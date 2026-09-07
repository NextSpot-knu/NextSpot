# '변화 없음' 과 '표본 없음'(검토목록 11번) — /admin/dashboard/today 의 전일 대비 계약.
#
# 잡으려는 결함: 서버가 두 사실을 같은 0.0 으로 내려보내, 화면이 측정한 적 없는 비교를
# ('어제와 같음' 배지) 그렸다. 반대 방향도 같은 크기의 거짓말이다 — 어제 평균이 0.0 이면
# 분모가 0 이라 변화율을 낼 수 없는데 그때도 0% 로 나갔다.
#
# 동시에 **구 키(changePercent)의 의미가 바뀌지 않았는지**도 함께 잠근다. Vercel(웹)과
# Render(API)는 배포 시점이 다르고 스테이징이 없어 옛 번들이 새 응답을 받는 구간이 실제로
# 존재한다 — 그 번들은 changePercent 를 숫자로 읽으므로 null 이 흘러가면 배지가 NaN 이 된다.
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


def _kst_now_iso() -> str:
    """오늘(KST) 구간 안에 확실히 드는 타임스탬프."""
    return datetime.now(timezone.utc).isoformat()


def _yesterday_iso() -> str:
    return (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()


class _WindowedSupabase:
    """오늘/어제 구간을 gte·lte 필터로 실제로 갈라 주는 페이크.

    공용 FakeSupabase 는 필터를 흡수해 **두 쿼리에 같은 행**을 주므로 '전일 표본 없음'
    자체를 재현할 수 없다. 이 테스트가 보려는 것이 정확히 그 상태라 필터를 흉내 낸다.
    """

    def __init__(self, rows):
        self._rows = rows

    def table(self, _name: str):
        return _WindowedTable(self._rows)


class _WindowedTable:
    def __init__(self, rows):
        self._rows = rows
        self._gte: str | None = None
        self._lte: str | None = None

    def gte(self, column: str, value):
        if column == "timestamp":
            self._gte = value
        return self

    def lte(self, column: str, value):
        if column == "timestamp":
            self._lte = value
        return self

    def __getattr__(self, _name):
        def _chain(*_args, **_kwargs):
            return self

        return _chain

    def execute(self):
        rows = [
            row for row in self._rows
            if (self._gte is None or row["timestamp"] >= self._gte)
            and (self._lte is None or row["timestamp"] <= self._lte)
        ]

        class _Result:
            data = rows

        return _Result()


def _log(level: float, timestamp: str) -> dict:
    return {
        "congestion_level": level,
        "current_count": 10,
        "timestamp": timestamp,
        "facility": {"name": "황리단길 카페", "type": "cafe"},
    }


def test_no_previous_sample_is_null_not_zero(client):
    """전일 로그가 한 건도 없으면 changePercentOrNull=null, prevSampleCount=0.

    구 키는 0.0 을 유지한다(옛 번들 호환) — 그래서 **새 키가 있어야만** 화면이
    '어제와 같음' 과 '비교 기준 없음' 을 구분할 수 있다.
    """
    today_only = [_log(0.5, _kst_now_iso()) for _ in range(6)]
    with patch.object(admin, "supabase_admin", _WindowedSupabase(today_only)):
        res = client.get("/api/v1/admin/dashboard/today", headers=_admin_headers())

    assert res.status_code == 200, res.text
    avg = res.json()["avgCongestion"]
    assert avg["prevSampleCount"] == 0
    assert avg["changePercentOrNull"] is None, "표본이 없는데 비교값을 만들어냈다"
    assert avg["changePercent"] == 0.0, "구 키의 의미가 바뀌었다(옛 번들이 NaN 을 그린다)"


def test_real_change_is_reported_in_both_keys(client):
    """전일 표본이 있으면 두 키가 같은 값을 말한다."""
    rows = [_log(0.6, _kst_now_iso()) for _ in range(6)]
    rows += [_log(0.4, _yesterday_iso()) for _ in range(4)]
    with patch.object(admin, "supabase_admin", _WindowedSupabase(rows)):
        res = client.get("/api/v1/admin/dashboard/today", headers=_admin_headers())

    avg = res.json()["avgCongestion"]
    assert avg["prevSampleCount"] == 4
    assert avg["changePercentOrNull"] == pytest.approx(50.0)
    assert avg["changePercent"] == pytest.approx(50.0)


def test_flat_change_is_zero_not_null(client):
    """어제와 정말 같으면 0.0 이다 — null 이 아니다.

    이 테스트가 없으면 '표본 없음' 을 고치면서 '변화 없음' 까지 null 로 밀어버리는
    반대 방향의 결함이 생긴다(그러면 진짜 0% 인 날의 배지가 사라진다).
    """
    rows = [_log(0.5, _kst_now_iso()) for _ in range(6)]
    rows += [_log(0.5, _yesterday_iso()) for _ in range(3)]
    with patch.object(admin, "supabase_admin", _WindowedSupabase(rows)):
        res = client.get("/api/v1/admin/dashboard/today", headers=_admin_headers())

    avg = res.json()["avgCongestion"]
    assert avg["prevSampleCount"] == 3
    assert avg["changePercentOrNull"] == 0.0


def test_zero_previous_average_cannot_be_compared(client):
    """어제 평균이 0.0 이면 분모가 0 이라 변화율이 존재하지 않는다 — null 이어야 한다.

    표본은 있으므로 prevSampleCount 는 0 이 아니다. 화면이 '표본 없음' 과 '비교 불가' 를
    같은 문구로 말해도 되지만, 서버가 없는 숫자를 만들어 주지는 않는다.
    """
    rows = [_log(0.5, _kst_now_iso()) for _ in range(6)]
    rows += [_log(0.0, _yesterday_iso()) for _ in range(3)]
    with patch.object(admin, "supabase_admin", _WindowedSupabase(rows)):
        res = client.get("/api/v1/admin/dashboard/today", headers=_admin_headers())

    avg = res.json()["avgCongestion"]
    assert avg["prevSampleCount"] == 3
    assert avg["changePercentOrNull"] is None
    assert avg["changePercent"] == 0.0


def test_briefing_view_drops_the_fabricated_comparison():
    """브리핑에 넘기는 사본은 '비교 불가' 를 None 으로 되돌린다.

    briefing_service.build_facts 는 changePercent=None 이면 {change} 플레이스홀더 자체를
    주지 않아 LLM 이 비교 문장을 쓸 수 없다. 라우터가 구 번들 호환으로 0.0 을 채우는 바람에
    그 분기가 죽으면, **전일 표본이 없는 날에도 "전일과 동일한 수준" 이 브리핑에 실린다.**
    """
    from app.services import briefing_service

    today = {
        "hasLogs": True,
        "avgCongestion": {"value": 0.8, "changePercent": 0.0, "changePercentOrNull": None, "prevSampleCount": 0},
        "anomalyCount": 1,
    }
    facts = briefing_service.build_facts(admin._briefing_view(today), {"relocations": 1, "saved_wait_minutes": 5})
    assert facts is not None
    assert "change" not in facts["placeholders"], "없는 비교를 브리핑 문장으로 만들어 줬다"

    # 실제 비교가 있는 날은 그대로 살아 있어야 한다(위 폐기가 과잉이 아님을 고정).
    today_with_change = {
        "hasLogs": True,
        "avgCongestion": {"value": 0.8, "changePercent": 12.0, "changePercentOrNull": 12.0, "prevSampleCount": 9},
        "anomalyCount": 1,
    }
    facts = briefing_service.build_facts(
        admin._briefing_view(today_with_change), {"relocations": 1, "saved_wait_minutes": 5}
    )
    assert "change" in facts["placeholders"]
