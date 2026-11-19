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

from app.core.config import settings as app_settings
from app.core.authz import ROLE_ADMIN, forbid_judge_admin, get_current_profile, require_role
from app.core.executors import run_admin_io
from app.core.internal_accounts import filter_internal_roles, internal_ids_from_rows, is_internal_user
from app.core.region import INTERNAL_REGIONS, PUBLIC_REGION, apply_region, run_region_scoped
from app.core.supabase import fetch_all_rows, supabase_admin
from app.services import briefing_service, congestion_estimator_service, estimated_report_service
from app.services import reference_snapshot
from app.core.admin_coalesce import coalesced_admin_view

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/admin", tags=["admin"], dependencies=[Depends(require_role(ROLE_ADMIN))])

FACILITY_TYPES = {"restaurant", "cafe", "attraction", "culture"}

# 지역 격리 DB 가드(마이그레이션 20261101090000)의 거절 표식. 관제는 공개 지역(경주)만 다룬다(S3) —
# 서울 좌표로 만들거나(23514 CHECK) 서울 시설에 기록하려 하면(P0001 트리거) 입력 문제라 422 로 돌려준다.
_REGION_REJECTIONS = (
    "facility_region_not_public",
    "facility_region_immutable",
    "facilities_seoul_coords_need_seoul_region",
    "facilities_seoul_region_needs_seoul_coords",
    "facilities_region_known",
)
_REGION_REJECTED_DETAIL = "공개 지역(경주) 밖의 시설·좌표는 관제에서 다룰 수 없습니다."


def _region_rejected(exc: Exception) -> bool:
    text = f"{getattr(exc, 'code', '') or ''} {getattr(exc, 'message', None) or exc}"
    return any(marker in text for marker in _REGION_REJECTIONS)
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

# 심사용 관리자 계정(authz.JUDGE_ADMIN_EMAIL)으로는 막는 쓰기 두 곳의 거부 문구.
# 쿠폰 정책 슬라이더(PATCH /facilities/{id})는 기능설명서 F5 ⑤ 시연 경로라 막지 않는다.
_JUDGE_SETTINGS_DETAIL = "심사용 계정에서는 전체 설정을 바꿀 수 없어요."
_JUDGE_DELETE_DETAIL = "심사용 계정에서는 장소를 삭제할 수 없어요."


# =========================================================================
# PostgREST 행수 캡 회피 — 관리자 집계 공용 페이지네이션
# =========================================================================
# PostgREST 는 단일 응답을 1000행에서 자른다. `.limit(20000)` 처럼 더 큰 값을 걸어도 서버는
# 1000행만 돌려주고 **잘렸다는 사실은 응답 어디에도 남지 않는다.** 그래서 이 파일의 집계들은
# 오랫동안 앞 1000행만 보고 계산했다:
#   · 30일 추이가 (최신순 정렬 탓에) 최근 며칠로 쪼그라들었다.
#   · model-trust 의 활성 시설 수·커버리지·'수집 공백' 목록이 시설 1,000곳만 보고 만들어졌다
#     (활성 1,669곳 · 전체 1,688곳, 2026-09-20 실측 — 669곳이 관측 유무와 무관하게 통계에서 사라졌다).
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

    동기(블로킹) 함수 — 라우터에서는 run_admin_io(관리자 전용 풀)로 오프로드해 호출한다.
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
# 관제 지표의 공용 정의 — 내부 계정 · 추천 결정 · '관측' 출처 (P0-5 f · P1-1)
# =========================================================================
# 지표 엔드포인트 셋(/metrics · /metrics/trend · /impact)이 같은 말을 같은 뜻으로 쓰게 정의를 한곳에 둔다.
# 엔드포인트마다 따로 세면 한 화면의 수락률과 리포트의 수락률이 다른 모집단을 세게 된다.

# 내부 계정 — 관리자·개발자(users.role). 시연·점검으로 누른 수락·거절이 관광객의 결정으로 세이면, 표본이
# 얇은 지금은 그 몇 건이 수락률을 통째로 바꾼다. '무엇이 내부인가' 는 사장님 성적표와 같은 정의를 쓴다
# (app/core/internal_accounts.py).
# 관리자·개발자 계정 수는 몇 명 수준이다. 상한에 닿으면 _fetch_capped 가 경고를 남긴다.
_INTERNAL_USERS_CAP = 1000


def _fetch_internal_user_ids() -> frozenset[str]:
    """내부 계정(admin·developer) id 집합. 실패는 그대로 올린다 — 못 거른 수치를 거른 척 내보내지 않는다."""
    rows, _truncated = _fetch_capped(
        "users",
        "id, role",
        filter_internal_roles,
        _INTERNAL_USERS_CAP,
        endpoint="internal-users",
    )
    return internal_ids_from_rows(rows)


def _is_internal(row: dict, internal_ids) -> bool:
    return is_internal_user(row.get("user_id"), internal_ids)


# 추천 '결정' — 사용자가 추천된 장소 하나를 두고 명시적으로 고른 것.
#   · 수락 = recommendations.accepted = true, 또는 그 행에 수락 결정(user_feedback)이 붙은 경우
#            (/feedback 의 accepted_visit_intent, 메인 '바로 갈래요'(/recommendations/accept) — 옛 모양은
#             원본=추천인 새 행을 넣고, 새 모양은 노출된 행을 갱신한다. 둘 다 accepted=true 로 남는다)
#   · 거절 = 그 행에 'rejected' 결정이 붙은 경우(추천 화면 거절 + 메인 거절 — 메인 거절은 source='browse'
#            행으로 저장된다. 예전 수락률은 이 browse 행을 분모에서 빼면서 수락은 셌다 — 같은 모집단이 아니었다)
#   · 결정이 아닌 것: skipped · dismissed_batch · unsaved · 만족도(helpful 등) — 장소를 두고 고른 것이 아니다.
# 수락률 = 수락 ÷ (수락 + 거절). 분자·분모 모두 같은 행 집합(모든 source, 내부 계정 제외)에서 센다.
# 창은 추천 행의 created_at(노출 또는 메인 결정이 기록된 시각)이다.
_ACCEPT_DECISION_ACTIONS = frozenset({"accepted_visit_intent", "accepted"})
_REJECT_DECISION_ACTIONS = frozenset({"rejected"})
# 결정 판정에 필요한 칸만 받는다. user_feedback(action) 은 FK(recommendation_id) 임베드 —
# recommendations 라우터의 거절 경로가 이미 같은 임베드를 운영에서 쓴다.
_DECISION_SELECT = "id, user_id, accepted, created_at, source, user_feedback(action)"


def _embedded_rows(value) -> list[dict]:
    """PostgREST 임베드 값 → dict 목록. 관계 모양에 따라 list(1:N) 또는 dict(1:1)로 온다 — 둘 다 받는다."""
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        return [value]
    return []


def _decision_of(row: dict) -> str | None:
    """추천 행 하나의 결정 — 'accepted' | 'rejected' | None(결정 없음). 수락이 거절보다 이긴다."""
    actions = {str(item.get("action")) for item in _embedded_rows(row.get("user_feedback"))}
    if row.get("accepted") is True or actions & _ACCEPT_DECISION_ACTIONS:
        return "accepted"
    if actions & _REJECT_DECISION_ACTIONS:
        return "rejected"
    return None


def _is_browse(row: dict) -> bool:
    # source 칸이 없던 옛 행·가짜 행은 DB 기본값('spot')과 같게 읽는다.
    return (row.get("source") or "spot") == "browse"


def _decision_summary(rows: list[dict], internal_ids: set[str]) -> dict:
    """추천 행 → 결정 집계. 표본 수(decisions)를 비율과 늘 함께 싣는다."""
    accepted = rejected = shown = excluded = 0
    for row in rows:
        if _is_internal(row, internal_ids):
            excluded += 1
            continue
        if not _is_browse(row):
            shown += 1
        decision = _decision_of(row)
        if decision == "accepted":
            accepted += 1
        elif decision == "rejected":
            rejected += 1
    decisions = accepted + rejected
    return {
        "accepted": accepted,
        "rejected": rejected,
        # 수락률의 분모이자 표본 수(n).
        "decisions": decisions,
        "rate": round(accepted / decisions, 4) if decisions else None,
        # 같은 창의 추천 노출 행(browse 제외) — 결정이 아니다. 참고용 규모.
        "shown": shown,
        "excluded_internal": excluded,
    }


# '관측' 이 아닌 congestion_logs 출처 — 실측 평균·이상 건수·관측 일수에서 뺀다(P0-5 f).
#   · admin_override  : 관리자가 슬라이더로 넣은 값(사람의 입력이지 관측이 아니다)
#   · simulated · seed: 모의 발생·시드
#   · parking_derived : 주차 점유율에서 파생한 추정치(추정은 dashboard/today 의 estimated 가 따로 싣는다)
# 거부목록인 이유: 관측 출처(user_report · merchant_report · traffic_cctv · tour_api · event)는 늘 수 있지만,
# 비관측 출처는 마이그레이션으로만 생긴다. 출처를 모르는 옛 행·가짜 행은 관측으로 둔다(조용히 버리지 않는다).
NON_OBSERVATION_SOURCES = frozenset({"admin_override", "simulated", "seed", "parking_derived"})


def _is_observation(row: dict) -> bool:
    return str(row.get("source") or "") not in NON_OBSERVATION_SOURCES


def _exclude_non_observation(query):
    """PostgREST 필터로도 거른다(같은 칸에 neq 를 여러 번 걸면 AND 로 묶인다).

    목적은 상한(cap)을 비관측 행이 먼저 채우지 않게 하는 것이다. 파이썬 필터(_is_observation)만 두면 상한에서
    잘린 **뒤에** 거르게 된다 — simulate-peak 세 번(시설 수만큼 × 3 ≈ 5,000행)이면 최신순 조회의 상한을 모의 행이
    통째로 채워, 그 너머의 실제 관측이 있는데도 '마지막 관측 없음' 이 된다. 판정의 정본은 여전히 파이썬 쪽이다
    (호출부가 _is_observation 으로 한 번 더 거른다).
    """
    for source in sorted(NON_OBSERVATION_SOURCES):
        query = query.neq("source", source)
    return query


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
        res = await run_admin_io(
            supabase_admin.table("facilities").insert(req.model_dump()).execute
        )
        if not res.data:
            raise HTTPException(status_code=500, detail="시설 등록에 실패했습니다.")
        reference_snapshot.mark_dirty("facilities")  # 지도 참조 스냅샷에 알린다(app/services/reference_snapshot.py) — 다음 지도 요청이 방금 쓴 값을 본다.
        logger.info("admin_facility_created", facility_id=res.data[0].get("id"), name=req.name)
        return res.data[0]
    except HTTPException:
        raise
    except Exception as e:
        if _region_rejected(e):
            raise HTTPException(status_code=422, detail=_REGION_REJECTED_DETAIL) from None
        logger.error("admin_facility_create_failed", error=str(e))
        raise HTTPException(status_code=500, detail="시설 등록에 실패했습니다.")


