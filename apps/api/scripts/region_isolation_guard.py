"""지역 격리 감시(region-guard) — 서울 시설이 브라우저나 옛 API 로 새어 나갈 상태면 서울 행을 끈다.

왜(SEOUL_TESTBED_PLAN §6 S3, 킬 스위치): 서울 시설은 내부(개발자) 전용이다. 격리는 두 층이다.
  · DB — 20261101090000 마이그레이션의 RESTRICTIVE 정책 · 자식 표 트리거 · 방문 확인 투영(region_isolation_status()=1).
  · API — 공개 경로를 경주로 고정한 코드(/health 의 capabilities.region_isolation ≥ 1).
누가 옛 마이그레이션을 다시 돌리거나, main·Render 를 S3 이전 커밋으로 되돌리면 한쪽이 사라진다. 이 스크립트가
30분마다(.github/workflows/region-guard.yml) 둘을 확인하고, 깨졌으면 두 가지로 막는다.
  · 봉쇄(DB 쪽이 깨졌을 때) — RPC region_guard_contain() 이 RLS 를 다시 켜고 RESTRICTIVE 정책을 마이그레이션과 같은
    정의로 되살린다. 브라우저(anon 탐침 · 관제 시설 목록)는 is_active 로 거르지 않으므로 **비활성화만으로는 브라우저
    노출이 멈추지 않는다** — 그래서 봉쇄 뒤 anon 탐침을 한 번 더 돌려, 아직 보이면 'containment_failed' 로 알린다
    (그때는 사람이 SQL Editor 에서 마이그레이션을 다시 적용해야 한다).
  · 비활성화 — 서울 행을 is_active=false 로 내린다. is_active 로 거르는 API 경로(옛 API 포함)에서 서울이 사라진다.

점검 순서:
  1) RPC region_isolation_status() — 함수나 region 컬럼이 없으면 '미적용(not_applied)'. 컬럼이 없으면 서울 행도
     있을 수 없으니 안전하다(exit 0).
  2) service_role 로 '활성 + 경주 아님' 행 수(머리 수만).
  3) 그 수가 0 보다 크면 /health 의 capabilities.region_isolation ≥ 1 이어야 한다.
  4) anon 키로 facilities?region=neq.gyeongju 를 한 행 요청 — 빈 배열이어야 한다.

판정:
  · (1)=0, (3) 실패(/health 는 응답), (4) 행 있음 → TRIP: [DB 쪽 깨짐((1)≠1 · (4))이면 봉쇄 + anon 재탐침] +
    서울 행 비활성화 + app_events 'region_guard_tripped'(숫자만) + exit 1(GitHub 실패 메일).
    Repository Variable REGION_GUARD_AUTO_DEACTIVATE=false 면 쓰기(봉쇄 포함) 없이 경보만.
  · /health 에 닿지 못함(서울 행이 있을 때만 묻는다) · 점검 자체 실패 → ALERT: 쓰기 없이 exit 1.
  · 그 밖 → OK(exit 0).

출력은 숫자·참거짓·종료 코드뿐이다(시설 id·이름·좌표·응답 본문을 찍지 않는다 — 공개 저장소의 Actions 로그).
app 패키지를 import 하지 않는다(설정 검증 없이 돌고, API 코드 버전과 무관하게 같은 판정을 하도록).

사용 예:
  python scripts/region_isolation_guard.py            # 점검 + 필요 시 비활성화
  python scripts/region_isolation_guard.py --dry-run  # 점검만(쓰기 없음)
필요 env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, BACKEND_HEALTH_URL(/health 전체 주소),
  선택 REGION_GUARD_AUTO_DEACTIVATE('false' 면 경보만).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from typing import Any

import httpx

PUBLIC_REGION = "gyeongju"
# API(WP2 app/core/region.py)의 /health 칸 이름. 이 스크립트는 app 을 import 하지 않으므로 이름을 직접 적는다.
HEALTH_CAPABILITY_PATH = ("capabilities", "region_isolation")
TRIP_EVENT = "region_guard_tripped"

OUTCOME_OK = "ok"
OUTCOME_NOT_APPLIED = "not_applied"
OUTCOME_TRIPPED = "tripped"
OUTCOME_ALERT = "alert"

REST_TIMEOUT_S = 20.0
# Render 무료 인스턴스는 잠들어 있으면 깨어나는 데 수십 초 걸린다.
HEALTH_TIMEOUT_S = 75.0
HEALTH_ATTEMPTS = 2


class GuardError(RuntimeError):
    """점검 자체가 실패했다(네트워크·권한·예상 밖 응답). 메시지에는 단계 이름과 HTTP 상태만 담는다."""


@dataclass(frozen=True)
class Action:
    outcome: str
    exit_code: int
    reasons: tuple[str, ...] = ()
    deactivate: bool = False
    record_event: bool = False
    # DB 쪽 깨짐(상태 ≠ 1 · anon 이 경주 아닌 행을 봄) — RLS·RESTRICTIVE 정책을 되살리는 RPC 를 부른다.
    contain: bool = False


# 봉쇄가 필요한 깨짐 — 브라우저에서 서울을 가리는 장치(DB 정책)가 무너진 경우. API 쪽 깨짐(api_capability_missing)은
# 비활성화가 막는다(그 API 는 is_active 로 거른다).
DB_SIDE_TRIPS = frozenset({
    "db_isolation_incomplete",
    "anon_sees_nonpublic_rows",
    "isolation_marker_missing_with_nonpublic_rows",
})
CONTAIN_RPC = "region_guard_contain"


@dataclass
class Report:
    outcome: str
    exit_code: int
    reasons: list[str] = field(default_factory=list)
    status: int | None = None
    active_nonpublic: int | None = None
    health_reachable: bool | None = None
    health_capability: int | None = None
    anon_rows: int | None = None
    auto_deactivate: bool = True
    deactivated: int = 0
    contained_status: int | None = None
    anon_rows_after: int | None = None
    event_recorded: bool = False
    error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "outcome": self.outcome,
            "exit_code": self.exit_code,
            "reasons": list(self.reasons),
            "status": self.status,
            "active_nonpublic": self.active_nonpublic,
            "health_reachable": self.health_reachable,
            "health_capability": self.health_capability,
            "anon_rows": self.anon_rows,
            "auto_deactivate": self.auto_deactivate,
            "deactivated": self.deactivated,
            "contained_status": self.contained_status,
            "anon_rows_after": self.anon_rows_after,
            "event_recorded": self.event_recorded,
            "error": self.error,
        }


def decide(
    status: int | None,
    active_nonpublic: int | None,
    health_capability: int | None,
    health_reachable: bool,
    anon_rows: int | None,
    *,
    auto_deactivate: bool = True,
) -> Action:
    """순수 판정. I/O 없음.

    status            region_isolation_status() 값. None = 함수나 region 컬럼이 없음(마이그레이션 미적용).
    active_nonpublic  활성 + 경주 아님 행 수. None = region 컬럼이 없음(그러면 그런 행도 있을 수 없다).
    health_capability /health 의 capabilities.region_isolation. None = 칸이 없음(S3 이전 API).
    health_reachable  /health 에 닿았는가(2xx JSON).
    anon_rows         anon 키로 본 경주 아닌 행 수(0 또는 1). None = 탐침 실패.
    """
    active = active_nonpublic or 0
    trips: list[str] = []
    alerts: list[str] = []

    if anon_rows is None:
        alerts.append("anon_probe_failed")
    elif anon_rows > 0:
        trips.append("anon_sees_nonpublic_rows")

    if status is None:
        if active > 0:
            trips.append("isolation_marker_missing_with_nonpublic_rows")
    elif status != 1:
        trips.append("db_isolation_incomplete")

    if active > 0:
        if not health_reachable:
            alerts.append("health_unreachable")
        elif health_capability is None or health_capability < 1:
            trips.append("api_capability_missing")

    if trips:
        do_writes = auto_deactivate
        return Action(
            outcome=OUTCOME_TRIPPED,
            exit_code=1,
            reasons=tuple(trips + alerts),
            deactivate=do_writes and active > 0,
            record_event=do_writes,
            contain=do_writes and any(reason in DB_SIDE_TRIPS for reason in trips),
        )
    if alerts:
        return Action(outcome=OUTCOME_ALERT, exit_code=1, reasons=tuple(alerts))
    if status is None:
        return Action(outcome=OUTCOME_NOT_APPLIED, exit_code=0)
    return Action(outcome=OUTCOME_OK, exit_code=0)


# ── I/O (httpx 로 PostgREST · /health 를 직접 부른다) ──────────────────────────────────────────


def _headers(key: str, **extra: str) -> dict[str, str]:
    return {"apikey": key, "Authorization": f"Bearer {key}", **extra}


def _error_code(resp: httpx.Response) -> str | None:
    try:
        body = resp.json()
    except ValueError:
        return None
    if isinstance(body, dict):
        code = body.get("code")
        return str(code) if code is not None else None
    return None


def _is_missing_region_column(resp: httpx.Response) -> bool:
    if resp.status_code != 400 or _error_code(resp) != "42703":
        return False
    try:
        message = str(resp.json().get("message", ""))
    except (ValueError, AttributeError):
        return False
    return "region" in message


def _range_total(resp: httpx.Response) -> int:
    """Content-Range '0-0/12' · '*/0' 의 전체 수."""
    content_range = resp.headers.get("content-range", "")
    total = content_range.rsplit("/", 1)[-1] if "/" in content_range else ""
    if not total.isdigit():
        raise GuardError(f"count_without_total status={resp.status_code}")
    return int(total)


def fetch_status(client: httpx.Client, rest: str, service_key: str) -> int | None:
    resp = client.post(f"{rest}/rpc/region_isolation_status", headers=_headers(service_key), json={})
    if resp.status_code == 200:
        try:
            return int(resp.json())
        except (TypeError, ValueError) as exc:
            raise GuardError("status_not_integer") from exc
    # PGRST202 = 함수 없음(스키마 캐시), 42883 = 함수 없음(DB). 마이그레이션 미적용.
    if resp.status_code in (400, 404) and _error_code(resp) in ("PGRST202", "42883"):
        return None
    raise GuardError(f"status_rpc_failed status={resp.status_code}")


def count_active_nonpublic(client: httpx.Client, rest: str, service_key: str) -> int | None:
    resp = client.get(
        f"{rest}/facilities",
        params={"select": "id", "region": f"neq.{PUBLIC_REGION}", "is_active": "is.true", "limit": "1"},
        headers=_headers(service_key, Prefer="count=exact"),
    )
    if _is_missing_region_column(resp):
        return None
    if resp.status_code not in (200, 206):
        raise GuardError(f"count_failed status={resp.status_code}")
    return _range_total(resp)


def probe_anon(client: httpx.Client, rest: str, anon_key: str) -> int | None:
    """anon 키로 경주 아닌 행을 한 행만 요청한다. 행 내용은 보지 않고 개수만 센다."""
    try:
        resp = client.get(
            f"{rest}/facilities",
            params={"select": "id", "region": f"neq.{PUBLIC_REGION}", "limit": "1"},
            headers=_headers(anon_key),
        )
    except httpx.HTTPError:
        return None
    if _is_missing_region_column(resp):
        return 0  # 컬럼이 없으면 경주 아닌 행도 없다
    if resp.status_code != 200:
        return None
    try:
        rows = resp.json()
    except ValueError:
        return None
    return len(rows) if isinstance(rows, list) else None


def fetch_health_capability(client: httpx.Client, health_url: str) -> tuple[bool, int | None]:
    """(닿았는가, capabilities.region_isolation). 2xx JSON 객체가 아니면 닿지 않은 것으로 본다."""
    if not health_url:
        return False, None
    for _ in range(HEALTH_ATTEMPTS):
        try:
            resp = client.get(health_url, timeout=HEALTH_TIMEOUT_S)
        except httpx.HTTPError:
            continue
        if not 200 <= resp.status_code < 300:
            continue
        try:
            body = resp.json()
        except ValueError:
            continue
        if not isinstance(body, dict):
            continue
        value: Any = body
        for key in HEALTH_CAPABILITY_PATH:
            value = value.get(key) if isinstance(value, dict) else None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return True, None
        return True, int(value)
    return False, None


def contain_db(client: httpx.Client, rest: str, service_key: str) -> int | None:
    """RPC region_guard_contain() — RLS·RESTRICTIVE 정책을 되살리고 그 뒤의 격리 상태를 돌려준다.

    None = 함수가 없다(마이그레이션 미적용 또는 지워짐) — 감시가 고칠 수 없으니 사람 몫이다.
    """
    resp = client.post(f"{rest}/rpc/{CONTAIN_RPC}", headers=_headers(service_key), json={})
    if resp.status_code == 200:
        try:
            return int(resp.json())
        except (TypeError, ValueError) as exc:
            raise GuardError("contain_not_integer") from exc
    if resp.status_code in (400, 404) and _error_code(resp) in ("PGRST202", "42883"):
        return None
    raise GuardError(f"contain_rpc_failed status={resp.status_code}")


def deactivate_nonpublic(client: httpx.Client, rest: str, service_key: str) -> int:
    resp = client.patch(
        f"{rest}/facilities",
        params={"region": f"neq.{PUBLIC_REGION}", "is_active": "is.true"},
        headers=_headers(service_key, Prefer="return=minimal,count=exact"),
        json={"is_active": False},
    )
    if resp.status_code not in (200, 204):
        raise GuardError(f"deactivate_failed status={resp.status_code}")
    try:
        return _range_total(resp)
    except GuardError:
        return 0


def record_trip_event(client: httpx.Client, rest: str, service_key: str, props: dict[str, Any]) -> bool:
    resp = client.post(
        f"{rest}/app_events",
        headers=_headers(service_key, Prefer="return=minimal"),
        json={"event": TRIP_EVENT, "props": props},
    )
    return resp.status_code in (200, 201, 204)


# ── 실행 ────────────────────────────────────────────────────────────────────────────────


def _auto_deactivate_enabled(env: dict[str, str]) -> bool:
    return (env.get("REGION_GUARD_AUTO_DEACTIVATE") or "").strip().lower() != "false"


def run(env: dict[str, str], client: httpx.Client, *, dry_run: bool = False) -> Report:
    auto = _auto_deactivate_enabled(env) and not dry_run
    url = (env.get("SUPABASE_URL") or "").strip().rstrip("/")
    anon_key = (env.get("SUPABASE_ANON_KEY") or "").strip()
    service_key = (env.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    health_url = (env.get("BACKEND_HEALTH_URL") or "").strip()
    if not (url and anon_key and service_key):
        return Report(OUTCOME_ALERT, 1, ["config_missing"], auto_deactivate=auto)
    rest = f"{url}/rest/v1"

    report = Report(OUTCOME_ALERT, 1, auto_deactivate=auto)
    try:
        report.status = fetch_status(client, rest, service_key)
        report.active_nonpublic = count_active_nonpublic(client, rest, service_key)
    except (GuardError, httpx.HTTPError) as exc:
        report.reasons = ["check_failed"]
        report.error = str(exc) if isinstance(exc, GuardError) else type(exc).__name__
        return report

    if (report.active_nonpublic or 0) > 0:
        report.health_reachable, report.health_capability = fetch_health_capability(client, health_url)
    report.anon_rows = probe_anon(client, rest, anon_key)

    action = decide(
        report.status,
        report.active_nonpublic,
        report.health_capability,
        bool(report.health_reachable),
        report.anon_rows,
        auto_deactivate=auto,
    )
    report.outcome = action.outcome
    report.exit_code = action.exit_code
    report.reasons = list(action.reasons)

    if action.contain:
        # 브라우저 노출부터 막는다. 봉쇄가 실패해도 아래 비활성화·기록은 그대로 한다(따로 잡는다).
        try:
            report.contained_status = contain_db(client, rest, service_key)
            if report.contained_status is None:
                report.reasons.append("containment_unavailable")
        except (GuardError, httpx.HTTPError) as exc:
            report.reasons.append("containment_rpc_failed")
            report.error = str(exc) if isinstance(exc, GuardError) else type(exc).__name__
        # 봉쇄 뒤 anon 탐침을 다시 돌려 실제로 가려졌는지 본다. 아직 보이면(또는 탐침 실패) 사람이 고쳐야 한다.
        report.anon_rows_after = probe_anon(client, rest, anon_key)
        if report.anon_rows_after != 0:
            report.reasons.append("containment_failed")

    try:
        if action.deactivate:
            report.deactivated = deactivate_nonpublic(client, rest, service_key)
        if action.record_event:
            report.event_recorded = record_trip_event(
                client,
                rest,
                service_key,
                {
                    "reasons": report.reasons,
                    "status": report.status,
                    "active_nonpublic": report.active_nonpublic,
                    "health_capability": report.health_capability,
                    "anon_rows": report.anon_rows,
                    "deactivated": report.deactivated,
                    "contained_status": report.contained_status,
                    "anon_rows_after": report.anon_rows_after,
                },
            )
    except (GuardError, httpx.HTTPError) as exc:
        report.reasons.append("trip_write_failed")
        report.error = str(exc) if isinstance(exc, GuardError) else type(exc).__name__
        report.exit_code = 1
    return report


def _summary_line(report: Report) -> str:
    head = {
        OUTCOME_OK: "지역 격리 정상",
        OUTCOME_NOT_APPLIED: "지역 격리 마이그레이션 미적용(경주 아닌 행 없음 — 안전)",
        OUTCOME_TRIPPED: "**지역 격리 깨짐 — TRIP**",
        OUTCOME_ALERT: "**지역 격리 점검 경보**",
    }[report.outcome]
    parts = [
        f"reasons={','.join(report.reasons) or '-'}",
        f"status={report.status}",
        f"active_nonpublic={report.active_nonpublic}",
        f"health_capability={report.health_capability}",
        f"anon_rows={report.anon_rows}",
        f"deactivated={report.deactivated}",
        f"contained_status={report.contained_status}",
        f"anon_rows_after={report.anon_rows_after}",
        f"auto_deactivate={str(report.auto_deactivate).lower()}",
        f"exit={report.exit_code}",
    ]
    return f"{head} — " + " ".join(parts)


def _write_step_summary(line: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="서울 지역 격리 감시(킬 스위치)")
    parser.add_argument("--dry-run", action="store_true", help="점검만 하고 쓰지 않는다")
    args = parser.parse_args(argv)
    with httpx.Client(timeout=REST_TIMEOUT_S) as client:
        report = run(dict(os.environ), client, dry_run=args.dry_run)
    print(json.dumps(report.as_dict(), ensure_ascii=False, sort_keys=True))
    line = _summary_line(report)
    print(line)
    _write_step_summary(line)
    return report.exit_code


if __name__ == "__main__":
    sys.exit(main())
