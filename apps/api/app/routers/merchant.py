"""소상공인 '내 가게 대시보드'(머천트 콘솔) 전용 라우터.

배경: 관광객 앱/관리자 관제와 별개로, 개별 가맹점 사장님이 자기 시설 하나만 보고 다루는
  전용 콘솔이 없었다. 이 라우터가 그 백엔드다 — apps/web/app/merchant/* 프런트가 소비한다.

- 인증은 **Supabase JWT + users.role='merchant'** 이고, 그 위에 **가게 소유권**을 강제한다
  (app/core/authz.py). 역할은 "콘솔에 들어갈 수 있다" 만 뜻하고, 어느 가게를 다루는지는
  facility_owners 가 정한다 — 이 검사가 없으면 누구나 아무 가게의 좌석 상태를 방송할 수 있고
  그 방송이 evidence_tier='verified' 로 학습 데이터에 들어간다(CONGESTION_TRUST_SPEC).
- 구 X-Merchant-Token 공유 토큰은 settings.LEGACY_CONSOLE_TOKENS 가 켜져 있는 동안만
  한시 수용된다(프런트 전환 전 무중단용). 그 경로는 사용자가 특정되지 않아 소유권을 확인할 수
  없으므로 **예전과 동일하게 소유권 검사를 건너뛴다** — 보안 구멍이 열려 있는 상태이며,
  프런트가 JWT 로 전환되는 즉시 이 플래그를 끈다.
- DB 접근은 service_role(supabase_admin) — RLS 우회는 이 신뢰 경로 안에서만 일어난다.
- 예외 원문은 서버 로그로만 남기고 클라이언트에는 일반 메시지를 준다(admin 라우터와 동일 관례).

추천 랭킹 반영 범위(2026-07 코드 확인 — 도입 당시 "미연동" 주석은 사실과 달라 정정):
  이 라우터가 쓰는 두 값은 app/services/merchant_boost.py 의 데이터 레이어 오버레이를 거쳐
  추천 랭킹에 **실제로 반영된다**. score.py(산식·가중치)는 무변경 — 오버레이는 score.py 가
  이미 읽는 입력값을 스코어링 직전에 바꿔치기하는 방식이다.
  - 셀프 타임세일(merchant_timesales): merchant_boost._apply_timesale_boost 가 활성 세일 중
    **최댓값 rate** 로 facility["coupon_rate"] 를 max() 갱신 → score.py 의 인센티브 항에 반영.
  - 좌석 상태(facilities.features.seat_status): **30분 이내로 신선할 때만**
    merchant_boost._apply_seat_status_boost 가 '현재 혼잡'을 대체(low=0.15/mid=0.5/full=0.9).
    30분을 넘긴 값은 무시된다.
  적용 호출부 4곳(2026-09-03 재확인 — 줄 번호는 또 낡으므로 **함수명**을 정본으로 본다):
    · recommendations.get_recommendations    — POST /recommendations (메인 분산 추천), :379
    · recommendations._recommend_by_type     — POST /recommendations/by-type, :767
    · courses._build_course                  — POST /courses/plan · /courses/recommend
    · coupon_service.issue_coupon_if_partner — 쿠폰 발급 시점의 유효 쿠폰율 재확인, :55
  네 곳 모두 **후보 확정 직후·스코어링 이전**에 얹는다 — 점수 계산 뒤에 얹으면 랭킹에
  반영되지 않는다. 메인 추천 호출부는 2026-09-03 에 새로 채웠다: 그전까지 이 자리에 있던
  "확인된 3곳: recommendations.py:370" 은 by-type 쪽만 가리키고 있었고(그나마 줄 번호도
  낡았다), 그래서 타임세일이 **메인 추천 랭킹에는 전혀 반영되지 않았다**.
  그 외 경로에는 적용되지 않는다.
"""
import asyncio
import hmac
import math
from datetime import datetime, timedelta, timezone
from typing import Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.core.authz import (
    ROLE_MERCHANT,
    assert_role,
    load_profile_from_request,
    require_facility_owner,
    require_merchant_console_enabled,
)
from app.core.config import settings
from app.core.internal_accounts import filter_internal_roles, internal_ids_from_rows, is_internal_user
from app.core.supabase import fetch_all_rows, supabase_admin
from app.services import merchant_briefing_service, reference_snapshot
from app.services.merchant_boost import SEAT_LEVEL_CONGESTION, SEAT_STATUS_FRESH_MINUTES

logger = structlog.get_logger()

# 구 공유 토큰(X-Merchant-Token) 한시 수용 경로.
#
# settings 경유로 읽는다(직접 os.environ 을 읽지 않는다): pydantic-settings 는 .env 를
# os.environ 에 주입하지 않으므로, os.environ.get 은 .env 에 적은 값을 조용히 무시한다.
# 모듈 로드 시점에 상수로 굳히지 않고 호출마다 settings 에서 읽는다 — import 순서에 값이
# 좌우되지 않고, 테스트가 monkeypatch 로 토큰 경로를 실제로 검증할 수 있다.
def _legacy_token_ok(request: Request) -> bool:
    """구 공유 토큰이 유효한가. LEGACY_CONSOLE_TOKENS 가 꺼져 있으면 항상 False."""
    if not settings.LEGACY_CONSOLE_TOKENS:
        return False
    token = (request.headers.get("x-merchant-token") or "").strip()
    return bool(token) and hmac.compare_digest(token, settings.MERCHANT_API_TOKEN)


async def merchant_context(
    request: Request,
    _console: None = Depends(require_merchant_console_enabled),
) -> dict:
    """사장님 콘솔 요청 컨텍스트.

    반환값의 ``profile`` 이 None 이면 **레거시 공유 토큰 경로**다 — 사용자를 특정할 수 없어
    소유권을 확인할 수 없으므로, 호출부의 assert_owns() 가 검사를 건너뛴다(예전 동작 유지).
    JWT 경로면 role 과 소유 가게가 채워진 profile 이 들어온다.
    """
    if _legacy_token_ok(request):
        logger.warning("legacy_token_used", path=request.url.path)
        return {"profile": None}

    # JWT 경로 — 여기서부터는 role·소유권을 정식으로 강제한다.
    profile = await load_profile_from_request(request)
    if profile is None:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    assert_role(profile, ROLE_MERCHANT)
    return {"profile": profile}


def assert_owns(ctx: dict, facility_id: str) -> None:
    """이 요청이 해당 가게를 다룰 수 있는지 확인한다(레거시 경로는 통과)."""
    profile = ctx.get("profile")
    if profile is None:
        return
    require_facility_owner(profile, facility_id)


router = APIRouter(prefix="/api/v1/merchant", tags=["merchant"])

