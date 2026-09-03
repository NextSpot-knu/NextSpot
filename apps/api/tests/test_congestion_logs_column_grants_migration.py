"""congestion_logs 신원 컬럼 차단의 계약.

배포된 번들에서 anon 키를 꺼내면 reporter_user_id 로 사용자 → 장소 → 분 단위 방문 이력이
조회되던 문제. 이 마이그레이션의 **형태**가 핵심이라 그것을 잠근다 — 컬럼 단위 REVOKE 만
써서는 아무 일도 일어나지 않기 때문이다(테이블 SELECT 가 있으면 컬럼 권한은 검사되지 않는다).
"""
from pathlib import Path

HIDDEN = ("reporter_user_id", "origin_outcome_id")
PUBLIC = ("id", "facility_id", "timestamp", "current_count", "congestion_level", "source", "evidence_tier")


def _sql() -> str:
    root = Path(__file__).resolve().parents[3]
    return (root / "supabase/migrations/20260905090000_congestion_logs_column_grants.sql").read_text(
        encoding="utf-8"
    )


def test_table_level_select_is_revoked_first():
    """이 줄이 없으면 아래 GRANT 는 장식이고 신원 컬럼이 그대로 노출된다."""
    sql = _sql()
    assert "REVOKE SELECT ON public.congestion_logs FROM anon, authenticated;" in sql
    revoke_at = sql.index("REVOKE SELECT ON public.congestion_logs")
    grant_at = sql.index("GRANT SELECT (")
    assert revoke_at < grant_at, "GRANT 가 REVOKE 보다 앞서면 권한이 남는다"


def test_identity_columns_are_not_granted_back():
    sql = _sql()
    grant_block = sql[sql.index("GRANT SELECT ("): sql.index("TO anon, authenticated;")]
    for column in HIDDEN:
        assert column not in grant_block, f"{column} 이 다시 부여됐다"


def test_columns_the_screens_read_are_granted():
    """지도·대시보드·신선도 배지가 읽는 컬럼이 빠지면 화면이 죽는다."""
    sql = _sql()
    grant_block = sql[sql.index("GRANT SELECT ("): sql.index("TO anon, authenticated;")]
    for column in PUBLIC:
        assert column in grant_block, f"화면이 읽는 {column} 이 부여되지 않았다"


def test_only_browser_roles_are_touched():
    """백엔드 적재·학습은 service_role 이고 RLS·컬럼 ACL 을 모두 우회한다 — 이 마이그레이션이
    service_role 의 권한을 건드리면 그쪽이 조용히 깨진다."""
    sql = _sql()
    statements = [line for line in sql.splitlines() if not line.lstrip().startswith("--")]
    body = chr(10).join(statements)
    assert "service_role" not in body, "SQL 본문이 service_role 권한을 건드린다"
    assert "FROM anon, authenticated" in body
    assert "TO anon, authenticated" in body
