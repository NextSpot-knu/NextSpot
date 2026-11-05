# pyrefly: ignore [missing-import]
import asyncio
import copy
import math
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import AliasChoices, BaseModel, Field, field_validator, model_validator
# 이 라우터는 인증된 사용자 컨텍스트에서 본인 소유 데이터만 다루는 서버→서버 신뢰 경로다.
# recommendations/user_feedback 는 RLS 가 service_role/authenticated 만 INSERT 를 허용하는데,
# anon 클라이언트는 요청별 JWT 를 PostgREST 로 싣지 않아 auth.uid()=null → RLS 거부가 된다.
# (ingest/preferences 라우터가 동일 사유로 supabase_admin 을 쓴다.) 따라서 service_role 클라이언트로
# 통일하고, 신뢰 경계는 아래 get_recommendations/submit_feedback 의 소유권 가드로 강제한다.
from app.core.client_ip import client_ip
from app.core.config import settings
from app.core.region import (
    PUBLIC_REGION,
    apply_region,
    arun_region_scoped,
    resolve_request_region,
)
from app.core.network_key import network_key_hash
from app.core.report_slots import (
    CONGESTION_VOTES_BY_IP,
    CORROBORATION_WINDOW_SEC,
    GUEST_ANSWER_LAST_BY_USER,
    GUEST_ANSWER_VOTES_BY_IP,
    release_report_slot,
    reserve_report_slot,
    shared_ip_retry_after,
)
from app.core.failure_log import record_failure
from app.core.response_cache import (
    ResponseCache,
    assumed_time_bucket,
    model_signature,
    round_location,
)
from app.core.supabase import supabase_admin as supabase_client, get_current_user
from app.services import feedback_service, reference_snapshot
from app.services.coupon_service import issue_coupon_if_partner
from app.services.merchant_boost import apply_merchant_boosts, CONGESTION_OVERRIDE_KEY
from app.services.facility_cache import get_facilities_cached
from app.services.preference_nlp_service import CATEGORY_KO
from app.services.preference_vector_service import preference_vector_service
from app.services.reason_service import generate_reason_with_source
from app.services.voice_intent_service import interpret_turn
from app.services.embedding_service import filter_candidates as vector_filter_candidates
from app.services.embedding_service import enrich_candidates as enrich_voice_candidates
from app.routers.infrastructures import (
    CongestionEstimate,
    _exact_current_count,
    congestion_estimate_model,
    fetch_active_facilities,
    fetch_latest_congestion_for_all,
)
from app.services.predict_service import get_model_info, predict_congestion_detailed
from app.services.area_demand_service import get_area_demand_signal
from app.services.availability_service import (
    attach_availability_evidence,
    fetch_effective_availability_map,
)
from app.services.area_demand_decision_service import (
    annotate_arrival_actions,
    annotate_relative_demand,
)
from app.services.spot.score import calculate_spot_score
from app.services.spot.travel import get_walking_routes
from app.services.spot.ranking import spot_ranking_sort_key
from app.services.congestion_evidence import (
    ZONE_EVIDENCE_TIER,
    attach_estimate,
    evidence_is_current,
    load_current_estimates,
    measurement_is_current,
    rankable_measured_level,
)
from app.services.crowd.zone_evidence import load_zone_readings, zone_evidence_dict
from app.services.travel_context import (
    KST,
    RECOMMENDATION_ELIGIBILITY_LABELS,
    TravelContext,
    facility_matches_context,
    open_status_at_arrival,
    recommendation_eligibility_tier,
    select_eligibility_tiers,
)
from app.services.tourism_area_prior_service import attach_tourism_area_priors
from app.services.tourism_related_service import attach_related_destination_priors
from app.services.discovery_theme_service import discovery_theme_match
from app.services.recommendation_explanation_service import explain as explain_snapshot
from app.services.spot.wait_time import calculate_predicted_wait_time
from app.services.spot.industry_baseline import get_predicted_baseline_congestion
from app.services.spot.preference import CATEGORY_VECTORS, build_facility_preference_vector, get_category_average_vector

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1", tags=["recommendations"])


def parse_assumed_time(raw: str | None) -> datetime | None:
    """데모용 '가정 출발 시각'(ISO 8601)을 UTC datetime 으로 파싱한다.

    심야에 심사위원이 방문해도 실제 결과가 보이도록, 프런트가 사용자가 고른 요일+시각을
    절대 시각(ISO 8601)으로 실어 보낸다. 이 값이 있으면 추천/코스의 도착 시각 영업여부·
    도착시점 혼잡·SPOT 채점의 기준 시각이 된다. 없거나(빈 값) 형식이 틀리면 ``None`` 을
    돌려주고, 호출부는 그대로 ``datetime.now(UTC)`` 로 동작한다 — **기본 동작을 절대 바꾸지 않고,
    잘못된 입력에도 절대 죽지 않는다**(조용히 무시). 두 추천/코스 라우터가 이 단일 정의를 공유한다.
    """
    if not raw or not isinstance(raw, str):
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# --- Request/Response Pydantic Models ---
class RecommendRequest(BaseModel):
    user_id: str
    original_facility_id: str
    user_lat: float
    user_lng: float
    context: TravelContext | None = None
    preference_intent: str | None = Field(None, max_length=120)
    candidate_types: list[Literal["restaurant", "cafe", "attraction", "culture"]] = Field(
        default_factory=list, max_length=2
    )
    discovery_theme: Literal[
        "silla_core", "night_heritage", "hanok_cafe", "indoor_history", "gyochon_walk"
    ] | None = None
    # 영업 확인 등급이 카드 수보다 적을 때 다음 등급(영업 미확인)에서 채울지. 채운 카드는 확인된 곳 뒤에 서야
    # 하는데, 배포된 구 번들은 응답을 점수로 다시 줄 세워 eligibility_tier 를 보지 않는다 — 그래서 등급 순으로
    # 그리는 새 번들만 true 를 보내고, 없거나 false 면 종전처럼 가장 강한 등급만 돌려준다.
    fill_weaker_tiers: bool = False

class RecommendItem(BaseModel):
    recommendation_id: str
    facility: dict
    spot_score: float
    breakdown: dict
    distance_m: float
    reason: str | None = None  # WP3: 백엔드 생성 사유(실패 시 템플릿 폴백)
    # 개발 디버그용 — 위 reason 이 LLM 다듬기로 나왔는지("llm") 템플릿 그대로인지("template").
    reason_source: str = "template"
    # 혼잡 3단계 근거(CONGESTION_TRUST_SPEC) — 지도 경로 CongestionInfo 규약을 추천 응답에 이식.
    # measured=congestion_logs 실측(또는 사장 확인), predicted=학습된 모델의 AI 예측,
    # none=근거 없음(혼잡 정보 준비 중 — 0.0/0.5 를 실측처럼 팔지 않는다).
    congestion_level: float | None = None
    congestion_source: Literal["measured", "predicted", "none"] = "none"
    # predicted 의 출처 — model = 학습된 모델의 예측, industry_baseline = 업종의 일반적인 시간대 곡선
    # (spot/industry_baseline.py — 이 가게를 잰 값도, 학습한 값도 아니다). 화면은 industry_baseline 에
    # '%'·'AI' 를 붙이지 않는다. predicted 가 아니면 None. 추가만 한 필드라 구 번들은 모르고 지나간다.
    congestion_prediction_basis: Literal["model", "industry_baseline"] | None = None
    congestion_log_source: str | None = None   # measured 일 때 원 로그 source(user_report/seed/…)
    congestion_is_stale: bool | None = None    # measured 일 때 로그 나이>24h
    congestion_timestamp: str | None = None    # measured 일 때 로그 시각
    # 위 congestion_level 이 '지금' 을 말할 자격이 있는가(congestion_evidence.evidence_is_current):
    # measured 는 verified/corroborated · 30분 이내(사장님 좌석 방송 포함), predicted 는 언제나 true,
    # none 은 false. **판정은 서버만 한다** — 화면이 다시 계산하면 같은 판단의 네 번째 복사본이 된다.
    # false 면 화면은 아래 congestion_estimate 를 '지금' 으로 칠하고 이 관측은 '마지막 관측 HH:MM'
    # 으로 남긴다. 값 자체는 응답에서 지우지 않는다(실제로 있었던 관측이고, 이 필드를 모르는 구
    # 번들은 종전과 똑같이 그 실측을 그린다 — 새 필드가 화면에서 값을 빼앗지 않는다).
    congestion_is_current: bool | None = None
    # 추정 모드(계획서 §5.2) — '지금' 자격이 있는 실측·예측이 없을 때만 채운다
    # (측정(신선·신뢰) > 예측 > 추정 > 없음. 낡은·단건 실측은 여기서 자리를 내준다 — 2026-09-20 결정,
    #  근거는 congestion_evidence.attach_estimate 주석).
    # congestion_source 에 'estimated' 를 새 값으로 넣지 않은 이유: 구 번들(배포 시차)은
    # source !== 'none' 이면 level 을 실측·예측처럼 칠하고 로컬 순위에도 쓴다. 옆 칸에 두면 구
    # 번들은 모르고 지나가고(종전과 같은 '정보 준비 중'), 새 번들만 '추정' 라벨로 그린다.
    # 순위에는 들어가지 않는다 — 같은 주차·관광 신호가 이미 area_stats_rules 로 반영된다(spot/ranking.py).
    congestion_estimate: CongestionEstimate | None = None
    rank: int
    total_candidates: int
    open_status_at_arrival: str | None = None
    information_confidence: str | None = None
    eligibility_tier: str | None = None
    place_data_source: str | None = None
    data_updated_at: str | None = None
    scoring_mode: Literal["model", "measured_rules", "area_stats_rules", "degraded_rules"] = "degraded_rules"
    model_version: str | None = None
    prediction_source: Literal["registry", "measured", "unavailable"] = "unavailable"

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


class ExplainRequest(BaseModel):
    question: Literal["why_first", "difference", "family_check"]
    comparison_recommendation_ids: list[str] = Field(default_factory=list, max_length=2)
    locale: Literal["ko", "en", "ja", "zh"] = "ko"


class ExplainResponse(BaseModel):
    answer: str
    source_labels: list[str]
    llm_status: str

# --- Helpers for async DB Calls ---
async def fetch_user(user_id: str):
    res = await asyncio.to_thread(
        supabase_client.table("users").select("*").eq("id", user_id).execute
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="사용자 정보를 찾을 수 없습니다.")
    return res.data[0]

async def fetch_facility(facility_id: str, *, region: str = PUBLIC_REGION):
    """시설 1건 — **요청 지역의 시설만**(쿼리 안의 region 필터). 다른 지역 id 는 없는 시설과 같은 404 다.

    기본값은 공개 지역(경주)이다 — 빠뜨려도 서울 시설이 나오지 않는다(fail-closed). region 컬럼이 아직 없는
    DB(마이그레이션 전)에서는 경주만 필터 없이 다시 읽는다(core/region.run_region_scoped).
    """

    def _read(with_region: bool) -> list[dict]:
        query = supabase_client.table("facilities").select("*").eq("id", facility_id)
        if with_region:
            query = apply_region(query, region)
        return query.execute().data or []

    rows = await arun_region_scoped(_read, region=region)
    if not rows:
        raise HTTPException(status_code=404, detail="시설 정보를 찾을 수 없습니다.")
    return rows[0]


# 추천 이력 행의 지역 표시 — **경주가 아닌 추천에만** 스냅샷에 ``region`` 을 적는다(경주 행은 글자 하나 바뀌지 않는다).
# 두 곳이 이 표시를 읽는다: DB 의 RESTRICTIVE 정책 recommendations_public_region_only(관제 계정이 남의 서울 추천 행을
# 브라우저에서 못 읽게 — 서울 시설이 지워져 id 가 NULL 이 돼도) · /admin/model-trust(경주 관제 숫자에서 뺀다).
RECOMMENDATION_REGION_KEY = "region"


def _region_marker(region: str) -> dict:
    """스냅샷에 펼쳐 넣을 지역 표시. 공개 지역(경주)이면 빈 dict."""
    return {} if region == PUBLIC_REGION else {RECOMMENDATION_REGION_KEY: region}


def _region_marker_snapshot(region: str) -> dict:
    """스냅샷 없이 넣던 행(직접 수락 · 메인 거절)에 붙일 칸. 경주면 빈 dict — 종전 payload 그대로."""
    marker = _region_marker(region)
    return {"recommendation_snapshot": marker} if marker else {}


def public_facility_view(row: dict) -> dict:
    """응답으로 나가는 시설 dict — ``region`` 을 뺀 **사본**. 원본(풀·캐시 행)은 건드리지 않는다.

    지역은 서버 내부의 격리 키다. 응답에 실으면 경주 응답의 모양이 지역 도입 전과 달라지고, 화면이 그 값으로
    무엇을 판정할 여지가 생긴다(판정은 서버만 한다). 캐시 행에서 지우면 다음 요청의 격리가 무너진다.
    """
    if not isinstance(row, dict) or "region" not in row:
        return row
    return {key: value for key, value in row.items() if key != "region"}


def _attach_tourism_area_priors(facilities: list[dict], forecasts: list[dict]) -> None:
    """관광지 일별 통계를 반경 2km의 지역 기준선으로 전파한다.

    관광·문화 유형 중 표시 차이만 정규화해 유일하게 일치한 시설을 좌표 앵커로 삼는다.
    주변 시설은 2km에서 중립값 50으로 수렴하도록 감쇠해 관광지 수치를 카페 내부
    혼잡처럼 복사하지 않는다. 충돌하거나 애매한 이름은 앵커로 쓰지 않는다.
    """
    attach_tourism_area_priors(facilities, forecasts)

