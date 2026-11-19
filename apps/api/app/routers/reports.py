"""혼잡 제보(크라우드소싱) 라우터.

관광객이 '지금 이곳이 얼마나 붐비는지'를 직접 제보하는 엔드포인트.

보안 배경(init RLS 20250523120001 + 20260827140000):
  congestion_logs 에는 일반 사용자용 INSERT 정책이 **없다** — anon 도, 로그인한 관광객도
  Supabase 로 직접 쓸 수 없다. 그래서 제보는 반드시 이 백엔드 엔드포인트를 거쳐
  supabase_admin(service_role) 으로 기록된다. 신뢰 경계는 authz.get_registered_user(계정 로그인 필수 —
  게스트 익명 세션은 403, 아래 '게스트(익명 세션) 차단')로 강제한다.

  2026-09-07 이전에는 "service_role 만 쓸 수 있다" 가 **사실이 아니었다.** 정책 admin_all_logs
  (FOR ALL TO authenticated, USING/WITH CHECK = public.is_admin_or_dev()) 가 admin·developer
  에게 이 표 전체의 직접 쓰기를 허용했다 — 그 두 역할은 브라우저에서 anon 키만으로
  evidence_tier='verified' 행(= 모델 학습의 정답)을 만들 수 있었고, 아래 제보 경로가 지키는
  tier 규칙(사용자 제보는 single_report)을 우회할 수 있었다.
  20260907090000_congestion_logs_admin_read_only.sql 이 그 정책을 admin_read_logs(FOR SELECT)
  로 좁혀 닫았다. **이 문단을 지우지 말 것** — '언제부터 사실인지' 가 이 문장의 핵심이다.

게스트(익명 세션) 차단(2026-10-30, 보안 진단 '중'):
  두 제보 경로 모두 계정 로그인을 요구한다(JWT 의 is_anonymous → 403, DB 를 읽기 전에 끝난다).
  그 전에는 get_current_user 만 봐서 SessionBootstrap 이 모든 방문자에게 자동 발급하는 익명
  세션도 통과했다. 익명 세션은 클릭 한 번이면 새로 생기므로 '사용자·시설당 쿨다운' 이 세션마다
  초기화됐고, 게스트 둘이 같은 단계를 보내면 DB 트리거(correlate_congestion_report_evidence)가
  corroborated 로 승격했다 — 그 등급은 추천 순위와 모델 학습 정답에 들어간다. 영업 상태도 같아서
  게스트 둘이 '닫힘' 을 맞추면 그 장소가 60분간 추천에서 빠졌다(record_facility_availability_report).
  웹은 게스트의 영업 상태 답을 서버에 기록하지 않고 그 사람 화면에만 적용한다(RecommendationCard ·
  explore/recommend) — 수락·길안내 흐름은 게스트에게도 그대로다.

레이트리밋 두 겹(프로세스 인메모리, 단일 인스턴스 데모 기준 — 다중 인스턴스는 Redis 등 공유 저장소로 승격):
  · 사용자·시설당 쿨다운(혼잡 5분 · 영업 1분) — 같은 사람의 연타.
  · **IP·시설당 한 계정**(교차검증 창 30분) — 한 단말에서 계정 여러 개를 돌려 '두 사람의 일치' 를 꾸미는 것.
    교차검증은 30분 안의 서로 다른 계정 둘을 센다(트리거 ±30분 · RPC 최근 30분). 그래서 IP 쪽을 쿨다운 길이
    (5분·1분)로 걸면 두 번째 계정이 5분 1초 뒤에 보내 그대로 corroborated 가 된다 — 늦출 뿐 막지 못한다.
    같은 와이파이 일행의 두 번째 제보도 막히지만, 같은 일행의 같은 관찰은 원래 '독립된 두 확인' 이 아니다.
  IP 키는 app/core/client_ip.py 의 해석(XFF 마지막 값)을 따른다. 검사와 자리 잡기는 await 없이 한 번에
  한다(app/core/report_slots.reserve_report_slot — 게스트 방문 확인 답 경로와 공용) — 사이에 await 가 있으면 동시에 들어온 두 계정이 둘 다 검사를 통과한다.
"""
import asyncio
from datetime import datetime, timezone
from typing import Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.authz import get_registered_user
from app.core.client_ip import client_ip
from app.core.region import PUBLIC_REGION, apply_region, arun_region_scoped
from app.core.report_slots import CONGESTION_VOTES_BY_IP, release_report_slot, reserve_report_slot
# congestion_logs 쓰기는 RLS 우회가 필요해 service_role(supabase_admin) 을 쓴다
# (infrastructures.simulate_peak / recommendations 와 동일 사유 — anon INSERT 는 RLS 로 거부됨).
# 이 문장이 **모든 authenticated 역할에 대해** 참이 된 시점과 그 전에 무엇이 열려 있었는지는
# 이 파일 상단 독스트링의 '보안 배경' 을 볼 것(20260907090000 마이그레이션).
from app.core.supabase import supabase_admin
from app.services import reference_snapshot
from app.services.coupon_service import issue_coupon_if_partner

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1", tags=["reports"])

