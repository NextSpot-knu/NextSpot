"""관리자 전용 라우터 — docs/archive/IMPROVEMENT_PLAN.md WS-A-6.

배경: 관리자 프런트(admin/*)가 anon 키(createPublicClient)로 facilities/system_settings/inquiries 를
직접 쓰던 경로는 RLS 강화(20260707120000_security_hardening.sql) 이후 전부 거부된다(이전에도
0행 갱신이 성공으로 표시되는 무음 실패였다). 이 라우터가 그 쓰기/민감 읽기의 단일 관문이다.

- 모든 엔드포인트는 Supabase JWT + users.role='admin' 가드로 보호된다.
- DB 접근은 service_role(supabase_admin) — RLS 우회는 이 신뢰 경로 안에서만 일어난다.
- 예외 원문은 서버 로그로만 남기고 클라이언트에는 일반 메시지를 준다.
"""
import asyncio
import math
from datetime import datetime, timedelta, timezone

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.authz import ROLE_ADMIN, get_current_profile, require_role
from app.core.supabase import fetch_all_rows, supabase_admin
from app.services import briefing_service

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/admin", tags=["admin"], dependencies=[Depends(require_role(ROLE_ADMIN))])

FACILITY_TYPES = {"restaurant", "cafe", "attraction", "culture"}
INQUIRY_STATUSES = {"new", "in_progress", "resolved"}  # inquiries.status CHECK 와 동일

# 관리자 수동 혼잡 개입(Override)의 source — **전용 값**이다(20260906120000 에서 CHECK 확장).
#
# 예전에는 'event' 를 재사용했다. 그런데 마이그레이션 20260819120000 이
# `source IN ('traffic_cctv','tour_api','event') → evidence_tier='verified'` 로 백필하며
# 'event' 를 운영 검증 소스로 분류한 탓에, source 만 봐서는 '측정된 이벤트 관측' 과
# '관리자가 슬라이더로 넣은 값' 을 구분할 수 없었다 — 로그에서 관리자 개입분을 골라낼 수
# 없으면 나중에 데이터 품질을 따질 때 전체 수치를 믿을 수 없다.
#
# ⚠️ 이 값은 CHECK 제약에 매여 있다. 마이그레이션 20260906120000 이 적용되지 않은 DB 에
# 이 코드가 먼저 닿으면 오버라이드가 통째로 500 이 된다(배포 순서: 마이그레이션 먼저).
_ADMIN_OVERRIDE_SOURCE = "admin_override"


# =========================================================================
# PostgREST 행수 캡 회피 — 관리자 집계 공용 페이지네이션
# =========================================================================
# PostgREST 는 단일 응답을 1000행에서 자른다. `.limit(20000)` 처럼 더 큰 값을 걸어도 서버는
# 1000행만 돌려주고 **잘렸다는 사실은 응답 어디에도 남지 않는다.** 그래서 이 파일의 집계들은
# 오랫동안 앞 1000행만 보고 계산했다:
#   · 30일 추이가 (최신순 정렬 탓에) 최근 며칠로 쪼그라들었다.
#   · model-trust 의 활성 시설 수·커버리지·'수집 공백' 목록이 시설 1,000곳만 보고 만들어졌다
#     (실측 2026-09-03 기준 1,660곳 — 660곳이 관측 유무와 무관하게 통계에서 사라졌다).
# 관리자가 '데이터가 없다' 고 **판단하는 근거** 화면이라 특히 나쁜 종류의 오류다.
#
# 전량이 필요한 조회는 app/core/supabase.py 의 fetch_all_rows 가 정답 패턴이다(그 docstring 이
# 이유를 설명한다). 다만 fetch_all_rows 는 '전량' 전용이라 상한에서 멈추지 못한다 — 창이 넓어
# 행이 폭주할 수 있는 로그·추천 집계는 상한을 유지해야 하므로, 같은 `.range()` 페이지네이션을
# 상한까지만 도는 헬퍼를 여기 둔다.
_POSTGREST_PAGE_SIZE = 1000


def _fetch_capped(
    table: str,
    select: str,
    apply_filters,
    cap: int,
    *,
    endpoint: str,
) -> tuple[list[dict], bool]:
    """`table` 을 cap 행까지 페이지네이션 조회하고 (행, 상한도달여부) 를 돌려준다.

    두 번째 원소가 이 헬퍼의 존재 이유다. 예전 코드는 `.limit(cap)` 을 한 번 쏘고
    `len(rows) >= cap` 으로 절단을 판정했는데, 서버가 1000행에서 자르므로 cap > 1000 인 한
    **절단이 실제로 일어난 모든 경우에 False** 였다 — 구조상 참이 될 수 없는 플래그였다.
    여기서는 실제로 cap 행을 받아냈을 때만 True 다.

    (경계 케이스: 행이 정확히 cap 개면 절단이 없어도 True 다. 한 페이지를 더 받아 확인할 수도
     있지만, 상한 근처라는 경고로는 과보고가 과소보고보다 안전하므로 그대로 둔다.)

    ⚠️ `apply_filters` 는 결정적 정렬(`.order`)을 반드시 포함해야 한다. 정렬이 없으면 PostgREST
    가 페이지마다 순서를 달리 줄 수 있어 행이 중복·누락된다(UUID PK 를 마지막 tiebreak 로 건다).

    동기(블로킹) 함수 — 라우터에서는 asyncio.to_thread 로 오프로드해 호출한다.
    """
    rows: list[dict] = []
    start = 0
    while start < cap:
        end = min(start + _POSTGREST_PAGE_SIZE, cap) - 1
        query = apply_filters(supabase_admin.table(table).select(select))
        page = query.range(start, end).execute().data or []
        rows.extend(page)
        if len(page) < end - start + 1:  # 마지막 페이지
            break
        start = end + 1
    truncated = len(rows) >= cap
    if truncated:
        # 화면에 내려보내는 truncated 플래그와 별개로, 상한에 닿았다는 사실 자체를 남긴다.
        logger.warning("admin_query_truncated", endpoint=endpoint, table=table, cap=cap)
    return rows, truncated


# =========================================================================
# 시설(POI) CRUD — components/admin/FacilityTable.tsx
# =========================================================================

class FacilityCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    type: str
    capacity: int = Field(ge=1, le=100000)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class FacilityUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    capacity: int | None = Field(default=None, ge=1, le=100000)
    # 쿠폰 정책 개입(폐루프): 제휴 할인율(0.10=10%). DB CHECK(0~1)와 동일 범위.
    # 변경 즉시 다음 추천 요청의 w3 쿠폰강도(min(1, rate/0.20))에 반영된다 — score.py 참조.
    coupon_rate: float | None = Field(default=None, ge=0, le=1)


