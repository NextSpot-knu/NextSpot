# pyrefly: ignore [missing-import]
import asyncio
from typing import Literal
import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
# 이 라우터는 인증된 사용자 컨텍스트에서 본인 소유 데이터만 다루는 서버→서버 신뢰 경로다.
# recommendations/user_feedback 는 RLS 가 service_role/authenticated 만 INSERT 를 허용하는데,
# anon 클라이언트는 요청별 JWT 를 PostgREST 로 싣지 않아 auth.uid()=null → RLS 거부가 된다.
# (ingest/preferences 라우터가 동일 사유로 supabase_admin 을 쓴다.) 따라서 service_role 클라이언트로
# 통일하고, 신뢰 경계는 아래 get_recommendations/submit_feedback 의 소유권 가드로 강제한다.
from app.core.supabase import supabase_admin as supabase_client, get_current_user
from app.services.preference_vector_service import preference_vector_service
from app.services.reason_service import generate_reason
from app.services.voice_intent_service import interpret_turn
from app.services.embedding_service import filter_candidates as vector_filter_candidates
from app.services.embedding_service import enrich_candidates as enrich_voice_candidates
from app.routers.infrastructures import fetch_latest_congestion_for_all
from app.services.spot.score import calculate_spot_score
from app.services.spot.travel import calculate_haversine_distance
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
    rank: int
    total_candidates: int

class FeedbackRequest(BaseModel):
    recommendation_id: str
    # DB CHECK(action IN accepted/rejected/ignored)와 정합. 잘못된 값은 라우터 진입 전 422로 거부된다.
    action: Literal["accepted", "rejected", "ignored"]

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