# 제보 보상 주기 — 이 배수의 제보마다 해당 시설이 제휴면 쿠폰을 발급한다.
_REWARD_EVERY = 3

# 3단계 체감 혼잡도(한산/보통/혼잡) → 0~1 추정치 매핑.
# 프런트 3지선다 버튼과 정합. 소수 라벨은 UX 부담이 커 이산 3구간으로 단순화한다.
_LEVEL_ENUM = {"한산": 0.2, "보통": 0.5, "혼잡": 0.8}

# congestion_logs.source CHECK 제약이 허용하는 값은 아홉 개다(20260908120000 기준):
#   traffic_cctv, tour_api, event, user_report, merchant_report, admin_override, seed, simulated, parking_derived
# 사용자 제보는 'user_report' 로 기록한다(스키마 제약을 만족하는 정식 값).
# 이 목록은 마이그레이션이 늘려 왔다 — 20260710172000(seed·simulated), 20260820123000
# (merchant_report), 20260906120000(admin_override), 20260908120000(주차 실측 파생 추정치).
# 여기 적힌 목록이 낡으면 "이 값은 못 쓴다" 는 잘못된 판단의 근거가 되므로, 제약을 바꿀 때
# 이 줄도 같이 고친다.
_USER_REPORT_SOURCE = "user_report"

# 사용자·시설당 제보 쿨다운(초) — 스팸/조작이 ML 혼잡 신호를 오염시키지 않도록 1차 차단.
# 프로세스 인메모리(단일 인스턴스 데모 기준). 다중 인스턴스는 Redis 등 공유 저장소로 승격 필요.
_REPORT_COOLDOWN_SEC = 300.0
_last_report_at: dict[tuple[str, str], float] = {}
_AVAILABILITY_COOLDOWN_SEC = 60.0
_last_availability_report_at: dict[tuple[str, str], float] = {}

# (IP, 시설) → (그 IP 에서 마지막으로 성공한 계정, 시각). 창 안에서는 같은 IP 의 **다른** 계정을 받지 않는다.
# 규칙·자리 잡기는 app/core/report_slots.py(방문 확인 체감 혼잡과 공용). 게스트 방문 확인 답은 이 표를 읽기만 한다 —
# 같은 IP 에서 계정 사용자가 먼저 제보한 장소의 게스트 답은 버려지지만, 게스트 답이 계정 사용자의 제보를 막지는 않는다.
_last_report_by_ip = CONGESTION_VOTES_BY_IP
_last_availability_report_by_ip: dict[tuple[str, str], tuple[str, float]] = {}


class CongestionReportRequest(BaseModel):
    facility_id: str
    # level 은 0~1 연속 추정치 또는 한산/보통/혼잡 라벨 중 하나를 받는다.
    # (프런트는 라벨을 보내고, 다른 클라이언트가 수치를 보내도 검증되게 union 으로 수용.)
    level: float | Literal["한산", "보통", "혼잡"] = Field(
        ..., description="0~1 혼잡 추정치 또는 한산/보통/혼잡"
    )


