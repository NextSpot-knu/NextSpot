"""익명 이용 기록 집계 함수(20261024100000)의 계약.

usage_events 는 브라우저가 읽지 못한다. 관제 패널(components/admin/UsageSummaryPanel.tsx)은 이 함수로 숫자만 받는다 —
관리자만 부를 수 있어야 하고(anon 회수), 집계가 쓰는 이벤트 이름이 테이블 CHECK 목록에 있어야 한다(오타면 늘 0).
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
MIGRATION = "supabase/migrations/20261024100000_usage_summary.sql"
EVENTS_MIGRATION = "supabase/migrations/20261023090000_usage_events.sql"
PANEL = "apps/web/components/admin/UsageSummaryPanel.tsx"


def _body(relative: str) -> str:
    """주석을 걷어낸 소문자 본문(공백 하나로). 주석 문장이 증거가 되면 안 된다."""
    text = (ROOT / relative).read_text(encoding="utf-8")
    lines = [line for line in text.splitlines() if not line.lstrip().startswith("--")]
    return " ".join("\n".join(lines).lower().split())


def test_migration_sorts_after_usage_events_and_reset_prelude_drops_it():
    names = sorted(p.name for p in (ROOT / "supabase/migrations").glob("*.sql"))
    assert names.index(Path(MIGRATION).name) > names.index(Path(EVENTS_MIGRATION).name)
    prelude = (ROOT / "scripts/build_reset.mjs").read_text(encoding="utf-8")
    assert "DROP FUNCTION IF EXISTS public.usage_summary(INTEGER) CASCADE;" in prelude


def test_only_admins_can_call_it():
    sql = _body(MIGRATION)
    assert "security definer" in sql
    assert "set search_path = public" in sql
    assert "if not public.is_admin_or_dev() then raise exception" in sql
    assert "revoke all on function public.usage_summary(integer) from public, anon" in sql
    assert "grant execute on function public.usage_summary(integer) to authenticated" in sql


def test_counted_events_exist_in_the_table_whitelist():
    sql = _body(MIGRATION)
    used = set(re.findall(r"event (?:= '([a-z_]+)'|in \(([^)]*)\))", sql))
    names = {n for a, b in used for n in ([a] if a else re.findall(r"'([a-z_]+)'", b))}
    assert {"rec_shown", "rec_accept", "rec_drive", "visit_arrived"} <= names
    events_sql = _body(EVENTS_MIGRATION)
    check = re.search(r"event text not null check \(event in \(([^)]*)\)\)", events_sql)
    assert check, "event CHECK 목록을 찾지 못했다"
    assert names <= set(re.findall(r"'([a-z_]+)'", check.group(1)))


def test_panel_reads_the_keys_the_function_returns():
    sql = _body(MIGRATION)
    panel = (ROOT / PANEL).read_text(encoding="utf-8")
    assert "rpc('usage_summary'" in panel
    for key in ("visitors", "saw_card", "went", "arrived", "daily"):
        assert f"'{key}'" in sql
        assert f"data.{key}" in panel or f"{key}:" in panel