@router.post("/facilities")
async def create_facility(req: FacilityCreate):
    if req.type not in FACILITY_TYPES:
        raise HTTPException(status_code=422, detail=f"type 은 {sorted(FACILITY_TYPES)} 중 하나여야 합니다.")
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("facilities").insert(req.model_dump()).execute
        )
        if not res.data:
            raise HTTPException(status_code=500, detail="시설 등록에 실패했습니다.")
        logger.info("admin_facility_created", facility_id=res.data[0].get("id"), name=req.name)
        return res.data[0]
    except HTTPException:
        raise
    except Exception as e:
        logger.error("admin_facility_create_failed", error=str(e))
        raise HTTPException(status_code=500, detail="시설 등록에 실패했습니다.")


@router.patch("/facilities/{facility_id}")
async def update_facility(facility_id: str, req: FacilityUpdate):
    fields = {k: v for k, v in req.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=422, detail="수정할 필드가 없습니다.")
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("facilities").update(fields).eq("id", facility_id).execute
        )
        if not res.data:
            raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.")
        logger.info("admin_facility_updated", facility_id=facility_id, fields=list(fields))
        return res.data[0]
    except HTTPException:
        raise
    except Exception as e:
        logger.error("admin_facility_update_failed", facility_id=facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="시설 수정에 실패했습니다.")


@router.delete("/facilities/{facility_id}")
async def delete_facility(facility_id: str):
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("facilities").delete().eq("id", facility_id).execute
        )
        if not res.data:
            raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.")
        logger.info("admin_facility_deleted", facility_id=facility_id)
        return {"success": True, "deleted_id": facility_id}
    except HTTPException:
        raise
    except Exception as e:
        # recommendations FK(ON DELETE SET NULL)·congestion_logs CASCADE 는 스키마가 처리한다.
        logger.error("admin_facility_delete_failed", facility_id=facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="시설 삭제에 실패했습니다.")


# =========================================================================
# 수동 혼잡도 설정(Override) — app/admin/infrastructure/page.tsx 관리자 액션
# 관리자가 현장 상황을 반영해 특정 시설의 최신 혼잡도를 직접 덮어쓴다(대시보드/추천이 소비하는
# congestion_logs 최신값 갱신). anon/authenticated 직접 INSERT 는 RLS 로 막혀 있어 service_role 경유.
# =========================================================================

class CongestionOverride(BaseModel):
    # DB CHECK(congestion_level 0~1)와 동일 범위. 초과 값은 라우터 진입 전 422.
    level: float = Field(ge=0.0, le=1.0)


@router.post("/facilities/{facility_id}/congestion")
async def override_congestion(facility_id: str, req: CongestionOverride):
    """관리자 수동 혼잡도 설정 — congestion_logs 에 source='admin_override',
    evidence_tier='single_report' 로 1행 기록하고 그 행을 반환한다.

    흐름: 시설 존재/수용량 조회 → current_count = round(capacity×level) 추정 → service_role INSERT.
    (제보 라우터와 달리 쿨다운 없음 — 관리자 신뢰 경로의 의도적 개입이다.)

    source 가 'event' 가 아닌 이유는 아래 _ADMIN_OVERRIDE_SOURCE 주석에 있고, tier 가
    verified 가 아닌 이유는: **관측이 아니라 사람이 슬라이더로 넣은 값이라 모델 학습의
    정답이 될 수 없다**(train.py 는 verified/corroborated 행을 그대로 학습에 넣는다).
    """
    # 1. 시설 존재 검증 + capacity 조회 (없는 facility_id 로의 FK 위반/유령 로그 방지)
    #    PK 단건 조회라 limit(1) 은 의도된 상한이다(페이지네이션 대상 아님).
    try:
        fac_res = await asyncio.to_thread(
            supabase_admin.table("facilities").select("id, capacity").eq("id", facility_id).limit(1).execute
        )
    except Exception as e:
        logger.error("admin_congestion_lookup_failed", facility_id=facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="혼잡도 설정에 실패했습니다.")
    if not fac_res.data:
        raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.")

    capacity = fac_res.data[0].get("capacity") or 0
    row = {
        "facility_id": facility_id,
        "congestion_level": req.level,
        "current_count": round(capacity * req.level),
        "source": _ADMIN_OVERRIDE_SOURCE,
        # **관측이 아니라 사람이 슬라이더로 넣은 값이다.** 그래서 single_report 다.
        #
        # 예전에는 verified 였는데, 이 값이 곧 모델 학습의 정답이 된다:
        # apps/api/scripts/train.py 의 collect_rows 는 evidence_tier ∈ {verified, corroborated}
        # 행을 그대로 학습 데이터로 넣는다. 관리자가 데모나 보정으로 슬라이더를 한 번 움직일
        # 때마다 측정된 적 없는 숫자가 정답으로 들어가는 구조였다(2026-09-06 확인: 프로덕션에
        # verified 행이 0건이라 실제 오염은 아직 없다).
        #
        # 표시에는 그대로 반영된다 — latest_congestion_for_facilities 의 source 필터는
        # 거부목록('seed','simulated')이라 admin_override 가 통과하고, tier 허용목록에도 든다.
        "evidence_tier": "single_report",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    # 2. service_role 로 INSERT (anon/authenticated 직접 쓰기는 RLS 로 거부됨)
    try:
        ins = await asyncio.to_thread(
            supabase_admin.table("congestion_logs").insert(row).execute
        )
        if not ins.data:
            raise HTTPException(status_code=500, detail="혼잡도 설정에 실패했습니다.")
    except HTTPException:
        raise
    except Exception as e:
        logger.error("admin_congestion_override_failed", facility_id=facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="혼잡도 설정에 실패했습니다.")

    logger.info("admin_congestion_override", facility_id=facility_id, level=req.level)
    return ins.data[0]


# =========================================================================
# 시스템 설정 — app/admin/settings/page.tsx (system_settings 단일 행 id=1)
# =========================================================================

class SettingsUpdate(BaseModel):
    maintenance_mode: bool
    notice_text: str = Field(max_length=500)
    congestion_threshold: int = Field(ge=0, le=100)
    coldstart_weight: int = Field(ge=0, le=100)


@router.get("/settings")
async def get_settings():
    try:
        # system_settings 는 단일 행(id=1) 계약이라 limit(1) 은 의도된 상한이다.
        res = await asyncio.to_thread(
            supabase_admin.table("system_settings").select("*").eq("id", 1).limit(1).execute
        )
        # 행이 없으면 null — 프런트가 기본값으로 폴백한다(마이그레이션 미적용 환경).
        return res.data[0] if res.data else None
    except Exception as e:
        logger.error("admin_settings_fetch_failed", error=str(e))
        raise HTTPException(status_code=500, detail="시스템 설정 조회에 실패했습니다.")


@router.put("/settings")
async def update_settings(req: SettingsUpdate):
    try:
        payload = req.model_dump()
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        res = await asyncio.to_thread(
            supabase_admin.table("system_settings").update(payload).eq("id", 1).execute
        )
        if not res.data:
            raise HTTPException(status_code=404, detail="system_settings 행이 없습니다. 마이그레이션 적용이 필요합니다.")
        logger.info("admin_settings_updated")
        return res.data[0]
    except HTTPException:
        raise
    except Exception as e:
        logger.error("admin_settings_update_failed", error=str(e))
        raise HTTPException(status_code=500, detail="시스템 설정 저장에 실패했습니다.")


# =========================================================================
# 문의(inquiries) — app/admin/support/page.tsx (PII 포함 → RLS 강화 후 admin API 전용)
# =========================================================================

class InquiryStatusUpdate(BaseModel):
    status: str
    # 답변 본문 — **선택**이다. 구 관리자 번들은 status 만 보내므로(필드 추가만) 그 요청도
    # 그대로 통과해야 한다. Vercel(웹)과 Render(API)는 배포 시점이 달라 옛 번들이 새 서버를
    # 두드리는 구간이 실제로 존재한다.
    # 상한 5000자: inquiries.content 는 TEXT 라 제한이 없지만, 답변은 사람이 쓰는 글이고
    # 무제한 본문을 받아 둘 이유가 없다(초과는 422 로 즉시 되돌려 준다 — 잘라서 저장하면
    # 관리자가 쓴 것과 저장된 것이 달라진다).
    reply_body: str | None = Field(default=None, max_length=5000)


def _is_missing_reply_columns(exc: Exception) -> bool:
    """답변 컬럼(reply_body/replied_at/replied_by)이 아직 없는 DB인가.

    마이그레이션(20260907091000)은 원격 SQL Editor 에서 사람이 적용한다 — 백엔드 배포가
    먼저 나가는 순서가 실제로 가능하다. 그때 **문의 상태 변경까지 같이 죽으면 안 된다.**
    이 오류만 골라내 status 만으로 한 번 더 시도하고, 답변이 저장되지 않았다는 사실을
    응답(reply_saved=false)으로 알린다. account.py 의 _is_missing_requested_role 과 같은 방식이다.

    두 가지 오류 문구를 모두 잡는다(실측):
      · UPDATE 페이로드에 없는 컬럼  → PGRST204 "Could not find the 'reply_body' column
        of 'inquiries' in the schema cache"
      · SELECT 에 없는 컬럼          → 42703 "column inquiries.reply_body does not exist"
    마이그레이션 적용을 확인하면 이 폴백은 지워도 된다.
    """
    text = str(exc).lower()
    return any(column in text for column in ("reply_body", "replied_at", "replied_by")) and (
        "pgrst204" in text or "42703" in text or "column" in text or "schema cache" in text
    )


@router.get("/inquiries")
async def list_inquiries(limit: int = 500):
    """최신 문의 limit 건. **의도된 상한**이라 페이지네이션하지 않는다.

    지원 화면은 최신 문의부터 처리하는 목록이지 집계가 아니다 — 전량이 필요한 화면이 아니고,
    문의 본문에는 PII 가 들어 있어 필요 이상으로 넓게 내려보내지 않는 편이 낫다.
    상한을 PostgREST 응답 캡(1000)과 같은 값으로 잡아 둔 덕에 조용한 절단도 일어나지 않는다
    (limit>1000 을 요청해도 여기서 1000 으로 깎이므로 서버가 말없이 자를 여지가 없다).
    """
    limit = max(1, min(limit, 1000))
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("inquiries")
            .select("*")
            .order("created_at", desc=True)
            .limit(limit)
            .execute
        )
        return res.data or []
    except Exception as e:
        logger.error("admin_inquiries_fetch_failed", error=str(e))
        raise HTTPException(status_code=500, detail="문의 목록 조회에 실패했습니다.")


