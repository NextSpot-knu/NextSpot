"""10분 지역 수요 스냅샷 수집의 운영 신뢰도를 실측 행으로만 계산한다."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

from app.core.supabase import supabase_admin

BUCKET_MINUTES = 10
_BUCKET_SECONDS = BUCKET_MINUTES * 60
_FRESH_MINUTES = 30
_DELAYED_MINUTES = 60
_ALLOWED_SOURCES = {"gyeongju_its", "national_parking_api"}


class AreaDemandReliabilityError(RuntimeError):
    """신뢰도 계산에 필요한 운영 테이블을 안전하게 조회하지 못했다."""


def _parse_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise AreaDemandReliabilityError("invalid_snapshot_timestamp") from exc
    else:
        raise AreaDemandReliabilityError("invalid_snapshot_timestamp")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise AreaDemandReliabilityError("invalid_snapshot_timestamp")
    return parsed.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _floor_to_bucket(value: datetime) -> datetime:
    timestamp = int(value.astimezone(timezone.utc).timestamp())
    return datetime.fromtimestamp(timestamp // _BUCKET_SECONDS * _BUCKET_SECONDS, tz=timezone.utc)


def _query_window(source: str, start_at: datetime, end_at: datetime) -> list[dict[str, Any]]:
    result = (
        supabase_admin.table("area_demand_snapshots")
        .select("id,bucket_at")
        .eq("source", source)
        .eq("bucket_minutes", BUCKET_MINUTES)
        .gte("bucket_at", _iso(start_at))
        .lt("bucket_at", _iso(end_at))
        .order("bucket_at")
        .limit(1008)
        .execute()
    )
    return result.data or []


def _query_boundary(source: str, *, latest: bool) -> dict[str, Any] | None:
    fields = (
        "id,source,observed_at,bucket_at,total_spaces,available_spaces,"
        "occupancy,live_lot_count"
        if latest
        else "id,bucket_at"
    )
    result = (
        supabase_admin.table("area_demand_snapshots")
        .select(fields)
        .eq("source", source)
        .eq("bucket_minutes", BUCKET_MINUTES)
        .order("bucket_at", desc=latest)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def _query_lots(snapshot_id: str) -> list[dict[str, Any]]:
    result = (
        supabase_admin.table("area_demand_snapshot_lots")
        .select(
            "source_lot_id,name,latitude,longitude,total_spaces,"
            "available_spaces,occupancy"
        )
        .eq("snapshot_id", snapshot_id)
        .order("name")
        .limit(500)
        .execute()
    )
    return result.data or []


def _freshness(observed_at: datetime, now: datetime) -> tuple[float, str]:
    age_minutes = (now - observed_at).total_seconds() / 60
    if age_minutes < -5:
        return round(age_minutes, 1), "future_timestamp"
    age_minutes = max(0.0, age_minutes)
    if age_minutes <= _FRESH_MINUTES:
        state = "fresh"
    elif age_minutes <= _DELAYED_MINUTES:
        state = "delayed"
    else:
        state = "stale"
    return round(age_minutes, 1), state


def _missing_metrics(
    *, start_at: datetime, expected_count: int, received: set[datetime]
) -> tuple[list[str], int]:
    missing: list[str] = []
    longest_gap = 0
    current_gap = 0
    for offset in range(expected_count):
        bucket = start_at + timedelta(minutes=BUCKET_MINUTES * offset)
        if bucket in received:
            current_gap = 0
            continue
        missing.append(_iso(bucket))
        current_gap += 1
        longest_gap = max(longest_gap, current_gap)
    return missing, longest_gap


async def get_area_demand_reliability(
    *,
    source: str = "gyeongju_its",
    hours: int = 24,
    now: datetime | None = None,
) -> dict[str, Any]:
    """완료된 10분 버킷의 누락과 최신 실측 상태를 service role로 집계한다."""
    if source not in _ALLOWED_SOURCES or not 1 <= hours <= 168:
        raise ValueError("invalid_reliability_window")
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    # 진행 중 버킷은 아직 스케줄 실행 전일 수 있으므로 누락 판정에서 제외한다.
    end_at = _floor_to_bucket(current)
    start_at = end_at - timedelta(hours=hours)
    expected_count = hours * (60 // BUCKET_MINUTES)

    try:
        window_rows, earliest, latest = await asyncio.gather(
            asyncio.to_thread(_query_window, source, start_at, end_at),
            asyncio.to_thread(_query_boundary, source, latest=False),
            asyncio.to_thread(_query_boundary, source, latest=True),
        )
    except AreaDemandReliabilityError:
        raise
    except Exception as exc:
        raise AreaDemandReliabilityError("snapshot_query_failed") from exc

    received: set[datetime] = set()
    for row in window_rows:
        bucket = _parse_timestamp(row.get("bucket_at"))
        if start_at <= bucket < end_at:
            received.add(bucket)
    missing, longest_gap = _missing_metrics(
        start_at=start_at,
        expected_count=expected_count,
        received=received,
    )

    earliest_bucket = _parse_timestamp(earliest["bucket_at"]) if earliest else None
    if latest is None:
        history_state = "no_data"
    elif earliest_bucket is None or earliest_bucket > start_at:
        history_state = "insufficient_history"
    else:
        history_state = "sufficient_history"

    latest_payload = None
    lots: list[dict[str, Any]] = []
    if latest is not None:
        try:
            observed_at = _parse_timestamp(latest.get("observed_at"))
            bucket_at = _parse_timestamp(latest.get("bucket_at"))
            occupancy = float(latest["occupancy"])
            age_minutes, freshness_state = _freshness(observed_at, current)
            latest_payload = {
                "snapshot_id": str(latest["id"]),
                "observed_at": _iso(observed_at),
                "bucket_at": _iso(bucket_at),
                "age_minutes": age_minutes,
                "freshness_state": freshness_state,
                "live_lot_count": int(latest["live_lot_count"]),
                "total_spaces": int(latest["total_spaces"]),
                "available_spaces": int(latest["available_spaces"]),
                "occupancy": occupancy,
            }
            lots = await asyncio.to_thread(_query_lots, str(latest["id"]))
            lots = [
                {
                    "source_lot_id": str(row["source_lot_id"]),
                    "name": str(row["name"]),
                    "latitude": float(row["latitude"]),
                    "longitude": float(row["longitude"]),
                    "total_spaces": int(row["total_spaces"]),
                    "available_spaces": int(row["available_spaces"]),
                    "occupancy": float(row["occupancy"]),
                }
                for row in lots
            ]
            latest_payload["lot_detail_count"] = len(lots)
            latest_payload["lot_details_complete"] = (
                len(lots) == latest_payload["live_lot_count"]
            )
        except AreaDemandReliabilityError:
            raise
        except Exception as exc:
            raise AreaDemandReliabilityError("snapshot_query_failed") from exc

    received_count = len(received)
    missing_count = len(missing)
    return {
        "source": source,
        "history_state": history_state,
        "first_bucket_at": _iso(earliest_bucket) if earliest_bucket else None,
        "window": {
            "hours": hours,
            "bucket_minutes": BUCKET_MINUTES,
            "start_at": _iso(start_at),
            "end_at": _iso(end_at),
            "end_exclusive": True,
            "expected_bucket_count": expected_count,
            "received_bucket_count": received_count,
            "missing_bucket_count": missing_count,
            "missing_rate": round(missing_count / expected_count, 4),
            "missing_buckets": missing,
            "longest_gap_buckets": longest_gap,
            "longest_gap_minutes": longest_gap * BUCKET_MINUTES,
            "complete": missing_count == 0,
        },
        "latest": latest_payload,
        "lots": lots,
    }