async def _fetch_all_facilities_uncached(
    *,
    center_lat: float | None = None,
    center_lng: float | None = None,
    radius_m: float | None = None,
    region: str = PUBLIC_REGION,
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

    facilities = await fetch_active_facilities(
        supabase_client, "*", region=region, extra_filters=extra_filters
    )
    if region != PUBLIC_REGION:
        # 관광공사 집중률(아래)은 경주 관광지 이름 앵커다 — 다른 지역 시설에는 붙이지 않는다.
        return facilities
    # 관광공사 30일 집중률은 POI 실시간 혼잡이 아닌 '오늘의 일별 prior'다. 이름 일치 관광지를
    # 좌표 앵커로 삼아 반경 2km에 거리 감쇠 지역 기준선을 붙인다. 미승인 환경은 무해 폴백한다.
    try:
        today = datetime.now(KST).date().isoformat()
        forecast_res = await asyncio.to_thread(
            lambda: supabase_client.table("tourism_concentration_forecasts")
            .select("tourist_attraction_name,concentration_rate,forecast_date")
            .eq("forecast_date", today).execute()
        )
        # 붙이기(1,682곳 × 앵커 거리 계산, 데스크톱 ~54ms · Render ~0.2-0.4초)는 스레드에서 한다 — 180초마다의
        # 재적재가 그동안 이벤트 루프(/health 포함)를 멈추지 않게. 이 행들은 방금 적재한 것이고 캐시는 _load()
        # 가 돌아온 뒤에야 저장하므로, 스레드가 도는 동안 다른 코루틴이 이 행들을 볼 수 없다.
        await asyncio.to_thread(_attach_tourism_area_priors, facilities, forecast_res.data or [])
    except Exception as e:
        logger.warning("tourapi_concentration_prior_unavailable", error=str(e))
    return facilities


def _within_bbox(facilities: list[dict], center_lat: float, center_lng: float, radius_m: float) -> list[dict]:
    """_fetch_all_facilities_uncached 의 DB bbox 와 동일한 사각형(NULL 좌표는 DB 필터와 동일하게 제외).
    여기서 좁힌 뒤의 정밀 판정은 기존처럼 호출부 Haversine 이 담당. 행을 읽기만 한다."""
    lat_delta = radius_m / 111_320.0
    lng_delta = radius_m / max(1.0, 111_320.0 * math.cos(math.radians(center_lat)))
    return [
        f for f in facilities
        if f.get("latitude") is not None and f.get("longitude") is not None
        and center_lat - lat_delta <= float(f["latitude"]) <= center_lat + lat_delta
        and center_lng - lng_delta <= float(f["longitude"]) <= center_lng + lng_delta
    ]


async def fetch_all_facilities(
    *,
    center_lat: float | None = None,
    center_lng: float | None = None,
    radius_m: float | None = None,
    with_availability: bool = True,
    copy_rows: bool = True,
    region: str = PUBLIC_REGION,
):
    """시설 목록. ``with_availability=False`` 면 영업 근거를 붙이지 않는다.

    ``region`` 은 **한 지역의 풀**만 돌려준다(기본값 공개 지역 = 경주, fail-closed). 경주의 캐시 키는 지역 도입
    전과 같은 ``('all',)`` 이고, 다른 지역은 ``('region', r)`` 로 따로 캐시한다 — 두 풀은 섞이지 않는다.

    ``copy_rows=False`` 면 캐시 행을 깊은 복사하지 않고 **공유 행 그대로** 돌려준다
    (목록만 새 list). 호출부는 행과 그 안의 중첩 값을 읽기만 하고, 계속 쓸 행은
    쓰기 전에 직접 ``copy.deepcopy`` 해야 한다. 코스처럼 1,600여 곳 중 수십 곳만 남기는
    호출부가 전체 깊은 복사(요청당 수십~백여 ms CPU)를 치르지 않게 하려는 것이다.

    영업 근거는 캐시 밖에서 매 요청 조회하는데, PostgREST 의 in.(...) URL 한계 때문에
    150개씩 끊어 받는다 — 시설이 1,600곳이면 **그것만으로 요청 11건**이다.
    후보 몇 곳에만 필요한 호출부(코스 추천)는 이걸 끄고 자기 후보 풀에 대해서만 따로
    붙이는 편이 훨씬 싸고, 평가 직전 값이라 신선도도 낫다.
    """
    # 캐시 키를 사용자 좌표로 쪼개면 위치가 다를 때마다 미스가 난다(실측: 프로덕션 by-type 가
    # 재배포·신규 위치마다 2초/최악 13초). 그래서 좌표와 무관한 단일 키로 캐시하고,
    # 좌표 사각형 필터는 파이썬에서 동일 수식으로 건다 — DB bbox 는 순수 최적화였고 정확도는
    # 어차피 하류의 Haversine 원형 필터가 보장하므로 최종 결과는 동일하다.
    #
    # 시설 수(활성 1,669곳, 2026-09-20 실측)가 늘어도 이 판단은 그대로다 — 미스가 곧 재조회이고
    # 재조회 비용이 위 실측치이기 때문이다. 다만 전체를 메모리에 올리는 구조라, 자릿수가
    # 한 번 더 늘면 그때는 캐시 대상을 좁히는 쪽을 다시 봐야 한다.
    key = ("all",) if region == PUBLIC_REGION else ("region", region)

    async def _load():
        if region == PUBLIC_REGION:
            return await _fetch_all_facilities_uncached()
        return await _fetch_all_facilities_uncached(region=region)

    has_bbox = center_lat is not None and center_lng is not None and radius_m is not None
    if copy_rows and has_bbox:
        # 사각형으로 먼저 좁히고 **남은 행만** 깊은 복사한다(전체 1,682곳을 복사한 뒤 버리던 것 — 데스크톱
        # 21~22ms → 5~9ms, Render 로 요청마다 ~50-90ms 의 이벤트 루프 CPU). 사각형 판정은 행을 읽기만 하고,
        # deepcopy(list) 는 메모 하나로 복사하므로 남은 행끼리의 공유 관계도 '전체 복사 뒤 필터' 와 똑같다.
        # 돌려주는 행은 여전히 캐시와 완전히 분리된 사본이다.
        shared = await get_facilities_cached(key, _load, isolate=False)
        facilities = copy.deepcopy(_within_bbox(shared, center_lat, center_lng, radius_m))
    else:
        if copy_rows:
            facilities = await get_facilities_cached(key, _load)
        else:
            facilities = await get_facilities_cached(key, _load, isolate=False)
        if has_bbox:
            facilities = _within_bbox(facilities, center_lat, center_lng, radius_m)

    if not with_availability:
        return facilities

    # 시설·관광 prior 캐시와 수명이 다른 단기 영업 근거(30/60분)는 캐시 밖에서 매 요청
    # 한 번만 조회한다. 그래야 두 번째 사용자 확인과 만료가 다음 추천에 즉시 반영된다.
    availability_by_id = await fetch_effective_availability_map(
        [str(f["id"]) for f in facilities if f.get("id")]
    )
    return attach_availability_evidence(facilities, availability_by_id)

async def fetch_congestion_map(facility_ids: list[str]) -> dict[str, dict]:
    """후보 시설들의 최신 혼잡 로그를 일괄 조회해 {facility_id: info} 로 반환한다.

    후보마다 개별 쿼리를 무제한 gather 하던 N+1 팬아웃(스레드풀 고갈 위험)을
    infrastructures.fetch_latest_congestion_for_all(시설별 limit 1, 결정적 정렬) 재사용으로 대체.
    info = {level, current_count, timestamp, source, is_stale} — 로그가 없는 시설은 맵에서
    **누락**된다(0.0 합성 금지 — CONGESTION_TRUST_SPEC: 누락이 곧 '근거 없음' 신호다).
    """
    return await fetch_latest_congestion_for_all(facility_ids)


async def _attach_delayed_area_actions(
    items: list[dict], *, now: datetime, delay_minutes: int = 30, region: str = PUBLIC_REGION
) -> None:
    """상위 후보만 30분 지연 출발과 비교한다.

    이력이나 관광 통계가 없으면 delayed signal은 None이며 행동 추천도
    ``no_clear_advantage``로 닫힌다. 현재 실측을 미래로 복사하지 않는다.
    주변 수요 신호는 경주 전용이라 다른 지역에서는 아무것도 하지 않는다.
    """
    if region != PUBLIC_REGION:
        return
    delayed_signals = await asyncio.gather(*[
        get_area_demand_signal(
            item["facility"],
            now + timedelta(
                minutes=float(item["breakdown"].get("travel_time") or 0.0) + delay_minutes
            ),
        )
        for item in items
    ])
    annotate_arrival_actions(items, delayed_signals, delay_minutes=delay_minutes)


async def resolve_congestion_evidence(
    facility: dict, log_info: dict | None, *, now: datetime | None = None, allow_model: bool = True
) -> dict:
    """후보 1건의 혼잡 근거 3단계를 판정한다(CONGESTION_TRUST_SPEC).

    - measured: 최신 congestion_logs 현장 관측(원 로그 source·신선도·증거등급 동봉)
    - predicted: 로그 없음 + 모델이 실제로 학습된 AI 예측(``now`` 시각 기준)
    - none: 로그 없음 + 모델 미학습 — 0.5 평탄 폴백을 예측으로 팔지 않는다
      (업종 예측 기준선 폴백은 여기서 하지 않는다 — build_candidate_evidence 가 추정보다 뒤,
       'none' 자리에서만 얹는다. 그래야 실측·모델·추정 우선순위가 보존된다.)

    ``now`` 는 예측 시각의 기준이다. 없으면 서버 현재 시각(UTC)을 쓴다 — 기존 동작 그대로.
    데모 '가정 시각'을 넘기면 그 시각의 hour/weekday 로 예측한다(가정 시각 시뮬레이터 정합).

    ⚠️ 알려진 순서 공백(지금은 잠들어 있다): 로그가 **있기만 하면** 나이·등급을 보지 않고 measured 로
    내려가므로, '모델이 학습된 상태 + 낡은 실측' 후보는 예측이 아니라 추정이 '지금' 자리를 가져간다
    (우선순위 문장은 예측 > 추정이다). 여기서 predicted 로 갈아 끼우지 않는 이유는 그렇게 하면 실측
    값이 응답에서 **사라지기** 때문이다 — 관측을 지우지 않는다는 선이 더 중요하다. 프로덕션은 모델
    미학습이라 이 분기가 실제로 갈라지지 않는다. 고치려면 evidence 에 예측을 옆 칸으로 더 싣고
    화면이 고르게 해야 한다(제품 결정으로 남긴다).
    """
    # 모델 유무와 현장 관측 유무는 별개다. 모델이 없어도 방문객·사장·운영자가 방금 남긴
    # 실제 관측은 출처와 함께 표시한다. 단, degraded_rules 점수에는 혼잡/대기를 섞지 않는다.
    if log_info is not None:
        return {
            "level": log_info["level"],
            "source": "measured",
            "log_source": log_info.get("source"),
            "current_count": _exact_current_count(log_info),
            "evidence_tier": log_info.get("evidence_tier"),
            "is_stale": bool(log_info.get("is_stale", False)),
            "timestamp": log_info.get("timestamp"),
        }
    # allow_model=False(공개 지역이 아닌 요청) — 경주에서 학습한 모델로 다른 지역의 혼잡을 말하지 않는다.
    if not allow_model or not get_model_info()["trained"]:
        return {
            "level": None, "source": "none", "log_source": None,
            "evidence_tier": None, "is_stale": None, "timestamp": None,
        }
    # 모델은 UTC 시각으로 학습됨(score.py 와 동일 관례). now 를 넘기면 그 시각(가정 시각 포함)으로.
    moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    predicted, pred_source = await asyncio.to_thread(
        predict_congestion_detailed, facility.get("type") or "", moment.hour, moment.weekday()
    )
    if pred_source == "registry" and predicted is not None:
        return {
            "level": predicted, "source": "predicted", "log_source": None,
            "evidence_tier": None, "is_stale": None, "timestamp": None,
            # 아래 업종 시간대 곡선도 source 는 'predicted' 다 — 화면·사유가 둘을 가를 수 있게 출처를 단다.
            "prediction_basis": "model",
        }
    return {
        "level": None, "source": "none", "log_source": None,
        "evidence_tier": None, "is_stale": None, "timestamp": None,
    }


async def build_candidate_evidence(
    facility: dict, log_info: dict | None, estimates: dict | None = None,
    *, now: datetime | None = None,
    region: str = PUBLIC_REGION,
    zone_readings: dict | None = None,
    wall_now: datetime | None = None,
) -> dict:
    """후보 1건의 혼잡 근거 — **세 경로가 공유하는 단일 정의.**

    좌석 방송 오버레이(30분 이내 사장 확인)가 있으면 그것을 실측으로 쓰고, 없으면
    `resolve_congestion_evidence` 의 3단계 판정으로 내려간다. 그 결과가 '지금' 을 말할 자격이
    없고(``is_current=False`` — 근거 없음이거나, 낡은·단건 실측) ``estimates``(load_current_estimates
    결과)에 이 시설의 추정이 있으면 ``estimate`` 칸에 싣는다 — source/level 은 **손대지 않는다**
    (congestion_evidence.attach_estimate 주석 참조).
    반환 dict 에는 언제나 ``estimate``·``is_current`` 키가 있다.

    우선순위(높은 것이 이긴다):
      1. 실측(신선·신뢰) / 사장님 좌석 방송
      2. 학습된 모델의 예측
      3. 추정(주차 실측 + 관광 통계) — estimate 옆 칸(source 는 'none' 그대로)
      4. **업종 예측 기준선** — 위 셋이 모두 없을 때만. congestion_source='predicted'(화면 '예측'
         라벨)로 얹는다. 이 값은 이 시설을 측정한 것이 아니라 업종의 일반적 시각·요일 패턴을
         코드화한 휴리스틱 예측이라(industry_baseline.get_predicted_baseline_congestion),
         'measured' 로는 절대 쓰지 않고 순위(SPOT 점수)에도 넣지 않는다 — 카드 표시 전용이다.
         ``now`` 의 KST 시각·요일에 따라 값이 달라져, 가정 시각 시뮬레이터가 카드 혼잡을 실제로
         움직이게 한다(그전에는 이 자리가 늘 'none' 이라 시각을 바꿔도 카드가 그대로였다).
      5. 없음('none').

    **구역 근거(서울 S3)** 는 좌석 방송 · 신선한 신뢰 로그 다음, 모델 예측 앞에 선다.
    ``zone_readings``(``zone_evidence.load_zone_readings`` 결과 — 경주는 언제나 빈 dict)에 이 시설이 있으면
    ``zone_evidence_dict`` 로 만든 근거(evidence_tier='zone_measured', ``zones`` 포함)를 돌려준다. ``wall_now`` 는
    그 신선도를 재는 실제 벽시계다. 빈 dict·None 이면 종전과 완전히 같다.
    ``region`` 이 공개 지역이 아니면 경주 학습 모델로 예측하지 않는다(업종 시간대 곡선은 지역 무관 휴리스틱이라 둔다).

    ``now`` 는 예측 기준 시각이다(가정 시각 또는 서버 현재 시각). resolve 의 모델 예측과 위 4번
    기준선에만 쓰고, 추정·실측의 '지금' 신선도 판정(attach_estimate)에는 넘기지 않는다 —
    그 판정은 실제 벽시계로 해야 한다(가정 시각으로 재면 방금 만든 추정이 만료로 잘못 걸린다).

    왜 함수로 뺐나: 같은 판정이 `/recommendations` 와 `/recommendations/by-type` 에 **두 벌로**
    복사돼 있었고, `/courses/plan` 에는 아예 없었다. 세 벌이 되면 반드시 갈라진다 — 실제로
    코스만 근거를 못 받아, 사장님이 좌석을 방송해도 코스 화면에서는 `measured_rules` 로
    들어가지 못했다(어제 고친 '정직한 방송이 손해' 가 그 화면에는 도달하지 못한 것이다).
    """
    override = facility.get(CONGESTION_OVERRIDE_KEY)
    if override is not None:
        # 사장님이 방금 확인한 좌석 상태 — 실측으로 취급(프런트 배지는 seat_status_fresh 가 담당).
        # is_current=True 를 **직접 찍는다**: merchant_boost 가 이미 같은 30분 창으로 걸렀는데,
        # 그 판정과 여기 사이에 흐른 몇 초로 경계를 넘겨 '방금 확인' 이 추정에 밀리면 안 된다.
        # (좌석 방송은 사장님이 '지금' 을 말한 것이다 — 이 경로가 우선순위 1번의 나머지 절반이다.)
        return {
            "level": override, "source": "measured", "log_source": "merchant_seat",
            "current_count": None, "evidence_tier": "verified", "is_stale": False,
            "timestamp": (facility.get("seat_status_fresh") or {}).get("updated_at"),
            "estimate": None, "is_current": True,
        }
    readings = (zone_readings or {}).get(str(facility.get("id"))) if zone_readings else None
    if readings and not (
        log_info is not None
        and measurement_is_current(log_info.get("evidence_tier"), log_info.get("timestamp"), now=wall_now)
    ):
        zone_evidence = zone_evidence_dict(readings, wall_now=wall_now)
        return {
            **zone_evidence,
            "estimate": None,
            "is_current": evidence_is_current(zone_evidence, now=wall_now),
        }
    # 혼잡 3단계 판정(CONGESTION_TRUST_SPEC) — 로그 없는 시설을 0.0(실측 여유)처럼 팔지 않는다.
    evidence = await resolve_congestion_evidence(
        facility, log_info, now=now, allow_model=region == PUBLIC_REGION
    )
    # 추정은 벽시계 기준으로 붙인다(가정 시각을 넘기지 않는다 — 위 docstring).
    evidence = attach_estimate(evidence, estimates, facility.get("id"))
    # 실측·모델·추정이 모두 없을 때만(= source 'none' 이고 추정도 못 붙은 자리) 업종 예측
    # 기준선을 '예측' 으로 얹는다. 관측을 지어내지 않으려는 선은 그대로다 — 라벨이 예측이고,
    # 순위에는 들어가지 않으며, 추정이 있으면 그 실데이터가 이 휴리스틱보다 앞선다.
    if evidence.get("source") == "none" and evidence.get("estimate") is None:
        baseline = get_predicted_baseline_congestion(facility.get("type"), now)
        if baseline is not None:
            evidence = {
                **evidence,
                "level": baseline,
                "source": "predicted",
                # 예측은 언제나 '지금' 을 말할 자격이 있다(congestion_evidence.evidence_is_current
                # 규약과 동일). 화면은 이 값을 '예측 · 지금' 으로 칠한다.
                "is_current": True,
                # 학습된 모델의 예측이 아니라 업종 시간대 곡선이다. 사유 문장은 이 값에 '%'·'AI' 를 붙이지
                # 않고(reason_service), 응답 congestion_prediction_basis 로 화면도 같은 구분을 받는다.
                "prediction_basis": "industry_baseline",
            }
    return evidence


def _reason_congestion_ctx(item: dict) -> dict:
    """사유 문장(reason_service)이 혼잡을 주장해도 되는지 — 카드 배지와 **같은 판정**을 쓴다.

    reason_service 의 템플릿은 source 가 'measured' 면 "혼잡도 92%" 를 사실처럼 적는다. 한 달 된
    관측에 그 문장을 붙이면, 같은 카드가 배지로는 '추정 · 여유' 를 말하면서 문장으로는 '혼잡도 92%'
    를 말하는 자기모순이 된다(2026-09-20 적대적 검토에서 잡힌 항목). '지금' 자격이 없는 값은
    혼잡을 주장하지 않는다 — 'none' 으로 넘기면 템플릿이 혼잡 문구 자체를 생략한다.

    관측을 숨기는 것이 아니다: 그 값은 응답 필드로 그대로 나가고 카드가 '마지막 관측 HH:MM' 으로
    보여 준다. 여기서 빼는 것은 **없는 시점을 주장하는 문장 한 줄**뿐이다.
    추정을 문장에 넣지 않는 이유도 같다 — 템플릿에는 '추정' 어휘가 없어서, 넣는 순간 추정이
    실측 문장으로 팔린다(추정은 배지 전용이다).
    """
    evidence = item["congestion_evidence"]
    if evidence.get("evidence_tier") == ZONE_EVIDENCE_TIER:
        return _zone_reason_ctx(item)
    if evidence.get("is_current"):
        return {
            "candidate_congestion": item["candidate_congestion"],
            "congestion_source": evidence["source"],
            # 업종 시간대 곡선이면 사유가 숫자 대신 시간대 말로 쓴다(reason_service._build_template).
            "congestion_prediction_basis": evidence.get("prediction_basis"),
            "facility_type": item["facility"].get("type"),
        }
    return {"candidate_congestion": None, "congestion_source": "none"}


def _zone_reason_ctx(item: dict) -> dict:
    """구역 근거 후보의 사유 컨텍스트 — 도착 시각 단계(없으면 '지금' 인 관측의 단계)로만 말한다.

    도착 시각도 지금도 말할 수 없는 관측(낡은 구역 관측)은 혼잡을 주장하지 않는다 — 카드가 'N분 전 관측' 으로
    보여 줄 뿐이다. '%' 는 쓰지 않는다(reason_service._build_zone_template).
    """
    evidence = item["congestion_evidence"]
    breakdown = item.get("breakdown") or {}
    band = breakdown.get("zone_arrival_level_band")
    basis = "arrival"
    if band is None and evidence.get("is_current"):
        # 엔진이 도착 단계를 내지 못했다 — '지금' 단계로만, 현재형으로 말한다('도착할 즈음' 을 주장하지 않는다).
        band = breakdown.get("zone_level_band")
        basis = "now"
    ctx = {"candidate_congestion": None, "congestion_source": "none"}
    if band is None:
        return ctx
    return {
        **ctx,
        "congestion_evidence_tier": ZONE_EVIDENCE_TIER,
        "zone_name": breakdown.get("zone_name"),
        "zone_band": band,
        "zone_band_basis": basis,
        "zone_usual_comparison": (
            breakdown.get("zone_usual_comparison") if evidence.get("is_current") else None
        ),
    }


def _zone_score_kwargs(
    region: str, wall_now: datetime, origin_zone_evidence: dict | None = None
) -> dict:
    """calculate_spot_score 에 넘길 지역 인자. 경주면 **빈 dict** — 경주 호출은 지역 도입 전과 같은 인자다."""
    if region == PUBLIC_REGION:
        return {}
    return {"region": region, "evidence_now": wall_now, "origin_zone_evidence": origin_zone_evidence}


async def _region_congestion_inputs(
    region: str, facility_ids: list[str], *, wall_now: datetime
) -> tuple[dict, dict | None, dict]:
    """(혼잡 로그 맵, 추정 묶음, 구역 관측) 을 한 번에 받는다.

    경주 — 종전과 같은 두 호출(혼잡 로그 · 추정)만 한다. 구역 관측은 ``{}``(경주에는 구역 근거가 없다).
    다른 지역 — 공개 혼잡 로그는 경주 전용(DB 트리거)이고 추정은 경주 주차·관광 통계라 읽지 않는다. 구역 관측만 읽는다.
    """
    if region == PUBLIC_REGION:
        congestion_by_id, estimates = await asyncio.gather(
            fetch_congestion_map(facility_ids),
            load_current_estimates(),
        )
        return congestion_by_id, estimates, {}
    zone_readings = await load_zone_readings(facility_ids, region=region, wall_now=wall_now)
    return {}, None, zone_readings


async def _resolve_user_vector(user_id: str, preferred_categories: list[str]) -> list[float]:
    """사용자 선호 벡터 1회 조회 — 없으면 Cold Start 벡터 생성 후 1회 업서트.

    (두 추천 엔드포인트가 공유하는 동일 패턴 — 후보마다 선호 벡터 저장소를 재조회하지 않는다.)
    """
    user_vector = await preference_vector_service.get_user_vector(user_id)
    if not user_vector:
        user_vector = get_category_average_vector(preferred_categories)
        await preference_vector_service.upsert_user_vector(user_id, user_vector)
    return user_vector


# /recommendations 가 돌려주는 카드 수. 영업 등급을 채우는 기준(select_eligibility_tiers 의 limit)도 이 수다.
_MAIN_RECOMMENDATION_LIMIT = 5


def _nearest_route_first(candidate: tuple) -> tuple[float, str]:
    """약한 등급에서 채울 때 채점까지 데려올 순서 — 도보 시간이 짧은 순(같으면 id 로 결정적)."""
    facility, route = candidate[0], candidate[1]
    return (float(route.duration_min), str(facility.get("id")))


def _eligibility_label(tier: int | None) -> str | None:
    return RECOMMENDATION_ELIGIBILITY_LABELS[tier] if tier is not None else None


def _eligibility_tier_counts(candidates: list[tuple]) -> dict[str, int]:
    """로그용 — 채점한 후보가 영업 근거 등급마다 몇 곳인지(채움이 얼마나 자주 일어나는지 보려고)."""
    counts: dict[str, int] = {}
    for candidate in candidates:
        label = RECOMMENDATION_ELIGIBILITY_LABELS[candidate[-1]]
        counts[label] = counts.get(label, 0) + 1
    return counts


# --- Endpoints ---

@router.post("/recommendations", response_model=list[RecommendItem])
async def get_recommendations(
    req: RecommendRequest,
    request: Request,
    current_user: dict = Depends(get_current_user)
):
    logger.info("recommendation_request_received", user_id=req.user_id, original_infra=req.original_facility_id)

    # 0. 소유권 가드 (IDOR 방지): 본문 user_id 는 토큰 주체와 일치해야 한다.
    #    타인의 user_id 로 선호벡터 조회/추천이력 INSERT 를 일으키는 신뢰 경계 위반을 차단.
    if req.user_id != current_user["id"]:
        raise HTTPException(status_code=403, detail="요청한 user_id가 인증된 사용자와 일치하지 않습니다.")

    # 0-1. 요청 지역 — 헤더는 요청일 뿐이고 서버가 DB 역할로 정한다(헤더 없으면 I/O 없이 경주).
    #      아래 원본 시설·후보 풀·근거·점수가 모두 이 값 하나를 명시 인자로 받는다.
    region = await resolve_request_region(request, current_user)

    # 1. 사용자 정보 및 원본 시설 정보 병렬 조회
    user_task = fetch_user(req.user_id)
    original_infra_task = fetch_facility(req.original_facility_id, region=region)
    max_walk_minutes = req.context.max_walk_minutes if req.context and req.context.max_walk_minutes else 10
    # 도보 추정을 계산하기 전 DB bbox는 넉넉히 잡고, 최종 제한은 보수적 경로 시간으로 강제한다.
    request_radius = max_walk_minutes * 100.0
    all_infra_task = fetch_all_facilities(
        center_lat=req.user_lat, center_lng=req.user_lng, radius_m=request_radius,
        region=region,
    )
    
    user_info, original_infra, all_facilities = await asyncio.gather(
        user_task, original_infra_task, all_infra_task
    )
    if region == PUBLIC_REGION:
        # Tmap 연관 목적지 prior 는 경주 이동 데이터다 — 다른 지역 후보에는 붙이지 않는다.
        await attach_related_destination_priors(original_infra, all_facilities)

    # 2. 시설 조건을 먼저 적용하고, 도보 경로 행렬로 영업 여부와 하드 캡을 판정한다.
    eligible = []
    for f in all_facilities:
        if f["id"] == req.original_facility_id or not facility_matches_context(f, req.context):
            continue
        if req.candidate_types and f.get("type") not in req.candidate_types:
            continue
        if req.discovery_theme:
            match = discovery_theme_match(f, req.discovery_theme)
            if match is None:
                continue
            # 요청 전용 메타데이터다. 공유 시설 캐시의 원본 dict를 오염시키지 않는다.
            f = {**f, "discovery_theme_match": match}
        eligible.append(f)

    # 활성 타임세일과 신선 좌석 상태를 점수 입력 전에 오버레이한다.
    #
    # 여기(후보 확정 직후, 도보 경로/스코어링 이전)여야 하는 이유: 오버레이는 score.py 가 읽는
    # 입력값(coupon_rate·'현재 혼잡')을 바꿔치기하는 방식이라, 점수 계산 뒤에 얹으면 랭킹에
    # 반영되지 않는다. _recommend_by_type 의 호출 지점·인자와 동일하게 맞춘다 —
    # 두 추천 경로가 같은 사장님 신호를 같은 순서로 소비해야 결과가 갈리지 않는다.
    # (원본 dict 를 건드리지 않는 얕은 복사본이 돌아오므로 공유 시설 캐시는 오염되지 않는다.)
    eligible = await apply_merchant_boosts(supabase_client, eligible)

    routes = await get_walking_routes(
        req.user_lat, req.user_lng,
        [(float(f["latitude"]), float(f["longitude"])) for f in eligible],
    )
    now = datetime.now(timezone.utc)
    tiered_candidates = []
    for facility, route in zip(eligible, routes):
        if route.duration_min > max_walk_minutes:
            continue
        tier = recommendation_eligibility_tier(
            facility,
            now + timedelta(minutes=route.duration_min),
            route.source,
        )
        if tier is not None:
            tiered_candidates.append((facility, route, tier))
    # 요청이 청하면(fill_weaker_tiers) 영업 확인 등급이 카드 수보다 적을 때 다음 등급(영업 미확인)에서 채운다 —
    # 정렬은 등급이 먼저라 확인된 곳이 언제나 앞이고, 채운 카드는 자기 등급을 단다. 청하지 않으면(구 번들)
    # 종전처럼 가장 강한 등급만이다(travel_context.select_eligibility_tiers).
    candidates = select_eligibility_tiers(
        tiered_candidates, _MAIN_RECOMMENDATION_LIMIT,
        fill_weaker=req.fill_weaker_tiers, fill_order=_nearest_route_first,
    )

    logger.info(
        "candidates_filtered",
        count=len(candidates),
        max_walk_minutes=max_walk_minutes,
        eligibility_tiers=_eligibility_tier_counts(candidates),
    )

    # 사용자 선호 벡터는 요청당 1개뿐이므로 여기서 1회만 조회한다. (없으면 Cold Start 벡터 생성 후 1회 업서트)
    user_vector = await _resolve_user_vector(req.user_id, user_info.get("preferred_categories", []))

    # 3. 각 후보군에 대해 SPOT 스코어를 병렬 연산
    #    후보별 최신 혼잡도는 일괄 조회(fetch_congestion_map) 후 맵 참조 — 후보 수만큼의
    #    개별 쿼리 팬아웃(N+1, 스레드풀 고갈 위험)을 제거한다.
    # 추정 묶음(5분 캐시)은 혼잡 로그 조회와 겹쳐 받는다 — 추천 지연을 더하지 않는다.
    # 다른 지역은 공개 혼잡 로그·추정 대신 구역 관측만 읽는다(_region_congestion_inputs). now 가 곧 벽시계다.
    congestion_by_id, estimates, zone_readings = await _region_congestion_inputs(
        region, [req.original_facility_id, *[f["id"] for f, _, _ in candidates]], wall_now=now
    )
    model_ready = get_model_info()["trained"]
    origin_zone_evidence = None
    if zone_readings.get(str(req.original_facility_id)):
        # 출발지도 구역 근거로 본다 — 재배치 기여의 기준선은 '같은 도착 시각의 출발지' 다(score.py).
        origin_zone_evidence = zone_evidence_dict(zone_readings[str(req.original_facility_id)], wall_now=now)
        original_evidence = {**origin_zone_evidence, "estimate": None}
        original_congestion = (
            origin_zone_evidence["level"] if evidence_is_current(origin_zone_evidence, now=now) else None
        )
    else:
        original_evidence = await resolve_congestion_evidence(
            original_infra, congestion_by_id.get(req.original_facility_id), now=now,
            allow_model=region == PUBLIC_REGION,
        )
        original_congestion = (
            rankable_measured_level(original_evidence)
            if original_evidence["source"] == "measured" else original_evidence.get("level")
        )
    # 원본 대기시간도 위 일괄 혼잡 조회 결과를 재사용한다.
    original_wait_time = None
    if model_ready and original_evidence["source"] == "predicted" and original_congestion is not None:
        original_wait_time = await calculate_predicted_wait_time(
            facility_type=original_infra["type"],
            congestion_level=original_congestion,
            facility_features=original_infra.get("features"),
        )

    async def _score_candidate(f: dict, route, eligibility_tier: int) -> dict:
        # 신선한 좌석 상태 방송(30분 이내)이 있으면 congestion_logs 조회값 대신 사장 확인 실측을 쓴다
        # (_recommend_by_type._score 와 동일 처리 — 두 경로가 같은 근거 dict 를 만든다).
        evidence = await build_candidate_evidence(
            f, congestion_by_id.get(f["id"]), estimates, now=now,
            region=region, zone_readings=zone_readings, wall_now=now,
        )
        candidate_congestion = evidence["level"]
        # 체감 혼잡도를 capacity×level 로 환산한 값은 실제 인원이 아니다. 계수형 소스가
        # 명시적으로 제공한 인원만 노출하고, 방문객·사장 정성 제보는 혼잡 단계만 보여준다.
        f = {**f, "current_count": evidence.get("current_count")}
        f.pop(CONGESTION_OVERRIDE_KEY, None)  # 내부 전용 오버레이 키 — 응답 payload 에는 노출하지 않는다.
        score_res = await calculate_spot_score(
            user_id=req.user_id,
            preferred_categories=user_info.get("preferred_categories", []),
            original_congestion_level=original_congestion,
            candidate_facility=f,
            user_lat=req.user_lat,
            user_lng=req.user_lng,
            user_vector=user_vector,
            congestion_evidence=evidence,
            preference_intent=req.preference_intent,
            travel_time_override=route.duration_min,
            travel_distance_override=route.distance_m,
            travel_source=route.source,
            **_zone_score_kwargs(region, now, origin_zone_evidence),
        )
        return {
            "facility": f,
            "spot_score": score_res.score,
            # original_wait_time 은 후보와 무관하게 요청당 1개지만, 추천 행 단독으로도
            # 절감분을 계산할 수 있도록 각 breakdown 에 함께 저장한다(비정규화 스냅샷).
            "breakdown": {
                **score_res.breakdown,
                "original_wait_time": original_wait_time,
                "discovery_theme_match": f.get("discovery_theme_match"),
            },
            "distance_m": route.distance_m,
            "candidate_congestion": candidate_congestion,
            "congestion_evidence": evidence,
            "eligibility_tier": eligibility_tier,
        }

    recommendation_results = list(
        await asyncio.gather(*[_score_candidate(f, route, tier) for f, route, tier in candidates])
    )

    # 같은 요청에서 실제로 비교 가능한 후보만 상대 수요 순위·중앙값 차이를 계산한다.
    # 모든 후보가 같은 권역 신호를 받으면 distinguishable=false가 되어 혼잡 대안이라고 주장하지 않는다.
    annotate_relative_demand(recommendation_results)

    # 4. 영업 근거 등급 → 혼잡 근거 등급 → 스코어 내림차순 정렬 및 상위 5개 선별.
    #    영업 등급이 맨 앞인 이유: 채운 미확인 후보가 점수로 확인된 곳을 앞지르면 안 된다.
    #    혼잡 근거 등급을 그다음에 보는 이유는 spot/ranking.py 주석 참조 — 모드마다 시간비용 공식이 달라서
    #    근거가 없는 후보가 구조적으로 최소 비용을 받는다. 같은 등급 안에서만 점수로 겨룬다.
    recommendation_results.sort(key=lambda x: (x["eligibility_tier"], *spot_ranking_sort_key(
        x["breakdown"].get("scoring_mode"), x["spot_score"], x["distance_m"], x["facility"]["id"],
        x["breakdown"].get("ranking_congestion"),
    )))
    # SPOT 점수순은 추천 계약 그 자체다. UI 다양성을 위해 후처리 재정렬하지 않는다.
    top_n = recommendation_results[:_MAIN_RECOMMENDATION_LIMIT]
    await _attach_delayed_area_actions(top_n, now=now, region=region)

    # 4-1. WP3: 상위 N개(=top_n)에만 백엔드 사유 생성 (동시 호출, 실패 시 템플릿 폴백)
    #      컨텍스트는 reason_service 가 소비하는 키만 전달한다: _build_template 는 이름·수치를,
    #      facility_id 는 LLM 문체 다듬기의 캐시 키(시설+혼잡도 버킷+시각)로 쓰인다.
    async def _reason_for(item: dict) -> tuple[str, str]:
        bd = item["breakdown"]
        return await generate_reason_with_source({
            "facility_id": item["facility"].get("id"),
            "recommended_facility_name": item["facility"].get("name"),
            **_reason_congestion_ctx(item),
            "travel_time": bd.get("travel_time"),
            "predicted_wait": bd.get("wait_time"),
        }, polish=False)

    reasons = await asyncio.gather(*[_reason_for(item) for item in top_n])

    # 5. DB(recommendations)에 추천 이력 저장 후 recommendation_id 획득 및 응답 매핑
    #    상위 N개 INSERT 도 병렬로 처리(직렬 await 제거).
    async def _persist(item: dict, rank: int):
        facility = item["facility"]
        evidence = item["congestion_evidence"]
        snapshot = {
            "facility_id": facility["id"],
            "facility_name": facility.get("name"),
            "facility_type": facility.get("type"),
            "spot_score": item["spot_score"],
            "rank": rank,
            "breakdown": item["breakdown"],
            "distance_m": item["distance_m"],
            "open_status_at_arrival": open_status_at_arrival(
                facility,
                datetime.now(timezone.utc) + timedelta(minutes=item["breakdown"].get("travel_time", 0)),
            ),
            # 카드마다 자기 등급 — 확인 등급이 모자라 채운 카드는 '영업 확인 필요' 등급으로 남는다.
            "eligibility_tier": _eligibility_label(item["eligibility_tier"]),
            "congestion": {
                "level": evidence["level"], "source": evidence["source"],
                "timestamp": evidence["timestamp"], "evidence_tier": evidence.get("evidence_tier"),
                "log_source": evidence.get("log_source"),
                # 사용자가 이 값을 '지금' 으로 봤는지. 이 칸을 읽는 집계는 source 만 세므로 영향이
                # 없고, 나중에 "낡은 실측이 몇 번 노출됐나" 를 되짚을 수 있게 스냅샷에 남긴다.
                "is_current": evidence.get("is_current"),
                # predicted 의 출처(model / industry_baseline) — 업종 곡선 노출을 모델 예측과 섞어 세지 않게.
                "prediction_basis": evidence.get("prediction_basis"),
            },
            # 사용자가 본 추정(있으면). 'congestion' 칸과 섞지 않는다 — 그 칸을 읽는 집계는
            # 계속 '근거 없음' 으로 센다. 학습은 congestion_logs 만 읽으므로 여기 닿지 않는다.
            "congestion_estimate": evidence.get("estimate"),
            "max_walk_minutes": max_walk_minutes,
            "travel_source": item["breakdown"].get("travel_source"),
            "availability_evidence": facility.get("availability_evidence"),
            "tourapi_facts": {
                "barrier_free": facility.get("barrier_free"),
                "operating_hours": facility.get("operating_hours"),
                "coupon_rate": facility.get("coupon_rate"),
            },
            "scoring_mode": item["breakdown"].get("scoring_mode"),
            "model_version": item["breakdown"].get("model_version"),
            "prediction_source": item["breakdown"].get("prediction_source"),
            "discovery_theme": req.discovery_theme,
            "reference_facility": (
                {"id": original_infra.get("id"), "name": original_infra.get("name")}
                if req.discovery_theme else None
            ),
            **_region_marker(region),
        }
        payload = {
                "user_id": req.user_id,
                "original_facility_id": req.original_facility_id,
                "recommended_facility_id": item["facility"]["id"],
                "spot_score": item["spot_score"],
                "score_breakdown": item["breakdown"],
                "recommendation_snapshot": snapshot,
                "accepted": False
            }
        try:
            return await asyncio.to_thread(
                supabase_client.table("recommendations").insert(payload).execute
            )
        except Exception as exc:
            # Migration rollout compatibility: preserve recommendation IDs until the new column is deployed.
            if "recommendation_snapshot" not in str(exc):
                raise
            if region != PUBLIC_REGION:
                # 구 payload 는 스냅샷째 지역 표시를 잃는다 — 표시 없는 내부 지역 행은 경주 집계·RLS 에 경주로 보인다.
                # 저장을 건너뛴다(이 항목은 mock-rec-id 로 강등). 경주는 종전 폴백 그대로다.
                raise
            legacy_payload = {k: v for k, v in payload.items() if k != "recommendation_snapshot"}
            return await asyncio.to_thread(
                supabase_client.table("recommendations").insert(legacy_payload).execute
            )

    # return_exceptions=True: INSERT 1건이 일시 DB 오류로 실패해도 정상 처리된 나머지 추천까지 버리지 않는다.
    # 실패 항목은 mock-rec-id 로 강등하되 '제거'하지 않는다 — top_n/reasons[idx] 인덱스 정렬을 유지해
    # 사유가 엉뚱한 시설에 붙는 것을 막는다.
    db_results = await asyncio.gather(
        *[_persist(item, idx + 1) for idx, item in enumerate(top_n)], return_exceptions=True
    )

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
        evidence = item["congestion_evidence"]
        response_items.append(RecommendItem(
            recommendation_id=rec_id,
            facility=public_facility_view(item["facility"]),
            spot_score=item["spot_score"],
            breakdown=item["breakdown"],
            distance_m=item["distance_m"],
            reason=reason_text,
            reason_source=reason_source,
            congestion_level=evidence["level"],
            congestion_source=evidence["source"],
            congestion_prediction_basis=evidence.get("prediction_basis"),
            congestion_log_source=evidence["log_source"],
            congestion_is_stale=evidence["is_stale"],
            congestion_timestamp=evidence["timestamp"],
            congestion_is_current=evidence.get("is_current"),
            congestion_estimate=congestion_estimate_model(evidence.get("estimate")),
            rank=idx + 1,
            total_candidates=total_count,
            open_status_at_arrival=open_status_at_arrival(
                item["facility"], datetime.now(timezone.utc) + timedelta(minutes=item["breakdown"].get("travel_time", 0))
            ),
            information_confidence=("verified" if item["eligibility_tier"] in {0, 1} else "unknown"),
            eligibility_tier=_eligibility_label(item["eligibility_tier"]),
            place_data_source=item["facility"].get("place_data_source"),
            data_updated_at=item["facility"].get("data_updated_at") or item["facility"].get("updated_at"),
            scoring_mode=item["breakdown"].get("scoring_mode", "degraded_rules"),
            model_version=item["breakdown"].get("model_version"),
            prediction_source=item["breakdown"].get("prediction_source", "unavailable"),
        ))

    logger.info("recommendations_generated", count=len(response_items))
    return response_items


# 추천 행 + 추천된 시설(요청 지역 것만). !inner 라 다른 지역 시설을 가리키는 추천 행은 **행째** 빠진다 —
# 읽은 뒤 dict 로 거르지 않고 쿼리 안에서 거른다(core/region 원칙). 지역 필터는 임베드 별칭의 region 칸에 건다.
_RECOMMENDATION_WITH_FACILITY = "*, recommended_facility:facilities!recommended_facility_id!inner(*)"
_RECOMMENDED_FACILITY_REGION = "recommended_facility.region"


def _select_recommendation_in_region(recommendation_id: str, region: str, *, limit: int | None = None):
    """동기 — 추천 행 1건을 요청 지역 시설 조인으로 읽는다(region 컬럼이 없는 DB 는 경주만 필터 없이)."""

    def _read(with_region: bool) -> list[dict]:
        query = (
            supabase_client.table("recommendations")
            .select(_RECOMMENDATION_WITH_FACILITY)
            .eq("id", recommendation_id)
        )
        if with_region:
            query = query.eq(_RECOMMENDED_FACILITY_REGION, region)
        if limit is not None:
            query = query.limit(limit)
        return query.execute().data or []

    return _read


# 설명(explain)의 공개 지역 읽기 — 시설은 **왼쪽** 임베드(region 칸만)다. 시설이 지워진(FK SET NULL) 경주 추천도
# 스냅샷으로 답한다(S3 전과 같다). 서울 행은 쿼리 안의 두 겹으로 빠진다: 스냅샷 지역 표시(``region``)가 있는 행,
# 그리고 시설 임베드가 지역 필터에 걸려 비는 행(시설 id 는 있는데 경주 시설이 아니다).
_RECOMMENDATION_WITH_FACILITY_REGION_LEFT = "*, recommended_facility:facilities!recommended_facility_id(region)"
_RECOMMENDATION_SNAPSHOT_REGION = f"recommendation_snapshot->>{RECOMMENDATION_REGION_KEY}"


def _select_public_recommendation_for_explain(recommendation_id: str):
    """동기 — 공개 지역(경주) 설명용 추천 행 1건. region 컬럼이 없는 DB 는 임베드 없이(모든 시설이 경주다)."""

    def _read(with_region: bool) -> list[dict]:
        query = (
            supabase_client.table("recommendations")
            .select(_RECOMMENDATION_WITH_FACILITY_REGION_LEFT if with_region else "*")
            .eq("id", recommendation_id)
            .is_(_RECOMMENDATION_SNAPSHOT_REGION, "null")
        )
        if with_region:
            query = query.eq(_RECOMMENDED_FACILITY_REGION, PUBLIC_REGION)
        rows = query.limit(1).execute().data or []
        if not with_region:
            return rows
        # 왼쪽 임베드라 지역 필터는 행을 빼지 않고 임베드만 비운다 — 시설 id 가 있는데 임베드가 비었으면 다른 지역 시설이다.
        return [
            row for row in rows
            if row.get("recommended_facility_id") is None or row.get("recommended_facility")
        ]

    return _read


async def _fetch_owned_recommendation(
    recommendation_id: str, user_id: str, region: str = PUBLIC_REGION
) -> dict:
    try:
        uuid.UUID(recommendation_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=404, detail="추천을 찾을 수 없습니다.") from None
    if region == PUBLIC_REGION:
        # 경주 — 시설이 지워진 추천도 스냅샷으로 답한다(S3 전 동작). 서울 행은 쿼리가 뺀다.
        read = _select_public_recommendation_for_explain(recommendation_id)
    else:
        # 내부 지역 — 그 지역 시설에 걸린 추천만(!inner). 시설이 지워진 내부 지역 추천은 설명하지 않는다.
        read = _select_recommendation_in_region(recommendation_id, region, limit=1)
    rows = await arun_region_scoped(read, region=region)
    if not rows:
        raise HTTPException(status_code=404, detail="추천을 찾을 수 없습니다.")
    row = rows[0]
    if row.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="본인의 추천만 설명할 수 있습니다.")
    return row


