"""서울 시연 권역 **실측 인구 기반 대안 추천** — 순수 함수만 둔다(DB·네트워크 없음).

`docs/CONGESTION_ENGINE_PLAN.md` §5.4 A2. 홍대·연남동·합정역은 서로 걸어서 오갈 수 있고,
서울시가 이 세 곳의 **인구를 실제로 재서 준다**(2026-09-20 재조정 블록). 반면 이 세 곳에는
실시간 대수를 주는 주차장이 0곳이라 우리 추정기는 아예 돌지 않는다. 그래서 이 모듈이 쓰는 값은
**전부 서울시 실측**이고, 우리 추정치(`level_est`)는 **한 번도 섞지 않는다** — "엔진이 실시간
인구 위에서 어떻게 도는가" 를 보여 주는 자리이지 추정기 성적표가 아니다(성적표는 summary 쪽).

## 등급 → 0~1 수준: 왜 구간 중앙값인가

서울시가 주는 것은 4등급 문자열(여유·보통·약간 붐빔·붐빔)이고, SPOT 의 비용 산식은 0~1 수준을
받는다. 둘을 잇는 방법은 하나를 골라야 한다. 여기서는 `engine_validation_metrics.ESTIMATE_GRADE_EDGES`
(0.25·0.50·0.75 — 저장소의 혼잡 경계 75와 같은 간격)가 만드는 **구간의 중앙값**을 쓴다:

    여유 0.125 · 보통 0.375 · 약간 붐빔 0.625 · 붐빔 0.875

이 선택의 근거:
  · 같은 경계를 쓰므로 `estimated_grade(grade_level(g)) == g` 가 **항상** 성립한다(테스트가 잠근다).
    즉 검증 화면의 등급 축과 이 화면의 수준 축이 서로 되돌아간다 — 두 화면이 다른 눈금을 쓰지 않는다.
  · 구간 끝(예 붐빔 = 1.0)을 쓰면 등급 하나 차이가 비용에서 과장된다. 중앙값은 등급이 곧 구간이라는
    사실(우리는 구간 안 어디인지 모른다)을 그대로 남긴다.
  · 인구 범위 중앙값을 수준으로 바로 쓰지 않는 이유: 인구는 **인원수**라 장소마다 자릿수가 다르다
    (홍대 6만 vs 연남동 1만). 등급은 서울시가 그 장소 기준으로 이미 판단한 값이라 장소 간 비교가 된다.
    인구는 **동률일 때의 가늠자**로만 쓴다(아래).

## 순위: SPOT 과 같은 비용 축

`spot/score.py` 는 후보를 `total_time = 이동(분) + 대기(분) + 패널티` 로 줄 세운다(작을수록 앞).
여기도 같은 축을 쓴다 — 새 산식을 만들면 "SPOT 엔진이 돈다" 가 거짓말이 된다.

    cost_minutes = walk_minutes + calculate_predicted_wait_time(level, 'attraction', KST 시)

`walk_minutes` 는 `spot/travel.py` 의 직선거리 × 1.18(우회 계수) ÷ 66.67 m/분 — 저장소가 경주
그래프 밖에서 쓰는 바로 그 폴백이다(보행 그래프는 경주 것뿐이라 서울에는 쓸 수 없다).
대기는 `spot/wait_time.py` 의 공식 그대로이고 `attraction`(기본 15분 처리)으로 본다 — 대상지는
가게가 아니라 '구역' 이라 업종이 없고, 관람·입장 대기가 가장 가까운 성격이다. 시간대 보정은 세
곳에 **똑같이** 걸리므로 순위를 바꾸지 않는다(크기만 바꾼다).

동률(분 단위 비용이 같음)이면 **정규화 인구**가 낮은 쪽이 앞선다. 정규화는 검증 지표와 같은 방식
(`midpoint_over_window_max`) — 그 장소의 인구 중앙값 ÷ 그 장소가 조회 창 안에서 보인 최대 중앙값.
장소끼리 인원수를 직접 비교하지 않기 위한 것이다. 그래도 같으면 이름 순으로 확정한다(응답이 흔들리지 않게).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from app.services import engine_validation_metrics as metrics
from app.services.spot.travel import (
    FALLBACK_ROUTE_FACTOR,
    WALKING_SPEED_M_PER_MIN,
    calculate_haversine_distance,
    estimate_walking_route,
)
from app.services.spot.wait_time import DEFAULT_PROCESSING_TIMES

_KST = timezone(timedelta(hours=9))

# 대기 공식에 넣을 업종. 대상지는 가게가 아니라 구역이라 '관람 대기'(15분)가 가장 가깝다.
CROWD_WAIT_FACILITY_TYPE = "attraction"


@dataclass(frozen=True)
class DemoPlace:
    """시연 권역 한 곳. 좌표는 `seoul_citydata_service._TARGET_PROFILES` 와 같아야 한다(테스트가 잠근다)."""

    area_cd: str
    area_nm: str
    latitude: float
    longitude: float


# 시연 권역 — 홍대에서 걸어서 오갈 수 있는 세 곳(§4 재조정 2026-09-20).
# 여기에 검증 지점(명동·동대문)을 넣지 않는 이유: 걸어서 갈 수 없다. "대안" 이 성립하지 않는다.
DEMO_CLUSTER: tuple[DemoPlace, ...] = (
    DemoPlace("POI007", "홍대 관광특구", 37.55391867558625, 126.92127401787192),
    DemoPlace("POI073", "연남동", 37.5606, 126.9256),
    DemoPlace("POI053", "합정역", 37.5497, 126.9137),
)

DEFAULT_ORIGIN = DEMO_CLUSTER[0].area_nm

# 수집 주기가 10분이다. 최신 버킷이 이보다 오래됐으면 "지금" 이라고 말하지 않는다.
STALE_AFTER_MINUTES = 30

# 정규화(동률 가늠자)와 '이 장소의 평소 대비' 표시를 위해 보는 창. 지표 창(14일)보다 짧다 —
# 이 화면은 '지금' 을 말하는 자리이고, 길게 볼수록 응답이 무거워진다(3곳 × 144버킷 × 7일).
LOOKBACK_DAYS = 7

SOURCE_MEASURED = "measured"

# 화면·응답에 항상 붙는 한 줄. "실측" 이라고 부르되 그 실측도 서울시의 추정이라는 사실을 같이 말한다.
MEASURED_CAVEAT = (
    "서울시 실시간 인구는 통신사(KT·SKT) 기지국 5분 집계를 50m 격자로 배분한 "
    "서울시의 추정치다. 우리가 잰 값이 아니고, 가게 단위도 아니다 — 대상지(핫스팟) 전체의 값이다."
)
RANKING_NOTE = (
    "순위 = 걷는 시간(분) + 혼잡 대기(분). SPOT 추천이 후보를 줄 세우는 축과 같다. "
    "혼잡 대기는 서울시 실측 등급만으로 만든다 — 우리 추정치(level_est)는 쓰지 않는다."
)


def grade_level(grade: int | None) -> float | None:
    """서울시 등급(0~3) → 0~1 수준. 등급 구간의 **중앙값**(모듈 설명 참조)."""
    if grade is None or not 0 <= grade < len(metrics.GRADE_LABELS):
        return None
    edges = (0.0, *metrics.ESTIMATE_GRADE_EDGES, 1.0)
    return (edges[grade] + edges[grade + 1]) / 2.0


# 문자열 등급 → 수준(응답에 그대로 실어 화면이 같은 표를 다시 만들지 않게 한다).
GRADE_LEVELS: dict[str, float] = {
    label: grade_level(index) for index, label in enumerate(metrics.GRADE_LABELS)  # type: ignore[misc]
}


def resolve_origin(value: str | None) -> str | None:
    """`origin` 질의값 → 대상지 이름. 이름·코드 둘 다 받고, 모르는 값은 None(호출측이 422)."""
    if value is None:
        return DEFAULT_ORIGIN
    text = " ".join(str(value).split())
    if not text:
        return DEFAULT_ORIGIN
    for place in DEMO_CLUSTER:
        if text == place.area_nm or text.upper() == place.area_cd.upper():
            return place.area_nm
    compact = text.replace(" ", "")
    for place in DEMO_CLUSTER:
        if compact == place.area_nm.replace(" ", ""):
            return place.area_nm
    return None


def crowd_wait_minutes(level: float | None, hour: int) -> float | None:
    """혼잡 수준 → 대기(분). `spot/wait_time.calculate_predicted_wait_time` 과 같은 공식.

    그 함수는 `async def` 라 동기 조립 경로에서 부르려면 `asyncio.run` 이 필요하다. 산식 자체는
    순수해서 여기서 같은 상수(`DEFAULT_PROCESSING_TIMES`)로 다시 쓴다 — 기본 처리 시간이 바뀌면
    두 곳이 같이 바뀌도록 상수를 import 하고, 시간대 계수만 이 모듈에 적는다(테스트가 두 값의
    일치를 잠근다).
    """
    if level is None or not math.isfinite(level):
        return None
    base = DEFAULT_PROCESSING_TIMES.get(CROWD_WAIT_FACILITY_TYPE, 15)
    if 11 <= hour < 14:
        multiplier = 1.3
    elif 14 <= hour < 18:
        multiplier = 1.2
    else:
        multiplier = 1.0
    return round(level * base * multiplier, 1)


def _to_float(value: Any) -> float | None:
    """숫자로 읽히면 float, 아니면 None. 서울 인구는 문자열로 올 수 있다('58,000')."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(str(value).replace(",", "")) if isinstance(value, str) else float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


