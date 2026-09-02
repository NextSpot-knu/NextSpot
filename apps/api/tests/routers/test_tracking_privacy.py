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


# ── 음성 명령 이벤트 — 프런트가 쏘고 있는데 서버가 버리던 것 ────────────────
# analytics.ts:23 이 voice_tool_executed 를 이미 쏘고 있었는데 서버 허용목록에 없어 전부
# 422 로 버려졌다. 음성 퍼널 계측이 통째로 비어 있었고, fire-and-forget 이라 아무도 몰랐다.


def test_voice_tool_event_is_stored(monkeypatch):
    client, recorder = _client(monkeypatch)
    res = client.post("/api/v1/events/track", json={
        "event": "voice_tool_executed",
        "props": {"tool": "set_facility_type", "status": "applied", "facility_type": "cafe"},
    })
    assert res.status_code == 204, f"프런트가 쏘는 이벤트가 {res.status_code} 로 버려졌다"
    assert recorder.rows[0]["event"] == "voice_tool_executed"


def test_voice_tool_event_rejects_free_text(monkeypatch):
    """자유 텍스트 표면을 닫는 게 이 허용목록의 목적이다 — 새 이벤트도 예외가 아니다."""
    client, _ = _client(monkeypatch)
    for props in (
        {"tool": "rm -rf /", "status": "applied"},
        {"tool": "set_indoor_mode", "status": "사용자가 입력한 아무 문자열"},
    ):
        res = client.post("/api/v1/events/track", json={"event": "voice_tool_executed", "props": props})
        assert res.status_code == 422, f"자유 텍스트가 통과했다: {props}"


# ── 쿨다운 키 — 위조 가능한 XFF 첫 항목을 쓰면 안 된다 ─────────────────────

def test_cooldown_key_uses_the_last_forwarded_hop(monkeypatch):
    """프록시는 XFF 에 덧붙이므로 첫 항목은 클라이언트가 임의로 써 보낼 수 있다. 그걸 키로
    쓰면 매 요청 다른 값을 넣어 쿨다운을 우회하면서 _last_track_at 을 무한히 키운다."""
    client, recorder = _client(monkeypatch)
    body = {"event": "trip_resumed", "props": {"facility_type": "cafe"}}

    first = client.post("/api/v1/events/track", json=body,
                        headers={"X-Forwarded-For": "1.1.1.1, 203.0.113.9"})
    second = client.post("/api/v1/events/track", json=body,
                         headers={"X-Forwarded-For": "2.2.2.2, 203.0.113.9"})

    assert first.status_code == 204 and second.status_code == 204
    # 앞 항목만 바꿔 치기해도 같은 실제 피어로 묶여야 하므로 두 번째는 쿨다운에 걸린다.
    assert len(recorder.rows) == 1, "위조한 XFF 첫 항목으로 쿨다운을 우회했다"
    # 쿨다운 키는 "<ip>:<event>" 다 — 위조한 앞 항목이 아니라 실제 피어로 묶여야 한다.
    assert all(k.startswith("203.0.113.9:") for k in tracking._last_track_at), tracking._last_track_at
    assert len(tracking._last_track_at) == 1