@router.post("/recommendations/{recommendation_id}/explain", response_model=ExplainResponse)
async def explain_recommendation(
    recommendation_id: str,
    req: ExplainRequest,
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    ids = [recommendation_id, *req.comparison_recommendation_ids]
    if len(set(ids)) != len(ids):
        raise HTTPException(status_code=422, detail="비교 추천 ID는 중복될 수 없습니다.")
    region = await resolve_request_region(request, current_user)
    rows = await asyncio.gather(*[
        _fetch_owned_recommendation(rec_id, current_user["id"], region) for rec_id in ids
    ])
    snapshots = []
    for row in rows:
        snapshot = row.get("recommendation_snapshot")
        if not isinstance(snapshot, dict):
            snapshot = {
                "facility_id": row.get("recommended_facility_id"),
                "facility_name": "추천 장소",
                "spot_score": row.get("spot_score"),
                "rank": 1,
                "breakdown": row.get("score_breakdown") or {},
                "tourapi_facts": {},
            }
        snapshots.append(snapshot)
    answer, labels, status = await explain_snapshot(req.question, snapshots, req.locale)
    logger.info(
        "recommendation_explained", recommendation_id=recommendation_id,
        question=req.question, comparison_count=len(req.comparison_recommendation_ids), llm_status=status,
    )
    return ExplainResponse(answer=answer, source_labels=labels, llm_status=status)


# --- 타입별 추천(메인 지도 브라우즈): 원본 없이 특정 종류를 선호/혼잡/거리로 랭킹 + 사유 ---
# 원본이 없는 브라우즈는 임의 원본 혼잡도를 만들지 않아 재배치 기여를 계산하지 않는다.
_BROWSE_BASELINE_CONGESTION = None
# 기본 20분 도보 밴드를 쓰며 후보가 부족해도 범위 밖 시설로 폴백하지 않는다.
_DEFAULT_BROWSE_WALK_MINUTES = 20
# Course planner compatibility; its own segment eligibility still consumes a distance cap.
_MAX_RECO_DISTANCE_M = _DEFAULT_BROWSE_WALK_MINUTES * 66.67


def _is_bar_facility(facility: dict) -> bool:
    features = facility.get("features") or {}
    raw = features.get("cuisine_tags") or features.get("cuisine") or []
    tags = raw if isinstance(raw, list) else [raw]
    bar_terms = ("술집", "호프", "포차", "오뎅바", "일본식주점", "칵테일바", "와인바")
    return any(any(term in str(tag) for term in bar_terms) for tag in tags)


class RecommendByTypeRequest(BaseModel):
    user_id: str
    facility_type: str
    user_lat: float
    user_lng: float
    exclude_ids: list[str] = []
    limit: int = Field(5, ge=1, le=20)  # 서버 상한: 후보 점수화(예측 + 사유 생성) 호출량 폭증 방지
    context: TravelContext | None = None
    preference_intent: str | None = Field(None, max_length=120)
    # 데모용 '가정 시각'(ISO 8601, UTC). 있으면 도착 영업여부·도착시점 혼잡·SPOT 채점의 기준
    # 시각이 이 값이 된다(parse_assumed_time). 없거나 형식 오류면 무시하고 서버 현재 시각을 쓴다
    # — 기본 동작 불변, 잘못된 입력에도 500 없이 조용히 무시.
    assumed_at: str | None = None
    # RecommendRequest.fill_weaker_tiers 와 같은 뜻 — 없거나 false 면 가장 강한 영업 등급만(구 번들 보호).
    fill_weaker_tiers: bool = False


# by-type 응답 캐시(180초). 판정·점수·라벨은 하나도 건드리지 않는다 — **같은 질문에 같은
# 답을 두 번 계산하지 않을 뿐**이다. 심사 동선은 /waiting 이 종류 4개를, /main 이 한 개를
# 같은 계정·같은 위치·같은 가정 시각 프리셋으로 반복 호출하는데, 그 한 번이 시설 전체 조회 +
# 영업근거 청크 + 타임세일 + 혼잡 RPC + 지역수요 RPC 수십 건이다(콜드 20초 실측).
# 0.5 CPU 인스턴스에서는 그게 겹치는 순간 헬스체크가 굶어 Render 가 프로세스를 재시작한다.
_by_type_cache = ResponseCache("recommend_by_type")


def _by_type_cache_key(req: "RecommendByTypeRequest", region: str = PUBLIC_REGION) -> tuple:
    """_recommend_by_type 의 출력을 바꿀 수 있는 입력을 **빠짐없이** 담은 키.

    아래 목록이 곧 "이 두 요청은 같은 질문인가" 의 정의다. 하나라도 빠지면 다른 질문에 남의
    답을 내주게 되므로, 요청 본문을 통째로 해싱하지 않고 필드를 하나씩 적는다(대신 답을
    바꾸지 않는 필드가 늘어도 적중률이 떨어지지 않는다).

      · user_id — 선호 벡터·preferred_categories·calculate_spot_score(user_id=…) 가 전부
        사용자별이다. 그래서 개인화 입력을 따로 키에 넣지 않는다: user_id 하나가 그 전부를
        덮는다(심사 세션은 한 계정을 계속 쓰므로 적중률도 그대로다).
      · facility_type / limit / exclude_ids — 후보 집합과 잘라내는 개수 그 자체.
        exclude_ids 는 집합으로만 쓰이므로(`f["id"] not in exclude`) 정렬해 접는다.
      · 반올림 좌표 — 아래 round_location 주석 참조(도보 경로·거리 점수의 출발점).
      · preference_intent — 채점 입력.
      · context — facility_matches_context(카테고리·실내·접근성·방문제외)와
        max_walk_minutes 를 통해 후보 자격과 반경을 모두 바꾼다.
      · 가정 시각 버킷 — 도착 영업여부·도착시점 혼잡·SPOT 채점의 기준 '지금'.
      · fill_weaker_tiers — 영업 미확인 등급으로 채울지(구 번들과 새 번들이 같은 키를 나누면 서로의 답을 받는다).
      · region — 요청 지역(서버가 역할로 정한 값). **공개 지역(경주)이면 넣지 않는다** — 경주 키는 지역 도입
        전과 같다. 같은 계정이라도 서울로 판정된 요청과 경주 요청은 다른 키다(풀이 다르다).
    """
    key = (
        req.user_id,
        req.facility_type,
        *round_location(req.user_lat, req.user_lng),
        int(req.limit),
        req.preference_intent or None,
        tuple(sorted(set(req.exclude_ids or ()))),
        model_signature(req.context),
        assumed_time_bucket(parse_assumed_time(req.assumed_at)),
        bool(req.fill_weaker_tiers),
    )
    return key if region == PUBLIC_REGION else (*key, ("region", region))


@router.post("/recommendations/by-type", response_model=list[RecommendItem])
async def recommend_by_type(
    req: RecommendByTypeRequest,
    request: Request,
    current_user: dict = Depends(get_current_user)
):
    logger.info("recommend_by_type_request", user_id=req.user_id, facility_type=req.facility_type)

    # 소유권 가드(IDOR 방지): 본문 user_id 는 토큰 주체와 일치해야 한다.
    if req.user_id != current_user["id"]:
        raise HTTPException(status_code=403, detail="요청한 user_id가 인증된 사용자와 일치하지 않습니다.")

    # 요청 지역은 **캐시보다 먼저** 정한다 — 캐시 키와 파이프라인이 같은 값을 명시 인자로 받는다.
    region = await resolve_request_region(request, current_user)

    # /courses/recommend 와 같은 이유로 감싼다(2026-08-28). 여기도 예외 처리가 없어
    # 업스트림이 흔들리면 그대로 500 이 나갔다 — 동시 호출 시 실측으로 확인했다.
    # 프런트는 이미 503 을 ServiceUnavailableError 로 따로 잡아 로컬 폴백으로 내려간다.
    try:
        # 캐시는 예외 처리 **안쪽**이다 — 미스가 그대로 파이프라인 호출이라 실패 경로(503 강등·
        # record_failure)가 종전과 똑같이 돈다. 실패는 캐시에 남지 않는다.
        return await _by_type_cache.get_or_compute(
            _by_type_cache_key(req, region), lambda: _recommend_by_type(req, region)
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "recommend_by_type_failed",
            user_id=req.user_id,
            facility_type=req.facility_type,
            error=str(exc),
            error_type=type(exc).__name__,
            exc_info=True,
        )
        record_failure("recommend_by_type", exc, facility_type=req.facility_type)
        raise HTTPException(
            status_code=503,
            detail="추천을 준비하는 중 일시적인 문제가 생겼어요. 잠시 후 다시 시도해 주세요.",
        ) from exc


async def _recommend_by_type(req: "RecommendByTypeRequest", region: str = PUBLIC_REGION) -> list:
    """by-type 추천 본체. 예외 처리는 호출부(recommend_by_type)가 맡는다."""
    max_walk_minutes = req.context.max_walk_minutes if req.context and req.context.max_walk_minutes else _DEFAULT_BROWSE_WALK_MINUTES
    user_info, all_facilities = await asyncio.gather(
        fetch_user(req.user_id),
        fetch_all_facilities(
            center_lat=req.user_lat, center_lng=req.user_lng, radius_m=max_walk_minutes * 100.0,
            region=region,
        ),
    )

    exclude = set(req.exclude_ids or [])
    candidates = [
        f for f in all_facilities
        if f.get("type") == req.facility_type
        and not (req.facility_type == "restaurant" and _is_bar_facility(f))
        and f["id"] not in exclude
        and facility_matches_context(f, req.context)
    ]
    if not candidates:
        return []

    # 활성 타임세일과 신선 좌석 상태를 점수 입력 전에 오버레이한다.
    candidates = await apply_merchant_boosts(supabase_client, candidates)

    # 후보별 키 없는 보수적 도보 추정을 한 번만 계산한다.
    routes = await get_walking_routes(
        req.user_lat, req.user_lng,
        [(float(f["latitude"]), float(f["longitude"])) for f in candidates],
    )
    # 데모 '가정 시각'이 있으면 그 시각을 기준으로 삼는다 — 도착 영업여부(eligibility tier·
    # open_status_at_arrival)와 아래 SPOT 채점의 도착시점 혼잡이 모두 이 now 를 따라간다.
    # 없으면(assumed_now=None) 종전과 완전히 동일하게 동작한다: now 는 서버 현재 시각이고,
    # 아래 채점에는 depart_time 을 넘기지 않아(None) score 가 자기 datetime.now 를 쓴다.
    assumed_now = parse_assumed_time(req.assumed_at)
    now = assumed_now or datetime.now(timezone.utc)
    tiered_candidate_routes = []
    for facility, route in zip(candidates, routes):
        if route.duration_min > max_walk_minutes:
            continue
        tier = recommendation_eligibility_tier(
            facility,
            now + timedelta(minutes=route.duration_min),
            route.source,
        )
        if tier is not None:
            tiered_candidate_routes.append((facility, route, tier))
    # /recommendations 와 같은 규칙 — 요청이 청하고 확인 등급이 limit 보다 적을 때만 다음 등급에서 채운다.
    candidate_routes = select_eligibility_tiers(
        tiered_candidate_routes, req.limit,
        fill_weaker=req.fill_weaker_tiers, fill_order=_nearest_route_first,
    )
    candidates = [facility for facility, _, _ in candidate_routes]
    route_by_id = {facility["id"]: route for facility, route, _ in candidate_routes}
    tier_by_id = {facility["id"]: tier for facility, _, tier in candidate_routes}
    if not candidates:
        return []

    # 선호 벡터 1회 조회(없으면 Cold Start 생성 후 업서트) — get_recommendations 와 동일 패턴
    user_vector = await _resolve_user_vector(req.user_id, user_info.get("preferred_categories", []))

    # 후보별 최신 혼잡도 일괄 조회(N+1 제거) — get_recommendations 와 동일 패턴.
    # 구역 관측의 신선도는 **실제 벽시계**로 잰다(now 는 가정 시각일 수 있다 — 채점의 기준 시각과 분리).
    wall_now = datetime.now(timezone.utc)
    congestion_by_id, estimates, zone_readings = await _region_congestion_inputs(
        region, [f["id"] for f in candidates], wall_now=wall_now
    )

    async def _score(f: dict) -> dict:
        evidence = await build_candidate_evidence(
            f, congestion_by_id.get(f["id"]), estimates, now=now,
            region=region, zone_readings=zone_readings, wall_now=wall_now,
        )
        cong = evidence["level"]
        route = route_by_id[f["id"]]
        # 정성 혼잡 단계를 인원수로 합성하지 않는다. 실제 계수 소스의 값만 전달한다.
        f2 = {**f, "current_count": evidence.get("current_count")}
        f2.pop(CONGESTION_OVERRIDE_KEY, None)  # 내부 전용 오버레이 키 — 응답 payload 에는 노출하지 않는다.
        res = await calculate_spot_score(
            user_id=req.user_id,
            preferred_categories=user_info.get("preferred_categories", []),
            original_congestion_level=_BROWSE_BASELINE_CONGESTION,
            candidate_facility=f2,
            user_lat=req.user_lat,
            user_lng=req.user_lng,
            user_vector=user_vector,
            congestion_evidence=evidence,
            preference_intent=req.preference_intent,
            # 가정 시각이 있으면 채점 기준 출발 시각으로도 넘긴다 → score 내부 도착예측 hour/dow 가
            # 위 eligibility·open_status 판정과 같은 시각을 본다. 가정이 없으면 None 을 넘겨 score 가
            # 종전처럼 자기 datetime.now 를 쓰게 둔다(기본 동작 완전 불변).
            depart_time=assumed_now,
            travel_time_override=route.duration_min,
            travel_distance_override=route.distance_m,
            travel_source=route.source,
            **_zone_score_kwargs(region, wall_now),
        )
        return {
            "facility": f2,
            "spot_score": res.score,
            "breakdown": res.breakdown,
            "distance_m": route.distance_m,
            "candidate_congestion": cong,
            "congestion_evidence": evidence,
            "eligibility_tier": tier_by_id[f["id"]],
        }

    scored = list(await asyncio.gather(*[_score(f) for f in candidates]))
    annotate_relative_demand(scored)
    # get_recommendations 와 **같은 정렬 키**를 쓴다(영업 등급 → 혼잡 근거 등급 → 점수). 한쪽만 등급
    # 정렬이면 같은 시설이 목록 화면과 종류별 화면에서 다른 자리에 놓인다.
    scored.sort(key=lambda x: (x["eligibility_tier"], *spot_ranking_sort_key(
        x["breakdown"].get("scoring_mode"), x["spot_score"], x["distance_m"], x["facility"]["id"],
        x["breakdown"].get("ranking_congestion"),
    )))
    top = scored[: max(1, req.limit)]
    await _attach_delayed_area_actions(top, now=now, region=region)

    # 컨텍스트는 reason_service 가 소비하는 키만 전달한다: _build_template 는 이름·수치를,
    # facility_id 는 LLM 문체 다듬기의 캐시 키(시설+혼잡도 버킷+시각)로 쓰인다.
    async def _reason_for(item: dict) -> tuple[str, str]:
        bd = item["breakdown"]
        return await generate_reason_with_source({
            "facility_id": item["facility"].get("id"),
            "recommended_facility_name": item["facility"].get("name"),
            **_reason_congestion_ctx(item),   # /recommendations 와 같은 판정(중복 정의 금지)
            "travel_time": bd.get("travel_time"),
            "predicted_wait": bd.get("wait_time"),
        }, polish=False)

    reasons = await asyncio.gather(*[_reason_for(item) for item in top])

    total = len(scored)
    # 실제 노출된 by-type 추천도 방문 결과와 조인 가능해야 한다. 각 노출을 recommendations에
    # 저장하고 UUID를 반환한다. 저장 실패 항목만 추적 불가능한 명시적 mock id로 강등한다.
    async def _persist_by_type(item: dict, rank: int):
        facility = item["facility"]
        evidence = item["congestion_evidence"]
        snapshot = {
            "facility_id": facility["id"], "facility_name": facility.get("name"),
            "facility_type": facility.get("type"), "spot_score": item["spot_score"],
            "rank": rank, "breakdown": item["breakdown"], "distance_m": item["distance_m"],
            "congestion": {
                "level": evidence["level"], "source": evidence["source"], "timestamp": evidence["timestamp"],
                "evidence_tier": evidence.get("evidence_tier"), "log_source": evidence.get("log_source"),
                "is_current": evidence.get("is_current"),  # 위 /recommendations 스냅샷과 같은 뜻.
                "prediction_basis": evidence.get("prediction_basis"),
            },
            "congestion_estimate": evidence.get("estimate"),
            "max_walk_minutes": max_walk_minutes,
            "travel_source": item["breakdown"].get("travel_source"),
            "availability_evidence": facility.get("availability_evidence"),
            "open_status_at_arrival": open_status_at_arrival(
                facility, now + timedelta(minutes=item["breakdown"].get("travel_time", 0))
            ),
            "eligibility_tier": _eligibility_label(item["eligibility_tier"]),
            "tourapi_facts": {
                "barrier_free": facility.get("barrier_free"),
                "operating_hours": facility.get("operating_hours"),
                "coupon_rate": facility.get("coupon_rate"),
            },
            "scoring_mode": item["breakdown"].get("scoring_mode"),
            "model_version": item["breakdown"].get("model_version"),
            "prediction_source": item["breakdown"].get("prediction_source"),
            **_region_marker(region),
        }
        return await asyncio.to_thread(
            supabase_client.table("recommendations").insert({
                "user_id": req.user_id,
                "original_facility_id": facility["id"],
                "recommended_facility_id": facility["id"],
                "spot_score": item["spot_score"],
                "score_breakdown": item["breakdown"],
                "recommendation_snapshot": snapshot,
                "accepted": False,
                "source": "spot",
            }).execute
        )

    persisted = await asyncio.gather(
        *[_persist_by_type(item, idx + 1) for idx, item in enumerate(top)], return_exceptions=True
    )
    return [
        RecommendItem(
            recommendation_id=(
                result.data[0]["id"]
                if not isinstance(result, Exception) and result.data else "mock-rec-id"
            ),
            facility=public_facility_view(item["facility"]),
            spot_score=item["spot_score"],
            breakdown=item["breakdown"],
            distance_m=item["distance_m"],
            reason=reasons[idx][0],
            reason_source=reasons[idx][1],
            congestion_level=item["congestion_evidence"]["level"],
            congestion_source=item["congestion_evidence"]["source"],
            congestion_prediction_basis=item["congestion_evidence"].get("prediction_basis"),
            congestion_log_source=item["congestion_evidence"]["log_source"],
            congestion_is_stale=item["congestion_evidence"]["is_stale"],
            congestion_timestamp=item["congestion_evidence"]["timestamp"],
            congestion_is_current=item["congestion_evidence"].get("is_current"),
            congestion_estimate=congestion_estimate_model(item["congestion_evidence"].get("estimate")),
            rank=idx + 1,
            total_candidates=total,
            open_status_at_arrival=open_status_at_arrival(
                item["facility"], now + timedelta(minutes=item["breakdown"].get("travel_time", 0))
            ),
            information_confidence=("verified" if item["eligibility_tier"] in {0, 1} else "unknown"),
            eligibility_tier=_eligibility_label(item["eligibility_tier"]),
            place_data_source=item["facility"].get("place_data_source"),
            data_updated_at=item["facility"].get("data_updated_at") or item["facility"].get("updated_at"),
            scoring_mode=item["breakdown"].get("scoring_mode", "degraded_rules"),
            model_version=item["breakdown"].get("model_version"),
            prediction_source=item["breakdown"].get("prediction_source", "unavailable"),
        )
        for idx, (item, result) in enumerate(zip(top, persisted))
    ]


class RecommendationOutcomeRequest(BaseModel):
    stage: Literal["navigation_started", "arrival_confirmed", "rated"]
    rating: Literal["up", "down"] | None = None
    observed_congestion: Literal["quiet", "normal", "busy"] | None = None

    @model_validator(mode="after")
    def validate_stage_fields(self):
        if self.stage == "rated" and self.rating is None:
            raise ValueError("rated 단계에는 rating이 필요합니다.")
        if self.stage != "rated" and (self.rating is not None or self.observed_congestion is not None):
            raise ValueError("평가와 체감 혼잡도는 rated 단계에서만 보낼 수 있습니다.")
        return self


# --- 음성 비서 1턴 해석: 발화→의도 + 후보 선호매칭 선택 + 한국어 응답 ---
# 무인증 — 로그인 사용자 데이터에 접근하지 않는다(요청 본문의 발화·후보만 읽는다).
#
# ⚠️ '로컬 전용'이 아니다. 이 경로는 조건부로 외부 LLM(Upstage Solar)을 호출한다:
#   1) 로컬 키워드 분류기가 먼저 판정한다(voice_intent_service._keyword_interpret). accept·next·
#      stop·details·select·command 로 분류되면 외부 호출 0 — 네트워크가 발생하지 않는다.
#   2) 그 결과가 filter(음식·조건 선호)이거나 unknown 이고, 후보가 1개 이상이며,
#      UPSTAGE_API_KEY 가 설정돼 있고, IP 레이트리밋(_voice_llm_allowed)을 통과할 때만
#      외부 LLM 제공자(settings.LLM_BASE_URL — 기본 api.upstage.ai)로 요청이 나간다.
#   3) 그때 나가는 데이터: 발화 원문(300자 절단), 현재 추천 이름, 상위 15개 후보의 이름·종류·
#      대표메뉴, app_context. **가게 이름이 외부로 나간다.**
#   4) 키 미설정·게이트 차단·호출 실패면 외부 전송 없이 키워드 결과로 폴백한다(무해 폴백).
# 응답의 llm_status 가 그 턴의 실제 경로다(keyword/gated/disabled=외부 호출 없음, llm·llm_failed=호출함).
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
    # 정밀분류(features.category, tag_cuisines.py 배치가 채움) — 아래 분류 게이트(cat_of)의 입력.
    # 이 필드가 스키마에 없으면 pydantic 이 프런트가 보낸 category 를 버려 게이트가 무력화된다(2026-07-18).
    category: str | None = None
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

    @field_validator("category", mode="before")
    @classmethod
    def _cap_category(cls, v):
        # _INTENT_CATEGORIES 라벨은 전부 40자 미만 — 초과분은 조작/오류 값이라 절단(_cap_menu 패턴).
        return str(v)[:40] if isinstance(v, str) and v.strip() else None

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


class VoiceAppContext(BaseModel):
    route: Literal["main"] = "main"
    facility_type: Literal["restaurant", "cafe", "attraction", "culture"] = "restaurant"
    indoor_required: bool = False
    max_walk_minutes: Literal[5, 10, 20] | None = None


class VoiceTurnRequest(BaseModel):
    # 무인증 엔드포인트 — 입력 크기 제한(과대 페이로드/프롬프트 비대화 방지). 출력은 _coerce 가 enum·후보 id 로 강제.
    utterance: str = Field("", max_length=500)
    facility_type: str = "restaurant"
    current_name: str | None = Field(None, max_length=120)
    candidates: list[VoiceCandidate] = Field(default_factory=list, max_length=30)
    app_context: VoiceAppContext | None = None


class VoiceAppCommand(BaseModel):
    name: Literal[
        "set_facility_type", "set_indoor_mode", "set_max_walk_minutes", "open_waiting_board"
    ]
    args: dict = Field(default_factory=dict)


# 무인증 유료(LLM) 호출 비용 소진 공격 방어(Codex 감사 P1-3) — search.py 의 슬라이딩 윈도우
# 패턴 미러(단일 인스턴스 데모 전제, 다중 인스턴스는 공유 저장소로 승격 필요).
# 키워드로 해석되는 정상 명령은 산입하지 않는다 — interpret_turn 이 LLM 사용 직전에만 게이트를 호출.
# 초과 시 429 대신 LLM 만 건너뛰고 unknown(재질문)으로 강등 — 데모에서 음성 UI 가 죽지 않게.
_VOICE_LLM_WINDOW_SEC = 60.0
_VOICE_LLM_RATE_LIMIT = 5  # IP당 분당 LLM 보조 해석 상한
_voice_llm_hits: dict[str, list[float]] = {}


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
    action: str  # accept|next|reject|details|select|filter|command|stop|unknown
    target_facility_id: str | None = None  # select 일 때 후보 id
    match_ids: list[str] = []  # filter 일 때 선호에 맞는 후보 id들(예: '양식' → 양식 식당들)
    spoken: str | None = None  # 백엔드 생성 한국어 응답(없으면 프런트가 자체 멘트)
    # filter 매치 0건일 때의 '유사 대안 제안'(같은 계열 음식) 후보 id — spoken 이 "…로 안내해드릴까요?"로
    # 물었고, 다음 턴 accept 를 프런트 훅이 이 후보 select 로 처리한다(2턴 흐름). 하위호환: 기본 None.
    suggestion_id: str | None = None
    # 개발 디버그용 — "AI 가 실제로 돌았는지" 프런트 배지 표시. interpret_turn 이 판정한 값을 그대로 싣는다.
    llm_status: str  # keyword|llm|llm_failed|gated|disabled
    command: VoiceAppCommand | None = None


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
    ip = client_ip(request)
    result = await interpret_turn(
        req.utterance, type_ko, req.current_name, candidates,
        llm_gate=lambda: _voice_llm_allowed(ip),
        app_context=req.app_context.model_dump() if req.app_context else None,
    )
    # 2) 후보 재필터: '선호 필터'로 분류되면 어떤 후보가 맞는지는 이름·종류 태그 부분문자열 매칭이 결정(embedding_service — 임베딩 아님).
    #    백엔드 가 확장한 search_query("고깃집"→"삼겹살 갈비 숯불구이…")로 검색해 곱창집·순댓국과 섞이지 않게 한다.
    if result["action"] == "filter":
        query = result.get("search_query") or req.utterance
        try:
            # 백엔드 가 정한 정밀분류(intent_category)를 함께 넘겨, 시드 category 일치 후보를 소프트 부스트(국밥→국밥집).
            vids = await vector_filter_candidates(query, candidates, intent_category=result.get("intent_category"))
        except Exception:
            vids = []
        llm_ids = result.get("match_ids") or []
        if result.get("llm_status") == "llm":
            # Solar가 후보 메뉴·업종을 보고 직접 고른 결과가 정본. 로컬 매처와의 교집합을 우선하고
            # (양쪽 합의 = 최고 신뢰), 교집합이 비면 Solar 단독 선택을 쓴다. Solar가 "맞는 곳 없음"
            # (빈 배열)이라 판단했으면 그대로 0건 → 아래 정직한 '후보 없음' 응답으로 흐른다.
            # (Solar는 상위 15개 후보만 보므로(_LLM_MAX_CANDIDATES) 로컬 매처 단독 결과로 폴백하지 않는다
            #  — 그 폴백이 바로 '삼겹살'→'불고기 피자' 피자집 오탐 사고 경로였다.)
            match = [m for m in vids if m in set(llm_ids)] or llm_ids
        else:
            match = vids or llm_ids  # LLM 미개입/실패 — 기존처럼 벡터 우선, 백엔드 match_ids 폴백
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
            no_match_msg = f"근처에 확인된 {ic} 후보가 없어요" if ic else "조건에 맞는 후보가 없어요"
            # 유사 대안 제안(2턴): Solar 가 같은 계열 후보(similar_ids)를 골랐으면 첫 후보의 이름으로
            # "대신 …로 안내해드릴까요?" 를 묻는다. spoken 은 서버 템플릿 전용 — name 은 검증된
            # 후보 dict(요청 스키마 절단 완료)의 값, ic 는 _INTENT_CATEGORIES 화이트리스트 통과값이라 안전.
            suggestion_id = None
            for sid in (result.get("similar_ids") or []):
                s_name = next((c.get("name") for c in candidates if c.get("id") == sid), None)
                if s_name:
                    suggestion_id = sid
                    # TTS 로 읽히는 문장 — '이(가)' 병기 대신 마지막 글자 받침으로 조사를 확정한다.
                    last = s_name[-1]
                    josa = "이" if 0 <= (ord(last) - 0xAC00) < 11172 and (ord(last) - 0xAC00) % 28 else "가"
                    result["spoken"] = (
                        f"{no_match_msg}. 대신 비슷한 곳으로 {s_name}{josa} 있어요. 안내해드릴까요?"
                    )
                    break
            result["suggestion_id"] = suggestion_id
            if suggestion_id is None and ic:
                result["spoken"] = f"{no_match_msg}. 다른 메뉴를 말씀해 주세요."
    # search_query 는 내부용(응답 스키마에 없음) — 제거 후 응답 구성.
    return VoiceTurnResponse(
        action=result["action"],
        target_facility_id=result.get("target_facility_id"),
        match_ids=result.get("match_ids") or [],
        spoken=result.get("spoken"),
        suggestion_id=result.get("suggestion_id"),
        llm_status=result.get("llm_status", "disabled"),
        command=result.get("command"),
    )


# --- 추천 수락(원클릭) — 메인 카드의 '바로 갈래요' ---
# 카드가 받은 추천 행 id(recommendation_id)를 함께 보내면 **그 행**을 수락으로 표시한다 — /feedback 의
# accepted_visit_intent 와 같은 효과(결정 행 1개 · 취향 벡터 +10% 1회 · 쿠폰)이고 새 행을 만들지 않는다.
# 예전에는 늘 원본=추천=그 시설인 새 행을 넣어, 같은 노출이 두 번 기록되고 '재배치' 가 부풀었으며 취향도
# 배우지 않았다. id 가 없으면(구 번들 · 추천 이력 없이 핀으로 고른 곳) 종전처럼 수락 행을 새로 넣는다.
class AcceptRequest(BaseModel):
    facility_id: str = Field(..., description="수락(방문 확정)할 시설 id")
    recommendation_id: str | None = Field(
        None, max_length=64, description="카드가 받은 추천 행 id(있으면 그 행을 수락으로 표시)"
    )


class RejectRequest(BaseModel):
    facility_id: str = Field(..., description="메인 탐색에서 거절한 시설 id")


@router.post("/recommendations/reject")
async def reject_recommendation(
    req: RejectRequest,
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    """메인 브라우즈 거절을 실험실 pending 결정으로 비차단 적재할 수 있게 한다."""
    user_id = current_user["id"]
    region = await resolve_request_region(request, current_user)
    # 클라이언트 점수·혼잡값 없이 서버의 시설 존재만 검증한다(요청 지역의 시설만 — 다른 지역은 404).
    await fetch_facility(req.facility_id, region=region)

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
                **_region_marker_snapshot(region),
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


def _linkable_recommendation_id(raw: str | None) -> str | None:
    """수락을 이을 추천 행 id. UUID 가 아니면(저장 실패분 'mock-rec-id' 등 — DB 행이 없다) None.

    None 이면 종전 경로(수락 행 새로 넣기)로 간다. 404 로 막으면 그 카드의 쿠폰까지 막힌다 — 행이 없는 것은
    사용자 잘못이 아니라 노출 저장이 실패한 것이다.
    """
    if not raw:
        return None
    try:
        uuid.UUID(str(raw))
    except (ValueError, TypeError, AttributeError):
        logger.info("accept_recommendation_id_unlinkable", recommendation_id=str(raw)[:64])
        return None
    return str(raw)


@router.post("/recommendations/accept")
async def accept_recommendation(
    req: AcceptRequest,
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    """특정 시설 방문을 수락 확정하고 제휴 시설이면 쿠폰을 발급한다.

    흐름: 인증 → 시설 존재 검증(404) →
      · recommendation_id 있음: 소유 확인(404·403 — /feedback 과 같은 가드) → 시설 일치 확인(409) →
        그 추천 행에 수락 결정 기록 + accepted=true(best-effort) → 쿠폰 → 취향 벡터 +10%(행당 1회)
      · 없음: recommendations 수락 행 새로 기록(best-effort, 종전과 같다) → 쿠폰
    응답: {"success": True, "coupon_issued": bool, "coupon_rate": float, "expires_at": str|None,
           "recommendation_id": str|None(수락으로 표시한 추천 행), "updated_vector": bool(이번에 취향을 배웠나)}
    """
    user_id = current_user["id"]
    region = await resolve_request_region(request, current_user)

    # 1. 시설 존재 검증(없으면 404 — fetch_facility 가 던진다). coupon_rate 포함 시설 dict 확보.
    #    요청 지역의 시설만 — 다른 지역 시설 id 는 없는 시설과 같은 404 다.
    facility = await fetch_facility(req.facility_id, region=region)

    recommendation_id = _linkable_recommendation_id(req.recommendation_id)
    if recommendation_id is not None:
        return await _accept_shown_recommendation(recommendation_id, facility, current_user, region)

    # 2. (구 번들·추천 이력 없음) 수락 이력 기록 — 종전과 같다.
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
                **_region_marker_snapshot(region),
            }).execute
        )
    except Exception as e:
        logger.warning("accept_persist_failed", user_id=user_id, facility_id=req.facility_id, error=str(e))

    # 3. 제휴 시설이면 쿠폰 발급(피드백 경로와 동일 규칙 — 멱등 upsert·만료 7일).
    result = await issue_coupon_if_partner(supabase_client, user_id, facility, region=region)
    logger.info("recommendation_accepted", user_id=user_id, facility_id=req.facility_id, coupon_issued=result["coupon_issued"])
    # 이 경로는 취향을 배우지 않는다(이을 추천 행이 없다) — 화면이 '취향에 반영' 을 말할지 이 값으로 고른다.
    return {"success": True, **result, "recommendation_id": None, "updated_vector": False}


