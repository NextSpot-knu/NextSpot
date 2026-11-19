"""S4 분산 결정 재생 — 반출 SQL 인쇄(`sql`)와 오프라인 재생(`run`).

`docs/SEOUL_TESTBED_PLAN.md` §4(V3) · §6 S4. 운영 DB 는 **읽기 전용**이고 이 스크립트는 DB·네트워크를 쓰지 않는다.

  1) SQL 인쇄(사람이 Supabase SQL Editor 에서 실행 — 결과 한도 'No limit', 바닥 행 수를 Q0 와 대조):
       .venv/Scripts/python scripts/crowd_dispersion_replay.py sql --cluster hongdae --from 2026-09-20 [--to 2026-11-01]
         [--site 연남동] [--chunk-days 10]
     --to 는 기본이 오늘 KST 자정(그날 0시, 배타)이고 그보다 늦으면 거부한다(쓰이고 있는 날의 행은 Q0 와 어긋난다).
  2) 받은 CSV(counts.csv · obs_*.csv · fcst_*.csv · 선택 counts_replaced.csv + replaced_*.csv)를 저장소 밖 폴더에 두고:
       .venv/Scripts/python scripts/crowd_dispersion_replay.py run --cluster hongdae --data-dir ~/nextspot-s4/hongdae --label pilot
     종로(나중): --cluster jongno --label confirmatory --expect-criteria <SEOUL_TESTBED_PLAN 에 고정한 해시>

산출(<data-dir>/out 기본): <cluster>_replay_report.json · <cluster>_replay_summary.md ·
decision_quality/<cluster>.json · (--trace) <cluster>_decisions_trace.csv — 추적 CSV 와 원본 CSV 는 커밋하지 않는다.

종료 코드: 0 성공 · 2 입력/설정 오류(문제 전부 출력 — CSV 로 읽을 수 없는 파일도) · 3 경로 가드 ·
4 기준 해시 불일치 · 확인 실행에 덮어쓰기 · 커밋하지 않은 재생·엔진 소스(apps/api/app)나 --no-sensitivity 로 확인 실행.

오프라인 보장: ``main`` 은 앱을 import 하기 **전에** Supabase·JWT·관리 토큰을 닿을 수 없는 자리표시자로 **강제**하고
(프로세스 환경이 apps/api/.env 를 이긴다 — 실제 키가 있는 기기에서도 쓰이지 않는다) LLM 을 끄며, 소켓 연결·이름 해석을
막는 가드를 건다(루프백 리터럴만 허용 — Windows 이벤트 루프가 자기 파이프에 쓴다). 끝나면 둘 다 되돌린다.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import ipaddress
import json
import os
import socket
import subprocess
import sys
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Sequence

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

KST = timezone(timedelta(hours=9))
EXIT_OK, EXIT_INPUT, EXIT_PATH, EXIT_CRITERIA = 0, 2, 3, 4

OFFLINE_ENV: dict[str, str] = {
    "SUPABASE_URL": "https://replay-offline.invalid",
    "SUPABASE_ANON_KEY": "replay-offline-anon",
    "SUPABASE_SERVICE_ROLE_KEY": "replay-offline-service-role",
    "JWT_SECRET": "replay-offline-jwt-secret-at-least-32-bytes",
    "ADMIN_API_TOKEN": "replay-offline-admin",
    "LLM_ENABLED": "false",
    "AREA_DEMAND_SOURCE": "rpc",
    "UPSTAGE_API_KEY": "",
    "TOURAPI_KEY": "",
    "SEOUL_OPENDATA_KEY": "",
}


# ── 오프라인 가드 ─────────────────────────────────────────────────────────────


class ReplayNetworkBlocked(RuntimeError):
    """재생 중 네트워크 접근 시도."""


# 마지막 main 실행에서 막힌 시도(테스트가 '시도 0회' 를 확인한다).
LAST_NETWORK_ATTEMPTS: list[str] = []


def _force_offline_env() -> dict[str, str | None]:
    previous = {key: os.environ.get(key) for key in OFFLINE_ENV}
    for key, value in OFFLINE_ENV.items():
        os.environ[key] = value  # setdefault 가 아니다 — 실제 키가 있어도 덮는다
    return previous


def _restore_env(previous: dict[str, str | None]) -> None:
    for key, value in previous.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def _is_loopback_literal(host: Any) -> bool:
    try:
        return ipaddress.ip_address(str(host).split("%", 1)[0]).is_loopback
    except ValueError:
        return False


@contextmanager
def network_guard(attempts: list[str] | None = None) -> Iterator[list[str]]:
    """소켓 연결·create_connection·getaddrinfo 를 막는다. 루프백 리터럴(127.0.0.0/8, ::1)만 통과."""
    record = attempts if attempts is not None else []
    original = (socket.socket.connect, socket.socket.connect_ex, socket.create_connection, socket.getaddrinfo)

    def _host_of(address: Any) -> Any:
        return address[0] if isinstance(address, tuple) and address else address

    def _check(host: Any, what: str) -> None:
        if not _is_loopback_literal(host):
            record.append(f"{what}:{host}")
            raise ReplayNetworkBlocked(f"재생은 네트워크를 쓰지 않는다 — {what} {host!r} 차단")

    def connect(self, address):  # noqa: ANN001
        _check(_host_of(address), "connect")
        return original[0](self, address)

    def connect_ex(self, address):  # noqa: ANN001
        _check(_host_of(address), "connect_ex")
        return original[1](self, address)

    def create_connection(address, *args, **kwargs):  # noqa: ANN001
        _check(_host_of(address), "create_connection")
        return original[2](address, *args, **kwargs)

    def getaddrinfo(host, *args, **kwargs):  # noqa: ANN001
        if host is not None:
            _check(host, "getaddrinfo")
        return original[3](host, *args, **kwargs)

    socket.socket.connect = connect  # type: ignore[method-assign]
    socket.socket.connect_ex = connect_ex  # type: ignore[method-assign]
    socket.create_connection = create_connection  # type: ignore[assignment]
    socket.getaddrinfo = getaddrinfo  # type: ignore[assignment]
    try:
        yield record
    finally:
        socket.socket.connect, socket.socket.connect_ex = original[0], original[1]  # type: ignore[method-assign]
        socket.create_connection, socket.getaddrinfo = original[2], original[3]  # type: ignore[assignment]


# ── SQL ───────────────────────────────────────────────────────────────────────

# Q0(목록)와 Q2(예측)가 **같은 글자**로 거른다 — n_fcst_kept 가 Q2 행 수와 맞아야 잘림을 잡는다.
FCST_LATERAL = (
    "CROSS JOIN LATERAL jsonb_array_elements(\n"
    "    CASE WHEN jsonb_typeof(s.fcst) = 'array' THEN s.fcst ELSE '[]'::jsonb END) AS e(item)\n"
    "CROSS JOIN LATERAL (SELECT CASE WHEN e.item->>'FCST_TIME' ~ '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}(:\\d{2})?$'\n"
    "              THEN (e.item->>'FCST_TIME')::timestamp AT TIME ZONE 'Asia/Seoul' END AS target_at) t"
)
FCST_FILTER = (
    "t.target_at IS NOT NULL\n"
    "  AND t.target_at >= s.observed_at\n"
    "  AND t.target_at <= s.observed_at + INTERVAL '3 hours'"
)
_UTC_SECONDS = "'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'"
_UTC_MICROS = "'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'"


def _sql_text_array(values: Sequence[str]) -> str:
    return "ARRAY[" + ",".join("'" + v.replace("'", "''") + "'" for v in values) + "]::text[]"


def _params(array_name: str, values: Sequence[str], start: date, end: date) -> str:
    return (
        "WITH params AS (\n"
        f"  SELECT {_sql_text_array(values)} AS {array_name},\n"
        f"         TIMESTAMPTZ '{start.isoformat()} 00:00:00+09' AS from_at,   -- KST, 포함\n"
        f"         TIMESTAMPTZ '{end.isoformat()} 00:00:00+09' AS to_at      -- KST, 배타(끝난 날만)\n"
        ")"
    )


def sql_q0(sites: Sequence[str], start: date, end: date) -> str:
    return (
        _params("sites", sites, start, end) + ",\n"
        "obs AS (\n"
        "  SELECT s.area_nm, s.area_cd, s.bucket_at, s.observed_at, s.fcst\n"
        "  FROM public.seoul_citydata_snapshots s\n"
        "  JOIN params p ON s.area_nm = ANY (p.sites)\n"
        "  WHERE s.bucket_at >= p.from_at AND s.bucket_at < p.to_at\n"
        "),\n"
        "per_day AS (\n"
        "  SELECT area_nm, to_char((bucket_at AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS kst_date, count(*) AS n\n"
        "  FROM obs GROUP BY 1, 2\n"
        "),\n"
        "fcst_kept AS (\n"
        "  SELECT s.area_nm, count(*) AS n_fcst_kept\n"
        "  FROM obs s\n"
        f"{FCST_LATERAL}\n"
        f"WHERE {FCST_FILTER}\n"
        "  GROUP BY 1\n"
        ")\n"
        "-- S4-Q0 목록(읽기 전용). 대상지마다 한 행이라 편집기 행 한도에 잘리지 않는다. counts.csv 로 저장.\n"
        "SELECT o.area_nm,\n"
        "       max(o.area_cd) AS area_cd,\n"
        "       count(*) AS n_obs_total,\n"
        f"       to_char(min(o.bucket_at) AT TIME ZONE 'UTC', {_UTC_SECONDS}) AS first_bucket_at,\n"
        f"       to_char(max(o.bucket_at) AT TIME ZONE 'UTC', {_UTC_SECONDS}) AS last_bucket_at,\n"
        "       (SELECT jsonb_object_agg(d.kst_date, d.n ORDER BY d.kst_date)::text\n"
        "          FROM per_day d WHERE d.area_nm = o.area_nm) AS per_kst_date,\n"
        "       coalesce((SELECT f.n_fcst_kept FROM fcst_kept f WHERE f.area_nm = o.area_nm), 0) AS n_fcst_kept\n"
        "FROM obs o\n"
        "GROUP BY o.area_nm\n"
        "ORDER BY o.area_nm;"
    )


def sql_q1(site: str, start: date, end: date) -> str:
    return (
        _params("sites", [site], start, end) + "\n"
        "-- S4-Q1 관측(읽기 전용). 시각은 UTC ISO 글자로 내보낸다(편집기 시간대 설정과 무관).\n"
        "SELECT s.area_cd,\n"
        "       s.area_nm,\n"
        f"       to_char(s.bucket_at   AT TIME ZONE 'UTC', {_UTC_SECONDS}) AS bucket_at,\n"
        f"       to_char(s.observed_at AT TIME ZONE 'UTC', {_UTC_SECONDS}) AS observed_at,\n"
        f"       to_char(s.fetched_at  AT TIME ZONE 'UTC', {_UTC_MICROS}) AS fetched_at,\n"
        "       s.congest_lvl,\n"
        "       s.ppltn_min,\n"
        "       s.ppltn_max\n"
        "FROM public.seoul_citydata_snapshots s\n"
        "JOIN params p ON s.area_nm = ANY (p.sites)\n"
        "WHERE s.bucket_at >= p.from_at AND s.bucket_at < p.to_at\n"
        "ORDER BY s.area_nm, s.bucket_at;"
    )


def sql_q2(site: str, start: date, end: date) -> str:
    return (
        _params("sites", [site], start, end) + "\n"
        "-- S4-Q2 공급원 예측 펼침(읽기 전용). 대상 시각이 [관측, 관측+3시간] 인 것만 — 엔진이 닿을 수 있는 범위다.\n"
        "SELECT s.area_cd,\n"
        "       s.area_nm,\n"
        f"       to_char(s.bucket_at AT TIME ZONE 'UTC', {_UTC_SECONDS}) AS bucket_at,\n"
        "       e.item->>'FCST_TIME'        AS fcst_time,\n"
        "       e.item->>'FCST_CONGEST_LVL' AS fcst_congest_lvl,\n"
        "       e.item->>'FCST_PPLTN_MIN'   AS fcst_ppltn_min,\n"
        "       e.item->>'FCST_PPLTN_MAX'   AS fcst_ppltn_max\n"
        "FROM public.seoul_citydata_snapshots s\n"
        "JOIN params p ON s.area_nm = ANY (p.sites)\n"
        f"{FCST_LATERAL}\n"
        "WHERE s.bucket_at >= p.from_at AND s.bucket_at < p.to_at\n"
        f"  AND {FCST_FILTER}\n"
        "ORDER BY s.area_nm, s.bucket_at, t.target_at;"
    )


def sql_q3_counts(zone_ids: Sequence[str], start: date, end: date) -> str:
    return (
        _params("zone_ids", zone_ids, start, end) + ",\n"
        "zrows AS (\n"
        "  SELECT z.zone_id, z.bucket_at\n"
        "  FROM public.zone_crowd_snapshots z\n"
        "  JOIN params p ON z.zone_id = ANY (p.zone_ids)\n"
        "  WHERE z.source = 'seoul_citydata'\n"
        "    AND z.bucket_at >= p.from_at AND z.bucket_at < p.to_at\n"
        "),\n"
        "per_day AS (\n"
        "  SELECT zone_id, to_char((bucket_at AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS kst_date, count(*) AS n\n"
        "  FROM zrows GROUP BY 1, 2\n"
        ")\n"
        "-- S4-Q3-count 선택: 대체값 표시 행 수 목록(읽기 전용). 구역마다 한 행이라 편집기 행 한도에 잘리지 않는다.\n"
        "-- Q3 를 받을 때만 함께 받는다(counts_replaced.csv) — 로더가 Q3 조각의 구역·날짜별 행 수를 이 목록과 대조한다.\n"
        "SELECT z.zone_id,\n"
        "       count(*) AS n_rows,\n"
        "       (SELECT jsonb_object_agg(d.kst_date, d.n ORDER BY d.kst_date)::text\n"
        "          FROM per_day d WHERE d.zone_id = z.zone_id) AS per_kst_date\n"
        "FROM zrows z\n"
        "GROUP BY z.zone_id\n"
        "ORDER BY z.zone_id;"
    )


def sql_q3(zone_ids: Sequence[str], start: date, end: date) -> str:
    return (
        _params("zone_ids", zone_ids, start, end) + "\n"
        "-- S4-Q3 선택: 대체값 표시(읽기 전용). 마이그레이션 20261031120000(zone_crowd_snapshots)이 있어야 한다 —\n"
        "-- 'relation ... not exist' 면 Q3-count 와 함께 건너뛴다. 표시가 빈 행도 전부 내보낸다(구역별 비율 보고).\n"
        "SELECT z.zone_id,\n"
        f"       to_char(z.bucket_at AT TIME ZONE 'UTC', {_UTC_SECONDS}) AS bucket_at,\n"
        "       z.quality->>'replaced' AS replaced\n"
        "FROM public.zone_crowd_snapshots z\n"
        "JOIN params p ON z.zone_id = ANY (p.zone_ids)\n"
        "WHERE z.source = 'seoul_citydata'\n"
        "  AND z.bucket_at >= p.from_at AND z.bucket_at < p.to_at\n"
        "ORDER BY z.zone_id, z.bucket_at;"
    )


def _slug(name: str) -> str:
    return "_".join(name.split())


def date_chunks(start: date, end: date, chunk_days: int | None) -> list[tuple[date, date]]:
    if not chunk_days:
        return [(start, end)]
    out = []
    current = start
    while current < end:
        nxt = min(end, current + timedelta(days=chunk_days))
        out.append((current, nxt))
        current = nxt
    return out


def build_sql(cluster: str, start: date, end: date, *, site: str | None = None, chunk_days: int | None = None) -> str:
    """사람이 SQL Editor 에 붙일 블록 전부(Q0 · 대상지·날짜 조각별 Q1/Q2 · Q3). 모두 읽기 전용 SELECT 다."""
    from app.services.batch.crowd_replay_data import cluster_zones

    zones = cluster_zones(cluster)
    names = [z.name for z in zones]
    blocks = [
        f"-- S4 반출 · 권역 {cluster} · KST [{start.isoformat()}, {end.isoformat()}) · 대상지 {', '.join(names)}\n"
        "-- SQL Editor 결과 한도를 'No limit'(없으면 가장 큰 값)으로 두고, 각 결과의 바닥 행 수를 Q0 의\n"
        "-- n_obs_total(Q1) · n_fcst_kept(Q2), Q3-count 의 n_rows(Q3) 와 대조한 뒤 내려받는다.\n"
        "-- 다르면 --chunk-days 10 으로 다시 인쇄한다(Q1·Q2·Q3 이 같은 조각으로 나뉜다).\n"
        "-- CSV 는 내려받은 그대로(UTF-8) 저장소 밖 한 폴더에 둔다 — 엑셀로 열어 저장하지 않는다.",
        "-- ===== Q0 → counts.csv =====\n" + sql_q0(names, start, end),
    ]
    targets = [z for z in zones if site is None or z.name == " ".join(site.split())]
    for zone in targets:
        for chunk_start, chunk_end in date_chunks(start, end, chunk_days):
            suffix = f"{_slug(zone.name)}_{chunk_start.isoformat()}_{chunk_end.isoformat()}.csv"
            blocks.append(f"-- ===== Q1 → obs_{suffix} =====\n" + sql_q1(zone.name, chunk_start, chunk_end))
            blocks.append(f"-- ===== Q2 → fcst_{suffix} =====\n" + sql_q2(zone.name, chunk_start, chunk_end))
    blocks.append(
        "-- ===== Q3-count(선택) → counts_replaced.csv =====\n" + sql_q3_counts([z.zone_id for z in zones], start, end)
    )
    for zone in targets:
        for chunk_start, chunk_end in date_chunks(start, end, chunk_days):
            suffix = f"{_slug(zone.name)}_{chunk_start.isoformat()}_{chunk_end.isoformat()}.csv"
            blocks.append(f"-- ===== Q3(선택) → replaced_{suffix} =====\n"
                          + sql_q3([zone.zone_id], chunk_start, chunk_end))
    return "\n\n".join(blocks) + "\n"


def today_kst() -> date:
    return datetime.now(KST).date()


# ── 경로 가드 ─────────────────────────────────────────────────────────────────


def repo_root(start: Path | None = None) -> Path | None:
    current = (start or Path(__file__)).resolve()
    for candidate in [current, *current.parents]:
        if (candidate / ".git").exists():
            return candidate
    return None


def _norm(path: Path | str) -> str:
    return os.path.normcase(str(Path(os.path.expandvars(str(path))).expanduser().resolve()))


def _under(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("\\/") + os.sep)


def path_problem(inputs: Sequence[Path], out_dir: Path, *, root: Path | None = None) -> str | None:
    """저장소 안이면 apps/api/.replay-data/ 아래만 허용. apps/api/app/ 아래 출력은 언제나 거부."""
    root = root if root is not None else repo_root()
    if root is None:
        return None
    repo = _norm(root)
    allowed = _norm(root / "apps" / "api" / ".replay-data")
    app_dir = _norm(root / "apps" / "api" / "app")
    out = _norm(out_dir)
    if _under(out, app_dir):
        return f"출력이 apps/api/app 아래다(런타임 코드 옆에 원본·추적을 두지 않는다): {out_dir}"
    for path in [*inputs, out_dir]:
        normalized = _norm(path)
        if _under(normalized, repo) and not _under(normalized, allowed):
            return f"저장소 안에서는 apps/api/.replay-data/ 아래만 쓴다(원본 반출은 커밋 금지): {path}"
    return None


# ── CSV 읽기 ──────────────────────────────────────────────────────────────────


def read_csv(path: Path):
    """CSV 하나 → CsvFile. 따옴표가 닫히지 않은 것처럼 CSV 로 읽을 수 없으면 ReplayInputError(종료 2 · 파일과 줄)."""
    from app.services.batch.crowd_replay_data import CsvFile, Problem, ReplayInputError

    raw = path.read_bytes()
    text = raw.decode("utf-8-sig")
    reader = csv.reader(io.StringIO(text, newline=""))
    rows, lines = [], []
    widths: list[tuple[int, int]] = []
    header: list[str] = []
    last_line = 0  # 마지막으로 끝까지 읽은 레코드의 끝 줄(머리줄·빈 줄 포함)
    try:
        for record in reader:
            last_line = reader.line_num
            if not header:
                header = [h.strip() for h in record]
                continue
            if not any(cell.strip() for cell in record):
                continue
            if len(record) != len(header):
                # 칸 수가 다르면 적재가 row_width_mismatch 로 거부한다(종료 코드 2) — 메우거나 자르지 않는다.
                widths.append((reader.line_num, len(record)))
            rows.append(dict(zip(header, record + [""] * (len(header) - len(record)))))
            lines.append(reader.line_num)
    except csv.Error as exc:
        # 닫히지 않은 따옴표는 파일 끝까지 한 칸으로 읽혀 칸 한도를 넘는다 — 줄은 마지막으로 읽은 행 다음이다.
        start = last_line + 1
        raise ReplayInputError([Problem(
            path.name, start, None, "csv_parse_error",
            f"CSV 로 읽을 수 없다({exc}) — {start}행 근처의 닫히지 않은 따옴표를 확인한다",
        )]) from exc
    return CsvFile(
        path.name, tuple(header), tuple(rows), tuple(lines), hashlib.sha256(raw).hexdigest(),
        width_mismatches=tuple(widths),
    )


REPLACED_COUNTS_NAME = "counts_replaced.csv"


def discover(data_dir: Path) -> dict[str, Any]:
    return {
        "counts": data_dir / "counts.csv" if (data_dir / "counts.csv").exists() else None,
        "obs": sorted(data_dir.glob("obs_*.csv")),
        "fcst": sorted(data_dir.glob("fcst_*.csv")),
        "replaced": sorted(data_dir.glob("replaced*.csv")),
        "replaced_counts": data_dir / REPLACED_COUNTS_NAME if (data_dir / REPLACED_COUNTS_NAME).exists() else None,
    }


# 마지막 git 실패의 이유(git stderr · 예외) — 확인 실행을 거부할 때 메시지에 붙인다.
LAST_GIT_ERROR: list[str] = []


def _git(*args: str) -> str | None:
    """저장소 뿌리에서 git 을 돌려 표준 출력을 준다. 저장소·git 이 없거나 실패하면 None(이유는 LAST_GIT_ERROR)."""
    LAST_GIT_ERROR.clear()
    root = repo_root()
    if root is None:
        LAST_GIT_ERROR.append("저장소 뿌리(.git)를 찾지 못했다")
        return None
    try:
        out = subprocess.run(
            ["git", *args], cwd=root, capture_output=True, text=True, timeout=10, check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        LAST_GIT_ERROR.append(f"git 을 실행하지 못했다({type(exc).__name__}: {exc})")
        return None
    if out.returncode != 0:
        LAST_GIT_ERROR.append(f"git {args[0]} 종료 {out.returncode}: {(out.stderr or '').strip() or '(stderr 없음)'}")
        return None
    return out.stdout


def default_code_version() -> str | None:
    """HEAD 짧은 해시. apps/api 아래에 커밋하지 않은 변경이 있으면 '-dirty' 를 붙인다(그 해시의 코드가 아니다)."""
    head = (_git("rev-parse", "--short", "HEAD") or "").strip()
    if not head:
        return None
    status = _git("status", "--porcelain", "--", "apps/api")
    return f"{head}-dirty" if status and status.strip() else head


# 확인 실행 전에 깨끗해야 하는 곳 — 재생 모듈만이 아니라 엔진 경로(zone_evidence · congestion_evidence · spot/* ·
# routers/recommendations …)도 결과를 바꾸므로 apps/api/app 전체와 이 스크립트다.
CONFIRMATORY_CLEAN_PATHS: tuple[str, ...] = ("apps/api/app", "apps/api/scripts/crowd_dispersion_replay.py")


def dirty_replay_sources() -> list[str] | None:
    """커밋되지 않은 재생·엔진 소스(수정·추적 안 됨) 목록. git 으로 확인할 수 없으면 None."""
    paths = list(CONFIRMATORY_CLEAN_PATHS)
    status = _git("status", "--porcelain", "--untracked-files=all", "--", *paths)
    if status is None:
        return None
    return [line[3:].strip() for line in status.splitlines() if line.strip()]


# ── 명령 ──────────────────────────────────────────────────────────────────────


def _parse_date(text: str) -> date:
    return date.fromisoformat(text)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="crowd_dispersion_replay", description="S4 분산 결정 재생(오프라인)")
    sub = parser.add_subparsers(dest="command", required=True)
    sql = sub.add_parser("sql", help="읽기 전용 반출 SQL 을 인쇄한다")
    sql.add_argument("--cluster", required=True)
    sql.add_argument("--from", dest="date_from", required=True, type=_parse_date, help="KST 날짜(포함)")
    sql.add_argument("--to", dest="date_to", type=_parse_date, default=None,
                     help="KST 날짜(배타). 기본 오늘 KST 자정 — 그보다 늦으면 거부")
    sql.add_argument("--site", default=None)
    sql.add_argument("--chunk-days", type=int, default=None)

    run = sub.add_parser("run", help="CSV 로 재생한다")
    run.add_argument("--cluster", required=True)
    run.add_argument("--data-dir", default=None)
    run.add_argument("--obs", nargs="*", default=None)
    run.add_argument("--fcst", nargs="*", default=None)
    run.add_argument("--counts", default=None)
    run.add_argument("--replaced", nargs="*", default=None, help="Q3 조각(replaced_*.csv)")
    run.add_argument("--replaced-counts", default=None, help="Q3-count 목록(counts_replaced.csv)")
    run.add_argument("--out-dir", default=None)
    run.add_argument("--label", choices=("pilot", "confirmatory", "exploratory"), default="pilot")
    run.add_argument("--expect-criteria", default=None)
    run.add_argument("--no-forecast", action="store_true")
    run.add_argument("--detour", type=float, default=None)
    run.add_argument("--truth-tolerance-min", type=float, default=None)
    run.add_argument("--trace", action="store_true")
    run.add_argument("--code-version", default=None)
    run.add_argument("--no-sensitivity", action="store_true", help="이동 1.18 민감도 재실행을 건너뛴다(빠른 확인용)")
    return parser


def _cmd_sql(args) -> int:
    from app.services.batch.crowd_replay_data import cluster_names, cluster_zones

    if not cluster_zones(args.cluster):
        print(f"모르는 권역: {args.cluster} (권역: {', '.join(cluster_names())})", file=sys.stderr)
        return EXIT_INPUT
    today = today_kst()
    end = args.date_to or today
    if end > today:
        print(f"--to {end} 는 마지막으로 끝난 KST 자정({today})보다 늦다 — 쓰이고 있는 날은 반출하지 않는다", file=sys.stderr)
        return EXIT_INPUT
    if args.date_from >= end:
        print(f"--from {args.date_from} 가 --to {end} 보다 늦지 않아야 한다", file=sys.stderr)
        return EXIT_INPUT
    if args.chunk_days is not None and args.chunk_days < 1:
        print("--chunk-days 는 1 이상", file=sys.stderr)
        return EXIT_INPUT
    names = [z.name for z in cluster_zones(args.cluster)]
    if args.site is not None and " ".join(args.site.split()) not in names:
        print(f"--site {args.site} 는 {args.cluster} 대상지가 아니다({', '.join(names)})", file=sys.stderr)
        return EXIT_INPUT
    sys.stdout.write(build_sql(args.cluster, args.date_from, end, site=args.site, chunk_days=args.chunk_days))
    return EXIT_OK


def _expand(path: str) -> Path:
    return Path(os.path.expandvars(path)).expanduser()


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _cmd_run(args) -> int:
    from app.services.batch import crowd_dispersion_replay as replay
    from app.services.batch.crowd_replay_data import ReplayInputError, load_replay_inputs

    version = replay.criteria_version()
    overrides = []
    if args.detour is not None:
        overrides.append(f"detour={args.detour}")
    if args.truth_tolerance_min is not None:
        overrides.append(f"truth_tolerance_min={args.truth_tolerance_min}")
    if args.no_forecast:
        overrides.append("no_forecast")
    if args.expect_criteria is not None and args.expect_criteria != version:
        print(f"기준 해시가 다르다: 기대 {args.expect_criteria} · 지금 {version} — 기준을 고친 뒤에는 새 해시를 문서에 고정한다",
              file=sys.stderr)
        return EXIT_CRITERIA
    if args.label == "confirmatory" and overrides:
        print(f"확인 실행(confirmatory)은 판정 인자를 덮을 수 없다: {', '.join(overrides)}", file=sys.stderr)
        return EXIT_CRITERIA
    if args.label == "confirmatory" and args.no_sensitivity:
        print("확인 실행(confirmatory)은 민감도(이동 1.18 재실행)를 건너뛸 수 없다 — --no-sensitivity 를 빼고 다시 돌린다",
              file=sys.stderr)
        return EXIT_CRITERIA
    if args.label == "confirmatory" and args.expect_criteria is None:
        print("확인 실행(confirmatory)에는 --expect-criteria <고정 해시> 가 필요하다", file=sys.stderr)
        return EXIT_CRITERIA
    if args.label == "confirmatory":
        # 확인 실행은 커밋된 코드로만 — 아니면 고정한 기준 해시가 같아도 어떤 코드로 돌렸는지 되짚을 수 없다.
        dirty = dirty_replay_sources()
        if dirty is None:
            why = LAST_GIT_ERROR[0] if LAST_GIT_ERROR else "이유 모름"
            print("확인 실행(confirmatory)은 git 으로 재생·엔진 소스(apps/api/app)가 커밋된 상태인지 확인할 수 있어야 한다"
                  f" — {why}", file=sys.stderr)
            return EXIT_CRITERIA
        if dirty:
            print("확인 실행(confirmatory)은 커밋하지 않은 재생·엔진 소스로 돌리지 않는다: " + ", ".join(dirty), file=sys.stderr)
            return EXIT_CRITERIA
    run_label = "exploratory" if overrides else args.label

    data_dir = _expand(args.data_dir) if args.data_dir else None
    found = (
        discover(data_dir) if data_dir is not None
        else {"counts": None, "obs": [], "fcst": [], "replaced": [], "replaced_counts": None}
    )
    obs_paths = [_expand(p) for p in args.obs] if args.obs else found["obs"]
    fcst_paths = [] if args.no_forecast else ([_expand(p) for p in args.fcst] if args.fcst else found["fcst"])
    counts_path = _expand(args.counts) if args.counts else found["counts"]
    replaced_paths = [_expand(p) for p in args.replaced] if args.replaced else found["replaced"]
    replaced_counts_path = _expand(args.replaced_counts) if args.replaced_counts else found["replaced_counts"]
    if args.out_dir:
        out_dir = _expand(args.out_dir)
    elif data_dir is not None:
        out_dir = data_dir / "out"
    else:
        print("--out-dir 또는 --data-dir 가 필요하다", file=sys.stderr)
        return EXIT_INPUT
    inputs = [
        p for p in [data_dir, counts_path, replaced_counts_path, *replaced_paths, *obs_paths, *fcst_paths]
        if p is not None
    ]
    problem = path_problem(inputs, out_dir)
    if problem:
        print(problem, file=sys.stderr)
        return EXIT_PATH

    missing = [
        str(p) for p in [counts_path, replaced_counts_path, *replaced_paths, *obs_paths, *fcst_paths]
        if p is not None and not p.exists()
    ]
    if missing:
        print("파일이 없다: " + ", ".join(missing), file=sys.stderr)
        return EXIT_INPUT
    try:
        data = load_replay_inputs(
            args.cluster,
            observations=[read_csv(p) for p in obs_paths],
            forecasts=[read_csv(p) for p in fcst_paths],
            counts=read_csv(counts_path) if counts_path is not None else None,
            replaced=[read_csv(p) for p in replaced_paths],
            replaced_counts=read_csv(replaced_counts_path) if replaced_counts_path is not None else None,
            forecasts_enabled=not args.no_forecast,
            truth_tolerance_minutes=args.truth_tolerance_min,
        )
        config = replay.ReplayConfig(
            cluster=args.cluster,
            run_label=run_label,
            detour=args.detour if args.detour is not None else replay.CRITERIA["travel"]["detour"],
            truth_tolerance_minutes=args.truth_tolerance_min,
            forecasts_enabled=not args.no_forecast,
            overrides=tuple(overrides),
            code_version=args.code_version if args.code_version is not None else default_code_version(),
            sensitivity=not args.no_sensitivity,
        )
        report, trace = replay.run_replay(data, config)
    except ReplayInputError as exc:
        print(f"입력·설정 문제 {len(exc.problems)}건:", file=sys.stderr)
        for item in exc.problems:
            print("  " + item.format(), file=sys.stderr)
        return EXIT_INPUT
    except UnicodeDecodeError as exc:
        print(f"UTF-8 이 아닌 파일이 있다(엑셀로 저장하지 말 것): {exc}", file=sys.stderr)
        return EXIT_INPUT

    cluster = args.cluster
    _write(out_dir / f"{cluster}_replay_report.json",
           json.dumps(report, sort_keys=True, ensure_ascii=False, indent=2) + "\n")
    _write(out_dir / f"{cluster}_replay_summary.md", replay.render_markdown(report))
    summary = replay.build_decision_quality_summary(report)
    _write(out_dir / "decision_quality" / f"{cluster}.json",
           json.dumps(summary, sort_keys=True, ensure_ascii=False, indent=2) + "\n")
    if args.trace:
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=list(replay.TRACE_COLUMNS), lineterminator="\n")
        writer.writeheader()
        writer.writerows(trace)
        _write(out_dir / f"{cluster}_decisions_trace.csv", buffer.getvalue())
    v3 = report["verdicts"]["V3"]
    v4 = report["verdicts"]["V4"]
    print(f"[{run_label} · 기준 {version}] V3 {v3['status']} (n={v3['n']}, 차={v3['diff']}, CI 하한={v3['ci_low']}) · "
          f"V4 {v4['status']}(권장 {v4['recommendation']}) → {out_dir}")
    return EXIT_OK


def main(argv: Sequence[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            pass
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    previous = _force_offline_env()
    try:
        LAST_NETWORK_ATTEMPTS.clear()
        with network_guard(LAST_NETWORK_ATTEMPTS):
            if args.command == "sql":
                return _cmd_sql(args)
            return _cmd_run(args)
    finally:
        _restore_env(previous)


if __name__ == "__main__":
    sys.exit(main())