_STATS_WINDOW_DAYS = 7
# 타임세일 UI 는 15/20/30% × 1/2/3시간의 고정 3×3 그리드다 — 서버도 동일 값만 허용해
# 임의 값(남용/오입력) 발행을 원천 차단한다.
_RATE_OPTIONS = (0.15, 0.20, 0.30)
_DURATION_MINUTES_OPTIONS = (60, 120, 180)
_SEAT_LEVELS = ("low", "mid", "full")


# =========================================================================
# 성적표 — GET /api/v1/merchant/stats?facility_id=&days=7|30
#
# 최근 N일과 **그 직전 N일**을 같은 규칙으로 센다. 사장님이 '늘었나, 줄었나' 를 같은 잣대로 볼 수 있어야
# 숫자가 쓸모 있다(예전에는 최근 7일 합계 하나뿐이라 월말에 "손님을 데려왔나" 에 답할 수 없었다).
#   · 쿠폰 발급/사용 — user_coupons. 발급 시각(issued_at)으로 기간을 가르고, 사용은 그 기간에 발급된
#     쿠폰 중 사용 처리된 것이다(예전과 같은 정의).
#   · 혼잡 제보     — congestion_logs source='user_report'.
#   · 길안내 시작   — recommendations.accepted=true. 아래 '수락 행' 참조.
#   · 도착 확인     — recommendation_outcomes.arrival_confirmed_at 이 있고, 그 추천의
#     recommended_facility_id 가 이 가게인 방문. 예전에는 서버에 이 기록이 있는데도 null 이었다.
#   · 추천 노출     — usage_events 'rec_shown'. 손님 화면에 이 가게 카드가 **실제로 그려진** 횟수다.
#     아래 '노출' 참조.
#
# 내부 계정(users.role admin·developer)의 쿠폰·제보·길안내·도착은 세지 않는다 — 팀·심사 계정이 눌러 본
# 기록이 사장님 실적으로 보이면 안 된다. rec_shown 은 계정과 이어지지 않아(usage_events 에 user_id 칼럼이
# 없다) 뺄 수 없다 — 대신 운영 주소 밖(로컬·미리보기)·자동화(e2e) 접속은 웹이 애초에 남기지 않는다.
#
# [노출] 예전 '노출' 은 이 가게가 들어간 recommendations 행 수였다. 그 행은 화면과 무관하게 생긴다 —
#   /main 은 들어올 때마다 4업종×8곳을 미리 요청하고(apps/web/lib/api-client.ts), 그 응답이 전부 행이 된다.
#   그래서 실제로 본 사람이 없어도 숫자가 불었다. rec_shown 은 카드가 그려질 때 한 번 남고
#   (components/RecommendationCard.tsx), props.facility_id 로 가게가 정확히 갈린다. props.rank 가 없는 기록은
#   손님이 검색·링크로 직접 연 카드라 '추천 노출' 이 아니다 — 세지 않는다.
#   · 이 기록은 usage_events 가 생긴 뒤(운영 2026-10-24)부터만 있다. 그래서 기록 시작이 기간 안에 있으면
#     counted_since 로 '언제부터 센 숫자인지' 를 함께 주고, 직전 기간이 기록 시작보다 앞서면 비교값을 주지
#     않는다(없던 기록을 0 으로 읽으면 '노출이 늘었다' 는 거짓 비교가 된다).
#   · usage_events 를 못 읽거나 기록이 한 번도 없으면 예전처럼 행 수로 물러서되, exposure_basis='list_rows' 로
#     **다른 숫자라는 것**을 알린다 — 화면은 이름을 '추천 목록에 포함된 횟수' 로 바꿔 단다.
#
# [수락 행] 두 모양이 섞여 있다(2026-10-31 기준).
#   · 예전 메인 '바로 갈래요'(/recommendations/accept): 노출된 행은 그대로 두고 original=recommended 인 새 행을
#     accepted=true 로 하나 더 넣는다(spot_score 0, score_breakdown {}).
#   · 새 경로(recommendation_id 를 함께 보낸 수락)·탐색 화면 피드백(/feedback): 노출된 그 행을 accepted=true 로 바꾼다.
#   어느 쪽이든 수락 하나에 accepted=true 행은 하나다. 다만 예전 모양은 같은 손님이 다시 누르면 행이 하나 더 생기고,
#   새 모양은 같은 추천을 다시 눌러도 그대로다 — 그래서 **(손님, KST 날짜)당 한 번**으로 센다. 이행 중 한 수락이
#   갱신과 삽입으로 두 번 적혀도 한 번이다. 도착 확인도 같은 규칙으로 센다.
#   새 모양의 행은 created_at 이 '노출된 시각' 이다(accepted_at 칸이 없다) — 수락이 노출보다 늦으면 노출한 날로
#   센다. 보통 몇 분 차이라 기간 경계에서만 드물게 하루가 밀린다.
#   행 수로 노출을 셀 때는 score_breakdown 이 빈 행(예전 수락 행)을 뺀다 — 목록에 들어간 적이 없는 행이다.
# =========================================================================

# 성적표가 고를 수 있는 기간(일) — 화면의 7일·30일 토글과 같은 값만 받는다. 임의 기간을 받으면 직전 기간과의
# 비교 잣대가 흔들리고, 긴 기간은 두 기간치를 통째로 훑는다(30일이면 60일).
_STATS_WINDOW_CHOICES = (7, 30)
# PostgREST 는 한 응답을 1,000행에서 조용히 자른다(오류가 아니라 잘린 200). 그래서 전부 .range() 로 넘겨 읽는다.
# 예전 .limit(5000) 은 이 캡 아래에서 아무 일도 하지 않았다 — 많이 오른 가게일수록 숫자가 1,000 에서 멈췄다.
_STATS_PAGE_SIZE = 1000
# '같은 날' 은 한국 날짜로 가른다 — 사장님의 하루다.
_KST = timezone(timedelta(hours=9))
# 손님 화면에 추천 카드가 그려질 때 웹이 남기는 익명 이벤트(apps/web/lib/usageEvents.ts 의 목록과 같은 이름).
_CARD_SHOWN_EVENT = "rec_shown"
_EXPOSURE_BASIS_CARD = "card_shown"
_EXPOSURE_BASIS_ROWS = "list_rows"
# 메인 탐색의 '관심 없음' 행 — 추천 실적이 아니다(20260716150000_recommendation_source).
_BROWSE_SOURCE = "browse"


class _StatsWindow:
    """최근 N일과 그 직전 N일. 요청 시각에서 거꾸로 잰 롤링 창이다(예전 7일 창과 같은 방식)."""

    def __init__(self, days: int, now: datetime):
        self.days = days
        self.until = now
        self.since = now - timedelta(days=days)
        self.previous_since = self.since - timedelta(days=days)

    def period_of(self, value) -> str | None:
        """타임스탬프가 어느 기간인지 — 'current' · 'previous' · None(둘 다 아니거나 못 읽음)."""
        ts = value if isinstance(value, datetime) else _parse_iso(value)
        if ts is None:
            return None
        if ts >= self.since:
            # 집계하는 동안 들어온 행(ts > until)도 이번 기간이다 — 미래 시각이라고 버리지 않는다.
            return "current"
        if ts >= self.previous_since:
            return "previous"
        return None


