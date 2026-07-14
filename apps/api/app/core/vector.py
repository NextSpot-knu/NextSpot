"""공용 벡터 수학 유틸 — 8차원 선호 벡터 L2 정규화.

preference_nlp_service._normalize / preference_vector_service._normalize_vector 로
중복 구현돼 있던 동일 로직(제로 벡터 → 8차원 균등 단위벡터 폴백)의 단일 정본.
(spot/preference.py 의 인라인 정규화는 폴백이 다르므로 — 제로 벡터를 그대로 통과 —
이 헬퍼로 통합하지 않는다.)
"""

import math


def l2_normalize(vec: list[float]) -> list[float]:
    """L2 정규화로 벡터 크기를 1로 만든다.

    제로 벡터는 정규화가 불가능하므로 8차원 균등 단위벡터([1/√8]*8)로 대체한다
    (선호 벡터 도메인이 8차원 고정이라는 기존 관례).
    """
    sq_sum = sum(x * x for x in vec)
    if sq_sum <= 0:
        # 8차원 기본 제로 벡터 방지
        return [1.0 / math.sqrt(8)] * 8
    norm = math.sqrt(sq_sum)
    return [x / norm for x in vec]
