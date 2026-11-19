"""scripts/region_isolation_guard.py — 지역 격리 킬 스위치(SEOUL_TESTBED_PLAN §6 S3).

순수 판정(decide) 표 + httpx.MockTransport 로 PostgREST · /health 를 흉내 낸 실행(run). 실제 네트워크는 쓰지 않는다.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import httpx
import pytest

import scripts.region_isolation_guard as guard

ROOT = Path(__file__).resolve().parents[4]
WORKFLOW = ROOT / ".github/workflows/region-guard.yml"

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
COORD_RE = re.compile(r"\b(?:3[5-8]|12[6-9])\.\d{3,}")
SEOUL_ROW_ID = "11111111-2222-3333-4444-555555555555"

ENV = {
    "SUPABASE_URL": "https://example.supabase.co",
    "SUPABASE_ANON_KEY": "anon-placeholder",
    "SUPABASE_SERVICE_ROLE_KEY": "service-placeholder",
    "BACKEND_HEALTH_URL": "https://api.example.test/health",
}


# ── decide() 표 ─────────────────────────────────────────────────────────────────────────


def test_status_zero_trips():
    action = guard.decide(0, 0, None, True, 0)
    assert action.outcome == guard.OUTCOME_TRIPPED and action.exit_code == 1
    assert "db_isolation_incomplete" in action.reasons
    assert action.record_event is True
    assert action.deactivate is False  # 끌 행이 없다


def test_status_zero_with_seoul_rows_trips_and_deactivates():
    action = guard.decide(0, 3, 1, True, 0)
    assert action.outcome == guard.OUTCOME_TRIPPED
    assert action.deactivate is True and action.record_event is True


def test_active_seoul_rows_with_missing_capability_trips_and_deactivates():
    action = guard.decide(1, 5, None, True, 0)
    assert action.outcome == guard.OUTCOME_TRIPPED and action.exit_code == 1
    assert action.reasons == ("api_capability_missing",)
    assert action.deactivate is True and action.record_event is True


def test_old_capability_value_counts_as_missing():
    assert guard.decide(1, 5, 0, True, 0).outcome == guard.OUTCOME_TRIPPED


def test_health_unreachable_alerts_without_writes():
    action = guard.decide(1, 5, None, False, 0)
    assert action.outcome == guard.OUTCOME_ALERT and action.exit_code == 1
    assert action.reasons == ("health_unreachable",)
    assert action.deactivate is False and action.record_event is False


def test_anon_rows_trip():
    action = guard.decide(1, 0, None, False, 1)
    assert action.outcome == guard.OUTCOME_TRIPPED
    assert "anon_sees_nonpublic_rows" in action.reasons
    assert action.record_event is True


def test_column_missing_is_not_applied_and_exits_zero():
    action = guard.decide(None, None, None, False, 0)
    assert action.outcome == guard.OUTCOME_NOT_APPLIED and action.exit_code == 0
    assert action.deactivate is False and action.record_event is False


def test_marker_missing_but_seoul_rows_present_trips():
    action = guard.decide(None, 2, 1, True, 0)
    assert action.outcome == guard.OUTCOME_TRIPPED
    assert "isolation_marker_missing_with_nonpublic_rows" in action.reasons


def test_auto_deactivate_false_means_no_writes():
    action = guard.decide(0, 5, None, True, 1, auto_deactivate=False)
    assert action.outcome == guard.OUTCOME_TRIPPED and action.exit_code == 1
    assert action.deactivate is False and action.record_event is False


def test_healthy_states_exit_zero():
    assert guard.decide(1, 0, None, False, 0) == guard.Action(guard.OUTCOME_OK, 0)  # 서울 행 없으면 /health 안 묻는다
    assert guard.decide(1, 7, 1, True, 0) == guard.Action(guard.OUTCOME_OK, 0)
    assert guard.decide(1, 7, 2, True, 0).outcome == guard.OUTCOME_OK


def test_anon_probe_failure_alerts():
    action = guard.decide(1, 0, None, False, None)
    assert action.outcome == guard.OUTCOME_ALERT and action.reasons == ("anon_probe_failed",)


def test_db_side_trip_without_active_rows_still_contains():
    """비활성화할 행이 없어도(이미 꺼졌어도) 브라우저는 is_active 로 거르지 않는다 — 봉쇄가 있어야 한다."""
    action = guard.decide(0, 0, 1, True, 1)
    assert action.outcome == guard.OUTCOME_TRIPPED
    assert action.deactivate is False
    assert action.contain is True


def test_api_side_trip_does_not_contain():
    action = guard.decide(1, 5, None, True, 0)
    assert action.deactivate is True and action.contain is False


def test_auto_deactivate_false_does_not_contain():
    assert guard.decide(0, 5, None, True, 1, auto_deactivate=False).contain is False


# ── run() — PostgREST · /health 흉내 ──────────────────────────────────────────────────────


class FakeBackend:
    def __init__(
        self,
        *,
        status: int | None = 1,
        column: bool = True,
        active: int = 0,
        anon_rows: int = 0,
        health: object = None,
        health_status: int = 200,
        contain: str = "works",
    ):
        self.status = status
        self.column = column
        self.active = active
        self.anon_rows = anon_rows
        self.health = health if health is not None else {"status": "healthy", "capabilities": {"region_isolation": 1}}
        self.health_status = health_status
        self.writes: list[tuple[str, str]] = []
        self.health_calls = 0
        # 봉쇄 RPC 흉내 — works: 정책을 되살려 anon 이 더는 못 본다 · noop: 불렸지만 여전히 보인다 · missing: 함수 없음.
        self.contain = contain

    def _missing_column(self) -> httpx.Response:
        return httpx.Response(400, json={"code": "42703", "message": "column facilities.region does not exist"})

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.host == "api.example.test":
            self.health_calls += 1
            if self.health_status == 0:
                raise httpx.ConnectError("down", request=request)
            return httpx.Response(self.health_status, json=self.health)
        path = url.path
        is_service = request.headers.get("apikey") == ENV["SUPABASE_SERVICE_ROLE_KEY"]
        if path.endswith("/rpc/region_isolation_status"):
            if self.status is None:
                return httpx.Response(404, json={"code": "PGRST202", "message": "Could not find the function"})
            return httpx.Response(200, json=self.status)
        if path.endswith("/rpc/region_guard_contain"):
            assert is_service and request.method == "POST"
            self.writes.append(("RPC", "region_guard_contain"))
            if self.contain == "missing":
                return httpx.Response(404, json={"code": "PGRST202", "message": "Could not find the function"})
            if self.contain == "works":
                self.anon_rows = 0
                self.status = 1
            return httpx.Response(200, json=self.status)
        if path.endswith("/facilities") and request.method == "GET":
            if not self.column:
                return self._missing_column()
            if is_service:
                return httpx.Response(
                    200,
                    json=[{"id": SEOUL_ROW_ID}] if self.active else [],
                    headers={"content-range": f"0-0/{self.active}" if self.active else "*/0"},
                )
            rows = [{"id": SEOUL_ROW_ID, "latitude": 37.573863, "longitude": 126.986063}][: self.anon_rows]
            return httpx.Response(200, json=rows)
        if path.endswith("/facilities") and request.method == "PATCH":
            assert is_service
            assert url.params["region"] == "neq.gyeongju" and url.params["is_active"] == "is.true"
            assert json.loads(request.content) == {"is_active": False}
            self.writes.append(("PATCH", "facilities"))
            return httpx.Response(204, headers={"content-range": f"*/{self.active}"})
        if path.endswith("/app_events") and request.method == "POST":
            assert is_service
            body = json.loads(request.content)
            assert body["event"] == "region_guard_tripped"
            self.writes.append(("POST", "app_events"))
            return httpx.Response(201)
        raise AssertionError(f"unexpected request {request.method} {path}")

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler))


def _run(backend: FakeBackend, env: dict | None = None, **kwargs) -> guard.Report:
    with backend.client() as client:
        return guard.run({**ENV, **(env or {})}, client, **kwargs)


def test_run_ok_without_seoul_rows_skips_health():
    backend = FakeBackend(status=1, active=0)
    report = _run(backend)
    assert report.outcome == guard.OUTCOME_OK and report.exit_code == 0
    assert backend.health_calls == 0 and backend.writes == []


def test_run_not_applied_when_column_and_function_missing():
    backend = FakeBackend(status=None, column=False)
    report = _run(backend)
    assert report.outcome == guard.OUTCOME_NOT_APPLIED and report.exit_code == 0
    assert report.active_nonpublic is None and report.anon_rows == 0
    assert backend.writes == []


def test_run_trips_and_deactivates_when_api_capability_missing():
    backend = FakeBackend(status=1, active=4, health={"status": "healthy"})
    report = _run(backend)
    assert report.outcome == guard.OUTCOME_TRIPPED and report.exit_code == 1
    assert report.deactivated == 4 and report.event_recorded is True
    assert backend.writes == [("PATCH", "facilities"), ("POST", "app_events")]


def test_run_trips_when_db_status_zero():
    backend = FakeBackend(status=0, active=2)
    report = _run(backend)
    assert report.outcome == guard.OUTCOME_TRIPPED
    assert ("PATCH", "facilities") in backend.writes


def test_run_trips_on_anon_rows():
    backend = FakeBackend(status=1, active=1, anon_rows=1)
    report = _run(backend)
    assert report.outcome == guard.OUTCOME_TRIPPED and "anon_sees_nonpublic_rows" in report.reasons


def test_run_contains_db_side_trip_and_reprobes_anon():
    """상태 0 + anon 이 서울 행을 보고, 서울 행은 이미 비활성(끌 것 없음) — 봉쇄 뒤 anon 이 0 이어야 한다."""
    backend = FakeBackend(status=0, active=0, anon_rows=1)
    report = _run(backend)
    assert report.outcome == guard.OUTCOME_TRIPPED and report.exit_code == 1
    assert ("RPC", "region_guard_contain") in backend.writes
    assert ("PATCH", "facilities") not in backend.writes
    assert report.contained_status == 1 and report.anon_rows_after == 0
    assert "containment_failed" not in report.reasons
    # 봉쇄가 비활성화·기록보다 먼저다.
    assert backend.writes == [("RPC", "region_guard_contain"), ("POST", "app_events")]


def test_run_reports_containment_failure_when_anon_still_sees_rows():
    backend = FakeBackend(status=0, active=2, anon_rows=1, contain="noop")
    report = _run(backend)
    assert report.outcome == guard.OUTCOME_TRIPPED and report.exit_code == 1
    assert report.anon_rows_after == 1 and "containment_failed" in report.reasons
    assert ("PATCH", "facilities") in backend.writes  # 비활성화는 그래도 한다


def test_run_reports_missing_containment_rpc_and_still_deactivates():
    backend = FakeBackend(status=0, active=2, anon_rows=1, contain="missing")
    report = _run(backend)
    assert report.contained_status is None
    assert "containment_unavailable" in report.reasons and "containment_failed" in report.reasons
    assert ("PATCH", "facilities") in backend.writes and ("POST", "app_events") in backend.writes


def test_run_api_side_trip_does_not_call_containment():
    backend = FakeBackend(status=1, active=4, health={"status": "healthy"})
    _run(backend)
    assert ("RPC", "region_guard_contain") not in backend.writes


def test_run_alerts_without_writes_when_health_unreachable():
    backend = FakeBackend(status=1, active=3, health_status=0)
    report = _run(backend)
    assert report.outcome == guard.OUTCOME_ALERT and report.exit_code == 1
    assert backend.writes == []
    assert backend.health_calls == guard.HEALTH_ATTEMPTS


def test_run_treats_health_5xx_as_unreachable():
    backend = FakeBackend(status=1, active=3, health_status=503)
    assert _run(backend).outcome == guard.OUTCOME_ALERT
    assert backend.writes == []


@pytest.mark.parametrize("value", ["false", "FALSE", " false "])
def test_run_auto_deactivate_false_makes_no_writes(value):
    backend = FakeBackend(status=0, active=4, anon_rows=1)
    report = _run(backend, {"REGION_GUARD_AUTO_DEACTIVATE": value})
    assert report.outcome == guard.OUTCOME_TRIPPED and report.exit_code == 1
    assert report.auto_deactivate is False
    assert backend.writes == []


def test_run_dry_run_makes_no_writes():
    backend = FakeBackend(status=0, active=4)
    report = _run(backend, dry_run=True)
    assert report.outcome == guard.OUTCOME_TRIPPED and backend.writes == []


def test_run_alerts_on_missing_config_and_rpc_failure():
    report = _run(FakeBackend(), {"SUPABASE_SERVICE_ROLE_KEY": ""})
    assert report.outcome == guard.OUTCOME_ALERT and report.reasons == ["config_missing"]

    class Broken(FakeBackend):
        def handler(self, request):
            if request.url.path.endswith("/rpc/region_isolation_status"):
                return httpx.Response(500, json={"message": "boom"})
            return super().handler(request)

    broken = Broken()
    report = _run(broken)
    assert report.outcome == guard.OUTCOME_ALERT and report.exit_code == 1
    assert report.reasons == ["check_failed"] and broken.writes == []


def test_output_is_aggregate_only(monkeypatch, capsys, tmp_path):
    """로그·Summary 에 시설 id(uuid)·좌표가 나오지 않는다 — 응답 본문에 둘 다 있어도."""
    backend = FakeBackend(status=1, active=4, anon_rows=1, health={"status": "healthy"})
    mock_client = backend.client()  # 바꿔치기 전에 만든다(guard.httpx 는 같은 httpx 모듈이다)
    monkeypatch.setattr(guard.httpx, "Client", lambda **_kw: mock_client)
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("REGION_GUARD_AUTO_DEACTIVATE", raising=False)
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))

    exit_code = guard.main([])

    out = capsys.readouterr().out + summary.read_text(encoding="utf-8")
    assert exit_code == 1
    assert "tripped" in out
    assert not UUID_RE.search(out), out
    assert not COORD_RE.search(out), out
    assert "anon-placeholder" not in out and "service-placeholder" not in out
    payload = json.loads(out.splitlines()[0])
    assert payload["deactivated"] == 4 and payload["outcome"] == "tripped"


def test_capability_field_name_is_hardcoded():
    assert guard.HEALTH_CAPABILITY_PATH == ("capabilities", "region_isolation")
    source = (ROOT / "apps/api/scripts/region_isolation_guard.py").read_text(encoding="utf-8")
    assert "from app" not in source and "import app" not in source


# ── 워크플로 ─────────────────────────────────────────────────────────────────────────────


def test_workflow_text_contract():
    """PyYAML 없이도 도는 글자 계약(CI 의 requirements-dev 에 PyYAML 이 없다)."""
    text = WORKFLOW.read_text(encoding="utf-8")
    assert "- cron: '*/30 * * * *'" in text
    assert "workflow_dispatch:" in text
    assert "group: region-guard" in text
    assert "timeout-minutes: 10" in text
    secrets = set(re.findall(r"secrets\.([A-Z0-9_]+)", text))
    assert secrets == {"SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"}
    variables = set(re.findall(r"vars\.([A-Z0-9_]+)", text))
    assert variables == {"BACKEND_HEALTH_URL", "REGION_GUARD_AUTO_DEACTIVATE"}


def test_workflow_schedule_and_secrets():
    yaml = pytest.importorskip("yaml")
    text = WORKFLOW.read_text(encoding="utf-8")
    doc = yaml.safe_load(text)
    triggers = doc.get("on", doc.get(True))  # PyYAML 은 'on' 키를 True 로 읽는다
    assert triggers["schedule"] == [{"cron": "*/30 * * * *"}]
    assert "workflow_dispatch" in triggers
    assert doc["concurrency"]["group"] == "region-guard"
    job = next(iter(doc["jobs"].values()))
    assert job["timeout-minutes"] == 10
    secrets = set(re.findall(r"secrets\.([A-Z0-9_]+)", text))
    assert secrets == {"SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"}
    variables = set(re.findall(r"vars\.([A-Z0-9_]+)", text))
    assert variables == {"BACKEND_HEALTH_URL", "REGION_GUARD_AUTO_DEACTIVATE"}
    assert "scripts/region_isolation_guard.py" in text
    assert doc["permissions"] == {"contents": "read"}