def _metric(current: int | None, previous: int | None, people: int | None = None,
            counted_since: str | None = None) -> dict:
    """지표 하나의 응답 모양 — 모든 지표가 같은 칸을 갖는다(화면이 한 가지 모양만 읽게)."""
    return {"current": current, "previous": previous, "people": people, "counted_since": counted_since}


def _is_internal(user_id, internal_ids: frozenset[str]) -> bool:
    return is_internal_user(user_id, internal_ids)


async def _fetch_stats_rows(table: str, select: str, apply_filters) -> list[dict]:
    """조건에 맞는 행 전부(1,000행씩 .range() 로 넘겨 읽는다). 실패는 그대로 올린다 — 호출부가 정한다."""
    return await asyncio.to_thread(
        fetch_all_rows, supabase_admin, table, select, _STATS_PAGE_SIZE, apply_filters
    )


async def _internal_user_ids() -> frozenset[str]:
    """사장님 실적에서 빼는 계정(관리자·개발자) — 관제 지표와 같은 정의(app/core/internal_accounts.py)."""
    rows = await _fetch_stats_rows("users", "id, role", filter_internal_roles)
    return internal_ids_from_rows(rows)


def _period_counts(rows: list[dict], ts_key: str, window: _StatsWindow) -> dict:
    counts = {"current": 0, "previous": 0}
    for row in rows:
        period = window.period_of(row.get(ts_key))
        if period is not None:
            counts[period] += 1
    return _metric(counts["current"], counts["previous"])


def _person_day_counts(rows: list[dict], ts_key: str, window: _StatsWindow) -> dict:
    """(손님, KST 날짜)당 한 번으로 센 기간별 수 + 이번 기간의 사람 수(표본).

    같은 손님이 같은 날 같은 가게로 여러 번 누른 것은 한 번이다(머리말 '수락 행' — 예전 모양의 중복 행과
    이행 중 이중 기록을 함께 흡수한다). 사용자를 모르는 행은 합칠 근거가 없어 하나씩 센다
    (지금 스키마에서 두 표의 user_id 는 NOT NULL 이라 실제로는 생기지 않는다).
    """
    keys: dict[str, set] = {"current": set(), "previous": set()}
    for index, row in enumerate(rows):
        ts = _parse_iso(row.get(ts_key))
        period = window.period_of(ts)
        if period is None:
            continue
        user_id = row.get("user_id")
        owner = str(user_id) if user_id is not None else f"row:{index}"
        keys[period].add((owner, ts.astimezone(_KST).date()))
    return _metric(
        len(keys["current"]),
        len(keys["previous"]),
        people=len({owner for owner, _day in keys["current"]}),
    )


def _is_store_arrival(row: dict, facility_id: str) -> bool:
    """outcome 행이 이 가게 추천의 도착인가. 끼워 온 recommendations 한 행으로 판정한다
    (PostgREST 는 다대일 임베드를 객체로 주지만, 목록으로 와도 받는다)."""
    embedded = row.get("recommendations")
    if isinstance(embedded, list):
        embedded = embedded[0] if embedded else None
    if not isinstance(embedded, dict):
        return False
    target = str(embedded.get("recommended_facility_id") or "").lower()
    return target == str(facility_id).lower() and embedded.get("source") != _BROWSE_SOURCE


async def _arrival_rows(facility_id: str, window: _StatsWindow) -> list[dict] | None:
    """이 가게 추천으로 도착이 확인된 방문 행. 못 읽으면 None — 성적표 전체를 실패시키지 않는다
    (도착은 예전에 없던 칸이라, 이것 하나 때문에 나머지 숫자까지 잃을 이유가 없다)."""
    try:
        return await _fetch_stats_rows(
            "recommendation_outcomes",
            "recommendation_id, user_id, arrival_confirmed_at, "
            "recommendations!inner(recommended_facility_id, source)",
            lambda q: q.eq("recommendations.recommended_facility_id", facility_id)
            .gte("arrival_confirmed_at", window.previous_since.isoformat())
            .order("recommendation_id"),
        )
    except Exception as e:
        logger.warning("merchant_stats_arrivals_unavailable", facility_id=facility_id, error=str(e))
        return None


async def _card_exposures(facility_id: str, window: _StatsWindow) -> dict | None:
    """손님 화면에 추천 카드로 그려진 횟수(rec_shown). 못 읽거나 기록이 한 번도 없으면 None(행 수로 물러선다)."""
    try:
        first_res, rows = await asyncio.gather(
            # 기록 시작 시각 — (event, created_at) 인덱스로 한 행만 본다.
            asyncio.to_thread(
                supabase_admin.table("usage_events")
                .select("created_at")
                .eq("event", _CARD_SHOWN_EVENT)
                .order("created_at")
                .limit(1)
                .execute
            ),
            _fetch_stats_rows(
                "usage_events",
                "id, anon_id, created_at, rank:props->>rank",
                lambda q: q.eq("event", _CARD_SHOWN_EVENT)
                .eq("props->>facility_id", facility_id)
                .gte("created_at", window.previous_since.isoformat())
                .order("id"),
            ),
        )
    except Exception as e:
        logger.warning("merchant_stats_card_exposures_unavailable", facility_id=facility_id, error=str(e))
        return None

    first = (first_res.data or [None])[0] or {}
    tracking_since = _parse_iso(first.get("created_at"))
    if tracking_since is None:
        # 표는 있는데 카드 기록이 한 번도 없다 — 기록이 꺼진 배포다. 0 을 '아무도 안 봤다' 로 읽히게 두지 않는다.
        return None

    counts = {"current": 0, "previous": 0}
    viewers: set[str] = set()
    for row in rows:
        if row.get("rank") is None:
            continue  # 검색·링크로 직접 연 카드 — 추천 노출이 아니다.
        period = window.period_of(row.get("created_at"))
        if period is None:
            continue
        counts[period] += 1
        if period == "current" and row.get("anon_id"):
            viewers.add(str(row["anon_id"]))

    metric = _metric(
        counts["current"],
        counts["previous"] if tracking_since <= window.previous_since else None,
        people=len(viewers),
        counted_since=tracking_since.isoformat() if tracking_since > window.since else None,
    )
    return {**metric, "basis": _EXPOSURE_BASIS_CARD}


