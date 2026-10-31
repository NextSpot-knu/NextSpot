"""방문 확인 체감 혼잡 — 게스트 그림자 모드 · 게스트 1인 1표 · 계정 사용자 예전 그대로(PRODUCT_EVALUATION_PLAN §6 D3).

DB 쪽(게스트 판정 · user_report 투영 생략 · 교차검증 조건)은 마이그레이션 20261031130000 의 트리거가 맡는다
(tests/migrations/test_guest_crowd_answer_shadow_migration.py). 여기서는 API 가 RPC 에 무엇을 넘기고,
게스트 답을 언제 버리는지, 계정 사용자 답은 언제나 기록되는지 본다.
"""
import re
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.report_slots import (
    CONGESTION_VOTES_BY_IP,
    GUEST_ANSWER_LAST_BY_USER,
    GUEST_ANSWER_VOTES_BY_IP,
)
from app.core.supabase import get_current_user
from app.routers import recommendations
from app.services import reference_snapshot

_REC = "22222222-2222-4222-8222-222222222222"
_URL = f"/api/v1/recommendations/{_REC}/outcome"
_FACILITY = "fac-1"
_HASH_RE = r"^[0-9a-f]{32}$"
_IP = "203.0.113.7"


class _Rpc:
    """rpc 호출을 기록하고, 정해 둔 응답(또는 예외)을 돌려준다. stored 는 DB 에 이미 있는 답(재전송 흉내)."""

    def __init__(self, *, mode: str | None = "registered", fail: Exception | None = None, legacy: bool = False,
                 stored: tuple[str, str] | None = None):
        self.calls: list[dict] = []
        self.mode = mode
        self.fail = fail
        self.legacy = legacy
        self.stored = stored
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
        observed = self._payload.get("p_observed_congestion")
        row = {
            "recommendation_id": _REC,
            "rating": self._payload.get("p_rating"),
            "observed_congestion": observed,
            "observed_network_hash": self._payload.get("p_network_hash"),
        }
        if not self.legacy:
            row["observed_answer_mode"] = self.mode if observed else None
        if self.stored:
            row["observed_congestion"], row["observed_answer_mode"] = self.stored
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


def _age_guest_slots(seconds: float) -> None:
    for key, (user_id, at) in list(GUEST_ANSWER_VOTES_BY_IP.items()):
        GUEST_ANSWER_VOTES_BY_IP[key] = (user_id, at - seconds)
    for key, at in list(GUEST_ANSWER_LAST_BY_USER.items()):
        GUEST_ANSWER_LAST_BY_USER[key] = at - seconds


# ── 게스트: 그림자 · 네트워크 키 · 실시간 요청 ────────────────────────────────────────────


def test_guest_answer_goes_to_shadow_with_network_hash_and_no_live_request(monkeypatch, marks):
    rpc = _Rpc(mode="guest_shadow")
    res = _rate(_client(monkeypatch, rpc, user_id="guest-1", anonymous=True), _IP)
    assert res.status_code == 200
    body = res.json()
    assert body["crowd_answer"] == "guest_shadow"
    payload = rpc.calls[0]
    assert payload["p_observed_congestion"] == "busy"
    assert payload["p_guest_answer_live"] is False
    assert re.match(_HASH_RE, payload["p_network_hash"])
    assert "203.0.113" not in str(payload)  # 원본 IP 는 DB 로 가지 않는다
    assert "observed_network_hash" not in body["outcome"]  # 응답에서도 뺀다
    assert marks == []  # 그림자 답은 지도 스냅샷을 흔들지 않는다


def test_live_switch_requests_guest_live(monkeypatch, marks):
    monkeypatch.setattr(recommendations.settings, "GUEST_CROWD_ANSWERS_LIVE", True)
    rpc = _Rpc(mode="guest_live")
    res = _rate(_client(monkeypatch, rpc, user_id="guest-1", anonymous=True), _IP)
    assert res.json()["crowd_answer"] == "guest_live"
    assert rpc.calls[0]["p_guest_answer_live"] is True
    assert marks == ["congestion"]
    # 답이 없으면 실시간 요청도 없다.
    rpc2 = _Rpc()
    _rate(_client(monkeypatch, rpc2, user_id="guest-2", anonymous=True), "198.51.100.1", observed=None)
    assert rpc2.calls[0]["p_guest_answer_live"] is False