@dataclass
class _Observation:
    """한 대상지의 최신 버킷 + 그 장소의 창 안 최대 중앙값."""

    bucket_at: datetime | None = None
    observed_at: datetime | None = None
    congest_lvl: str | None = None
    ppltn_min: float | None = None
    ppltn_max: float | None = None
    midpoint: float | None = None
    max_midpoint: float | None = None
    max_midpoint_bucket_at: datetime | None = None
    bucket_count: int = 0


def latest_by_place(rows: list[dict[str, Any]]) -> dict[str, _Observation]:
    """행 → 대상지 이름별 최신 관측(+ 창 안 최대 중앙값). 모르는 대상지 행은 버린다."""
    known = {place.area_nm for place in DEMO_CLUSTER}
    found: dict[str, _Observation] = {}
    for row in rows:
        name = metrics.place_key(row)
        if name not in known:
            continue
        bucket = metrics.parse_time(row.get("bucket_at"))
        if bucket is None:
            continue
        observation = found.setdefault(name, _Observation())
        observation.bucket_count += 1
        midpoint = metrics.population_midpoint(row.get("ppltn_min"), row.get("ppltn_max"))
        if midpoint is not None and (observation.max_midpoint is None or midpoint > observation.max_midpoint):
            observation.max_midpoint = midpoint
            observation.max_midpoint_bucket_at = bucket
        # 같은 버킷이 두 번 들어왔으면 나중 행이 이긴다(재수집 대비 — summarize 와 같은 규칙).
        if observation.bucket_at is None or bucket >= observation.bucket_at:
            observation.bucket_at = bucket
            observation.observed_at = metrics.parse_time(row.get("observed_at"))
            observation.congest_lvl = row.get("congest_lvl") if isinstance(row.get("congest_lvl"), str) else None
            observation.ppltn_min = _to_float(row.get("ppltn_min"))
            observation.ppltn_max = _to_float(row.get("ppltn_max"))
            observation.midpoint = midpoint
    return found