async def _list_row_exposures(facility_id: str, window: _StatsWindow, internal_ids: frozenset[str]) -> dict:
    """물러선 노출 — 이 가게가 계산된 추천 목록에 들어간 행 수. 화면에 보였는지는 이 숫자로 알 수 없다."""
    rows = await _fetch_stats_rows(
        "recommendations",
        # score_breakdown 은 통째로 읽지 않는다(행마다 수십 바이트 JSON) — 목록에서 왔는지만 본다.
        "id, user_id, created_at, source, travel_time:score_breakdown->travel_time",
        lambda q: q.eq("recommended_facility_id", facility_id)
        .neq("source", _BROWSE_SOURCE)
        .gte("created_at", window.previous_since.isoformat())
        .order("id"),
    )
    counts = {"current": 0, "previous": 0}
    users: set[str] = set()
    for row in rows:
        if row.get("source") == _BROWSE_SOURCE or row.get("travel_time") is None:
            continue  # '관심 없음' 행 · 예전 수락 행(빈 score_breakdown) — 목록에 들어간 기록이 아니다.
        if _is_internal(row.get("user_id"), internal_ids):
            continue
        period = window.period_of(row.get("created_at"))
        if period is None:
            continue
        counts[period] += 1
        if period == "current" and row.get("user_id") is not None:
            users.add(str(row["user_id"]))
    return {**_metric(counts["current"], counts["previous"], people=len(users)), "basis": _EXPOSURE_BASIS_ROWS}


@router.get("/stats")
async def get_stats(
    facility_id: str,
    days: int = Query(_STATS_WINDOW_DAYS, description="집계 기간(일) — 7 또는 30"),
    ctx: dict = Depends(merchant_context),
):
    assert_owns(ctx, facility_id)
    # Literal[7, 30] 은 쿼리 문자열 '7' 을 받지 못한다(pydantic v2 리터럴은 형 변환을 하지 않는다) — 직접 본다.
    if days not in _STATS_WINDOW_CHOICES:
        raise HTTPException(status_code=422, detail="집계 기간은 7일 또는 30일만 고를 수 있습니다.")
    window = _StatsWindow(days, datetime.now(timezone.utc))
    previous_since = window.previous_since.isoformat()
    try:
        internal_ids, coupons, reports, accepted, arrival_rows, card_exposures = await asyncio.gather(
            _internal_user_ids(),
            _fetch_stats_rows(
                "user_coupons",
                "id, user_id, status, issued_at",
                lambda q: q.eq("facility_id", facility_id).gte("issued_at", previous_since).order("id"),
            ),
            _fetch_stats_rows(
                "congestion_logs",
                "id, reporter_user_id, timestamp",
                lambda q: q.eq("facility_id", facility_id)
                .eq("source", "user_report")
                .gte("timestamp", previous_since)
                .order("id"),
            ),
            _fetch_stats_rows(
                "recommendations",
                "id, user_id, created_at, accepted, source",
                lambda q: q.eq("recommended_facility_id", facility_id)
                .eq("accepted", True)
                .neq("source", _BROWSE_SOURCE)
                .gte("created_at", previous_since)
                .order("id"),
            ),
            _arrival_rows(facility_id, window),
            _card_exposures(facility_id, window),
        )
        exposures = card_exposures or await _list_row_exposures(facility_id, window, internal_ids)
    except Exception as e:
        logger.error("merchant_stats_fetch_failed", facility_id=facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="성적표 집계에 실패했습니다.")

    # 조건은 쿼리가 이미 걸었지만 여기서도 한 번 더 본다 — 이 숫자는 사장님이 돈(쿠폰)을 걸고 읽는 숫자라,
    # 필터 하나가 빠진 응답이 내부 계정·'관심 없음' 기록을 실적으로 섞어 넣지 않게 한다.
    customer_coupons = [r for r in coupons if not _is_internal(r.get("user_id"), internal_ids)]
    coupons_issued = _period_counts(customer_coupons, "issued_at", window)
    coupons_used = _period_counts(
        [r for r in customer_coupons if r.get("status") == "used"], "issued_at", window
    )
    congestion_reports = _period_counts(
        [r for r in reports if not _is_internal(r.get("reporter_user_id"), internal_ids)], "timestamp", window
    )
    accepts = _person_day_counts(
        [
            r for r in accepted
            if r.get("accepted") is True
            and r.get("source") != _BROWSE_SOURCE
            and not _is_internal(r.get("user_id"), internal_ids)
        ],
        "created_at",
        window,
    )
    if arrival_rows is None:
        arrivals = _metric(None, None)
        arrivals_note = "도착 확인 기록을 지금 불러오지 못했습니다."
    else:
        arrivals = _person_day_counts(
            [
                r for r in arrival_rows
                if _is_store_arrival(r, facility_id) and not _is_internal(r.get("user_id"), internal_ids)
            ],
            "arrival_confirmed_at",
            window,
        )
        arrivals_note = (
            "추천을 보고 길안내를 시작한 손님이 앱에서 도착을 확인한 방문입니다. "
            "같은 손님의 같은 날 방문은 한 번으로 셉니다."
        )

    return {
        # ── 예전 칸(이름·형 불변 — 구 화면이 그대로 읽는다). 값은 '이번 기간' 이다.
        "facility_id": facility_id,
        "since": window.since.isoformat(),
        "window_days": days,
        "coupons_issued": coupons_issued["current"],
        "coupons_used": coupons_used["current"],
        "congestion_reports": congestion_reports["current"],
        # 구 화면은 이 칸을 '손님 추천에 노출' 로 읽는다 — 기준이 무엇인지는 exposure_basis 가 말한다.
        "recommendations_exposed": exposures["current"],
        "recommendations_accepted": accepts["current"],
        "visit_confirmations": arrivals["current"],
        "visit_confirmations_note": arrivals_note,
        # ── 추가 칸
        "until": window.until.isoformat(),
        "previous_since": window.previous_since.isoformat(),
        "exposure_basis": exposures["basis"],
        "internal_accounts_excluded": True,
        # 지표마다 {current, previous, people, counted_since}. previous=None 은 '비교할 수 없음'(0 이 아니다),
        # people 은 이번 기간 숫자를 만든 사람 수(표본). 무엇으로 세는지는 지표마다 다르다 — 카드 기준 노출은 익명
        # 기기(usage_events.anon_id), 목록 행 기준 노출·길안내·도착은 계정(users.id — 관광객 게스트 세션 포함)이다.
        "metrics": {
            "exposures": exposures,
            "accepts": accepts,
            "arrivals": arrivals,
            "coupons_issued": coupons_issued,
            "coupons_used": coupons_used,
            "congestion_reports": congestion_reports,
        },
    }


