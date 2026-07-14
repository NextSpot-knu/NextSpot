"""혼잡 예측 모델 학습 + 백테스트(홀드아웃 평가) 스크립트.

사용법:
  python scripts/train.py               # 전체 데이터 학습 → model.pkl 저장
  python scripts/train.py --evaluate    # 시간순 홀드아웃(뒤 20%) MAE 백테스트 후 전체 재학습·저장

--evaluate 는 로그를 시간순 정렬해 앞 80%로 학습, 뒤 20%로 MAE 를 측정한다(미래 데이터가
학습에 새어 들어가지 않는 time-ordered split). 비교 기준선은 '학습 구간 평균값 상수 예측'의
MAE — 모델이 기준선보다 얼마나 나은지가 실질 성능이다. 측정 결과는 model.pkl 의 metrics 로
내장돼 GET /predict/model-info 와 관리자 대시보드 정확도 배지가 그대로 노출한다.
평가 프로토콜·한계는 docs/MODEL_CARD.md 참조.
"""
import argparse
import os
import sys
import pickle
from datetime import datetime, timezone
from supabase import create_client
from sklearn.metrics import mean_absolute_error
from sklearn.preprocessing import OneHotEncoder
from sklearn.linear_model import Ridge
from dotenv import load_dotenv

# Add parent directory of this script's directory to sys.path
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.append(parent_dir)

# Load env variables if running outside project root
load_dotenv(os.path.join(parent_dir, ".env"))

# Import settings from app.core.config
from app.core.config import settings
from app.core.supabase import fetch_all_rows

HOLDOUT_RATIO = 0.2      # 시간순 뒤쪽 20% 를 평가용으로 사용
MIN_EVAL_ROWS = 50       # 이보다 적으면 홀드아웃 통계가 무의미 — 평가 생략

def normalize_facility_type(facility_type: str) -> str:
    # 관광 canonical 4타입: restaurant / cafe / attraction / culture
    # (predict_service.normalize_facility_type 와 동일 로직 유지 — 학습/추론 버킷 정합)
    if facility_type in ["restaurant", "cafe", "attraction", "culture"]:
        return facility_type
    aliases = {
        "음식점": "restaurant", "식당": "restaurant", "cafeteria": "restaurant",
        "카페": "cafe", "coffee": "cafe",
        "관광지": "attraction", "명소": "attraction", "sight": "attraction",
        "문화시설": "culture", "박물관": "culture", "museum": "culture",
    }
    return aliases.get(facility_type, facility_type)


def fit_model(X_raw: list[list[str]], y: list[float]) -> tuple[Ridge, OneHotEncoder]:
    """OneHot([norm_type, hour, dow]) + Ridge 학습 — 추론(predict_service)과 동일 포맷."""
    encoder = OneHotEncoder(handle_unknown='ignore', sparse_output=False)
    X = encoder.fit_transform(X_raw)
    ridge = Ridge(alpha=1.0)
    ridge.fit(X, y)
    return ridge, encoder


def evaluate_holdout(rows: list[tuple[datetime, list[str], float]]) -> dict | None:
    """시간순 홀드아웃 백테스트 — MAE(모델) vs MAE(학습구간 평균 상수 예측)."""
    if len(rows) < MIN_EVAL_ROWS:
        print(f"평가 생략: 로그 {len(rows)}행 < 최소 {MIN_EVAL_ROWS}행 (홀드아웃 통계 무의미)")
        return None

    rows_sorted = sorted(rows, key=lambda r: r[0])
    split = int(len(rows_sorted) * (1.0 - HOLDOUT_RATIO))
    train_rows, hold_rows = rows_sorted[:split], rows_sorted[split:]

    X_train = [r[1] for r in train_rows]
    y_train = [r[2] for r in train_rows]
    X_hold = [r[1] for r in hold_rows]
    y_hold = [r[2] for r in hold_rows]

    model, encoder = fit_model(X_train, y_train)
    y_pred = [max(0.0, min(1.0, p)) for p in model.predict(encoder.transform(X_hold))]
    mae = mean_absolute_error(y_hold, y_pred)

    # 기준선: 학습 구간 평균값 상수 예측 (모델이 이보다 못하면 학습 무의미)
    train_mean = sum(y_train) / len(y_train)
    baseline_mae = mean_absolute_error(y_hold, [train_mean] * len(y_hold))

    metrics = {
        "mae": round(float(mae), 4),
        "baseline_mae": round(float(baseline_mae), 4),
        "train_n": len(train_rows),
        "holdout_n": len(hold_rows),
        "holdout_start": hold_rows[0][0].isoformat(),
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
    }
    print(
        f"백테스트(시간순 홀드아웃 {int(HOLDOUT_RATIO * 100)}%): "
        f"MAE={metrics['mae']:.4f} (기준선 평균예측 MAE={metrics['baseline_mae']:.4f}) · "
        f"학습 {metrics['train_n']}행 / 평가 {metrics['holdout_n']}행"
    )
    return metrics


