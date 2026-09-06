# pyrefly: ignore [missing-import]
"""분산 코스(멀티스톱 동선) 추천 라우터.

단일 대안(POST /recommendations)이 '지금 혼잡한 원본의 즉시 대체'를 주는 것과 달리,
여기서는 2~3개 정류지로 이어지는 '동선(코스)'을 짜서 시간에 걸쳐 혼잡을 회피한다.

핵심 아이디어(시간 분산):
  · 1번 정류지 = 사용자 위치에서 가깝고 '지금 도착하면' 여유로운 곳.
  · 2번 정류지 = 1번에서 체류를 마치고 '이동해 도착하는 시각'에 여유로울 것으로 예측되는 곳.
  · 3번 정류지 = 다시 그 뒤 도착 시각 기준으로 여유로울 곳.
  도착 시각 = 직전 도착 + 체류(COURSE_DWELL_MIN) + 이동(get_walking_routes) 누적.
  각 정류지의 도착시점 예측 혼잡은 predict_service.predict_congestion(도착 hour/dow)로 산출한다.

설계 원칙:
  · SPOT 스코어(선호·시간비용·인센티브)는 calculate_spot_score 로 재사용한다(단일 소스).
  · 반환하는 predicted_congestion 은 '누적 도착 시각' 기준의 정직한 모델 예측치다.
  · 결정적(deterministic): 동점은 (거리 오름차순, id) 로 깬다. 데이터가 없으면(모델/로그 부재)
    조용히 저하되어 빈 코스([])나 짧은 코스를 반환할 뿐, 값을 지어내지 않는다.
"""
import asyncio
import hashlib
from datetime import datetime, timedelta, timezone

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.failure_log import record_failure
from app.core.supabase import get_current_user, supabase_admin
from app.services.availability_service import (
    attach_availability_evidence,
    fetch_effective_availability_map,
)
from app.services.preference_vector_service import preference_vector_service
from app.services.spot.score import calculate_spot_score
from app.services.spot.travel import (
    WalkingRoute,
    calculate_haversine_distance,
    get_walking_routes,
)
from app.services.travel_context import (
    TravelContext,
    facility_matches_context,
    is_recommendable_at_arrival,
    open_status_at_arrival,
)
from app.services.spot.preference import get_category_average_vector
from app.services.predict_service import predict_congestion
from app.services.merchant_boost import apply_merchant_boosts, CONGESTION_OVERRIDE_KEY
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

# 그리디 탐색 비용 상한 — **한 자리에서 실제로 채점하는 후보 수**다.
# (보행 경로는 슬롯당 1회 배치라 후보 수에 비례하지 않지만, 예측·SPOT 스코어·지역수요 조회는
#  여전히 후보마다 한 번씩이고 지역수요 조회에는 캐시가 없다 — 채점 수를 늘리는 것은 지금도 비싸다.)
MAX_COURSE_CANDIDATES = 12

# 후보 **풀**은 채점 수보다 넓게 잡는다. 둘을 나눈 이유가 이 기능의 전부다.
#
# 풀이 곧 채점 대상이던 시절, 풀은 '사용자 위치 기준 가까운 순' 으로 잘려 있었다. 그래서
# 2번 자리를 고를 때 이미 1번 정류지로 옮겨간 출발점 근처의 가게가 **애초에 후보에 없었다.**
# 순서를 바꿔도 늘 같은 답이 나온 게 우연이 아니라 구조였다: 순서 모드의 풀은 종류별 합집합이라
# 순열에 불변이고, 선택은 정렬 기반이라 리스트 순서와 무관하다.
# (같은 종류 안에서 SPOT 의 실질 변별자는 사실상 이동시간뿐이다 — predict_congestion 은 시설
#  id 를 받지 않아 같은 종류·같은 도착 시각대면 예측이 동일하고, 선호 벡터도 종류 기저에
#  features 를 조금 얹은 값이라 거의 같다. 그래서 '종류별 1등' ≈ '그 종류 중 가장 가까운 곳'.)
#
# 풀을 넓히고 자리마다 '지금 서 있는 자리' 기준으로 다시 추리면, 채점 횟수는 그대로인 채
# 2번 이후의 후보만 실제로 달라진다. 넓힌 만큼 비싸지는 것은 후보 평가가 아니라 풀 단위
# 일괄 조회(혼잡·영업근거·타임세일)뿐인데, 그건 id 를 묶어 한 번에 나가므로 사실상 그대로다.
_AUTO_POOL_CANDIDATES = 36

class CourseRequest(BaseModel):
    user_id: str
    user_lat: float
    user_lng: float
    types: list[str] | None = None  # 코스에 포함할 시설 종류 화이트리스트(없으면 전체 종류 대상)
    # 정류지별 '순서 지정' 종류(예: ["cafe","attraction","restaurant"] → 1번째 카페, 2번째 관광지, 3번째 식당).
    # 주어지면 types 화이트리스트와 종류 다양성 로직을 대체한다(무효 종류는 걸러지고 MAX_STOPS 까지만 사용).
    sequence: list[str] | None = None
    # 자리 고정. 사용자가 마음에 든 곳을 붙박아 두고 나머지만 다시 짜게 한다.
    # 고정이 하나 생기면 그 뒤 자리의 출발점과 누적 도착 시각이 실제로 달라지므로, 드래그가
    # 처음으로 '다른 가게' 를 데려온다. 채점 수는 오히려 줄어든다(고정된 자리는 후보가 1개다).
    pins: list["CoursePin"] | None = None
    context: TravelContext | None = None


