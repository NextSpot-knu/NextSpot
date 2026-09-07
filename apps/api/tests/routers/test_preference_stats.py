# 온보딩 선호 집계 라우터 테스트 — 분모 정의·개인정보 미노출·표본 없음·1000행 캡.
#
#  · main.py 는 소유 파일 밖(배선은 별도 작업)이라 이 라우터만 얹은 로컬 FastAPI 앱을 쓴다
#    (tests/routers/test_impact.py 상단 주석과 같은 이유).
#  · DB: supabase_admin 을 test_routers.py 의 공용 FakeSupabase 로 패치 — 네트워크 0.
#    그 페이크는 .range() 와 **1000행 캡**을 실제로 흉내 내므로, 전량 조회를 안 하는
#    구현은 여기서 걸린다(users 가 캡을 넘는 날 조용히 잘린 표본으로 비율을 계산하는 결함).
#
# 잡으려는 결함:
#   · 분모를 '전체 사용자' 로 잡아 어떤 업종도 몇 %를 못 넘는 죽은 숫자가 되는 것
#   · 표본 0명인데 0.0 을 채워 보내 화면이 '선호 0%' 라는 없는 관측을 그리는 것
#   · 사용자 식별자·개별 선호 조합이 응답에 섞여 나가는 것
#   · 조회 실패가 '표본 없음' 으로 흡수돼 관리자가 장애를 데이터 부족으로 읽는 것
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import preference_stats
from tests.conftest import admin_headers
from tests.routers.test_routers import FakeSupabase


