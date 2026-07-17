# pyrefly: ignore [missing-import]
import asyncio
import math
import time
import uuid
from datetime import datetime, timezone
from typing import Literal
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import AliasChoices, BaseModel, Field, field_validator
# 이 라우터는 인증된 사용자 컨텍스트에서 본인 소유 데이터만 다루는 서버→서버 신뢰 경로다.
# recommendations/user_feedback 는 RLS 가 service_role/authenticated 만 INSERT 를 허용하는데,
# anon 클라이언트는 요청별 JWT 를 PostgREST 로 싣지 않아 auth.uid()=null → RLS 거부가 된다.
# (ingest/preferences 라우터가 동일 사유로 supabase_admin 을 쓴다.) 따라서 service_role 클라이언트로
# 통일하고, 신뢰 경계는 아래 get_recommendations/submit_feedback 의 소유권 가드로 강제한다.
from app.core.supabase import supabase_admin as supabase_client, get_current_user
from app.services import feedback_service
from app.services.coupon_service import issue_coupon_if_partner
from app.services.merchant_boost import apply_merchant_boosts, CONGESTION_OVERRIDE_KEY
from app.services.facility_cache import get_facilities_cached
from app.services.preference_nlp_service import CATEGORY_KO
from app.services.preference_vector_service import preference_vector_service
from app.services.reason_service import generate_reason_with_source
from app.services.voice_intent_service import interpret_turn
from app.services.embedding_service import filter_candidates as vector_filter_candidates
from app.services.embedding_service import enrich_candidates as enrich_voice_candidates
from app.routers.infrastructures import fetch_active_facilities, fetch_latest_congestion_for_all
from app.services.spot.score import calculate_spot_score
from app.services.spot.travel import calculate_haversine_distance
from app.services.spot.wait_time import calculate_predicted_wait_time
from app.services.spot.preference import CATEGORY_VECTORS, get_category_average_vector

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1", tags=["recommendations"])

# --- Request/Response Pydantic Models ---
class RecommendRequest(BaseModel):
    user_id: str
    original_facility_id: str
    user_lat: float
    user_lng: float

class RecommendItem(BaseModel):
    recommendation_id: str
    facility: dict
    spot_score: float
    breakdown: dict
    distance_m: float
    reason: str | None = None  # WP3: 백엔드 생성 사유(실패 시 템플릿 폴백)
    # 개발 디버그용 — 위 reason 이 LLM 다듬기로 나왔는지("llm") 템플릿 그대로인지("template").
    reason_source: str = "template"
    rank: int
    total_candidates: int

class FeedbackRequest(BaseModel):
    recommendation_id: str
    # 거절 실험실 액션 어휘(feedback_service.API_ACTIONS 와 동일 집합 — 패리티 테스트로 강제).
    # legacy(accepted/ignored)는 기존 행 보존용으로 DB CHECK 에만 남고 **API 입력에서는 제외**한다.
    # 잘못된 값은 라우터 진입 전 422 로 거부된다.
    action: Literal[
        "accepted_visit_intent",  # 실제 방문 수락 — 수락 표시·쿠폰·벡터 +10%
        "rejected",               # 명시 거절 — reason_status='pending', 장기 학습은 사유 응답 후
        "skipped",                # '다음'/나중에 — 학습 없음
        "dismissed_batch",        # '다른 대안 보기' — 학습 없음
        "unsaved",                # 저장 해제 — 학습 없음
        "helpful",                # 만족도 👍 — 품질 신호만
        "not_helpful",            # 만족도 👎 — 품질 신호만
    ]

# --- Helpers for async DB Calls ---
async def fetch_user(user_id: str):
    res = await asyncio.to_thread(
        supabase_client.table("users").select("*").eq("id", user_id).execute
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="사용자 정보를 찾을 수 없습니다.")
    return res.data[0]

async def fetch_facility(facility_id: str):
    res = await asyncio.to_thread(
        supabase_client.table("facilities").select("*").eq("id", facility_id).execute
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="시설 정보를 찾을 수 없습니다.")
    return res.data[0]

async def _fetch_all_facilities_uncached(
    *, center_lat: float | None = None, center_lng: float | None = None, radius_m: float | None = None
):
    # PostgREST 행수 캡을 넘는 전체 시설 조회. is_active=false(폐업·표출중단 감지, 2차 기획 1위)는
    # 후보에서 제외 — infrastructures.fetch_active_facilities 재사용(컬럼 미배포 시 필터 없이 폴백).
    extra_filters = None
    if center_lat is not None and center_lng is not None and radius_m is not None:
        # PostGIS 없이도 btree 좌표 범위로 먼저 줄인다. 이후 Haversine 원형 필터가 정확도를 보장한다.
        lat_delta = radius_m / 111_320.0
        lng_delta = radius_m / max(1.0, 111_320.0 * math.cos(math.radians(center_lat)))

        def extra_filters(query):
            return (
                query.gte("latitude", center_lat - lat_delta).lte("latitude", center_lat + lat_delta)
                .gte("longitude", center_lng - lng_delta).lte("longitude", center_lng + lng_delta)
            )

    facilities = await fetch_active_facilities(supabase_client, "*", extra_filters=extra_filters)
    # 관광공사 30일 집중률은 POI 실시간 혼잡이 아닌 '오늘의 일별 prior'다. 별도 테이블에서
    # 이름이 정확히 일치하는 행만 붙이며, 마이그레이션/별도 API 승인이 아직 없으면 무해 폴백한다.
    try:
        today = datetime.now(timezone.utc).date().isoformat()
        forecast_res = await asyncio.to_thread(
            lambda: supabase_client.table("tourism_concentration_forecasts")
            .select("tourist_attraction_name,concentration_rate,forecast_date")
            .eq("forecast_date", today).execute()
        )
        by_name = {
            str(row["tourist_attraction_name"]).strip(): float(row["concentration_rate"])
            for row in (forecast_res.data or [])
            if row.get("tourist_attraction_name") and row.get("concentration_rate") is not None
        }
        for facility in facilities:
            rate = by_name.get(str(facility.get("name") or "").strip())
            if rate is not None:
                facility["tourapi_concentration_rate"] = rate
    except Exception as e:
        logger.warning("tourapi_concentration_prior_unavailable", error=str(e))
    return facilities