class ReportReward(BaseModel):
    report_count: int      # 누적 제보 횟수(이번 제보 반영 후)
    coupon_issued: bool    # 이번 제보로 쿠폰이 발급됐는지(제휴 시설 & 보상 주기 도달 시)
    next_reward_in: int    # 다음 보상까지 남은 제보 수


class CongestionReportResponse(BaseModel):
    success: bool
    facility_id: str
    congestion_level: float
    # 방문객은 인원수를 세는 것이 아니라 체감 단계를 제보한다. DB 호환용 환산값을
    # 외부 응답에서 실제 인원처럼 노출하지 않는다.
    current_count: int | None
    timestamp: str
    source: str
    reward: ReportReward


class AvailabilityReportRequest(BaseModel):
    facility_id: str
    status: Literal["open", "closed"]


class AvailabilityReportResponse(BaseModel):
    success: bool = True
    facility_id: str
    status: Literal["open", "closed"]
    evidence_tier: Literal["single_report", "corroborated"]
    corroborating_count: int
    reported_at: str
    expires_at: str


async def _bump_report_count(user_id: str) -> int:
    """users.report_count 를 +1 하고 갱신 후 값을 반환한다(제보 보상 게이팅용).

    단일 인스턴스 데모 기준의 read-modify-write(원자적 증가 아님) — 동시 제보 경합은 데모 범위에서 무시한다.
    select 실패 시 0(보상 없음)으로 강등하고, update 실패는 흡수한다(제보 성공 자체는 유지).
    """
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("users").select("report_count").eq("id", user_id).limit(1).execute
        )
    except Exception as e:
        logger.warning("report_count_fetch_failed", user_id=user_id, error=str(e))
        return 0
    current = (res.data[0].get("report_count") or 0) if res.data else 0
    new_count = int(current) + 1
    try:
        await asyncio.to_thread(
            supabase_admin.table("users").update({"report_count": new_count}).eq("id", user_id).execute
        )
    except Exception as e:
        # 카운트 영속화 실패라도 이번 제보의 의도된 누적값은 그대로 보고한다(제보 자체는 저장됨).
        logger.warning("report_count_update_failed", user_id=user_id, error=str(e))
    return new_count


def _coerce_level(level: float | str) -> float:
    """입력 level 을 0~1 실수로 정규화한다(라벨이면 매핑, 수치면 범위 검증)."""
    if isinstance(level, str):
        mapped = _LEVEL_ENUM.get(level.strip())
        if mapped is None:
            raise HTTPException(
                status_code=422,
                detail="level 은 한산/보통/혼잡 또는 0~1 사이 수치여야 합니다.",
            )
        return mapped
    # 수치 경로: DB CHECK(congestion_level 0~1)와 정합하도록 범위 검증
    if not (0.0 <= level <= 1.0):
        raise HTTPException(status_code=422, detail="level 수치는 0.0~1.0 범위여야 합니다.")
    return float(level)


# 지역 격리 DB 가드의 거절(마이그레이션 20261101090000) — 자식 표 트리거(P0001 facility_region_not_public).
_REGION_REJECTIONS = ("facility_region_not_public",)


def _region_rejected(exc: Exception) -> bool:
    text = f"{getattr(exc, 'code', '') or ''} {getattr(exc, 'message', None) or exc}"
    return any(marker in text for marker in _REGION_REJECTIONS)


async def _public_facility(facility_id: str, columns: str) -> dict | None:
    """공개 지역(경주) 시설 한 곳. 다른 지역·없음은 None — 지역은 쿼리 안에서 건다(region 컬럼 전이면 경주 폴백)."""

    def _read(with_region: bool) -> list[dict]:
        query = supabase_admin.table("facilities").select(columns).eq("id", facility_id)
        if with_region:
            query = apply_region(query, PUBLIC_REGION)
        return query.limit(1).execute().data or []

    rows = await arun_region_scoped(_read, region=PUBLIC_REGION)
    return rows[0] if rows else None


