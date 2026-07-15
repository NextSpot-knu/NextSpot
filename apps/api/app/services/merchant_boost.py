"""머천트 랭킹 연동(2단계) — 데이터 레이어 오버레이.

배경: score.py(가중치·산식)와 packages/shared-types 는 이 스코프에서 절대 수정하지 않는다
(정본 불변). 사장님이 발행한 셀프 타임세일/좌석 상태 방송을 추천 랭킹에 반영하려면,
score.py 가 이미 읽고 있는 입력값(facility["coupon_rate"], 라우터가 넘기는 '현재 혼잡')을
스코어링 '이전'에 실측·최신값으로 바꿔치기하면 된다 — 이 모듈이 그 오버레이 레이어다.
(merchant.py 도입 당시 주석: "랭킹 연동은 미구현 2단계" — 이 파일이 그 2단계다.)

제공하는 오버레이 2종(apply_merchant_boosts 가 한 번에 적용):
  1) 타임세일: merchant_timesales 에서 지금 활성인 행을 시설 id 목록으로 **한 번의 쿼리**로 조회해
     facility_id→최댓값 rate 맵을 만들고, effective = max(coupon_rate or 0, timesale rate) 로
     facility["coupon_rate"] 를 교체한다. score.py 의 coupon_term(=min(1, coupon_rate/CAP))이
     자동으로 타임세일을 반영한다(score.py 무변경). 타임세일이 알려진 쿠폰율보다 클 때만
     facility["timesale_rate"] 를 배지 표기용으로 별도로 남긴다.
  2) 좌석 상태: features.seat_status={level, updated_at} 이 30분 이내로 신선하면, 사장님이 방금
     확인한 실측 혼잡으로 라우터의 '현재 혼잡' 을 대체한다. 매핑: low=0.15, mid=0.5, full=0.9.
     30분을 넘긴 값은 오래된 방송으로 사용자를 오도할 수 있어 무시한다. 오버레이 값은
     facility["_merchant_congestion_override"](내부 전용 키 — 응답 직전에 각 라우터가 벗겨낸다)에
     싣고, 프런트 배지용으로 facility["seat_status_fresh"]={level, minutes_ago} 를 별도 표기한다.

실패 원칙: 테이블 부재/쿼리 오류/잘못된 features 형태 등 어떤 예외도 추천 플로우 자체를
막아서는 안 된다 — 조용히 원본을 그대로 반환하고 warning 로그만 남긴다(무해 폴백).
"""
from datetime import datetime, timezone
import asyncio

import structlog

logger = structlog.get_logger()

# 좌석 상태 레벨 → 혼잡도(0~1) 매핑. merchant.py 의 _SEAT_LEVELS 와 동일 집합을 소비한다.
SEAT_LEVEL_CONGESTION = {"low": 0.15, "mid": 0.5, "full": 0.9}

# 좌석 상태 신선도 기준(분) — 이보다 오래된 방송은 무시한다(오래된 값으로 오도 금지).
SEAT_STATUS_FRESH_MINUTES = 30

# 내부 전용 오버레이 키 — 응답 payload 로 나가기 전 각 호출측 라우터가 벗겨낸다.
CONGESTION_OVERRIDE_KEY = "_merchant_congestion_override"


async def apply_merchant_boosts(client, facilities: list[dict]) -> list[dict]:
    """타임세일·좌석 상태 오버레이를 한 번에 적용한 새 리스트를 반환한다.

    원본 dict/list 는 변경하지 않는다(얕은 복사 후 오버레이) — 호출측이 들고 있는
    all_facilities/candidates 원본 리스트가 공유 참조로 오염되는 것을 막기 위함이다.
    facilities 가 비어 있으면 그대로 반환(쿼리 스킵).
    """
    if not facilities:
        return facilities

    overlaid = [dict(f) for f in facilities]
    overlaid = await _apply_timesale_boost(client, overlaid)
    overlaid = _apply_seat_status_boost(overlaid)
    return overlaid


async def _apply_timesale_boost(client, facilities: list[dict]) -> list[dict]:
    """활성 타임세일(now ∈ [starts_at, ends_at], canceled_at is null)을 한 번의 쿼리로 반영."""
    ids = [f["id"] for f in facilities if f.get("id")]
    if not ids:
        return facilities

    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        res = await asyncio.to_thread(
            client.table("merchant_timesales")
            .select("facility_id, rate, starts_at, ends_at, canceled_at")
            .in_("facility_id", ids)
            .is_("canceled_at", "null")
            .lte("starts_at", now_iso)
            .gte("ends_at", now_iso)
            .execute
        )
        rows = res.data or []
    except Exception as e:
        # 테이블 미존재(마이그레이션 미적용)/네트워크 오류 등 — 무해 폴백(원본 그대로).
        logger.warning("merchant_boost_timesale_fetch_failed", error=str(e))
        return facilities

    # facility_id → 활성 타임세일 중 최댓값 rate(동시 다건이면 가장 후한 할인만 의미 있음).
    max_rate_by_id: dict[str, float] = {}
    for row in rows:
        fid = row.get("facility_id")
        rate = row.get("rate")
        if fid is None or rate is None:
            continue
        try:
            rate = float(rate)
        except (TypeError, ValueError):
            continue
        if rate > max_rate_by_id.get(fid, 0.0):
            max_rate_by_id[fid] = rate

    if not max_rate_by_id:
        return facilities

    for f in facilities:
        ts_rate = max_rate_by_id.get(f.get("id"))
        if ts_rate is None:
            continue
        base_rate = float(f.get("coupon_rate") or 0.0)
        f["coupon_rate"] = max(base_rate, ts_rate)
        # 타임세일이 기본 쿠폰율보다 클 때만 배지 표기(기본율이 더 후하면 이미 반영돼 있어 무표기).
        if ts_rate > base_rate:
            f["timesale_rate"] = ts_rate
    return facilities


def _apply_seat_status_boost(facilities: list[dict]) -> list[dict]:
    """features.seat_status 가 30분 이내 신선하면 사장 확인 혼잡값으로 오버레이."""
    now = datetime.now(timezone.utc)
    for f in facilities:
        try:
            features = f.get("features") or {}
            if not isinstance(features, dict):
                continue
            seat_status = features.get("seat_status")
            if not isinstance(seat_status, dict):
                continue

            level = seat_status.get("level")
            updated_at_raw = seat_status.get("updated_at")
            if level not in SEAT_LEVEL_CONGESTION or not updated_at_raw:
                continue

            updated_at = datetime.fromisoformat(str(updated_at_raw).replace("Z", "+00:00"))
            if updated_at.tzinfo is None:
                updated_at = updated_at.replace(tzinfo=timezone.utc)
            minutes_ago = (now - updated_at).total_seconds() / 60.0

            # 미래 시각(시계 오차)이거나 30분 초과면 무시 — 오래된 방송으로 오도하지 않는다.
            if minutes_ago < 0 or minutes_ago > SEAT_STATUS_FRESH_MINUTES:
                continue

            f[CONGESTION_OVERRIDE_KEY] = SEAT_LEVEL_CONGESTION[level]
            f["seat_status_fresh"] = {"level": level, "minutes_ago": round(minutes_ago)}
        except Exception as e:
            logger.warning("merchant_boost_seat_status_failed", facility_id=f.get("id"), error=str(e))
            continue
    return facilities