async def fetch_all_facilities(
    *, center_lat: float | None = None, center_lng: float | None = None, radius_m: float | None = None
):
    # 캐시 키를 사용자 좌표로 쪼개면 위치가 다를 때마다 미스가 난다(실측: 프로덕션 by-type 가
    # 재배포·신규 위치마다 2초/최악 13초). 시설은 85곳뿐이라 전체를 단일 키로 캐시하고,
    # 좌표 사각형 필터는 파이썬에서 동일 수식으로 건다 — DB bbox 는 순수 최적화였고 정확도는
    # 어차피 하류의 Haversine 원형 필터가 보장하므로 최종 결과는 동일하다.
    key = ("all",)

    async def _load():
        return await _fetch_all_facilities_uncached()

    facilities = await get_facilities_cached(key, _load)

    if center_lat is not None and center_lng is not None and radius_m is not None:
        # _fetch_all_facilities_uncached 의 DB bbox 와 동일한 사각형(NULL 좌표는 DB 필터와
        # 동일하게 제외). 여기서 좁힌 뒤의 정밀 판정은 기존처럼 호출부 Haversine 이 담당.
        lat_delta = radius_m / 111_320.0
        lng_delta = radius_m / max(1.0, 111_320.0 * math.cos(math.radians(center_lat)))
        facilities = [
            f for f in facilities
            if f.get("latitude") is not None and f.get("longitude") is not None
            and center_lat - lat_delta <= float(f["latitude"]) <= center_lat + lat_delta
            and center_lng - lng_delta <= float(f["longitude"]) <= center_lng + lng_delta
        ]

    return facilities

async def fetch_latest_congestion(facility_id: str) -> float:
    """
    특정 시설의 가장 최신 congestion_level을 조회합니다. (없으면 기본값 0.0)
    """
    res = await asyncio.to_thread(
        supabase_client.table("congestion_logs")
        .select("congestion_level")
        .eq("facility_id", facility_id)
        .order("timestamp", desc=True)
        .order("id", desc=True)  # 동일 timestamp 동률 시 결정적 정렬(infrastructures 라우터와 통일)
        .limit(1)
        .execute
    )
    if res.data:
        return res.data[0]["congestion_level"]
    return 0.0


async def fetch_congestion_map(facility_ids: list[str]) -> dict[str, float]:
    """후보 시설들의 최신 혼잡도를 일괄 조회해 {facility_id: level} 로 반환한다.

    후보마다 개별 쿼리를 무제한 gather 하던 N+1 팬아웃(스레드풀 고갈 위험)을
    infrastructures.fetch_latest_congestion_for_all(시설별 limit 1, 결정적 정렬) 재사용으로 대체.
    로그가 없는 시설은 0.0.
    """
    congestion_map = await fetch_latest_congestion_for_all(facility_ids)
    return {fid: data["level"] for fid, data in congestion_map.items()}


async def _resolve_user_vector(user_id: str, preferred_categories: list[str]) -> list[float]:
    """사용자 선호 벡터 1회 조회 — 없으면 Cold Start 벡터 생성 후 1회 업서트.

    (두 추천 엔드포인트가 공유하는 동일 패턴 — 후보마다 선호 벡터 저장소를 재조회하지 않는다.)
    """
    user_vector = await preference_vector_service.get_user_vector(user_id)
    if not user_vector:
        user_vector = get_category_average_vector(preferred_categories)
        await preference_vector_service.upsert_user_vector(user_id, user_vector)
    return user_vector


# --- Endpoints ---

