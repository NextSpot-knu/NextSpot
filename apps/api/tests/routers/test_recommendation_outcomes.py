from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.core.supabase import get_current_user
from app.routers import recommendations


USER_ID = "11111111-1111-4111-8111-111111111111"
REC_ID = "22222222-2222-4222-8222-222222222222"


class RpcRecorder:
    def __init__(self, error: Exception | None = None):
        self.calls = []
        self.error = error

    def rpc(self, name, payload):
        self.calls.append((name, payload))
        return self

    def execute(self):
        if self.error:
            raise self.error
        return SimpleNamespace(data={"recommendation_id": REC_ID, "user_id": USER_ID})


def make_client(monkeypatch, recorder: RpcRecorder, resolve=None):
    app = FastAPI()
    app.include_router(recommendations.router)
    app.dependency_overrides[get_current_user] = lambda: {"id": USER_ID}
    monkeypatch.setattr(recommendations, "supabase_client", recorder)
    monkeypatch.setattr(
        recommendations,
        "resolve_feedback_target",
        resolve or AsyncMock(return_value=({"id": REC_ID}, {"id": "facility"})),
    )
    return TestClient(app)


def test_navigation_outcome_is_idempotently_forwarded_to_atomic_rpc(monkeypatch):
    recorder = RpcRecorder()
    client = make_client(monkeypatch, recorder)
    first = client.patch(f"/api/v1/recommendations/{REC_ID}/outcome", json={"stage": "navigation_started"})
    second = client.patch(f"/api/v1/recommendations/{REC_ID}/outcome", json={"stage": "navigation_started"})
    assert first.status_code == second.status_code == 200
    assert recorder.calls[0] == recorder.calls[1]
    assert recorder.calls[0][1]["p_user_id"] == USER_ID


def test_rated_requires_rating_and_rejects_fields_on_earlier_stage(monkeypatch):
    client = make_client(monkeypatch, RpcRecorder())
    assert client.patch(f"/api/v1/recommendations/{REC_ID}/outcome", json={"stage": "rated"}).status_code == 422
    assert client.patch(
        f"/api/v1/recommendations/{REC_ID}/outcome",
        json={"stage": "arrival_confirmed", "rating": "up"},
    ).status_code == 422


def test_stage_order_conflict_is_409(monkeypatch):
    client = make_client(monkeypatch, RpcRecorder(ValueError("navigation_started must be recorded first")))
    response = client.patch(f"/api/v1/recommendations/{REC_ID}/outcome", json={"stage": "arrival_confirmed"})
    assert response.status_code == 409


def test_recommendation_ownership_failure_is_preserved(monkeypatch):
    resolve = AsyncMock(side_effect=HTTPException(status_code=403, detail="forbidden"))
    client = make_client(monkeypatch, RpcRecorder(), resolve)
    response = client.patch(f"/api/v1/recommendations/{REC_ID}/outcome", json={"stage": "navigation_started"})
    assert response.status_code == 403