@router.post("/reports/availability", response_model=AvailabilityReportResponse)
async def report_availability(
    req: AvailabilityReportRequest,
    request: Request,
    current_user: dict = Depends(get_registered_user),
):
    """Record a short-lived opening-status check using server time.

    The database RPC atomically keeps one current report per user/place and promotes
    only two-user agreement to corroborated evidence. A single report never affects
    recommendation eligibility. Guest (anonymous) sessions are rejected with 403.
    """
    facility = await _public_facility(req.facility_id, "id")
    if not facility:
        raise HTTPException(status_code=404, detail="시설 정보를 찾을 수 없습니다.")

    slot = reserve_report_slot(
        user_store=_last_availability_report_at,
        ip_store=_last_availability_report_by_ip,
        user_id=current_user["id"],
        ip=client_ip(request),
        facility_id=req.facility_id,
        cooldown_sec=_AVAILABILITY_COOLDOWN_SEC,
        cooldown_detail="영업 상태는 1분에 한 번만 확인할 수 있습니다.",
    )

    try:
        result = await asyncio.to_thread(
            supabase_admin.rpc(
                "record_facility_availability_report",
                {
                    "p_facility_id": req.facility_id,
                    "p_reporter_user_id": current_user["id"],
                    "p_status": req.status,
                },
            ).execute
        )
    except Exception as exc:
        release_report_slot(slot)
        if _region_rejected(exc):
            # 공개 지역이 아닌 시설 — DB 트리거(reject_non_public_region_facility)가 막았다. 없는 시설과 같다.
            raise HTTPException(status_code=404, detail="시설 정보를 찾을 수 없습니다.") from None
        logger.error(
            "availability_report_failed",
            facility_id=req.facility_id,
            user_id=current_user["id"],
            error=str(exc),
        )
        raise HTTPException(status_code=503, detail="영업 상태 저장에 실패했습니다.")
    reference_snapshot.mark_dirty("availability")  # 지도 참조 스냅샷에 알린다(app/services/reference_snapshot.py) — 다음 지도 요청이 방금 쓴 값을 본다.

    payload = result.data or {}
    if isinstance(payload, list):
        payload = payload[0] if payload else {}
    if not payload:
        release_report_slot(slot)
        raise HTTPException(status_code=503, detail="영업 상태 저장 결과를 확인하지 못했습니다.")
    return AvailabilityReportResponse(success=True, **payload)


