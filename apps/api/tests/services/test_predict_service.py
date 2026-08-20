import hashlib
import pickle
from datetime import datetime, timezone

import pytest
from sklearn.linear_model import Ridge
from sklearn.preprocessing import OneHotEncoder

from app.services import predict_service as service


def _metrics():
    return {
        "mae": 0.1, "baseline_mae": 0.14, "baseline_improvement": 0.2857,
        "holdout_n": 60,
        "facility_type_counts": {name: 75 for name in service.CANONICAL_TYPES},
        "active_facility_types": list(service.CANONICAL_TYPES),
    }


def _artifact(schema=service.FEATURE_SCHEMA_VERSION):
    encoder = OneHotEncoder(handle_unknown="ignore", sparse_output=False)
    rows = [[name, str(hour), str(dow)] for name in service.CANONICAL_TYPES for hour in range(24) for dow in range(7)]
    encoded = encoder.fit_transform(rows)
    model = Ridge().fit(encoded, [0.4] * len(rows))
    return pickle.dumps({
        "model": model, "encoder": encoder, "metrics": _metrics(),
        "feature_schema_version": schema,
    })


def _row(raw: bytes, **updates):
    row = {
        "version": "v1", "storage_path": "v1/model.pkl",
        "sha256": hashlib.sha256(raw).hexdigest(), "feature_schema_version": service.FEATURE_SCHEMA_VERSION,
        "status": "active", "training_started_at": "2026-01-01T00:00:00+00:00",
        "training_ended_at": "2026-08-01T00:00:00+00:00", "real_data_count": 300,
        "source_composition": {"verified": 300, "corroborated": 0, "synthetic": 0, "single_report": 0},
        "metrics": _metrics(),
    }
    row.update(updates)
    return row


@pytest.fixture(autouse=True)
def _reset_state(monkeypatch):
    monkeypatch.setattr(service, "_snapshot", None)
    monkeypatch.setattr(service, "_last_refresh_error", None)


def test_no_active_model_never_returns_arbitrary_half():
    value, source = service.predict_congestion_detailed("cafe", 12, 3)
    assert value is None
    assert source == "unavailable"
    assert service.predict_congestion("cafe", 12, 3) is None
    assert service.get_model_info()["fallback_state"] == "degraded_rules"


def test_valid_registry_artifact_loads_without_exposing_storage_path():
    raw = _artifact()
    snapshot = service._load_artifact(raw, _row(raw))
    service._snapshot = snapshot
    value, source = service.predict_congestion_detailed("cafe", 12, 3)
    assert source == "registry"
    assert 0 <= value <= 1
    info = service.get_model_info()
    assert info["version"] == "v1"
    assert "storage_path" not in info


@pytest.mark.parametrize("mutation", ["hash", "schema", "metrics"])
def test_tampered_or_invalid_artifact_is_rejected(mutation):
    raw = _artifact()
    row = _row(raw)
    if mutation == "hash":
        raw += b"tampered"
    elif mutation == "schema":
        row["feature_schema_version"] = "wrong"
        with pytest.raises(ValueError, match="schema"):
            service._validate_registry(row)
        return
    else:
        row["metrics"] = {**row["metrics"], "mae": 0.2}
        with pytest.raises(ValueError, match="quality"):
            service._validate_registry(row)
        return
    with pytest.raises(ValueError, match="sha256"):
        service._load_artifact(raw, row)


@pytest.mark.asyncio
async def test_failed_refresh_keeps_previous_snapshot(monkeypatch):
    raw = _artifact()
    previous = service._load_artifact(raw, _row(raw))
    service._snapshot = previous

    def fail():
        raise OSError("download failed")

    monkeypatch.setattr(service, "_fetch_active_snapshot", fail)
    assert await service.refresh_active_model() is False
    assert service.get_snapshot() is previous
    assert service.get_model_info()["trained"] is True


def test_loaded_timestamp_is_server_generated():
    raw = _artifact()
    snapshot = service._load_artifact(raw, _row(raw))
    assert datetime.fromisoformat(snapshot.loaded_at).tzinfo == timezone.utc
