# '오늘이 비었다' 와 '고장났다' 는 다른 사실이다 — /admin/dashboard/today 의 폴백 계약.
#
# 잡으려는 결함: congestion_logs 의 최신 행이 19일 전인 상태(실측 2026-09-08)에서 이 응답은
# 전부 null 이었다. 화면은 히트맵·이상 혼잡·평균 혼잡을 통째로 비운 채, **왜** 비었는지 말할
# 근거를 하나도 받지 못했다. 관리자는 그 화면에서 '데이터 없음' 과 '백엔드 장애' 를 구분할 수
# 없다(둘 다 빈 카드다).
#
# 여기서 잠그는 두 가지:
#   1) 서버가 '마지막 관측 시각' 과 '가장 최근 관측이 있는 KST 하루의 집계' 를 함께 싣는다.
#   2) 그 폴백이 **최상위 키를 오염시키지 않는다.** Vercel(웹)/Render(API) 배포 시차 구간에
#      옛 번들이 새 응답을 받으면, 최상위 hasLogs=true 는 19일 전 데이터를 오늘 것으로
#      그리게 만든다 — 값을 지어내는 것과 같은 크기의 거짓말이라 구조로 막는다.
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import admin
from tests.routers.test_routers import _admin_headers


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


# 실측 프로덕션 상태를 그대로 쓴다: 최신 혼잡 로그가 2026-08-20T17:05Z.
# UTC 로는 8월 20일이지만 이 대시보드의 하루 경계는 KST 라, 기준일은 **2026-08-21** 이다.
# (이 한 칸이 어긋나면 화면의 '기준일' 배지가 하루 틀린 날짜를 크게 표시한다.)
_LATEST_UTC = "2026-08-20T17:05:00+00:00"
_FALLBACK_DATE_KST = "2026-08-21"
# 폴백 기준일(KST 2026-08-21)의 전날 = KST 2026-08-20 → 변화율 비교 대상.
_PREV_DAY_UTC = "2026-08-19T20:00:00+00:00"  # = KST 2026-08-20 05:00


class _DayFilteredSupabase:
    """gte/lte·order·limit·range 를 실제로 흉내 내는 페이크.

    공용 FakeSupabase 는 체이닝을 전부 흡수해 **모든 쿼리에 같은 행**을 준다. 이 테스트가
    보려는 것이 정확히 '오늘 구간은 비고 과거 구간에만 행이 있다' 는 상태라, 날짜 필터와
    '최신 1건' 조회(order desc + limit 1)를 실제로 갈라야 한다.
    """

    def __init__(self, rows):
        self._rows = rows

    def table(self, _name: str):
        return _DayFilteredTable(self._rows)


class _DayFilteredTable:
    def __init__(self, rows):
        self._rows = rows
        self._gte: str | None = None
        self._lte: str | None = None
        self._desc = False
        self._limit: int | None = None
        self._range: tuple[int, int] | None = None

    def select(self, *_args, **_kwargs):
        return self

    def gte(self, column: str, value):
        if column == "timestamp":
            self._gte = value
        return self

    def lte(self, column: str, value):
        if column == "timestamp":
            self._lte = value
        return self

    def order(self, column: str, desc: bool = False):
        if column == "timestamp":
            self._desc = desc
        return self

    def limit(self, n: int):
        self._limit = n
        return self

    def range(self, start: int, end: int):
        self._range = (start, end)
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def execute(self):
        rows = [
            row for row in self._rows
            if (self._gte is None or row["timestamp"] >= self._gte)
            and (self._lte is None or row["timestamp"] <= self._lte)
        ]
        rows.sort(key=lambda r: r["timestamp"], reverse=self._desc)
        if self._limit is not None:
            rows = rows[: self._limit]
        if self._range is not None:
            start, end = self._range
            rows = rows[start : end + 1]

        class _Result:
            data = rows

        return _Result()


def _log(level: float, timestamp: str, name: str = "황리단길", ftype: str = "attraction") -> dict:
    return {
        "id": f"{name}-{timestamp}-{level}",
        "congestion_level": level,
        "current_count": 10,
        "timestamp": timestamp,
        "facility": {"name": name, "type": ftype},
    }


def _fallback_day_logs() -> list[dict]:
    """KST 2026-08-21 하루 안의 로그 6건(평균 0.5, 이상 1건). 마지막 1건이 _LATEST_UTC."""
    rows = [_log(0.4, "2026-08-20T16:00:00+00:00") for _ in range(4)]
    rows.append(_log(0.4, "2026-08-20T16:30:00+00:00"))
    rows.append(_log(1.0, _LATEST_UTC))
    return rows