# sequence 검증용 캐노니컬 시설 종류(DB CHECK 와 동일 집합).
_VALID_COURSE_TYPES = {"restaurant", "cafe", "attraction", "culture"}
# sequence 모드에서 종류별로 풀에 담을 인근 후보 상한 — 가까운 순 전체 상한과 달리
# 종류별 보장이 목적이다(가까운 곳에 카페가 0개여도 카페 자리가 성립하게).
# 채점 수가 아니라 **풀 크기**다(위 _AUTO_POOL_CANDIDATES 주석 참조).
_SEQ_CANDIDATES_PER_TYPE = 18
# 순서 지정 모드에서 한 자리를 채우려고 실제로 채점하는 후보 수. 종전 풀 크기와 같은 값이라
# 이 변경으로 채점 횟수가 늘지 않는다.
_SEQ_SLOT_EVAL_LIMIT = 6

# 한 자리에 함께 실어 보낼 차점 후보 수. 채점은 어차피 끝나 있으므로 추가 연산이 없다.
MAX_ALTERNATIVES_PER_STOP = 3


class CourseStop(BaseModel):
    order: int                    # 방문 순서(1부터)
    facility: dict
    arrival_offset_min: float     # 지금(요청 시각) 기준 이 정류지 도착까지 걸리는 누적 분
    predicted_congestion: float | None   # degraded_rules에서는 혼잡 수치 미제공
    spot_score: float
    reason: str
    open_status_at_arrival: str | None = None
    travel_minutes: float | None = None  # 직전 위치→정류지 구간 도보시간(누적 arrival_offset 과 구분)
    # 같은 자리의 차점 후보들. 구 번들은 모르는 필드라 무시한다(추가만 하고 봉투는 안 바꾼다).
    alternatives: list["CourseAlternative"] = []


class CoursePin(BaseModel):
    """이 자리는 이 가게로 고정한다.

    `order` 는 1부터다(응답 CourseStop.order 와 같은 축). `dict[int, str]` 로 받지 않은 이유:
    JSON 객체의 키는 언제나 문자열이라 "1" 과 1 을 오가는 변환이 클라이언트마다 달라진다.
    리스트는 그 애매함이 없고, 같은 자리에 핀이 두 번 오는 것도 여기서 걸러 낼 수 있다.
    """

    order: int = Field(ge=1, le=MAX_STOPS)
    facility_id: str


class CourseAlternative(BaseModel):
    """같은 자리의 차점 후보.

    ⚠️ 이 수치들은 **그 슬롯의 실제 출발점과 실제 누적 도착 시각**에서 계산된 값이다.
    1등을 뽑느라 어차피 전부 채점해 둔 것을 버리지 않고 실어 보내는 것뿐이라 추가 연산이 0 이다
    (예전에는 `evaluations[0]` 만 꺼내고 나머지를 지역 변수와 함께 소멸시켰다).

    나중에 "대안은 대충 계산해도 되겠지" 라고 생각하지 말 것 — 그 순간 화면의 숫자가 거짓이 된다.
    사용자가 대안으로 갈아끼우면 그 자리의 도착 시각·예상 혼잡은 여기 적힌 값 그대로여야 한다.
    """

    facility: dict
    arrival_offset_min: float
    predicted_congestion: float | None
    spot_score: float
    travel_minutes: float | None = None


# 슬롯 결과 코드. 프런트가 개수 차이로 이유를 **추측하지 않게** 하는 것이 존재 이유다.
SLOT_FILLED = "filled"
SLOT_NO_CANDIDATE = "no_candidate_of_type"      # 그 종류 후보가 풀에 남아 있지 않다
SLOT_CLOSED_AT_ARRIVAL = "closed_at_arrival"    # 도착 시각 영업 자격에서 전원 탈락
SLOT_OVER_TIME_BUDGET = "over_time_budget"      # available_minutes 예산을 넘긴다
SLOT_PIN_UNAVAILABLE = "pin_unavailable"        # 고정한 가게를 이 자리에 넣을 수 없다


class SlotOutcome(BaseModel):
    """요청한 자리 하나가 어떻게 됐는지.

    왜 필요한가: 코스는 **조용히 짧아진다.** 3곳을 짰는데 2곳만 돌아와도 응답의 order 는
    1..n 으로 다시 매겨져서, 어느 자리가 왜 빠졌는지 응답에서 복원할 방법이 없었다.
    화면은 개수 차이만 보고 이유를 추측할 수밖에 없었는데, 추측한 이유를 사용자에게 말하는
    것은 값을 지어내는 것과 같다(이 라우터가 다른 곳에서는 하지 않는 일이다).
    그래서 서버가 아는 사실만 그대로 내려보낸다.
    """

    order: int                          # 사용자가 짠 자리 번호(1부터). 응답 stops 의 order 와 다를 수 있다.
    requested_type: str | None = None   # 순서 지정 모드에서 그 자리에 요청한 종류(자동 모드면 None)
    status: str
    facility_id: str | None = None      # status == filled 일 때 실제로 채운 가게
    pinned: bool = False


