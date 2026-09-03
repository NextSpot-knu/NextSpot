"""20260904090000_account_deletion_fk_fix.sql 검증.

DELETE /api/v1/account/me 는 auth.users 를 지우고, 그 삭제가 public.users 로 연쇄한다.
public.users 를 참조하는 FK 중 ON DELETE 절이 없는(=NO ACTION) 것이 하나라도 남아 있으면
그 자식 행을 가진 계정은 탈퇴가 영구히 실패한다. 이 테스트는 그 회귀를 막는다.
(실 DB 접근 없이 마이그레이션 SQL 본문을 읽어 필수 구문을 단언한다 — 기존
 test_*_migration.py 들과 같은 방식.)
"""

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS = ROOT / "supabase" / "migrations"
MIGRATION = MIGRATIONS / "20260904090000_account_deletion_fk_fix.sql"


def _sql() -> str:
    return MIGRATION.read_text(encoding="utf-8").lower()


def test_both_blocking_fks_are_recreated_with_cascade():
    sql = _sql()
    for table in ("business_verification_requests", "facility_owners"):
        # 실제 제약 이름을 카탈로그에서 찾아 지운 뒤(이름 추측 금지) 다시 만든다.
        assert f"'public.{table}'::regclass" in sql
        assert f"add constraint {table}_user_id_fkey" in sql
        assert re.search(
            rf"add constraint {table}_user_id_fkey\s+foreign key \(user_id\)\s+"
            r"references public\.users\(id\) on delete cascade",
            sql,
        ), f"{table}.user_id 가 ON DELETE CASCADE 로 재정의되지 않았습니다"


def test_facility_owner_history_is_preserved_in_role_audit_log():
    """facility_owners 는 CASCADE 로 지워지되 소유 이력은 role_audit_log 로 옮겨진다."""
    sql = _sql()
    assert "create or replace function public.log_facility_owner_deletion" in sql
    assert "security definer" in sql  # role_audit_log 는 RLS + service_role 전용 쓰기 정책
    assert "after delete on public.facility_owners" in sql
    assert "insert into public.role_audit_log" in sql
    assert "'owner_revoke'" in sql  # role_audit_log_action_check 가 허용하는 값
    # 감사 로그 쓰기가 실패해도 탈퇴는 성공해야 한다 — 그게 이 마이그레이션의 목적이다.
    assert "exception when others" in sql


def test_no_remaining_no_action_fk_to_public_users():
    """migrations 전체에서 public.users 를 참조하는 FK 는 모두 ON DELETE 절을 가져야 한다."""
    offenders: list[str] = []
    for path in sorted(MIGRATIONS.glob("*.sql")):
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("--"):
                continue
            low = stripped.lower()
            if "references public.users(id)" not in low:
                continue
            if "on delete" in low:
                continue
            offenders.append(f"{path.name}:{lineno}: {stripped}")
    # 20260827140000 의 두 줄은 여기서 걸리지만, 20260904090000 이 그 FK 를 CASCADE 로
    # 교체하므로 최종 상태는 안전하다. 그 두 줄 외에 새로운 위반이 생기면 실패한다.
    allowed_files = {"20260827140000_rbac_roles_and_ownership.sql"}
    unexpected = [o for o in offenders if o.split(":")[0] not in allowed_files]
    assert not unexpected, "ON DELETE 절 없는 public.users FK 가 새로 생겼습니다:\n" + "\n".join(
        unexpected
    )
