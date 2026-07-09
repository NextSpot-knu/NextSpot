# pyrefly: ignore [missing-import]
"""분산 코스(멀티스톱 동선) 추천 라우터.

단일 대안(POST /recommendations)이 '지금 혼잡한 원본의 즉시 대체'를 주는 것과 달리,
여기서는 2~3개 정류지로 이어지는 '동선(코스)'을 짜서 시간에 걸쳐 혼잡을 회피한다.

핵심 아이디어(시간 분산):
  · 1번 정류지 = 사용자 위치에서 가깝고 '지금 도착하면' 여유로운 곳.
  · 2번 정류지 = 1번에서 체류를 마치고 '이동해 도착하는 시각'에 여유로울 것으로 예측되는 곳.
  · 3번 정류지 = 다시 그 뒤 도착 시각 기준으로 여유로울 곳.
  도착 시각 = 직전 도착 + 체류(COURSE_DWELL_MIN) + 이동(get_travel_time_and_distance) 누적.
  각 정류지의 도착시점 예측 혼잡은 predict_service.predict_congestion(도착 hour/dow)로 산출한다.

설계 원칙:
  · SPOT 스코어(선호·시간비용·인센티브)는 calculate_spot_score 로 재사용한다(단일 소스).
  · 반환하는 predicted_congestion 은 '누적 도착 시각' 기준의 정직한 모델 예측치다.
  · 결정적(deterministic): 동점은 (거리 오름차순, id) 로 깬다. 데이터가 없으면(모델/로그 부재)
    조용히 저하되어 빈 코스([])나 짧은 코스를 반환할 뿐, 값을 지어내지 않는다.
"""
import asyncio
from datetime import datetime, timedelta, timezone

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.supabase import get_current_user
from app.services.preference_vector_service import preference_vector_service
from app.services.spot.score import calculate_spot_score
from app.services.spot.travel import calculate_haversine_distance, get_travel_time_and_distance
from app.services.spot.preference import get_category_average_vector
from app.services.predict_service import predict_congestion
# 코스 후보 조회/현재 혼잡 일괄조회/반경 상수는 recommendations 라우터의 헬퍼를 재사용한다(단일 소스).
from app.routers.recommendations import (
    fetch_user,
    fetch_all_facilities,
    fetch_congestion_map,
    _MAX_RECO_DISTANCE_M,
)

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1", tags=["courses"])

# --- 코스 파라미터 ---
MAX_STOPS = 3   # 최대 정류지 수(동선 길이 상한)
MIN_STOPS = 2   # '코스'로 성립하는 최소 정류지 수(후보가 이보다 적으면 있는 만큼만 반환)

# 각 정류지 예상 체류 시간(분) — '다음 정류지 도착 시각' 산정에 쓰는 관광 체류 시간.
# (예측 대기시간과는 별개: 관광객이 그 장소를 즐기는 데 쓰는 시간의 명시적 가정값.)
COURSE_DWELL_MIN = {"restaurant": 60, "cafe": 40, "attraction": 45, "culture": 50}
DEFAULT_DWELL_MIN = 45

# 그리디 탐색 비용 상한: 정류지마다 후보별 이동/예측/점수 호출이 발생하므로 인근 후보 수를 제한한다.
MAX_COURSE_CANDIDATES = 12

# 코스 목적함수 가중치: '도착시점 예측 혼잡 회피'가 코스의 핵심 가치라 크게, SPOT 스코어(선호 등)는 보조.
# 두 항 모두 [0,1] 이라 course_value ∈ [0,1].
CONGESTION_AVOIDANCE_WEIGHT = 0.6
SPOT_SCORE_WEIGHT = 0.4


class CourseRequest(BaseModel):
    user_id: str
    user_lat: float
    user_lng: float
    types: list[str] | None = None  # 코스에 포함할 시설 종류 화이트리스트(없으면 전체 종류 대상)


class CourseStop(BaseModel):
    order: int                    # 방문 순서(1부터)
    facility: dict
    arrival_offset_min: float     # 지금(요청 시각) 기준 이 정류지 도착까지 걸리는 누적 분
    predicted_congestion: float   # 누적 도착 시각 기준 예측 혼잡도(0~1)
    spot_score: float
    reason: str