@router.post("/recommendations", response_model=list[RecommendItem])
async def get_recommendations(
    req: RecommendRequest,
    current_user: dict = Depends(get_current_user)
):
    logger.info("recommendation_request_received", user_id=req.user_id, original_infra=req.original_facility_id)

    # 0. 소유권 가드 (IDOR 방지): 본문 user_id 는 토큰 주체와 일치해야 한다.
    #    타인의 user_id 로 선호벡터 조회/추천이력 INSERT 를 일으키는 신뢰 경계 위반을 차단.
    if req.user_id != current_user["id"]:
        raise HTTPException(status_code=403, detail="요청한 user_id가 인증된 사용자와 일치하지 않습니다.")

    # 1. 사용자 정보 및 원본 시설 정보 병렬 조회
    user_task = fetch_user(req.user_id)
    original_infra_task = fetch_facility(req.original_facility_id)
    all_infra_task = fetch_all_facilities(
        center_lat=req.user_lat, center_lng=req.user_lng, radius_m=150.0
    )
    
    user_info, original_infra, all_facilities = await asyncio.gather(
        user_task, original_infra_task, all_infra_task
    )

    # 2. 반경 150m 이내 후보 시설 필터링 (본인 시설 제외)
    candidates = []
    for f in all_facilities:
        if f["id"] == req.original_facility_id:
            continue
            
        distance = calculate_haversine_distance(
            req.user_lat, req.user_lng,
            f["latitude"], f["longitude"]
        )
        
        # 150미터 이내 시설만 후보군으로 포함
        if distance <= 150.0:
            candidates.append((f, distance))

    logger.info("candidates_filtered", count=len(candidates), max_radius_m=150)

    # 사용자 선호 벡터는 요청당 1개뿐이므로 여기서 1회만 조회한다. (없으면 Cold Start 벡터 생성 후 1회 업서트)
    user_vector = await _resolve_user_vector(req.user_id, user_info.get("preferred_categories", []))

    # 3. 각 후보군에 대해 SPOT 스코어를 병렬 연산
    #    후보별 최신 혼잡도는 일괄 조회(fetch_congestion_map) 후 맵 참조 — 후보 수만큼의
    #    개별 쿼리 팬아웃(N+1, 스레드풀 고갈 위험)을 제거한다.
    congestion_by_id = await fetch_congestion_map(
        [req.original_facility_id, *[f["id"] for f, _ in candidates]]
    )
    original_congestion = congestion_by_id.get(req.original_facility_id, 0.0)
    # 원본 대기시간도 위 일괄 혼잡 조회 결과를 재사용한다.
    original_wait_time = await calculate_predicted_wait_time(
        facility_type=original_infra["type"],
        congestion_level=original_congestion,
        facility_features=original_infra.get("features"),
    )

    async def _score_candidate(f: dict, dist: float) -> dict:
        candidate_congestion = congestion_by_id.get(f["id"], 0.0)
        # 현재 인원 추정치를 응답 facility 에 주입한다(원본 리스트는 건드리지 않도록 얕은 복사).
        # facilities 스키마에는 current_count 컬럼이 없고 실시간 인원은 congestion_logs 에만 있으므로,
        # capacity × 혼잡도(0~1)로 추정해 프런트 카드의 혼잡/여유 인원 표시가 깨지지 않게 한다.
        f = {**f, "current_count": round(f.get("capacity", 0) * candidate_congestion)}
        score_res = await calculate_spot_score(
            user_id=req.user_id,
            preferred_categories=user_info.get("preferred_categories", []),
            original_congestion_level=original_congestion,
            candidate_facility=f,
            user_lat=req.user_lat,
            user_lng=req.user_lng,
            user_vector=user_vector,
        )
        return {
            "facility": f,
            "spot_score": score_res.score,
            # original_wait_time 은 후보와 무관하게 요청당 1개지만, 추천 행 단독으로도
            # 절감분을 계산할 수 있도록 각 breakdown 에 함께 저장한다(비정규화 스냅샷).
            "breakdown": {**score_res.breakdown, "original_wait_time": original_wait_time},
            "distance_m": dist,
            "candidate_congestion": candidate_congestion,
        }

    recommendation_results = list(
        await asyncio.gather(*[_score_candidate(f, dist) for f, dist in candidates])
    )

    # 4. 스코어 기준 내림차순 정렬 및 상위 5개 선별
    recommendation_results.sort(key=lambda x: x["spot_score"], reverse=True)
    top_n = recommendation_results[:5]  # 추천 제안 개수(요청: 3 → 5)

    # 4-1. WP3: 상위 N개(=top_n)에만 백엔드 사유 생성 (동시 호출, 실패 시 템플릿 폴백)
    #      컨텍스트는 reason_service 가 소비하는 키만 전달한다: _build_template 는 이름·수치를,
    #      facility_id 는 LLM 문체 다듬기의 캐시 키(시설+혼잡도 버킷+시각)로 쓰인다.
    async def _reason_for(item: dict) -> tuple[str, str]:
        bd = item["breakdown"]
        return await generate_reason_with_source({
            "facility_id": item["facility"].get("id"),
            "recommended_facility_name": item["facility"].get("name"),
            "candidate_congestion": item["candidate_congestion"],
            "travel_time": bd.get("travel_time"),
            "predicted_wait": bd.get("wait_time"),
        })

    reasons = await asyncio.gather(*[_reason_for(item) for item in top_n])

    # 5. DB(recommendations)에 추천 이력 저장 후 recommendation_id 획득 및 응답 매핑
    #    상위 N개 INSERT 도 병렬로 처리(직렬 await 제거).
    async def _persist(item: dict):
        return await asyncio.to_thread(
            supabase_client.table("recommendations").insert({
                "user_id": req.user_id,
                "original_facility_id": req.original_facility_id,
                "recommended_facility_id": item["facility"]["id"],
                "spot_score": item["spot_score"],
                "score_breakdown": item["breakdown"],
                "accepted": False
            }).execute
        )

    # return_exceptions=True: INSERT 1건이 일시 DB 오류로 실패해도 정상 처리된 나머지 추천까지 버리지 않는다.
    # 실패 항목은 mock-rec-id 로 강등하되 '제거'하지 않는다 — top_n/reasons[idx] 인덱스 정렬을 유지해
    # 사유가 엉뚱한 시설에 붙는 것을 막는다.
    db_results = await asyncio.gather(*[_persist(item) for item in top_n], return_exceptions=True)

    response_items = []
    total_count = len(recommendation_results)
    for idx, (item, db_res) in enumerate(zip(top_n, db_results)):
        if isinstance(db_res, Exception):
            logger.warning(
                "recommendation_persist_failed",
                error=str(db_res),
                recommended_facility_id=item["facility"]["id"],
            )
            rec_id = "mock-rec-id"
        else:
            rec_id = db_res.data[0]["id"] if db_res.data else "mock-rec-id"

        reason_text, reason_source = reasons[idx]
        response_items.append(RecommendItem(
            recommendation_id=rec_id,
            facility=item["facility"],
            spot_score=item["spot_score"],
            breakdown=item["breakdown"],
            distance_m=item["distance_m"],
            reason=reason_text,
            reason_source=reason_source,
            rank=idx + 1,
            total_candidates=total_count
        ))

    logger.info("recommendations_generated", count=len(response_items))
    return response_items


