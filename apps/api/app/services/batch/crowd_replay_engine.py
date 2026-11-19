"""S4 분산 결정 재생 — **실제 엔진 경로** 어댑터(다시 구현하지 않는다).

`docs/SEOUL_TESTBED_PLAN.md` §4(V3) 2단계 "실제 추천 경로(SPOT — 취향 중립·쿠폰 0)로 대안을 고른다".
구역 하나를 가상 시설 하나(``replay:<zone_id>`` · 관광지 · 쿠폰 0 · 특징 없음)로 두고, ``/recommendations``
라우터가 서울 요청에서 부르는 그대로 부른다:

    zone_evidence_dict → evidence_is_current            (출발지 블록 — recommendations.py 원본 블록 복사)
    recommendations.build_candidate_evidence            (후보 근거)
    spot.score.calculate_spot_score                     (SPOT 점수 — 가중치 0.40/0.40/0.20 그대로)
    spot.ranking.spot_ranking_sort_key                  (근거 등급 → 점수 → 거리 → id)

라우터의 맨 앞 정렬 항(영업 자격 등급)은 영업시간이 없는 구역 가상 시설에서 모두 같아 빠진다.
라우터의 **도보 상한**(`route.duration_min > max_walk_minutes` 면 후보에서 뺀다)도 그대로 건다 — 상한은 API 가
받는 가장 큰 값 20분(`MAX_WALK_MINUTES`)이다. 운영 경로가 내놓을 수 없는 곳을 재생이 고르면 V3 가 엔진이 하지
않는 결정을 채점하게 된다(S4 검토).

## 엔진이 보는 이동 = 라우터가 계산하는 이동(`router_travel_matrix`)
상한 비교·``travel_time_override``·``travel_distance_override``·정렬 키의 거리는 라우터가 서울 요청에서 실제로 쓰는 값이다.
서울 구역 중심은 경주 보행 그래프에서 250m 넘게 떨어져 있어 ``get_walking_routes`` 는 언제나
``spot.travel.estimate_walking_route``(직선 × 1.18 ÷ 66.67, 0.1분 반올림 · 올림 없음, source='estimated')를 낸다 —
``tests/routers/test_crowd_replay_engine_parity.py`` 가 실제 ``get_walking_routes`` 로 모든 서울 구역 쌍에서 같은지 잠근다.
재생의 보수적 이동(우회 1.4 · 분 올림)은 **정답 도착 시각**(t+τ)과 기준선의 추가 이동 계산에만 쓴다 — 엔진 입력으로 쓰면
운영 라우터가 내는 대안(예: 홍대 관광특구 → 합정역 17.4분)을 재생이 빼게 된다(S4 검토 2차).
라우터와 같은 순서·점수인지는 ``tests/routers/test_crowd_replay_engine_parity.py`` 가 실제 핸들러로 잠근다.

import 는 전부 함수 안에서 한다 — ``app.services.batch`` 를 import 해도 라우터가 올라오지 않게(런타임 격리).
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any, Mapping, Sequence

from app.services.crowd.zone_evidence import ZoneDefinition, ZoneReading

PSEUDO_PREFIX = "replay:"
# 라우터가 서울 요청에서 기록하는 이동 출처(estimate_walking_route 의 source) — 점수에는 쓰이지 않고 breakdown 에만 남는다.
TRAVEL_SOURCE = "estimated"
REPLAY_USER_ID = "replay"
REGION = "seoul"
# 라우터의 도보 상한 중 가장 큰 값(`travel_context.TravelContext.max_walk_minutes: Literal[5, 10, 20]`).
# 라우터 규칙: 경로 분이 이 값보다 **크면** 후보에서 뺀다(같으면 남는다).
MAX_WALK_MINUTES = 20


@dataclass(frozen=True)
class EngineLeg:
    """엔진이 보는 한 구간 — 라우터의 ``WalkingRoute`` 와 같은 값(분은 0.1분 반올림, 올림 없음)."""

    minutes: float
    route_m: float
    source: str


def router_travel_matrix(zones: Sequence[ZoneDefinition]) -> dict[tuple[str, str], EngineLeg]:
    """구역 중심 간 **라우터의** 도보 구간 — ``get_walking_routes`` 가 서울에서 내는 값(그래프 밖 추정)과 같다.

    대안 자격(도보 상한)과 엔진 입력(이동 분·m)은 이 값으로 정한다. 정답 도착 시각은 재생의 보수적 이동을 쓴다.
    """
    from app.services.spot.travel import estimate_walking_route

    out: dict[tuple[str, str], EngineLeg] = {}
    for origin in zones:
        for target in zones:
            if origin.zone_id == target.zone_id:
                continue
            route = estimate_walking_route(
                origin.centroid_lat, origin.centroid_lng, target.centroid_lat, target.centroid_lng
            )
            out[(origin.zone_id, target.zone_id)] = EngineLeg(
                float(route.duration_min), float(route.distance_m), route.source
            )
    return out


def pseudo_id(zone_id: str) -> str:
    return PSEUDO_PREFIX + zone_id


def zone_of(pseudo: str) -> str:
    return pseudo[len(PSEUDO_PREFIX):] if pseudo.startswith(PSEUDO_PREFIX) else pseudo


def pseudo_facility(zone: ZoneDefinition) -> dict[str, Any]:
    """구역 → 가상 시설(취향 중립 비교를 위해 모든 구역이 같은 종류·특징·쿠폰 0)."""
    return {
        "id": pseudo_id(zone.zone_id),
        "name": zone.name,
        "type": "attraction",
        "latitude": zone.centroid_lat,
        "longitude": zone.centroid_lng,
        "features": {},
        "coupon_rate": 0.0,
        "barrier_free": None,
    }


def _single(reading: ZoneReading | None) -> tuple[ZoneReading, ...] | None:
    if reading is None:
        return None
    return (replace(reading, weight=1.0, mapped_zone_count=1),)


@dataclass(frozen=True)
class OriginBlock:
    zone_evidence: dict | None
    original_congestion: float | None


@dataclass(frozen=True)
class CandidateResult:
    zone_id: str
    facility_id: str
    score: float
    scoring_mode: str | None
    ranking_tier: int
    ranking_congestion: float | None
    congestion_arrival_basis: str | None
    zone_arrival_band: str | None
    incentive_relief: float | None
    ranking_wait_time: float | None
    travel_time: float
    route_m: float
    sort_key: tuple


@dataclass(frozen=True)
class EngineResult:
    origin_level: float | None
    ranked: tuple[CandidateResult, ...]

    @property
    def choice(self) -> str | None:
        return self.ranked[0].zone_id if self.ranked else None

    def candidate(self, zone_id: str) -> CandidateResult | None:
        for item in self.ranked:
            if item.zone_id == zone_id:
                return item
        return None


def origin_block(origin_reading: ZoneReading | None, t: datetime) -> OriginBlock:
    """출발지 근거 — recommendations.get_recommendations 의 출발지 블록을 그대로 옮겼다.

    구역 관측이 없으면 라우터는 resolve_congestion_evidence(로그 없음, allow_model=False) → 'none' 으로
    가고 original_congestion 은 None 이다(여기서는 같은 결론을 바로 낸다).
    """
    from app.services.congestion_evidence import evidence_is_current
    from app.services.crowd.zone_evidence import zone_evidence_dict

    readings_o = _single(origin_reading)
    if not readings_o:
        return OriginBlock(None, None)
    now = t
    origin_zone_evidence = zone_evidence_dict(readings_o, wall_now=now)
    original_congestion = (
        origin_zone_evidence["level"] if evidence_is_current(origin_zone_evidence, now=now) else None
    )
    return OriginBlock(origin_zone_evidence, original_congestion)


_NEUTRAL: list[float] | None = None


def neutral_vector() -> list[float]:
    global _NEUTRAL
    if _NEUTRAL is None:
        from app.services.spot.preference import get_category_average_vector

        _NEUTRAL = get_category_average_vector([])
    return list(_NEUTRAL)


async def rank_alternatives(
    origin: ZoneDefinition,
    alternatives: Sequence[ZoneDefinition],
    *,
    origin_reading: ZoneReading | None,
    alt_readings: Mapping[str, ZoneReading | None],
    t: datetime,
    travel: Mapping[str, tuple[float, float]],
    block: OriginBlock | None = None,
    max_walk_minutes: float = MAX_WALK_MINUTES,
) -> EngineResult | None:
    """대안 구역들을 실제 엔진으로 채점·정렬한다. 출발지가 '지금' 이 아니면 None(라우터도 기준선이 없다).

    ``travel`` = {대안 zone_id: (분, 경로 m)} — 라우터가 계산하는 값(``router_travel_matrix``)을 준다.
    ``t`` 는 벽시계이자 출발 시각이다(now = wall_now = evidence_now = t).
    이동이 ``max_walk_minutes`` 보다 긴 대안은 라우터처럼 채점하지 않고 뺀다 — 남는 대안이 없으면 ``ranked`` 가
    빈 결과(추천 없음)다.
    """
    from app.routers.recommendations import build_candidate_evidence
    from app.services.spot.ranking import scoring_evidence_tier, spot_ranking_sort_key
    from app.services.spot.score import calculate_spot_score

    block = block if block is not None else origin_block(origin_reading, t)
    if block.original_congestion is None:
        return None
    zone_readings: dict[str, tuple[ZoneReading, ...]] = {}
    single_origin = _single(origin_reading)
    if single_origin:
        zone_readings[pseudo_id(origin.zone_id)] = single_origin
    for zone in alternatives:
        single = _single(alt_readings.get(zone.zone_id))
        if single:
            zone_readings[pseudo_id(zone.zone_id)] = single
    user_vector = neutral_vector()
    results: list[CandidateResult] = []
    for zone in alternatives:
        facility = pseudo_facility(zone)
        minutes, route_m = travel[zone.zone_id]
        if minutes > max_walk_minutes:  # recommendations.get_recommendations 의 하드 캡과 같은 비교
            continue
        evidence = await build_candidate_evidence(
            facility, None, None, now=t, region=REGION, zone_readings=zone_readings, wall_now=t,
        )
        res = await calculate_spot_score(
            user_id=REPLAY_USER_ID,
            preferred_categories=[],
            original_congestion_level=block.original_congestion,
            candidate_facility=facility,
            user_lat=origin.centroid_lat,
            user_lng=origin.centroid_lng,
            user_vector=user_vector,
            congestion_evidence=evidence,
            preference_intent=None,
            travel_time_override=minutes,
            travel_distance_override=route_m,
            travel_source=TRAVEL_SOURCE,
            region=REGION,
            evidence_now=t,
            origin_zone_evidence=block.zone_evidence,
        )
        breakdown = res.breakdown
        key = spot_ranking_sort_key(
            breakdown.get("scoring_mode"), res.score, route_m, facility["id"], breakdown.get("ranking_congestion")
        )
        results.append(CandidateResult(
            zone_id=zone.zone_id,
            facility_id=facility["id"],
            score=float(res.score),
            scoring_mode=breakdown.get("scoring_mode"),
            ranking_tier=scoring_evidence_tier(breakdown.get("scoring_mode"), breakdown.get("ranking_congestion")),
            ranking_congestion=breakdown.get("ranking_congestion"),
            congestion_arrival_basis=breakdown.get("congestion_arrival_basis"),
            zone_arrival_band=breakdown.get("zone_arrival_level_band"),
            incentive_relief=breakdown.get("incentive_relief"),
            ranking_wait_time=breakdown.get("ranking_wait_time"),
            travel_time=float(breakdown.get("travel_time") or minutes),
            route_m=float(route_m),
            sort_key=key,
        ))
    results.sort(key=lambda item: item.sort_key)
    return EngineResult(origin_level=block.original_congestion, ranked=tuple(results))
