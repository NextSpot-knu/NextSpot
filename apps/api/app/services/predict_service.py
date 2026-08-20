"""검증된 Supabase Storage 모델의 원자적 로딩과 혼잡 추론.

저장소의 ``model.pkl``은 합성/데모 데이터 모델이므로 운영 추론에 사용하지 않는다.
오직 ``model_registry.status='active'``이고 해시·스키마·품질 게이트를 모두 통과한 비공개
Storage 아티팩트만 메모리에 올라간다. 새 버전 검증 실패 시 기존 정상 스냅샷은 유지된다.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import pickle
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

import structlog

from app.core.supabase import supabase_admin

logger = structlog.get_logger()

MODEL_BUCKET = "recommendation-models"
FEATURE_SCHEMA_VERSION = "congestion-v1:type-hour-dow"
MODEL_REFRESH_SECONDS = 300
MIN_REAL_DATA_COUNT = 300
MIN_HOLDOUT_COUNT = 60
MAX_MAE = 0.15
MIN_BASELINE_IMPROVEMENT = 0.20
MIN_TYPE_COUNT = 50
CANONICAL_TYPES = ("restaurant", "cafe", "attraction", "culture")


@dataclass(frozen=True)
class ModelSnapshot:
    version: str
    model: Any
    encoder: Any
    loaded_at: str
    training_started_at: str
    training_ended_at: str
    real_data_count: int
    metrics: dict


_snapshot: ModelSnapshot | None = None
_state_lock = threading.Lock()
_last_refresh_error: str | None = None
_refresh_task: asyncio.Task | None = None


def normalize_facility_type(facility_type: str) -> str:
    if facility_type in CANONICAL_TYPES:
        return facility_type
    aliases = {
        "음식점": "restaurant", "식당": "restaurant", "cafeteria": "restaurant",
        "카페": "cafe", "coffee": "cafe",
        "관광지": "attraction", "명소": "attraction", "sight": "attraction",
        "문화시설": "culture", "박물관": "culture", "museum": "culture",
    }
    return aliases.get(facility_type, facility_type)


def _validate_registry(row: dict) -> None:
    if row.get("status") != "active":
        raise ValueError("registry row is not active")
    if not re.fullmatch(r"[0-9a-f]{64}", str(row.get("sha256") or "")):
        raise ValueError("invalid sha256 metadata")
    if row.get("feature_schema_version") != FEATURE_SCHEMA_VERSION:
        raise ValueError("feature schema mismatch")

    metrics = row.get("metrics") or {}
    sources = row.get("source_composition") or {}
    if int(row.get("real_data_count") or 0) < MIN_REAL_DATA_COUNT:
        raise ValueError("insufficient verified observations")
    if int(metrics.get("holdout_n") or 0) < MIN_HOLDOUT_COUNT:
        raise ValueError("insufficient seven-day holdout")
    mae = float(metrics.get("mae", 1.0))
    baseline_mae = float(metrics.get("baseline_mae", 0.0))
    improvement = float(metrics.get("baseline_improvement", 0.0))
    if mae > MAX_MAE or baseline_mae <= 0 or improvement < MIN_BASELINE_IMPROVEMENT:
        raise ValueError("quality metrics below promotion threshold")
    type_counts = metrics.get("facility_type_counts") or {}
    active_types = metrics.get("active_facility_types") or list(CANONICAL_TYPES)
    if any(int(type_counts.get(name) or 0) < MIN_TYPE_COUNT for name in active_types):
        raise ValueError("insufficient observations for an active facility type")
    if any(int(sources.get(name) or 0) > 0 for name in ("synthetic", "seed", "simulated", "single_report")):
        raise ValueError("untrusted data source present in official metrics")


def _load_artifact(raw: bytes, row: dict) -> ModelSnapshot:
    if hashlib.sha256(raw).hexdigest() != row["sha256"]:
        raise ValueError("model sha256 mismatch")
    payload = pickle.load(io.BytesIO(raw))
    if not isinstance(payload, dict):
        raise ValueError("model artifact must be a mapping")
    if payload.get("feature_schema_version") != FEATURE_SCHEMA_VERSION:
        raise ValueError("artifact feature schema mismatch")
    model = payload.get("model")
    encoder = payload.get("encoder")
    if model is None or encoder is None or not callable(getattr(model, "predict", None)):
        raise ValueError("artifact model contract mismatch")
    if not hasattr(encoder, "categories_") or len(encoder.categories_) != 3:
        raise ValueError("artifact encoder contract mismatch")
    if (payload.get("metrics") or {}) != (row.get("metrics") or {}):
        raise ValueError("artifact metrics do not match registry")
    return ModelSnapshot(
        version=str(row["version"]), model=model, encoder=encoder,
        loaded_at=datetime.now(timezone.utc).isoformat(),
        training_started_at=str(row["training_started_at"]),
        training_ended_at=str(row["training_ended_at"]),
        real_data_count=int(row["real_data_count"]),
        metrics=dict(row.get("metrics") or {}),
    )


def _fetch_active_snapshot() -> ModelSnapshot | None:
    result = (
        supabase_admin.table("model_registry")
        .select("version,storage_path,sha256,feature_schema_version,status,training_started_at,training_ended_at,real_data_count,source_composition,metrics")
        .eq("status", "active").limit(1).execute()
    )
    if not result.data:
        return None
    row = result.data[0]
    _validate_registry(row)
    current = get_snapshot()
    if current is not None and current.version == row["version"]:
        return current
    raw = supabase_admin.storage.from_(MODEL_BUCKET).download(row["storage_path"])
    return _load_artifact(bytes(raw), row)


def get_snapshot() -> ModelSnapshot | None:
    with _state_lock:
        return _snapshot


async def refresh_active_model() -> bool:
    """활성 버전을 검증 후 한 번에 교체한다. 실패하면 기존 스냅샷을 보존한다."""
    global _snapshot, _last_refresh_error
    try:
        candidate = await asyncio.to_thread(_fetch_active_snapshot)
        if candidate is None:
            _last_refresh_error = "no_active_model"
            logger.warning("predict_model_degraded", reason="no_active_model")
            return False
        with _state_lock:
            changed = _snapshot is None or _snapshot.version != candidate.version
            _snapshot = candidate
        _last_refresh_error = None
        if changed:
            logger.info("predict_model_activated", version=candidate.version)
        return True
    except Exception as exc:
        _last_refresh_error = type(exc).__name__
        logger.error("predict_model_refresh_rejected", error=str(exc))
        return False


async def _refresh_loop() -> None:
    while True:
        await asyncio.sleep(MODEL_REFRESH_SECONDS)
        await refresh_active_model()


async def start_model_manager() -> None:
    global _refresh_task
    await refresh_active_model()
    if _refresh_task is None or _refresh_task.done():
        _refresh_task = asyncio.create_task(_refresh_loop(), name="recommendation-model-refresh")


async def stop_model_manager() -> None:
    global _refresh_task
    if _refresh_task is not None:
        _refresh_task.cancel()
        try:
            await _refresh_task
        except asyncio.CancelledError:
            pass
        _refresh_task = None


def get_model_info() -> dict:
    snapshot = get_snapshot()
    if snapshot is None:
        return {
            "trained": False, "version": None, "loaded_at": None, "real_data_count": 0,
            "training_started_at": None, "training_ended_at": None, "mae": None,
            "baseline_improvement": None, "fallback_state": "degraded_rules",
            "refresh_error": _last_refresh_error,
        }
    return {
        "trained": True, "version": snapshot.version, "loaded_at": snapshot.loaded_at,
        "real_data_count": snapshot.real_data_count,
        "training_started_at": snapshot.training_started_at,
        "training_ended_at": snapshot.training_ended_at,
        "mae": snapshot.metrics.get("mae"),
        "baseline_improvement": snapshot.metrics.get("baseline_improvement"),
        "fallback_state": None, "refresh_error": _last_refresh_error,
    }


def _predict(snapshot: ModelSnapshot, facility_type: str, hour: int, dow: int) -> float | None:
    norm_type = normalize_facility_type(facility_type)
    encoder = snapshot.encoder
    if norm_type not in encoder.categories_[0] or str(hour) not in encoder.categories_[1] or str(dow) not in encoder.categories_[2]:
        return None
    try:
        encoded = encoder.transform([[norm_type, str(hour), str(dow)]])
        return max(0.0, min(1.0, float(snapshot.model.predict(encoded)[0])))
    except Exception as exc:
        logger.warning("predict_inference_error", version=snapshot.version, error=str(exc))
        return None


def predict_congestion_detailed(
    facility_type: str, hour: int, day_of_week: int
) -> tuple[float | None, Literal["registry", "unavailable"]]:
    snapshot = get_snapshot()
    if snapshot is None:
        return None, "unavailable"
    result = _predict(snapshot, facility_type, hour, day_of_week)
    return (result, "registry") if result is not None else (None, "unavailable")


def predict_congestion(facility_type: str, hour: int, day_of_week: int) -> float | None:
    value, _source = predict_congestion_detailed(facility_type, hour, day_of_week)
    return value