# =========================================================================
# 오늘의 실행 브리핑 — GET /api/v1/merchant/briefing?facility_id=  (P1-5)
# 서버가 '앞으로 6시간' 예측 창의 최저 혼잡 시간대(golden-hour 앵커링 산식 재사용, argmin 은
# 서버)와 활성 타임세일 현황을 사실로 수집하고, Solar 는 한국어 2~3문장 프로즈만 생성한다.
# 게이트/캐시/폴백 규칙은 merchant_briefing_service 가 보유한다. 어떤 실패든 briefing=None
# 으로 강등된다. 그때 프런트는 이 카드 대신 성적표 숫자로 만든 요약(LLM 없음)을 그 자리에 그리고,
# 요약할 숫자도 없으면 아무것도 그리지 않는다(lib/merchant/scorecard.ts scorecardSummary). 이 엔드포인트는 읽기 전용 —
# 타임세일 발행 등 어떤 실행 동작도 하지 않는다(실행 결정은 사람 몫, SOLAR_LLM_EXPANSION §4-④).
# =========================================================================


@router.get("/briefing")
async def get_briefing(facility_id: str, ctx: dict = Depends(merchant_context)):
    assert_owns(ctx, facility_id)
    """오늘의 실행 브리핑 — { briefing: str|null, llmStatus }.

    캐시(facility+KST 시간 버킷, 성공 30분/실패 1분) 히트 시 예측·DB 조회 없이 즉시 반환한다.
    미스면 시설 존재·타입을 확인(golden-hour 의 단건 조회 패턴 미러)한 뒤 브리핑을 생성한다.
    """
    cached = merchant_briefing_service.cached_briefing(facility_id)
    if cached is not None:
        return cached

    try:
        res = await asyncio.to_thread(
            supabase_admin.table("facilities").select("id, type").eq("id", facility_id).limit(1).execute
        )
    except Exception as e:
        logger.error("merchant_briefing_facility_lookup_failed", facility_id=facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="브리핑 생성에 실패했습니다.")
    if not res.data:
        raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.")

    return await merchant_briefing_service.generate_briefing(facility_id, res.data[0]["type"])


# =========================================================================
# 셀프 타임세일 — POST /timesale(발행) · GET /timesale(활성 목록) · POST /timesale/cancel(취소)
# 발행/취소는 merchant_timesales 테이블에 반영되고, merchant_boost 오버레이를 통해 추천 랭킹의
# 인센티브 항에 실반영된다(모듈 상단 '추천 랭킹 반영 범위' 참조 — score.py 자체는 무변경).
# ⚠️ 동시 활성 세일: 발행을 막지 않는다(기존 동작 유지). 다만 오버레이가 활성 세일 중 **최댓값**
#   rate 만 쓰므로, 방금 발행한 세일이 곧바로 적용되지 않을 수 있다 — 응답에 실제 적용 할인율을
#   함께 실어 프런트가 사장님에게 안내하게 한다(아래 _active_timesale_rates 참조).
#   소비처(2026-09-06 확인): apps/web/lib/merchant/api.ts 의 timesalePublishNotice() 가 이 세
#   필드를 읽고, dashboard/page.tsx 의 TimesaleSection 이 발행 토스트 + 인라인 안내로 띄운다.
#   ⚠️ 그전까지 프런트는 이 필드를 **한 번도 읽지 않았다** — 이 주석이 거짓이었다. 필드를
#   지우거나 이름을 바꾸면 저 두 곳도 함께 고칠 것(안 그러면 다시 거짓말이 된다).
# =========================================================================


class TimesaleCreate(BaseModel):
    facility_id: str
    rate: Literal[0.15, 0.20, 0.30] = Field(description="타임세일 할인율(15/20/30% 중 하나)")
    duration_minutes: Literal[60, 120, 180] = Field(description="지속 시간(분) — 1/2/3시간 중 하나")


class TimesaleCancel(BaseModel):
    id: str
    facility_id: str


async def _facility_exists(facility_id: str) -> bool:
    res = await asyncio.to_thread(
        supabase_admin.table("facilities").select("id").eq("id", facility_id).limit(1).execute
    )
    return bool(res.data)


