# POST /api/v1/preferences/parse — '못 알아들었으면 아무것도 쓰지 않는다' 계약 검증(2026-09 감사).
#
# 배경: 자연어 선호 파싱이 카테고리·속성을 하나도 못 뽑아도 라우터가 그대로 선호 벡터를 upsert 했다.
# 빈 파싱 결과의 벡터는 build_preference_vector([], []) = '전 카테고리 평균'이라, 사용자가 피드백으로
# 쌓아 온 학습이 말 한마디에 기본값으로 초기화되고 화면은 '반영했어요'라고 말했다.
#
# 여기서는 목으로 흉내낸 경로가 아니라 **실제 라우터가 쓰는 쓰기 지점**(supabase_admin.table(...).update,
# preference_vector_service.upsert_user_vector)에 기록기를 걸고, 쓰기가 0건인지 센다.
# 조기 반환을 되돌리면 이 카운터가 올라가 테스트가 깨진다.

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.core.supabase import get_current_user
from app.main import app
from app.routers import preferences as prefs
from app.services.preference_vector_service import preference_vector_service

USER_ID = "u-pref-1"

# 키워드 사전(카테고리·속성 전부)에 하나도 안 걸리는 발화. conftest 가 UPSTAGE_API_KEY="" 로
# 고정하므로 LLM 백스톱도 비활성 → 파싱 결과가 확실히 빈 상태가 된다.
_UNPARSEABLE = "아무거나 좋아요"
# 키워드가 확실히 잡히는 발화(cafe + quiet) — 정상 경로가 살아 있는지 대조군.
_PARSEABLE = "조용한 카페가 좋아요"


class _RecordingResult:
    data: list = []


class _RecordingTable:
    """update()/upsert() 페이로드를 기록하고 체이닝을 흡수하는 가짜 테이블."""

    def __init__(self, name: str, writes: list):
        self._name = name
        self._writes = writes

    def update(self, payload):
        self._writes.append((self._name, "update", payload))
        return self

    def upsert(self, payload):
        self._writes.append((self._name, "upsert", payload))
        return self

    def __getattr__(self, _name):
        def _chain(*_args, **_kwargs):
            return self

        return _chain

    def execute(self):
        return _RecordingResult()


class _RecordingSupabase:
    def __init__(self):
        self.writes: list = []

    def table(self, name: str) -> _RecordingTable:
        return _RecordingTable(name, self.writes)


@pytest.fixture
def auth_client():
    app.dependency_overrides[get_current_user] = lambda: {
        "id": USER_ID,
        "email": "tourist@example.com",
        "role": "authenticated",
    }
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture
def recorder(monkeypatch):
    """users 테이블 쓰기와 선호 벡터 upsert 를 모두 기록한다(네트워크 0)."""
    db = _RecordingSupabase()
    monkeypatch.setattr(prefs, "supabase_admin", db)
    upsert = AsyncMock()
    monkeypatch.setattr(preference_vector_service, "upsert_user_vector", upsert)
    return db, upsert


def test_unparseable_preference_writes_nothing_and_says_so(auth_client, recorder):
    # 1. 선호를 하나도 못 알아들으면 벡터도 카테고리도 preference_note 도 쓰지 않는다.
    db, upsert = recorder
    res = auth_client.post("/api/v1/preferences/parse", json={"text": _UNPARSEABLE})

    assert res.status_code == 200

    # 핵심 — 사용자 데이터가 한 글자도 바뀌지 않았다(학습된 선호 벡터 보존).
    upsert.assert_not_awaited()
    assert db.writes == []

    body = res.json()
    assert body["applied"] is False
    assert body["reason"] == prefs.REASON_NO_PREFERENCE
    assert body["preferred_categories"] == []
    assert body["attributes"] == []
    assert body["vector_updated"] is False
    assert body["categories_saved"] is False
    # 응답 봉투는 그대로 — 구버전 프런트가 읽는 필드가 하나도 빠지지 않았다.
    for key in ("summary", "is_fallback", "llm_status"):
        assert key in body


def test_parseable_preference_still_applies(auth_client, recorder):
    # 2. 대조군 — 알아들은 선호는 기존대로 저장되고 applied=True.
    db, upsert = recorder
    res = auth_client.post("/api/v1/preferences/parse", json={"text": _PARSEABLE})

    assert res.status_code == 200
    body = res.json()
    assert body["applied"] is True
    assert body["reason"] is None
    assert "cafe" in body["preferred_categories"]
    assert "quiet" in body["attributes"]
    assert body["vector_updated"] is True
    assert body["categories_saved"] is True

    upsert.assert_awaited_once()
    written = {(table, op) for table, op, _payload in db.writes}
    assert ("users", "update") in written


def test_storage_failure_is_not_reported_as_applied(auth_client, monkeypatch):
    # 3. 선호는 알아들었지만 저장이 전부 실패하면 applied=False — '반영했어요'라고 말하지 않는다.
    #    (벡터 저장소 미가용 + users 업데이트 예외 = 실제로 반영된 것이 0건)
    class _Exploding:
        def table(self, _name):
            raise RuntimeError("PostgREST unavailable")

    monkeypatch.setattr(prefs, "supabase_admin", _Exploding())
    monkeypatch.setattr(preference_vector_service, "upsert_user_vector", AsyncMock())
    with patch.object(type(preference_vector_service), "available", property(lambda _self: False)):
        res = auth_client.post("/api/v1/preferences/parse", json={"text": _PARSEABLE})

    assert res.status_code == 200
    body = res.json()
    assert body["applied"] is False
    assert body["reason"] == prefs.REASON_STORAGE_UNAVAILABLE
    assert body["vector_updated"] is False
    assert body["categories_saved"] is False
    # 파싱 자체는 성공했으므로 구조화 결과는 그대로 돌려준다(값을 지어내지도, 감추지도 않는다).
    assert "cafe" in body["preferred_categories"]