def test_empty_today_carries_latest_observation_and_fallback_day(client):
    """오늘이 비면 '마지막 관측 시각' 과 '그 날의 집계' 를 함께 내려보낸다.

    이게 없으면 화면은 빈 카드만 그리고, 관리자는 고장인지 데이터가 없는 건지 알 수 없다.
    """
    rows = _fallback_day_logs()
    with patch.object(admin, "supabase_admin", _DayFilteredSupabase(rows)):
        res = client.get("/api/v1/admin/dashboard/today", headers=_admin_headers())

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["latestObservedAt"] == _LATEST_UTC

    fallback = body["fallback"]
    assert fallback is not None, "폴백할 날이 있는데 화면에 줄 것이 없다"
    # UTC 로는 8/20 이지만 KST 하루 경계로는 8/21 이다 — 배지에 찍힐 날짜라 하루도 틀리면 안 된다.
    assert fallback["dateKst"] == _FALLBACK_DATE_KST
    assert fallback["observedAt"] == _LATEST_UTC
    assert fallback["hasLogs"] is True
    assert fallback["sampleCount"] == 6
    # 평균 (0.4×5 + 1.0)/6 = 0.5, 이상(>=0.9) 1건
    assert fallback["avgCongestion"]["value"] == 0.5
    assert fallback["anomalyCount"] == 1
    # 히트맵은 오늘 경로와 같은 산식·같은 shape 이어야 한다(폴백만 다른 규칙이면 안 된다).
    assert len(fallback["heatmap"]) == 24
    peak_cell = next(c for c in fallback["heatmap"] if c["hour"] == 2)  # 17:05Z = KST 02시
    assert peak_cell["value"] == 1.0
    assert peak_cell["facilityType"] == "attraction"
    assert len(fallback["anomalies"]) == 1


def test_fallback_never_leaks_into_the_today_keys(client):
    """최상위 키는 끝까지 '오늘' 만 뜻한다.

    배포 시차 구간에서 옛 번들이 이 응답을 받으면 최상위 키만 읽는다. 거기에 폴백 값을
    채우면 19일 전 데이터가 **오늘 것으로** 그려진다. 그래서 폴백은 별도 객체다.
    """
    with patch.object(admin, "supabase_admin", _DayFilteredSupabase(_fallback_day_logs())):
        res = client.get("/api/v1/admin/dashboard/today", headers=_admin_headers())

    body = res.json()
    assert body["hasLogs"] is False
    assert body["avgCongestion"] is None
    assert body["anomalyCount"] is None
    assert body["heatmap"] is None
    assert body["anomalies"] is None
    assert body["sampleCount"] == 0, "오늘 구간의 표본 수는 0 이다(폴백 건수가 아니다)"
    assert body["fallback"]["hasLogs"] is True, "폴백은 별도 객체 안에만 있어야 한다"


def test_fallback_compares_against_the_day_before_the_fallback_day(client):
    """폴백의 전일 대비는 '어제' 가 아니라 **기준일의 전날**과 비교한다.

    오늘 기준으로 어제를 보면 그 구간도 비어 있어 언제나 '비교 불가' 가 된다 — 비교할 수
    있는데도 비교하지 않는 것은 화면에서 '전일 표본이 없다' 는 없는 사실이 된다.
    """
    rows = _fallback_day_logs() + [_log(0.25, _PREV_DAY_UTC) for _ in range(4)]
    with patch.object(admin, "supabase_admin", _DayFilteredSupabase(rows)):
        res = client.get("/api/v1/admin/dashboard/today", headers=_admin_headers())

    avg = res.json()["fallback"]["avgCongestion"]
    assert avg["prevSampleCount"] == 4
    # (0.5 - 0.25)/0.25 = +100.0%
    assert avg["changePercentOrNull"] == pytest.approx(100.0)
    assert avg["changePercent"] == pytest.approx(100.0), "구 키의 의미가 바뀌면 옛 번들이 NaN 을 그린다"


def test_no_logs_at_all_says_so_without_inventing_a_day(client):
    """표가 통째로 비면 마지막 관측도 폴백도 없다 — 없는 날짜를 만들지 않는다."""
    with patch.object(admin, "supabase_admin", _DayFilteredSupabase([])):
        res = client.get("/api/v1/admin/dashboard/today", headers=_admin_headers())

    body = res.json()
    assert body["hasLogs"] is False
    assert body["latestObservedAt"] is None
    assert body["fallback"] is None