def _congestion_label(level: float) -> str:
    # 프런트(explore/recommend)의 getCongestionLabel 과 임계값 통일.
    if level >= 0.75:
        return "혼잡"
    if level >= 0.5:
        return "보통"
    if level >= 0.25:
        return "여유"
    return "한산"


def _build_stop_reason(
    order: int,
    facility: dict,
    arrival_offset_min: float,
    predicted_congestion: float,
    current_congestion: float,
) -> str:
    """정직·결정적 한국어 사유. LLM 미사용(코스는 재현 가능해야 함)."""
    name = facility.get("name", "이곳")
    pct = round(predicted_congestion * 100)
    label = _congestion_label(predicted_congestion)
    when = "지금 바로" if order == 1 else f"약 {round(arrival_offset_min)}분 뒤"
    reason = f"{order}번째 코스 {name}: {when} 도착하면 예상 혼잡도 {pct}%({label}) 수준이에요."
    # 현재보다 도착 시점이 눈에 띄게 여유로워지면(시간 분산 효과) 이를 함께 알린다.
    if current_congestion - predicted_congestion >= 0.1:
        drop = round((current_congestion - predicted_congestion) * 100)
        reason += f" 지금보다 약 {drop}%p 여유로워질 시간대예요."
    return reason


async def _evaluate_candidate(
    facility: dict,
    cur_lat: float,
    cur_lng: float,
    cum_offset_min: float,
    now: datetime,
    congestion_now: dict[str, float],
    user_vector: list[float] | None,
    preferred_categories: list[str],
    user_id: str,
) -> dict:
    """현재 위치/누적 시각에서 후보 하나를 평가한다.

    - travel: 현재 위치→후보 이동시간(분)/거리(m).
    - 도착 시각 = now + 누적오프셋 + 이동시간 → 그 시각(hour/dow)의 예측 혼잡.
    - SPOT 스코어는 calculate_spot_score 로 재사용(선호·시간비용·인센티브). 인센티브의 '재배치기여'
      기준선(original_congestion_level)은 후보의 '현재' 혼잡으로 둬서, 지금보다 도착 시점이
      한산해지는(시간 분산) 후보를 보상한다.
    """
    travel_min, dist = await get_travel_time_and_distance(
        start_lat=cur_lat, start_lng=cur_lng,
        end_lat=facility["latitude"], end_lng=facility["longitude"],
    )
    arrival_offset = cum_offset_min + travel_min
    arrival_dt = now + timedelta(minutes=arrival_offset)
    # predict_congestion 은 동기(로컬 sklearn) — 이벤트 루프 비블로킹 위해 워커 스레드로 오프로드.
    predicted_congestion = await asyncio.to_thread(
        predict_congestion, facility["type"], arrival_dt.hour, arrival_dt.weekday()
    )
    current_congestion = congestion_now.get(facility["id"], 0.0)

    # 도착 시점 예상 인원 추정치를 응답 facility 에 주입(원본 리스트 불변 — 얕은 복사).
    scored_facility = {**facility, "current_count": round(facility.get("capacity", 0) * predicted_congestion)}
    score_res = await calculate_spot_score(
        user_id=user_id,
        preferred_categories=preferred_categories,
        original_congestion_level=current_congestion,
        candidate_facility=scored_facility,
        user_lat=cur_lat,
        user_lng=cur_lng,
        user_vector=user_vector,
    )

    course_value = (
        SPOT_SCORE_WEIGHT * score_res.score
        + CONGESTION_AVOIDANCE_WEIGHT * (1.0 - predicted_congestion)
    )
    return {
        "facility": scored_facility,
        "spot_score": score_res.score,
        "predicted_congestion": predicted_congestion,
        "current_congestion": current_congestion,
        "arrival_offset_min": round(arrival_offset, 1),
        "distance_m": dist,
        "course_value": course_value,
    }