@router.patch("/inquiries/{inquiry_id}")
async def update_inquiry_status(
    inquiry_id: str,
    req: InquiryStatusUpdate,
    # 라우터 dependencies 의 require_role(ROLE_ADMIN) 이 이미 같은 의존성을 평가했으므로
    # FastAPI 의존성 캐시가 재사용한다(추가 DB 조회 없음). 답한 사람을 남기려면 id 가 필요하다.
    profile: dict = Depends(get_current_profile),
):
    """문의 상태 변경 + (선택) 답변 본문 저장.

    응답은 갱신된 행에 두 필드를 **덧붙여** 돌려준다 — 화면이 '무엇이 실제로 일어났는지'를
    말할 수 있어야 하기 때문이다(이 화면의 결함이 정확히 그 지점이었다):
      · reply_saved            — 답변 본문이 실제로 저장됐는가
      · reply_unavailable_reason — 저장하지 못했다면 그 이유("schema_missing")

    답변을 보내지 않았을 때(reply_body=None)는 reply_saved=false 지만 이유도 없다 —
    '저장 실패' 가 아니라 '저장할 것이 없었다' 이므로 화면이 둘을 구분해야 한다.
    """
    if req.status not in INQUIRY_STATUSES:
        raise HTTPException(status_code=422, detail=f"status 는 {sorted(INQUIRY_STATUSES)} 중 하나여야 합니다.")

    # 공백만 있는 본문은 '안 보냄' 과 같다 — 빈 답변을 저장해 '답변함' 으로 만들지 않는다.
    reply_body = (req.reply_body or "").strip() or None
    payload: dict = {"status": req.status}
    if reply_body is not None:
        payload["reply_body"] = reply_body
        payload["replied_at"] = datetime.now(timezone.utc).isoformat()
        payload["replied_by"] = profile["id"]

    def _update(data: dict):
        return supabase_admin.table("inquiries").update(data).eq("id", inquiry_id).execute()

    reply_saved = reply_body is not None
    reply_unavailable_reason: str | None = None
    try:
        res = await asyncio.to_thread(_update, payload)
    except Exception as exc:
        if reply_body is not None and _is_missing_reply_columns(exc):
            # 마이그레이션 미적용 DB — 상태 변경까지 같이 죽이지 않는다. 대신 답변이
            # 저장되지 않았다는 사실을 반드시 응답에 실어 보낸다(조용한 성공 금지).
            logger.warning("admin_inquiry_reply_column_missing", inquiry_id=inquiry_id)
            reply_saved = False
            reply_unavailable_reason = "schema_missing"
            try:
                res = await asyncio.to_thread(_update, {"status": req.status})
            except Exception as retry_exc:
                logger.error("admin_inquiry_update_failed", inquiry_id=inquiry_id, error=str(retry_exc))
                raise HTTPException(status_code=500, detail="문의 상태 변경에 실패했습니다.") from None
        else:
            logger.error("admin_inquiry_update_failed", inquiry_id=inquiry_id, error=str(exc))
            raise HTTPException(status_code=500, detail="문의 상태 변경에 실패했습니다.") from None

    if not res.data:
        raise HTTPException(status_code=404, detail="해당 문의를 찾을 수 없습니다.")
    logger.info(
        "admin_inquiry_status_updated",
        inquiry_id=inquiry_id,
        status=req.status,
        reply_saved=reply_saved,
    )
    return {
        **res.data[0],
        "reply_saved": reply_saved,
        "reply_unavailable_reason": reply_unavailable_reason,
    }


# =========================================================================
# 대시보드/리포트 지표 — anon 열람이 막힌 recommendations/user_feedback 의 비식별 지표 제공
# (admin/dashboard: 최근 7일 수락률·오늘 DAU / admin/reports: 최근 28일 수락 추이)
# =========================================================================

