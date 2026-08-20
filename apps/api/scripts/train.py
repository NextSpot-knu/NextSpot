"""검증된 실데이터 전용 혼잡 모델 후보 생성·승격·롤백 CLI.

seed/simulated/single_report는 학습과 공식 평가에서 구조적으로 제외한다. 최근 7일을
홀드아웃으로 고정하고 모든 품질 게이트를 통과한 후보만 Registry/비공개 Storage에 올린다.
첫 두 후보는 candidate로 남기며 이후 후보는 기준 통과 시 원자적으로 자동 승격한다.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import os
import pickle
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error
from sklearn.preprocessing import OneHotEncoder

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
API_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.append(API_DIR)
load_dotenv(os.path.join(API_DIR, ".env"))

from app.core.config import settings
from app.core.supabase import fetch_all_rows
from app.services.predict_service import (
    CANONICAL_TYPES,
    FEATURE_SCHEMA_VERSION,
    MAX_MAE,
    MIN_BASELINE_IMPROVEMENT,
    MIN_HOLDOUT_COUNT,
    MIN_REAL_DATA_COUNT,
    MIN_TYPE_COUNT,
    MODEL_BUCKET,
    normalize_facility_type,
)

TRUSTED_TIERS = {"verified", "corroborated"}


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def fit_model(rows: list[tuple[datetime, str, float]]) -> tuple[Ridge, OneHotEncoder]:
    raw = [[facility_type, str(ts.hour), str(ts.weekday())] for ts, facility_type, _ in rows]
    encoder = OneHotEncoder(handle_unknown="ignore", sparse_output=False)
    encoded = encoder.fit_transform(raw)
    model = Ridge(alpha=1.0)
    model.fit(encoded, [value for _, _, value in rows])
    return model, encoder


def _baseline_predictions(
    train: list[tuple[datetime, str, float]], holdout: list[tuple[datetime, str, float]]
) -> list[float]:
    buckets: dict[tuple[str, int, int], list[float]] = defaultdict(list)
    by_type: dict[str, list[float]] = defaultdict(list)
    for ts, facility_type, value in train:
        buckets[(facility_type, ts.weekday(), ts.hour)].append(value)
        by_type[facility_type].append(value)
    global_mean = statistics.mean(value for _, _, value in train)
    return [
        statistics.mean(buckets[(facility_type, ts.weekday(), ts.hour)])
        if buckets[(facility_type, ts.weekday(), ts.hour)]
        else statistics.mean(by_type[facility_type]) if by_type[facility_type] else global_mean
        for ts, facility_type, _ in holdout
    ]


def collect_rows(client) -> tuple[list[tuple[datetime, str, float]], dict, list[str]]:
    facilities = fetch_all_rows(client, "facilities", "id,type,is_active")
    facility_types = {str(row["id"]): normalize_facility_type(str(row["type"])) for row in facilities}
    active_types = sorted({
        normalize_facility_type(str(row["type"])) for row in facilities if row.get("is_active", True)
    })

    logs = fetch_all_rows(
        client, "congestion_logs",
        "facility_id,timestamp,congestion_level,source,evidence_tier,reporter_user_id",
    )
    rows: list[tuple[datetime, str, float]] = []
    sources = Counter({"verified": 0, "corroborated": 0, "synthetic": 0, "single_report": 0, "seed": 0, "simulated": 0})
    corroborated_logs: dict[tuple[str, datetime], list[float]] = defaultdict(list)
    for log in logs:
        tier = str(log.get("evidence_tier") or "synthetic")
        source = str(log.get("source") or "")
        if tier not in TRUSTED_TIERS:
            continue
        ts = parse_time(log.get("timestamp"))
        facility_type = facility_types.get(str(log.get("facility_id")))
        if ts is None or facility_type not in CANONICAL_TYPES:
            continue
        if tier == "corroborated":
            bucket = ts.replace(minute=(ts.minute // 30) * 30, second=0, microsecond=0)
            corroborated_logs[(facility_type, bucket)].append(float(log["congestion_level"]))
        else:
            rows.append((ts, facility_type, float(log["congestion_level"])))
            sources[tier] += 1
        if source in {"seed", "simulated"}:
            # 방어적 이중 게이트: 잘못 승격된 synthetic source도 공식 모델을 즉시 실패시킨다.
            sources[source] += 1

    for (facility_type, bucket), values in corroborated_logs.items():
        rows.append((bucket, facility_type, statistics.median(values)))
        sources["corroborated"] += 1

    return sorted(rows, key=lambda row: row[0]), dict(sources), active_types


def evaluate(rows: list[tuple[datetime, str, float]], active_types: list[str]) -> tuple[dict, Ridge, OneHotEncoder]:
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=7)
    train = [row for row in rows if row[0] < cutoff]
    holdout = [row for row in rows if row[0] >= cutoff]
    counts = Counter(facility_type for _, facility_type, _ in rows)
    failures = []
    if len(rows) < MIN_REAL_DATA_COUNT:
        failures.append(f"verified observations {len(rows)} < {MIN_REAL_DATA_COUNT}")
    for facility_type in active_types:
        if counts[facility_type] < MIN_TYPE_COUNT:
            failures.append(f"{facility_type} observations {counts[facility_type]} < {MIN_TYPE_COUNT}")
    if len(holdout) < MIN_HOLDOUT_COUNT:
        failures.append(f"seven-day holdout {len(holdout)} < {MIN_HOLDOUT_COUNT}")
    if not train:
        failures.append("training window is empty")
    if failures:
        raise RuntimeError("; ".join(failures))

    eval_model, eval_encoder = fit_model(train)
    encoded_holdout = eval_encoder.transform([[kind, str(ts.hour), str(ts.weekday())] for ts, kind, _ in holdout])
    predicted = [max(0.0, min(1.0, float(value))) for value in eval_model.predict(encoded_holdout)]
    actual = [value for _, _, value in holdout]
    mae = float(mean_absolute_error(actual, predicted))
    baseline_predictions = _baseline_predictions(train, holdout)
    baseline_mae = float(mean_absolute_error(actual, baseline_predictions))
    improvement = (baseline_mae - mae) / baseline_mae if baseline_mae else 0.0
    per_type = {}
    for facility_type in active_types:
        positions = [index for index, row in enumerate(holdout) if row[1] == facility_type]
        if not positions:
            raise RuntimeError(f"seven-day holdout has no {facility_type} observations")
        per_type[facility_type] = round(float(mean_absolute_error(
            [actual[index] for index in positions], [predicted[index] for index in positions]
        )), 4)

    if mae > MAX_MAE:
        raise RuntimeError(f"MAE {mae:.4f} > {MAX_MAE}")
    if improvement < MIN_BASELINE_IMPROVEMENT:
        raise RuntimeError(f"baseline improvement {improvement:.2%} < {MIN_BASELINE_IMPROVEMENT:.0%}")

    final_model, final_encoder = fit_model(rows)
    metrics = {
        "mae": round(mae, 4), "baseline_mae": round(baseline_mae, 4),
        "baseline_improvement": round(improvement, 4),
        "train_n": len(train), "holdout_n": len(holdout),
        "holdout_start": cutoff.isoformat(),
        "facility_type_counts": dict(counts), "active_facility_types": active_types,
        "per_type_mae": per_type, "evaluated_at": now.isoformat(),
    }
    return metrics, final_model, final_encoder


def enforce_active_regression(client, metrics: dict) -> None:
    result = client.table("model_registry").select("metrics").eq("status", "active").limit(1).execute()
    if not result.data:
        return
    previous = (result.data[0].get("metrics") or {}).get("per_type_mae") or {}
    for facility_type, new_mae in metrics["per_type_mae"].items():
        old_mae = previous.get(facility_type)
        if old_mae is not None and float(new_mae) - float(old_mae) > 0.03:
            raise RuntimeError(f"{facility_type} MAE regression exceeds 0.03")


def promote(client, version: str) -> None:
    client.rpc("promote_recommendation_model", {"p_version": version}).execute()
    retained = (
        client.table("model_registry").select("id,version,storage_path,status,activated_at")
        .in_("status", ["active", "rolled_back"]).order("activated_at", desc=True).execute()
    )
    for old in (retained.data or [])[3:]:
        client.table("model_registry").update({"status": "rejected"}).eq("id", old["id"]).execute()
        client.storage.from_(MODEL_BUCKET).remove([old["storage_path"]])
    print(f"active model: {version}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--promote-version")
    parser.add_argument("--rollback-version")
    args = parser.parse_args()

    from supabase import create_client
    client = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
    if args.promote_version or args.rollback_version:
        target = args.promote_version or args.rollback_version
        if args.rollback_version:
            status = client.table("model_registry").select("status").eq("version", target).limit(1).execute()
            if not status.data or status.data[0].get("status") != "rolled_back":
                raise RuntimeError("rollback target must be a retained rolled_back model")
        promote(client, target)
        return

    rows, sources, active_types = collect_rows(client)
    if sources.get("seed", 0) or sources.get("simulated", 0) or sources.get("synthetic", 0) or sources.get("single_report", 0):
        raise RuntimeError("untrusted observations entered official dataset")
    metrics, model, encoder = evaluate(rows, active_types)
    enforce_active_regression(client, metrics)

    now = datetime.now(timezone.utc)
    version = now.strftime("congestion-%Y%m%dT%H%M%SZ")
    payload = {
        "model": model, "encoder": encoder, "metrics": metrics,
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
    }
    buffer = io.BytesIO()
    pickle.dump(payload, buffer)
    raw = buffer.getvalue()
    digest = hashlib.sha256(raw).hexdigest()
    storage_path = f"{version}/model.pkl"
    registry = {
        "version": version, "storage_path": storage_path, "sha256": digest,
        "feature_schema_version": FEATURE_SCHEMA_VERSION, "status": "candidate",
        "training_started_at": rows[0][0].isoformat(), "training_ended_at": rows[-1][0].isoformat(),
        "real_data_count": len(rows), "source_composition": sources, "metrics": metrics,
    }
    print(f"candidate {version}: n={len(rows)}, MAE={metrics['mae']}, improvement={metrics['baseline_improvement']:.1%}")
    if args.dry_run:
        return

    client.storage.from_(MODEL_BUCKET).upload(
        storage_path, raw,
        file_options={"content-type": "application/octet-stream", "upsert": "false"},
    )
    try:
        client.table("model_registry").insert(registry).execute()
    except Exception:
        client.storage.from_(MODEL_BUCKET).remove([storage_path])
        raise

    generated = client.table("model_registry").select("id").order("created_at").limit(3).execute()
    if len(generated.data or []) <= 2:
        print("manual approval required for one of the first two candidates")
    else:
        promote(client, version)


if __name__ == "__main__":
    main()