async def _active_timesale_rates(facility_id: str) -> list[float] | None:
    """지금 이 순간 추천에 반영되는 활성 세일들의 rate 목록. 조회 실패 시 None(=알 수 없음).

    필터는 merchant_boost._apply_timesale_boost 와 **동일하게** 맞춘다(canceled_at is null,
    starts_at <= now <= ends_at) — 여기서 계산한 '적용 할인율' 이 실제 랭킹 반영값과 어긋나면
    안내 자체가 거짓말이 되기 때문이다. GET /timesale(목록)은 starts_at 을 보지 않지만,
    이 함수의 목적은 '표시' 가 아니라 '실적용 예측' 이므로 오버레이 기준을 따른다.
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("merchant_timesales")
            .select("rate, starts_at, ends_at, canceled_at")
            .eq("facility_id", facility_id)
            .is_("canceled_at", "null")
            .lte("starts_at", now_iso)
            .gte("ends_at", now_iso)
            .execute
        )
    except Exception as e:
        # 안내용 부가 정보일 뿐 — 발행 자체를 실패시키지 않는다(무해 폴백, 아래 None 처리).
        logger.warning("merchant_timesale_active_lookup_failed", facility_id=facility_id, error=str(e))
        return None

    rates: list[float] = []
    for row in res.data or []:
        try:
            rate = row.get("rate")
            if rate is not None:
                rates.append(float(rate))
        except (TypeError, ValueError):
            continue
    return rates


@router.post("/timesale")
async def create_timesale(req: TimesaleCreate, ctx: dict = Depends(merchant_context)):
    assert_owns(ctx, req.facility_id)
    """타임세일 발행 — 유령 세일 방지를 위해 시설 존재를 먼저 검증한다(admin 혼잡 override 패턴 미러)."""
    try:
        exists = await _facility_exists(req.facility_id)
    except Exception as e:
        logger.error("merchant_timesale_facility_lookup_failed", error=str(e))
        raise HTTPException(status_code=500, detail="타임세일 발행에 실패했습니다.")
    if not exists:
        raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.")

    # 발행 '전' 스냅샷 — 방금 만든 세일이 집계에 섞이지 않게 insert 앞에서 읽는다.
    prior_rates = await _active_timesale_rates(req.facility_id)

    now = datetime.now(timezone.utc)
    ends_at = now + timedelta(minutes=req.duration_minutes)
    row = {
        "facility_id": req.facility_id,
        "rate": req.rate,
        "starts_at": now.isoformat(),
        "ends_at": ends_at.isoformat(),
    }
    try:
        ins = await asyncio.to_thread(supabase_admin.table("merchant_timesales").insert(row).execute)
        if not ins.data:
            raise HTTPException(status_code=500, detail="타임세일 발행에 실패했습니다.")
    except HTTPException:
        raise
    except Exception as e:
        # 마이그레이션 미적용 환경(테이블 부재)도 여기로 흡수된다 — 프런트는 일반 실패로 취급한다.
        logger.error("merchant_timesale_create_failed", facility_id=req.facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="타임세일 발행에 실패했습니다.")
    # 타임세일은 아직 지도 스냅샷에 없다(추천이 옮겨 오는 P3 에서 붙는다) — 알림 자리만 미리 둔다.
    reference_snapshot.mark_dirty("timesales")

    logger.info(
        "merchant_timesale_created", facility_id=req.facility_id,
        rate=req.rate, duration_minutes=req.duration_minutes,
    )

    # 중복 활성 세일 안내(감사 P1-7) — 발행을 막지는 않되, 오버레이가 '최댓값만' 쓴다는 사실을
    # 응답에 실어 사장님이 어떤 할인율이 실제로 적용되는지 알 수 있게 한다.
    # 조회 실패(prior_rates is None)면 지어내지 않고 None 을 그대로 준다(프런트는 안내 생략).
    created = dict(ins.data[0])
    if prior_rates is None:
        created["other_active_timesale_count"] = None
        created["effective_timesale_rate"] = None
        created["effective_timesale_note"] = None
    else:
        effective = max([*prior_rates, req.rate])
        created["other_active_timesale_count"] = len(prior_rates)
        created["effective_timesale_rate"] = effective
        created["effective_timesale_note"] = (
            None
            if not prior_rates
            else (
                f"이미 진행 중인 타임세일이 {len(prior_rates)}건 있습니다. "
                f"추천에는 활성 세일 중 가장 높은 할인율인 {round(effective * 100)}% 가 적용됩니다."
                + (
                    ""
                    if effective == req.rate
                    else f" 방금 발행한 {round(req.rate * 100)}% 는 더 높은 세일이 끝난 뒤 적용됩니다."
                )
            )
        )
    return created


@router.get("/timesale")
async def list_active_timesales(facility_id: str, ctx: dict = Depends(merchant_context)):
    assert_owns(ctx, facility_id)
    """활성(미취소·미만료) 타임세일 목록 — created_at 최신순."""
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("merchant_timesales")
            .select("*")
            .eq("facility_id", facility_id)
            .is_("canceled_at", "null")
            .gt("ends_at", now_iso)
            .order("created_at", desc=True)
            .execute
        )
    except Exception as e:
        logger.error("merchant_timesale_list_failed", facility_id=facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="타임세일 목록 조회에 실패했습니다.")
    return res.data or []


@router.post("/timesale/cancel")
async def cancel_timesale(req: TimesaleCancel, ctx: dict = Depends(merchant_context)):
    assert_owns(ctx, req.facility_id)
    """타임세일 취소 — id+facility_id 일치 행만 canceled_at 을 채운다(타 시설 세일 오취소 방지)."""
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("merchant_timesales")
            .update({"canceled_at": datetime.now(timezone.utc).isoformat()})
            .eq("id", req.id)
            .eq("facility_id", req.facility_id)
            .execute
        )
    except Exception as e:
        logger.error("merchant_timesale_cancel_failed", timesale_id=req.id, error=str(e))
        raise HTTPException(status_code=500, detail="타임세일 취소에 실패했습니다.")
    if not res.data:
        raise HTTPException(status_code=404, detail="해당 타임세일을 찾을 수 없습니다.")
    reference_snapshot.mark_dirty("timesales")
    logger.info("merchant_timesale_canceled", timesale_id=req.id, facility_id=req.facility_id)
    return res.data[0]


# =========================================================================
# 좌석 상태 방송 — POST /seat-status
# facilities.features(jsonb) 에 seat_status:{level, updated_at} 을 병합 저장한다(신규 컬럼/마이그레이션 불필요).
# 추천 랭킹에는 **30분 이내 신선한 값만** 반영된다(merchant_boost.SEAT_STATUS_FRESH_MINUTES).
# level=null 이면 해제 — features 에서 seat_status 키를 통째로 제거한다(타임스탬프가 그 안에
# 중첩돼 있어 별도 정리 대상은 없다). 사장님이 "지금은 모르겠다" 로 되돌릴 수 있어야,
# 오래된 방송이 30분간 랭킹에 남는 상황을 스스로 끊을 수 있다.
# 쓰기는 두 번이고 **주 효과는 facilities 갱신 하나뿐**이다(congestion_logs 관측은 부수 효과) —
# 둘을 한 트랜잭션으로 묶을 수 없어서 생기는 문제와 그 판단 근거는 아래 함수 본문 주석 참조.
#
# ⚠️ 관측(②)에는 **빈도 제한**이 걸려 있다. 방송(①) 자체는 언제든 되지만, 같은 버튼을 N번
#    누른다고 evidence_tier='verified' 학습 정답이 N줄 쌓이지는 않는다 — 아래
#    _SEAT_OBSERVATION_MIN_INTERVAL_MINUTES 와 _seat_observation_decision 참조.
# =========================================================================


# 좌석 방송이 **시계열 관측으로 남는** 최소 간격(분).
#
# 왜 이 값인가: 좌석 상태의 추천 반영 창이 30분이다(merchant_boost.SEAT_STATUS_FRESH_MINUTES).
# 10분이면 그 한 창 안에 최대 3번까지 관측이 남는다 — 점심 피크처럼 실제로 상태가 바뀌는
# 구간의 변화를 놓치지 않으면서, 연타가 학습 정답을 부풀리지는 못하는 선이다.
# (반대로 30분으로 잡으면 창 안의 변화가 통째로 기록되지 않고, 1분으로 잡으면 제한이 없는 것과
#  같다.)
#
# ⚠️ 이 간격은 **방송을 막지 않는다.** facilities.features.seat_status 는 매번 갱신되므로
#    누를 때마다 손님 화면과 추천 반영 창(30분)은 실제로 새로 시작한다. 막는 것은 오직
#    congestion_logs 행이 중복으로 쌓이는 것뿐이다 — 눌러도 아무 일도 없는 버튼을 만들지
#    않기 위한 구분이고, 남은 시간은 응답에 실어 화면이 그대로 말하게 한다.
_SEAT_OBSERVATION_MIN_INTERVAL_MINUTES = 10
_SEAT_OBSERVATION_MIN_INTERVAL_SECONDS = _SEAT_OBSERVATION_MIN_INTERVAL_MINUTES * 60

# 좌석 방송이 congestion_logs 에 남길 때 쓰는 source. 직전 관측을 되찾을 때도 같은 값으로
# 좁힌다 — 손님 제보(user_report)까지 세면 사장님 방송과 무관한 행이 간격 판정을 좌우한다.
_SEAT_OBSERVATION_SOURCE = "merchant_report"


def _parse_iso(value) -> datetime | None:
    """DB 가 준 타임스탬프 문자열 → aware UTC datetime. 못 읽으면 None."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


