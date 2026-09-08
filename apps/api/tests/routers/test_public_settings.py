# 공개 시스템 설정(검토목록 6번) 라우터 테스트 — 무인증 접근·노출 범위·실패 폴백.
#
#  · main.py 는 소유 파일 밖(배선은 별도 작업)이라 이 라우터만 얹은 로컬 FastAPI 앱을 쓴다
#    (tests/routers/test_impact.py 상단 주석과 같은 이유).
#  · DB: app.routers.system.supabase_admin 을 페이크로 패치 — 네트워크 0.
#
# 잡으려는 결함:
#   · 다른 설정 컬럼(merchant_console_enabled 등)이 무인증 응답에 섞여 나가는 것
#   · 조회 실패가 '점검 중' 으로 읽혀 멀쩡한 서비스에 중단 안내가 뜨는 것
#   · 실패했는데 그 사실을 숨겨 낡은 값을 최신인 척 내보내는 것
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import system

_ROW = {
    "maintenance_mode": True,
    "notice_text": "시설 점검 중입니다.",
    "congestion_threshold": 85,
}


class _FakeTable:
    def __init__(self, rows, recorder: dict, fail: bool):
        self._rows = rows
        self._recorder = recorder
        self._fail = fail

    def select(self, columns: str):
        self._recorder["select"] = columns
        return self

    def __getattr__(self, _name):
        def _chain(*_args, **_kwargs):
            return self

        return _chain

    def execute(self):
        if self._fail:
            raise RuntimeError("connection reset by peer")

        class _Result:
            data = self._rows

        return _Result()


class _FakeSupabase:
    def __init__(self, rows, *, fail: bool = False):
        self.rows = rows
        self.fail = fail
        self.recorder: dict = {}

    def table(self, _name: str):
        return _FakeTable(self.rows, self.recorder, self.fail)