async def _accept_shown_recommendation(
    recommendation_id: str, facility: dict, current_user: dict, region: str = PUBLIC_REGION
) -> dict:
    """노출된 추천 행을 수락으로 표시한다 — /feedback accepted_visit_intent 와 같은 효과, 새 행 없음.

    /feedback 을 함께 불러도 두 번 세지 않는다: 결정 행은 추천당 1개(record_decision 멱등)이고 취향 학습
    슬롯도 행당 1회이며, accepted=true·쿠폰 upsert 도 다시 해도 같은 결과다.
    """
    user_id = current_user["id"]
    # 소유권 가드(비-UUID·없는 행 404, 남의 행 403) — /feedback · /outcome 과 같은 함수.
    recommendation, _joined_facility = await resolve_feedback_target(
        recommendation_id, current_user, region=region
    )
    if str(recommendation.get("recommended_facility_id")) != str(facility["id"]):
        # 다른 장소의 추천 행을 수락으로 바꾸면 분산 지표가 없던 이동을 센다 — 고치지 않고 거절한다.
        raise HTTPException(status_code=409, detail="추천 기록의 장소와 수락한 장소가 다릅니다.")

    # 결정 기록이 실패해도 쿠폰(사용자 가치)은 막지 않는다 — 종전 수락 경로와 같은 best-effort.
    decision = None
    try:
        decision = await feedback_service.record_decision(
            supabase_client,
            user_id=user_id,
            recommendation_id=recommendation_id,
            action=feedback_service.ACTION_ACCEPTED_VISIT_INTENT,
        )
        await asyncio.to_thread(
            supabase_client.table("recommendations")
            .update({"accepted": True})
            .eq("id", recommendation_id)
            .execute
        )
    except Exception as e:
        logger.warning(
            "accept_decision_persist_failed",
            user_id=user_id, recommendation_id=recommendation_id, error=str(e),
        )

    result = await issue_coupon_if_partner(supabase_client, user_id, facility, region=region)

    # 취향 벡터 — 서비스가 학습 슬롯을 선점해 준 경우에만(행당 생애 1회, /feedback 과 같은 규칙).
    updated_vector = False
    if decision is not None and decision["should_learn_vector"]:
        try:
            updated_vector = await apply_feedback_vector_learning(
                user_id=user_id, facility=facility, vector_action=VECTOR_ACTION_REINFORCE
            )
        except Exception as e:
            # 슬롯은 이미 선점됐다 — 재시도로 두 번 배우는 것보다 이번 학습을 잃는 편을 택한다(feedback_service 참조).
            logger.warning(
                "accept_vector_learning_failed",
                user_id=user_id, recommendation_id=recommendation_id, error=str(e),
            )

    logger.info(
        "recommendation_accepted",
        user_id=user_id,
        facility_id=facility["id"],
        recommendation_id=recommendation_id,
        coupon_issued=result["coupon_issued"],
        decision_created=decision["created"] if decision is not None else None,
        updated_vector=updated_vector,
    )
    return {
        "success": True,
        **result,
        "recommendation_id": recommendation_id,
        "updated_vector": updated_vector,
    }


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
    if facility_type not in CATEGORY_VECTORS:
        # 미지 카테고리는 제로 벡터 학습(정규화 시 균등벡터로 대체 → 무의미한 보정)이 되므로
        # 조용히 반영하지 않고 경고 후 스킵한다. 피드백 이력 저장 자체는 이미 완료된 뒤다.
        logger.warning("feedback_vector_skip_unknown_type", facility_type=facility_type, user_id=user_id)
        return False
    features = dict(facility.get("features") or {})
    if facility.get("barrier_free") is not None:
        features.setdefault("barrier_free", facility.get("barrier_free"))
    facility_vector = build_facility_preference_vector(facility_type, features)
    await preference_vector_service.adjust_user_vector_on_feedback(
        user_id=user_id,
        facility_vector=facility_vector,
        action=vector_action,
    )
    return True