# --- 타입별 추천(메인 지도 브라우즈): 원본 없이 특정 종류를 선호/혼잡/거리로 랭킹 + 사유 ---
# /recommendations 가 '혼잡한 원본의 대안'(반경 150m)을 주는 것과 달리, 여기선 원본이 없으므로
# 혼잡 기준선(_BROWSE_BASELINE_CONGESTION)을 원본 혼잡도로 삼아 인센티브의 재배치기여
# 성분을 산출한다. (인센티브 = 쿠폰강도 + 재배치기여 결합 — score.py 참조)
_BROWSE_BASELINE_CONGESTION = 0.7
# 현실성 필터: 도보로 닿기 힘든 거리의 시설은 추천에서 제외(사용자 위치 기준 직선거리, m).
# 약 1.5km ≈ 도보 22분. time_cost 가 60분에서 캡되어 원거리
# 페널티가 약한 점을 후보 단계의 reachability 컷오프로 보완한다. 후보가 limit 미만이면 가까운
# 순으로 폴백해 빈손/엣지(사용자가 외곽) 위치에서도 추천이 끊기지 않게 한다.
_MAX_RECO_DISTANCE_M = 1500.0


class RecommendByTypeRequest(BaseModel):
    user_id: str
    facility_type: str
    user_lat: float
    user_lng: float
    exclude_ids: list[str] = []
    limit: int = Field(5, ge=1, le=20)  # 서버 상한: 후보 점수화(예측 + 사유 생성) 호출량 폭증 방지


@router.post("/recommendations/by-type", response_model=list[RecommendItem])
async def recommend_by_type(
    req: RecommendByTypeRequest,
    current_user: dict = Depends(get_current_user)
):
    logger.info("recommend_by_type_request", user_id=req.user_id, facility_type=req.facility_type)

    # 소유권 가드(IDOR 방지): 본문 user_id 는 토큰 주체와 일치해야 한다.
    if req.user_id != current_user["id"]:
        raise HTTPException(status_code=403, detail="요청한 user_id가 인증된 사용자와 일치하지 않습니다.")

    user_info, all_facilities = await asyncio.gather(
        fetch_user(req.user_id),
        fetch_all_facilities(center_lat=req.user_lat, center_lng=req.user_lng, radius_m=_MAX_RECO_DISTANCE_M),
    )

    exclude = set(req.exclude_ids or [])
    candidates = [
        f for f in all_facilities
        if f.get("type") == req.facility_type and f["id"] not in exclude
    ]
    # 외곽 위치에서 반경 내 후보가 부족하면 기존 기능대로 전체 시설 가까운 순 폴백을 보존한다.
    if len(candidates) < max(req.limit, 3):
        all_facilities = await fetch_all_facilities()
        candidates = [
            f for f in all_facilities
            if f.get("type") == req.facility_type and f["id"] not in exclude
        ]
    if not candidates:
        return []

    # 머천트 랭킹 연동(2단계): 활성 타임세일(coupon_rate 유효값 교체)·신선 좌석 상태(혼잡 실측 대체)를
    # 스코어링 전에 오버레이한다(score.py 는 무변경 — 이 함수가 candidate_facility 입력값만 바꿔친다).
    candidates = await apply_merchant_boosts(supabase_client, candidates)

    # 현실성 컷오프: 도보 비현실 거리 시설을 후보에서 제외(직선거리). 가까운 순 정렬 후 반경 내만 남기되,
    # 반경 내가 limit 미만이면 가까운 순으로 폴백(빈손/외곽 위치 방지). 점수 산정 후보가 줄어 호출량도 감소.
    _with_dist = sorted(
        (
            (f, calculate_haversine_distance(req.user_lat, req.user_lng, f["latitude"], f["longitude"]))
            for f in candidates
        ),
        key=lambda x: x[1],
    )
    _reachable = [f for f, d in _with_dist if d <= _MAX_RECO_DISTANCE_M]
    candidates = _reachable if len(_reachable) >= max(req.limit, 3) else [f for f, _ in _with_dist[: max(req.limit, 3)]]

    # 선호 벡터 1회 조회(없으면 Cold Start 생성 후 업서트) — get_recommendations 와 동일 패턴
    user_vector = await _resolve_user_vector(req.user_id, user_info.get("preferred_categories", []))

    # 후보별 최신 혼잡도 일괄 조회(N+1 제거) — get_recommendations 와 동일 패턴
    congestion_by_id = await fetch_congestion_map([f["id"] for f in candidates])

    async def _score(f: dict) -> dict:
        # 신선한 좌석 상태 방송(30분 이내)이 있으면 congestion_logs 조회값 대신 사장 확인 실측을 쓴다.
        cong = f.get(CONGESTION_OVERRIDE_KEY, congestion_by_id.get(f["id"], 0.0))
        dist = calculate_haversine_distance(req.user_lat, req.user_lng, f["latitude"], f["longitude"])
        f2 = {**f, "current_count": round(f.get("capacity", 0) * cong)}
        f2.pop(CONGESTION_OVERRIDE_KEY, None)  # 내부 전용 오버레이 키 — 응답 payload 에는 노출하지 않는다.
        res = await calculate_spot_score(
            user_id=req.user_id,
            preferred_categories=user_info.get("preferred_categories", []),
            original_congestion_level=_BROWSE_BASELINE_CONGESTION,
            candidate_facility=f2,
            user_lat=req.user_lat,
            user_lng=req.user_lng,
            user_vector=user_vector,
        )
        return {
            "facility": f2,
            "spot_score": res.score,
            "breakdown": res.breakdown,
            "distance_m": dist,
            "candidate_congestion": cong,
        }

    scored = list(await asyncio.gather(*[_score(f) for f in candidates]))
    scored.sort(key=lambda x: x["spot_score"], reverse=True)
    top = scored[: max(1, req.limit)]

    # 컨텍스트는 reason_service 가 소비하는 키만 전달한다: _build_template 는 이름·수치를,
    # facility_id 는 LLM 문체 다듬기의 캐시 키(시설+혼잡도 버킷+시각)로 쓰인다.
    async def _reason_for(item: dict) -> tuple[str, str]:
        bd = item["breakdown"]
        return await generate_reason_with_source({
            "facility_id": item["facility"].get("id"),
            "recommended_facility_name": item["facility"].get("name"),
            "candidate_congestion": item["candidate_congestion"],
            "travel_time": bd.get("travel_time"),
            "predicted_wait": bd.get("wait_time"),
        })

    reasons = await asyncio.gather(*[_reason_for(item) for item in top])

    total = len(scored)
    # 브라우즈 랭킹은 DB(recommendations)에 남기지 않는다(합성 recommendation_id 사용).
    return [
        RecommendItem(
            recommendation_id=f"bytype-{item['facility']['id']}",
            facility=item["facility"],
            spot_score=item["spot_score"],
            breakdown=item["breakdown"],
            distance_m=item["distance_m"],
            reason=reasons[idx][0],
            reason_source=reasons[idx][1],
            rank=idx + 1,
            total_candidates=total,
        )
        for idx, item in enumerate(top)
    ]