def main():
    parser = argparse.ArgumentParser(description="혼잡 예측 모델 학습 (+ --evaluate 홀드아웃 백테스트)")
    parser.add_argument("--evaluate", action="store_true", help="시간순 홀드아웃 MAE 평가 후 전체 재학습·저장")
    args = parser.parse_args()

    supabase_url = settings.SUPABASE_URL
    supabase_key = settings.SUPABASE_KEY

    if not supabase_url or not supabase_key:
        print("Error: SUPABASE_URL or SUPABASE_KEY is missing in settings.")
        sys.exit(1)

    supabase = create_client(supabase_url, supabase_key)

    # 1. Retrieve all facilities
    print("Retrieving facilities...")
    try:
        facilities_res = supabase.table("facilities").select("id, type").execute()
        facilities = facilities_res.data
    except Exception as e:
        print(f"Error querying facilities: {e}")
        sys.exit(1)

    facility_map = {f["id"]: f["type"] for f in facilities}
    print(f"Retrieved {len(facilities)} facilities.")

    # 2. Retrieve all congestion logs (공용 페이지네이션 헬퍼 — PostgREST 행수 캡 우회)
    print("Retrieving congestion logs...")
    try:
        logs = fetch_all_rows(supabase, "congestion_logs", "facility_id, timestamp, congestion_level")
    except Exception as e:
        print(f"Error querying congestion logs: {e}")
        sys.exit(1)

    print(f"Retrieved {len(logs)} congestion logs.")

    if not logs:
        print("Error: No congestion logs found.")
        sys.exit(1)

    # 3. Join + feature engineering — (timestamp, [norm_type, hour, dow], y) 행으로 수집.
    #    timestamp 를 유지하는 이유: --evaluate 의 시간순 홀드아웃 분할에 필요.
    rows: list[tuple[datetime, list[str], float]] = []
    for log in logs:
        raw_type = facility_map.get(log.get("facility_id"))
        if not raw_type:
            continue
        ts_str = log.get("timestamp")
        if not ts_str:
            continue
        try:
            dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        except Exception as e:
            print(f"Warning: Failed to parse timestamp {ts_str}: {e}")
            continue
        norm_type = normalize_facility_type(raw_type)
        rows.append((dt, [norm_type, str(dt.hour), str(dt.weekday())], log.get("congestion_level", 0.0)))

    if not rows:
        print("Error: No valid feature vectors created.")
        sys.exit(1)

    # 4. (옵션) 홀드아웃 백테스트 — 평가용 분할 학습은 임시, 저장 모델은 아래 전체 재학습본.
    metrics: dict = {}
    if args.evaluate:
        eval_metrics = evaluate_holdout(rows)
        if eval_metrics:
            metrics.update(eval_metrics)

    # 5. 전체 데이터로 최종 모델 학습 (평가 유무와 무관 — 서빙 모델은 가용 데이터 전부 사용)
    print("Training Ridge Regression model with One-Hot Encoded features...")
    X_raw = [r[1] for r in rows]
    y = [r[2] for r in rows]
    ridge, encoder = fit_model(X_raw, y)
    score = ridge.score(encoder.transform(X_raw), y)
    metrics.update({
        "n_rows": len(rows),
        "r2_train": round(float(score), 4),
        "trained_at": datetime.now(timezone.utc).isoformat(),
    })

    # 6. Save model (+metrics) to apps/api/model.pkl — predict_service 가 metrics 를
    #    GET /predict/model-info 로 노출한다(관리자 정확도 배지).
    model_pkl_path = os.path.join(parent_dir, "model.pkl")
    try:
        with open(model_pkl_path, "wb") as f:
            pickle.dump({"model": ridge, "encoder": encoder, "metrics": metrics}, f)
    except Exception as e:
        print(f"Error saving model: {e}")
        sys.exit(1)

    print(f"학습 완료: {len(rows)}행, R²={score}")
    if "mae" in metrics:
        print(f"홀드아웃 MAE {metrics['mae']} → model.pkl metrics 로 내장됨 (/predict/model-info 노출)")

if __name__ == "__main__":
    main()
