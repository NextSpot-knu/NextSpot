from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import tracking


class _InsertRecorder:
    def __init__(self):
        self.rows = []

    def table(self, name):
        assert name == "app_events"
        return self

    def insert(self, row):
        self.rows.append(row)
        return self

    def execute(self):
        return None


def _client(monkeypatch):
    recorder = _InsertRecorder()
    monkeypatch.setattr(tracking, "supabase_admin", recorder)
    tracking._last_track_at.clear()
    app = FastAPI()
    app.include_router(tracking.router)
    return TestClient(app), recorder


def test_core_event_with_bounded_properties_is_stored(monkeypatch):
    client, recorder = _client(monkeypatch)
    response = client.post("/api/v1/events/track", json={
        "event": "context_applied",
        "props": {
            "categories": ["culture"],
            "max_walk_minutes": 10,
            "available_minutes": 60,
            "required_attributes": ["indoor"],
            "exclude_visited": True,
        },
    })
    assert response.status_code == 204
    assert recorder.rows[0]["event"] == "context_applied"


def test_coordinates_and_natural_language_are_rejected(monkeypatch):
    client, recorder = _client(monkeypatch)
    for props in ({"latitude": 35.8}, {"text": "비가 와서 가까운 곳"}, {"query": "raw request"}):
        response = client.post("/api/v1/events/track", json={"event": "replan_requested", "props": props})
        assert response.status_code == 422
    assert recorder.rows == []


def test_arbitrary_event_and_free_form_value_are_rejected(monkeypatch):
    client, recorder = _client(monkeypatch)
    assert client.post("/api/v1/events/track", json={"event": "custom", "props": {}}).status_code == 422
    assert client.post("/api/v1/events/track", json={
        "event": "recommendation_explained", "props": {"question": "사용자 원문"},
    }).status_code == 422
    assert recorder.rows == []