async def resolve_feedback_target(
    recommendation_id: str, current_user: dict, *, region: str = PUBLIC_REGION
) -> tuple[dict, dict]:
    """피드백/실험실 경로의 공통 진입 가드 — 추천 이력 조회 + 소유권 검사.

    ``region`` — 추천된 시설이 이 지역 것인 추천 행만 찾는다(쿼리 안의 !inner 조인 필터). 다른 지역 시설의
    추천 행은 없는 추천과 같은 404 다(기본값 공개 지역 = 경주, fail-closed).

    Returns:
        (recommendation, facility)

    Raises:
        HTTPException: 404(비-UUID·미존재 추천) / 403(타인 소유).
    """
    # recommendation_id 형식 방어 — uuid 컬럼에 비-UUID 문자열을 넘기면 캐스팅 오류로 500 이 나므로
    # 그 전에 깔끔한 404 로 응답한다. 여기로 오는 비-UUID 는 저장 실패분의 "mock-rec-id"(아래 참조)와
    # 구버전 프런트가 보관 중인 옛 합성 id 다.
    #
    # by-type 브라우즈는 더 이상 합성 id 를 만들지 않는다: _recommend_by_type 이 노출된 추천을 전부
    # recommendations 에 INSERT 하고 **실제 UUID** 를 돌려준다(INSERT 실패 항목만 "mock-rec-id" 로 강등).
    # 따라서 브라우즈 랭킹에서 온 추천도 이 가드를 통과해 /feedback 으로 들어오고,
    # accepted_visit_intent 면 제휴 시설 쿠폰이 실제로 발급된다(submit_feedback 4단계).
    try:
        uuid.UUID(str(recommendation_id))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=404, detail="해당 추천 기록을 찾을 수 없습니다.")

    rows = await arun_region_scoped(
        _select_recommendation_in_region(recommendation_id, region), region=region
    )
    if not rows:
        raise HTTPException(status_code=404, detail="해당 추천 기록을 찾을 수 없습니다.")

    recommendation = rows[0]
    # 소유권 가드: 타인의 추천 기록에 피드백을 넣어 그 사람의 선호 벡터를 오염시키는 것을 차단.
    if recommendation["user_id"] != current_user["id"]:
        raise HTTPException(status_code=403, detail="해당 추천 기록에 대한 권한이 없습니다.")

    facility = recommendation.get("recommended_facility")
    if isinstance(facility, list):
        facility = facility[0] if facility else None
    if not facility:
        # facilities 를 조인하지 못했을 시 단독으로 시설 추가 조회(같은 지역 필터)
        facility = await fetch_facility(recommendation["recommended_facility_id"], region=region)
    return recommendation, facility