@pytest.fixture
def client():
    test_app = FastAPI()
    test_app.include_router(system.router)
    with TestClient(test_app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_cache():
    """모듈 TTL 캐시를 테스트 간 격리 — 앞 테스트의 값이 뒤 테스트로 새지 않게."""
    system._cache = None
    yield
    system._cache = None


def test_public_settings_needs_no_auth(client, monkeypatch):
    """무인증으로 읽힌다. 점검 안내는 세션 부트스트랩 전에 가장 필요하다."""
    monkeypatch.setattr(system, "supabase_admin", _FakeSupabase([_ROW]))
    res = client.get("/api/v1/system/public-settings")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body == {
        "maintenanceMode": True,
        "noticeText": "시설 점검 중입니다.",
        "congestionThreshold": 85,
        "source": "live",
    }


def test_only_three_fields_are_exposed(client, monkeypatch):
    """다른 설정 컬럼은 절대 새어 나가지 않는다.

    행에 내부 스위치가 섞여 들어와도 응답에는 세 키만 있어야 하고, 애초에 SELECT 자체가
    `*` 가 아니라 세 컬럼을 이름으로 지정해야 한다(컬럼이 늘 때 조용히 공개되는 구조 차단).
    """
    fake = _FakeSupabase([{**_ROW, "merchant_console_enabled": False, "coldstart_weight": 50}])
    monkeypatch.setattr(system, "supabase_admin", fake)
    res = client.get("/api/v1/system/public-settings")

    assert set(res.json()) == {"maintenanceMode", "noticeText", "congestionThreshold", "source"}
    assert "*" not in fake.recorder["select"], "select('*') 는 컬럼이 늘 때마다 조용히 공개된다"
    assert "coldstart_weight" not in fake.recorder["select"]
    assert "merchant_console_enabled" not in fake.recorder["select"]


def test_fetch_failure_is_not_reported_as_maintenance(client, monkeypatch):
    """조회 실패를 '점검 중' 으로 오해시키지 않는다(fail-open).

    실패를 maintenanceMode=true 로 폴백하면 설정 표 장애 한 번이 멀쩡히 도는 앱 전체에
    서비스 중단 안내를 띄운다.
    """
    monkeypatch.setattr(system, "supabase_admin", _FakeSupabase([], fail=True))
    res = client.get("/api/v1/system/public-settings")

    assert res.status_code == 200, "설정 조회 실패가 500 이 되면 안 된다"
    body = res.json()
    assert body["maintenanceMode"] is False
    assert body["noticeText"] == ""
    assert body["source"] == "fallback", "폴백값을 실제 설정인 척 내보냈다"


def test_failure_after_success_serves_stale_cache(client, monkeypatch):
    """한 번 성공한 뒤 실패하면 직전 값을 쓰되 낡았다고 말한다."""
    fake = _FakeSupabase([_ROW])
    monkeypatch.setattr(system, "supabase_admin", fake)
    assert client.get("/api/v1/system/public-settings").json()["source"] == "live"

    # TTL 을 지나게 만든 뒤 조회를 실패시킨다.
    system._cache = (system._cache[0] - system._CACHE_TTL_SECONDS - 1, system._cache[1])
    monkeypatch.setattr(system, "supabase_admin", _FakeSupabase([], fail=True))
    body = client.get("/api/v1/system/public-settings").json()

    assert body["source"] == "stale_cache"
    assert body["maintenanceMode"] is True, "직전 성공값을 잃어버렸다"


def test_missing_settings_row_falls_back(client, monkeypatch):
    """system_settings 행이 없는 환경(마이그레이션 미적용)도 500 이 아니다."""
    monkeypatch.setattr(system, "supabase_admin", _FakeSupabase([]))
    body = client.get("/api/v1/system/public-settings").json()

    assert body["source"] == "fallback"
    assert body["maintenanceMode"] is False
    assert system._cache is None, "읽을 설정이 없는 상태를 캐시에 넣으면 행이 생겨도 60초를 못 읽는다"


def test_threshold_is_clamped_and_typed(client, monkeypatch):
    """등급 경계로 쓰이는 값이라 타입·범위를 서버에서 조인다."""
    monkeypatch.setattr(system, "supabase_admin", _FakeSupabase([{**_ROW, "congestion_threshold": 150}]))
    assert client.get("/api/v1/system/public-settings").json()["congestionThreshold"] == 100

    system._cache = None
    monkeypatch.setattr(system, "supabase_admin", _FakeSupabase([{**_ROW, "congestion_threshold": None}]))
    # NULL 은 폴백 경계(75)로 — 프런트가 이미 하드코딩하고 있는 값과 같다.
    assert client.get("/api/v1/system/public-settings").json()["congestionThreshold"] == 75


def test_cache_header_matches_the_server_ttl(client, monkeypatch):
    """앞단 캐시와 서버 TTL 이 **같아야** 한다.

    어긋나면 더 긴 쪽이 실제 지연이 된다 — 서버 TTL 만 줄여 봐야 브라우저·공유 캐시가
    옛 값을 그대로 붙들고 있어 점검 모드가 늦게 퍼진다. 그래서 상수를 직접 대조한다.
    """
    monkeypatch.setattr(system, "supabase_admin", _FakeSupabase([_ROW]))
    res = client.get("/api/v1/system/public-settings")
    assert res.headers["cache-control"] == f"public, max-age={int(system._CACHE_TTL_SECONDS)}"


def test_second_request_within_ttl_skips_the_query(client, monkeypatch):
    """TTL 캐시가 실제로 왕복을 줄인다(관광객 앱이 화면마다 두드린다)."""
    calls = {"n": 0}

    class _CountingSupabase(_FakeSupabase):
        def table(self, name: str):
            calls["n"] += 1
            return super().table(name)

    monkeypatch.setattr(system, "supabase_admin", _CountingSupabase([_ROW]))
    client.get("/api/v1/system/public-settings")
    client.get("/api/v1/system/public-settings")
    assert calls["n"] == 1, f"캐시가 동작하지 않는다(DB 조회 {calls['n']}회)"
