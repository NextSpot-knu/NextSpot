"""관리자 오버라이드 전용 source 값의 계약.

라우터가 쓰는 값과 CHECK 가 허용하는 값이 어긋나면 관리자 오버라이드가 통째로 500 이 된다.
그 둘을 한 파일에서 대조한다 — 마이그레이션과 코드는 다른 순간에 배포되므로, 어긋남을
사람이 눈으로 맞추게 두면 언젠가 어긋난다.
"""
from pathlib import Path

from app.routers.admin import _ADMIN_OVERRIDE_SOURCE

MIGRATION = "supabase/migrations/20260906120000_admin_override_source.sql"
# 20260820123000 까지 허용되던 값들. 새 마이그레이션이 이 중 하나라도 빠뜨리면
# 기존 경로(사장님 좌석 방송·제보·시드)의 INSERT 가 죽는다.
PREVIOUSLY_ALLOWED = (
    "traffic_cctv", "tour_api", "event", "user_report", "merchant_report", "seed", "simulated",
)


def _sql() -> str:
    root = Path(__file__).resolve().parents[4]
    return (root / MIGRATION).read_text(encoding="utf-8")


def test_check_allows_the_value_the_router_actually_writes():
    assert f"'{_ADMIN_OVERRIDE_SOURCE}'" in _sql(), (
        f"라우터가 쓰는 source={_ADMIN_OVERRIDE_SOURCE!r} 를 CHECK 가 허용하지 않는다 — "
        "이 조합이면 관리자 오버라이드가 500 이다"
    )


def test_check_keeps_every_previously_allowed_source():
    sql = _sql()
    missing = [value for value in PREVIOUSLY_ALLOWED if f"'{value}'" not in sql]
    assert not missing, f"기존 허용값이 빠졌다 — 해당 경로의 INSERT 가 죽는다: {missing}"


def test_migration_is_idempotent():
    """사람이 SQL Editor 에 붙여넣어 적용한다 — 두 번 눌러도 안전해야 한다."""
    sql = _sql()
    assert "DROP CONSTRAINT IF EXISTS congestion_logs_source_check" in sql
    drop_at = sql.index("DROP CONSTRAINT IF EXISTS congestion_logs_source_check")
    add_at = sql.index("ADD CONSTRAINT congestion_logs_source_check")
    assert drop_at < add_at, "제약을 지우기 전에 다시 만들 수 없다"


def test_existing_rows_are_not_rewritten():
    """과거 source='event' 행이 관리자 개입인지 실제 관측인지 구분할 근거가 없다.

    추측해서 UPDATE 하면 그때부터 로그가 사실이 아니게 된다. 구분은 이 시점 이후부터다.
    """
    sql = _sql()
    assert "UPDATE public.congestion_logs" not in sql, (
        "구분할 근거가 없는 과거 행을 다시 쓰고 있다"
    )