# 방문 확인 체감 혼잡 답의 처리 결과(응답 crowd_answer). 앞의 셋은 DB recommendation_outcomes.observed_answer_mode 와 같다.
#   registered   계정 사용자 — 예전처럼 congestion_logs(user_report)로 옮겨져 지도·교차검증에 들어간다. 언제나 기록한다.
#   guest_shadow 게스트 — 저장만(그림자 모드). 지도·추천·corroborated 에 들어가지 않는다(20261031130000 트리거).
#   guest_live   게스트 — GUEST_CROWD_ANSWERS_LIVE 로 실시간 반영(교차검증은 네트워크·실측 조건이 붙는다).
#   not_recorded_shared_network     (게스트) 같은 IP·같은 장소에서 30분 안에 다른 계정이 이미 답·제보했다.
#   not_recorded_cooldown           (게스트) 같은 게스트가 같은 장소에 30분 안에 이미 답했다(추천을 돌려 표를 쌓지 못하게).
#   not_recorded_pending_migration  (게스트) DB 에 20261031130000 이 아직 없다 — 그림자로 분류할 수 없어 답을 버린다(닫힌 쪽 실패).
#   not_recorded_* 이면 평가(좋았어요/별로였어요)만 저장하고 답은 버린다. 409/429 로 거절하지 않는다 — 웹 방문 결과 큐가 멈추지 않게.
_CROWD_ANSWER_SHARED_NETWORK = "not_recorded_shared_network"
_CROWD_ANSWER_COOLDOWN = "not_recorded_cooldown"
_CROWD_ANSWER_PENDING_MIGRATION = "not_recorded_pending_migration"
#   not_recorded_region             내부 지역(서울) 추천 — 그 지역은 혼잡 제보가 꺼져 있어 답을 버린다(계정 사용자 포함).
_CROWD_ANSWER_REGION = "not_recorded_region"
# 같은 게스트·같은 장소의 답은 교차검증 창(30분)에 한 번. 실시간을 켜면 한 게스트가 추천을 돌려 단건 관측을 쌓는 것을 막는다.
_GUEST_ANSWER_COOLDOWN_SEC = CORROBORATION_WINDOW_SEC
# 응답에서 빼는 열 — 네트워크 키는 측정·교차검증용이라 클라이언트에 돌려줄 이유가 없다.
_OUTCOME_PRIVATE_FIELDS = ("observed_network_hash",)