# ── 게스트: 1인 1표 · 쿨다운 ───────────────────────────────────────────────────────────────


def test_second_guest_on_same_ip_and_place_keeps_rating_but_drops_answer(monkeypatch, marks):
    assert _rate(_client(monkeypatch, _Rpc(mode="guest_shadow"), user_id="guest-1", anonymous=True), _IP).status_code == 200

    second = _Rpc(mode="guest_shadow")
    res = _rate(_client(monkeypatch, second, user_id="guest-2", anonymous=True), f"10.0.0.9, {_IP}")
    # 거절(429)하지 않는다 — 웹 방문 결과 큐가 이 항목에서 멈추지 않게 평가는 저장한다.
    assert res.status_code == 200
    assert res.json()["crowd_answer"] == "not_recorded_shared_network"
    assert second.calls[0]["p_observed_congestion"] is None
    assert second.calls[0]["p_network_hash"] is None
    assert second.calls[0]["p_rating"] == "up"

    # 다른 IP 의 게스트는 통과한다. 30분이 지나면 같은 IP 의 다른 게스트도 통과한다.
    other = _rate(_client(monkeypatch, _Rpc(mode="guest_shadow"), user_id="guest-3", anonymous=True), "198.51.100.1")
    assert other.json()["crowd_answer"] == "guest_shadow"
    _age_guest_slots(31 * 60)
    later = _rate(_client(monkeypatch, _Rpc(mode="guest_shadow"), user_id="guest-2", anonymous=True), _IP)
    assert later.json()["crowd_answer"] == "guest_shadow"


def test_same_guest_same_place_answers_once_per_30_minutes(monkeypatch, marks):
    # L4: 실시간을 켜면 한 게스트가 추천을 돌려 같은 장소에 단건 관측을 쌓을 수 있었다 — IP 를 바꿔도 30분에 한 번.
    assert _rate(_client(monkeypatch, _Rpc(mode="guest_shadow"), user_id="guest-1", anonymous=True), _IP).json()[
        "crowd_answer"
    ] == "guest_shadow"
    again = _Rpc(mode="guest_shadow")
    res = _rate(_client(monkeypatch, again, user_id="guest-1", anonymous=True), "198.51.100.1")
    assert res.json()["crowd_answer"] == "not_recorded_cooldown"
    assert again.calls[0]["p_observed_congestion"] is None
    _age_guest_slots(31 * 60)
    res = _rate(_client(monkeypatch, _Rpc(mode="guest_shadow"), user_id="guest-1", anonymous=True), "198.51.100.1")
    assert res.json()["crowd_answer"] == "guest_shadow"


def test_queue_replay_of_an_already_recorded_answer_reports_the_stored_mode(monkeypatch, marks):
    # 같은 rated 를 큐가 다시 보내면 쿨다운에 걸리지만, DB 에 이미 답이 있으니 그 분류를 돌려준다.
    _rate(_client(monkeypatch, _Rpc(mode="guest_shadow"), user_id="guest-1", anonymous=True), _IP)
    replay = _Rpc(stored=("busy", "guest_shadow"))
    res = _rate(_client(monkeypatch, replay, user_id="guest-1", anonymous=True), _IP)
    assert res.json()["crowd_answer"] == "guest_shadow"


def test_guest_answer_yields_to_a_registered_report_on_the_same_ip(monkeypatch, marks):
    # 계정 사용자가 명시 제보로 잡은 IP·장소 — 다른 게스트의 답은 버린다(게스트끼리·게스트+계정 일치를 한 네트워크가 꾸미지 못하게).
    CONGESTION_VOTES_BY_IP[(_IP, _FACILITY)] = ("reporter", time.monotonic())
    res = _rate(_client(monkeypatch, _Rpc(mode="guest_shadow"), user_id="guest-1", anonymous=True), _IP)
    assert res.json()["crowd_answer"] == "not_recorded_shared_network"