class CoursePlan(BaseModel):
    """코스 한 벌 + 그 코스가 어떻게 만들어졌는지.

    `/courses/recommend` 는 **배열**을 그대로 유지하고(구 번들 호환), 이 봉투는 `/courses/plan`
    으로만 나간다. 최상위를 배열에서 객체로 바꾸면, Vercel(정적 export)과 Render 의 배포 시점이
    다른 탓에 새 API 가 먼저 뜨는 창에서 구 번들의 `Array.isArray(data) ? data : []` 가 false 로
    떨어져 **장애가 '갈 곳 없음'으로 보인다.** 그건 이 라우터가 가장 피하려는 종류의 거짓말이다.
    """

    stops: list[CourseStop]
    slot_outcomes: list[SlotOutcome]
    # 선택된 시설 id 열의 결정적 해시. 프런트가 '결과가 실제로 바뀌었는지'를 추측이 아니라
    # 사실로 판정하게 한다 — 이게 없으면 화면은 재조회 때마다 "새 추천이 왔어요" 라고 말하고
    # 싶은 유혹을 받고, 같은 답이 돌아온 순간 그 말이 거짓이 된다.
    plan_id: str


def _plan_id(stops: list[CourseStop]) -> str:
    raw = "|".join(f"{s.order}:{s.facility.get('id')}" for s in stops)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


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
    predicted_congestion: float | None,
    current_congestion: float,
) -> str:
    """정직·결정적 한국어 사유. LLM 미사용(코스는 재현 가능해야 함)."""
    name = facility.get("name", "이곳")
    if predicted_congestion is None:
        return f"{order}번째 {facility['name']}: 약 {round(arrival_offset_min)}분 후 도착합니다. 취향·실제 이동시간·혜택 기준 추천입니다."
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
    route: WalkingRoute,
    cur_lat: float,
    cur_lng: float,
    cum_offset_min: float,
    now: datetime,
    congestion_now: dict[str, dict],
    user_vector: list[float] | None,
    preferred_categories: list[str],
    user_id: str,
) -> dict:
    """현재 위치/누적 시각에서 후보 하나를 평가한다.

    - route: 호출부가 슬롯 단위로 **한 번에** 구한 현재 위치→후보 보행 경로(분/m/근거).
      여기서 다시 길찾기를 하지 않는 이유는 호출부 주석 참조(같은 출발점에서 Dijkstra 반복).
    - 도착 시각 = now + 누적오프셋 + 이동시간 → 그 시각(hour/dow)의 예측 혼잡.
    - SPOT 스코어는 calculate_spot_score 로 재사용(선호·시간비용·인센티브). 인센티브의 '재배치기여'
      기준선(original_congestion_level)은 후보의 '현재' 혼잡으로 둬서, 지금보다 도착 시점이
      한산해지는(시간 분산) 후보를 보상한다.
    """
    travel_min, dist = route.duration_min, route.distance_m
    arrival_offset = cum_offset_min + travel_min
    arrival_dt = now + timedelta(minutes=arrival_offset)
    # predict_congestion 은 동기(로컬 sklearn) — 이벤트 루프 비블로킹 위해 워커 스레드로 오프로드.
    predicted_congestion = await asyncio.to_thread(
        predict_congestion, facility["type"], arrival_dt.hour, arrival_dt.weekday()
    )
    # 신선한 좌석 상태 방송(30분 이내)이 있으면 congestion_logs 조회값 대신 사장 확인 실측을 '현재
    # 혼잡'(재배치기여의 기준선)으로 쓴다. facility 자체는 여러 라운드에 걸쳐 재평가될 수 있어(선택
    # 안 된 후보는 remaining 에 남는다) 이 오버레이 키를 여기서 지우지 않는다 — 아래 scored_facility
    # 복사본에서만 벗겨 응답 payload 에 내부 키가 노출되지 않게 한다.
    # fetch_congestion_map 은 이제 로그 info dict 를 반환한다(CONGESTION_TRUST_SPEC). 여기의
    # 0.0 폴백은 W3 재배치기여의 **점수 입력** — Phase 1 은 점수 입력을 바꾸지 않는다(D-2, Phase 2 재검토).
    current_congestion = facility.get(
        CONGESTION_OVERRIDE_KEY, (congestion_now.get(facility["id"]) or {}).get("level", 0.0)
    )

    # 도착 시점 예상 인원 추정치를 응답 facility 에 주입(원본 리스트 불변 — 얕은 복사).
    scored_facility = {
        **facility,
        "current_count": (
            round(facility.get("capacity", 0) * predicted_congestion)
            if predicted_congestion is not None else None
        ),
    }
    scored_facility.pop(CONGESTION_OVERRIDE_KEY, None)
    score_res = await calculate_spot_score(
        user_id=user_id,
        preferred_categories=preferred_categories,
        original_congestion_level=current_congestion,
        candidate_facility=scored_facility,
        user_lat=cur_lat,
        user_lng=cur_lng,
        user_vector=user_vector,
        # 누적 출발 시각(직전 정류지까지의 누적 오프셋 반영) → score 내부 도착예측이 predicted_congestion 과 정합.
        depart_time=now + timedelta(minutes=cum_offset_min),
        # 같은 구간을 score 안에서 또 길찾기하지 않도록 위에서 받은 경로를 그대로 넘긴다.
        # 넘기지 않으면 score 는 동일 인자로 get_travel_time_and_distance 를 한 번 더 부른다 —
        # 결과가 같은 중복 계산이었을 뿐이라 override 로 바꿔도 점수는 변하지 않는다.
        # travel_source 는 '정정'이다. override 없이 부르면 score 가 근거를 무조건 "estimated" 로
        # 덮어써서(score.py), OSM 보행로로 실제 계산한 구간도 추정으로 기록됐다. 코스 응답은
        # breakdown 을 싣지 않아 화면에 보이던 값은 아니지만, 없는 사실을 적어 두지는 않는다.
        travel_time_override=route.duration_min,
        travel_distance_override=route.distance_m,
        travel_source=route.source,
    )

    return {
        "facility": scored_facility,
        "spot_score": score_res.score,
        "predicted_congestion": predicted_congestion,
        "current_congestion": current_congestion,
        "arrival_offset_min": round(arrival_offset, 1),
        "travel_minutes": round(travel_min, 1),
        "distance_m": dist,
        "open_status_at_arrival": open_status_at_arrival(scored_facility, arrival_dt),
    }


