"""관리자 GET /api/v1/admin/metrics/guest-answers — 게스트 체감 혼잡 그림자 모드 측정(D3)."""
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.routers.admin import build_guest_answer_shadow_metrics
from tests.conftest import make_test_jwt
from tests.routers.test_routers import _admin_headers

_PATH = "/api/v1/admin/metrics/guest-answers"


def _raw(*, guest=40, comparable=35, agree=28, with_network=40, shared=6, clustered=2):
    return {
        "days": 14,
        "since": "2026-10-17T00:00:00+00:00",
        "answers": {"registered": 50, "guest_shadow": guest, "guest_live": 0},
        "guest_accounts": 31,
        "agreement": {
            "guest_vs_registered": {"comparable": comparable, "agree": agree},
            "guest_vs_measured": {"comparable": 3, "agree": 2},
            "registered_vs_registered": {"comparable": 40, "agree": 33},
            "registered_vs_measured": {"comparable": 2, "agree": 2},
        },
        "networks": {
            "guest_answers_with_network": with_network,
            "distinct_networks": 30,
            "answers_from_shared_networks": shared,
            "same_place_cluster_answers": clustered,
        },
    }


def test_rates_only_when_sample_is_large_enough():
    m = build_guest_answer_shadow_metrics(_raw(), days=14, live=False)
    assert m.sample_status == "ok"
    assert m.agreement.guest_vs_registered.rate == 0.8
    assert m.agreement.guest_vs_measured.rate is None  # 3건 — 표본 부족
    assert m.agreement.registered_vs_registered.rate == 0.825
    assert m.networks.shared_network_share == 0.15
    assert m.networks.same_place_cluster_share == 0.05
    assert m.live is False and m.min_sample == 30


def test_insufficient_sample_is_said_out_loud():
    m = build_guest_answer_shadow_metrics(_raw(guest=4, comparable=2, agree=2, with_network=4), days=14, live=False)
    assert m.sample_status == "insufficient"
    assert m.agreement.guest_vs_registered.rate is None
    assert m.networks.shared_network_share is None
    assert any("일치율을 내지 않습니다" in n for n in m.notes)
    assert any("겹침 비율을 내지 않습니다" in n for n in m.notes)


def test_empty_db_payload_is_zeroes_not_errors():
    m = build_guest_answer_shadow_metrics({}, days=7, live=True)
    assert m.days == 7 and m.answers.guest_shadow == 0 and m.sample_status == "insufficient"
    assert any("게스트 답이 없습니다" in n for n in m.notes)


class _Rpc:
    def __init__(self, data=None, fail=False):
        self.data, self.fail, self.calls = data, fail, []

    def rpc(self, name, payload):
        self.calls.append((name, payload))
        return self

    def execute(self):
        if self.fail:
            raise RuntimeError("function does not exist")
        return SimpleNamespace(data=self.data)


def test_endpoint_is_admin_only_and_clamps_days():
    fake = _Rpc(data=_raw())
    with TestClient(app) as c, patch("app.routers.admin.supabase_admin", new=fake):
        ok = c.get(_PATH, params={"days": 99}, headers=_admin_headers())
        tourist = c.get(_PATH, headers={"Authorization": f"Bearer {make_test_jwt('tourist-x')}"})
    assert ok.status_code == 200
    assert fake.calls == [("guest_crowd_answer_shadow_metrics", {"p_days": 30})]
    assert ok.json()["agreement"]["guest_vs_registered"]["rate"] == 0.8
    assert tourist.status_code == 403


def test_endpoint_reports_503_when_function_missing():
    with TestClient(app) as c, patch("app.routers.admin.supabase_admin", new=_Rpc(fail=True)):
        res = c.get(_PATH, headers=_admin_headers())
    assert res.status_code == 503