# 원본 행을 그대로 프런트로 넘기는 엔드포인트라 상한을 유지한다(28일 창 × 전 사용자 —
# 성장하면 무한정 커지는 응답을 관리자 화면에 밀어넣지 않는다). 상한을 넘으면 최신순으로
# 남기고 truncated 로 알린다: 대시보드가 계산하는 수락률·DAU 가 창 전체의 값이 아니게 되므로
# '표본이 잘렸다' 는 사실이 화면 판단의 일부여야 한다.
_METRICS_ROW_CAP = 5000


@router.get("/metrics")
async def get_metrics(days: int = 28):
    days = max(1, min(days, 90))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    try:
        (recs, recs_truncated), (feedback, fb_truncated) = await asyncio.gather(
            asyncio.to_thread(
                _fetch_capped,
                "recommendations",
                "accepted, created_at",
                lambda q: q.neq("source", "browse")
                .gte("created_at", since)
                .order("created_at", desc=True)
                .order("id", desc=True),
                _METRICS_ROW_CAP,
                endpoint="metrics",
            ),
            asyncio.to_thread(
                _fetch_capped,
                "user_feedback",
                "user_id, timestamp",
                lambda q: q.gte("timestamp", since)
                .order("timestamp", desc=True)
                .order("id", desc=True),
                _METRICS_ROW_CAP,
                endpoint="metrics",
            ),
        )
        return {
            "since": since,
            "recommendations": recs,
            "feedback": feedback,
            # 필드 추가만(구 번들은 이 키를 읽지 않는다). 어느 한쪽이라도 상한에 닿으면 True.
            "truncated": recs_truncated or fb_truncated,
        }
    except Exception as e:
        logger.error("admin_metrics_fetch_failed", error=str(e))
        raise HTTPException(status_code=500, detail="지표 조회에 실패했습니다.")


# model-trust 창 상한. 전량이 필요하지만 무한정 받을 수는 없는 조회들이라 상한은 유지하고,
# 닿으면 응답의 truncated·warnings 로 알린다(수치가 창 전체의 값이 아니게 되므로).
_TRUST_REC_CAP = 10000       # 추천 노출·스냅샷 가드레일
_TRUST_OUTCOME_CAP = 10000   # 추천→길찾기→방문 퍼널
_TRUST_LOG_CAP = 20000       # 관측 수·출처/티어 분포·시설 커버리지


@router.get("/model-trust")
async def get_model_trust(days: int = 30):
    """활성 모델 품질·추천→방문 퍼널·근거 노출 가드레일의 비식별 운영 요약."""
    from app.services.predict_service import get_model_info
    from app.services.congestion_evidence import rankable_measured_level

    days = max(1, min(days, 90))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    try:
        (
            registry_res,
            (recommendations, recs_truncated),
            (outcomes, outcomes_truncated),
            (logs, logs_truncated),
            facility_rows,
        ) = await asyncio.gather(
            asyncio.to_thread(
                # 활성 모델은 정의상 1행이다 — limit(1) 은 의도된 상한(페이지네이션 불필요).
                supabase_admin.table("model_registry")
                .select("version,status,real_data_count,training_started_at,training_ended_at,source_composition,metrics")
                .eq("status", "active").limit(1).execute
            ),
            asyncio.to_thread(
                _fetch_capped,
                "recommendations",
                "id,recommendation_snapshot,created_at",
                lambda q: q.eq("source", "spot")
                .gte("created_at", since)
                .order("created_at", desc=True)
                .order("id", desc=True),
                _TRUST_REC_CAP,
                endpoint="model-trust",
            ),
            asyncio.to_thread(
                _fetch_capped,
                "recommendation_outcomes",
                "recommendation_id,navigation_started_at,arrival_confirmed_at,rated_at,rating",
                lambda q: q.gte("created_at", since)
                .order("created_at", desc=True)
                .order("recommendation_id", desc=True),  # PK — created_at 동률에서의 tiebreak
                _TRUST_OUTCOME_CAP,
                endpoint="model-trust",
            ),
            asyncio.to_thread(
                _fetch_capped,
                "congestion_logs",
                "facility_id,source,evidence_tier,timestamp",
                lambda q: q.gte("timestamp", since)
                .order("timestamp", desc=True)
                .order("id", desc=True),
                _TRUST_LOG_CAP,
                endpoint="model-trust",
            ),
            asyncio.to_thread(
                # 시설은 **전량**이 필요하다: 아래 facility_gaps 는 '관측이 하나도 없는 시설'
                # 목록이라, 조회에서 빠진 시설은 공백으로도 잡히지 않고 active_facilities·
                # 커버리지 분모까지 함께 틀어진다. 예전의 .limit(5000) 은 시설 수(1,660곳)보다
                # 컸으니 무해해 보였지만, 정작 자른 것은 PostgREST 의 1000행 캡이었다.
                fetch_all_rows,
                supabase_admin,
                "facilities",
                "id,name,type,is_active",
                _POSTGREST_PAGE_SIZE,
                lambda q: q.order("id"),  # range 페이지 경계 고정
            ),
        )
    except Exception as exc:
        logger.error("admin_model_trust_failed", error=str(exc))
        raise HTTPException(status_code=500, detail="모델 신뢰도 지표 조회에 실패했습니다.")

    outcome_by_id = {row["recommendation_id"]: row for row in outcomes}
    top3 = []
    closed = 0
    ungrounded_numeric = 0
    walk_limit_violations = 0
    scoring_modes: dict[str, int] = {}
    for row in recommendations:
        snapshot = row.get("recommendation_snapshot") or {}
        mode = str(snapshot.get("scoring_mode") or "unknown")
        scoring_modes[mode] = scoring_modes.get(mode, 0) + 1
        rank = snapshot.get("rank")
        if isinstance(rank, int) and rank <= 3:
            top3.append(snapshot)
        if snapshot.get("open_status_at_arrival") == "closed_confirmed":
            closed += 1
        max_walk = snapshot.get("max_walk_minutes")
        travel_time = (snapshot.get("breakdown") or {}).get("travel_time")
        if isinstance(max_walk, (int, float)) and isinstance(travel_time, (int, float)) and travel_time > max_walk:
            walk_limit_violations += 1
        congestion = snapshot.get("congestion") or {}
        breakdown = snapshot.get("breakdown") or {}
        if (
            congestion.get("source") == "none" and congestion.get("level") is not None
        ) or (
            snapshot.get("scoring_mode") in {"degraded_rules", "area_stats_rules"}
            and breakdown.get("wait_time") is not None
        ):
            ungrounded_numeric += 1

    registry = (registry_res.data or [None])[0]
    evidence_count = sum(1 for item in top3 if (item.get("congestion") or {}).get("source") in {"measured", "predicted"})
    hours_count = sum(1 for item in top3 if (item.get("tourapi_facts") or {}).get("operating_hours"))
    fresh_count = 0
    fresh_trusted_measured = 0
    now = datetime.now(timezone.utc)
    for item in top3:
        congestion = item.get("congestion") or {}
        timestamp = congestion.get("timestamp")
        if timestamp is None and congestion.get("source") == "predicted":
            timestamp = (registry or {}).get("training_ended_at")
        if timestamp:
            try:
                parsed = datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
                if now - parsed.astimezone(timezone.utc) <= timedelta(hours=24):
                    fresh_count += 1
            except (TypeError, ValueError):
                pass
        if rankable_measured_level(congestion, now=now) is not None:
            fresh_trusted_measured += 1

    exposures = len(recommendations)
    navigations = sum(1 for row in recommendations if row["id"] in outcome_by_id)
    arrivals = sum(1 for row in outcomes if row.get("arrival_confirmed_at"))
    positive = sum(1 for row in outcomes if row.get("rating") == "up")
    verified_success = sum(1 for row in outcomes if row.get("arrival_confirmed_at") and row.get("rating") == "up")
    facilities = [row for row in facility_rows if row.get("is_active", True)]
    trusted_logs = [row for row in logs if row.get("evidence_tier") in {"verified", "corroborated"}]
    trusted_facility_ids = {str(row.get("facility_id")) for row in trusted_logs if row.get("facility_id")}
    active_facility_ids = {str(row.get("id")) for row in facilities if row.get("id")}
    covered_active_ids = trusted_facility_ids & active_facility_ids
    source_counts: dict[str, int] = {}
    tier_counts: dict[str, int] = {}
    for row in logs:
        source = str(row.get("source") or "unknown")
        tier = str(row.get("evidence_tier") or "unknown")
        source_counts[source] = source_counts.get(source, 0) + 1
        tier_counts[tier] = tier_counts.get(tier, 0) + 1
    collection_gaps = [
        {"id": row.get("id"), "name": row.get("name"), "type": row.get("type")}
        for row in sorted(facilities, key=lambda item: (str(item.get("type")), str(item.get("name"))))
        if str(row.get("id")) not in trusted_facility_ids
    ][:20]
    info = get_model_info()
    source_composition = (registry or {}).get("source_composition") or {}
    warnings = []
    if not info["trained"]:
        warnings.append("trained_false")
    if info.get("refresh_error"):
        warnings.append("model_refresh_failure")
    if any(int(source_composition.get(key) or 0) for key in ("seed", "simulated", "synthetic", "single_report")):
        warnings.append("untrusted_training_source")
    if closed:
        warnings.append("closed_place_recommended")
    if ungrounded_numeric:
        warnings.append("ungrounded_numeric_exposure")
    if walk_limit_violations:
        warnings.append("walk_limit_violation")
    if info.get("mae") is not None and float(info["mae"]) > 0.15:
        warnings.append("active_model_mae_out_of_bounds")
    truncated = recs_truncated or outcomes_truncated or logs_truncated
    if truncated:
        # 창 상한에 닿았다 = 아래 수치가 창 전체의 값이 아니다. 특히 facility_gaps 는
        # '관측 없는 시설' 목록이라 로그가 잘리면 멀쩡히 관측되는 시설을 공백으로 지목한다.
        warnings.append("metrics_truncated")

    return {
        "since": since, "model": info, "registry": registry,
        # 필드 추가만(구 번들은 이 키를 읽지 않는다).
        "truncated": truncated,
        "funnel": {
            "exposures": exposures, "navigations": navigations, "arrivals": arrivals,
            "positive_ratings": positive,
            "verified_visit_success_rate": round(verified_success / exposures, 4) if exposures else 0.0,
        },
        "top3_evidence": {
            "count": len(top3),
            "coverage_rate": round(evidence_count / len(top3), 4) if top3 else 0.0,
            "fresh_rate": round(fresh_count / len(top3), 4) if top3 else 0.0,
            "fresh_trusted_measured_rate": round(fresh_trusted_measured / len(top3), 4) if top3 else 0.0,
            "operating_hours_rate": round(hours_count / len(top3), 4) if top3 else 0.0,
        },
        "collection": {
            "observations": len(logs),
            "trusted_observations": len(trusted_logs),
            "remaining_to_candidate": max(0, 300 - len(trusted_logs)),
            "active_facilities": len(facilities),
            "trusted_facility_coverage_rate": (
                round(len(covered_active_ids) / len(facilities), 4) if facilities else 0.0
            ),
            "by_source": source_counts,
            "by_evidence_tier": tier_counts,
            "facility_gaps": collection_gaps,
        },
        "guardrails": {
            "closed_recommendations": closed,
            "ungrounded_numeric_exposures": ungrounded_numeric,
            "walk_limit_violations": walk_limit_violations,
            "scoring_modes": scoring_modes,
            "warnings": warnings,
        },
    }