@router.patch("/facilities/{facility_id}")
async def update_facility(facility_id: str, req: FacilityUpdate):
    fields = {k: v for k, v in req.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=422, detail="수정할 필드가 없습니다.")
    def _write(with_region: bool) -> list[dict]:
        # 공개 지역(경주) 시설만 고친다 — 서울(개발자 전용) 시설은 없는 시설과 같은 404(쿼리 안에서 거른다).
        query = supabase_admin.table("facilities").update(fields).eq("id", facility_id)
        if with_region:
            query = apply_region(query, PUBLIC_REGION)
        return query.execute().data or []

    try:
        rows = await run_admin_io(run_region_scoped, _write, region=PUBLIC_REGION)
        if not rows:
            raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.")
        reference_snapshot.mark_dirty("facilities")
        logger.info("admin_facility_updated", facility_id=facility_id, fields=list(fields))
        return rows[0]
    except HTTPException:
        raise
    except Exception as e:
        if _region_rejected(e):
            raise HTTPException(status_code=422, detail=_REGION_REJECTED_DETAIL) from None
        logger.error("admin_facility_update_failed", facility_id=facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="시설 수정에 실패했습니다.")


@router.delete("/facilities/{facility_id}", dependencies=[Depends(forbid_judge_admin(_JUDGE_DELETE_DETAIL))])
async def delete_facility(facility_id: str):
    def _delete(with_region: bool) -> list[dict]:
        query = supabase_admin.table("facilities").delete().eq("id", facility_id)
        if with_region:
            query = apply_region(query, PUBLIC_REGION)  # 서울 시설은 관제에서 지울 수 없다(404)
        return query.execute().data or []

    try:
        rows = await run_admin_io(run_region_scoped, _delete, region=PUBLIC_REGION)
        if not rows:
            raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.")
        reference_snapshot.mark_dirty("facilities")
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
    #    공개 지역(경주) 시설만 — 서울 시설은 404(쿼리 안에서 거른다. congestion_logs 트리거도 막는다).
    def _read(with_region: bool) -> list[dict]:
        query = supabase_admin.table("facilities").select("id, capacity").eq("id", facility_id)
        if with_region:
            query = apply_region(query, PUBLIC_REGION)
        return query.limit(1).execute().data or []

    try:
        fac_rows = await run_admin_io(run_region_scoped, _read, region=PUBLIC_REGION)
    except Exception as e:
        logger.error("admin_congestion_lookup_failed", facility_id=facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="혼잡도 설정에 실패했습니다.")
    if not fac_rows:
        raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.")

    capacity = fac_rows[0].get("capacity") or 0
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
        ins = await run_admin_io(
            supabase_admin.table("congestion_logs").insert(row).execute
        )
        if not ins.data:
            raise HTTPException(status_code=500, detail="혼잡도 설정에 실패했습니다.")
    except HTTPException:
        raise
    except Exception as e:
        if _region_rejected(e):
            raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.") from None
        logger.error("admin_congestion_override_failed", facility_id=facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="혼잡도 설정에 실패했습니다.")

    reference_snapshot.mark_dirty("congestion")  # 지도 참조 스냅샷에 알린다(app/services/reference_snapshot.py) — 다음 지도 요청이 방금 쓴 값을 본다.
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
        res = await run_admin_io(
            supabase_admin.table("system_settings").select("*").eq("id", 1).limit(1).execute
        )
        # 행이 없으면 null — 프런트가 기본값으로 폴백한다(마이그레이션 미적용 환경).
        return res.data[0] if res.data else None
    except Exception as e:
        logger.error("admin_settings_fetch_failed", error=str(e))
        raise HTTPException(status_code=500, detail="시스템 설정 조회에 실패했습니다.")