async def _last_seat_observation(facility_id: str) -> dict | None:
    """이 가게의 직전 좌석 방송 관측 1행(없거나 조회 실패면 None).

    조회가 실패해도 방송을 실패시키지 않고 None 을 준다 — 그러면 아래 판정이 '기록한다' 로
    가는데, 이는 의도한 fail-open 이다. congestion_logs 를 못 읽는 상황이면 이어지는 insert 도
    같이 실패해 observation_logged=False 로 정직하게 보고된다. 반대로 fail-closed 로 잡으면
    일시적 조회 실패가 **멀쩡한 현장 관측을 조용히 버리는** 쪽으로 작동한다.
    """
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("congestion_logs")
            .select("timestamp, congestion_level")
            .eq("facility_id", facility_id)
            .eq("source", _SEAT_OBSERVATION_SOURCE)
            .order("timestamp", desc=True)
            .limit(1)
            .execute
        )
    except Exception as e:
        logger.warning("merchant_seat_status_last_log_lookup_failed", facility_id=facility_id, error=str(e))
        return None
    return (res.data or [None])[0]


def _seat_observation_decision(
    previous: dict | None, level_value: float, now: datetime
) -> tuple[str, int | None]:
    """이번 방송을 시계열 관측으로 남길지 정한다 → (판정, 다음 기록까지 남은 초).

    판정은 셋 중 하나다.
      · "log"       — 남긴다.
      · "unchanged" — 직전 관측과 값이 같다. **간격과 무관하게** 남기지 않는다. 같은 사실을
                      두 번 적는 것일 뿐이고, 학습 정답에서는 그 중복이 곧 가중치가 된다.
                      (남은 시간을 주지 않는다 — 기다린다고 기록되는 게 아니라 값이 바뀌어야
                       기록되기 때문이다. 없는 카운트다운을 보여주면 그것도 거짓말이다.)
      · "throttled" — 값은 다른데 직전 기록이 너무 최근이다. 남은 초를 함께 준다.
    """
    if previous is None:
        return "log", None
    previous_level = previous.get("congestion_level")
    if previous_level is not None:
        try:
            # 좌석 등급은 SEAT_LEVEL_CONGESTION 의 고정 3값이지만, DB 를 왕복하며 numeric →
            # float 로 오므로 정확히 같은지는 부동소수 오차를 감안해 본다.
            if math.isclose(float(previous_level), level_value, abs_tol=1e-9):
                return "unchanged", None
        except (TypeError, ValueError):
            pass  # 값을 못 읽으면 '같다' 고 단정하지 않는다 — 관측을 버리는 쪽으로 기울지 않는다.
    previous_at = _parse_iso(previous.get("timestamp"))
    if previous_at is None:
        # 직전 시각을 못 읽으면 간격을 판정할 수 없다. 판정 불가를 '차단' 으로 읽지 않는다.
        return "log", None
    elapsed = (now - previous_at).total_seconds()
    if elapsed >= _SEAT_OBSERVATION_MIN_INTERVAL_SECONDS:
        return "log", None
    # elapsed 가 음수(시계 어긋남)여도 간격 이상으로 부풀리지 않는다 — 최대치는 간격 그 자체다.
    remaining = min(
        _SEAT_OBSERVATION_MIN_INTERVAL_SECONDS,
        math.ceil(_SEAT_OBSERVATION_MIN_INTERVAL_SECONDS - elapsed),
    )
    return "throttled", max(1, remaining)


class SeatStatusUpdate(BaseModel):
    facility_id: str
    # None 은 '해제' 를 뜻한다. 기본값을 두지 않아 필드 자체가 필수 — 바디 누락/오타로 실수로
    # 해제되는 일이 없게, 해제하려면 level:null 을 명시적으로 보내야 한다.
    level: Literal["low", "mid", "full"] | None = Field(
        description="여유(low)/보통(mid)/만석(full), null 이면 좌석 상태 해제"
    )


