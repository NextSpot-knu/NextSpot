import os
import sys
import pickle
from datetime import datetime
from supabase import create_client
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

def main():
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

    # 2. Retrieve all congestion logs
    print("Retrieving congestion logs...")
    logs = []
    limit = 1000
    start = 0
    while True:
        try:
            res = supabase.table("congestion_logs")\
                          .select("facility_id, timestamp, congestion_level")\
                          .range(start, start + limit - 1)\
                          .execute()
        except Exception as e:
            print(f"Error querying congestion logs: {e}")
            sys.exit(1)

        if not res.data:
            break
        logs.extend(res.data)
        if len(res.data) < limit:
            break
        start += limit

    print(f"Retrieved {len(logs)} congestion logs.")

    if not logs:
        print("Error: No congestion logs found.")
        sys.exit(1)

    # 3. Join and pre-process facility type
    X = []
    y = []
    mapped_types = []
    valid_logs = []

    for log in logs:
        facility_id = log.get("facility_id")
        raw_type = facility_map.get(facility_id)
        if not raw_type:
            continue
        norm_type = normalize_facility_type(raw_type)
        mapped_types.append(norm_type)
        valid_logs.append((log, norm_type))

    if not valid_logs:
        print("Error: No logs matching existing facilities.")
        sys.exit(1)

    # 4. Feature engineering (One-Hot Encoding hour, day_of_week, and normalized facility_type)
    X_raw = []
    for log, norm_type in valid_logs:
        ts_str = log.get("timestamp")
        if not ts_str:
            continue

        try:
            ts_str = ts_str.replace("Z", "+00:00")
            dt = datetime.fromisoformat(ts_str)
        except Exception as e:
            print(f"Warning: Failed to parse timestamp {ts_str}: {e}")
            continue

        hour = str(dt.hour)
        day_of_week = str(dt.weekday())
        
        # Collect raw categorical features
        X_raw.append([norm_type, hour, day_of_week])
        y.append(log.get("congestion_level", 0.0))

    if not X_raw:
        print("Error: No valid feature vectors created.")
        sys.exit(1)

    # Fit OneHotEncoder on the collected features
    encoder = OneHotEncoder(handle_unknown='ignore', sparse_output=False)
    X = encoder.fit_transform(X_raw)

    # 5. Model training
    print("Training Ridge Regression model with One-Hot Encoded features...")
    ridge = Ridge(alpha=1.0)
    ridge.fit(X, y)
    score = ridge.score(X, y)

    # 6. Save model to apps/api/model.pkl
    model_pkl_path = os.path.join(parent_dir, "model.pkl")
    try:
        with open(model_pkl_path, "wb") as f:
            pickle.dump({"model": ridge, "encoder": encoder}, f)
    except Exception as e:
        print(f"Error saving model: {e}")
        sys.exit(1)

    print(f"학습 완료: {len(X_raw)}행, R²={score}")

if __name__ == "__main__":
    main()