def test_guest_answer_never_takes_the_registered_report_slot(monkeypatch, marks):
    # 게스트 답(그림자·실시간 모두)은 계정 사용자의 실시간 표를 읽기만 한다 — 계정 사용자의 제보를 막지 않는다.
    for live in (False, True):
        monkeypatch.setattr(recommendations.settings, "GUEST_CROWD_ANSWERS_LIVE", live)
        _rate(_client(monkeypatch, _Rpc(mode="guest_live" if live else "guest_shadow"), user_id=f"guest-{live}",
                      anonymous=True), _IP if not live else "198.51.100.9")
    assert CONGESTION_VOTES_BY_IP == {}
    assert (_IP, _FACILITY) in GUEST_ANSWER_VOTES_BY_IP


def test_failed_rpc_releases_the_guest_slot_and_cooldown(monkeypatch, marks):
    res = _rate(_client(monkeypatch, _Rpc(fail=RuntimeError("supabase down")), user_id="guest-1", anonymous=True), _IP)
    assert res.status_code == 500
    assert GUEST_ANSWER_VOTES_BY_IP == {} and GUEST_ANSWER_LAST_BY_USER == {}


# ── 계정 사용자: 10-31 이전 그대로 ─────────────────────────────────────────────────────────


def test_registered_answer_is_always_recorded_and_carries_no_network_hash(monkeypatch, marks):
    # 같은 IP 에서 다른 계정이 이미 제보했어도(공용 와이파이·CGNAT) 계정 사용자 답은 버리지 않는다.
    CONGESTION_VOTES_BY_IP[(_IP, _FACILITY)] = ("someone-else", time.monotonic())
    GUEST_ANSWER_VOTES_BY_IP[(_IP, _FACILITY)] = ("guest-x", time.monotonic())
    for user in ("user-1", "user-2"):
        rpc = _Rpc(mode="registered")
        res = _rate(_client(monkeypatch, rpc, user_id=user, anonymous=False), _IP)
        assert res.status_code == 200
        assert res.json()["crowd_answer"] == "registered"
        assert rpc.calls[0]["p_observed_congestion"] == "busy"
        assert rpc.calls[0]["p_network_hash"] is None
        assert rpc.calls[0]["p_guest_answer_live"] is False
    assert marks == ["congestion", "congestion"]


def test_registered_answer_does_not_block_another_accounts_explicit_report(monkeypatch, marks):
    _rate(_client(monkeypatch, _Rpc(mode="registered"), user_id="user-1", anonymous=False), _IP)
    _rate(_client(monkeypatch, _Rpc(mode="registered"), user_id="user-1", anonymous=False), "198.51.100.1")
    # 표를 하나도 잡지 않았다 — 같은 IP 의 다른 계정 제보(reports.py)가 429 를 받을 일이 없다.
    assert CONGESTION_VOTES_BY_IP == {}
    assert GUEST_ANSWER_VOTES_BY_IP == {} and GUEST_ANSWER_LAST_BY_USER == {}


# ── 구 DB(마이그레이션 전) — 게스트는 닫힌 쪽으로 ──────────────────────────────────────────


def test_legacy_db_drops_guest_answer_instead_of_making_it_live(monkeypatch, marks):
    rpc = _Rpc(legacy=True)
    res = _rate(_client(monkeypatch, rpc, user_id="guest-1", anonymous=True), _IP)
    assert res.status_code == 200
    assert len(rpc.calls) == 2
    assert "p_network_hash" not in rpc.calls[1] and "p_guest_answer_live" not in rpc.calls[1]
    assert rpc.calls[1]["p_observed_congestion"] is None  # 구 트리거가 user_report 로 옮기지 못하게
    assert rpc.calls[1]["p_rating"] == "up"
    assert res.json()["crowd_answer"] == "not_recorded_pending_migration"
    assert marks == []
    assert GUEST_ANSWER_VOTES_BY_IP == {} and GUEST_ANSWER_LAST_BY_USER == {}  # 기록 안 된 답은 자리를 남기지 않는다


def test_legacy_db_keeps_registered_answer(monkeypatch, marks):
    rpc = _Rpc(legacy=True)
    res = _rate(_client(monkeypatch, rpc, user_id="user-1", anonymous=False), _IP)
    assert rpc.calls[1]["p_observed_congestion"] == "busy"
    assert res.json()["crowd_answer"] is None
    assert marks == ["congestion"]  # 구 DB 는 예전처럼 user_report 로 옮긴다