# =========================================================================
# 30일 분산 추이 — 대시보드 '③ 분산 효과' 차트의 실측 소스 (E3 지표 리얼리티)
# congestion_logs 일평균 혼잡도 + recommendations 일별 수락률을 KST 일 단위로 집계한다.
# 반사실('도입 전') 기준선은 실측이 불가능하므로 제공하지 않는다 — 실측 두 계열만 반환하고,
# 표본이 빈약한 날은 null 로 두어 프런트가 데모 예시로 폴백/구분 표기하게 한다(정직성 원칙).
# =========================================================================

# 추이 창의 행 상한. 상한에 닿으면 최신순으로 남기고(오래된 날부터 버린다) truncated=True 로 알린다.
#
# 상한을 없애지 않는 이유: 상한에 닿는 것이 가상의 상황이 아니다. /admin/simulate-peak 은
# 한 번 누를 때 **시설 수만큼**(실측 2026-09-03 기준 1,660행) congestion_logs 에 넣으므로,
# 데모 준비로 열세 번만 눌러도 30일 창이 20,000행을 넘는다. 반대로 실제 현장 관측은 아직
# 수백 건 규모라(모델 후보 기준선이 검증 관측 300건이다) 평상시엔 한 페이지로 끝난다.
# 즉 상한은 '데모가 만든 로그 폭주로 관리자 조회가 수십만 행을 끌어오는 것'을 막는 안전장치다.
#
# ⚠️ 예전 코드는 `.limit(_TREND_LOG_CAP)` 한 번으로 받고 `len(logs) >= _TREND_LOG_CAP` 로
# 절단을 판정했다. PostgREST 가 1000행에서 자르므로 20,000행이 반환될 수 없었고 —
# **절단이 실제로 일어나는 모든 경우에 truncated=False** 였다. 게다가 정렬이 최신순이라
# 30일 추이가 조용히 '최근 1000행' 으로 쪼그라들었다(로그가 잦으면 하루치도 안 된다).
_TREND_LOG_CAP = 20000
# 추천은 시설 수와 무관하게 실사용자 행동이라 로그보다 훨씬 희소하다 — 상한도 그만큼 낮게 둔다.
_TREND_REC_CAP = 5000


def _kst_date(ts: str) -> str | None:
    """UTC 타임스탬프 → KST 날짜('YYYY-MM-DD'). 파싱 실패 시 None(해당 행 스킵)."""
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (dt.astimezone(timezone.utc) + _KST_OFFSET).strftime("%Y-%m-%d")


