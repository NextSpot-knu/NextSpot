"""20260904091000_inquiries_insert_ownership.sql 검증.

원래 INSERT 정책은 `WITH CHECK (true)` 에 TO 절도 없어서, 프런트 번들에 들어 있는 anon 키만
있으면 누구나 **남의 user_id 로** 문의를 넣을 수 있었다. 새 정책은 "NULL(익명) 이거나 본인"
만 받는다. 익명 문의 경로는 유지된다.
"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
MIGRATIONS = ROOT / "supabase" / "migrations"
MIGRATION = MIGRATIONS / "20260904091000_inquiries_insert_ownership.sql"


def _sql() -> str:
    return MIGRATION.read_text(encoding="utf-8").lower()


def _statements() -> str:
    """주석(`--`) 줄을 걷어낸 SQL 본문. 주석에 인용한 구 정책이 단언에 걸리지 않게 한다."""
    lines = [
        line
        for line in MIGRATION.read_text(encoding="utf-8").splitlines()
        if not line.strip().startswith("--")
    ]
    return "\n".join(lines).lower()


def test_open_insert_policy_is_dropped():
    sql = _sql()
    assert 'drop policy if exists "allow anonymous or auth inserts on inquiries"' in sql


def test_new_insert_policy_scopes_role_and_ownership():
    sql = _sql()
    assert "create policy inquiries_insert_own_or_anonymous on public.inquiries" in sql
    # TO 절 — service_role/PUBLIC 이 아니라 클라이언트 두 롤에만 적용한다.
    assert "for insert to anon, authenticated" in sql
    # 익명(NULL) 또는 본인만. 남의 uid 는 거부된다.
    assert "with check (user_id is null or user_id = auth.uid())" in sql
    # 클라이언트가 쓰는 정책에는 무조건 통과하는 WITH CHECK (true) 가 남아 있으면 안 된다.
    # (service_role 정책의 (true) 는 백엔드 신뢰 경로라 예외.)
    open_checks = [
        line
        for line in _statements().splitlines()
        if "with check (true)" in line and "service_role" not in line
    ]
    assert not open_checks, f"무조건 통과하는 WITH CHECK 가 남아 있습니다: {open_checks}"


def test_service_role_write_path_is_explicit():
    """구 정책은 TO 절이 없어 service_role 도 덮었다. 좁히면서 명시 정책을 남겨야 한다."""
    sql = _sql()
    assert "create policy inquiries_service_all on public.inquiries" in sql
    assert "for all to service_role" in sql


def test_inquiries_user_id_stays_nullable():
    """새 정책의 익명 가지(user_id IS NULL)는 컬럼이 NULL 을 허용해야 성립한다."""
    create_sql = (MIGRATIONS / "20260531220000_add_inquiries_table.sql").read_text(
        encoding="utf-8"
    ).lower()
    assert "user_id uuid references public.users(id)" in create_sql
    assert "user_id uuid not null" not in create_sql
    # 이후 어떤 마이그레이션도 NOT NULL 을 붙이지 않았는지 확인한다.
    for path in sorted(MIGRATIONS.glob("*.sql")):
        text = path.read_text(encoding="utf-8").lower()
        assert "alter column user_id set not null" not in text or "inquiries" not in text, (
            f"{path.name} 이 inquiries.user_id 에 NOT NULL 을 붙였을 수 있습니다"
        )