async def _course_or_503(req: CourseRequest, current_user: dict) -> CoursePlan:
    """두 엔드포인트가 공유하는 가드 + 예외 처리."""
    logger.info("course_request", user_id=req.user_id, types=req.types, sequence=req.sequence)

    # 소유권 가드(IDOR 방지): 본문 user_id 는 토큰 주체와 일치해야 한다(타인 선호벡터 조회 차단).
    if req.user_id != current_user["id"]:
        raise HTTPException(status_code=403, detail="요청한 user_id가 인증된 사용자와 일치하지 않습니다.")

    # 이 아래는 네트워크 의존 호출이 6곳이다(사용자·시설 조회, 사장님 부스트, 선호벡터
    # 조회/갱신, 혼잡도, 후보 평가). 예전에는 그 중 하나만 흔들려도 그대로 500 "Internal
    # Server Error" 가 나갔다 — 실제로 프로덕션에서 같은 요청이 한 번은 500, 재시도하면
    # 200 인 것을 확인했다(2026-08-28).
    #
    # 빈 배열로 삼키지 않는다. []는 "조건에 맞는 코스가 없다"는 **정상 결과**이고 화면도
    # 그렇게 안내한다 — 장애를 그 모양으로 돌려주면 사용자도 우리도 구분할 수 없다.
    # 대신 503 으로 구분해 던진다. 프런트는 이미 503 을 ServiceUnavailableError 로 따로
    # 잡는다(apps/web/lib/api-client.ts).
    try:
        return await _build_course(req)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "course_recommend_failed",
            user_id=req.user_id,
            types=req.types,
            sequence=req.sequence,
            error=str(exc),
            error_type=type(exc).__name__,
            # 스택까지 남긴다 — 어느 외부 의존이 흔들렸는지 로그만 보고 좁힐 수 있어야 한다.
            # (실제로 프로덕션에서 이 자리를 만났을 때 str(exc) 만으로는 원인을 못 좁혔다.)
            exc_info=True,
        )
        # Render 로그를 못 볼 때를 대비한 진단 통로(개발자 콘솔에서 조회).
        record_failure("course_recommend", exc, types=req.types, sequence=req.sequence)
        raise HTTPException(
            status_code=503,
            detail="코스를 짜는 중 일시적인 문제가 생겼어요. 잠시 후 다시 시도해 주세요.",
        ) from exc


@router.post("/courses/recommend", response_model=list[CourseStop])
async def recommend_course(
    req: CourseRequest,
    current_user: dict = Depends(get_current_user),
):
    """정류지 배열만 돌려주는 **기존 계약**. 바꾸지 않는다.

    Vercel(정적 export)과 Render 는 배포 시점이 다르고 스테이징이 없다. 최상위를 객체로
    바꾸면 새 API 가 먼저 뜨는 창에서 구 번들의 `Array.isArray(data) ? data : []` 가 false 로
    떨어져 **장애가 '갈 곳 없음'으로 보인다.** 새 정보가 필요한 화면은 /courses/plan 을 쓴다.
    """
    plan = await _course_or_503(req, current_user)
    return plan.stops


@router.post("/courses/plan", response_model=CoursePlan)
async def plan_course(
    req: CourseRequest,
    current_user: dict = Depends(get_current_user),
):
    """정류지 + 자리별 결과 + plan_id.

    /recommend 와 같은 계산이다(같은 _build_course). 다른 것은 봉투뿐 — 왜 나눴는지는
    /recommend docstring 참조.
    """
    return await _course_or_503(req, current_user)


def _empty_plan(seq: list[str] | None, status: str) -> CoursePlan:
    """후보가 하나도 없어 코스를 못 짠 경우.

    자리 결과를 비워 보내지 않는다. 사용자가 [카페, 식당, 관광지] 를 짜 놓고 빈 화면을 받으면
    '서버가 죽었나' 와 '조건에 맞는 곳이 없나' 를 구분할 수 없다 — 이 라우터가 다른 곳에서는
    503 과 빈 배열을 굳이 갈라 놓는 것과 같은 이유다.

    자동 모드(seq 없음)에는 사용자가 지정한 자리가 없으므로 1번 자리 하나로 사실만 전한다.
    """
    orders = seq or [None]
    return CoursePlan(
        stops=[],
        slot_outcomes=[
            SlotOutcome(order=i + 1, requested_type=wanted, status=status)
            for i, wanted in enumerate(orders)
        ],
        plan_id=_plan_id([]),
    )