@router.get("/metrics/trend")
async def get_metrics_trend(days: int = 30):
    """최근 days일(KST 일 단위, 오늘 포함) 혼잡·추천수락 실측 추이 — 과거→오늘 순 daily 배열."""
    days = max(1, min(days, 90))
    today_start, _ = _kst_today_range_utc()
    since = (datetime.fromisoformat(today_start) - timedelta(days=days - 1)).isoformat()
    try:
        (logs, logs_truncated), (recs, recs_truncated) = await asyncio.gather(
            asyncio.to_thread(
                _fetch_capped,
                "congestion_logs",
                "congestion_level, timestamp",
                # 상한 절단 시 최근 일자부터 보존(desc). id 는 동률 tiebreak — simulate-peak 이
                # 수천 행을 **같은 timestamp** 로 넣기 때문에 페이지 경계가 실제로 흔들린다.
                lambda q: q.gte("timestamp", since)
                .order("timestamp", desc=True)
                .order("id", desc=True),
                _TREND_LOG_CAP,
                endpoint="metrics/trend",
            ),
            asyncio.to_thread(
                _fetch_capped,
                "recommendations",
                "accepted, created_at",
                lambda q: q.neq("source", "browse")
                .gte("created_at", since)
                .order("created_at", desc=True)
                .order("id", desc=True),
                _TREND_REC_CAP,
                endpoint="metrics/trend",
            ),
        )
    except Exception as e:
        logger.error("admin_metrics_trend_failed", error=str(e))
        raise HTTPException(status_code=500, detail="분산 추이 집계에 실패했습니다.")

    cong: dict[str, dict[str, float]] = {}
    for row in logs:
        day = _kst_date(row.get("timestamp"))
        if not day:
            continue
        acc = cong.setdefault(day, {"sum": 0.0, "n": 0})
        acc["sum"] += float(row.get("congestion_level") or 0)
        acc["n"] += 1

    rec_agg: dict[str, dict[str, int]] = {}
    for row in recs:
        day = _kst_date(row.get("created_at"))
        if not day:
            continue
        acc = rec_agg.setdefault(day, {"total": 0, "accepted": 0})
        acc["total"] += 1
        if row.get("accepted"):
            acc["accepted"] += 1

    first_kst = datetime.fromisoformat(since) + _KST_OFFSET
    daily = []
    for i in range(days):
        day = (first_kst + timedelta(days=i)).strftime("%Y-%m-%d")
        c = cong.get(day)
        r = rec_agg.get(day)
        daily.append({
            "date": day,
            # 로그 없는 날은 null 센티넬 — 실측 0.0 과 구분(대시보드 히트맵과 동일 규약)
            "avg_congestion": _js_round(c["sum"] / c["n"], 3) if c and c["n"] else None,
            "samples": int(c["n"]) if c else 0,
            "rec_total": r["total"] if r else 0,
            "rec_accepted": r["accepted"] if r else 0,
        })

    # 두 계열 중 하나라도 상한에 닿으면 daily 의 앞쪽(오래된 날)이 실제보다 비어 보인다.
    return {"days": days, "daily": daily, "truncated": logs_truncated or recs_truncated}


# =========================================================================
# 분산 효과 정량화 — 수락된 추천의 '절감 대기시간' 합산 (admin/dashboard 위젯)
# 산식: Σ max(0, 원본 예상대기 − 대안 도착시점 예상대기)  [수락 건만]
#  · original_wait_time/wait_time 은 추천 생성 시점에 score_breakdown 으로 저장된다
#    (recommendations 라우터). 그 시점의 실측 혼잡 기반이라 사후 재계산보다 정직하다.
#  · original_wait_time 이 없는 레거시 행은 incentive_relief(원본혼잡−도착시점 예측혼잡, 0~1)
#    × 15분(타입 기본 처리시간 중앙값)으로 보수적으로 근사한다 — 근사 건수는 estimated 로 구분 표기.
# =========================================================================

_LEGACY_RELIEF_TO_MINUTES = 15.0  # wait_time.DEFAULT_PROCESSING_TIMES 중앙값(카페12·식당25·관광15·문화15)
# 수락 추천 상한. 절감 분(分)은 **합계**라 행이 빠지면 그만큼 과소 집계된다 — 즉 잘리면
# '분산 효과가 이만큼 있었다' 를 실제보다 작게 말하게 된다. 상한에 닿으면 truncated 로 알린다.
_IMPACT_REC_CAP = 5000


@router.get("/impact")
async def get_impact(since: str | None = None, days: int = 1):
    """수락 추천 기준 재배치 건수·절감 대기시간(분) 집계.

    since(ISO8601, UTC)가 오면 그 시각 이후, 없으면 최근 days(기본 1)일 롤링 윈도우.
    프런트(대시보드)는 KST '오늘 00:00' 을 since 로 넘겨 '오늘' 지표로 쓴다.
    """
    days = max(1, min(days, 90))
    if since:
        try:
            # 검증 겸 정규화 — 잘못된 문자열이 PostgREST 필터로 그대로 흘러가지 않게 한다.
            since = datetime.fromisoformat(since.replace("Z", "+00:00")).isoformat()
        except ValueError:
            raise HTTPException(status_code=422, detail="since 는 ISO8601 형식이어야 합니다.")
    else:
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()

    try:
        rows, truncated = await asyncio.to_thread(
            _fetch_capped,
            "recommendations",
            "score_breakdown, created_at",
            lambda q: q.eq("accepted", True)
            .gte("created_at", since)
            .order("created_at", desc=True)
            .order("id", desc=True),
            _IMPACT_REC_CAP,
            endpoint="impact",
        )
    except Exception as e:
        logger.error("admin_impact_fetch_failed", error=str(e))
        raise HTTPException(status_code=500, detail="분산 효과 집계에 실패했습니다.")

    relocations = 0
    saved_minutes = 0.0
    measured = 0   # original_wait_time 실측 저장 행
    estimated = 0  # 레거시 근사(incentive_relief 기반) 행
    for row in rows:
        relocations += 1
        bd = row.get("score_breakdown") or {}
        original_wait = bd.get("original_wait_time")
        candidate_wait = bd.get("wait_time")
        if original_wait is not None and candidate_wait is not None:
            saved_minutes += max(0.0, float(original_wait) - float(candidate_wait))
            measured += 1
        elif bd.get("incentive_relief") is not None:
            saved_minutes += max(0.0, float(bd["incentive_relief"])) * _LEGACY_RELIEF_TO_MINUTES
            estimated += 1

    return {
        "since": since,
        "relocations": relocations,
        "saved_wait_minutes": round(saved_minutes, 1),
        "measured": measured,
        "estimated": estimated,
        # 필드 추가만(구 번들은 이 키를 읽지 않는다). True 면 아래 합계는 하한이다.
        "truncated": truncated,
    }


