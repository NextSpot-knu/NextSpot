"""정규화 관측 저장 — `zone_crowd_snapshots`(구역 × 10분 버킷).

`docs/SEOUL_TESTBED_PLAN.md` §3 · §7 Q4. 표는 마이그레이션 `20261031120000_crowd_zones.sql` 이 만들고,
원격 적용은 사람이 SQL Editor 에서 한다. API 배포가 먼저 나가는 순서가 실제로 가능하므로 **표가 없어도
수집은 멈추지 않는다** — 이 저장은 기존 `seoul_citydata_snapshots` 저장 옆의 이중 저장이고, 결과는
상태(`migration_not_applied` 등)로만 돌려준다. 예외를 밖으로 내지 않는다.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, Sequence

import structlog

from app.core.supabase import supabase_admin
from app.services.crowd.observation import CrowdObservation

logger = structlog.get_logger()

TABLE = "zone_crowd_snapshots"
MIGRATION = "20261031120000_crowd_zones.sql"

# 10분 버킷(UTC, 1970-01-01 기준) — seoul_citydata_snapshots · pg_cron date_bin 과 같은 경계.
BUCKET = timedelta(minutes=10)
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

_TABLE_MISSING_SIGNALS = ("pgrst205", "42p01", "could not find the table")
# 23503 = 외래키 위반. 대상지가 `zones` 에 정의되지 않았다(시드 없이 대상지만 늘렸다).
_FK_VIOLATION = "23503"


def is_missing_table(exc: BaseException, table: str) -> bool:
    """마이그레이션이 아직 적용되지 않아 `table` 이 없는가. 컬럼 부재(42703)는 여기 넣지 않는다.

    `seoul_citydata_service.is_missing_table` 과 같은 판정이다(그쪽이 이 함수에 위임한다).
    """
    code = str(getattr(exc, "code", "") or "").lower()
    if code in {"pgrst205", "42p01"}:
        return True
    text = str(getattr(exc, "message", None) or exc).lower()
    if any(signal in text for signal in _TABLE_MISSING_SIGNALS):
        return True
    return table in text and "relation" in text and "does not exist" in text and "column" not in text


def _is_fk_violation(exc: BaseException) -> bool:
    code = str(getattr(exc, "code", "") or "")
    text = str(getattr(exc, "message", None) or exc).lower()
    return code == _FK_VIOLATION or "violates foreign key constraint" in text


def _iso(moment: datetime) -> str:
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.isoformat()


def bucket_floor(moment: datetime) -> datetime:
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    moment = moment.astimezone(timezone.utc)
    return _EPOCH + ((moment - _EPOCH) // BUCKET) * BUCKET


def snapshot_row(observation: CrowdObservation, *, bucket_at: datetime | None = None) -> dict[str, Any]:
    """관측 → 표 한 행. DB 접근 없음. 버킷을 주지 않으면 받은 시각(fetched_at)의 10분 버킷이다 —
    수집기의 기존 행(`seoul_citydata_snapshots.bucket_at`)과 같은 규칙이라 두 표의 버킷이 맞물린다."""
    return {
        "zone_id": observation.zone_id,
        "source": observation.source,
        "bucket_at": _iso(bucket_at if bucket_at is not None else bucket_floor(observation.fetched_at)),
        "observed_at": _iso(observation.observed_at),
        "fetched_at": _iso(observation.fetched_at),
        "period_seconds": observation.period_seconds,
        "population_min": observation.population_min,
        "population_max": observation.population_max,
        "population_point": observation.population_point,
        "level": observation.level,
        "level_label": observation.level_label,
        "level_scale": observation.level_scale,
        "forecast": [
            {
                "target_at": _iso(item.target_at),
                "population_min": item.population_min,
                "population_max": item.population_max,
                "level": item.level,
                "level_label": item.level_label,
            }
            for item in observation.forecast
        ],
        "quality": dict(observation.quality),
    }


def _upsert_row(row: dict[str, Any]) -> None:
    # 같은 (구역, 공급원, 버킷) 재수집은 최신 응답으로 덮어쓴다 — seoul_citydata_snapshots 와 같은 멱등.
    supabase_admin.table(TABLE).upsert(row, on_conflict="zone_id,source,bucket_at").execute()


async def persist_observations(
    observations: Sequence[CrowdObservation], *, bucket_at: datetime | None = None
) -> dict[str, Any]:
    """관측을 한 행씩 저장한다. 결과 상태만 돌려주고 예외는 내지 않는다.

    state:
      · ``skipped``               저장할 관측이 없다
      · ``stored``                전부 저장
      · ``partial``               일부만 저장(나머지 사유는 ``errors``)
      · ``migration_not_applied`` 표가 없다 — 첫 행에서 멈춘다(나머지도 같은 이유로 실패한다)
      · ``failed``                하나도 저장하지 못했다
    """
    if not observations:
        return {"state": "skipped", "stored_count": 0, "errors": {}}
    stored = 0
    errors: dict[str, str] = {}
    for observation in observations:
        row = snapshot_row(observation, bucket_at=bucket_at)
        try:
            await asyncio.to_thread(_upsert_row, row)
        except Exception as exc:  # noqa: BLE001 — 이중 저장은 기존 수집을 막지 않는다
            if is_missing_table(exc, TABLE):
                logger.warning("zone_crowd_snapshots_missing", migration=MIGRATION)
                return {
                    "state": "migration_not_applied",
                    "stored_count": stored,
                    "errors": {observation.zone_id: "migration_not_applied"},
                }
            code = "zone_not_defined" if _is_fk_violation(exc) else "zone_snapshot_failed"
            logger.error(
                "zone_crowd_snapshot_persist_failed",
                zone_id=observation.zone_id, error_code=code, error_type=type(exc).__name__,
            )
            errors[observation.zone_id] = code
            continue
        stored += 1
    if not errors:
        state = "stored"
    else:
        state = "partial" if stored else "failed"
    return {"state": state, "stored_count": stored, "errors": errors}