@router.put("/settings", dependencies=[Depends(forbid_judge_admin(_JUDGE_SETTINGS_DETAIL))])
async def update_settings(req: SettingsUpdate):
    try:
        payload = req.model_dump()
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        res = await run_admin_io(
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
        res = await run_admin_io(
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
        res = await run_admin_io(_update, payload)
    except Exception as exc:
        if reply_body is not None and _is_missing_reply_columns(exc):
            # 마이그레이션 미적용 DB — 상태 변경까지 같이 죽이지 않는다. 대신 답변이
            # 저장되지 않았다는 사실을 반드시 응답에 실어 보낸다(조용한 성공 금지).
            logger.warning("admin_inquiry_reply_column_missing", inquiry_id=inquiry_id)
            reply_saved = False
            reply_unavailable_reason = "schema_missing"
            try:
                res = await run_admin_io(_update, {"status": req.status})
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


def _normalize_since(since: str | None, days: int) -> str:
    """since(ISO8601) 검증·정규화. 없으면 최근 days 일 롤링 창의 시작. 잘못된 문자열은 422 —
    PostgREST 필터로 그대로 흘러가지 않게 한다."""
    if since:
        try:
            parsed = datetime.fromisoformat(since.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=422, detail="since 는 ISO8601 형식이어야 합니다.")
        # 오프셋 없는 값은 UTC 로 읽는다(DB 시각이 UTC 적재) — 오프셋이 있는 시각과 비교할 때 터지지 않게.
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.isoformat()
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


@router.get("/metrics")
@coalesced_admin_view("admin/metrics")
async def get_metrics(days: int = 28, since: str | None = None):
    """추천 결정·이용 지표 — { since, recommendations[], feedback[], truncated, acceptance, active_users }.

    acceptance  = 수락 ÷ (수락 + 거절) — 모든 source(메인 거절 포함)의 같은 행 집합, 내부 계정 제외.
                  decisions(표본 수)를 비율과 함께 싣는다. 결정이 0건이면 rate=null.
    active_users = 오늘(KST) 피드백을 남긴 순 사용자 수(users)와 그 행 수(events), 내부 계정 제외.
    recommendations · feedback = 구 번들용 원본 행(뜻 그대로: browse 제외 추천 행 · 피드백 행, 내부 계정 제외).
    since(ISO8601)가 오면 그 시각 이후, 없으면 최근 days 일.
    """
    days = max(1, min(days, 90))
    since = _normalize_since(since, days)
    today_start, _ = _kst_today_range_utc()
    # 오늘의 순 사용자는 창이 오늘 0시보다 늦게 시작해도 하루치를 본다.
    feedback_since = min(since, today_start, key=_parse_utc)
    try:
        (recs, recs_truncated), (feedback, fb_truncated), internal_ids = await asyncio.gather(
            run_admin_io(
                _fetch_capped,
                "recommendations",
                # 결정 판정에 필요한 칸 — 구 키(recommendations)도 같은 조회에서 뽑는다(왕복 한 번).
                _DECISION_SELECT,
                lambda q: q.gte("created_at", since)
                .order("created_at", desc=True)
                .order("id", desc=True),
                _METRICS_ROW_CAP,
                endpoint="metrics",
            ),
            run_admin_io(
                _fetch_capped,
                "user_feedback",
                "user_id, timestamp",
                lambda q: q.gte("timestamp", feedback_since)
                .order("timestamp", desc=True)
                .order("id", desc=True),
                _METRICS_ROW_CAP,
                endpoint="metrics",
            ),
            run_admin_io(_fetch_internal_user_ids),
        )
    except Exception as e:
        logger.error("admin_metrics_fetch_failed", error=str(e))
        raise HTTPException(status_code=500, detail="지표 조회에 실패했습니다.")

    # 구 키 — 예전 번들이 '수락 ÷ 행 수' 로 읽던 행들. 뜻(browse 제외 추천 행)은 그대로 두고 내부 계정만 뺀다.
    # 결정 판정용 칸(id·user_id·임베드)은 덜어 낸다 — 예전 응답에 없던 사용자 식별자를 늘리지 않는다.
    legacy_recs = [
        {key: value for key, value in row.items() if key not in ("id", "user_id", "user_feedback")}
        for row in recs
        if not _is_browse(row) and not _is_internal(row, internal_ids)
    ]
    legacy_feedback = [
        row for row in feedback
        if not _is_internal(row, internal_ids) and _timestamp_at_or_after(row.get("timestamp"), since)
    ]

    today_rows = [
        row for row in feedback
        if not _is_internal(row, internal_ids) and _timestamp_at_or_after(row.get("timestamp"), today_start)
    ]
    excluded_feedback = sum(
        1 for row in feedback
        if _is_internal(row, internal_ids) and _timestamp_at_or_after(row.get("timestamp"), today_start)
    )
    return {
        "since": since,
        "recommendations": legacy_recs,
        "feedback": legacy_feedback,
        # 필드 추가만(구 번들은 이 키를 읽지 않는다). 어느 한쪽이라도 상한에 닿으면 True.
        "truncated": recs_truncated or fb_truncated,
        # ── 새 키(추가만) ───────────────────────────────────────────────────────
        "acceptance": {**_decision_summary(recs, internal_ids), "since": since, "truncated": recs_truncated},
        "active_users": {
            "since": today_start,
            "users": len({str(row.get("user_id")) for row in today_rows if row.get("user_id")}),
            "events": len(today_rows),
            "excluded_internal": excluded_feedback,
            "truncated": fb_truncated,
        },
    }


def _timestamp_at_or_after(value, boundary: str) -> bool:
    """value(ISO) ≥ boundary(ISO). 문자열 비교는 표기(오프셋·소수점)가 섞이면 틀리므로 시각으로 비교한다."""
    if not value:
        return False
    try:
        return _parse_utc(str(value)) >= _parse_utc(boundary)
    except (TypeError, ValueError):
        return False


# model-trust 창 상한. 전량이 필요하지만 무한정 받을 수는 없는 조회들이라 상한은 유지하고,
# 닿으면 응답의 truncated·warnings 로 알린다(수치가 창 전체의 값이 아니게 되므로).
_TRUST_REC_CAP = 10000       # 추천 노출·스냅샷 가드레일
_TRUST_OUTCOME_CAP = 10000   # 추천→길찾기→방문 퍼널
_TRUST_LOG_CAP = 20000       # 관측 수·출처/티어 분포·시설 커버리지

# model-trust 가 recommendation_snapshot 에서 실제로 읽는 칸만 JSON 경로로 받는다(PostgREST `별칭:열->키`).
# 스냅샷 전체(칸 ~20개 — 추정·가용 근거·TourAPI 사실·참조 시설 등)를 최대 10,000행 받아 쥐던 것을
# 줄인다(합성 6,000행 실측: 파이썬 객체 16.5MB → 4.4MB). 관제 대시보드 OOM(2026-09-25 18:15 KST)의
# 주된 방어는 동시 실행 상한·메모리 반환(app.core.memory_guard)이고 이것은 보탬이다.
# 새 칸을 읽게 되면 여기에도 더한다.
_TRUST_REC_SELECT = ",".join((
    "id",
    "created_at",
    "s_scoring_mode:recommendation_snapshot->scoring_mode",
    "s_rank:recommendation_snapshot->rank",
    "s_open_status_at_arrival:recommendation_snapshot->open_status_at_arrival",
    "s_max_walk_minutes:recommendation_snapshot->max_walk_minutes",
    "s_travel_time:recommendation_snapshot->breakdown->travel_time",
    "s_wait_time:recommendation_snapshot->breakdown->wait_time",
    "s_congestion:recommendation_snapshot->congestion",
    "s_operating_hours:recommendation_snapshot->tourapi_facts->operating_hours",
))


def _trust_snapshot(row: dict) -> dict:
    """_TRUST_REC_SELECT 로 받은 행을 model-trust 가 읽던 스냅샷 모양으로 되돌린다.

    예전 조회(`recommendation_snapshot` 통째)는 행에 스냅샷 dict 가 그대로 있었다 — 그 모양도 받아 준다
    (테스트 가짜·구 응답 호환). 없는 칸은 None 이라 `.get()` 결과가 예전과 같다.
    """
    full = row.get("recommendation_snapshot")
    if isinstance(full, dict):
        return full
    return {
        "scoring_mode": row.get("s_scoring_mode"),
        "rank": row.get("s_rank"),
        "open_status_at_arrival": row.get("s_open_status_at_arrival"),
        "max_walk_minutes": row.get("s_max_walk_minutes"),
        "breakdown": {"travel_time": row.get("s_travel_time"), "wait_time": row.get("s_wait_time")},
        "congestion": row.get("s_congestion"),
        "tourapi_facts": {"operating_hours": row.get("s_operating_hours")},
    }


# 경주가 아닌 추천 행의 지역 표시 — recommendations 라우터가 **경주가 아닌 추천에만** 스냅샷에 적는다(경주 행에는 없다).
# 관제는 경주 숫자만 본다: 개발자가 서울 테스트베드에서 받은 추천·방문 결과를 model-trust 에 섞지 않는다(S3).
_REC_REGION_PATH = "recommendation_snapshot->>region"


def _is_internal_region_snapshot(row: dict) -> bool:
    snapshot = row.get("recommendation_snapshot")
    return isinstance(snapshot, dict) and snapshot.get("region") is not None


def _fetch_trust_recommendations(since: str) -> tuple[list[dict], bool]:
    """model-trust 의 추천 창 — 얇은 JSON 경로 조회, 거부되면 예전 통째 조회로 한 번 물러선다.

    JSON 경로 select 는 운영 PostgREST 에서 처음 쓰는 모양이라, 만에 하나 거부(400)돼도 관제 화면이
    500 으로 깨지지 않게 한다. 물러선 조회는 메모리를 더 쓰지만 게이트(app.core.memory_guard)가 동시
    실행을 묶고 있다. 두 번째도 실패하면 예외를 그대로 올린다(라우터가 500 으로 바꾼다).

    경주가 아닌 추천(스냅샷의 지역 표시)은 쿼리 안에서 뺀다 — 상한(10,000행)을 서울 행이 먹지 않게.
    물러선 조회는 JSON 경로 필터도 쓰지 않고 받은 뒤 같은 기준으로 뺀다.
    """
    def _filters(q):
        return (
            q.eq("source", "spot")
            .gte("created_at", since)
            .order("created_at", desc=True)
            .order("id", desc=True)
        )

    def _public_only(q):
        return _filters(q.is_(_REC_REGION_PATH, "null"))

    try:
        return _fetch_capped(
            "recommendations", _TRUST_REC_SELECT, _public_only, _TRUST_REC_CAP, endpoint="model-trust"
        )
    except Exception as exc:  # noqa: BLE001 — 어떤 거부든 한 번은 통째 조회로 물러선다
        logger.warning("admin_trust_slim_select_failed", error=str(exc))
        rows, truncated = _fetch_capped(
            "recommendations", "id,recommendation_snapshot,created_at", _filters, _TRUST_REC_CAP,
            endpoint="model-trust",
        )
        return [row for row in rows if not _is_internal_region_snapshot(row)], truncated


# 방문 결과의 지표 칸. 경주 숫자에서 서울 방문 결과를 빼는 기본 경로는 추천 임베드(!inner)의 지역 표시 필터다.
_TRUST_OUTCOME_COLUMNS = "recommendation_id,navigation_started_at,arrival_confirmed_at,rated_at,rating"
_TRUST_OUTCOME_EMBED_ALIAS = "recommendation"
_TRUST_OUTCOME_PUBLIC_SELECT = f"{_TRUST_OUTCOME_COLUMNS},{_TRUST_OUTCOME_EMBED_ALIAS}:recommendations!inner(id)"
_OUTCOME_REC_REGION_PATH = f"{_TRUST_OUTCOME_EMBED_ALIAS}.{_REC_REGION_PATH}"
# 물러선 경로의 서울 추천 id 조회 창 — 지표 기간보다 이만큼 앞에서 시작한다(방문 결과는 추천 직후에 생기지만,
# 기간 경계 직전의 추천이 기간 안에 방문 결과를 남길 수 있다).
_TRUST_INTERNAL_ID_SLACK = timedelta(days=2)


def _fetch_trust_outcomes(since: str) -> tuple[list[dict], bool]:
    """model-trust 의 방문 결과 창 — 경주 추천의 방문 결과만.

    방문 결과 행에는 지역이 없다. 추천 임베드(``recommendations!inner(id)``)에 스냅샷 지역 표시 필터를 걸어 **쿼리
    안에서** 서울 방문 결과를 뺀다 — 별도 id 조회·상한·실패 시 빈 집합 같은 틈이 없다. 임베드 필터가 거부되면(운영
    PostgREST 가 모르는 모양) 한 번 물러선다: 필터 없이 받고, 지표 기간에 묶인 서울 추천 id 로 뺀다.
    """

    def _filters(q):
        return (
            q.gte("created_at", since)
            .order("created_at", desc=True)
            .order("recommendation_id", desc=True)  # PK — created_at 동률에서의 tiebreak
        )

    try:
        rows, truncated = _fetch_capped(
            "recommendation_outcomes",
            _TRUST_OUTCOME_PUBLIC_SELECT,
            lambda q: _filters(q.is_(_OUTCOME_REC_REGION_PATH, "null")),
            _TRUST_OUTCOME_CAP,
            endpoint="model-trust",
        )
        # 임베드 칸은 필터용이다 — 행 모양은 예전과 같게 둔다.
        return [{k: v for k, v in row.items() if k != _TRUST_OUTCOME_EMBED_ALIAS} for row in rows], truncated
    except Exception as exc:  # noqa: BLE001 — 어떤 거부든 한 번은 예전 방식으로 물러선다
        logger.warning("admin_trust_outcome_region_embed_failed", error=str(exc))
    excluded = _fetch_internal_region_recommendation_ids(since)
    if excluded is None:
        # 서울 추천을 가려낼 수 없다 — 방문 결과를 세면 서울이 경주 퍼널에 섞인다(열린 쪽 실패). 방문 결과 지표를
        # 비우고 절단으로 알린다(화면 경고 metrics_truncated — 수치가 창 전체의 값이 아니다).
        logger.error("admin_trust_outcomes_withheld_region_unknown")
        return [], True
    rows, truncated = _fetch_capped(
        "recommendation_outcomes", _TRUST_OUTCOME_COLUMNS, _filters, _TRUST_OUTCOME_CAP, endpoint="model-trust",
    )
    if excluded:
        rows = [row for row in rows if str(row.get("recommendation_id")) not in excluded]
    return rows, truncated


def _fetch_internal_region_recommendation_ids(since: str) -> frozenset[str] | None:
    """경주가 아닌 추천 행 id(지표 기간 + 여유 안) — 물러선 경로에서 방문 결과를 경주 숫자에서 빼는 데 쓴다.

    기간(created_at)에 묶고 created_at 순으로 읽는다 — 표 전체를 훑지 않는다. 집합이 완전하지 않으면(조회 실패·
    상한 도달) None 이다 — 호출부는 방문 결과를 세지 않는다(닫힌 쪽). 관제 화면을 500 으로 깨뜨리지도 않는다.
    """
    try:
        window_start = (datetime.fromisoformat(since) - _TRUST_INTERNAL_ID_SLACK).isoformat()
    except (TypeError, ValueError):
        window_start = since
    ids: set[str] = set()
    try:
        for region in sorted(INTERNAL_REGIONS):
            rows, truncated = _fetch_capped(
                "recommendations",
                "id",
                lambda q, region=region: q.eq(_REC_REGION_PATH, region)
                .gte("created_at", window_start)
                .order("created_at", desc=True)
                .order("id", desc=True),
                _TRUST_OUTCOME_CAP,
                endpoint="model-trust",
            )
            if truncated:
                logger.warning("admin_trust_internal_region_ids_truncated", region=region, cap=_TRUST_OUTCOME_CAP)
                return None
            ids.update(str(row["id"]) for row in rows if row.get("id"))
    except Exception as exc:  # noqa: BLE001 — 관제 화면은 깨뜨리지 않는다(호출부가 방문 결과를 비운다)
        logger.warning("admin_trust_internal_region_ids_failed", error=str(exc))
        return None
    return frozenset(ids)


def _fetch_public_facility_rows() -> list[dict]:
    """model-trust 의 시설 전량 — 공개 지역(경주)만, 지역은 쿼리 안에서(region 컬럼 전이면 경주 폴백)."""

    def _read(with_region: bool) -> list[dict]:
        def _filters(query):  # range 페이지 경계 고정
            return (apply_region(query, PUBLIC_REGION) if with_region else query).order("id")

        return fetch_all_rows(supabase_admin, "facilities", "id,name,type,is_active", _POSTGREST_PAGE_SIZE, _filters)

    return run_region_scoped(_read, region=PUBLIC_REGION)


@router.get("/model-trust")
@coalesced_admin_view("admin/model-trust")
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
            run_admin_io(
                # 활성 모델은 정의상 1행이다 — limit(1) 은 의도된 상한(페이지네이션 불필요).
                supabase_admin.table("model_registry")
                .select("version,status,real_data_count,training_started_at,training_ended_at,source_composition,metrics")
                .eq("status", "active").limit(1).execute
            ),
            run_admin_io(_fetch_trust_recommendations, since),
            # 경주 추천의 방문 결과만 — 서울 방문 결과는 조회 안에서 빠진다(_fetch_trust_outcomes).
            run_admin_io(_fetch_trust_outcomes, since),
            run_admin_io(
                _fetch_capped,
                "congestion_logs",
                "facility_id,source,evidence_tier,timestamp",
                lambda q: q.gte("timestamp", since)
                .order("timestamp", desc=True)
                .order("id", desc=True),
                _TRUST_LOG_CAP,
                endpoint="model-trust",
            ),
            run_admin_io(
                # 시설은 **전량**이 필요하다: 아래 facility_gaps 는 '관측이 하나도 없는 시설'
                # 목록이라, 조회에서 빠진 시설은 공백으로도 잡히지 않고 active_facilities·
                # 커버리지 분모까지 함께 틀어진다. 예전의 .limit(5000) 은 시설 수(활성 1,669곳,
                # 2026-09-20 실측)보다 컸으니 무해해 보였지만, 정작 자른 것은 PostgREST 의 1000행 캡이었다.
                # 관제는 공개 지역(경주)만 — 서울(개발자 전용) 시설이 공백 목록·분모에 섞이지 않게(S3).
                _fetch_public_facility_rows,
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
        snapshot = _trust_snapshot(row)
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
# 30일 추이 — 대시보드 '③' 차트와 성과 리포트의 실측 소스 (E3 지표 리얼리티)
# congestion_logs 일평균 혼잡도(현장 관측만) + 추천 결정(수락·거절)을 KST 일 단위로 집계한다.
# 반사실('도입 전') 기준선은 측정할 수 없어 제공하지 않는다 — 실측 두 계열만 반환하고, 표본이 없는 날은
# null 로 둔다. 화면은 표본이 모자라면 '표본 부족' 으로 그린다(운영 화면은 예시 곡선으로 채우지 않는다).
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
@coalesced_admin_view("admin/metrics/trend")
async def get_metrics_trend(days: int = 30):
    """최근 days일(KST 일 단위, 오늘 포함) 현장 관측 혼잡·추천 결정 추이 — 과거→오늘 순 daily 배열.

    avg_congestion·samples 는 현장 관측만 센다 — 관리자 입력(admin_override)·모의(simulated)·시드(seed)·
    주차 파생 추정(parking_derived)은 뺀다(excluded_sources). decisions·accepted·rejected 는 /metrics 의
    수락률과 같은 정의(모든 source, 내부 계정 제외)다. rec_total·rec_accepted 는 구 번들용 키다
    (browse 제외 추천 행 수·그중 수락 행 수, 내부 계정 제외).
    """
    days = max(1, min(days, 90))
    today_start, _ = _kst_today_range_utc()
    since = (datetime.fromisoformat(today_start) - timedelta(days=days - 1)).isoformat()
    try:
        (logs, logs_truncated), (recs, recs_truncated), internal_ids = await asyncio.gather(
            run_admin_io(
                _fetch_capped,
                "congestion_logs",
                "congestion_level, timestamp, source",
                # 상한 절단 시 최근 일자부터 보존(desc). id 는 동률 tiebreak — simulate-peak 이
                # 수천 행을 **같은 timestamp** 로 넣기 때문에 페이지 경계가 실제로 흔들린다.
                # 비관측 출처는 쿼리에서도 뺀다 — 모의 발생 몇 번이 상한을 채워 관측을 밀어내지 않게.
                lambda q: _exclude_non_observation(q.gte("timestamp", since))
                .order("timestamp", desc=True)
                .order("id", desc=True),
                _TREND_LOG_CAP,
                endpoint="metrics/trend",
            ),
            run_admin_io(
                _fetch_capped,
                "recommendations",
                # 메인 거절(source='browse')도 결정이라 출처를 거르지 않는다(구 키는 아래에서 browse 를 뺀다).
                _DECISION_SELECT,
                lambda q: q.gte("created_at", since)
                .order("created_at", desc=True)
                .order("id", desc=True),
                _TREND_REC_CAP,
                endpoint="metrics/trend",
            ),
            run_admin_io(_fetch_internal_user_ids),
        )
    except Exception as e:
        logger.error("admin_metrics_trend_failed", error=str(e))
        raise HTTPException(status_code=500, detail="분산 추이 집계에 실패했습니다.")

    cong: dict[str, dict[str, float]] = {}
    for row in logs:
        if not _is_observation(row):
            continue
        day = _kst_date(row.get("timestamp"))
        if not day:
            continue
        acc = cong.setdefault(day, {"sum": 0.0, "n": 0})
        acc["sum"] += float(row.get("congestion_level") or 0)
        acc["n"] += 1

    rec_agg: dict[str, dict[str, int]] = {}
    for row in recs:
        if _is_internal(row, internal_ids):
            continue
        day = _kst_date(row.get("created_at"))
        if not day:
            continue
        acc = rec_agg.setdefault(day, {"total": 0, "accepted_shown": 0, "accepted": 0, "rejected": 0})
        if not _is_browse(row):
            acc["total"] += 1
            if row.get("accepted"):
                acc["accepted_shown"] += 1
        decision = _decision_of(row)
        if decision == "accepted":
            acc["accepted"] += 1
        elif decision == "rejected":
            acc["rejected"] += 1

    first_kst = datetime.fromisoformat(since) + _KST_OFFSET
    daily = []
    for i in range(days):
        day = (first_kst + timedelta(days=i)).strftime("%Y-%m-%d")
        c = cong.get(day)
        r = rec_agg.get(day) or {"total": 0, "accepted_shown": 0, "accepted": 0, "rejected": 0}
        daily.append({
            "date": day,
            # 관측 없는 날은 null 센티넬 — 관측 0.0 과 구분(대시보드 히트맵과 동일 규약)
            "avg_congestion": _js_round(c["sum"] / c["n"], 3) if c and c["n"] else None,
            "samples": int(c["n"]) if c else 0,
            # 구 키(뜻 그대로) — browse 제외 추천 행 수 · 그중 수락 행 수.
            "rec_total": r["total"],
            "rec_accepted": r["accepted_shown"],
            # 새 키 — 결정 기준. 하루 수락률 = accepted ÷ decisions(표본 수 decisions 와 함께 읽는다).
            "decisions": r["accepted"] + r["rejected"],
            "accepted": r["accepted"],
            "rejected": r["rejected"],
        })

    # 두 계열 중 하나라도 상한에 닿으면 daily 의 앞쪽(오래된 날)이 실제보다 비어 보인다.
    return {
        "days": days,
        "daily": daily,
        "truncated": logs_truncated or recs_truncated,
        # 새 키 — avg_congestion·samples 가 무엇을 셌는지(현장 관측) 응답이 스스로 말한다.
        "congestion_basis": "observed",
        "excluded_sources": sorted(NON_OBSERVATION_SOURCES),
    }


# =========================================================================
# 리포트 화면의 **일별 추정 추이** — 경주 추정 모드의 일괄 경로
# =========================================================================
# 왜 `/metrics/trend` 에 키를 더하지 않고 **별도 엔드포인트**인가:
#
#   · `/metrics/trend` 는 대시보드도 부른다. 거기에 몇 초짜리 추정 계산을 붙이면 추정과
#     아무 상관 없는 화면이 같이 느려진다.
#   · 화면이 실측과 추정을 **따로** 요청하면, 추정이 느리거나 죽어도 실측 응답은 애초에
#     영향을 받을 수 없다(같은 응답 안에서 shield/timeout 으로 막는 것보다 강한 보장이다).
#
# 실패를 HTTP 오류로 만들지 않는 이유: 이 화면들에게 '추정이 없다' 는 정상 상태다(실측이
# 있으면 애초에 쓰지 않는다). 500 을 주면 화면이 '관제 API 장애' 라고 말하게 되는데 그건
# 사실이 아니다. 대신 available=false + reason 으로 **왜 없는지**를 싣는다.
_REPORT_ESTIMATE_TIMEOUT_SECONDS = 10.0
# 같은 기간의 계산이 이미 돌고 있으면 합류한다(두 리포트 화면이 같은 30일을 동시에 부른다).
_report_estimate_inflight: dict[tuple[int, str], asyncio.Task] = {}


def _report_estimate_task_done(key: tuple[int, str], task: asyncio.Task) -> None:
    """끝난 계산을 합류 목록에서 빼고 예외를 회수한다(dashboard/today 와 같은 이유)."""
    if _report_estimate_inflight.get(key) is task:
        _report_estimate_inflight.pop(key, None)
    if not task.cancelled():
        task.exception()


def _empty_report_estimate(days: int, reason: str) -> dict:
    """추정을 못 낸 응답. 모양은 성공과 같게 두어 화면이 키 존재로 분기하지 않게 한다."""
    return {
        "days": days, "available": False, "reason": reason,
        "startDateKst": None, "endDateKst": None, "samplingMinutes": None,
        "daily": [], "basis": None,
    }


@router.get("/reports/estimated")
@coalesced_admin_view("admin/reports/estimated")
async def get_estimated_report(days: int = 30):
    """최근 days일(KST, 오늘 포함)의 **추정** 일별 집계 — 실측이 아니다.

    반환: { days, available, reason, startDateKst, endDateKst, samplingMinutes, daily[], basis }
      · daily[i] = { date, avgCongestion|null, sampleCount, snapshotCount, anomalyCount|null,
                     byType: { <시설 유형>: { avgCongestion, sampleCount, anomalyCount } } }
      · basis    = 산식·가중치·반경·표본 간격·주차장 수·관측 시각·보정 상태
                   (estimated_report_service.aggregate_estimated_days)

    ⚠️ 이 응답에는 **인원 수가 없다.** 추정치는 0~1 의 혼잡도 비율이고 사람 수가 아니다.
    '몇 명' 칸을 이 값으로 채우면 없는 관측을 만들어 내는 것이다 — 화면은 그 칸을 0 으로
    채우지 말고 "추정에는 인원 수가 없다" 고 말해야 한다.

    available=false 의 reason:
      · "timeout"        — 상한(10초) 안에 못 끝냈다. 계산은 shield 안에서 계속 돌아 캐시를
                           채우므로 다음 새로고침은 대개 즉시 성공한다.
      · "compute_failed" — 계산 중 예외(원본 조회 실패 등). 서버 로그에 사유가 남는다.
      · "bad_shape"      — 계산 결과 모양이 어긋났다(있을 수 없지만, 조용히 흘리지 않는다).
    """
    days = max(1, min(days, estimated_report_service.MAX_DAYS))
    key = (days, _kst_date_str(datetime.now(timezone.utc)))
    loop = asyncio.get_running_loop()
    task = _report_estimate_inflight.get(key)
    # 다른 이벤트 루프(테스트 클라이언트 재생성 등)에서 만든 태스크는 await 할 수 없다.
    if task is None or task.done() or task.get_loop() is not loop:
        task = asyncio.ensure_future(estimated_report_service.estimated_daily_series(days))
        task.add_done_callback(lambda done, k=key: _report_estimate_task_done(k, done))
        _report_estimate_inflight[key] = task
    try:
        result = await asyncio.wait_for(asyncio.shield(task), timeout=_REPORT_ESTIMATE_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        logger.warning("admin_report_estimate_timeout", days=days, timeout_s=_REPORT_ESTIMATE_TIMEOUT_SECONDS)
        return _empty_report_estimate(days, "timeout")
    except Exception as e:  # noqa: BLE001 — 추정 실패가 리포트 화면을 죽이면 안 된다
        logger.warning("admin_report_estimate_failed", days=days, error=str(e), error_type=type(e).__name__)
        return _empty_report_estimate(days, "compute_failed")
    if not isinstance(result, dict) or not isinstance(result.get("daily"), list):
        logger.warning("admin_report_estimate_bad_shape", days=days, type=type(result).__name__)
        return _empty_report_estimate(days, "bad_shape")
    return {**result, "available": True, "reason": None}


# =========================================================================
# 추천 수락 결과 — 재배치(도착 확인)·예상 대기 차이(모델 추정) 집계 (admin/dashboard 위젯) — P1-1
# =========================================================================
# '재배치' = 수락 + 원본 시설이 있고 + 원본 ≠ 목적지 + 도착 확인(recommendation_outcomes.arrival_confirmed_at).
#   예전에는 수락 행 수였다. 그런데 메인 '바로 갈래요' 는 원본 = 목적지인 행을 남기고(옛 모양은 새 행, 새 모양은
#   노출 행 갱신 — 둘 다 원본 = 목적지다), 수락만 하고 가지 않은 사람도 셌다 — 둘 다 '혼잡지에서 옮겨 갔다' 의
#   증거가 아니다. 그래서 수락은 넷으로 나눠 따로 센다(합이 accepted_total — 표본 수):
#     relocations                 원본 ≠ 목적지 · 도착 확인
#     accepted_moves_unconfirmed  원본 ≠ 목적지 · 도착 확인 없음
#     accepted_same_facility      원본 = 목적지(바로 갈래요·유형별 목록에서 고른 곳)
#     accepted_missing_facility   원본 또는 목적지 id 가 비었다(시설 삭제로 SET NULL 된 행)
#
# '예상 대기 차이(모델 추정)' = Σ max(0, 원본 예상대기 − 대안 예상대기) — **재배치 건만**.
#   예상대기는 혼잡도 × 업종 처리시간 × 시간대 계수(services/spot/wait_time.py)로 추천 생성 시점에 계산해
#   score_breakdown 에 저장한 값이다. 측정한 대기도, 측정한 절감도 아니다(그래서 '절감' 이라 부르지 않는다).
#   · wait_model     : 두 예상대기가 저장된 행 — 그 차이를 쓴다.
#   · congestion_gap : 원본 예상대기가 없는 행 — incentive_relief(원본 혼잡 − 도착 시점 예측 혼잡, 0~1)
#                      × 15분(업종 기본 처리시간 중앙값)으로 근사한다.
#   · unavailable    : 둘 다 없는 행 — 더하지 않는다.
# 구 키(relocations·saved_wait_minutes·measured·estimated)는 이름을 그대로 두고 위 정의를 따른다.
# 'measured' 는 이름과 달리 측정이 아니라 wait_model 행 수다(구 번들 호환 때문에 이름만 남겼다).
# =========================================================================

_LEGACY_RELIEF_TO_MINUTES = 15.0  # wait_time.DEFAULT_PROCESSING_TIMES 중앙값(카페12·식당25·관광15·문화15)
# 수락 추천 상한. 예상 대기 차이는 **합계**라 행이 빠지면 그만큼 과소 집계된다. 상한에 닿으면 truncated 로 알린다.
_IMPACT_REC_CAP = 5000
# 도착 확인 조회 상한 — 길찾기를 시작한 추천만 행이 생기므로 수락보다 적다(model-trust 와 같은 상한).
_IMPACT_OUTCOME_CAP = _TRUST_OUTCOME_CAP
_IMPACT_REC_SELECT = (
    "id, user_id, accepted, original_facility_id, recommended_facility_id, score_breakdown, created_at"
)


def _as_float(value) -> float | None:
    """score_breakdown(JSONB) 값의 방어적 float 변환 — 없거나 숫자가 아니면 None."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _impact_summary(rows: list[dict], arrived_ids: set[str], internal_ids: set[str]) -> dict:
    """수락 행 → 재배치 분류 + 예상 대기 차이. 순수 함수(라우터·테스트가 같이 쓴다)."""
    counts = {"relocations": 0, "moves_unconfirmed": 0, "same_facility": 0, "missing_facility": 0}
    basis = {"wait_model": 0, "congestion_gap": 0, "unavailable": 0}
    wait_diff = 0.0
    accepted_total = excluded = 0
    for row in rows:
        # 쿼리가 accepted=true 로 거른다 — 그래도 명시적 False 는 버린다(필터를 흡수하는 가짜·구 응답 방어).
        if row.get("accepted") is False:
            continue
        if _is_internal(row, internal_ids):
            excluded += 1
            continue
        accepted_total += 1
        origin, destination = row.get("original_facility_id"), row.get("recommended_facility_id")
        if not origin or not destination:
            counts["missing_facility"] += 1
            continue
        if str(origin) == str(destination):
            counts["same_facility"] += 1
            continue
        if str(row.get("id")) not in arrived_ids:
            counts["moves_unconfirmed"] += 1
            continue
        counts["relocations"] += 1
        breakdown = row.get("score_breakdown") if isinstance(row.get("score_breakdown"), dict) else {}
        original_wait = _as_float(breakdown.get("original_wait_time"))
        candidate_wait = _as_float(breakdown.get("wait_time"))
        relief = _as_float(breakdown.get("incentive_relief"))
        if original_wait is not None and candidate_wait is not None:
            wait_diff += max(0.0, original_wait - candidate_wait)
            basis["wait_model"] += 1
        elif relief is not None:
            wait_diff += max(0.0, relief) * _LEGACY_RELIEF_TO_MINUTES
            basis["congestion_gap"] += 1
        else:
            basis["unavailable"] += 1
    return {
        "accepted_total": accepted_total,
        "counts": counts,
        "basis": basis,
        "wait_diff": round(wait_diff, 1),
        "excluded_internal": excluded,
    }


@router.get("/impact")
@coalesced_admin_view("admin/impact")
async def get_impact(since: str | None = None, days: int = 1):
    """추천 수락 결과 — 재배치(원본 ≠ 목적지 · 도착 확인) 건수와 그 건들의 예상 대기 차이(모델 추정, 분).

    수락은 재배치·도착 미확인·같은 장소·시설 정보 없음으로 나눠 따로 싣고(합 = accepted_total), 내부 계정
    (admin·developer)은 뺀다. since(ISO8601, UTC)가 오면 그 시각 이후, 없으면 최근 days(기본 1)일.
    """
    days = max(1, min(days, 90))
    # 검증 겸 정규화 — 잘못된 문자열이 PostgREST 필터로 그대로 흘러가지 않게 한다.
    since = _normalize_since(since, days)

    try:
        (rows, recs_truncated), (outcomes, outcomes_truncated), internal_ids = await asyncio.gather(
            run_admin_io(
                _fetch_capped,
                "recommendations",
                _IMPACT_REC_SELECT,
                lambda q: q.eq("accepted", True)
                .gte("created_at", since)
                .order("created_at", desc=True)
                .order("id", desc=True),
                _IMPACT_REC_CAP,
                endpoint="impact",
            ),
            run_admin_io(
                _fetch_capped,
                "recommendation_outcomes",
                "recommendation_id, arrival_confirmed_at",
                # 결과 행은 추천 뒤에만 생기므로 같은 창(created_at ≥ since)이 창 안 추천의 결과를 전부 덮는다.
                lambda q: q.gte("created_at", since)
                .order("created_at", desc=True)
                .order("recommendation_id", desc=True),  # PK — created_at 동률에서의 tiebreak
                _IMPACT_OUTCOME_CAP,
                endpoint="impact",
            ),
            run_admin_io(_fetch_internal_user_ids),
        )
    except Exception as e:
        logger.error("admin_impact_fetch_failed", error=str(e))
        raise HTTPException(status_code=500, detail="분산 효과 집계에 실패했습니다.")

    arrived_ids = {
        str(row.get("recommendation_id")) for row in outcomes
        if row.get("recommendation_id") and row.get("arrival_confirmed_at")
    }
    summary = _impact_summary(rows, arrived_ids, internal_ids)
    counts, basis = summary["counts"], summary["basis"]
    return {
        "since": since,
        # 구 키 — 뜻이 바뀌었다(위 머리 주석): 수락 행 수 → 도착이 확인된 재배치.
        "relocations": counts["relocations"],
        # 구 키 — 재배치 건의 예상 대기 차이 합(모델 추정). 측정한 절감이 아니다.
        "saved_wait_minutes": summary["wait_diff"],
        # 구 키 — 이름과 달리 '측정' 이 아니다: wait_model 행 수 · congestion_gap 행 수.
        "measured": basis["wait_model"],
        "estimated": basis["congestion_gap"],
        # 필드 추가만(구 번들은 이 키를 읽지 않는다). True 면 위 건수·합계는 하한이다.
        "truncated": recs_truncated or outcomes_truncated,
        # ── 새 키(추가만) ───────────────────────────────────────────────────────
        "accepted_total": summary["accepted_total"],
        "accepted_moves_unconfirmed": counts["moves_unconfirmed"],
        "accepted_same_facility": counts["same_facility"],
        "accepted_missing_facility": counts["missing_facility"],
        "expected_wait_diff_minutes": summary["wait_diff"],
        "expected_wait_diff_basis": basis,
        "excluded_internal": summary["excluded_internal"],
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
# 하루를 집계로 인정하는 최소 표본. 오늘 구간과 폴백 기준일에 **같은 기준**을 쓴다 —
# 기준이 갈리면 폴백 화면만 조용히 더 무른 규칙으로 그려진다.
_DASHBOARD_MIN_DAY_SAMPLES = 5
# 폴백 기준일을 찾을 때 훑는 최근 관측 시각 수(타임스탬프 한 칼럼만 읽는다).
# simulate-peak 한 번이 시설 수만큼(약 1,660행) 넣으므로 이 상한은 '표본이 두꺼운 날' 여럿을
# 덮고, 반대로 1~4건짜리 얇은 날만 이어질 때는 5,000일치까지 거슬러 올라간다.
_DASHBOARD_FALLBACK_SCAN_CAP = 5000


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


def _parse_utc(ts: str) -> datetime:
    """DB 타임스탬프(UTC 적재) → tz-aware UTC datetime. 나이브면 UTC 로 간주한다."""
    dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _kst_day_range_utc(moment: datetime) -> tuple[str, str]:
    """임의 UTC 시각이 속한 **KST 하루**의 00:00~23:59:59.999 를 UTC ISO 로.
    _kst_today_range_utc 의 '오늘' 을 임의 날짜로 일반화한 것 — 폴백 기준일 조회가 쓴다."""
    kst = moment.astimezone(timezone.utc) + _KST_OFFSET
    start = datetime(kst.year, kst.month, kst.day, 0, 0, 0, tzinfo=timezone.utc) - _KST_OFFSET
    end = datetime(kst.year, kst.month, kst.day, 23, 59, 59, 999000, tzinfo=timezone.utc) - _KST_OFFSET
    return start.isoformat(), end.isoformat()


def _kst_date_str(moment: datetime) -> str:
    """UTC 시각이 속한 KST 날짜(YYYY-MM-DD).

    화면이 UTC ISO 를 받아 스스로 KST 날짜를 계산하면, 이 파일의 KST 규칙과 두 곳에서
    갈라진다(그리고 브라우저 TZ 가 KST 가 아닌 관리자에게서만 어긋난다). 날짜 라벨은
    집계를 소유한 서버가 문자열로 확정해 내려보낸다.
    """
    kst = moment.astimezone(timezone.utc) + _KST_OFFSET
    return f"{kst.year:04d}-{kst.month:02d}-{kst.day:02d}"


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
    return (_parse_utc(ts) + _KST_OFFSET).hour


def _fetch_day_logs(start: str, end: str) -> list[dict]:
    """하루치 혼잡 로그(시설명/유형 조인 포함). 절단 여부는 _fetch_capped 가 구조화 로그로 남긴다."""
    logs, _truncated = _fetch_capped(
        "congestion_logs",
        # source 를 함께 읽는다 — 이 카드가 그리는 평균·히트맵이 **무엇으로 만들어졌는지**
        # 화면이 말할 수 있어야 하기 때문이다. 주차 파생 추정치(parking_derived)가 섞이면
        # 숫자는 그대로여도 '실측 혼잡' 이 아니게 되고, 그 사실은 값 옆에 있어야 한다.
        "congestion_level, current_count, timestamp, source, facility:facilities(name, type)",
        # 비관측 출처는 쿼리에서 뺀다 — 모의·시드 행이 상한을 먼저 채우면 그 뒤의 관측이 잘린다.
        lambda q: _exclude_non_observation(q.gte("timestamp", start).lte("timestamp", end))
        .order("timestamp", desc=False)
        .order("id", desc=False),  # simulate-peak 이 동일 timestamp 를 대량 생성한다
        _DASHBOARD_LOG_CAP,
        endpoint="dashboard/today",
    )
    return logs


def _fetch_day_levels(start: str, end: str) -> list[dict]:
    """전일 비교용 — congestion_level(+ 관측 판정용 source). 변화율(%) 하나를 만들 뿐이라 상한이 더 낮다."""
    logs, _truncated = _fetch_capped(
        "congestion_logs",
        "congestion_level, source",
        lambda q: _exclude_non_observation(q.gte("timestamp", start).lte("timestamp", end))
        .order("timestamp", desc=False)
        .order("id", desc=False),
        _DASHBOARD_YESTERDAY_CAP,
        endpoint="dashboard/today",
    )
    return logs


def _recent_congestion_timestamps() -> list[str]:
    """congestion_logs 의 최근 관측 시각을 **내림차순**으로(상한까지). 실패하면 빈 리스트.

    왜 필요한가: 이 대시보드의 '오늘' 구간이 비는 일이 실제로 자주 있다(제보·좌석 방송·
    관리자 오버라이드·simulate-peak 만이 이 표에 행을 넣고, 주차 실측은 다른 표로 간다).
    그때 화면은 '고장' 과 '오늘 관측 없음' 을 구분할 근거가 하나도 없었다. 이 목록이 두
    가지를 만든다 — 마지막 관측이 **언제**였는지, 그리고 **집계할 수 있는 가장 최근 날**이
    언제인지.

    타임스탬프 한 칼럼만 읽으므로 페이지당 비용이 작고, 이 경로는 오늘이 빈 날에만 돈다.

    실패해도 예외를 올리지 않는다: 부가 정보 때문에 오늘 집계 전체를 500 으로 떨어뜨리면,
    고치려던 문제(관리자가 아무것도 못 본다)를 그대로 재현한다.
    """
    try:
        rows, truncated = _fetch_capped(
            "congestion_logs",
            # source 는 관측 판정용 — 모의·시드 날짜를 '현장 관측이 집계된 가장 최근 날' 로 고르지 않게.
            # 쿼리에서도 뺀다: 이 조회는 최신순 상한(5,000)이라, 모의 발생 몇 번이면 상한이 모의 행으로 차서
            # 그 너머의 실제 관측(마지막 관측 시각·폴백일)이 사라진다.
            "timestamp, source",
            lambda q: _exclude_non_observation(q).order("timestamp", desc=True).order("id", desc=True),
            _DASHBOARD_FALLBACK_SCAN_CAP,
            endpoint="dashboard/today",
        )
    except Exception as e:  # noqa: BLE001 — 부가 정보라 조용히 포기한다(사유는 로그에 남긴다)
        logger.warning("admin_recent_congestion_timestamps_failed", error=str(e))
        return []
    if truncated:
        # 상한에 닿으면 그 너머(더 오래된 날)는 못 본다. _pick_fallback_day 는 내림차순으로
        # 훑어 **가장 최근** 자격일을 고르므로, 절단은 '없는 날을 만들어내는' 방향으로는
        # 절대 틀리지 않는다 — 찾을 수 있는 날을 놓치는 쪽으로만 틀린다.
        logger.warning("admin_fallback_scan_truncated", cap=_DASHBOARD_FALLBACK_SCAN_CAP)
    return [str(r["timestamp"]) for r in rows if r.get("timestamp") and _is_observation(r)]


def _pick_fallback_day(timestamps: list[str]) -> tuple[str, str] | None:
    """내림차순 관측 시각 목록에서 **집계할 수 있는 가장 최근 KST 하루**를 고른다.

    반환: (KST 날짜 'YYYY-MM-DD', 그 날의 마지막 관측 시각) 또는 None.

    왜 '가장 최근 관측이 있는 날' 이 아니라 '집계할 수 있는 날' 인가 — 실측(2026-09-08)에서
    최신 행은 KST 2026-08-21 의 **단 1건**이고, 그 아래로 7월 초의 수백 건짜리 날들이 있다.
    최신 행의 날짜로 폴백하면 폴백해 놓고도 화면이 그대로 빈다(1건으로는 하루 평균도,
    이상 건수도, 히트맵도 낼 수 없다). 오늘 구간과 **같은 최소 표본 기준**을 적용해,
    실제로 보여 줄 것이 있는 가장 최근 날을 고른다.

    (건너뛴 날들은 사라지지 않는다 — 최신 관측 시각은 latestObservedAt 으로 따로 나가고,
     화면은 '그 뒤에도 관측은 있었지만 표본이 모자랐다' 를 말할 수 있다.)
    """
    counts: dict[str, int] = {}
    newest: dict[str, str] = {}
    order: list[str] = []  # 최신 날짜부터의 등장 순서(입력이 내림차순이라 그대로 보존된다)
    for ts in timestamps:
        try:
            day = _kst_date_str(_parse_utc(ts))
        except (TypeError, ValueError):
            continue
        if day not in counts:
            counts[day] = 0
            newest[day] = ts  # 내림차순이라 그 날 첫 등장이 곧 그 날의 최신 관측이다
            order.append(day)
        counts[day] += 1
    for day in order:
        if counts[day] >= _DASHBOARD_MIN_DAY_SAMPLES:
            return day, newest[day]
    return None


def _aggregate_congestion_day(logs: list[dict], prev_logs: list[dict]) -> dict:
    """하루치 로그 → 대시보드 집계 { hasLogs, avgCongestion, anomalyCount, heatmap, anomalies, sampleCount }.

    '오늘' 과 '폴백 기준일' 이 **같은 산식**을 쓰도록 라우터 본문에서 뽑아낸 함수다.
    두 벌로 두면 폴백 화면만 조용히 다른 규칙으로 그려진다.

    관측이 아닌 행(NON_OBSERVATION_SOURCES — 관리자 입력·모의·시드·주차 파생 추정)은 평균·이상 건수·
    히트맵·표본 수에서 뺀다(P0-5 f). 이 집계는 화면에서 배지 없이 '현장 관측' 으로 그려지기 때문이다.
    응답 키는 늘리지 않는다(이 응답 모양은 화면·리포트·브리핑이 함께 쓰고 키 집합을 테스트가 잠근다) —
    무엇을 뺐는지는 화면의 지표 설명이 말한다.
    """
    excluded = sum(1 for row in logs if not _is_observation(row))
    if excluded:
        logger.info("admin_dashboard_non_observation_excluded", excluded=excluded)
    logs = [row for row in logs if _is_observation(row)]
    prev_logs = [row for row in prev_logs if _is_observation(row)]

    # 이 하루가 **무엇으로 만들어졌는가**. 값과 함께 다녀야 화면이 무엇을 그리는지 말할 수 있다.
    # source 를 모르는 옛 행/옛 쿼리는 'unknown' 으로 센다(조용히 버리지 않는다).
    source_composition: dict[str, int] = {}
    for row in logs:
        key = str(row.get("source") or "unknown")
        source_composition[key] = source_composition.get(key, 0) + 1

    if len(logs) < _DASHBOARD_MIN_DAY_SAMPLES:
        return {
            "hasLogs": False,
            "avgCongestion": None,
            "anomalyCount": None,
            "heatmap": None,
            "anomalies": None,
            # 표본 수는 0 과 '4건뿐' 을 구분하게 해 준다(둘 다 hasLogs=False 지만 사실은 다르다).
            "sampleCount": len(logs),
            "sourceComposition": source_composition,
        }

    # 1) KPI: 평균 혼잡도 + 이상(>= ANOMALY_LEVEL) 건수 + 전일 대비 변화율
    #    이상 기준은 추정 집계·안전 경보와 같은 상수 하나다(congestion_estimator_service.ANOMALY_LEVEL).
    anomaly_level = congestion_estimator_service.ANOMALY_LEVEL
    avg = sum(float(row.get("congestion_level") or 0) for row in logs) / len(logs)
    value = _js_round(avg, 2)
    anomaly_count = sum(1 for row in logs if float(row.get("congestion_level") or 0) >= anomaly_level)
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
    prev_sample_count = len(prev_logs)
    change_percent_or_null: float | None = None
    if prev_logs:
        y_avg = sum(float(row.get("congestion_level") or 0) for row in prev_logs) / len(prev_logs)
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

    # 3) 이상 알림: 그날의 >= ANOMALY_LEVEL 피크(시설별 최고 1건), congestionLevel 내림차순 상위 6
    peak: dict[str, dict] = {}
    for row in logs:
        level = float(row.get("congestion_level") or 0)
        if level < anomaly_level:
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
        "sampleCount": len(logs),
        "sourceComposition": source_composition,
    }


async def _fallback_day_aggregate(day_kst: str, day_observed_at: str) -> dict | None:
    """집계 가능한 가장 최근 **KST 하루** 를 오늘과 같은 산식으로 집계해 돌려준다.

    반환에 dateKst/observedAt 을 함께 싣는 이유: 화면은 이 집계를 그리면서 **어느 날짜 기준
    인지 크게 명시해야** 한다. 날짜 없이 그리면 오늘 것으로 읽히고, 그건 값을 지어낸 것과
    같은 크기의 거짓말이다. 날짜 계산은 KST 규칙을 소유한 이 파일이 문자열로 확정한다.

    실패하면 None — 폴백은 부가 기능이라 오늘 집계까지 500 으로 끌고 가지 않는다.
    """
    try:
        moment = _parse_utc(day_observed_at)
    except (TypeError, ValueError):
        logger.warning("admin_dashboard_fallback_bad_timestamp", timestamp=str(day_observed_at))
        return None

    f_start, f_end = _kst_day_range_utc(moment)
    p_start = (datetime.fromisoformat(f_start) - timedelta(days=1)).isoformat()
    p_end = (datetime.fromisoformat(f_end) - timedelta(days=1)).isoformat()
    try:
        f_logs, p_logs = await asyncio.gather(
            run_admin_io(_fetch_day_logs, f_start, f_end),
            run_admin_io(_fetch_day_levels, p_start, p_end),
        )
    except Exception as e:  # noqa: BLE001 — 폴백 실패가 오늘 집계를 죽이면 안 된다
        logger.warning("admin_dashboard_fallback_fetch_failed", error=str(e))
        return None

    return {
        "dateKst": day_kst,
        # **그 날의** 마지막 관측 시각(UTC ISO) — 전체 최신 관측(latestObservedAt)과 다를 수 있다.
        # 실측이 정확히 그렇다: 최신 관측은 8/21 의 1건이지만 집계 가능한 날은 7/09 다.
        "observedAt": day_observed_at,
        **_aggregate_congestion_day(f_logs, p_logs),
    }


# ── 오늘의 **추정** 집계(경주 추정 모드) ────────────────────────────────────────
# congestion_logs 는 사실상 비어 있다(7월 시드 한 덩어리뿐). 그래서 '실시간 관제' 가 매일
# 빈 카드이거나 두 달 전 시드를 그렸다. 경주에는 시설 단위 실시간 인원 데이터가 없으므로,
# 10분마다 쌓이는 공영주차 실측(area_demand_snapshots) + 관광공사 집중률로 **읽을 때 계산한
# 추정치**를 함께 싣는다(congestion_estimator_service — 적재하지 않는다, 그 이유는 거기 적혀 있다).
#
# 추정은 부가 정보다. 어떤 실패도 오늘 실측 응답을 죽이지 않는다 — 예외·시간 초과는 전부
# estimated=None + 구조화 경고로 강등한다(폴백 경로와 같은 원칙).
#
# 시간 상한을 두는 이유: 콜드 계산이 1~3초(오늘+전일 스냅샷 약 290개 × 시설 1,600곳)이고,
# Render 무료 플랜의 콜드 스타트와 겹치면 더 길어질 수 있다. 화면의 요청 타임아웃(25초)을
# 추정 하나 때문에 넘기면 실측 KPI 까지 통째로 '조회 실패' 가 된다. 상한에 닿아도 계산은
# shield 로 **계속 돌아 캐시를 채운다** — 다음 새로고침은 캐시에서 즉시 받는다.
_ESTIMATE_TIMEOUT_SECONDS = 12.0
# 같은 날짜의 계산이 이미 돌고 있으면 합류한다. 대시보드는 dashboard/today 와 briefing(내부에서
# get_dashboard_today 재호출)을 동시에 부르므로, 이게 없으면 콜드 계산이 두 번 겹친다.
_estimate_inflight: dict[str, asyncio.Task] = {}


def _estimate_task_done(date_kst: str, task: asyncio.Task) -> None:
    """끝난 계산을 합류 목록에서 빼고, 예외를 회수한다.

    시간 초과로 아무도 기다리지 않게 된 계산이 나중에 실패하면 asyncio 가
    'exception was never retrieved' 를 남긴다 — 사유는 위 호출부가 이미 로그로 남겼다.
    """
    if _estimate_inflight.get(date_kst) is task:
        _estimate_inflight.pop(date_kst, None)
    if not task.cancelled():
        task.exception()


async def _estimated_day_or_none(date_kst: str) -> dict | None:
    """``congestion_estimator_service.estimated_day_aggregate`` 를 실패·시간 초과에 안전하게."""
    loop = asyncio.get_running_loop()
    task = _estimate_inflight.get(date_kst)
    # 다른 이벤트 루프(테스트 클라이언트 재생성 등)에서 만든 태스크는 await 할 수 없다.
    if task is None or task.done() or task.get_loop() is not loop:
        task = asyncio.ensure_future(congestion_estimator_service.estimated_day_aggregate(date_kst))
        task.add_done_callback(lambda done, key=date_kst: _estimate_task_done(key, done))
        _estimate_inflight[date_kst] = task
    try:
        result = await asyncio.wait_for(asyncio.shield(task), timeout=_ESTIMATE_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        logger.warning("admin_dashboard_estimate_timeout", date=date_kst, timeout_s=_ESTIMATE_TIMEOUT_SECONDS)
        return None
    except Exception as e:  # noqa: BLE001 — 추정 실패가 실측 응답을 죽이면 안 된다
        logger.warning("admin_dashboard_estimate_failed", date=date_kst, error=str(e), error_type=type(e).__name__)
        return None
    # 모양이 어긋난 결과를 그대로 흘리면 화면의 형 가드가 막더라도 원인이 서버 로그에 안 남는다.
    if not isinstance(result, dict):
        logger.warning("admin_dashboard_estimate_bad_shape", date=date_kst, type=type(result).__name__)
        return None
    return result


@router.get("/dashboard/today")
@coalesced_admin_view("admin/dashboard/today")
async def get_dashboard_today():
    """오늘(KST) 혼잡 집계 — page.tsx fetchCongestion 과 동일 산식의 compact JSON.

    반환: { hasLogs, avgCongestion, anomalyCount, heatmap, anomalies, sampleCount,
            latestObservedAt, fallback }
      · hasLogs = 오늘 로그 수 >= 5
      · avgCongestion.value = 평균 혼잡도(소수 2자리)
      · avgCongestion.changePercent        = 전일 평균 대비(소수 1자리) — **구 키, 의미 그대로**
      · avgCongestion.changePercentOrNull  = 같은 값이되 전일 표본이 없으면 null
      · avgCongestion.prevSampleCount      = 비교에 쓴 전일 로그 건수
      · anomalyCount = congestion_level >= 0.9 건수
      · heatmap = 시설명×KST시(0..23) 평균(2자리), 로그 없는 칸은 null 센티넬(실측 0.0 과 구분)
      · anomalies = 시설별 >=0.9 피크 상위 6건
    로그가 5건 미만이면 hasLogs=false + 나머지 null(클라이언트 폴백과 동일 shape).
    관리자 입력·모의·시드·주차 파생 추정 행은 관측이 아니라서 세지 않는다(NON_OBSERVATION_SOURCES).

    ── 신규 키(추가만 한다) ─────────────────────────────────────────────────────
      · sampleCount      = 오늘 구간의 로그 건수(0 과 '4건뿐' 을 구분)
      · latestObservedAt = congestion_logs 전체의 가장 최근 관측 시각(UTC ISO) 또는 null
      · fallback         = 오늘이 비었을 때 **집계할 수 있는 가장 최근 KST 하루** 의 같은 집계
                           { dateKst, observedAt, hasLogs, avgCongestion, anomalyCount,
                             heatmap, anomalies, sampleCount } 또는 null
                           observedAt 은 **그 날의** 마지막 관측이라 latestObservedAt 과
                           다를 수 있다(_pick_fallback_day 주석 참조).

    왜 폴백을 최상위 키에 섞지 않고 **별도 객체**로 두는가: Vercel(웹)과 Render(API)는 배포
    시점이 다르고 스테이징이 없다. 오늘 구간이 빈 날 최상위 hasLogs 에 폴백 값을 채워
    보내면, 아직 옛 번들을 받은 관리자 화면은 **19일 전 데이터를 오늘 것으로** 그린다.
    그건 값을 지어내는 것과 같다. 최상위 키의 뜻은 '오늘' 그대로 두고, 폴백을 읽을 줄 아는
    새 번들만 날짜 배지와 함께 그린다.

    (이 응답 shape 은 admin/report 화면·브리핑과도 공유한다. 둘 다 최상위 hasLogs/
     avgCongestion/anomalyCount 만 읽으므로 신규 키의 영향을 받지 않는다.)

    ── 신규 키 2(추가만 한다) — 경주 추정 모드 ─────────────────────────────────────
      · estimated = 오늘(KST)의 **추정** 집계 또는 null(계산 실패·시간 초과·옛 원본 부재)
                    { dateKst, hasLogs, avgCongestion, anomalyCount, heatmap, anomalies,
                      sampleCount, sourceComposition{'estimated': n}, basis{...} }
                    모양은 위 오늘 집계와 같고, basis 가 산식·근거(주차장 수·관측 시각·반경)를
                    싣는다(congestion_estimator_service.aggregate_estimated_day).
                    표본 단위가 로그 1행이 아니라 (대표 장소 × 10분 버킷)이다.

    추정을 최상위 키에 섞지 않는 이유는 폴백과 같다: 옛 번들은 최상위만 읽으므로, 거기에
    추정을 채우면 **추정치가 라벨 없이 실측처럼** 그려진다. 추정을 읽을 줄 아는 새 번들만
    '추정' 배지와 근거 문장을 붙여 그린다. 실측(최상위)이 있으면 화면은 실측을 쓴다.
    """
    start, end = _kst_today_range_utc()
    # 전일 동일 구간(변화율 보정용) — 오늘 구간을 하루 앞으로 민다.
    y_start = (datetime.fromisoformat(start) - timedelta(days=1)).isoformat()
    y_end = (datetime.fromisoformat(end) - timedelta(days=1)).isoformat()

    # 추정은 실측 조회와 **동시에** 시작한다(직렬로 두면 콜드 1~3초가 응답 시간에 그대로 더해진다).
    # 오늘 실측이 있어도 계산한다 — 5분 캐시라 비용이 작고, 키의 뜻이 '실측 유무에 따라 있다
    # 없다' 로 흔들리지 않는다(null 은 오직 '추정을 못 냈다' 를 뜻한다).
    estimate_task = asyncio.ensure_future(_estimated_day_or_none(_kst_date_str(datetime.now(timezone.utc))))

    try:
        # 오늘 로그(시설명/유형 조인)와 어제 로그(변화율용, congestion_level만)를 동시에 조회한다(직렬 왕복 제거).
        logs, y_logs = await asyncio.gather(
            run_admin_io(_fetch_day_logs, start, end),
            run_admin_io(_fetch_day_levels, y_start, y_end),
        )
    except Exception as e:
        # 기다리지 않을 추정은 끊는다(계산 자체는 shield 안이라 캐시를 채우며 끝까지 돈다).
        estimate_task.cancel()
        logger.error("admin_dashboard_today_failed", error=str(e))
        raise HTTPException(status_code=500, detail="혼잡 집계 조회에 실패했습니다.")

    # 절단 사실은 응답이 아니라 구조화 로그로만 남긴다(_fetch_capped 안에서 경고).
    today = _aggregate_congestion_day(logs, y_logs)

    if today["hasLogs"]:
        # 오늘 관측이 있으면 가장 최근 관측도 오늘 안에 있다 — 추가 왕복 없이 손에 든 행에서 뽑는다.
        # (관측이 아닌 행 — 관리자 입력·모의 등 — 은 '마지막 관측' 이 아니다.)
        latest_at = max(
            (str(row["timestamp"]) for row in logs if row.get("timestamp") and _is_observation(row)),
            default=None,
        )
        return {**today, "latestObservedAt": latest_at, "fallback": None, "estimated": await estimate_task}

    # ── 오늘 구간이 비었다 ──────────────────────────────────────────────────────
    # 여기가 '고장' 인지 '데이터 없음' 인지는 이 응답만 봐서는 알 수 없었다(둘 다 빈 화면).
    # 최근 관측 시각을 훑어 (1) 마지막 관측이 언제인지와 (2) 집계할 수 있는 가장 최근 날이
    # 언제인지를 함께 실어, 화면이 사실을 말할 수 있게 한다. 둘은 다를 수 있다 — 실측에서는
    # 최신 관측이 8/21 의 1건이고 집계 가능한 날은 7/09 다(_pick_fallback_day 참조).
    recent = await run_admin_io(_recent_congestion_timestamps)
    latest_at = recent[0] if recent else None
    fallback = None
    picked = _pick_fallback_day(recent)
    if picked:
        day_kst, day_observed_at = picked
        # 고른 날이 '오늘' 이면 폴백할 다른 날이 아니다(오늘이 표본 미달이라는 사실 그대로).
        if day_kst != _kst_date_str(datetime.now(timezone.utc)):
            fallback = await _fallback_day_aggregate(day_kst, day_observed_at)
    # 폴백(과거 실측)과 추정(오늘)을 **둘 다** 싣는다. 무엇을 먼저 그릴지는 화면이 정한다
    # (오늘 실측 → 오늘 추정 → 과거 실측). 서버가 하나를 골라 버리면, 추정을 못 읽는 옛
    # 번들은 폴백마저 잃는다.
    return {**today, "latestObservedAt": latest_at, "fallback": fallback, "estimated": await estimate_task}


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
@coalesced_admin_view("admin/dashboard/briefing")
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


# =========================================================================
# 게스트 방문 확인 체감 혼잡 — 그림자 모드 측정(PRODUCT_EVALUATION_PLAN §6 D3)
# =========================================================================
# 2주 그림자 모드 동안 '게스트 답을 실시간에 넣어도 되는가' 를 정할 숫자를 낸다. 집계는 DB 함수
# guest_crowd_answer_shadow_metrics(20261031130000)가 하고(행·계정·네트워크 키는 밖으로 나오지 않는다),
# 여기서는 비율과 '표본이 모자라다' 는 판정만 붙인다. 비율은 표본이 _SHADOW_MIN_SAMPLE 미만이면 null 이다 —
# 몇 건으로 낸 일치율은 켤지 말지의 근거가 되지 못한다.
_SHADOW_MIN_SAMPLE = 30


class GuestAnswerCounts(BaseModel):
    registered: int = 0
    guest_shadow: int = 0
    guest_live: int = 0


class AnswerAgreement(BaseModel):
    """같은 장소 ±30분 안에서 시각이 가장 가까운 기준값 하나와 혼잡 단계 띠(한산·보통·혼잡)가 같은 비율."""

    comparable: int = 0
    agree: int = 0
    rate: float | None = None


class GuestAnswerAgreement(BaseModel):
    guest_vs_registered: AnswerAgreement
    guest_vs_measured: AnswerAgreement
    registered_vs_registered: AnswerAgreement
    registered_vs_measured: AnswerAgreement


class GuestAnswerNetworks(BaseModel):
    guest_answers_with_network: int = 0
    distinct_networks: int = 0
    answers_from_shared_networks: int = 0
    same_place_cluster_answers: int = 0
    shared_network_share: float | None = None
    same_place_cluster_share: float | None = None


class GuestAnswerShadowMetrics(BaseModel):
    days: int
    since: str | None = None
    live: bool
    answers: GuestAnswerCounts
    guest_accounts: int = 0
    agreement: GuestAnswerAgreement
    networks: GuestAnswerNetworks
    min_sample: int
    sample_status: str  # "ok" | "insufficient"
    notes: list[str]


def _int(value) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _share(part: int, whole: int) -> float | None:
    return round(part / whole, 3) if whole >= _SHADOW_MIN_SAMPLE else None


def _agreement(raw) -> AnswerAgreement:
    raw = raw if isinstance(raw, dict) else {}
    comparable, agree = _int(raw.get("comparable")), _int(raw.get("agree"))
    return AnswerAgreement(comparable=comparable, agree=agree, rate=_share(agree, comparable))


def build_guest_answer_shadow_metrics(raw: dict, *, days: int, live: bool) -> GuestAnswerShadowMetrics:
    """DB 집계(JSON)에 비율·표본 판정·안내 문장을 붙인다. 순수 함수 — 테스트가 직접 부른다."""
    raw = raw if isinstance(raw, dict) else {}
    answers_raw = raw.get("answers") if isinstance(raw.get("answers"), dict) else {}
    answers = GuestAnswerCounts(**{k: _int(answers_raw.get(k)) for k in ("registered", "guest_shadow", "guest_live")})
    agreement_raw = raw.get("agreement") if isinstance(raw.get("agreement"), dict) else {}
    agreement = GuestAnswerAgreement(**{
        key: _agreement(agreement_raw.get(key))
        for key in ("guest_vs_registered", "guest_vs_measured", "registered_vs_registered", "registered_vs_measured")
    })
    net_raw = raw.get("networks") if isinstance(raw.get("networks"), dict) else {}
    guest_total = answers.guest_shadow + answers.guest_live
    with_network = _int(net_raw.get("guest_answers_with_network"))
    shared = _int(net_raw.get("answers_from_shared_networks"))
    clustered = _int(net_raw.get("same_place_cluster_answers"))
    networks = GuestAnswerNetworks(
        guest_answers_with_network=with_network,
        distinct_networks=_int(net_raw.get("distinct_networks")),
        answers_from_shared_networks=shared,
        same_place_cluster_answers=clustered,
        shared_network_share=_share(shared, with_network),
        same_place_cluster_share=_share(clustered, with_network),
    )

    guest_comparable = max(agreement.guest_vs_registered.comparable, agreement.guest_vs_measured.comparable)
    enough = guest_comparable >= _SHADOW_MIN_SAMPLE and with_network >= _SHADOW_MIN_SAMPLE
    notes: list[str] = []
    if guest_total == 0:
        notes.append(f"최근 {days}일 게스트 답이 없습니다.")
    if guest_comparable < _SHADOW_MIN_SAMPLE:
        notes.append(
            f"같은 장소·30분 안에 비교할 계정 사용자 답·실측이 있는 게스트 답이 {guest_comparable}건이라 "
            f"일치율을 내지 않습니다({_SHADOW_MIN_SAMPLE}건부터)."
        )
    if with_network < _SHADOW_MIN_SAMPLE:
        notes.append(
            f"네트워크 키가 있는 게스트 답이 {with_network}건이라 겹침 비율을 내지 않습니다({_SHADOW_MIN_SAMPLE}건부터)."
        )
    if agreement.registered_vs_registered.rate is None and agreement.registered_vs_measured.rate is None:
        notes.append("계정 사용자 답의 기준 일치율도 표본이 모자라 게스트와 나란히 비교할 수 없습니다.")
    since = raw.get("since")
    return GuestAnswerShadowMetrics(
        days=_int(raw.get("days")) or days,
        since=str(since) if since else None,
        live=live,
        answers=answers,
        guest_accounts=_int(raw.get("guest_accounts")),
        agreement=agreement,
        networks=networks,
        min_sample=_SHADOW_MIN_SAMPLE,
        sample_status="ok" if enough else "insufficient",
        notes=notes,
    )


@router.get("/metrics/guest-answers", response_model=GuestAnswerShadowMetrics)
async def get_guest_answer_shadow_metrics(days: int = 14):
    """게스트 방문 확인 체감 혼잡 그림자 모드 측정 — 답 수 · 일치율(계정 사용자·실측 대비) · 네트워크 겹침.

    days 1~30(기본 14 — 그림자 모드 2주, 네트워크 키 보관 30일을 넘지 않는다). 비율은 표본 30건 미만이면 null 이고,
    sample_status·notes 가 무엇이 모자란지 말한다. live 는 지금 서버의 GUEST_CROWD_ANSWERS_LIVE 값이다.
    """
    days = max(1, min(days, 30))
    try:
        res = await run_admin_io(
            lambda: supabase_admin.rpc("guest_crowd_answer_shadow_metrics", {"p_days": days}).execute()
        )
    except Exception as exc:
        logger.error("guest_answer_shadow_metrics_failed", error=str(exc))
        raise HTTPException(status_code=503, detail="게스트 답 측정값을 불러오지 못했습니다(마이그레이션 20261031130000 적용 확인).")
    raw = res.data
    if isinstance(raw, list):
        raw = raw[0] if raw else {}
    return build_guest_answer_shadow_metrics(raw or {}, days=days, live=bool(app_settings.GUEST_CROWD_ANSWERS_LIVE))