async def fetch_all_facilities():
    all_data = []
    limit = 1000
    start = 0
    while True:
        # Avoid lambda scope capture issues by specifying start/limit explicitly
        res = await asyncio.to_thread(
            lambda s=start, n=limit: supabase_client.table("facilities").select("*").range(s, s + n - 1).execute()
        )
        if not res.data:
            break
        all_data.extend(res.data)
        if len(res.data) < limit:
            break
        start += limit
    return all_data

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
    all_infra_task = fetch_all_facilities()
    
    user_info, original_infra, all_facilities = await asyncio.gather(
        user_task, original_infra_task, all_infra_task
    )

    # 원본 시설의 실시간 혼잡도 조회
    original_congestion = await fetch_latest_congestion(req.original_facility_id)

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

    # 사용자 선호 벡터는 요청당 1개뿐이므로 후보마다 선호 벡터 저장소 를 재조회하지 않도록 여기서 1회만 조회한다.
    # (없으면 Cold Start 벡터 생성 후 1회 업서트)
    user_vector = await preference_vector_service.get_user_vector(req.user_id)
    if not user_vector:
        user_vector = get_category_average_vector(user_info.get("preferred_categories", []))
        await preference_vector_service.upsert_user_vector(req.user_id, user_vector)

    # 3. 각 후보군에 대해 SPOT 스코어를 병렬 연산
    #    후보별 최신 혼잡도는 일괄 조회(fetch_congestion_map) 후 맵 참조 — 후보 수만큼의
    #    개별 쿼리 팬아웃(N+1, 스레드풀 고갈 위험)을 제거한다.
    congestion_by_id = await fetch_congestion_map([f["id"] for f, _ in candidates])

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
            "breakdown": score_res.breakdown,
            "distance_m": dist,
            "candidate_congestion": candidate_congestion,
        }

    recommendation_results = list(
        await asyncio.gather(*[_score_candidate(f, dist) for f, dist in candidates])
    )

    # 4. 스코어 기준 내림차순 정렬 및 상위 3개 선별
    recommendation_results.sort(key=lambda x: x["spot_score"], reverse=True)
    top_n = recommendation_results[:5]  # 추천 제안 개수(요청: 3 → 5)

    # 4-1. WP3: 상위 N개(=top_n)에만 백엔드 사유 생성 (동시 호출, 실패 시 템플릿 폴백)
    async def _reason_for(item: dict) -> str:
        bd = item["breakdown"]
        return await generate_reason({
            "original_facility_name": original_infra.get("name"),
            "recommended_facility_name": item["facility"].get("name"),
            "original_congestion": original_congestion,
            "candidate_congestion": item["candidate_congestion"],
            "travel_time": bd.get("travel_time"),
            "predicted_wait": bd.get("wait_time"),
            "preference": bd.get("preference"),
            "incentive": bd.get("incentive"),
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

        response_items.append(RecommendItem(
            recommendation_id=rec_id,
            facility=item["facility"],
            spot_score=item["spot_score"],
            breakdown=item["breakdown"],
            distance_m=item["distance_m"],
            reason=reasons[idx],
            rank=idx + 1,
            total_candidates=total_count
        ))

    logger.info("recommendations_generated", count=len(response_items))
    return response_items


# --- 타입별 추천(메인 지도 브라우즈): 원본 없이 특정 종류를 선호/혼잡/거리로 랭킹 + 사유 ---
# /recommendations 가 '혼잡한 원본의 대안'(반경 150m)을 주는 것과 달리, 여기선 원본이 없으므로
# 혼잡 기준선(_BROWSE_BASELINE_CONGESTION)을 원본 혼잡도로 삼아 인센티브의 재배치기여
# 성분과 추천 사유 문맥을 산출한다. (인센티브 = 쿠폰강도 + 재배치기여 결합 — score.py 참조)
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
        fetch_user(req.user_id), fetch_all_facilities()
    )

    exclude = set(req.exclude_ids or [])
    candidates = [
        f for f in all_facilities
        if f.get("type") == req.facility_type and f["id"] not in exclude
    ]
    if not candidates:
        return []

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
    user_vector = await preference_vector_service.get_user_vector(req.user_id)
    if not user_vector:
        user_vector = get_category_average_vector(user_info.get("preferred_categories", []))
        await preference_vector_service.upsert_user_vector(req.user_id, user_vector)

    # 후보별 최신 혼잡도 일괄 조회(N+1 제거) — get_recommendations 와 동일 패턴
    congestion_by_id = await fetch_congestion_map([f["id"] for f in candidates])

    async def _score(f: dict) -> dict:
        cong = congestion_by_id.get(f["id"], 0.0)
        dist = calculate_haversine_distance(req.user_lat, req.user_lng, f["latitude"], f["longitude"])
        f2 = {**f, "current_count": round(f.get("capacity", 0) * cong)}
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

    async def _reason_for(item: dict) -> str:
        bd = item["breakdown"]
        return await generate_reason({
            "original_facility_name": None,
            "recommended_facility_name": item["facility"].get("name"),
            "original_congestion": _BROWSE_BASELINE_CONGESTION,
            "candidate_congestion": item["candidate_congestion"],
            "travel_time": bd.get("travel_time"),
            "predicted_wait": bd.get("wait_time"),
            "preference": bd.get("preference"),
            "incentive": bd.get("incentive"),
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
            reason=reasons[idx],
            rank=idx + 1,
            total_candidates=total,
        )
        for idx, item in enumerate(top)
    ]


# --- 음성 비서 1턴 해석(키워드 분류): 발화→의도 + 후보 선호매칭 선택 + 한국어 응답 ---
# 무인증(텍스트/후보만 처리, 사용자 데이터 미접근). 로컬 전용.
class VoiceTurnRequest(BaseModel):
    # 무인증 엔드포인트 — 입력 크기 제한(과대 페이로드/프롬프트 비대화 방지). 출력은 _coerce 가 enum·후보 id 로 강제.
    utterance: str = Field("", max_length=500)
    facility_type: str = "restaurant"
    current_name: str | None = Field(None, max_length=120)
    candidates: list[dict] = Field(default_factory=list, max_length=30)  # [{id, name, congestion(0~1), distance_m}]


class VoiceTurnResponse(BaseModel):
    action: str  # accept|next|reject|details|select|filter|stop|unknown
    target_facility_id: str | None = None  # select 일 때 후보 id
    match_ids: list[str] = []  # filter 일 때 선호에 맞는 후보 id들(예: '양식' → 양식 식당들)
    spoken: str | None = None  # 백엔드 생성 한국어 응답(없으면 프런트가 자체 멘트)


_VOICE_TYPE_KO = {"restaurant": "음식점", "cafe": "카페", "attraction": "관광지", "culture": "문화시설"}


@router.post("/voice/turn", response_model=VoiceTurnResponse)
async def voice_turn(req: VoiceTurnRequest):
    type_ko = _VOICE_TYPE_KO.get(req.facility_type, "시설")
    candidates = req.candidates or []
    # 0) 후보에 시드된 분류·대표메뉴를 채워 백엔드 가 '자세히/메뉴/혼잡' 질문에 실제 데이터로 답하게 한다.
    try:
        candidates = await enrich_voice_candidates(candidates)
    except Exception:
        pass
    # 1) 백엔드: 의도 분류 + 한국어 응답 + search_query(선호를 구체 메뉴로 확장)(역할 분리의 '대화' 쪽).
    result = await interpret_turn(req.utterance, type_ko, req.current_name, candidates)
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
            # 그 분류가 근처에 없거나 매칭 실패 → next 로만 강등(선택지 폐기 아님). 엉뚱 추천보다 정직한 안내.
            result["action"] = "next"
            result["match_ids"] = []
            if ic:
                result["spoken"] = f"근처에 {ic} 후보가 없어 다른 곳을 보여드릴게요."
    # search_query 는 내부용(응답 스키마에 없음) — 제거 후 응답 구성.
    return VoiceTurnResponse(
        action=result["action"],
        target_facility_id=result.get("target_facility_id"),
        match_ids=result.get("match_ids") or [],
        spoken=result.get("spoken"),
    )


@router.post("/feedback")
async def submit_feedback(
    req: FeedbackRequest,
    current_user: dict = Depends(get_current_user)
):
    logger.info("feedback_received", recommendation_id=req.recommendation_id, action=req.action)

    # 1. 기존 추천 이력 조회
    rec_res = await asyncio.to_thread(
        supabase_client.table("recommendations").select("*, recommended_facility:facilities!recommended_facility_id(*)").eq("id", req.recommendation_id).execute
    )
    if not rec_res.data:
        raise HTTPException(status_code=404, detail="해당 추천 기록을 찾을 수 없습니다.")
    
    recommendation = rec_res.data[0]
    user_id = recommendation["user_id"]

    # 소유권 가드: 타인의 추천 기록에 피드백을 넣어 그 사람의 선호 벡터 저장소 선호벡터를 오염시키는 것을 차단.
    if user_id != current_user["id"]:
        raise HTTPException(status_code=403, detail="해당 추천 기록에 대한 권한이 없습니다.")

    facility = recommendation.get("recommended_facility")
    if not facility:
        # facilities를 조인하지 못했을 시 단독으로 시설 추가 조회
        facility = await fetch_facility(recommendation["recommended_facility_id"])

    # 2. user_feedback 이력 저장
    await asyncio.to_thread(
        supabase_client.table("user_feedback").insert({
            "user_id": user_id,
            "recommendation_id": req.recommendation_id,
            "action": req.action
        }).execute
    )

    # 3. 수락 행동인 경우 recommendations 테이블의 accepted 여부 업데이트
    if req.action == "accepted":
        await asyncio.to_thread(
            supabase_client.table("recommendations")
            .update({"accepted": True})
            .eq("id", req.recommendation_id)
            .execute
        )

    # 4. 선호 벡터 저장소 사용자 선호도 벡터 학습 보정
    # 시설 특성 및 카테고리에 맞는 기본 벡터 획득
    facility_type = facility["type"]
    facility_vector = CATEGORY_VECTORS.get(facility_type)
    if facility_vector is None:
        # 미지 카테고리는 제로 벡터 학습(정규화 시 균등벡터로 대체 → 무의미한 보정)이 되므로
        # 조용히 반영하지 않고 경고 후 스킵한다. 피드백 이력 저장 자체는 위에서 완료됨.
        logger.warning("feedback_vector_skip_unknown_type", facility_type=facility_type, user_id=user_id)
        return {"success": True, "updated_vector": False}

    # 피드백 학습 반영
    await preference_vector_service.adjust_user_vector_on_feedback(
        user_id=user_id,
        facility_vector=facility_vector,
        action=req.action
    )

    logger.info("feedback_processed_and_vector_updated", user_id=user_id)
    return {"success": True, "updated_vector": True}


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
