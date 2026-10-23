"""익명 이용 기록 테이블(20261023090000)의 계약.

웹(lib/usageEvents.ts)이 보내는 이벤트 이름이 DB CHECK 목록에 없으면 그 배치 INSERT 가 통째로 거절되고,
웹은 첫 실패 뒤 그 탭에서 기록을 멈춘다 — 조용히 아무것도 쌓이지 않는다. 두 목록이 같아야 한다.
권한은 브라우저 INSERT(고른 칼럼)만, 읽기는 service_role 만이다(2026-10-30 새 테이블 명시 GRANT 규칙).
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
MIGRATION = "supabase/migrations/20261023090000_usage_events.sql"
WEB_MODULE = "apps/web/lib/usageEvents.ts"


def _body(relative: str) -> str:
    """주석을 걷어낸 소문자 본문(공백 하나로). 주석 문장이 증거가 되면 안 된다."""
    text = (ROOT / relative).read_text(encoding="utf-8")
    lines = [line for line in text.splitlines() if not line.lstrip().startswith("--")]
    return " ".join("\n".join(lines).lower().split())


def test_migration_sorts_last_and_reset_prelude_drops_the_table():
    names = sorted(p.name for p in (ROOT / "supabase/migrations").glob("*.sql"))
    assert names.index(Path(MIGRATION).name) > names.index("20260920140000_seoul_citydata_retry_budget.sql")
    prelude = (ROOT / "scripts/build_reset.mjs").read_text(encoding="utf-8")
    assert "DROP TABLE IF EXISTS public.usage_events CASCADE;" in prelude


def test_event_whitelist_matches_the_web_module():
    sql = _body(MIGRATION)
    check = re.search(r"event text not null check \(event in \(([^)]*)\)\)", sql)
    assert check, "event CHECK 목록을 찾지 못했다"
    db_events = set(re.findall(r"'([a-z_]+)'", check.group(1)))
    web = (ROOT / WEB_MODULE).read_text(encoding="utf-8")
    block = re.search(r"export const USAGE_EVENTS = \[(.*?)\] as const;", web, flags=re.S)
    assert block, "USAGE_EVENTS 목록을 찾지 못했다"
    web_events = set(re.findall(r"'([a-z_]+)'", block.group(1)))
    assert db_events == web_events


def test_browser_can_only_insert_chosen_columns_and_never_read():
    sql = _body(MIGRATION)
    assert "alter table public.usage_events enable row level security" in sql
    assert "revoke all on table public.usage_events from anon, authenticated" in sql
    assert (
        "grant insert (anon_id, session_id, event, page, locale, props) on table public.usage_events "
        "to anon, authenticated" in sql
    )
    assert not re.search(r"grant [a-z, ]*select[a-z, ]* on table public\.usage_events to [a-z, ]*anon", sql)
    assert "grant select, insert, update, delete on table public.usage_events to service_role" in sql
    # 계정과 잇지 않는다 — user_id 칼럼이 없다.
    assert "user_id" not in sql


def test_one_year_retention_is_scheduled_once():
    sql = _body(MIGRATION)
    assert "cron.unschedule" in sql
    assert "'nextspot-usage-events-retention'" in sql
    assert "delete from public.usage_events where created_at < now() - interval '365 days'" in sql