async def _build_course(req: CourseRequest) -> CoursePlan:
    """코스 조립 본체. 예외 처리는 호출부(recommend_course)가 맡는다."""
    # 영업 근거는 여기서 받지 않는다 — 후보 풀이 정해진 뒤 그 몇 곳에만 붙인다(아래 참고).
    user_info, all_facilities = await asyncio.gather(
        fetch_user(req.user_id), fetch_all_facilities(with_availability=False)
    )

    # 순서 지정(sequence) 정규화 — 무효 종류 제거, 코스 길이 상한까지만. 주어지면 types 를 대체한다.
    seq = [t for t in (req.sequence or []) if t in _VALID_COURSE_TYPES][:MAX_STOPS] or None

    allowed_types = set() if seq else set(req.types or [])
    candidates = [
        f for f in all_facilities
        if (not allowed_types or f.get("type") in allowed_types)
        and facility_matches_context(f, req.context)
    ]
    if not candidates:
        # 여행 조건(카테고리·실내·접근성·방문 제외)이 전부 걸러낸 경우다.
        return _empty_plan(seq, SLOT_NO_CANDIDATE)

    # 현실성 컷오프 + 인근 상한: 도보 비현실 거리는 제외하고 가까운 순 상위만 후보로(호출량 제한).
    # 반경 내가 최소 정류지 수 미만이면 가까운 순 폴백(외곽/데이터 희소 위치에서도 코스가 끊기지 않게).
    with_dist = sorted(
        (
            (f, calculate_haversine_distance(req.user_lat, req.user_lng, f["latitude"], f["longitude"]))
            for f in candidates
        ),
        key=lambda x: x[1],
    )
    max_distance = req.context.max_distance_m if req.context and req.context.max_distance_m else _MAX_RECO_DISTANCE_M
    reachable = [f for f, d in with_dist if d <= max_distance]
    if seq:
        # 순서 지정 모드: 요청된 각 종류가 후보 풀에 반드시 대표되도록 종류별 가까운 순 상한으로 구성.
        # (가까운 순 전체 상위 12곳에 특정 종류가 없으면 해당 슬롯이 성립 불가 — 종류별 보장이 필요.)
        pool = []
        seen_ids: set[str] = set()
        for t in dict.fromkeys(seq):  # 순서 보존 중복 제거
            typed = [f for f, d in with_dist if f.get("type") == t and d <= max_distance]
            if not typed and not (req.context and req.context.max_walk_minutes):
                # 도보 제한을 **사용자가 고른 경우에만** 엄격한 자격 규칙으로 본다.
                # 안 고른 요청(max_walk_minutes 없음)은 반경 밖이라도 가까운 순으로 채운다 —
                # 외곽·데이터 희소 위치에서 코스가 통째로 비는 것을 막으려는 폴백이다.
                #
                # 이 분기는 한동안 사실상 죽어 있었다: 웹이 온보딩을 건너뛴 사용자에게도
                # maxWalkMinutes=20 을 실어 보내서(EMPTY_TRAVEL_CONTEXT) 여기서는 늘
                # '명시적 제한' 으로 읽혔다. 프런트에서 그 기본값을 걷어내며 다시 살아났다.
                typed = [f for f, _ in with_dist if f.get("type") == t]
            for f in typed[:_SEQ_CANDIDATES_PER_TYPE]:
                if f["id"] not in seen_ids:
                    seen_ids.add(f["id"])
                    pool.append(f)
    else:
        pool = reachable[:_AUTO_POOL_CANDIDATES]
        if len(reachable) < MIN_STOPS and not (req.context and req.context.max_walk_minutes):
            pool = [f for f, _ in with_dist[:_AUTO_POOL_CANDIDATES]]

    # 고정한 가게는 풀 밖에 있을 수 있다(사용자가 조금 먼 곳을 붙박았을 수 있다).
    # 그래도 **자격 검사는 통과해야 한다** — candidates 는 이미 facility_matches_context 를
    # 지난 목록이므로 거기서만 끌어온다. 접근성 '미상 = 부적격' 은 fail-closed 판정인데
    # (travel_context.py), 고정이라는 이유로 우회시키면 그 결과는 휠체어 사용자를 계단 앞에
    # 세우는 것이다. 자격에 걸린 고정은 조용히 넣지 않고 pin_unavailable 로 알린다.
    pinned_ids = {p.facility_id for p in (req.pins or [])}
    if pinned_ids:
        eligible_by_id = {f["id"]: f for f in candidates}
        in_pool = {f["id"] for f in pool}
        for fid in pinned_ids:
            facility = eligible_by_id.get(fid)
            if facility is not None and fid not in in_pool:
                pool.append(facility)
                in_pool.add(fid)

    if not pool:
        # 조건에 맞는 곳은 있는데 걸어갈 만한 거리 안에 없다.
        return _empty_plan(seq, SLOT_NO_CANDIDATE)

    # 머천트 랭킹 연동(2단계): 활성 타임세일(coupon_rate 유효값 교체)·신선 좌석 상태(혼잡 실측 대체)를
    # 스코어링 전에 오버레이한다(score.py 는 무변경 — calculate_spot_score 입력값만 바꿔친다).
    pool = await apply_merchant_boosts(supabase_admin, pool)

    # 선호 벡터 1회 조회(없으면 Cold Start 생성 후 업서트) — recommendations 라우터와 동일 패턴.
    user_vector = await preference_vector_service.get_user_vector(req.user_id)
    if not user_vector:
        user_vector = get_category_average_vector(user_info.get("preferred_categories", []))
        await preference_vector_service.upsert_user_vector(req.user_id, user_vector)

    # 영업 근거(availability)는 **여기서** 후보 풀에만 붙인다.
    #
    # 예전에는 fetch_all_facilities() 가 시설 전체분을 통째로 받아 왔다. 시설이 85곳이던
    # 시절 주석이 그대로 남아 있었는데 지금은 1,600곳이 넘고, PostgREST in.(...) URL 한계
    # 때문에 150개씩 끊어 받으므로 **코스 한 번에 요청 11건**이 그것 때문에 나갔다
    # (실측: 웜 캐시 기준 Supabase 요청 15건 중 11건). 정작 쓰는 곳은 후보 12~24곳을
    # 평가하는 open_status_at_arrival 하나뿐이라 나머지는 전부 버려졌다.
    #
    # 후보 풀은 여기서 확정되므로 이 시점에 조회하면 요청이 1건으로 줄고, 신선도는
    # 오히려 좋아진다(평가 직전 값이다). 혼잡도와 함께 한 번에 나간다.
    pool_ids = [f["id"] for f in pool]
    congestion_now, availability_by_id = await asyncio.gather(
        fetch_congestion_map(pool_ids),
        fetch_effective_availability_map(pool_ids),
    )
    pool = attach_availability_evidence(pool, availability_by_id)
    preferred_categories = user_info.get("preferred_categories", [])
    now = datetime.now(timezone.utc)

    # 자리 고정(핀) 색인. 같은 자리에 두 번 오면 뒤엣것을 쓴다(클라이언트 실수를 422 로 만들지 않는다).
    pins_by_order: dict[int, str] = {p.order: p.facility_id for p in (req.pins or [])}

    target_stops = len(seq) if seq else min(MAX_STOPS, len(pool))
    remaining = list(pool)
    used_types: set[str] = set()
    cur_lat, cur_lng = req.user_lat, req.user_lng
    cum_offset = 0.0
    chosen: list[tuple[int, dict]] = []
    outcomes: list[SlotOutcome] = []

    # 이미 전멸한 것으로 판명된 (종류, 누적 시각) 조합. 아래 continue 와 짝이다.
    #
    # 예전에는 후보가 전멸하면 `break` 였다 — 그 자리 하나가 비는 게 아니라 **뒤 자리가 통째로
    # 사라졌다.** 저녁에 [식당, 카페, 관광지] 를 짜면 1번에서 걸려 코스가 아예 안 나오는 식이다.
    # 그렇다고 순진하게 `continue` 만 하면 더 나빠진다: continue 는 cur_lat/cum_offset 을
    # 갱신하지 않고 remaining 도 줄지 않으므로, 같은 종류를 요청한 다음 자리가 **완전히 같은
    # 후보를 완전히 같은 시각에** 다시 평가해 결정적으로 또 빈다. 평가 1회가 캐시 없는
    # 지역수요 조회 1건이라, 그 낭비가 하필 '빈 코스로 끝나는' 가장 느린 경로에서 쌓인다.
    exhausted: dict[tuple[str | None, float], str] = {}

    for step_idx in range(target_stops):
        slot_no = step_idx + 1
        wanted_type = seq[step_idx] if seq else None
        pinned_id = pins_by_order.get(slot_no)

        # 다른 자리에 고정된 가게는 이 자리의 후보가 아니다.
        #
        # 빼지 않으면 그리디가 먼저 집어가고, 정작 그 자리 차례에는 remaining 에서 이미 빠져
        # pin_unavailable 이 된다 — 사용자가 명시적으로 고정한 자리가 조용히 다른 자리에 먹힌다.
        other_pinned = {fid for no, fid in pins_by_order.items() if no != slot_no}
        available = [f for f in remaining if f["id"] not in other_pinned]

        # 고정이 있으면 후보가 하나도 안 남은 경우에도 **고정 기준으로** 답한다.
        # 'no_candidate_of_type' 이라고 하면 사용자는 자기가 지목한 가게가 어떻게 됐는지
        # 알 수 없다 — 이름을 대고 고정한 사람에게는 그 가게 이야기를 돌려줘야 한다.
        if pinned_id is not None:
            pinned = next((f for f in available if f["id"] == pinned_id), None)
            if pinned is None:
                # 풀에 없다 = 존재하지 않거나, 여정 조건(접근성·실내·카테고리)에 맞지 않거나,
                # 앞 자리에서 이미 쓰였다. 어느 쪽이든 **넣지 않고** 알린다 — 특히 접근성은
                # '미상 = 부적격' 의 fail-closed 판정이라(travel_context.py), 핀이라고
                # 우회시키면 그 결과는 휠체어 사용자를 계단 앞에 세우는 것이다.
                outcomes.append(SlotOutcome(
                    order=slot_no, requested_type=wanted_type,
                    status=SLOT_PIN_UNAVAILABLE, facility_id=pinned_id, pinned=True,
                ))
                continue
            pick_from = [pinned]
        elif not remaining:
            outcomes.append(SlotOutcome(order=slot_no, requested_type=wanted_type, status=SLOT_NO_CANDIDATE))
            continue
        elif seq:
            # 순서 지정 모드: 이번 자리는 요청된 종류에서만 고른다. 사용자가 명시한 종류를
            # 조용히 다른 종류로 대체하지 않는다 — 코스가 짧아질 뿐 지어내지 않는다.
            typed = [f for f in available if f.get("type") == wanted_type]
            if not typed:
                outcomes.append(SlotOutcome(order=slot_no, requested_type=wanted_type, status=SLOT_NO_CANDIDATE))
                continue
            pick_from = typed
        else:
            # 종류 다양성: 후보 풀에 여러 종류가 남아 있으면, 아직 방문 안 한 종류를 우선 고른다
            # (카페→식당→관광지 같은 다채로운 동선). 한 종류만 남았거나 모두 방문했으면 전체에서 고른다.
            distinct_types = {f.get("type") for f in available}
            pick_from = available
            if len(distinct_types) > 1:
                unused = [f for f in available if f.get("type") not in used_types]
                if unused:
                    pick_from = unused
            if not pick_from:
                outcomes.append(SlotOutcome(order=slot_no, requested_type=None, status=SLOT_NO_CANDIDATE))
                continue

        # 같은 조건으로 이미 전멸한 자리면 다시 평가하지 않는다(위 exhausted 주석).
        seen_key = (wanted_type, round(cum_offset, 3))
        if pinned_id is None and seen_key in exhausted:
            outcomes.append(SlotOutcome(order=slot_no, requested_type=wanted_type, status=exhausted[seen_key]))
            continue

        # 이 자리에서 **실제로 채점할** 후보를 '지금 서 있는 자리' 기준으로 추린다.
        #
        # 여기가 이 기능의 핵심이다. 예전에는 후보 풀이 곧 평가 대상이었고, 그 풀은 '사용자
        # 위치 기준 가까운 순' 으로 잘려 있었다. 그래서 2번 자리를 고를 때 이미 1번 정류지로
        # 옮겨간 출발점 근처의 가게가 **애초에 후보에 없었다** — 순서를 어떻게 바꿔도 같은
        # 집합에서 같은 argmax 가 나온 이유다(순서 모드의 풀은 종류별 합집합이라 순열에 불변이다).
        #
        # 풀을 넓게 잡고 자리마다 다시 추리면, 평가 횟수는 그대로인 채 2번 이후의 후보만 실제로
        # 달라진다. **1번은 달라지지 않는다** — 출발점이 곧 사용자 위치라 추려낸 결과가 종전과
        # 같다. 이 기능이 약속할 수 있는 것은 딱 거기까지다.
        eval_limit = 1 if pinned_id is not None else (_SEQ_SLOT_EVAL_LIMIT if seq else MAX_COURSE_CANDIDATES)
        if len(pick_from) > eval_limit:
            pick_from = sorted(
                pick_from,
                key=lambda f: (
                    calculate_haversine_distance(cur_lat, cur_lng, f["latitude"], f["longitude"]),
                    f["id"],   # 동점은 id 로 깬다 — 정렬이 결정적이어야 응답도 결정적이다.
                ),
            )[:eval_limit]

        # 보행 경로는 이 슬롯의 후보 전체를 **한 번에** 구한다.
        #
        # get_travel_time_and_distance 는 get_walking_routes 의 단건 래퍼다. 후보마다 부르면
        # 같은 출발점에서 28,832노드 그래프 Dijkstra 전탐색이 후보 수만큼 반복됐고, 게다가
        # calculate_spot_score 안에서 같은 구간이 한 번 더 돌아 **후보당 2회**였다
        # (실측: 자동 모드 후보 평가 27회 → Dijkstra 54회). 이 탐색은 to_thread 없이 이벤트
        # 루프 위에서 동기로 도는지라 그대로 응답 지연이 된다 — Render 무료 플랜에서 이
        # 엔드포인트가 실제로 타임아웃으로 죽은 적이 있다.
        #
        # 배치화해도 값은 바뀌지 않는다. Dijkstra 가 돌려주는 각 목적지까지의 최단거리는
        # 목적지 집합에 무엇이 더 들어 있든 같고, 목적지 집합은 조기 종료 시점만 늦출 뿐이다.
        # (경로 근거·폴백 판정도 목적지별로 독립이다 — travel.py.)
        # recommendations 라우터가 이미 쓰는 패턴이라 코스만 예외로 남아 있던 것이다.
        routes = await get_walking_routes(
            cur_lat, cur_lng, [(f["latitude"], f["longitude"]) for f in pick_from]
        )

        # 후보 하나가 터지면 코스 전체가 날아가던 자리다. 후보 평가는 외부 의존이 여럿이라
        # (혼잡 예측·SPOT 스코어·지역수요) 하나쯤 흔들릴 수 있는데, gather 기본 동작은
        # 첫 예외를 그대로 올려 **나머지 멀쩡한 후보까지 버린다.**
        #
        # 부분 실패는 그 후보만 빼고 진행한다. 다만 **전부 실패하면 올린다** — 그때는 빈 코스가
        # "갈 곳이 없다"는 정상 결과와 구분되지 않기 때문이다(호출부가 503 으로 바꾼다).
        # 경로 탐색은 이제 이 gather 밖(위 배치)이라 실패하면 슬롯 전체가 예외로 올라간다.
        # 후보별로 잘라낼 수 있는 실패가 아니라 슬롯의 출발점 자체가 없는 상황이라 그게 맞다.
        #
        # zip 의 strict=True: 길이가 어긋나면 zip 은 조용히 뒤를 잘라 후보가 소리 없이 사라진다.
        # 그러면 '후보가 빠진 것'과 '갈 곳이 없는 것'을 구분할 수 없으므로 여기서는 터뜨린다.
        settled = await asyncio.gather(*[
            _evaluate_candidate(
                f, route, cur_lat, cur_lng, cum_offset, now, congestion_now,
                user_vector, preferred_categories, req.user_id,
            )
            for f, route in zip(pick_from, routes, strict=True)
        ], return_exceptions=True)

        failures = [r for r in settled if isinstance(r, BaseException)]
        evaluations = [r for r in settled if not isinstance(r, BaseException)]
        if failures:
            logger.warning(
                "course_candidate_evaluation_failed",
                failed=len(failures),
                total=len(settled),
                error=str(failures[0]),
                error_type=type(failures[0]).__name__,
            )
        if settled and not evaluations:
            raise failures[0]

        # 도착 시각 자격과 시간 예산을 나눠 센다. 둘을 뭉뚱그리면 자리가 빈 이유를 말할 수 없다.
        open_ok = [
            e for e in evaluations
            if is_recommendable_at_arrival(
                e["facility"], now + timedelta(minutes=e["arrival_offset_min"])
            )
        ]
        dropped_closed = len(evaluations) - len(open_ok)
        evaluations = open_ok
        dropped_budget = 0
        if req.context and req.context.available_minutes:
            within_budget = [
                e for e in evaluations
                if e["arrival_offset_min"] + COURSE_DWELL_MIN.get(
                    e["facility"].get("type"), DEFAULT_DWELL_MIN
                ) <= req.context.available_minutes
            ]
            dropped_budget = len(evaluations) - len(within_budget)
            evaluations = within_budget

        if not evaluations:
            # 무엇이 이 자리를 비웠는가. 예산 컷이 마지막 관문이므로 그쪽이 우선이다
            # (영업은 통과했는데 시간이 모자란 경우 = 사용자가 바꿀 수 있는 조건이다).
            if dropped_budget:
                status = SLOT_OVER_TIME_BUDGET
            elif dropped_closed:
                status = SLOT_CLOSED_AT_ARRIVAL
            else:
                status = SLOT_NO_CANDIDATE
            if pinned_id is None:
                exhausted[seen_key] = status
            outcomes.append(SlotOutcome(
                order=slot_no, requested_type=wanted_type, status=status,
                facility_id=pinned_id, pinned=pinned_id is not None,
            ))
            continue

        # SPOT is the sole ranking objective. Arrival congestion is already an input to SPOT.
        evaluations.sort(key=lambda e: (-e["spot_score"], e["distance_m"], e["facility"]["id"]))
        best = evaluations[0]
        # 2등 이하는 버리지 않고 이 자리의 '다른 곳' 으로 실어 보낸다(CourseAlternative 주석 참조).
        best["alternatives"] = evaluations[1 : 1 + MAX_ALTERNATIVES_PER_STOP]
        chosen.append((slot_no, best))
        outcomes.append(SlotOutcome(
            order=slot_no, requested_type=wanted_type, status=SLOT_FILLED,
            facility_id=str(best["facility"]["id"]), pinned=pinned_id is not None,
        ))

        best_facility = best["facility"]
        used_types.add(best_facility.get("type"))
        remaining = [f for f in remaining if f["id"] != best_facility["id"]]
        cur_lat, cur_lng = best_facility["latitude"], best_facility["longitude"]
        # 다음 정류지 도착 시각 = 이 정류지 도착 + 체류 시간.
        cum_offset = best["arrival_offset_min"] + COURSE_DWELL_MIN.get(
            best_facility.get("type"), DEFAULT_DWELL_MIN
        )

    if req.context and req.context.available_minutes:
        # 루프 안의 예산 컷(도착+체류)이 이 조건(도착)보다 엄격하므로 여기서 걸릴 것은 없다.
        # 그래도 남겨 둔다 — 위 조건이 언젠가 느슨해져도 예산을 넘긴 정류지가 화면에 나가면 안 된다.
        # 다만 걸린다면 슬롯 결과도 함께 정정해야 한다(안 그러면 '채웠다' 고 말해 놓고 안 준 셈이다).
        kept, trimmed_orders = [], []
        for slot_no, item in chosen:
            if item["arrival_offset_min"] <= req.context.available_minutes:
                kept.append((slot_no, item))
            else:
                trimmed_orders.append(slot_no)
        if trimmed_orders:
            logger.warning("course_budget_posttrim", orders=trimmed_orders)
            outcomes = [
                o.model_copy(update={"status": SLOT_OVER_TIME_BUDGET, "facility_id": None})
                if o.order in trimmed_orders else o
                for o in outcomes
            ]
        chosen = kept

    stops = [
        CourseStop(
            order=i + 1,
            facility=item["facility"],
            arrival_offset_min=item["arrival_offset_min"],
            predicted_congestion=(
                round(item["predicted_congestion"], 3)
                if item["predicted_congestion"] is not None else None
            ),
            spot_score=item["spot_score"],
            reason=_build_stop_reason(
                i + 1,
                item["facility"],
                item["arrival_offset_min"],
                item["predicted_congestion"],
                item["current_congestion"],
            ),
            open_status_at_arrival=item["open_status_at_arrival"],
            travel_minutes=item["travel_minutes"],
            alternatives=[
                CourseAlternative(
                    facility={
                        k: alt["facility"].get(k)
                        for k in ("id", "name", "type", "latitude", "longitude")
                    },
                    arrival_offset_min=alt["arrival_offset_min"],
                    predicted_congestion=(
                        round(alt["predicted_congestion"], 3)
                        if alt["predicted_congestion"] is not None else None
                    ),
                    spot_score=alt["spot_score"],
                    travel_minutes=alt["travel_minutes"],
                )
                for alt in item.get("alternatives", [])
            ],
        )
        for i, (_slot_no, item) in enumerate(chosen)
    ]
    logger.info(
        "course_generated",
        stops=len(stops),
        slots=len(outcomes),
        filled=sum(1 for o in outcomes if o.status == SLOT_FILLED),
    )
    return CoursePlan(stops=stops, slot_outcomes=outcomes, plan_id=_plan_id(stops))