# =========================================================================
# 오늘(KST) 혼잡 집계 — 12k행 클라이언트 집계를 서버측으로 이관 (최적화 #4)
# 기존엔 admin/dashboard(page.tsx fetchCongestion)가 congestion_logs 최대 ~12,000행을
# 브라우저로 내려받아 JS 로 평균/이상건수/히트맵/이상알림을 집계했다. 이 엔드포인트가 동일 산식으로
# 서버에서 집계해 compact JSON 만 반환한다(네트워크·클라이언트 CPU 절감). 산식은 fetchCongestion 과 1:1.
# =========================================================================

_KST_OFFSET = timedelta(hours=9)
# 클라이언트 페이지네이션(1000행×12페이지)과 동일한 과다조회 상한.
# ⚠️ '1000행×12페이지' 는 **클라이언트가 12번 왕복했다**는 뜻이다. 서버로 옮기면서 그것을
# `.limit(12000)` 한 번으로 바꿨는데, PostgREST 는 1000행에서 자르므로 이관 후의 서버 집계는
# 사실상 1/12 만 보고 있었다(평균 혼잡도·이상 건수·히트맵·이상 알림 전부). 지금은 캡 너머로
# 페이지네이션하되 상한은 유지한다 — simulate-peak 한 번이 시설 수만큼(약 1,660행) 넣으므로
# 데모를 8번만 돌려도 하루치가 이 상한에 닿는다.
_DASHBOARD_LOG_CAP = 12000
# 전일 평균은 변화율(%) 하나를 만들 뿐이라 오늘치보다 낮게 잡는다.
_DASHBOARD_YESTERDAY_CAP = 5000


def _js_round(value: float, digits: int) -> float:
    """JS Math.round(x·10^d)/10^d 재현(round-half-up).
    파이썬 round() 는 은행가 반올림이라 .x5 경계에서 클라이언트 값과 어긋날 수 있어 직접 구현한다."""
    factor = 10 ** digits
    return math.floor(value * factor + 0.5) / factor


def _kst_today_range_utc() -> tuple[str, str]:
    """KST '오늘' 00:00~23:59:59.999 를 UTC ISO 문자열로. page.tsx getKstTodayRangeUtc 미러.
    congestion_logs.timestamp 는 UTC 적재라 서버 로컬 TZ 와 무관하게 KST(UTC+9) 고정 환산한다."""
    kst_now = datetime.now(timezone.utc) + _KST_OFFSET  # KST 벽시계(UTC 라벨로 표현)
    start = datetime(kst_now.year, kst_now.month, kst_now.day, 0, 0, 0, tzinfo=timezone.utc) - _KST_OFFSET
    end = datetime(kst_now.year, kst_now.month, kst_now.day, 23, 59, 59, 999000, tzinfo=timezone.utc) - _KST_OFFSET
    return start.isoformat(), end.isoformat()


def _joined_facility(log: dict) -> tuple[str | None, str | None]:
    """조인된 facility 가 dict/list 어느 형태로 와도 name/type 안전 추출(page.tsx joinedFacility 미러)."""
    f = log.get("facility")
    if not f:
        return None, None
    o = f[0] if isinstance(f, list) else f
    if not isinstance(o, dict):
        return None, None
    return o.get("name"), o.get("type")


def _kst_hour(ts: str) -> int:
    """UTC 타임스탬프의 KST(UTC+9) 시(0..23). page.tsx: getTime()+9h → getUTCHours() 미러."""
    dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (dt.astimezone(timezone.utc) + _KST_OFFSET).hour


