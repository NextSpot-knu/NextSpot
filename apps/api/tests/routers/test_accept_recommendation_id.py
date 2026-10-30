"""메인 '바로 갈래요' 수락이 노출된 추천 행을 갱신하는 경로(P1-1 쓰기 · P0-5 c).

POST /api/v1/recommendations/accept 에 recommendation_id 가 오면 그 행을 수락으로 표시한다 — /feedback 의
accepted_visit_intent 와 같은 효과(결정 행 1개 · 취향 벡터 +10% 1회 · 쿠폰)이고, 새 recommendations 행은
넣지 않는다. 예전에는 늘 원본=추천인 새 행을 넣어 같은 노출이 두 번 기록되고 '재배치' 가 부풀었으며,
화면은 "취향에 반영했어요" 라고 했지만 취향을 배우지 않았다.
"""
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.core.supabase import get_current_user
from app.main import app
from app.services import feedback_service
from app.services.preference_vector_service import preference_vector_service

USER_ID = "u-accept"
REC_ID = "5b0f6f3a-2a1e-4c55-9d3b-0b6a7d3f9e11"
FACILITY = {
    "id": "f-1", "name": "한옥카페", "type": "cafe", "latitude": 35.836, "longitude": 129.21,
    "coupon_rate": 0.1, "features": {},
}


class _Result:
    def __init__(self, data):
        self.data = data


class _Table:
    """select/insert/update 를 기록하는 최소 PostgREST 대역. eq·in_·limit·is_ 같은 필터는 흡수한다."""

    def __init__(self, db: "_Db", name: str):
        self.db, self.name = db, name
        self._op, self._payload = "select", None

    def select(self, *_args, **_kwargs):
        self._op = "select"
        return self

    def insert(self, payload):
        self._op, self._payload = "insert", payload
        return self

    def update(self, payload):
        self._op, self._payload = "update", payload
        return self

    def __getattr__(self, _name):
        return lambda *_args, **_kwargs: self

    def execute(self):
        if self._op == "insert":
            self.db.inserts.append((self.name, dict(self._payload)))
            row = {"id": f"{self.name}-new", **self._payload}
            if self.name == "user_feedback":
                self.db.feedback.append(row)
            return _Result([row])
        if self._op == "update":
            self.db.updates.append((self.name, dict(self._payload)))
            if self.name == "user_feedback" and self.db.feedback:
                self.db.feedback[0].update(self._payload)
                return _Result([self.db.feedback[0]])
            return _Result([])
        if self.name == "recommendations":
            return _Result([self.db.recommendation] if self.db.recommendation else [])
        if self.name == "user_feedback":
            return _Result([dict(row) for row in self.db.feedback])
        return _Result([])


class _Db:
    def __init__(self, recommendation: dict | None, feedback: list[dict] | None = None):
        self.recommendation = recommendation
        self.feedback = feedback or []
        self.inserts: list[tuple[str, dict]] = []
        self.updates: list[tuple[str, dict]] = []

    def table(self, name: str) -> _Table:
        return _Table(self, name)


def _recommendation(**overrides) -> dict:
    row = {
        "id": REC_ID,
        "user_id": USER_ID,
        # by-type 노출 행은 원본이 없어 original=recommended 다(/recommendations 행만 원본 ≠ 추천).
        "original_facility_id": FACILITY["id"],
        "recommended_facility_id": FACILITY["id"],
        "accepted": False,
        "recommended_facility": FACILITY,
    }
    row.update(overrides)
    return row


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = lambda: {"id": USER_ID, "role": "authenticated"}
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_current_user, None)


def _patched(db: _Db, *, coupon=None, adjust=None):
    coupon = coupon or AsyncMock(return_value={"coupon_issued": True, "coupon_rate": 0.1, "expires_at": "x"})
    adjust = adjust or AsyncMock()
    return (
        patch("app.routers.recommendations.supabase_client", new=db),
        patch("app.routers.recommendations.fetch_facility", new=AsyncMock(return_value=dict(FACILITY))),
        patch("app.routers.recommendations.issue_coupon_if_partner", new=coupon),
        patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=adjust),
    ), coupon, adjust


def _accept(client, body: dict):
    return client.post("/api/v1/recommendations/accept", json=body)


