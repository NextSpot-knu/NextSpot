"""사용자 행동 기록 테이블(20261112090000)의 계약.

웹(apps/web/lib/actionLog.ts)이 공개 anon 키로 직접 INSERT 하고, 서버 칼럼은 트리거가 찍는다. 이 테스트가 잠그는 것:
  · 이벤트 16개 CHECK 목록 = 웹의 ACTION_LOG_EVENTS(순서까지) — 어긋나면 그 묶음 INSERT 가 통째로 거절된다.
  · 브라우저는 고른 9칼럼 INSERT 만(읽기·수정·삭제 없음), service_role 은 SELECT·INSERT 만.
  · 서버 칼럼(received_at · user_id · is_anonymous · account_role · ip · ip_chain · user_agent)은 트리거가 덮어쓴다.
  · 추가만 — UPDATE · 365일 안 DELETE · TRUNCATE 는 트리거가 거절하고, 1년 지난 행은 cron 이 지운다.
  · 읽기 RPC 둘은 developer 만 — 심사위원이 admin 계정을 쓰므로 admin 이 통과하면 안 된다.

로컬에 Postgres 가 없어 계약을 글자로 고정한다(행동은 PGlite 로 한 번 돌려 확인했다 — 로그인 전·게스트·계정 도장,
보낸 서버 칼럼 무시, 헤더가 없거나 깨져도 기록, 수정·최근 삭제·TRUNCATE 거절과 365일 지난 행 삭제, developer 만 RPC,
admin·tourist·guest 는 42501, 이메일은 계정 행에만).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
MIGRATION = "supabase/migrations/20261112090000_action_logs.sql"
WEB_MODULE = "apps/web/lib/actionLog.ts"

_SQL = (ROOT / MIGRATION).read_text(encoding="utf-8")
_CODE = re.sub(r"--[^\n]*", "", _SQL)  # 주석 문장이 증거가 되면 안 된다

EVENTS = (
    "session_start",
    "page_view",
    "click",
    "input",
    "submit",
    "search",
    "voice",
    "key",
    "swipe",
    "scroll",
    "map",
    "visibility",
    "heartbeat",
    "api",
    "error",
    "auth",
)
BROWSER_COLUMNS = "occurred_at, device_id, session_id, seq, event, page, host, locale, props"
DEVICES_SIGNATURE = "action_log_devices(TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, INTEGER)"
ROWS_SIGNATURE = "action_log_rows(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BIGINT, INTEGER)"
DEVELOPER_GATE = (
    "if public.get_auth_user_role() is distinct from 'developer' then "
    "raise exception 'developer_only' using errcode = '42501'; end if;"
)


def _norm(text: str) -> str:
    """소문자 + 공백 하나로."""
    return " ".join(text.lower().split())


def _function(name: str) -> tuple[str, str]:
    """(머리말: 인자·RETURNS·속성, 본문) — CREATE 문 기준(앞의 DROP FUNCTION 줄이 아니라)."""
    start = _CODE.index(f"CREATE OR REPLACE FUNCTION public.{name}(")
    body_open = _CODE.index("$$", start)
    body_close = _CODE.index("$$;", body_open + 2)
    return _CODE[start:body_open], _CODE[body_open + 2 : body_close]


def _returns_table(name: str) -> list[tuple[str, str]]:
    header, _ = _function(name)
    block = re.search(r"RETURNS TABLE \((.*?)\)\s*LANGUAGE", header, flags=re.S)
    assert block, f"{name} 의 RETURNS TABLE 을 찾지 못했다"
    columns = []
    for part in block.group(1).split(","):
        column, column_type = part.split()
        columns.append((column, column_type))
    return columns


def _table_ddl() -> str:
    start = _CODE.index("CREATE TABLE IF NOT EXISTS public.action_logs (")
    return _CODE[start : _CODE.index(");", start)]


def test_migration_sorts_after_guest_shadow_and_reset_prelude_drops_everything():
    names = sorted(p.name for p in (ROOT / "supabase/migrations").glob("*.sql"))
    assert names.index(Path(MIGRATION).name) > names.index("20261031130000_guest_crowd_answer_shadow.sql")
    prelude = (ROOT / "scripts/build_reset.mjs").read_text(encoding="utf-8")
    assert "DROP TABLE IF EXISTS public.action_logs CASCADE;" in prelude
    for signature in ("action_logs_stamp()", "action_logs_guard()", DEVICES_SIGNATURE, ROWS_SIGNATURE):
        assert f"DROP FUNCTION IF EXISTS public.{signature} CASCADE;" in prelude


def test_event_whitelist_is_the_contract_list_in_order():
    check = re.search(r"event text not null check \(event in \(([^)]*)\)\)", _norm(_table_ddl()))
    assert check, "event CHECK 목록을 찾지 못했다"
    assert tuple(re.findall(r"'([a-z_]+)'", check.group(1))) == EVENTS


def test_event_whitelist_matches_the_web_module():
    web = ROOT / WEB_MODULE
    if not web.exists():
        pytest.skip(f"{WEB_MODULE} 가 아직 없다(브라우저 쪽은 따로 만든다)")
    text = web.read_text(encoding="utf-8")
    block = re.search(r"(?:export\s+)?const\s+ACTION_LOG_EVENTS\b[^=]*=\s*\[(.*?)\]", text, flags=re.S)
    assert block, "ACTION_LOG_EVENTS 목록을 찾지 못했다"
    items = re.sub(r"/\*.*?\*/|//[^\n]*", "", block.group(1), flags=re.S)
    assert tuple(re.findall(r"['\"]([a-z_]+)['\"]", items)) == EVENTS


def test_browser_columns_are_bounded_and_user_id_has_no_foreign_key():
    ddl = _norm(_table_ddl())
    assert "id bigint generated always as identity primary key" in ddl
    assert "received_at timestamptz not null default now()" in ddl
    assert "occurred_at timestamptz," in ddl  # 브라우저 시계 — NULL 허용
    assert "device_id text not null check (char_length(device_id) between 8 and 64)" in ddl
    assert "session_id text not null check (char_length(session_id) between 8 and 64)" in ddl
    assert "seq integer check (seq is null or seq >= 0)" in ddl
    assert "page text check (page is null or char_length(page) <= 200)" in ddl
    assert "host text check (host is null or char_length(host) <= 100)" in ddl
    assert "locale text check (locale is null or char_length(locale) <= 16)" in ddl
    assert (
        "props jsonb not null default '{}'::jsonb check (jsonb_typeof(props) = 'object' "
        "and pg_column_size(props) <= 4096)"
    ) in ddl
    for column in ("user_id uuid", "is_anonymous boolean", "account_role text"):
        assert column in ddl
    assert "ip text check (ip is null or char_length(ip) <= 64)" in ddl
    assert "ip_chain text check (ip_chain is null or char_length(ip_chain) <= 300)" in ddl
    assert "user_agent text check (user_agent is null or char_length(user_agent) <= 400)" in ddl
    # 계정이 지워져도 기록은 남는다 — FK(ON DELETE SET NULL)였다면 UPDATE 가드에 막혀 계정 삭제가 실패한다.
    assert "references" not in ddl


def test_browser_can_only_insert_chosen_columns_and_nobody_can_rewrite():
    sql = _norm(_CODE)
    assert "alter table public.action_logs enable row level security" in sql
    assert (
        "create policy action_logs_insert_any on public.action_logs for insert to anon, authenticated "
        "with check (true)"
    ) in sql
    assert "for select to service_role using (true)" in sql
    assert "for insert to service_role with check (true)" in sql
    assert "revoke all on table public.action_logs from anon, authenticated;" in sql
    assert "revoke all on table public.action_logs from public, service_role;" in sql
    assert f"grant insert ({BROWSER_COLUMNS}) on table public.action_logs to anon, authenticated;" in sql
    assert "grant select, insert on table public.action_logs to service_role;" in sql
    grants = re.findall(r"grant ([a-z, ()_]+?) on table public\.action_logs to ([a-z_, ]+);", sql)
    assert len(grants) == 2
    for privileges, _grantees in grants:
        assert not re.search(r"\b(update|delete|truncate|all)\b", privileges)
    for privileges, grantees in grants:
        if "anon" in grantees or "authenticated" in grantees:
            assert privileges.startswith("insert (")


def test_server_columns_are_stamped_by_a_security_definer_trigger():
    header, body = _function("action_logs_stamp")
    header, body = _norm(header), _norm(body)
    assert "security definer" in header
    assert "set search_path = public, pg_temp" in header
    assert "v_uid uuid := auth.uid();" in body
    assert "new.received_at := now();" in body
    assert "new.user_id := v_uid;" in body
    assert "new.is_anonymous := null;" in body and "new.account_role := null;" in body
    assert "new.is_anonymous := coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);" in body
    assert "select u.role into v_role from public.users as u where u.id = v_uid;" in body
    # 헤더가 없거나 깨져도 INSERT 는 실패하지 않는다.
    assert "current_setting('request.headers', true)" in body
    assert "exception when others then v_headers := '{}'::jsonb;" in body
    # ip: cf-connecting-ip → x-real-ip → x-forwarded-for 첫 값.
    cf = body.index("v_headers ->> 'cf-connecting-ip'")
    real = body.index("v_headers ->> 'x-real-ip'")
    first_xff = body.index("split_part(v_xff, ',', 1)")
    assert cf < real < first_xff
    assert "v_xff := nullif(v_headers ->> 'x-forwarded-for', '');" in body
    assert "new.ip_chain := left(v_xff, 300);" in body
    assert "), 64);" in body
    assert "new.user_agent := left(nullif(btrim(v_headers ->> 'user-agent'), ''), 400);" in body
    sql = _norm(_CODE)
    assert "drop trigger if exists action_logs_stamp on public.action_logs" in sql
    assert (
        "create trigger action_logs_stamp before insert on public.action_logs for each row "
        "execute function public.action_logs_stamp();"
    ) in sql


def test_append_only_guards_block_update_recent_delete_and_truncate():
    header, body = _function("action_logs_guard")
    header, body = _norm(header), _norm(body)
    assert "security definer" not in header
    assert "if tg_op = 'delete' then if old.received_at > now() - interval '365 days' then raise exception" in body
    assert "return old;" in body
    assert body.rstrip().endswith("end;")
    assert body.count("raise exception") == 2  # 최근 행 DELETE + 그 밖(UPDATE·TRUNCATE) 전부
    sql = _norm(_CODE)
    for trigger, timing, level in (
        ("action_logs_no_update", "before update", "for each row"),
        ("action_logs_no_recent_delete", "before delete", "for each row"),
        ("action_logs_no_truncate", "before truncate", "for each statement"),
    ):
        assert f"drop trigger if exists {trigger} on public.action_logs" in sql
        assert (
            f"create trigger {trigger} {timing} on public.action_logs {level} "
            "execute function public.action_logs_guard();"
        ) in sql
    for function in ("action_logs_stamp", "action_logs_guard"):
        assert f"revoke all on function public.{function}() from public, anon, authenticated;" in sql


def test_indexes_cover_time_device_account_and_event_lookups():
    sql = _norm(_CODE)
    assert "on public.action_logs (received_at desc);" in sql
    assert "on public.action_logs (device_id, received_at);" in sql
    assert "on public.action_logs (user_id, received_at) where user_id is not null;" in sql
    assert "on public.action_logs (event, received_at desc);" in sql
    assert sql.count("create index if not exists idx_action_logs_") == 4


def test_one_year_retention_is_scheduled_once():
    sql = _norm(_CODE)
    assert sql.index("cron.unschedule") < sql.index("select cron.schedule(")
    assert "where jobname = 'nextspot-action-logs-retention'" in sql
    assert (
        "select cron.schedule( 'nextspot-action-logs-retention', '37 18 * * *', "
        "$command$delete from public.action_logs where received_at < now() - interval '365 days';$command$ );"
    ) in sql


def test_read_rpcs_are_developer_only_and_not_admin():
    sql = _norm(_CODE)
    for name, signature in (("action_log_devices", DEVICES_SIGNATURE), ("action_log_rows", ROWS_SIGNATURE)):
        header, body = _function(name)
        header, body = _norm(header), _norm(body)
        for attribute in ("language plpgsql", "stable", "security definer", "set search_path = public"):
            assert attribute in header
        # 본문 첫 문장이 developer 확인이다(선언부 뒤 BEGIN 바로 다음).
        assert body.startswith("#variable_conflict use_column declare")
        assert body.split(" begin ", 1)[1].startswith(DEVELOPER_GATE)
        assert "is_admin_or_dev" not in body
        lowered = signature.lower()
        assert f"drop function if exists public.{lowered};" in sql
        assert f"revoke all on function public.{lowered} from public, anon;" in sql
        assert f"grant execute on function public.{lowered} to authenticated;" in sql


def test_rpc_signatures_and_output_columns_match_the_contract():
    header, _ = _function("action_log_devices")
    assert _norm(header).startswith(
        "create or replace function public.action_log_devices( p_from timestamptz, p_to timestamptz, "
        "p_accounts_only boolean default false, p_limit integer default 300 )"
    )
    assert _returns_table("action_log_devices") == [
        ("device_id", "TEXT"),
        ("first_at", "TIMESTAMPTZ"),
        ("last_at", "TIMESTAMPTZ"),
        ("sessions", "INTEGER"),
        ("events", "INTEGER"),
        ("page_views", "INTEGER"),
        ("clicks", "INTEGER"),
        ("heartbeats", "INTEGER"),
        ("accounts", "JSONB"),
        ("ips", "TEXT[]"),
        ("user_agent", "TEXT"),
        ("landing", "TEXT"),
        ("referrer", "TEXT"),
    ]
    header, _ = _function("action_log_rows")
    assert _norm(header).startswith(
        "create or replace function public.action_log_rows( p_from timestamptz, p_to timestamptz, "
        "p_device_id text default null, p_after_id bigint default 0, p_limit integer default 2000 )"
    )
    assert _returns_table("action_log_rows") == [
        ("id", "BIGINT"),
        ("received_at", "TIMESTAMPTZ"),
        ("occurred_at", "TIMESTAMPTZ"),
        ("device_id", "TEXT"),
        ("session_id", "TEXT"),
        ("seq", "INTEGER"),
        ("event", "TEXT"),
        ("page", "TEXT"),
        ("host", "TEXT"),
        ("locale", "TEXT"),
        ("props", "JSONB"),
        ("user_id", "UUID"),
        ("email", "TEXT"),
        ("is_anonymous", "BOOLEAN"),
        ("account_role", "TEXT"),
        ("ip", "TEXT"),
        ("ip_chain", "TEXT"),
        ("user_agent", "TEXT"),
    ]


def test_devices_rpc_window_accounts_ips_and_landing():
    _, body = _function("action_log_devices")
    body = _norm(body)
    assert "v_limit := least(greatest(coalesce(p_limit, 300), 1), 1000);" in body
    assert body.count("l.received_at >= v_from and l.received_at < v_to") == 5  # 요약 + 상세 넷이 같은 기간
    assert "where not v_accounts_only or pd.has_account" in body
    assert "coalesce(bool_or(l.is_anonymous = false), false) as has_account" in body
    # 계정: 게스트가 아닌 행만, 이메일은 auth.users 에서.
    assert "jsonb_build_object('user_id', a.user_id, 'email', au.email, 'role', a.account_role)" in body
    assert "and l.is_anonymous = false group by l.user_id, l.account_role" in body
    assert "left join auth.users as au on au.id = a.user_id" in body
    assert "coalesce(acc.accounts_json, '[]'::jsonb)" in body
    assert "[1:10] as ip_list" in body
    assert "and l.event = 'session_start' order by l.received_at, l.id limit 1" in body
    assert "l.props ->> 'referrer' as landing_referrer" in body
    assert "order by l.received_at desc, l.id desc limit 1" in body  # 가장 최근 user_agent
    assert body.rstrip().endswith("order by p.last_seen desc, p.dev; end;")


def test_rows_rpc_pages_by_id_and_shows_email_only_for_registered_rows():
    _, body = _function("action_log_rows")
    body = _norm(body)
    assert "v_limit := least(greatest(coalesce(p_limit, 2000), 1), 5000);" in body
    assert "case when l.is_anonymous = false then au.email::text end" in body
    assert "left join auth.users as au on l.is_anonymous = false and au.id = l.user_id" in body
    assert "and (v_device is null or l.device_id = v_device)" in body
    assert "and l.id > coalesce(p_after_id, 0) order by l.id limit v_limit;" in body


def test_table_comment_and_apply_notes():
    comment = re.search(r"COMMENT ON TABLE public\.action_logs IS(.*?);\n", _CODE, flags=re.S)
    assert comment, "COMMENT ON TABLE 을 찾지 못했다"
    assert "저장:" in comment.group(1) and "저장 안 함:" in comment.group(1)
    # 적용 안내(주석) — 스키마 캐시 갱신과 읽기 전용 확인 쿼리.
    assert "NOTIFY pgrst, 'reload schema';" in _SQL
    assert "from public.action_logs order by id desc limit 20;" in _SQL
    assert "from cron.job where jobname = 'nextspot-action-logs-retention';" in _SQL
