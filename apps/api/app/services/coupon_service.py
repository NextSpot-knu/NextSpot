"""쿠폰 발급 공용 서비스 — 제휴 시설(coupon_rate>0) 수락/제보 보상 경로에서 재사용.

배경: SPOT w3 인센티브(facilities.coupon_rate)를 실제 쿠폰으로 현물화하는 로직이
recommendations.submit_feedback 에만 있었다(리뷰 P1#1). 수락 파이프라인(/recommendations/accept)과
제보 보상(reports)에서도 동일 규칙으로 발급하도록 모듈 함수로 추출한다.

- upsert(on user_id+facility_id, ignore_duplicates): 한 시설당 사용자 1장 — 이미 보유 시 되돌리지 않는다.
- expires_at = 발급 시각 + 7일(만료 파생은 coupons 라우터가 담당, DB status CHECK 는 issued/used 불변).
- best-effort: 발급 실패가 상위 플로우(수락/제보)를 깨지 않도록 예외를 흡수하고 issued=False 로 강등한다.
- 공개 지역(경주) 시설에만 발급한다(SEOUL_TESTBED_PLAN S3). 서울(개발자 전용) 시설은 발급 없이 끝난다 —
  호출부가 지역으로 거른 읽기에서 시설을 얻었으면 그 지역(``region=``)을 넘긴다(경주면 재조회 없음, 그 밖이면 즉시
  종료). 지역을 넘기지 않은 호출은 시설 dict 를 믿지 않고 발급 직전 지역을 건 단건 조회로 확인한다.

supabase 클라이언트를 인자로 받는다 — 호출자 모듈의 service_role 클라이언트를 그대로 넘겨(테스트가
각 라우터의 클라이언트 패치 지점을 그대로 쓰도록) 재사용성과 패치 일관성을 함께 얻는다.

머천트 랭킹 연동(2단계): 이 함수를 부르는 라우터(recommendations.accept_recommendation,
submit_feedback)는 facility 를 by-type/courses 후보 목록과 무관한 단건 조회(fetch_facility,
recommendations!recommended_facility_id 조인)로 얻으므로 apply_merchant_boosts 오버레이가 적용돼
있지 않다. 여기서 단건(1 facility) 오버레이를 다시 태워 유효 쿠폰율을 재확인한다 —
'점수는 타임세일로 올려놓고 쿠폰은 기본율로 준다' 는 불일치를 막는다(단일 소스 재사용).
"""
import asyncio
from datetime import datetime, timedelta, timezone

import structlog

from app.core.region import PUBLIC_REGION, apply_region, arun_region_scoped
from app.services.merchant_boost import apply_merchant_boosts

logger = structlog.get_logger()

# 쿠폰 유효기간(일) — 발급 시각 기준. coupons.list_my_coupons 의 만료 파생과 동일 기준.
COUPON_TTL_DAYS = 7


def coupon_expiry_from_now() -> str:
    """현재 시각 + COUPON_TTL_DAYS 의 ISO8601 문자열(발급 만료 스냅샷)."""
    return (datetime.now(timezone.utc) + timedelta(days=COUPON_TTL_DAYS)).isoformat()


async def issue_coupon_if_partner(
    supabase, user_id: str, facility: dict, *, region: str | None = None
) -> dict:
    """제휴 시설이면 사용자 지갑(user_coupons)에 쿠폰을 발급한다(멱등 upsert).

    Args:
        supabase: service_role 권한 Supabase 클라이언트(호출자 모듈의 것 — 테스트 패치 지점 일원화).
        user_id: 발급 대상 사용자.
        facility: 최소 {id, coupon_rate} 를 가진 시설 dict.
        region: 호출부가 ``facility`` 를 **그 지역으로 거른 읽기**에서 얻었을 때 그 지역.
            · 공개 지역(경주) → 발급 직전 지역 재조회를 하지 않는다(호출부 읽기가 이미 보장 — S3 전과 같은 왕복 수).
            · 그 밖의 지역 → 아무것도 읽지 않고 발급 없이 끝난다(내부 지역은 쿠폰이 없다).
            · None(지역을 모르는 호출부) → 지역을 건 단건 조회로 확인한다(닫힌 쪽).
    Returns:
        {"coupon_issued": bool, "coupon_rate": float, "expires_at": str|None}
        coupon_rate<=0(제휴 없음)이면 발급 없이 issued=False, rate=0.0, expires_at=None.
    """
    facility_id = facility.get("id")
    if not facility_id:
        return {"coupon_issued": False, "coupon_rate": 0.0, "expires_at": None}
    if region is not None and region != PUBLIC_REGION:
        logger.info("coupon_skipped_non_public_region", user_id=user_id, facility_id=facility_id)
        return {"coupon_issued": False, "coupon_rate": 0.0, "expires_at": None}

    # 발급 시점에도 활성 타임세일을 재확인해 유효 쿠폰율을 적용한다(오버레이 실패는 무해 폴백 —
    # apply_merchant_boosts 자체가 예외를 흡수하므로 여기서 별도 try/except 는 불필요).
    boosted = await apply_merchant_boosts(supabase, [facility])
    facility = boosted[0] if boosted else facility

    coupon_rate = facility.get("coupon_rate") or 0
    if coupon_rate <= 0:
        return {"coupon_issued": False, "coupon_rate": 0.0, "expires_at": None}

    if region is None and not await _is_public_facility(supabase, facility_id):
        logger.info("coupon_skipped_non_public_region", user_id=user_id, facility_id=facility_id)
        return {"coupon_issued": False, "coupon_rate": 0.0, "expires_at": None}

    expires_at = coupon_expiry_from_now()
    try:
        # ignore_duplicates=True: 이미 보유(사용/발급) 시 되돌리지 않는다(리뷰 P2#8).
        await asyncio.to_thread(
            supabase.table("user_coupons").upsert(
                {
                    "user_id": user_id,
                    "facility_id": facility_id,
                    "coupon_rate": coupon_rate,
                    "status": "issued",
                    "expires_at": expires_at,
                },
                on_conflict="user_id,facility_id",
                ignore_duplicates=True,
            ).execute
        )
    except Exception as e:
        # 발급 실패는 상위 플로우를 깨지 않도록 흡수(로깅 후 issued=False 강등).
        logger.warning("issue_coupon_failed", user_id=user_id, facility_id=facility_id, error=str(e))
        return {"coupon_issued": False, "coupon_rate": float(coupon_rate), "expires_at": None}

    logger.info("coupon_issued", user_id=user_id, facility_id=facility_id, coupon_rate=coupon_rate)
    return {"coupon_issued": True, "coupon_rate": float(coupon_rate), "expires_at": expires_at}


async def _is_public_facility(supabase, facility_id) -> bool:
    """공개 지역(경주) 시설인가 — 지역을 건 단건 조회(region 컬럼 전이면 경주 폴백). 조회 실패는 발급 안 함."""

    def _read(with_region: bool) -> list[dict]:
        query = supabase.table("facilities").select("id").eq("id", facility_id)
        if with_region:
            query = apply_region(query, PUBLIC_REGION)
        return query.limit(1).execute().data or []

    try:
        return bool(await arun_region_scoped(_read, region=PUBLIC_REGION))
    except Exception as e:  # noqa: BLE001 — best-effort: 확인하지 못하면 발급하지 않는다(닫힌 쪽)
        logger.warning("coupon_region_check_failed", facility_id=facility_id, error=str(e))
        return False