@router.post("/courses/recommend", response_model=list[CourseStop])
async def recommend_course(
    req: CourseRequest,
    current_user: dict = Depends(get_current_user),
):
    logger.info("course_request", user_id=req.user_id, types=req.types)

    # 소유권 가드(IDOR 방지): 본문 user_id 는 토큰 주체와 일치해야 한다(타인 선호벡터 조회 차단).
    if req.user_id != current_user["id"]:
        raise HTTPException(status_code=403, detail="요청한 user_id가 인증된 사용자와 일치하지 않습니다.")

    user_info, all_facilities = await asyncio.gather(
        fetch_user(req.user_id), fetch_all_facilities()
    )

    allowed_types = set(req.types or [])
    candidates = [
        f for f in all_facilities
        if (not allowed_types or f.get("type") in allowed_types)
    ]
    if not candidates:
        return []

    # 현실성 컷오프 + 인근 상한: 도보 비현실 거리는 제외하고 가까운 순 상위만 후보로(호출량 제한).
    # 반경 내가 최소 정류지 수 미만이면 가까운 순 폴백(외곽/데이터 희소 위치에서도 코스가 끊기지 않게).
    with_dist = sorted(
        (
            (f, calculate_haversine_distance(req.user_lat, req.user_lng, f["latitude"], f["longitude"]))
            for f in candidates
        ),
        key=lambda x: x[1],
    )
    reachable = [f for f, d in with_dist if d <= _MAX_RECO_DISTANCE_M]
    pool = (
        reachable[:MAX_COURSE_CANDIDATES]
        if len(reachable) >= MIN_STOPS
        else [f for f, _ in with_dist[:MAX_COURSE_CANDIDATES]]
    )
    if not pool:
        return []

    # 선호 벡터 1회 조회(없으면 Cold Start 생성 후 업서트) — recommendations 라우터와 동일 패턴.
    user_vector = await preference_vector_service.get_user_vector(req.user_id)
    if not user_vector:
        user_vector = get_category_average_vector(user_info.get("preferred_categories", []))
        await preference_vector_service.upsert_user_vector(req.user_id, user_vector)

    congestion_now = await fetch_congestion_map([f["id"] for f in pool])
    preferred_categories = user_info.get("preferred_categories", [])
    now = datetime.now(timezone.utc)

    target_stops = min(MAX_STOPS, len(pool))
    remaining = list(pool)
    used_types: set[str] = set()
    cur_lat, cur_lng = req.user_lat, req.user_lng
    cum_offset = 0.0
    chosen: list[dict] = []

    for _ in range(target_stops):
        if not remaining:
            break
        # 종류 다양성: 후보 풀에 여러 종류가 남아 있으면, 아직 방문 안 한 종류를 우선 고른다
        # (카페→식당→관광지 같은 다채로운 동선). 한 종류만 남았거나 모두 방문했으면 전체에서 고른다.
        distinct_types = {f.get("type") for f in remaining}
        pick_from = remaining
        if len(distinct_types) > 1:
            unused = [f for f in remaining if f.get("type") not in used_types]
            if unused:
                pick_from = unused

        evaluations = await asyncio.gather(*[
            _evaluate_candidate(
                f, cur_lat, cur_lng, cum_offset, now, congestion_now,
                user_vector, preferred_categories, req.user_id,
            )
            for f in pick_from
        ])
        # 결정적 선택: course_value 내림차순, 동점은 (거리 오름차순, id).
        evaluations.sort(key=lambda e: (-e["course_value"], e["distance_m"], e["facility"]["id"]))
        best = evaluations[0]
        chosen.append(best)

        best_facility = best["facility"]
        used_types.add(best_facility.get("type"))
        remaining = [f for f in remaining if f["id"] != best_facility["id"]]
        cur_lat, cur_lng = best_facility["latitude"], best_facility["longitude"]
        # 다음 정류지 도착 시각 = 이 정류지 도착 + 체류 시간.
        cum_offset = best["arrival_offset_min"] + COURSE_DWELL_MIN.get(
            best_facility.get("type"), DEFAULT_DWELL_MIN
        )

    stops = [
        CourseStop(
            order=i + 1,
            facility=item["facility"],
            arrival_offset_min=item["arrival_offset_min"],
            predicted_congestion=round(item["predicted_congestion"], 3),
            spot_score=item["spot_score"],
            reason=_build_stop_reason(
                i + 1,
                item["facility"],
                item["arrival_offset_min"],
                item["predicted_congestion"],
                item["current_congestion"],
            ),
        )
        for i, item in enumerate(chosen)
    ]
    logger.info("course_generated", stops=len(stops))
    return stops