def _iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if value is not None else None


def build_places(
    rows: list[dict[str, Any]],
    *,
    origin: str,
    now: datetime,
) -> list[dict[str, Any]]:
    """시연 권역 3곳 카드. **행이 없어도 3장을 다 만든다** — 빈 카드가 곧 '아직 안 들어왔다' 라는 사실이다."""
    observations = latest_by_place(rows)
    origin_place = next(place for place in DEMO_CLUSTER if place.area_nm == origin)
    hour = now.astimezone(_KST).hour
    cards: list[dict[str, Any]] = []
    for place in DEMO_CLUSTER:
        observation = observations.get(place.area_nm)
        is_origin = place.area_nm == origin
        straight_m = calculate_haversine_distance(
            origin_place.latitude, origin_place.longitude, place.latitude, place.longitude
        )
        route = estimate_walking_route(
            origin_place.latitude, origin_place.longitude, place.latitude, place.longitude
        )
        grade = metrics.actual_grade(observation.congest_lvl) if observation else None
        level = grade_level(grade)
        wait = crowd_wait_minutes(level, hour)
        age = (
            (now - observation.bucket_at).total_seconds() / 60.0
            if observation and observation.bucket_at
            else None
        )
        normalized = None
        if observation and observation.midpoint is not None and observation.max_midpoint:
            normalized = round(observation.midpoint / observation.max_midpoint, 4)
        # 출발지는 이미 그 자리에 있으므로 걷는 시간이 0이다. 그래도 비용은 계산한다 —
        # "여기 머무는 비용" 과 "옆 동네로 걸어가는 비용" 을 같은 축에서 비교해야 추천이 성립한다.
        walk_minutes = 0.0 if is_origin else route.duration_min
        cost = None if wait is None else round(walk_minutes + wait, 1)
        reason = None
        if observation is None:
            reason = "이 대상지의 행이 아직 없다 — 수집 목록(SEOUL_CITYDATA_TARGETS)과 수집 잡을 확인하세요."
        elif grade is None:
            reason = "서울시 혼잡 등급을 읽지 못했다 — 등급 없이는 순위에 넣지 않는다."
        cards.append(
            {
                "area_cd": place.area_cd,
                "area_nm": place.area_nm,
                "latitude": place.latitude,
                "longitude": place.longitude,
                "is_origin": is_origin,
                "has_data": observation is not None,
                "source": SOURCE_MEASURED,
                "bucket_at": _iso(observation.bucket_at) if observation else None,
                "observed_at": _iso(observation.observed_at) if observation else None,
                "age_minutes": round(age, 1) if age is not None else None,
                "stale": age is not None and age > STALE_AFTER_MINUTES,
                "congest_lvl": observation.congest_lvl if observation else None,
                "grade": grade,
                "level": level,
                "ppltn_min": observation.ppltn_min if observation else None,
                "ppltn_max": observation.ppltn_max if observation else None,
                "ppltn_midpoint": observation.midpoint if observation else None,
                "normalized_population": normalized,
                "lookback_max_midpoint": observation.max_midpoint if observation else None,
                "lookback_max_bucket_at": _iso(observation.max_midpoint_bucket_at) if observation else None,
                "lookback_buckets": observation.bucket_count if observation else 0,
                "straight_distance_m": 0.0 if is_origin else straight_m,
                "walk_distance_m": 0.0 if is_origin else route.distance_m,
                "walk_minutes": walk_minutes,
                "walk_source": route.source,
                "crowd_wait_minutes": wait,
                "cost_minutes": cost,
                "rank": None,
                "reason": reason,
            }
        )
    return cards