@pytest.fixture
def client():
    test_app = FastAPI()
    test_app.include_router(preference_stats.router)
    with TestClient(test_app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_cache():
    """모듈 TTL 캐시를 테스트 간 격리 — 앞 테스트의 집계가 뒤 테스트로 새지 않게."""
    preference_stats._cache = None
    yield
    preference_stats._cache = None


def _users(*preference_values) -> list[dict]:
    """users 행 목록. 값을 그대로 넣는다 — 리스트가 아닌 값(과거 스키마·NULL)도 테스트한다."""
    return [{"preferred_categories": value} for value in preference_values]


# =========================================================================
# 인증 가드 — 관리자만
# =========================================================================

def test_requires_admin(client):
    assert client.get("/api/v1/preference-stats/categories").status_code == 401


def test_tourist_is_rejected(client):
    # conftest 의 _TEST_ROLES 에 없는 uid 는 tourist 로 떨어진다.
    res = client.get(
        "/api/v1/preference-stats/categories",
        headers=admin_headers("11111111-0000-4000-8000-000000000001"),
    )
    assert res.status_code == 403


# =========================================================================
# 분모 = '선호를 고른 사용자' 지 '전체 사용자' 가 아니다
# =========================================================================

def test_share_denominator_is_the_answered_sample(client):
    """선호를 안 고른 사용자는 분모에 들어가지 않는다.

    프로덕션 실측(2026-09-07)이 683명 중 26명만 선호를 갖고 있다. 683 을 분모로 쓰면
    가장 인기 있는 업종조차 3% 를 못 넘어 '아무도 찾지 않는 도시' 라는 없는 사실이 나온다.
    """
    rows = _users(["restaurant"], ["restaurant", "cafe"], [], [], [])
    with patch.object(preference_stats, "supabase_admin", FakeSupabase({"users": rows})):
        body = client.get("/api/v1/preference-stats/categories", headers=admin_headers()).json()

    assert body["sample_size"] == 2, "선호를 고른 2명만 분모다"
    assert body["total_users"] == 5, "전체 사용자 수는 맥락으로 함께 준다"
    assert body["shares"]["restaurant"] == 1.0
    assert body["shares"]["cafe"] == 0.5
    assert body["shares"]["culture"] == 0.0, "표본이 있는데 아무도 안 고른 것은 실측 0 이다"


def test_duplicate_picks_count_once(client):
    """같은 업종을 두 번 적어도 한 번만 센다 — 분자는 '고른 사람 수' 다."""
    rows = _users(["cafe", "cafe", "cafe"], ["restaurant"])
    with patch.object(preference_stats, "supabase_admin", FakeSupabase({"users": rows})):
        body = client.get("/api/v1/preference-stats/categories", headers=admin_headers()).json()

    assert body["shares"]["cafe"] == 0.5


def test_unknown_categories_are_ignored(client):
    """화이트리스트 밖 값(과거 스키마·오타)은 통째로 무시한다."""
    rows = _users(["bar", "hotel"], ["restaurant"], "not-a-list", None)
    with patch.object(preference_stats, "supabase_admin", FakeSupabase({"users": rows})):
        body = client.get("/api/v1/preference-stats/categories", headers=admin_headers()).json()

    assert body["sample_size"] == 1, "허용 업종을 하나도 안 고른 행은 표본이 아니다"
    assert set(body["shares"]) == {"restaurant", "cafe", "attraction", "culture"}


# =========================================================================
# 표본이 없으면 비율도 없다 — 0.0 을 지어내지 않는다
# =========================================================================

def test_empty_sample_returns_no_shares(client):
    rows = _users([], [], [])
    with patch.object(preference_stats, "supabase_admin", FakeSupabase({"users": rows})):
        body = client.get("/api/v1/preference-stats/categories", headers=admin_headers()).json()

    assert body["sample_size"] == 0
    assert body["total_users"] == 3
    assert body["shares"] == {}, "0.0 을 채워 보내면 화면이 '선호 0%' 라는 관측으로 그린다"


# =========================================================================
# 개인정보 미노출 — 집계 비율만
# =========================================================================

def test_response_carries_no_per_user_data(client):
    rows = [
        {"id": "u-1", "nickname": "홍길동", "email": "a@b.c", "preferred_categories": ["cafe"]},
        {"id": "u-2", "nickname": "임꺽정", "email": "d@e.f", "preferred_categories": ["cafe"]},
    ]
    with patch.object(preference_stats, "supabase_admin", FakeSupabase({"users": rows})):
        res = client.get("/api/v1/preference-stats/categories", headers=admin_headers())

    assert set(res.json()) == {"sample_size", "total_users", "shares"}
    raw = res.text
    for secret in ("u-1", "홍길동", "a@b.c"):
        assert secret not in raw, f"응답에 개별 사용자 데이터({secret})가 실렸다"


# =========================================================================
# PostgREST 1000행 캡 — 전량 조회여야 한다
# =========================================================================

def test_reads_past_the_postgrest_row_cap(client):
    """단일 응답 캡(1000행)을 넘는 사용자도 전부 센다.

    페이지네이션 없이 select 한 번으로 읽으면 1000행에서 조용히 잘린 표본으로 비율을
    계산한다 — 숫자는 그럴듯하게 나오므로 아무도 눈치채지 못한다.
    """
    rows = _users(*([["restaurant"]] * 1000 + [["cafe"]] * 200))
    with patch.object(preference_stats, "supabase_admin", FakeSupabase({"users": rows})):
        body = client.get("/api/v1/preference-stats/categories", headers=admin_headers()).json()

    assert body["total_users"] == 1200
    assert body["sample_size"] == 1200
    assert body["shares"]["cafe"] == pytest.approx(200 / 1200, abs=1e-4)


# =========================================================================
# 조회 실패는 '표본 없음' 이 아니다
# =========================================================================

def test_query_failure_is_an_error_not_an_empty_sample(client):
    class _Boom:
        def table(self, _name):
            raise RuntimeError("connection reset by peer")

    with patch.object(preference_stats, "supabase_admin", _Boom()):
        res = client.get("/api/v1/preference-stats/categories", headers=admin_headers())

    assert res.status_code == 500, "실패를 표본 0 으로 흡수하면 관리자는 장애를 데이터 부족으로 읽는다"


# =========================================================================
# TTL 캐시 — 두 번째 호출은 DB 를 다시 두드리지 않는다
# =========================================================================

def test_second_call_is_served_from_cache(client):
    class _CountingSupabase(FakeSupabase):
        def __init__(self, tables):
            super().__init__(tables)
            self.calls = 0

        def table(self, name):
            self.calls += 1
            return super().table(name)

    fake = _CountingSupabase({"users": _users(["cafe"])})
    with patch.object(preference_stats, "supabase_admin", fake):
        client.get("/api/v1/preference-stats/categories", headers=admin_headers())
        first = fake.calls
        client.get("/api/v1/preference-stats/categories", headers=admin_headers())

    assert fake.calls == first, "TTL 안인데 users 를 다시 전량 조회했다"