def test_today_with_logs_reports_todays_latest_and_no_fallback(client):
    """오늘 관측이 있으면 폴백은 null 이고, latestObservedAt 은 오늘 안의 최대 시각이다."""
    now = datetime.now(timezone.utc)
    newest = (now - timedelta(minutes=1)).isoformat()
    rows = [_log(0.5, (now - timedelta(hours=1)).isoformat()) for _ in range(5)]
    rows.append(_log(0.5, newest))
    with patch.object(admin, "supabase_admin", _DayFilteredSupabase(rows)):
        res = client.get("/api/v1/admin/dashboard/today", headers=_admin_headers())

    body = res.json()
    assert body["hasLogs"] is True
    assert body["fallback"] is None, "오늘이 있는데 과거 날짜를 함께 내려보내면 화면이 헷갈린다"
    assert body["latestObservedAt"] == newest


def test_today_thin_but_latest_is_today_has_no_fallback(client):
    """오늘 로그가 5건 미만이어도, 집계 가능한 유일한 날이 오늘이면 폴백할 다른 날이 없다.

    (그 상태에서 '오늘' 을 폴백 기준일로 다시 집계하면 같은 결과를 두 번 그리게 된다.)
    """
    now = datetime.now(timezone.utc)
    rows = [_log(0.5, (now - timedelta(minutes=10 * i)).isoformat()) for i in range(3)]
    with patch.object(admin, "supabase_admin", _DayFilteredSupabase(rows)):
        res = client.get("/api/v1/admin/dashboard/today", headers=_admin_headers())

    body = res.json()
    assert body["hasLogs"] is False
    assert body["sampleCount"] == 3, "0 건과 '3건뿐' 은 다른 사실이다"
    assert body["latestObservedAt"] is not None
    assert body["fallback"] is None


def test_fallback_skips_days_too_thin_to_aggregate(client):
    """폴백 기준일은 '가장 최근 관측이 있는 날' 이 아니라 **집계할 수 있는 가장 최근 날**이다.

    실측(2026-09-08) 그대로의 상태를 재현한다: 최신 행은 KST 2026-08-21 의 **1건**뿐이고,
    그 아래로 7월 초의 두꺼운 날들이 있다. 최신 행의 날짜로 폴백하면 폴백해 놓고도 화면이
    그대로 빈다 — 1건으로는 하루 평균도, 이상 건수도, 히트맵도 낼 수 없기 때문이다.
    사용자 요구가 '결국에는 정보가 표시되어야 한다' 였으므로 여기서 갈린다.
    """
    stray = _log(0.9, _LATEST_UTC)  # KST 2026-08-21 의 단 1건
    thick = [_log(0.4, f"2026-07-08T0{i}:00:00+00:00") for i in range(6)]  # KST 2026-07-08
    with patch.object(admin, "supabase_admin", _DayFilteredSupabase([stray, *thick])):
        res = client.get("/api/v1/admin/dashboard/today", headers=_admin_headers())

    body = res.json()
    # 최신 관측 시각은 여전히 8/21 을 그대로 말한다 — 건너뛴 사실을 숨기지 않는다.
    assert body["latestObservedAt"] == _LATEST_UTC
    fallback = body["fallback"]
    assert fallback is not None, "표본이 두꺼운 날이 있는데 화면에 줄 것이 없다"
    assert fallback["dateKst"] == "2026-07-08", "1건짜리 날을 기준일로 세우면 폴백해도 화면이 빈다"
    assert fallback["hasLogs"] is True
    assert fallback["sampleCount"] == 6
    # observedAt 은 **그 날의** 마지막 관측이지 전체 최신 관측이 아니다.
    assert fallback["observedAt"] == "2026-07-08T05:00:00+00:00"


def test_every_day_too_thin_yields_no_fallback(client):
    """어느 날도 최소 표본에 못 미치면 폴백하지 않는다 — 1건짜리 '하루 평균' 을 만들지 않는다."""
    rows = [
        _log(0.9, _LATEST_UTC),
        _log(0.1, "2026-07-08T01:00:00+00:00"),
        _log(0.1, "2026-07-07T01:00:00+00:00"),
    ]
    with patch.object(admin, "supabase_admin", _DayFilteredSupabase(rows)):
        res = client.get("/api/v1/admin/dashboard/today", headers=_admin_headers())

    body = res.json()
    assert body["latestObservedAt"] == _LATEST_UTC, '마지막 관측이 있었다는 사실은 그대로 말한다'
    assert body["fallback"] is None