def rank_alternatives(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """출발지를 뺀 카드를 SPOT 비용 축으로 줄 세운다(작을수록 앞). 등급 없는 곳은 뺀다.

    `cards` 의 `rank` 를 제자리에서 채우고, 순위가 매겨진 카드를 순서대로 돌려준다.
    """
    ranked = sorted(
        (card for card in cards if not card["is_origin"] and card["cost_minutes"] is not None),
        key=lambda card: (
            card["cost_minutes"],
            card["normalized_population"] if card["normalized_population"] is not None else 1.0,
            card["area_nm"],
        ),
    )
    for index, card in enumerate(ranked, start=1):
        card["rank"] = index
    return ranked


def build_recommendation(cards: list[dict[str, Any]], *, origin: str) -> dict[str, Any]:
    """추천 한 줄의 재료. 문장은 화면이 만든다 — 여기서는 '무엇이 사실인가' 만 둔다.

    순위(`rank`)와 추천(`best`)은 **다른 질문에 답한다**:

      · 순위는 SPOT 의 비용 축 그대로다 — 붐벼도 가까우면 앞설 수 있다(거리가 비용이니까).
      · 추천은 그중 **출발지보다 실제로 덜 붐비는** 첫 번째 곳이다. 같은 등급이거나 더 붐비는 곳을
        "대안" 이라고 부르면 근거 없는 추천이 된다 — 그럴 땐 `best=None`, `better=False` 로 둔다.

    `beats_origin_cost` 는 걷는 시간까지 더해도 그 대안이 더 싼지다. 덜 붐비지만 멀어서 결국
    머무는 편이 빠른 경우가 실제로 있고(홍대↔합정 1.6km), 그걸 숨기면 화면이 과장한다.
    """
    origin_card = next(card for card in cards if card["area_nm"] == origin)
    ranked = rank_alternatives(cards)
    origin_grade = origin_card["grade"]
    less_crowded = [
        card for card in ranked if origin_grade is not None and card["grade"] < origin_grade
    ]
    best = less_crowded[0] if less_crowded else None
    reason: str | None = None
    if origin_grade is None:
        reason = "출발지의 실측 등급이 아직 없어 비교할 수 없다."
    elif not ranked:
        reason = "이웃 대상지의 실측 등급이 아직 없어 대안을 고를 수 없다."
    elif best is None:
        reason = "지금은 이웃 대상지가 출발지보다 덜 붐비지 않는다 — 옮길 이유가 없다."
    beats_cost = bool(
        best is not None
        and origin_card["cost_minutes"] is not None
        and best["cost_minutes"] <= origin_card["cost_minutes"]
    )
    return {
        "origin": origin,
        "origin_congest_lvl": origin_card["congest_lvl"],
        "origin_grade": origin_grade,
        "origin_cost_minutes": origin_card["cost_minutes"],
        "origin_stale": origin_card["stale"],
        "best": best["area_nm"] if best else None,
        "best_congest_lvl": best["congest_lvl"] if best else None,
        "best_grade": best["grade"] if best else None,
        "best_walk_minutes": best["walk_minutes"] if best else None,
        "best_cost_minutes": best["cost_minutes"] if best else None,
        # '덜 붐비는 곳' 이 실제로 덜 붐빌 때만 true. 셋 다 같은 등급이면 false.
        "better": best is not None,
        "grade_gap": (origin_grade - best["grade"]) if best else 0,
        "beats_origin_cost": beats_cost,
        # 비용 축의 1등(붐벼도 가까울 수 있다). 화면이 순위와 추천을 구분해 보여 주라고 같이 준다.
        "top_ranked": ranked[0]["area_nm"] if ranked else None,
        "ranking_note": RANKING_NOTE,
        "reason": reason,
    }


def walking_method() -> dict[str, Any]:
    """걷는 시간을 어떻게 냈는지 — 화면이 그대로 적을 수 있게 값으로 준다."""
    return {
        "method": "haversine_x_route_factor",
        "speed_m_per_min": WALKING_SPEED_M_PER_MIN,
        "route_factor": FALLBACK_ROUTE_FACTOR,
        "note": (
            "직선거리 × 1.18(우회 계수) ÷ 66.67m/분. 저장소의 보행 그래프는 경주 것뿐이라 "
            "서울에서는 같은 폴백 추정을 쓴다 — 실제 보행 경로가 아니다."
        ),
    }
