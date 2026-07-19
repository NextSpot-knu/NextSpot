# predict_service — 혼잡 3단계(CONGESTION_TRUST_SPEC)의 predicted/none 판정을 위한
# predict_congestion_detailed 계약: (값, 출처) 반환, 출처 "local"=실제 모델 추론 /
# "default"=미학습 0.5 폴백. 기존 predict_congestion 은 값만 반환하는 래퍼로 동작이 동일해야 한다.
from app.services.predict_service import (
    DEFAULT_CONGESTION,
    predict_congestion,
    predict_congestion_detailed,
)


def test_predict_detailed_contract_and_wrapper_parity():
    value, source = predict_congestion_detailed("cafe", 12, 3)
    assert source in {"local", "default"}
    assert 0.0 <= value <= 1.0
    # 미학습(default)이면 반드시 0.5 평탄 폴백 — 이 값을 'AI 예측'으로 팔면 안 되는 근거.
    if source == "default":
        assert value == DEFAULT_CONGESTION
    # 래퍼는 동일 입력에서 동일 값(회귀 0 — score.py 가 무수정 호출).
    assert predict_congestion("cafe", 12, 3) == value


def test_predict_detailed_unknown_type_falls_back_to_default():
    value, source = predict_congestion_detailed("unknown-type-xyz", 12, 3)
    assert source == "default"
    assert value == DEFAULT_CONGESTION