@router.post("/reports/congestion", response_model=CongestionReportResponse)
async def report_congestion(
    req: CongestionReportRequest,
    request: Request,
    current_user: dict = Depends(get_registered_user),
):
    """관광객의 실시간 혼잡 제보를 congestion_logs 에 기록한다(source='user_report').

    흐름: 인증 + 게스트 거부(get_registered_user, 403) → level 정규화 → 시설 존재 검증 →
    쿨다운(사용자 5분 · IP 한 계정 30분) → supabase_admin 으로 로그 INSERT. current_count 는 capacity×level 로 추정한다
    (congestion_logs 에 실인원 컬럼은 있으나 제보는 인원을 모르므로 수용량 기반 추정).
    """
    level = _coerce_level(req.level)

    logger.info(
        "congestion_report_received",
        user_id=current_user["id"],
        facility_id=req.facility_id,
        level=level,
    )

    # 1. 시설 존재 검증 (없는 facility_id 로의 FK 위반/유령 로그 방지). coupon_rate 는 제보 보상 발급 판정용.
    #    공개 지역(경주) 시설만 — 서울(개발자 전용) 시설은 없는 시설과 같은 404 다(쿼리 안에서 거른다).
    facility_row = await _public_facility(req.facility_id, "id, capacity, coupon_rate")
    if not facility_row:
        raise HTTPException(status_code=404, detail="시설 정보를 찾을 수 없습니다.")

    # 1-1. 레이트리밋: 사용자·시설당 쿨다운 + IP·시설당 한 계정(스팸/조작 1차 차단, 상단 독스트링).
    #      여기서 자리를 잡고, 저장이 실패하면 되돌린다.
    slot = reserve_report_slot(
        user_store=_last_report_at,
        ip_store=_last_report_by_ip,
        user_id=current_user["id"],
        ip=client_ip(request),
        facility_id=req.facility_id,
        cooldown_sec=_REPORT_COOLDOWN_SEC,
        cooldown_detail=f"제보는 {int(_REPORT_COOLDOWN_SEC // 60)}분에 한 번만 가능합니다. 잠시 후 다시 시도해 주세요.",
    )

    capacity = facility_row.get("capacity") or 0
    current_count = round(capacity * level)
    now_str = datetime.now(timezone.utc).isoformat()

    row = {
        "facility_id": req.facility_id,
        "congestion_level": level,
        "current_count": current_count,
        "source": _USER_REPORT_SOURCE,
        "evidence_tier": "single_report",
        "reporter_user_id": current_user["id"],
        "timestamp": now_str,
    }

    # 2. service_role 로 INSERT (anon·일반 authenticated 직접 쓰기는 RLS 로 거부됨.
    #    admin·developer 는 예외이고, 그 예외의 정확한 범위는 상단 도크에 적었다.)
    try:
        ins = await asyncio.to_thread(
            supabase_admin.table("congestion_logs").insert(row).execute
        )
    except Exception as e:
        release_report_slot(slot)  # 저장하지 못한 시도는 쿨다운을 남기지 않는다
        if _region_rejected(e):
            raise HTTPException(status_code=404, detail="시설 정보를 찾을 수 없습니다.") from None
        logger.error("congestion_report_insert_failed", error=str(e), facility_id=req.facility_id)
        # 우리 쪽 장애는 503 이다(이 저장소의 규칙 — 중복만 409, 잘못된 입력은 422).
        # 500 은 프런트가 '다시 시도해도 소용없는 오류' 로 다루기 쉽고, 실제로는 Render
        # 콜드 스타트나 Supabase 순간 장애라 다시 누르면 되는 경우가 대부분이다.
        raise HTTPException(status_code=503, detail="혼잡 제보를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.")

    reference_snapshot.mark_dirty("congestion")  # 지도 참조 스냅샷에 알린다(app/services/reference_snapshot.py) — 다음 지도 요청이 방금 쓴 값을 본다.
    inserted = (ins.data or [{}])[0]
    logger.info("congestion_report_saved", facility_id=req.facility_id, level=level)

    # 3. 제보 보상: 누적 제보 +1, _REWARD_EVERY 배수마다 제휴 시설이면 쿠폰 발급(coupon_rate 0 이면 카운트만).
    report_count = await _bump_report_count(current_user["id"])
    coupon_issued = False
    if report_count > 0 and report_count % _REWARD_EVERY == 0:
        issue = await issue_coupon_if_partner(
            supabase_admin,
            current_user["id"],
            {"id": req.facility_id, "coupon_rate": facility_row.get("coupon_rate")},
            region=PUBLIC_REGION,  # facility_row 는 _public_facility(경주로 거른 읽기)에서 왔다
        )
        coupon_issued = issue["coupon_issued"]
    # 다음 보상까지 남은 제보 수 = 다음 배수 - 현재 누적. (report_count=0 강등 시에도 _REWARD_EVERY.)
    next_reward_in = ((report_count // _REWARD_EVERY) + 1) * _REWARD_EVERY - report_count

    return CongestionReportResponse(
        success=True,
        facility_id=req.facility_id,
        congestion_level=inserted.get("congestion_level", level),
        current_count=None,
        timestamp=inserted.get("timestamp", now_str),
        source=inserted.get("source", _USER_REPORT_SOURCE),
        reward=ReportReward(
            report_count=report_count,
            coupon_issued=coupon_issued,
            next_reward_in=next_reward_in,
        ),
    )