# --- 음성 비서 1턴 해석(키워드 분류): 발화→의도 + 후보 선호매칭 선택 + 한국어 응답 ---
# 무인증(텍스트/후보만 처리, 사용자 데이터 미접근). 로컬 전용.
class VoiceCandidate(BaseModel):
    """무인증 입력 후보 — 필드별 타입·길이 상한(Codex 감사 P1-4).

    기존 list[dict] 는 후보 '개수'만 제한하고 내부 문자열이 무제한이라 발화 300자 절단을
    우회해 프롬프트 토큰·메모리를 폭증시킬 수 있었다. 정상 트래픽(프런트 실사용 값)은
    전부 상한 안이므로 422 대신 조용한 절단으로 처리해 UX 회귀를 만들지 않는다.
    """
    id: str = Field(..., min_length=1, max_length=64)
    name: str = Field(..., min_length=1)
    cuisine: str | list[str] | None = None
    menu: str | None = None
    congestion: float | None = None
    # apiClient(keysToSnake)는 distance_m 로 보내지만, 변환을 거치지 않는 직접 호출자 방어용으로
    # camelCase 도 수용(Codex 리뷰 — 하위호환 벨트앤서스펜더).
    distance_m: float | None = Field(
        None, validation_alias=AliasChoices("distance_m", "distanceM")
    )

    @field_validator("name", mode="after")
    @classmethod
    def _cap_name(cls, v: str) -> str:
        return v[:80]

    @field_validator("menu", mode="before")
    @classmethod
    def _cap_menu(cls, v):
        return str(v)[:300] if isinstance(v, str) and v.strip() else None

    @field_validator("cuisine", mode="before")
    @classmethod
    def _cap_cuisine(cls, v):
        if isinstance(v, str):
            return v[:120]
        if isinstance(v, list):
            return [str(x)[:60] for x in v[:10]]
        return None

    @field_validator("congestion", "distance_m", mode="before")
    @classmethod
    def _numeric_or_none(cls, v):
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        # 혼잡 0~1, 거리 0~100km 범위 밖은 조작/오류 값 — 버린다(클램프보다 정직)
        return f if 0 <= f <= 100_000 else None


class VoiceTurnRequest(BaseModel):
    # 무인증 엔드포인트 — 입력 크기 제한(과대 페이로드/프롬프트 비대화 방지). 출력은 _coerce 가 enum·후보 id 로 강제.
    utterance: str = Field("", max_length=500)
    facility_type: str = "restaurant"
    current_name: str | None = Field(None, max_length=120)
    candidates: list[VoiceCandidate] = Field(default_factory=list, max_length=30)


# 무인증 유료(LLM) 호출 비용 소진 공격 방어(Codex 감사 P1-3) — search.py 의 슬라이딩 윈도우
# 패턴 미러(단일 인스턴스 데모 전제, 다중 인스턴스는 공유 저장소로 승격 필요).
# 키워드로 해석되는 정상 명령은 산입하지 않는다 — interpret_turn 이 LLM 사용 직전에만 게이트를 호출.
# 초과 시 429 대신 LLM 만 건너뛰고 unknown(재질문)으로 강등 — 데모에서 음성 UI 가 죽지 않게.
_VOICE_LLM_WINDOW_SEC = 60.0
_VOICE_LLM_RATE_LIMIT = 5  # IP당 분당 LLM 보조 해석 상한
_voice_llm_hits: dict[str, list[float]] = {}