def _is_missing_rpc_signature(message: str) -> bool:
    """PostgREST 가 새 인자를 가진 RPC 를 못 찾았는가(마이그레이션 20261031130000 미적용 또는 스키마 캐시 미갱신)."""
    return "PGRST202" in message or "Could not find the function" in message


async def _call_outcome_rpc(params: dict, extra: dict, *, is_guest: bool) -> tuple[object, bool]:
    """방문 결과 RPC 호출 → (결과, 구 DB 였는가).

    새 인자(network_hash·guest_answer_live)를 모르는 구 DB 면 옛 인자로 한 번 더 부른다. 그 DB 에는 게스트 판정·그림자
    분류가 없어 게스트 답이 그대로 실시간 user_report 가 된다 — 그래서 **게스트면 답을 빼고**(평가만) 부른다(닫힌 쪽 실패).
    계정 사용자는 예전 그대로 답까지 기록한다.
    """
    try:
        result = await asyncio.to_thread(
            supabase_client.rpc("record_recommendation_outcome", {**params, **extra}).execute
        )
        return result, False
    except Exception as exc:
        if not _is_missing_rpc_signature(str(exc)):
            raise
    logger.warning("recommendation_outcome_rpc_legacy_signature", hint="apply migration 20261031130000")
    legacy = {**params, "p_observed_congestion": None} if is_guest else params
    result = await asyncio.to_thread(supabase_client.rpc("record_recommendation_outcome", legacy).execute)
    return result, True


