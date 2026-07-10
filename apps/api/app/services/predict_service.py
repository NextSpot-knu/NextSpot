"""혼잡 예측 서비스 (로컬 전용).

추론 경로(다단계 폴백):
  (a) 로컬 `apps/api/model.pkl` 인메모리 추론 → source=local
  (b) 모델 없음/미학습 타입 → 0.5 → source=default

설계 원칙:
- import 시점에 절대 죽지 않는다(=lazy 로딩). model.pkl 이 없어도 서버는 뜨고, 예측은 0.5 로 폴백한다.
- 외부 노출 함수 `predict_congestion(...)` 의 시그니처·반환 타입은 변경하지 않는다(score.py 가 무수정 호출).
- model.pkl 은 `python scripts/train.py` 가 Supabase 혼잡 로그로 학습해 생성한다(GCP 불필요).
  (대회 종료 후 Vertex AI Endpoint / GCS 모델 서빙 경로는 제거됨 — 로컬 sklearn 단일 경로.)
"""

import os
import pickle
import threading
from typing import Optional, Tuple, Any

import structlog

logger = structlog.get_logger()

# 시설 카테고리 (학습 스펙과 동일하게 인코더가 fit된 3개 피처: [norm_type, hour_str, dow_str])
DEFAULT_CONGESTION = 0.5

# --- lazy 캐시 (모듈 전역, 최초 사용 시 1회 로드) ---
_local_artifacts: Optional[Tuple[Any, Any]] = None    # (model, encoder)
_local_loaded = False

# 추천 채점이 후보를 병렬(asyncio.to_thread)로 돌리므로, 최초 1회 lazy 로드가 여러 워커
# 스레드에서 동시에 들어올 수 있다. 중복 초기화/경쟁을 막기 위한 락(double-checked locking).
_init_lock = threading.Lock()


def normalize_facility_type(facility_type: str) -> str:
    # 관광 canonical 4타입: restaurant / cafe / attraction / culture
    if facility_type in ["restaurant", "cafe", "attraction", "culture"]:
        return facility_type
    # 한국어 라벨·동의어·레거시(산업) 타입 → canonical 매핑
    aliases = {
        "음식점": "restaurant", "식당": "restaurant", "cafeteria": "restaurant",
        "카페": "cafe", "coffee": "cafe",
        "관광지": "attraction", "명소": "attraction", "sight": "attraction",
        "문화시설": "culture", "박물관": "culture", "museum": "culture",
    }
    return aliases.get(facility_type, facility_type)


# --- 로컬 모델 lazy 로드 ---
def _load_local_artifacts() -> Optional[Tuple[Any, Any]]:
    global _local_artifacts, _local_loaded
    if _local_loaded:
        return _local_artifacts
    with _init_lock:
        if _local_loaded:
            return _local_artifacts
        local_model_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
            "model.pkl",
        )
        try:
            if os.path.exists(local_model_path):
                with open(local_model_path, "rb") as f:
                    model_data = pickle.load(f)
                _local_artifacts = (model_data["model"], model_data["encoder"])
                logger.info("predict_model_loaded", source="local", path=local_model_path)
            else:
                _local_artifacts = None
        except Exception as e:
            logger.warning("predict_model_load_failed", source="local", error=str(e))
            _local_artifacts = None
        _local_loaded = True
    return _local_artifacts


def _predict_with_artifacts(artifacts: Tuple[Any, Any], norm_type: str, hour: int, dow: int) -> Optional[float]:
    """로컬 모델 인메모리 추론. 미학습 타입이면 None(상위에서 0.5 처리)."""
    model, encoder = artifacts
    # norm_type 과 대칭으로 hour/dow 도 학습 카테고리 멤버십을 검증한다. OneHotEncoder(handle_unknown='ignore')는
    # 미학습 hour/dow 를 0벡터로 만들어 '절편-only(평균) 예측'을 source=local '성공'처럼 반환하므로,
    # 미학습 시점은 None 으로 내려 0.5 폴백이 되게 한다(의미 없는 평균을 신뢰값으로 반환하지 않음).
    # len<3 가드는 다른 피처 수의 인코더가 들어왔을 때의 IndexError 방지.
    if (
        not hasattr(encoder, "categories_")
        or len(encoder.categories_) < 3
        or norm_type not in encoder.categories_[0]
        or str(hour) not in encoder.categories_[1]
        or str(dow) not in encoder.categories_[2]
    ):
        return None
    try:
        # train.py의 OneHotEncoder가 fit된 포맷: [norm_type, hour_str, dow_str]
        features = [[norm_type, str(hour), str(dow)]]
        X_encoded = encoder.transform(features)
        prediction = model.predict(X_encoded)[0]
        return max(0.0, min(1.0, float(prediction)))
    except Exception as e:
        logger.warning("predict_inference_error", error=str(e))
        return None


def predict_congestion(facility_type: str, hour: int, day_of_week: int) -> float:
    """도착 예상 시점 기준 혼잡도를 [0,1]로 반환.

    시그니처/반환 타입 불변 (score.py가 무수정 호출).
    경로: 로컬 model.pkl → 0.5. 어느 경로를 탔는지 로깅한다.
    """
    norm_type = normalize_facility_type(facility_type)

    local = _load_local_artifacts()
    if local is not None:
        result = _predict_with_artifacts(local, norm_type, hour, day_of_week)
        if result is not None:
            logger.info("congestion_predicted", source="local", facility_type=norm_type, value=result)
            return result

    # 모델 부재(미학습) 또는 미학습 타입 → 기본값
    logger.info("congestion_predicted", source="default", facility_type=norm_type, value=DEFAULT_CONGESTION)
    return DEFAULT_CONGESTION