@router.post("/seat-status")
async def update_seat_status(req: SeatStatusUpdate, ctx: dict = Depends(merchant_context)):
    assert_owns(ctx, req.facility_id)
    try:
        fac_res = await asyncio.to_thread(
            supabase_admin.table("facilities").select("id, features, capacity").eq("id", req.facility_id).limit(1).execute
        )
    except Exception as e:
        logger.error("merchant_seat_status_lookup_failed", facility_id=req.facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="좌석 상태 갱신에 실패했습니다.")
    if not fac_res.data:
        raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.")

    current_features = fac_res.data[0].get("features") or {}
    if not isinstance(current_features, dict):
        current_features = {}
    updated_at = datetime.now(timezone.utc).isoformat()
    if req.level is None:
        # 해제 — features 의 다른 키(average_processing_time 등)는 보존하고 seat_status 만 뺀다.
        new_features = {k: v for k, v in current_features.items() if k != "seat_status"}
    else:
        new_features = {**current_features, "seat_status": {"level": req.level, "updated_at": updated_at}}

    # ── 주 효과(①): 화면에 보이는 좌석 상태. 이게 실패하면 방송 자체가 실패다 → 500.
    try:
        upd = await asyncio.to_thread(
            supabase_admin.table("facilities").update({"features": new_features}).eq("id", req.facility_id).execute
        )
        if not upd.data:
            raise HTTPException(status_code=500, detail="좌석 상태 갱신에 실패했습니다.")
    except HTTPException:
        raise
    except Exception as e:
        logger.error("merchant_seat_status_update_failed", facility_id=req.facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="좌석 상태 갱신에 실패했습니다.")
    # 좌석 상태는 facilities.features 안에 있다 — 지도 참조 스냅샷의 시설 베이스를 다시 읽게 한다.
    reference_snapshot.mark_dirty("facilities")

    # ── 부수 효과(②): 시계열 관측 1행. 여기부터는 **어떤 실패도 500 이 아니다.**
    #
    # [왜 이렇게 나눴나 — 2026-09 감사 P1]
    # 예전에는 ①②를 한 try 로 묶어, ②가 깨지면 except 가 500 "좌석 상태 갱신에 실패했습니다" 를
    # 던졌다. 그런데 ①은 이미 커밋된 뒤였다(두 테이블에 걸친 트랜잭션이 없다 — PostgREST 를
    # 통해 각각 별개 요청으로 나간다). 결과는 최악의 조합이었다: 손님 화면의 좌석 상태는 바뀌어
    # 있는데 사장님 화면은 '실패' 라고 말한다. 사장님은 다시 누르고, 또 절반만 되고, 시계열
    # 관측만 계속 빠진다. **틀린 실패 보고가 옳은 성공 보고보다 나쁘다** — 사장님이 사실과
    # 다른 상태를 믿고 행동하게 만들기 때문이다.
    #
    # 그래서 '주 효과' 를 ①로 정했다. 사장님이 이 버튼으로 하려는 일은 **지금 우리 가게 상태를
    # 방송하는 것**이고, ②는 그 방송에서 파생된 기록이다. ①이 성공했으면 방송은 실제로 일어났고,
    # ②의 실패는 그것을 취소할 이유가 못 된다. 게다가 되돌릴 수단도 없다 — 보상 update 를 쏘면
    # 그 자체가 또 실패할 수 있고, 그 사이 들어온 다른 갱신을 덮어쓴다.
    #
    # 순서를 뒤집어 ②를 먼저 쓰는 안(떠도는 관측 1행은 무해하다)은 택하지 않았다. 그러면 ②가
    # 성공하고 ①이 실패했을 때 사장님의 본래 목적(방송)만 통째로 실패하고, 재시도할 때마다
    # evidence_tier='verified' 관측이 중복으로 쌓인다 — 학습 정답에 같은 시각의 같은 제보가
    # 여러 번 들어가는 편이 관측 1건이 빠지는 것보다 나쁘다고 봤다.
    #
    # 대신 **조용히 삼키지 않는다**: 실패 사실을 응답에 실어 사장님에게 그대로 전한다
    # (이 저장소 원칙 — 실패를 '없음' 과 같은 값으로 표현하지 않는다).
    #   observation_logged: True=기록됨 / False=기록 실패 / None=해당 없음(해제·의도적 생략)
    #
    # observation_logged 만으로는 '실패' 와 '일부러 안 남김' 을 구분할 수 없어서
    # observation_status 를 함께 준다. False 는 **진짜 실패에만** 쓴다 — 빈도 제한으로 건너뛴
    # 것을 False 로 주면 프런트가 장애 문구를 띄우고, 사장님은 멀쩡한 방송을 실패로 읽는다.
    #   observation_status: logged / failed / throttled / unchanged / not_applicable
    observation_logged: bool | None = None
    observation_note: str | None = None
    observation_status = "not_applicable"
    # 다음 관측이 남을 때까지 남은 초. **서버가 계산해서 준다** — 클라이언트 절대시계를 믿고
    # 화면에서 빼면, 단말 시계가 어긋난 사장님에게는 없는 대기 시간이 보이거나 그 반대가 된다.
    next_observation_in_seconds: int | None = None
    if req.level is not None:
        normalized_level = SEAT_LEVEL_CONGESTION[req.level]
        # 빈도 제한(감사 10번) — 방송은 이미 위에서 반영됐다. 여기서 거르는 것은 학습 정답으로
        # 들어가는 congestion_logs 행뿐이다.
        previous = await _last_seat_observation(req.facility_id)
        observation_status, next_observation_in_seconds = _seat_observation_decision(
            previous, normalized_level, datetime.now(timezone.utc)
        )

        if observation_status == "log":
            # 화면용 최신 상태와 별개로 시계열 관측을 남긴다. 매장 운영자가 직접 확인한
            # 좌석 방송은 MVP의 가장 빠른 현장 관측이므로 공식 학습 가능한 verified 로 기록한다.
            try:
                capacity = int(fac_res.data[0].get("capacity") or 0)
                await asyncio.to_thread(
                    supabase_admin.table("congestion_logs").insert({
                        "facility_id": req.facility_id,
                        "timestamp": updated_at,
                        "current_count": round(capacity * normalized_level),
                        "congestion_level": normalized_level,
                        "source": _SEAT_OBSERVATION_SOURCE,
                        "evidence_tier": "verified",
                        # 누가 방송했는지 남긴다. 이 행은 evidence_tier='verified' 라 모델 학습에
                        # 들어가므로, 오염이 발견되면 출처를 되짚을 수 있어야 한다.
                        # 레거시 공유 토큰 경로는 사용자를 특정할 수 없어 NULL 이다.
                        "reporter_user_id": (ctx.get("profile") or {}).get("id"),
                    }).execute
                )
                # insert 결과가 비었는지는 보지 않는다 — PostgREST 의 returning 설정에 따라 정상
                # 성공에도 빈 배열이 올 수 있어, 그걸 실패로 읽으면 매 방송마다 거짓 경보가 된다.
                # 여기서 확실히 아는 실패는 '예외가 났다' 뿐이므로 그것만 False 로 보고한다.
                reference_snapshot.mark_dirty("congestion")
                observation_logged = True
                observation_status = "logged"
                # 방금 남겼으니 다음 기록 가능 시점은 정확히 한 간격 뒤다 — 화면이 카운트다운을
                # 띄울 수 있게 성공 시에도 남은 시간을 준다.
                next_observation_in_seconds = _SEAT_OBSERVATION_MIN_INTERVAL_SECONDS
            except Exception as e:
                logger.error("merchant_seat_status_log_failed", facility_id=req.facility_id, error=str(e))
                observation_logged = False
                observation_status = "failed"
                # 아무것도 못 남겼으니 다음 시도를 막을 근거도 없다 — 카운트다운을 주지 않는다.
                next_observation_in_seconds = None
                observation_note = (
                    "좌석 상태 방송은 정상 반영됐지만, 이 방송을 시계열 관측 기록으로 남기지 못했습니다. "
                    "손님 화면과 추천에는 지금 상태가 그대로 쓰입니다."
                )
        elif observation_status == "throttled":
            minutes_left = math.ceil((next_observation_in_seconds or 0) / 60)
            observation_note = (
                f"좌석 상태 방송은 정상 반영됐습니다(추천 반영 {SEAT_STATUS_FRESH_MINUTES}분 재시작). "
                f"다만 직전 관측 기록이 {_SEAT_OBSERVATION_MIN_INTERVAL_MINUTES}분 이내라 이번 방송은 "
                f"기록으로 남기지 않았습니다 — 약 {minutes_left}분 뒤에 다시 기록됩니다."
            )
        elif observation_status == "unchanged":
            observation_note = (
                f"좌석 상태 방송은 정상 반영됐습니다(추천 반영 {SEAT_STATUS_FRESH_MINUTES}분 재시작). "
                "직전 기록과 같은 상태라 관측 기록은 새로 남기지 않았습니다 — 상태가 바뀌면 다시 기록됩니다."
            )

    logger.info(
        "merchant_seat_status_cleared" if req.level is None else "merchant_seat_status_updated",
        facility_id=req.facility_id, level=req.level, observation_logged=observation_logged,
        observation_status=observation_status,
    )
    # 기존 5키는 그대로 두고(응답 봉투 불변) 판정·남은 시간만 덧붙인다 — 해제 시 level=None,
    # updated_at 은 '해제한 시각'.
    return {
        "facility_id": req.facility_id,
        "level": req.level,
        "updated_at": updated_at,
        "observation_logged": observation_logged,
        "observation_note": observation_note,
        "observation_status": observation_status,
        "next_observation_in_seconds": next_observation_in_seconds,
    }