def _reserve_guest_answer(user_id: str, ip: str, facility_id: str) -> tuple[tuple | None, str | None]:
    """게스트 답의 1인 1표 · 쿨다운을 검사하고 자리를 잡는다 → (되돌리기 토큰, 버린 이유).

    계정 사용자의 실시간 표(CONGESTION_VOTES_BY_IP)는 읽기만 한다 — 게스트 답이 계정 사용자의 제보를 막지 않게.
    """
    if shared_ip_retry_after(CONGESTION_VOTES_BY_IP, user_id=user_id, ip=ip, facility_id=facility_id) is not None:
        return None, _CROWD_ANSWER_SHARED_NETWORK
    try:
        token = reserve_report_slot(
            ip_store=GUEST_ANSWER_VOTES_BY_IP,
            user_store=GUEST_ANSWER_LAST_BY_USER,
            user_id=user_id,
            ip=ip,
            facility_id=facility_id,
            cooldown_sec=_GUEST_ANSWER_COOLDOWN_SEC,
            cooldown_detail=_CROWD_ANSWER_COOLDOWN,
        )
    except HTTPException as blocked:
        reason = _CROWD_ANSWER_COOLDOWN if blocked.detail == _CROWD_ANSWER_COOLDOWN else _CROWD_ANSWER_SHARED_NETWORK
        return None, reason
    return token, None


@router.patch("/recommendations/{recommendation_id}/outcome")
async def record_recommendation_outcome(
    recommendation_id: str,
    req: RecommendationOutcomeRequest,
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    """추천 소유자의 방문 단계를 서버 시각으로 전진시킨다(DB RPC가 멱등·원자성 보장).

    체감 혼잡(observed_congestion)은 게스트도 답할 수 있다. 게스트 답은 기본으로 그림자 모드다 — 저장만 하고
    실시간 혼잡 판정에는 넣지 않는다(DB 가 auth.users.is_anonymous 로 판정, GUEST_CROWD_ANSWERS_LIVE 로 켠다).
    계정 사용자의 답은 예전 그대로 언제나 기록한다(IP 규칙을 걸지도, 자리를 잡지도 않는다).
    게스트 답에만 1인 1표가 걸린다: 같은 IP·같은 장소는 30분에 한 계정(계정 사용자의 실시간 표는 읽기만 하고 자리는 게스트
    전용 표에 잡는다), 같은 게스트·같은 장소는 30분에 한 번. 막히면 평가만 저장하고 crowd_answer 로 이유를 알린다.
    """
    region = await resolve_request_region(request, current_user)
    recommendation, _facility = await resolve_feedback_target(recommendation_id, current_user, region=region)
    observed = req.observed_congestion
    # 게스트 판정은 검증된 JWT 의 is_anonymous 다. 방금 계정을 연결해(linkIdentity·이메일 전환) JWT 는 아직 익명인데 DB 는
    # 계정 사용자인 짧은 순간이 있다(L1). 그때 이 요청은 게스트 규칙(IP·쿨다운 제한, 네트워크 키 계산)을 한 번 더 받을 뿐이고,
    # DB 분류 트리거가 registered 로 정하고 네트워크 키를 지운다 — 더 엄격한 쪽으로만 어긋나므로 따로 다루지 않는다.
    is_guest = bool((current_user.get("payload") or {}).get("is_anonymous"))
    dropped: str | None = None
    network_hash: str | None = None
    slot = None
    if observed is not None and region != PUBLIC_REGION:
        # 내부 지역(서울)은 혼잡 제보가 꺼져 있다(사용자 결정 2) — 체감 혼잡은 저장하지 않는다(평가·단계만 저장).
        # 저장하면 경주 관제의 답 지표(guest_crowd_answer_shadow_metrics)에 서울 답이 섞인다. 경주는 그대로다.
        observed = None
        dropped = _CROWD_ANSWER_REGION
        logger.info("outcome_crowd_answer_not_recorded", recommendation_id=recommendation_id, reason=dropped)
    if observed is not None and is_guest:
        ip = client_ip(request)
        facility_id = str(recommendation.get("recommended_facility_id") or "")
        if facility_id:
            slot, dropped = _reserve_guest_answer(current_user["id"], ip, facility_id)
        if dropped is not None:
            observed = None
            logger.info("outcome_guest_answer_not_recorded", recommendation_id=recommendation_id, reason=dropped)
        else:
            # 게스트 답에만 대역 해시를 남긴다(원본 IP 는 저장하지 않는다). 계정 사용자 답은 DB 트리거도 지운다.
            network_hash = network_key_hash(ip)

    params = {
        "p_recommendation_id": recommendation_id,
        "p_user_id": current_user["id"],
        "p_stage": req.stage,
        "p_rating": req.rating,
        "p_observed_congestion": observed,
    }
    extra = {
        "p_network_hash": network_hash,
        "p_guest_answer_live": bool(settings.GUEST_CROWD_ANSWERS_LIVE) and observed is not None,
    }
    try:
        result, legacy_db = await _call_outcome_rpc(params, extra, is_guest=is_guest)
    except Exception as exc:
        if slot is not None:
            release_report_slot(slot)
        message = str(exc)
        if "must be recorded first" in message or "cannot be changed" in message:
            raise HTTPException(status_code=409, detail="방문 결과 단계 순서가 올바르지 않습니다.")
        if "facility_region_not_public" in message:
            # DB 의 지역 격리 트리거(P0001) — 공개 지역이 아닌 시설은 공개 혼잡 표에 쓰지 않는다. 없는 시설과 같은 404.
            raise HTTPException(status_code=404, detail="해당 추천 기록을 찾을 수 없습니다.")
        logger.error("recommendation_outcome_failed", recommendation_id=recommendation_id, error=message)
        raise HTTPException(status_code=500, detail="방문 결과 저장에 실패했습니다.")
    if legacy_db and is_guest and observed is not None:
        # 구 DB 에서는 게스트 답을 빼고 저장했다 — 잡은 자리를 돌려주고 '기록 안 됨' 으로 알린다.
        if slot is not None:
            release_report_slot(slot)
        observed = None
        dropped = _CROWD_ANSWER_PENDING_MIGRATION

    row = result.data
    if isinstance(row, list):
        row = row[0] if row else None
    crowd_answer: str | None = dropped
    if isinstance(row, dict):
        # 이미 받은 답이 DB 에 있으면(큐 재전송 등) 그 분류가 답이다 — 이번 요청에서 버린 이유보다 우선한다.
        if row.get("observed_congestion") and row.get("observed_answer_mode"):
            crowd_answer = row["observed_answer_mode"]
        row = {k: v for k, v in row.items() if k not in _OUTCOME_PRIVATE_FIELDS}
    if observed is not None and crowd_answer != "guest_shadow" and region == PUBLIC_REGION:
        # (다른 지역 시설의 답은 DB 가 공개 congestion_logs 로 옮기지 않는다 — 스냅샷을 흔들 이유가 없다.)
        # 체감 혼잡은 DB 트리거(project_outcome_congestion_log)가 congestion_logs 에 단건 관측으로
        # 옮긴다 — 지도에 보이는 쓰기다. 게스트 그림자 답은 옮기지 않으므로 스냅샷을 흔들지 않는다.
        reference_snapshot.mark_dirty("congestion")
    return {"success": True, "outcome": row, "crowd_answer": crowd_answer}


@router.post("/feedback")
async def submit_feedback(
    req: FeedbackRequest,
    request: Request,
    current_user: dict = Depends(get_current_user)
):
    logger.info("feedback_received", recommendation_id=req.recommendation_id, action=req.action)

    # 1. 추천 이력 조회 + 소유권 가드(비-UUID·미존재 id 는 404, 타인 소유는 403).
    #    by-type 브라우즈 노출도 recommendations 에 저장돼 실제 UUID 로 들어온다 — 이 경로를 통과한다.
    region = await resolve_request_region(request, current_user)
    _recommendation, facility = await resolve_feedback_target(
        req.recommendation_id, current_user, region=region
    )
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
        await issue_coupon_if_partner(supabase_client, user_id, facility, region=region)

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
