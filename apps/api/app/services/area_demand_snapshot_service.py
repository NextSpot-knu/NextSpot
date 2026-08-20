"""경주시 ITS 실측 주차면을 15분 시계열로 영속한다.

이 서비스는 예측을 만들지 않는다. 공급자가 현재 제공한 총 주차면과 잔여면만 저장하고,
점유율은 DB generated column이 계산한다. 부모 행은 현재 실시간 값을 제공하는 ITS 주차장
전체의 네트워크 집계이며, 위치별 수요는 자식 주차장 좌표로 반경을 다시 계산해야 한다.
동일 15분 버킷 재호출은 upsert로 멱등이다.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

from app.core.supabase import supabase_admin
from app.services.parking_demand_service import fetch_current_gyeongju_parking_snapshot


class SnapshotPersistenceError(RuntimeError):
    """실측 조회는 성공했지만 스냅샷 영속화가 실패했다."""


_ALLOWED_FACTUAL_SOURCES = {"gyeongju_its", "national_parking_api"}


def _persist_snapshot(observation: dict[str, Any]) -> dict[str, Any]:
    source = observation.get("source")
    observed_at = observation.get("observed_at")
    lots = observation.get("lots")
    if (
        source not in _ALLOWED_FACTUAL_SOURCES
        or not isinstance(observed_at, datetime)
        or observed_at.tzinfo is None
        or observed_at.utcoffset() is None
        or not isinstance(lots, list)
        or not lots
    ):
        raise SnapshotPersistenceError("invalid_snapshot_observation")
    for lot in lots:
        try:
            total = int(lot["total_spaces"])
            available = int(lot["available_spaces"])
            latitude = float(lot["latitude"])
            longitude = float(lot["longitude"])
            source_lot_id = str(lot["source_lot_id"]).strip()
            name = str(lot["name"]).strip()
        except (KeyError, TypeError, ValueError) as exc:
            raise SnapshotPersistenceError("invalid_snapshot_observation") from exc
        if (
            total <= 0
            or not 0 <= available <= total
            or not -90 <= latitude <= 90
            or not -180 <= longitude <= 180
            or not source_lot_id
            or not name
        ):
            raise SnapshotPersistenceError("invalid_snapshot_observation")

    # 부모 집계, 15분 버킷, 자식 교체를 DB 함수 한 트랜잭션에서 처리한다. 분리된 REST
    # upsert는 두 번째 요청 실패 시 부모/자식이 어긋날 수 있으므로 사용하지 않는다.
    result = supabase_admin.rpc("record_area_demand_snapshot", {
        "p_source": source,
        "p_observed_at": observed_at.isoformat(),
        "p_lots": lots,
    }).execute()
    payload = result.data
    if isinstance(payload, list) and payload:
        payload = payload[0]
    if not isinstance(payload, dict) or not payload.get("id"):
        raise SnapshotPersistenceError("snapshot_result_missing")
    required = {
        "source", "observed_at", "bucket_at", "total_spaces", "available_spaces",
        "live_lot_count", "stored",
    }
    if not required.issubset(payload):
        raise SnapshotPersistenceError("snapshot_result_invalid")
    return {
        "snapshot_id": str(payload["id"]),
        "source": payload["source"],
        "observed_at": str(payload["observed_at"]),
        "bucket_at": str(payload["bucket_at"]),
        "total_spaces": int(payload["total_spaces"]),
        "available_spaces": int(payload["available_spaces"]),
        "live_lot_count": int(payload["live_lot_count"]),
        "stored": bool(payload["stored"]),
    }


async def collect_area_demand_snapshot() -> dict[str, Any]:
    """현재 ITS 관측치를 조회한 뒤 Supabase에 멱등 저장한다."""
    observation = await fetch_current_gyeongju_parking_snapshot()
    try:
        return await asyncio.to_thread(_persist_snapshot, observation)
    except SnapshotPersistenceError:
        raise
    except Exception as exc:
        raise SnapshotPersistenceError("snapshot_persistence_failed") from exc