def _voice_client_ip(request: Request) -> str:
    """레이트리밋 키용 클라이언트 IP.

    ⚠️ XFF 의 '첫 값'은 클라이언트가 위조 가능하다(프록시는 뒤에 append) — 요청마다 다른
    가짜 첫 값으로 분당 제한을 무한 우회할 수 있다(Codex 리뷰 P1). 신뢰 프록시(Render 엣지)가
    마지막에 덧붙인 값이 실제 피어이므로 **마지막 항목**을 쓴다. 프록시 없는 로컬은 소켓 피어.
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return request.client.host if request.client else "unknown"


def _voice_llm_allowed(ip: str) -> bool:
    """분당 상한 내면 True(호출 1회 소비), 초과면 False — 초과 시 타임스탬프 미기록(윈도우 밀림 방지)."""
    now = time.monotonic()
    hits = [t for t in _voice_llm_hits.get(ip, []) if now - t < _VOICE_LLM_WINDOW_SEC]
    if len(hits) >= _VOICE_LLM_RATE_LIMIT:
        _voice_llm_hits[ip] = hits
        logger.info("voice_llm_rate_limited", ip_prefix=ip[:12])
        return False
    hits.append(now)
    _voice_llm_hits[ip] = hits
    return True


class VoiceTurnResponse(BaseModel):
    action: str  # accept|next|reject|details|select|filter|stop|unknown
    target_facility_id: str | None = None  # select 일 때 후보 id
    match_ids: list[str] = []  # filter 일 때 선호에 맞는 후보 id들(예: '양식' → 양식 식당들)
    spoken: str | None = None  # 백엔드 생성 한국어 응답(없으면 프런트가 자체 멘트)
    # 개발 디버그용 — "AI 가 실제로 돌았는지" 프런트 배지 표시. interpret_turn 이 판정한 값을 그대로 싣는다.
    llm_status: str  # keyword|llm|llm_failed|gated|disabled


@router.post("/voice/turn", response_model=VoiceTurnResponse)
async def voice_turn(req: VoiceTurnRequest, request: Request):
    # 카테고리→한국어 라벨은 preference_nlp_service.CATEGORY_KO 를 단일 정본으로 재사용.
    type_ko = CATEGORY_KO.get(req.facility_type, "시설")
    # typed VoiceCandidate → dict (하류 서비스들은 dict 계약 — 검증·절단은 pydantic 이 이미 완료)
    candidates = [c.model_dump() for c in (req.candidates or [])]
    # 0) 후보 메타 보강 훅 — 로컬 모드의 enrich_candidates 는 no-op passthrough 다(embedding_service 참조).
    #    '자세히/메뉴' 질문의 실데이터(cuisine·menu)는 프런트가 후보에 동봉한다(main/page.tsx interpret).
    try:
        candidates = await enrich_voice_candidates(candidates)
    except Exception:
        pass
    # 1) 백엔드: 의도 분류 + 한국어 응답 + search_query(선호를 구체 메뉴로 확장)(역할 분리의 '대화' 쪽).
    #    llm_gate: 무인증 유료 호출 레이트리밋 — LLM 이 실제로 필요할 때만 카운트를 소비한다.
    ip = _voice_client_ip(request)
    result = await interpret_turn(
        req.utterance, type_ko, req.current_name, candidates,
        llm_gate=lambda: _voice_llm_allowed(ip),
    )
    # 2) 임베딩 의미검색: '선호 필터'로 분류되면 어떤 후보가 맞는지는 벡터가 결정(retrieval).
    #    백엔드 가 확장한 search_query("고깃집"→"삼겹살 갈비 숯불구이…")로 검색해 곱창집·순댓국과 섞이지 않게 한다.
    if result["action"] == "filter":
        query = result.get("search_query") or req.utterance
        try:
            # 백엔드 가 정한 정밀분류(intent_category)를 함께 넘겨, 시드 category 일치 후보를 소프트 부스트(국밥→국밥집).
            vids = await vector_filter_candidates(query, candidates, intent_category=result.get("intent_category"))
        except Exception:
            vids = []
        match = vids or result.get("match_ids") or []  # 벡터 우선, 백엔드 match_ids 가 폴백
        # 분류 게이트(누설 차단): 백엔드 가 정밀분류(intent_category)를 정했고 풀에 그 분류 후보가 있으면,
        # 최종 후보를 그 분류로 강제한다. 벡터가 비활성/실패해 백엔드 match_ids 로 폴백한 경우의 누설까지
        # 막는다('중식'→어탕칼국수 방지). category 는 enrich_voice_candidates 가 시드에서 채운 값.
        ic = (result.get("intent_category") or "").strip()
        if ic and match:
            cat_of = {c.get("id"): c.get("category") for c in candidates}
            # 분류정보가 하나라도 채워졌을 때만 게이트. 전부 None(미시드)이면
            # 게이트를 건너뛰어 match(벡터·백엔드 폴백)를 그대로 신뢰 — 분류정보 없을 때 거짓 next 강등 방지.
            if any(cat_of.values()):
                if any(v == ic for v in cat_of.values()):
                    match = [m for m in match if cat_of.get(m) == ic]
                else:
                    match = []  # 분류정보는 있는데 그 분류 후보가 풀에 없음 → 억지 매칭 금지(누설 차단)
        if match:
            result["match_ids"] = match
        else:
            # 맞는 후보가 없으면 현재 카드를 유지한다. next 로 강등하면 단순 다음 순위(무관한 식당)를
            # 선호에 맞는 결과처럼 읽어주는 오해가 생긴다.
            result["action"] = "filter"
            result["match_ids"] = []
            if ic:
                result["spoken"] = f"근처에 확인된 {ic} 후보가 없어요. 다른 메뉴를 말씀해 주세요."
    # search_query 는 내부용(응답 스키마에 없음) — 제거 후 응답 구성.
    return VoiceTurnResponse(
        action=result["action"],
        target_facility_id=result.get("target_facility_id"),
        match_ids=result.get("match_ids") or [],
        spoken=result.get("spoken"),
        llm_status=result.get("llm_status", "disabled"),
    )


# --- 추천 수락(원클릭) — 원본 없이 특정 시설을 '가겠다'고 확정하는 경로 ---
# 지도/카드에서 대안 장소로 바로 이동을 확정할 때 쓴다(추천 이력이 없어도 동작).
# submit_feedback('accepted')는 사전에 생성된 recommendation_id 를 요구하지만, 이 경로는
# facility_id 만으로 수락을 기록하고 제휴 시설이면 쿠폰을 발급한다(발급 규칙은 피드백 경로와 동일).
class AcceptRequest(BaseModel):
    facility_id: str = Field(..., description="수락(방문 확정)할 시설 id")


class RejectRequest(BaseModel):
    facility_id: str = Field(..., description="메인 탐색에서 거절한 시설 id")


@router.post("/recommendations/reject")
async def reject_recommendation(
    req: RejectRequest,
    current_user: dict = Depends(get_current_user),
):
    """메인 브라우즈 거절을 실험실 pending 결정으로 비차단 적재할 수 있게 한다."""
    user_id = current_user["id"]
    await fetch_facility(req.facility_id)  # 클라이언트 점수·혼잡값 없이 서버의 시설 존재만 검증한다.

    # 동일 시설의 미처리 browse 거절은 재사용한다. 네트워크 재시도로 실험실 항목이 중복되지 않되,
    # reason_status 가 완료/제거된 과거 거절 뒤의 새 거절은 별도 이력으로 남는다.
    existing_res = await asyncio.to_thread(
        supabase_client.table("recommendations")
        .select("id, user_feedback(id, reason_status)")
        .eq("user_id", user_id)
        .eq("recommended_facility_id", req.facility_id)
        .eq("source", "browse")
        .order("created_at", desc=True)
        .limit(1)
        .execute
    )
    recommendation_id = None
    if existing_res.data:
        feedback_rows = existing_res.data[0].get("user_feedback") or []
        if any(row.get("reason_status") == "pending" for row in feedback_rows):
            recommendation_id = existing_res.data[0]["id"]

    if recommendation_id is None:
        inserted = await asyncio.to_thread(
            supabase_client.table("recommendations").insert({
                "user_id": user_id,
                "original_facility_id": req.facility_id,
                "recommended_facility_id": req.facility_id,
                "spot_score": 0.0,
                "score_breakdown": {},
                "accepted": False,
                "source": "browse",
            }).execute
        )
        recommendation_id = inserted.data[0]["id"]

    decision = await feedback_service.record_decision(
        supabase_client,
        user_id=user_id,
        recommendation_id=recommendation_id,
        action="rejected",
    )
    return {
        "success": True,
        "recommendation_id": recommendation_id,
        "feedback_id": decision["row"]["id"],
        "reason_status": decision["row"]["reason_status"],
    }


@router.post("/recommendations/accept")
async def accept_recommendation(
    req: AcceptRequest,
    current_user: dict = Depends(get_current_user),
):
    """특정 시설 방문을 수락 확정하고 제휴 시설이면 쿠폰을 발급한다.

    흐름: 인증 → 시설 존재 검증(404) → recommendations 수락 이력 기록(best-effort) →
    issue_coupon_if_partner(제휴면 발급, coupon_rate 0 이면 발급 없이 issued=False).
    응답: {"success": True, "coupon_issued": bool, "coupon_rate": float, "expires_at": str|None}
    """
    user_id = current_user["id"]

    # 1. 시설 존재 검증(없으면 404 — fetch_facility 가 던진다). coupon_rate 포함 시설 dict 확보.
    facility = await fetch_facility(req.facility_id)

    # 2. 수락 이력 기록 — /admin/impact 의 분산 relocations 집계에 반영된다.
    #    원본이 없는 직접 수락이라 original=recommended=facility_id, spot_score 는 스키마 NOT NULL 기본값 0.0.
    #    이력 저장 실패가 쿠폰 발급(사용자 가치)을 막지 않도록 best-effort(예외 로깅 후 진행).
    try:
        await asyncio.to_thread(
            supabase_client.table("recommendations").insert({
                "user_id": user_id,
                "original_facility_id": req.facility_id,
                "recommended_facility_id": req.facility_id,
                "spot_score": 0.0,
                "score_breakdown": {},
                "accepted": True,
            }).execute
        )
    except Exception as e:
        logger.warning("accept_persist_failed", user_id=user_id, facility_id=req.facility_id, error=str(e))

    # 3. 제휴 시설이면 쿠폰 발급(피드백 경로와 동일 규칙 — 멱등 upsert·만료 7일).
    result = await issue_coupon_if_partner(supabase_client, user_id, facility)
    logger.info("recommendation_accepted", user_id=user_id, facility_id=req.facility_id, coupon_issued=result["coupon_issued"])
    return {"success": True, **result}


#: preference_vector_service.adjust_user_vector_on_feedback 가 이해하는 **legacy** 액션 문자열.
#: 그 서비스는 'accepted' 일 때만 +10% 이고 나머지 전부 -5% 다(신중 구역이라 시그니처 무변경).
#: 신규 어휘는 라우터에서 여기로 번역한다 — 어느 방향으로 벡터를 움직일지는 호출자가 결정한다.
VECTOR_ACTION_REINFORCE = "accepted"  # +10%
VECTOR_ACTION_PENALIZE = "rejected"   # -5%


async def apply_feedback_vector_learning(*, user_id: str, facility: dict, vector_action: str) -> bool:
    """선호 벡터를 1회 보정한다. 실제 '몇 회 부를지'는 호출자(feedback_service 의 학습 슬롯)가 정한다.

    이 함수는 **멱등하지 않다** — feedback_service 가 `should_learn_vector=True` 를 준 경우에만 부른다
    (그 플래그는 행당 생애 최대 1회만 True 다. feedback_service 모듈 docstring 참조).

    Args:
        vector_action: VECTOR_ACTION_REINFORCE(+10%) 또는 VECTOR_ACTION_PENALIZE(-5%).

    Returns:
        실제로 벡터를 움직였으면 True. 미지 카테고리라 스킵했으면 False.
    """
    facility_type = facility.get("type")
    facility_vector = CATEGORY_VECTORS.get(facility_type)
    if facility_vector is None:
        # 미지 카테고리는 제로 벡터 학습(정규화 시 균등벡터로 대체 → 무의미한 보정)이 되므로
        # 조용히 반영하지 않고 경고 후 스킵한다. 피드백 이력 저장 자체는 이미 완료된 뒤다.
        logger.warning("feedback_vector_skip_unknown_type", facility_type=facility_type, user_id=user_id)
        return False
    await preference_vector_service.adjust_user_vector_on_feedback(
        user_id=user_id,
        facility_vector=facility_vector,
        action=vector_action,
    )
    return True


async def resolve_feedback_target(recommendation_id: str, current_user: dict) -> tuple[dict, dict]:
    """피드백/실험실 경로의 공통 진입 가드 — 추천 이력 조회 + 소유권 검사.

    Returns:
        (recommendation, facility)

    Raises:
        HTTPException: 404(합성 id·미존재 추천) / 403(타인 소유).
    """
    # recommendation_id 형식 방어 — by-type 브라우즈는 합성 id("bytype-…", DB 미저장)를 반환하므로
    # 그런 값이 오면 uuid 컬럼 캐스팅 오류로 500 이 나기 전에 깔끔한 404 로 응답한다.
    # (브라우즈 랭킹 수락은 쿠폰 발급 경로가 아니라 카카오맵 길안내로 처리된다.)
    try:
        uuid.UUID(str(recommendation_id))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=404, detail="해당 추천 기록을 찾을 수 없습니다.")

    rec_res = await asyncio.to_thread(
        supabase_client.table("recommendations")
        .select("*, recommended_facility:facilities!recommended_facility_id(*)")
        .eq("id", recommendation_id)
        .execute
    )
    if not rec_res.data:
        raise HTTPException(status_code=404, detail="해당 추천 기록을 찾을 수 없습니다.")

    recommendation = rec_res.data[0]
    # 소유권 가드: 타인의 추천 기록에 피드백을 넣어 그 사람의 선호 벡터를 오염시키는 것을 차단.
    if recommendation["user_id"] != current_user["id"]:
        raise HTTPException(status_code=403, detail="해당 추천 기록에 대한 권한이 없습니다.")

    facility = recommendation.get("recommended_facility")
    if isinstance(facility, list):
        facility = facility[0] if facility else None
    if not facility:
        # facilities 를 조인하지 못했을 시 단독으로 시설 추가 조회
        facility = await fetch_facility(recommendation["recommended_facility_id"])
    return recommendation, facility


@router.post("/feedback")
async def submit_feedback(
    req: FeedbackRequest,
    current_user: dict = Depends(get_current_user)
):
    logger.info("feedback_received", recommendation_id=req.recommendation_id, action=req.action)

    # 1. 추천 이력 조회 + 소유권 가드(합성 bytype-* 는 404).
    _recommendation, facility = await resolve_feedback_target(req.recommendation_id, current_user)
    user_id = current_user["id"]  # body 의 user_id 를 신뢰하지 않는다 — 토큰 주체만 쓴다.

    # 2. 만족도 신호(helpful/not_helpful): 품질 신호 전용 행만 남긴다.
    #    결정 액션이 아니므로 수락 표시·쿠폰·벡터 어느 것도 건드리지 않는다.
    if req.action in feedback_service.QUALITY_ACTIONS:
        signal = await feedback_service.record_quality_signal(
            supabase_client, user_id=user_id, recommendation_id=req.recommendation_id, action=req.action
        )
        logger.info("feedback_quality_signal_recorded", user_id=user_id, action=req.action)
        return {
            "success": True,
            "feedback_id": signal["id"],
            "action": req.action,
            "reason_status": signal["reason_status"],
            "updated_vector": False,
        }

    # 3. 결정 액션: 추천 1건당 결정 행 1개로 멱등 기록한다(중복 학습 금지).
    #    rejected 는 여기서 reason_status='pending' 으로만 적재되고 장기 벡터는 움직이지 않는다 —
    #    실제 -5% 는 실험실에서 사유가 확정될 때(POST /api/v1/lab/{id}/reason) 정확히 1회 적용된다.
    decision = await feedback_service.record_decision(
        supabase_client, user_id=user_id, recommendation_id=req.recommendation_id, action=req.action
    )

    # 4. 실제 방문 수락만 수락 표시 + 쿠폰 발급을 유발한다.
    #    (쿠폰 발급·accepted 플래그 자체가 멱등이라 재요청에도 안전하게 그대로 통과시킨다 —
    #     1차 시도가 중간에 실패한 경우를 재요청으로 복구할 수 있게 한다.)
    if req.action == feedback_service.ACTION_ACCEPTED_VISIT_INTENT:
        await asyncio.to_thread(
            supabase_client.table("recommendations")
            .update({"accepted": True})
            .eq("id", req.recommendation_id)
            .execute
        )
        # 제휴 시설이면 '내 쿠폰함'에 쿠폰 발급 — 실제 '수락'을 게이트로 w3 인센티브(coupon_rate)를
        # 현물화한다. 발급 규칙(제휴 판정·멱등 upsert·만료 7일·best-effort)은 issue_coupon_if_partner 로
        # 통일해 수락 파이프라인(/recommendations/accept)과 동일하게 재사용한다.
        await issue_coupon_if_partner(supabase_client, user_id, facility)

    # 5. 선호 벡터 학습 — 서비스가 학습 슬롯을 선점해준 경우에만(행당 생애 1회).
    updated_vector = False
    if decision["should_learn_vector"]:
        updated_vector = await apply_feedback_vector_learning(
            user_id=user_id, facility=facility, vector_action=VECTOR_ACTION_REINFORCE
        )

    logger.info(
        "feedback_processed",
        user_id=user_id,
        action=req.action,
        created=decision["created"],
        updated_vector=updated_vector,
    )
    return {
        "success": True,
        "feedback_id": decision["id"],
        "action": decision["action"],
        "reason_status": decision["reason_status"],
        "updated_vector": updated_vector,
    }


class UserVectorResponse(BaseModel):
    user_id: str
    vector: list[float]

@router.get("/users/me/vector", response_model=UserVectorResponse)
async def get_my_vector(
    current_user: dict = Depends(get_current_user)
):
    """
    현재 로그인된 사용자의 8차원 선호도 벡터 배열을 조회합니다.
    """
    user_id = current_user["id"]
    try:
        vec = await preference_vector_service.get_user_vector(user_id)
        if vec is None:
            # 기본값 반환 (정규화된 균등 벡터)
            vec = preference_vector_service._normalize_vector([1.0] * 8)
        return UserVectorResponse(user_id=user_id, vector=vec)
    except Exception as e:
        logger.error("get_my_vector_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="내 선호도 벡터 조회에 실패했습니다.")