@router.get("/dashboard/today")
async def get_dashboard_today():
    """오늘(KST) 혼잡 집계 — page.tsx fetchCongestion 과 동일 산식의 compact JSON.

    반환: { hasLogs, avgCongestion, anomalyCount, heatmap, anomalies }
      · hasLogs = 오늘 로그 수 >= 5
      · avgCongestion.value = 평균 혼잡도(소수 2자리)
      · avgCongestion.changePercent        = 전일 평균 대비(소수 1자리) — **구 키, 의미 그대로**
      · avgCongestion.changePercentOrNull  = 같은 값이되 전일 표본이 없으면 null (신규)
      · avgCongestion.prevSampleCount      = 비교에 쓴 전일 로그 건수 (신규)
      · anomalyCount = congestion_level >= 0.9 건수
      · heatmap = 시설명×KST시(0..23) 평균(2자리), 로그 없는 칸은 null 센티넬(실측 0.0 과 구분)
      · anomalies = 시설별 >=0.9 피크 상위 6건
    로그가 5건 미만이면 hasLogs=false + 나머지 null(클라이언트 폴백과 동일 shape).
    """
    start, end = _kst_today_range_utc()
    # 전일 동일 구간(변화율 보정용) — 오늘 구간을 하루 앞으로 민다.
    y_start = (datetime.fromisoformat(start) - timedelta(days=1)).isoformat()
    y_end = (datetime.fromisoformat(end) - timedelta(days=1)).isoformat()

    empty = {"hasLogs": False, "avgCongestion": None, "anomalyCount": None, "heatmap": None, "anomalies": None}
    try:
        # 오늘 로그(시설명/유형 조인)와 어제 로그(변화율용, congestion_level만)를 동시에 조회한다(직렬 왕복 제거).
        (logs, _today_truncated), (y_logs, _y_truncated) = await asyncio.gather(
            asyncio.to_thread(
                _fetch_capped,
                "congestion_logs",
                "congestion_level, current_count, timestamp, facility:facilities(name, type)",
                lambda q: q.gte("timestamp", start)
                .lte("timestamp", end)
                .order("timestamp", desc=False)
                .order("id", desc=False),  # simulate-peak 이 동일 timestamp 를 대량 생성한다
                _DASHBOARD_LOG_CAP,
                endpoint="dashboard/today",
            ),
            asyncio.to_thread(
                _fetch_capped,
                "congestion_logs",
                "congestion_level",
                lambda q: q.gte("timestamp", y_start)
                .lte("timestamp", y_end)
                .order("timestamp", desc=False)
                .order("id", desc=False),
                _DASHBOARD_YESTERDAY_CAP,
                endpoint="dashboard/today",
            ),
        )
    except Exception as e:
        logger.error("admin_dashboard_today_failed", error=str(e))
        raise HTTPException(status_code=500, detail="혼잡 집계 조회에 실패했습니다.")

    # 절단 사실은 응답이 아니라 구조화 로그로만 남긴다(_fetch_capped 안에서 경고).
    # 이 응답 shape 은 클라이언트 폴백 경로·브리핑과 공유하므로 **키를 지우거나 뜻을 바꾸지
    # 않는다.** 아래에서 avgCongestion 에 키를 두 개 더하는 것은 그 규칙과 어긋나지 않는다 —
    # 구 번들은 모르는 키를 읽지 않고, 브리핑(build_facts)은 changePercent 만 본다.
    if len(logs) < 5:
        return empty

    # 1) KPI: 평균 혼잡도 + 이상(>=0.9) 건수 + 전일 대비 변화율
    avg = sum(float(row.get("congestion_level") or 0) for row in logs) / len(logs)
    value = _js_round(avg, 2)
    anomaly_count = sum(1 for row in logs if float(row.get("congestion_level") or 0) >= 0.9)
    # ── '변화 없음' 과 '표본 없음' 은 다른 사실이다 ──────────────────────────────
    # 예전에는 둘 다 changePercent=0.0 이었다. 그래서 전일 로그가 **한 건도 없는** 날에도
    # 화면은 '0%' 배지를 그렸다 — 측정한 적 없는 비교를 한 것처럼 보이게 만드는 값이다.
    # (반대 방향도 같은 크기의 거짓말이다: 어제 평균이 0.0 이면 분모가 0 이라 변화율을 낼 수
    #  없는데, 그때도 0% 로 나갔다.)
    #
    # 그래서 서버가 세 값을 함께 싣는다:
    #   · changePercent        — **구 키. 의미를 그대로 둔다.**
    #   · changePercentOrNull  — 비교할 수 없으면 null
    #   · prevSampleCount      — 비교에 실제로 쓴 전일 로그 건수(화면이 이유를 말할 근거)
    #
    # 왜 구 키를 그대로 두는가: Vercel(웹)과 Render(API)는 배포 시점이 다르고 스테이징이
    # 없다. 옛 번들이 새 응답을 받는 구간이 실제로 존재하고, 그 번들은 changePercent 를
    # 숫자로 읽는다 — 여기서 null 을 흘려보내면 배지가 'NaN%' 가 된다.
    # 계획: 새 화면이 배포돼 안정되면(양쪽 배포 확인 후) changePercent 를 걷고
    #      changePercentOrNull 을 changePercent 로 되돌린다. 그때 지울 것은
    #      이 블록의 change_percent 계산과 프런트의 구 키 폴백 두 곳뿐이다.
    prev_sample_count = len(y_logs)
    change_percent_or_null: float | None = None
    if y_logs:
        y_avg = sum(float(row.get("congestion_level") or 0) for row in y_logs) / len(y_logs)
        if y_avg > 0:
            # JS: Math.round((value - yAvg)/yAvg * 1000)/10 == _js_round(... * 100, 1)
            change_percent_or_null = _js_round((value - y_avg) / y_avg * 100, 1)
    avg_congestion = {
        "value": value,
        # 구 키 — null 을 절대 넣지 않는다(옛 번들이 숫자로 읽는다).
        "changePercent": change_percent_or_null if change_percent_or_null is not None else 0.0,
        "changePercentOrNull": change_percent_or_null,
        "prevSampleCount": prev_sample_count,
    }

    # 2) 히트맵: 시설명 × KST시 평균(로그 있는 시설만, 첫 등장 순서 유지)
    cells: dict[str, dict[str, float]] = {}
    type_of: dict[str, str] = {}
    names: list[str] = []
    for row in logs:
        name, ftype = _joined_facility(row)
        if not name:
            continue
        if name not in type_of:
            type_of[name] = ftype or "unknown"
            names.append(name)
        key = f"{name}__{_kst_hour(row.get('timestamp'))}"
        acc = cells.setdefault(key, {"sum": 0.0, "n": 0})
        acc["sum"] += float(row.get("congestion_level") or 0)
        acc["n"] += 1
    heatmap: list[dict] = []
    for name in names:
        for h in range(24):
            acc = cells.get(f"{name}__{h}")
            heatmap.append({
                "facility": name,
                "facilityType": type_of[name],
                "hour": h,
                # 로그 없는 시간대는 null(데이터 없음 센티넬) — 실측 0.00 과 구분한다.
                "value": _js_round(acc["sum"] / acc["n"], 2) if acc and acc["n"] else None,
            })

    # 3) 이상 알림: 오늘 >=0.9 피크(시설별 최고 1건), congestionLevel 내림차순 상위 6
    peak: dict[str, dict] = {}
    for row in logs:
        level = float(row.get("congestion_level") or 0)
        if level < 0.9:
            continue
        name, _ = _joined_facility(row)
        if not name:
            continue
        if name not in peak or level > peak[name]["congestionLevel"]:
            peak[name] = {
                "id": f"{name}-{row.get('timestamp')}",
                "facilityName": name,
                "timestamp": row.get("timestamp"),
                "congestionLevel": level,
                "durationMinutes": 30,
            }
    anomalies = sorted(peak.values(), key=lambda a: a["congestionLevel"], reverse=True)[:6]

    return {
        "hasLogs": True,
        "avgCongestion": avg_congestion,
        "anomalyCount": anomaly_count,
        "heatmap": heatmap,
        "anomalies": anomalies,
    }


# =========================================================================
# 오늘의 브리핑 — docs/archive/SOLAR_LLM_EXPANSION.md P0-2 (admin/dashboard 상단 카드)
# 서버가 dashboard/today + impact(KST 오늘) 수치를 사실 JSON 으로 집계하고, Solar 는
# 한국어 1~2문장 프로즈만 생성한다. 게이트/캐시/폴백 규칙은 briefing_service 가 보유한다.
# 어떤 실패든 briefing=None 으로 강등되며 프런트는 카드 자체를 렌더하지 않는다(무해 폴백).
# =========================================================================

def _briefing_view(today: dict) -> dict:
    """브리핑에 넘길 때만 changePercent 를 '비교 불가면 null' 로 되돌린 사본.

    briefing_service.build_facts 는 이미 changePercent=None 을 제대로 다룬다 — 그 경우
    {change} 플레이스홀더 자체를 주지 않아 LLM 이 "전일과 동일" 류 비교를 쓸 수 없게 만든다.
    그런데 이 라우터가 구 번들 호환을 위해 changePercent 에 0.0 을 채워 보내므로, 그대로
    넘기면 그 분기가 영영 죽고 **전일 표본이 없는 날에도 "전일과 동일한 수준" 이라는 문장이
    브리핑에 실린다.** 없는 비교를 문장으로 만들어 주는 셈이라 여기서 끊는다.

    HTTP 응답은 손대지 않는다 — 구 키 계약은 화면 쪽 이야기고, 브리핑은 서버 안에서
    끝나는 경로라 정직한 값을 그대로 쓸 수 있다.
    """
    avg = today.get("avgCongestion")
    if not isinstance(avg, dict) or "changePercentOrNull" not in avg:
        return today
    return {**today, "avgCongestion": {**avg, "changePercent": avg["changePercentOrNull"]}}


@router.get("/dashboard/briefing")
async def get_dashboard_briefing():
    """오늘의 브리핑 — { briefing: str|null, llmStatus }.

    캐시(12분 TTL, KST 날짜 키) 히트 시 집계 쿼리 없이 즉시 반환한다. 미스면
    get_dashboard_today/get_impact 를 그대로 재사용해 집계 후 브리핑을 생성한다.
    """
    cached = briefing_service.cached_briefing()
    if cached is not None:
        return cached

    today_start, _ = _kst_today_range_utc()
    # 대시보드 프런트와 동일한 기준: impact 는 KST '오늘 00:00' 이후(오늘 지표).
    today, impact = await asyncio.gather(
        get_dashboard_today(),
        get_impact(since=today_start),
    )
    return await briefing_service.generate_briefing(_briefing_view(today), impact)
