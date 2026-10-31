"""방문 확인 체감 혼잡 — 게스트 그림자 모드 · 1인 1표(PRODUCT_EVALUATION_PLAN §6 D3).

DB 쪽(게스트 판정 · user_report 투영 생략 · 교차검증 조건)은 마이그레이션 20261031130000 의 트리거가 맡는다
(tests/migrations/test_guest_crowd_answer_shadow_migration.py). 여기서는 API 가 RPC 에 무엇을 넘기고,
같은 IP·장소의 두 번째 계정 답을 어떻게 다루는지 본다.
"""
import re
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.report_slots import CONGESTION_VOTES_BY_IP, GUEST_SHADOW_VOTES_BY_IP
from app.core.supabase import get_current_user
from app.routers import recommendations
from app.services import reference_snapshot

_REC = "22222222-2222-4222-8222-222222222222"
_URL = f"/api/v1/recommendations/{_REC}/outcome"
_FACILITY = "fac-1"
_HASH_RE = r"^[0-9a-f]{32}$"


class _Rpc:
    """rpc 호출을 기록하고, 정해 둔 응답(또는 예외)을 돌려준다."""

    def __init__(self, *, mode: str | None = "registered", fail: Exception | None = None, legacy: bool = False):
        self.calls: list[dict] = []
        self.mode = mode
        self.fail = fail
        self.legacy = legacy
        self._payload: dict = {}

    def rpc(self, _name, payload):
        self._payload = payload
        self.calls.append(payload)
        return self

    def execute(self):
        if self.legacy and "p_network_hash" in self._payload:
            raise RuntimeError("{'code': 'PGRST202', 'message': 'Could not find the function'}")
        if self.fail is not None:
            raise self.fail
        row = {
            "recommendation_id": _REC,
            "rating": self._payload.get("p_rating"),
            "observed_congestion": self._payload.get("p_observed_congestion"),
            "observed_network_hash": self._payload.get("p_network_hash"),
        }
        if not self.legacy:
            row["observed_answer_mode"] = self.mode if self._payload.get("p_observed_congestion") else None
        return SimpleNamespace(data=row)


