"""SPOT 후보 정렬 규칙 — 근거 등급을 먼저 보고, **같은 등급 안에서만** 점수를 비교한다.

왜 이 파일이 있는가
--------------------
``calculate_spot_score`` 는 후보마다 ``scoring_mode`` 를 따로 정하고 **서로 다른 시간비용
공식**을 쓴다.

    measured_rules / model : 이동 + 대기(분)     + 주차 패널티
    area_stats_rules       : 이동 + 0            + 주변수요 패널티
    degraded_rules         : 이동 + 0            + 0

그런데 그 결과를 한 리스트에서 점수로 정렬했다. 다른 모드가 더하는 항은 전부 ≥0 이므로
**근거가 하나도 없는 후보는 언제나 최소 시간비용을 받는다 — 구조적 하한이다.** '모른다' 가
'대기 0분' 으로 채워지는 것이다.

지금 프로덕션(모델 미학습)에서 실제로 이렇게 됐다. 사장님이 좌석을 '여유(0.15)' 로 방송하면
그 가게는 measured_rules 로 들어가 대기 4.9분이 시간비용에 붙는다. 로그도 주변 신호도 없는
옆 가게는 degraded_rules 라 0 이다. 거리·취향이 같으면 **아무것도 방송하지 않은 쪽이 이긴다.**
콘솔이 권장하는 행동(정직한 방송)이 그 가게의 순위를 떨어뜨렸고, 사용자에게는 '무지' 가
'한산' 으로 팔렸다 — 이 저장소가 혼잡 표시에서 못 박은 "로그 없는 시설을 0.0 실측처럼 팔지
않는다" 를 점수 축에서 뒤집는 것이었다.

고치는 방법은 값을 손보는 게 아니라 **다른 공식의 점수를 비교하는 일 자체를 없애는** 것이다.
등급을 먼저 보고 같은 등급 안에서만 점수로 줄을 세운다. ``travel_context`` 의 영업 자격
등급(``recommendation_eligibility_tier`` / ``keep_best_eligibility_tier``)과 같은 규칙이다 —
숫자가 작을수록 강한 근거이고, 등급이 다르면 점수는 아예 비교하지 않는다. 다만 자격 등급은
약한 등급을 **버리지만**(추천하면 안 되는 후보라서), 근거 등급은 **뒤로 미룰 뿐**이다.
근거가 없다는 게 갈 만한 곳이 아니라는 뜻은 아니다.
"""

# scoring_mode → 근거 등급. 낮을수록 강한 근거.
#
# model 과 measured_rules 가 **같은 등급**인 이유: 이 둘만 시간비용에 실제 대기 항
# (calculate_predicted_wait_time 의 분)을 넣는다. 비용 축이 같으니 점수를 그대로 비교해도
# 위에서 말한 왜곡이 생기지 않는다. 반대로 등급을 갈라 measured 를 위에 두면 '만석(1.0)' 을
# 방송한 가게가 모델이 한산하다고 본 가게를 **항상** 이긴다 — 지금 고치려는 왜곡을 방향만
# 바꿔 다시 만드는 셈이다.
EVIDENCE_TIER_BY_SCORING_MODE = {
    "model": 0,
    "measured_rules": 0,
    "area_stats_rules": 1,
    "degraded_rules": 2,
}

# 등급 이름표 — 로그·설명용(RECOMMENDATION_ELIGIBILITY_LABELS 와 같은 자리).
EVIDENCE_TIER_LABELS = {
    0: "arrival_wait_evidence",
    1: "area_demand_evidence",
    2: "no_congestion_evidence",
}

# 모르는 모드는 가장 약한 근거로 본다. 새 모드가 생겼는데 여기 등록을 잊으면 조용히
# 최상위로 올라가는 쪽이 아니라 조용히 맨 뒤로 가는 쪽이 안전하다(모르면 이기지 못한다).
WEAKEST_EVIDENCE_TIER = max(EVIDENCE_TIER_LABELS)

# 이 이상이면 '이미 붐빈다' 로 본다 — **근거 등급 이점을 주지 않는다.**
#
# 왜 필요한가: 등급이 점수보다 앞서므로, 위 표만 있으면 **어떤 값을 방송하든** 그 가게가
# 무근거 가게 전부를 이긴다. '만석(1.0)' 을 방송해도 그렇다. 그러면
#   · 사장님 콘솔에는 "아무 값이나 방송하면 이득" 이라는 새 유인이 생기고,
#   · 분산이라는 서비스 목표에서 보면 "만석인 걸 아는 가게" 를 "모르는 가게" 위에 올리게 된다.
# 앞의 왜곡('정직하면 손해')을 고치다 방향만 바꿔 새 왜곡을 만드는 셈이라, 붐비는 것이
# 확인된 후보는 등급 이점에서 빼기로 했다(검토 결정 2026-09-08).
#
# 0.9 인 이유: 이 저장소가 **이미 쓰고 있는 '이상 혼잡' 선**이다(admin.py 의 대시보드
# anomalyCount = congestion_level >= 0.9). 새 숫자를 만들면 "이 정도면 붐빔" 의 정의가 둘이
# 되고, 둘은 반드시 갈라진다. 임의성을 하나라도 줄이려고 있는 선을 그대로 쓴다.
CROWDED_EVIDENCE_CUTOFF = 0.9


def scoring_evidence_tier(
    scoring_mode: str | None, congestion_level: float | None = None
) -> int:
    """``scoring_mode``(+ 알려진 혼잡도)를 근거 등급으로 바꾼다. 낮을수록 강한 근거.

    ``congestion_level`` 은 그 후보의 시간비용을 실제로 만든 값이다(실측이면 실측,
    모델이면 예측 — score.py 의 ``ranking_congestion``). 모르면 ``None`` 이고, 그때는
    모드만으로 판정한다 — **모른다는 이유로 강등하지 않는다.** 강등은 '붐비는 것이
    확인됐을 때' 만이다.
    """
    tier = EVIDENCE_TIER_BY_SCORING_MODE.get(scoring_mode or "", WEAKEST_EVIDENCE_TIER)
    if congestion_level is None:
        return tier
    try:
        level = float(congestion_level)
    except (TypeError, ValueError):
        return tier
    if level >= CROWDED_EVIDENCE_CUTOFF:
        # 이점만 없앤다 — 이미 약한 등급을 더 내리지는 않는다(가장 약한 등급이 바닥이다).
        return max(tier, WEAKEST_EVIDENCE_TIER)
    return tier


def spot_ranking_sort_key(
    scoring_mode: str | None,
    spot_score: float,
    distance_m: float,
    facility_id: str,
    congestion_level: float | None = None,
) -> tuple[int, float, float, str]:
    """추천·코스가 공유하는 SPOT 정렬 키 — (근거 등급, 점수 내림차순, 거리, id).

    세 정렬 지점(``/recommendations``, ``/recommendations/by-type``, ``/courses/plan`` 의
    슬롯별 후보)이 **같은 키**를 써야 한다. 한 곳이라도 빠뜨리면 같은 후보가 화면마다 다른
    자리에 놓인다. 뒤의 세 항목은 종전 정렬과 동일하다 — 등급만 앞에 붙였다.
    """
    return (
        scoring_evidence_tier(scoring_mode, congestion_level),
        -float(spot_score),
        float(distance_m),
        str(facility_id),
    )
