"""주차 파생 추정치 전용 source 마이그레이션의 계약.

라우터/서비스가 쓰는 값과 CHECK 가 허용하는 값이 어긋나면 적재가 통째로 실패한다.
그리고 이 마이그레이션이 잘못되면 **추정치가 실측 자리로 새어 들어간다** — 그쪽이 더 나쁘다.
"""
from pathlib import Path

from app.services.parking_derived_congestion_service import EVIDENCE_TIER, SOURCE

MIGRATION = "supabase/migrations/20260908120000_parking_derived_congestion_source.sql"
# 20260906120000 까지 허용되던 값들. 하나라도 빠지면 그 경로의 INSERT 가 죽는다.
PREVIOUSLY_ALLOWED = (
    "traffic_cctv", "tour_api", "event", "user_report", "merchant_report",
    "admin_override", "seed", "simulated",
)


def _sql() -> str:
    root = Path(__file__).resolve().parents[4]
    return (root / MIGRATION).read_text(encoding="utf-8")


def _body() -> str:
    """주석을 걷어낸 SQL 본문. 주석에 적힌 값이 '허용됐다' 는 증거가 되면 안 된다."""
    return "\n".join(
        line for line in _sql().splitlines() if not line.lstrip().startswith("--")
    )


def test_check_allows_the_value_the_service_actually_writes():
    assert f"'{SOURCE}'" in _body(), (
        f"서비스가 쓰는 source={SOURCE!r} 를 CHECK 가 허용하지 않는다 — 적재가 전부 실패한다"
    )


def test_check_keeps_every_previously_allowed_source():
    body = _body()
    missing = [value for value in PREVIOUSLY_ALLOWED if f"'{value}'" not in body]
    assert not missing, f"기존 허용값이 빠졌다 — 해당 경로의 INSERT 가 죽는다: {missing}"


def test_current_count_not_null_is_dropped():
    """인원수를 모르는 관측이 생겼다. NOT NULL 이 남아 있으면 값을 지어내야만 넣을 수 있다."""
    body = _body()
    assert "ALTER COLUMN current_count DROP NOT NULL" in body


def test_duplicate_guard_exists_and_is_scoped_to_the_new_source():
    """부분 인덱스여야 한다 — 전역 UNIQUE 는 제보·좌석 방송의 정상 중복까지 막는다."""
    body = _body()
    assert "CREATE UNIQUE INDEX IF NOT EXISTS uq_congestion_logs_parking_derived" in body
    index_stmt = body[body.index("CREATE UNIQUE INDEX IF NOT EXISTS uq_congestion_logs_parking_derived"):]
    index_stmt = index_stmt[: index_stmt.index(";")]
    assert f"WHERE source = '{SOURCE}'" in index_stmt


def test_ranking_query_excludes_the_new_source_by_name_too():
    """tier 로 이미 막히지만 두 겹으로 막는다 — 누가 tier 를 잘못 올려도 뚫리지 않게."""
    body = _body()
    assert "latest_congestion_for_facilities" in body
    where = body[body.index("FROM public.congestion_logs"):]
    assert f"'{SOURCE}'" in where, "'지금 혼잡' 조회가 새 source 를 이름으로 배제하지 않는다"
    assert "'seed', 'simulated'" in where, "기존 배제값이 사라졌다"
    # tier 허용목록은 그대로여야 한다 — synthetic 이 여기 들어가면 추정치가 추천에 들어간다.
    assert "c.evidence_tier IN ('single_report', 'corroborated', 'verified')" in where
    assert f"'{EVIDENCE_TIER}'" not in where.split("ORDER BY")[0], (
        f"{EVIDENCE_TIER} 가 '지금 혼잡' 조회의 WHERE 에 들어갔다 — 추정치가 추천에 흘러든다"
    )


def test_migration_is_idempotent():
    """사람이 SQL Editor 에 붙여넣어 적용한다 — 두 번 눌러도 안전해야 한다."""
    body = _body()
    assert "DROP CONSTRAINT IF EXISTS congestion_logs_source_check" in body
    drop_at = body.index("DROP CONSTRAINT IF EXISTS congestion_logs_source_check")
    add_at = body.index("ADD CONSTRAINT congestion_logs_source_check")
    assert drop_at < add_at, "제약을 지우기 전에 다시 만들 수 없다"
    assert "CREATE UNIQUE INDEX IF NOT EXISTS" in body
    assert "CREATE OR REPLACE FUNCTION" in body


def test_existing_rows_are_not_rewritten():
    assert "UPDATE public.congestion_logs" not in _body(), (
        "과거 행을 다시 쓰고 있다 — 이 마이그레이션은 새 종류를 추가할 뿐이다"
    )