@pytest.fixture
def marks(monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr(reference_snapshot, "mark_dirty", lambda kind: seen.append(kind))
    return seen


def _client(monkeypatch, rpc: _Rpc, *, user_id: str, anonymous: bool) -> TestClient:
    app = FastAPI()
    app.include_router(recommendations.router)
    app.dependency_overrides[get_current_user] = lambda: {
        "id": user_id,
        "payload": {"is_anonymous": anonymous},
    }
    monkeypatch.setattr(recommendations, "supabase_client", rpc)
    monkeypatch.setattr(
        recommendations,
        "resolve_feedback_target",
        AsyncMock(return_value=({"recommended_facility_id": _FACILITY, "user_id": user_id}, {})),
    )
    return TestClient(app)


def _rate(client: TestClient, ip: str, observed: str | None = "busy"):
    body = {"stage": "rated", "rating": "up"}
    if observed:
        body["observed_congestion"] = observed
    return client.patch(_URL, json=body, headers={"x-forwarded-for": ip})


def test_guest_answer_goes_to_shadow_with_network_hash_and_no_live_request(monkeypatch, marks):
    rpc = _Rpc(mode="guest_shadow")
    res = _rate(_client(monkeypatch, rpc, user_id="guest-1", anonymous=True), "203.0.113.7")
    assert res.status_code == 200
    body = res.json()
    assert body["crowd_answer"] == "guest_shadow"
    payload = rpc.calls[0]
    assert payload["p_observed_congestion"] == "busy"
    assert payload["p_guest_answer_live"] is False
    assert re.match(_HASH_RE, payload["p_network_hash"])
    assert "203.0.113" not in str(payload)          # 원본 IP 는 DB 로 가지 않는다
    assert "observed_network_hash" not in body["outcome"]  # 응답에서도 뺀다
    assert marks == []                               # 그림자 답은 지도 스냅샷을 흔들지 않는다


def test_registered_answer_unchanged_and_carries_no_network_hash(monkeypatch, marks):
    rpc = _Rpc(mode="registered")
    res = _rate(_client(monkeypatch, rpc, user_id="user-1", anonymous=False), "203.0.113.7")
    assert res.status_code == 200
    assert res.json()["crowd_answer"] == "registered"
    assert rpc.calls[0]["p_network_hash"] is None
    assert marks == ["congestion"]


def test_live_switch_requests_guest_live(monkeypatch, marks):
    monkeypatch.setattr(recommendations.settings, "GUEST_CROWD_ANSWERS_LIVE", True)
    rpc = _Rpc(mode="guest_live")
    res = _rate(_client(monkeypatch, rpc, user_id="guest-1", anonymous=True), "203.0.113.7")
    assert res.json()["crowd_answer"] == "guest_live"
    assert rpc.calls[0]["p_guest_answer_live"] is True
    assert marks == ["congestion"]
    # 답이 없으면 실시간 요청도 없다.
    rpc2 = _Rpc()
    _rate(_client(monkeypatch, rpc2, user_id="guest-2", anonymous=True), "198.51.100.1", observed=None)
    assert rpc2.calls[0]["p_guest_answer_live"] is False


def test_second_account_on_same_ip_and_place_keeps_rating_but_drops_answer(monkeypatch, marks):
    first = _Rpc(mode="guest_shadow")
    assert _rate(_client(monkeypatch, first, user_id="guest-1", anonymous=True), "203.0.113.7").status_code == 200

    second = _Rpc(mode="guest_shadow")
    res = _rate(_client(monkeypatch, second, user_id="guest-2", anonymous=True), "10.0.0.9, 203.0.113.7")
    # 거절(429)하지 않는다 — 웹 방문 결과 큐가 이 항목에서 멈추지 않게 평가는 저장한다.
    assert res.status_code == 200
    assert res.json()["crowd_answer"] == "not_recorded_shared_network"
    assert second.calls[0]["p_observed_congestion"] is None
    assert second.calls[0]["p_network_hash"] is None
    assert second.calls[0]["p_rating"] == "up"

    # 다른 IP 의 계정 · 같은 계정의 재요청은 통과한다.
    third = _Rpc(mode="guest_shadow")
    assert _rate(_client(monkeypatch, third, user_id="guest-2", anonymous=True), "198.51.100.1").json()["crowd_answer"] == "guest_shadow"
    again = _Rpc(mode="guest_shadow")
    assert _rate(_client(monkeypatch, again, user_id="guest-1", anonymous=True), "203.0.113.7").json()["crowd_answer"] == "guest_shadow"


def test_explicit_report_and_visit_answer_share_the_vote(monkeypatch, marks):
    # 명시 제보(reports)가 잡은 IP·장소 자리를 다른 계정의 방문 확인 답이 넘지 못한다.
    CONGESTION_VOTES_BY_IP[("203.0.113.7", _FACILITY)] = ("reporter", time.monotonic())
    rpc = _Rpc(mode="registered")
    res = _rate(_client(monkeypatch, rpc, user_id="user-2", anonymous=False), "203.0.113.7")
    assert res.json()["crowd_answer"] == "not_recorded_shared_network"


def test_failed_rpc_releases_the_vote(monkeypatch, marks):
    rpc = _Rpc(fail=RuntimeError("supabase down"))
    res = _rate(_client(monkeypatch, rpc, user_id="guest-1", anonymous=True), "203.0.113.7")
    assert res.status_code == 500
    assert ("203.0.113.7", _FACILITY) not in GUEST_SHADOW_VOTES_BY_IP
    assert ("203.0.113.7", _FACILITY) not in CONGESTION_VOTES_BY_IP


def test_shadow_guest_answer_never_blocks_a_registered_live_vote(monkeypatch, marks):
    # 그림자 답은 실시간에 안 들어간다 — 같은 IP 의 계정 사용자 답(실시간)을 막으면 안 된다.
    guest = _Rpc(mode="guest_shadow")
    assert _rate(_client(monkeypatch, guest, user_id="guest-1", anonymous=True), "203.0.113.7").status_code == 200
    assert ("203.0.113.7", _FACILITY) in GUEST_SHADOW_VOTES_BY_IP
    assert ("203.0.113.7", _FACILITY) not in CONGESTION_VOTES_BY_IP
    member = _Rpc(mode="registered")
    res = _rate(_client(monkeypatch, member, user_id="user-1", anonymous=False), "203.0.113.7")
    assert res.json()["crowd_answer"] == "registered"
    # 반대로 계정 사용자가 먼저 낸 IP·장소에서는 다른 게스트의 그림자 답도 버린다(측정이 같은 규칙에서 나오게).
    late_guest = _Rpc(mode="guest_shadow")
    res = _rate(_client(monkeypatch, late_guest, user_id="guest-2", anonymous=True), "203.0.113.7")
    assert res.json()["crowd_answer"] == "not_recorded_shared_network"


def test_live_guest_answer_uses_the_shared_live_table(monkeypatch, marks):
    monkeypatch.setattr(recommendations.settings, "GUEST_CROWD_ANSWERS_LIVE", True)
    _rate(_client(monkeypatch, _Rpc(mode="guest_live"), user_id="guest-1", anonymous=True), "203.0.113.7")
    assert CONGESTION_VOTES_BY_IP[("203.0.113.7", _FACILITY)][0] == "guest-1"
    res = _rate(_client(monkeypatch, _Rpc(mode="registered"), user_id="user-1", anonymous=False), "203.0.113.7")
    assert res.json()["crowd_answer"] == "not_recorded_shared_network"


def test_legacy_db_without_new_rpc_arguments_falls_back(monkeypatch, marks):
    rpc = _Rpc(legacy=True)
    res = _rate(_client(monkeypatch, rpc, user_id="guest-1", anonymous=True), "203.0.113.7")
    assert res.status_code == 200
    assert len(rpc.calls) == 2
    assert "p_network_hash" not in rpc.calls[1] and "p_guest_answer_live" not in rpc.calls[1]
    assert rpc.calls[1]["p_observed_congestion"] == "busy"
    assert res.json()["crowd_answer"] is None
    assert marks == ["congestion"]  # 구 DB 는 예전처럼 user_report 로 옮긴다