def test_accept_marks_the_shown_recommendation_and_learns_once(client):
    db = _Db(_recommendation())
    patches, coupon, adjust = _patched(db)
    with patches[0], patches[1], patches[2], patches[3]:
        res = _accept(client, {"facility_id": "f-1", "recommendation_id": REC_ID})

    assert res.status_code == 200
    body = res.json()
    assert body == {
        "success": True, "coupon_issued": True, "coupon_rate": 0.1, "expires_at": "x",
        "recommendation_id": REC_ID, "updated_vector": True,
    }
    # 새 recommendations 행 없음 — 노출된 그 행만 accepted=true 로 바뀐다.
    assert [name for name, _ in db.inserts] == ["user_feedback"]
    assert ("recommendations", {"accepted": True}) in db.updates
    # /feedback accepted_visit_intent 와 같은 결정 행(장기 학습 슬롯 선점 포함).
    decision = db.inserts[0][1]
    assert decision["action"] == feedback_service.ACTION_ACCEPTED_VISIT_INTENT
    assert decision["recommendation_id"] == REC_ID and decision["user_id"] == USER_ID
    assert decision["learning_scope"] == "long_term" and decision["learning_applied_at"]
    coupon.assert_awaited_once()
    assert adjust.await_count == 1 and adjust.await_args.kwargs["action"] == "accepted"


@pytest.mark.parametrize("order", ["accept_then_feedback", "feedback_then_accept"])
def test_accept_and_feedback_for_the_same_card_count_once(client, order):
    db = _Db(_recommendation())
    patches, _coupon, adjust = _patched(db)
    with patches[0], patches[1], patches[2], patches[3]:
        calls = [
            lambda: _accept(client, {"facility_id": "f-1", "recommendation_id": REC_ID}),
            lambda: client.post("/api/v1/feedback", json={
                "recommendation_id": REC_ID, "action": "accepted_visit_intent",
            }),
        ]
        if order == "feedback_then_accept":
            calls.reverse()
        responses = [call() for call in calls]

    assert [response.status_code for response in responses] == [200, 200]
    assert [response.json()["updated_vector"] for response in responses] == [True, False]
    assert adjust.await_count == 1  # 취향 +10% 는 한 번
    assert len(db.feedback) == 1  # 결정 행 하나
    assert not [name for name, _ in db.inserts if name == "recommendations"]


def test_accept_switches_an_earlier_decision_without_relearning(client):
    # 실험실에서 거절 사유로 이미 -5% 를 받은 추천 — 수락으로 바뀌어도 +10% 를 더 주지 않는다(행당 1회).
    earlier = {
        "id": "fb-1", "user_id": USER_ID, "recommendation_id": REC_ID, "action": "rejected",
        "reason_status": "answered", "learning_scope": "long_term",
        "learning_applied_at": "2026-10-30T00:00:00+00:00",
    }
    db = _Db(_recommendation(), feedback=[earlier])
    patches, _coupon, adjust = _patched(db)
    with patches[0], patches[1], patches[2], patches[3]:
        res = _accept(client, {"facility_id": "f-1", "recommendation_id": REC_ID})

    assert res.status_code == 200
    assert res.json()["updated_vector"] is False
    assert db.feedback[0]["action"] == feedback_service.ACTION_ACCEPTED_VISIT_INTENT
    adjust.assert_not_awaited()


def test_accept_refuses_someone_elses_recommendation(client):
    db = _Db(_recommendation(user_id="someone-else"))
    patches, coupon, adjust = _patched(db)
    with patches[0], patches[1], patches[2], patches[3]:
        res = _accept(client, {"facility_id": "f-1", "recommendation_id": REC_ID})

    assert res.status_code == 403
    assert db.inserts == [] and db.updates == []
    coupon.assert_not_awaited()
    adjust.assert_not_awaited()


def test_accept_with_an_unknown_recommendation_is_404(client):
    db = _Db(None)
    patches, coupon, _adjust = _patched(db)
    with patches[0], patches[1], patches[2], patches[3]:
        res = _accept(client, {"facility_id": "f-1", "recommendation_id": REC_ID})

    assert res.status_code == 404
    assert db.inserts == [] and db.updates == []
    coupon.assert_not_awaited()


def test_accept_refuses_a_recommendation_for_another_place(client):
    # 다른 장소의 추천 행을 수락으로 바꾸면 분산 지표가 없던 이동을 센다.
    db = _Db(_recommendation(recommended_facility_id="f-other"))
    patches, coupon, _adjust = _patched(db)
    with patches[0], patches[1], patches[2], patches[3]:
        res = _accept(client, {"facility_id": "f-1", "recommendation_id": REC_ID})

    assert res.status_code == 409
    assert db.inserts == [] and db.updates == []
    coupon.assert_not_awaited()


def test_decision_write_failure_still_issues_the_coupon(client):
    db = _Db(_recommendation())
    patches, coupon, adjust = _patched(db)
    failing = AsyncMock(side_effect=RuntimeError("db down"))
    with patches[0], patches[1], patches[2], patches[3], \
         patch("app.routers.recommendations.feedback_service.record_decision", new=failing):
        res = _accept(client, {"facility_id": "f-1", "recommendation_id": REC_ID})

    assert res.status_code == 200
    assert res.json()["coupon_issued"] is True
    assert res.json()["updated_vector"] is False
    coupon.assert_awaited_once()
    adjust.assert_not_awaited()
    assert not [name for name, _ in db.inserts if name == "recommendations"]
