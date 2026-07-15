# 머천트 랭킹 연동(2단계) 오버레이(apply_merchant_boosts) 테스트 — 실제 DB/네트워크 없이
# 타임세일 유효율 교체·좌석 상태 실측 대체·무해 폴백을 검증한다.
#
# merchant_timesales 조회는 DB WHERE 절(활성 조건)에 의존하므로, test_routers.py 의 blind
# pass-through FakeTable 대신 실제로 in_/is_/lte/gte 를 python 리스트에 적용하는 미니 Fake 를 쓴다.
# 이렇게 해야 '만료·취소된 타임세일은 무시된다'는 계약이 프로덕션 쿼리 체이닝 자체로 검증된다
# (canned 데이터에 만료/취소 행을 섞어 두고, 코드가 실제로 걸러내는지 확인).
from datetime import datetime, timedelta, timezone

import pytest

from app.services.merchant_boost import (
    CONGESTION_OVERRIDE_KEY,
    SEAT_LEVEL_CONGESTION,
    SEAT_STATUS_FRESH_MINUTES,
    apply_merchant_boosts,
)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _facility(fid: str, coupon_rate: float = 0.0, features: dict | None = None) -> dict:
    return {"id": fid, "coupon_rate": coupon_rate, "features": features or {}}


class _FakeResult:
    def __init__(self, data):
        self.data = data


class _FilterableQuery:
    """merchant_timesales 쿼리 체이닝을 실제로 필터링하는 미니 Fake(blind pass-through 아님)."""

    def __init__(self, rows):
        self._rows = list(rows)

    def select(self, *_args, **_kwargs):
        return self

    def in_(self, col, values):
        vs = set(values)
        self._rows = [r for r in self._rows if r.get(col) in vs]
        return self

    def is_(self, col, value):
        if value == "null":
            self._rows = [r for r in self._rows if r.get(col) is None]
        return self

    def lte(self, col, value):
        self._rows = [r for r in self._rows if r.get(col) is not None and r[col] <= value]
        return self

    def gte(self, col, value):
        self._rows = [r for r in self._rows if r.get(col) is not None and r[col] >= value]
        return self

    def execute(self):
        return _FakeResult(self._rows)


class _FakeTimesaleClient:
    def __init__(self, rows):
        self._rows = rows

    def table(self, name):
        assert name == "merchant_timesales"
        return _FilterableQuery(self._rows)


class _RaisingClient:
    """테이블 부재/쿼리 오류를 시뮬레이션 — apply_merchant_boosts 가 무해 폴백해야 한다."""

    def table(self, _name):
        raise RuntimeError("merchant_timesales table not found")


# =========================================================================
# 1. 타임세일 오버레이 — 유효율 교체 / 기본율이 더 클 때 미표기 / 만료·취소·미래 무시
# =========================================================================


@pytest.mark.asyncio
async def test_timesale_replaces_effective_coupon_rate_when_higher():
    now = datetime.now(timezone.utc)
    rows = [{
        "facility_id": "f-1", "rate": 0.3,
        "starts_at": _iso(now - timedelta(minutes=10)), "ends_at": _iso(now + timedelta(minutes=50)),
        "canceled_at": None,
    }]
    out = await apply_merchant_boosts(_FakeTimesaleClient(rows), [_facility("f-1", coupon_rate=0.1)])
    assert out[0]["coupon_rate"] == 0.3
    assert out[0]["timesale_rate"] == 0.3


@pytest.mark.asyncio
async def test_timesale_rate_not_badged_when_base_coupon_rate_is_higher():
    now = datetime.now(timezone.utc)
    rows = [{
        "facility_id": "f-1", "rate": 0.15,
        "starts_at": _iso(now - timedelta(minutes=5)), "ends_at": _iso(now + timedelta(minutes=55)),
        "canceled_at": None,
    }]
    out = await apply_merchant_boosts(_FakeTimesaleClient(rows), [_facility("f-1", coupon_rate=0.3)])
    # 유효값(max)은 그대로 0.3 — 이미 기본율이 더 후하므로 배지(timesale_rate) 미표기.
    assert out[0]["coupon_rate"] == 0.3
    assert "timesale_rate" not in out[0]


@pytest.mark.asyncio
async def test_expired_canceled_and_future_timesales_are_ignored():
    now = datetime.now(timezone.utc)
    rows = [
        # 만료: ends_at 이 과거
        {"facility_id": "f-1", "rate": 0.3,
         "starts_at": _iso(now - timedelta(hours=3)), "ends_at": _iso(now - timedelta(hours=1)),
         "canceled_at": None},
        # 취소됨: canceled_at 존재(기간은 활성 범위 내)
        {"facility_id": "f-1", "rate": 0.3,
         "starts_at": _iso(now - timedelta(minutes=10)), "ends_at": _iso(now + timedelta(minutes=50)),
         "canceled_at": _iso(now - timedelta(minutes=1))},
        # 아직 시작 전(미래)
        {"facility_id": "f-1", "rate": 0.3,
         "starts_at": _iso(now + timedelta(minutes=10)), "ends_at": _iso(now + timedelta(hours=1)),
         "canceled_at": None},
    ]
    out = await apply_merchant_boosts(_FakeTimesaleClient(rows), [_facility("f-1", coupon_rate=0.1)])
    # 활성 타임세일이 실질적으로 하나도 없으므로 원본 쿠폰율 그대로.
    assert out[0]["coupon_rate"] == 0.1
    assert "timesale_rate" not in out[0]


@pytest.mark.asyncio
async def test_timesale_query_scoped_to_requested_ids_only():
    # 후보에 없는 시설(f-2)의 타임세일은 무관해야 한다.
    now = datetime.now(timezone.utc)
    rows = [{
        "facility_id": "f-2", "rate": 0.3,
        "starts_at": _iso(now - timedelta(minutes=1)), "ends_at": _iso(now + timedelta(minutes=59)),
        "canceled_at": None,
    }]
    out = await apply_merchant_boosts(_FakeTimesaleClient(rows), [_facility("f-1", coupon_rate=0.1)])
    assert out[0]["coupon_rate"] == 0.1
    assert "timesale_rate" not in out[0]


# =========================================================================
# 2. 좌석 상태 오버레이 — 레벨 매핑 / 30분 이내 신선 / 30분 초과 무시
# =========================================================================


@pytest.mark.asyncio
async def test_seat_status_fresh_overrides_congestion_with_level_mapping():
    now = datetime.now(timezone.utc)
    for level, expected_congestion in SEAT_LEVEL_CONGESTION.items():
        facility = _facility(
            "f-1",
            features={"seat_status": {"level": level, "updated_at": _iso(now - timedelta(minutes=5))}},
        )
        out = await apply_merchant_boosts(_FakeTimesaleClient([]), [facility])
        assert out[0][CONGESTION_OVERRIDE_KEY] == expected_congestion
        assert out[0]["seat_status_fresh"] == {"level": level, "minutes_ago": 5}


@pytest.mark.asyncio
async def test_seat_status_older_than_30min_is_ignored():
    now = datetime.now(timezone.utc)
    stale = now - timedelta(minutes=SEAT_STATUS_FRESH_MINUTES + 1)
    facility = _facility("f-1", features={"seat_status": {"level": "full", "updated_at": _iso(stale)}})
    out = await apply_merchant_boosts(_FakeTimesaleClient([]), [facility])
    assert CONGESTION_OVERRIDE_KEY not in out[0]
    assert "seat_status_fresh" not in out[0]


@pytest.mark.asyncio
async def test_seat_status_just_under_30min_boundary_is_still_fresh():
    # 정확히 30분 지점은 테스트 실행 시각과 함수 내부 now() 호출 시각의 미세한 간극(수 ms)에 따라
    # 경계를 넘나들 수 있어 검증 대상으로 부적합하다(플레이키). 2초 여유를 둬 '거의 30분'을 검증한다.
    now = datetime.now(timezone.utc)
    boundary = now - timedelta(minutes=SEAT_STATUS_FRESH_MINUTES) + timedelta(seconds=2)
    facility = _facility("f-1", features={"seat_status": {"level": "mid", "updated_at": _iso(boundary)}})
    out = await apply_merchant_boosts(_FakeTimesaleClient([]), [facility])
    assert out[0][CONGESTION_OVERRIDE_KEY] == SEAT_LEVEL_CONGESTION["mid"]


@pytest.mark.asyncio
async def test_seat_status_missing_or_malformed_is_skipped_without_crashing():
    now = datetime.now(timezone.utc)
    no_seat_status = _facility("f-1", features={})
    unknown_level = _facility("f-2", features={"seat_status": {"level": "medium", "updated_at": _iso(now)}})
    not_a_dict_features = {"id": "f-3", "coupon_rate": 0.0, "features": "not-a-dict"}

    out = await apply_merchant_boosts(
        _FakeTimesaleClient([]), [no_seat_status, unknown_level, not_a_dict_features]
    )
    for item in out:
        assert CONGESTION_OVERRIDE_KEY not in item
        assert "seat_status_fresh" not in item


# =========================================================================
# 3. 무해 폴백 — 쿼리 실패 시 원본 반환(타임세일 실패와 좌석 오버레이는 서로 독립)
# =========================================================================


@pytest.mark.asyncio
async def test_timesale_fetch_failure_falls_back_to_original_untouched():
    facility = _facility("f-1", coupon_rate=0.2)
    out = await apply_merchant_boosts(_RaisingClient(), [facility])
    assert out[0]["coupon_rate"] == 0.2
    assert "timesale_rate" not in out[0]


@pytest.mark.asyncio
async def test_timesale_failure_does_not_block_seat_status_overlay():
    now = datetime.now(timezone.utc)
    facility = _facility(
        "f-1", coupon_rate=0.2,
        features={"seat_status": {"level": "low", "updated_at": _iso(now - timedelta(minutes=1))}},
    )
    out = await apply_merchant_boosts(_RaisingClient(), [facility])
    # 타임세일 조회는 실패했지만(무해 폴백), 좌석 오버레이는 DB 조회가 필요 없어 정상 적용된다.
    assert out[0][CONGESTION_OVERRIDE_KEY] == SEAT_LEVEL_CONGESTION["low"]


@pytest.mark.asyncio
async def test_empty_facilities_list_returns_as_is():
    assert await apply_merchant_boosts(_RaisingClient(), []) == []


@pytest.mark.asyncio
async def test_original_input_dicts_are_not_mutated():
    original = _facility("f-1", coupon_rate=0.1)
    now = datetime.now(timezone.utc)
    rows = [{
        "facility_id": "f-1", "rate": 0.3,
        "starts_at": _iso(now - timedelta(minutes=1)), "ends_at": _iso(now + timedelta(minutes=59)),
        "canceled_at": None,
    }]
    out = await apply_merchant_boosts(_FakeTimesaleClient(rows), [original])
    assert original["coupon_rate"] == 0.1  # 원본 dict 는 불변(얕은 복사 오버레이)
    assert out[0]["coupon_rate"] == 0.3
