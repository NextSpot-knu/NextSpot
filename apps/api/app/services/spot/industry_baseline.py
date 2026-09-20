"""근거 없는 후보(``degraded_rules``)에 줄 **업종별 혼잡 기준선**.

왜 필요한가
------------
``ranking.py`` 의 근거 등급으로 '무근거 후보가 근거 있는 후보를 이기는' 구조적 하한은
사라진다. 하지만 **같은 degraded 등급 안에서는** 여전히 모든 후보의 대기 항이 0 이다.
그러면 점심시간의 식당과 카페가 똑같이 '대기 0분' 으로 묶여, 업종 차이가 순위에서
통째로 사라진다. 등급이 같으면 이동시간·취향·쿠폰만 남기 때문이다.

그래서 ``congestion_logs`` 의 **업종별 모집단 중앙 혼잡도**를 뽑아 준다. 이 값은 그 가게를
측정한 값이 아니라 '그 업종이 보통 이 정도' 라는 모집단 통계다. 그래서

  · breakdown 의 ``wait_time``/``ranking_wait_time`` 으로는 **절대 내보내지 않는다**
    (그 두 키는 "이 시설의 대기" 라는 뜻이다). 별도 키로만 적어 둔다.
  · 표본이 모자라면 **아예 주지 않는다.** 없는 값을 지어내지 않는다 — 그때는 등급만으로
    처리한다(무근거 후보끼리는 종전처럼 이동·취향·쿠폰으로 갈린다).

무엇을 모집단으로 세는가
------------------------
``congestion_evidence.TRUSTED_EVIDENCE_TIERS`` (= verified/corroborated) 인 로그만 센다.
이 저장소에서 '점수에 영향을 줘도 되는 관측' 의 정의가 이미 그거고(``rankable_measured_level``),
모델 학습의 정답 집합도 같다(``scripts/train.py::TRUSTED_TIERS``). 규칙을 여기서 새로 만들면
같은 표를 두 잣대로 읽게 된다. 부수 효과로 합성 시드(source='seed' → tier='synthetic')와
관리자 슬라이더 값(tier='single_report')이 자동으로 빠진다 — 둘 다 측정이 아니다.

⚠️ 2026-09-07 프로덕션 실측: congestion_logs 2,705행이 전부 single_report/synthetic 이라
   **신뢰 등급 행이 0건**이다. 즉 지금은 어떤 업종도 기준선을 받지 못하고, 등급 정렬만
   동작한다. 그게 정직한 결과다 — 여기서 single_report 까지 끌어다 쓰면 5개 가게의 일지를
   1,078개 식당의 업종 통계라고 부르는 셈이 된다.
"""

from __future__ import annotations

import asyncio
import statistics
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog

from app.core.supabase import fetch_all_rows, supabase_admin
from app.services.congestion_evidence import TRUSTED_EVIDENCE_TIERS
from app.services.predict_service import MIN_TYPE_COUNT, normalize_facility_type

logger = structlog.get_logger()

# 업종당 최소 관측 수. 모델 승격이 "이 업종을 말해도 되는가" 에 쓰는 하한과 같은 수를 쓴다
# (predict_service.MIN_TYPE_COUNT). 같은 표에서 같은 업종의 대표성을 말하는 숫자라 별도로
# 두면 둘이 조용히 갈라진다.
MIN_BASELINE_LOGS_PER_TYPE = MIN_TYPE_COUNT

# 업종당 최소 '서로 다른 가게' 수. 관측 수만 보면 부지런한 한 가게의 일지가 업종 통계가 된다.
# 중앙값이 업종을 말하려면 여러 가게에서 나와야 한다.
MIN_BASELINE_FACILITIES_PER_TYPE = 5

# 조회 주기. 모집단 중앙값은 하루 단위로도 거의 안 움직이지만, 새 제보가 반영되는 데
# 반나절씩 걸리면 확인이 어렵다. tourism_related_service 와 같은 1시간.
CACHE_TTL_SECONDS = 60 * 60.0
# 조회 실패는 '기준선 없음' 으로 강등하고 짧게 캐시한다 — 장애가 랭킹을 뒤집지 않게, 그리고
# 요청마다 죽은 상류를 다시 때리지 않게(parking_demand_service 의 _FAIL_TTL 과 같은 취급).
FAIL_TTL_SECONDS = 10 * 60.0

# (적재 시각, 이 항목의 TTL, 업종→중앙 혼잡도)
_cache: tuple[float, float, dict[str, float]] | None = None
_lock = asyncio.Lock()


def reset_cache() -> None:
    """테스트 격리용 — 모듈 캐시를 비운다(event_boost._cache 와 같은 취급)."""
    global _cache
    _cache = None


def _median_congestion_by_type(rows: list[dict[str, Any]]) -> dict[str, float]:
    """신뢰 등급 로그를 업종별 중앙 혼잡도로 접는다. 표본 미달 업종은 결과에 넣지 않는다."""
    levels: dict[str, list[float]] = {}
    facilities: dict[str, set[str]] = {}
    for row in rows:
        # PostgREST 임베드 결과: facilities(type) → {"facilities": {"type": ...}}.
        # 관계 판정에 따라 배열로 오기도 하므로 둘 다 받는다. 시설이 지워진 로그(임베드가
        # None/빈 배열)나 값이 깨진 행은 조용히 건너뛴다 — 통계 한 줄 때문에 랭킹을 멈추지 않는다.
        embedded = row.get("facilities")
        if isinstance(embedded, list):
            embedded = embedded[0] if embedded else None
        facility_type = (embedded or {}).get("type")
        try:
            level = float(row["congestion_level"])
        except (KeyError, TypeError, ValueError):
            continue
        if not facility_type or not 0.0 <= level <= 1.0:
            continue
        levels.setdefault(facility_type, []).append(level)
        facilities.setdefault(facility_type, set()).add(str(row.get("facility_id")))

    baseline: dict[str, float] = {}
    for facility_type, values in levels.items():
        if len(values) < MIN_BASELINE_LOGS_PER_TYPE:
            continue
        if len(facilities[facility_type]) < MIN_BASELINE_FACILITIES_PER_TYPE:
            continue
        baseline[facility_type] = float(statistics.median(values))
    return baseline


async def _load_baseline() -> dict[str, float]:
    """신뢰 등급 로그 전량을 받아 업종별 중앙 혼잡도를 만든다."""
    # PostgREST 는 단일 응답을 1000행에서 조용히 자른다. 잘린 앞부분만으로 낸 중앙값은
    # '전체 중앙값' 이 아니라 '삽입 순서 앞쪽의 중앙값' 이다 — 그건 통계가 아니라 사고다.
    # (2026-09-07 실측: congestion_logs 2,705행.)
    rows = await asyncio.to_thread(
        fetch_all_rows,
        supabase_admin,
        "congestion_logs",
        select="facility_id,congestion_level,facilities(type)",
        apply_filters=lambda query: query.in_("evidence_tier", sorted(TRUSTED_EVIDENCE_TIERS)),
    )
    return _median_congestion_by_type(rows)


async def get_industry_baseline_congestion(facility_type: str | None) -> float | None:
    """``facility_type`` 업종의 모집단 중앙 혼잡도. 표본이 모자라거나 조회가 실패하면 ``None``.

    분(minute)이 아니라 혼잡도를 돌려주는 이유: 혼잡도를 대기 분으로 바꾸는 곳은
    ``wait_time.calculate_predicted_wait_time`` 하나여야 한다. 후보 자신의 평균 처리시간
    (features.average_processing_time)과 도착 시각의 피크 배수가 거기 들어 있는데, 여기서
    분을 미리 만들어 버리면 그 두 가지를 이 파일이 다시 구현하게 된다.
    """
    global _cache
    if not facility_type:
        return None

    now = time.monotonic()
    if _cache and now - _cache[0] < _cache[1]:
        return _cache[2].get(facility_type)

    async with _lock:
        # 락을 기다리는 동안 다른 코루틴이 이미 채웠을 수 있다(이중 확인).
        now = time.monotonic()
        if _cache and now - _cache[0] < _cache[1]:
            return _cache[2].get(facility_type)
        try:
            baseline = await _load_baseline()
        except Exception as exc:
            # 상류 장애로 순위가 뒤집히면 안 된다 — '기준선 없음' 으로 강등한다.
            # 이건 등급 정렬(ranking.py)만 살아 있는 상태이고, 그게 이 기능의 기본값이다.
            logger.warning(
                "industry_baseline_unavailable",
                error=str(exc),
                error_type=type(exc).__name__,
            )
            _cache = (now, FAIL_TTL_SECONDS, {})
            return None
        _cache = (now, CACHE_TTL_SECONDS, baseline)
        return baseline.get(facility_type)


# ── 시각·요일 기반 예측 기준선(카드 표시 전용) ────────────────────────────────────
#
# 위 get_industry_baseline_congestion 은 **표본에서 뽑은 업종 중앙값**이라 (1) 시각·요일에
# 따라 움직이지 않고 (2) 신뢰 등급 로그가 0건인 현재 프로덕션에서는 전 업종 None 이다. 그래서
# 실측도 학습 모델도 추정도 없는 후보의 카드는 여전히 '혼잡 정보 준비 중' 으로 비어 보인다 —
# 특히 심사위원이 '가정 시각' 을 바꿔도 카드 혼잡이 그대로라 기능이 죽은 것처럼 보인다.
#
# 아래 값은 **이 시설을 측정한 값이 아니다.** 업종의 일반적인 하루 패턴(식사·오후·주간 피크)과
# 요일 효과를 코드로 옮긴 **휴리스틱 예측**이다. 그래서
#   · 호출부는 이 값을 오직 congestion_source='predicted'(화면 '예측' 라벨)로만 노출한다.
#     'measured' 로는 절대 쓰지 않는다 — '지금 이만큼 붐빈다는 관측' 을 지어내지 않는다.
#   · 순위(SPOT 점수)에는 들어가지 않는다. score.py 는 자기 예측/실측만 쓰고, 이 값은 카드
#     표시에서만 산다. 표본 기반 랭킹 기준선(get_industry_baseline_congestion, 표본 미달 시 None)
#     과 역할이 다르다 — 그쪽은 순위 시간비용용이라 값이 없으면 침묵하는 것이 옳고, 이쪽은
#     "이 업종이면 이 시각에 보통 이 정도" 라는 예측을 정직한 라벨로 보여 주는 것이 목적이다.
#   · KST 시각·요일에 따라 값이 **실제로 달라진다** — 가정 시각 시뮬레이터가 카드 혼잡을
#     움직이게 하는 것이 존재 이유다.

_KST = timezone(timedelta(hours=9))

# 업종별 '가장 붐비는 시각(주말 피크)' 의 예측 혼잡도(0..1).
_PREDICTED_PEAK_BY_TYPE = {
    "restaurant": 0.85,
    "cafe": 0.72,
    "attraction": 0.80,
    "culture": 0.62,
}
_PREDICTED_PEAK_DEFAULT = 0.68

# 업종별 KST 시각(0~23)의 피크 대비 비율(0..1). 심야·영업 외 시간은 0 근처, 업종별 피크가 다르다
# (식당=점심·저녁, 카페=오후, 관광지·문화=한낮).
_PREDICTED_HOUR_SHAPE = {
    "restaurant": (
        0.05, 0.04, 0.03, 0.03, 0.03, 0.04, 0.08, 0.15, 0.22, 0.28,
        0.40, 0.65, 1.00, 0.95, 0.55, 0.42, 0.45, 0.65, 0.95, 1.00,
        0.88, 0.60, 0.35, 0.15,
    ),
    "cafe": (
        0.05, 0.04, 0.03, 0.03, 0.03, 0.05, 0.10, 0.20, 0.32, 0.45,
        0.58, 0.68, 0.78, 0.88, 0.96, 1.00, 0.95, 0.85, 0.72, 0.60,
        0.48, 0.35, 0.22, 0.10,
    ),
    "attraction": (
        0.03, 0.02, 0.02, 0.02, 0.02, 0.03, 0.08, 0.18, 0.35, 0.55,
        0.72, 0.86, 0.92, 0.96, 1.00, 0.95, 0.82, 0.62, 0.42, 0.26,
        0.16, 0.09, 0.05, 0.03,
    ),
    "culture": (
        0.03, 0.02, 0.02, 0.02, 0.02, 0.03, 0.05, 0.12, 0.30, 0.52,
        0.72, 0.86, 0.92, 0.96, 1.00, 0.94, 0.78, 0.52, 0.22, 0.10,
        0.07, 0.05, 0.04, 0.03,
    ),
}
# 알 수 없는 업종의 기본 곡선(완만한 주간 피크).
_PREDICTED_HOUR_SHAPE_DEFAULT = (
    0.05, 0.04, 0.03, 0.03, 0.03, 0.05, 0.10, 0.20, 0.35, 0.50,
    0.62, 0.72, 0.80, 0.82, 0.80, 0.75, 0.68, 0.58, 0.48, 0.38,
    0.28, 0.20, 0.12, 0.07,
)

# 요일 효과(KST, 월=0 … 일=6). 주말이 가장 붐비고 평일이 한산하다.
_PREDICTED_WEEKDAY_FACTOR = (0.70, 0.70, 0.72, 0.75, 0.85, 1.00, 0.98)


def get_predicted_baseline_congestion(
    facility_type: str | None, now: datetime | None = None
) -> float | None:
    """업종·KST 시각·요일 기반 **예측** 혼잡도(0..1). 업종이 비어 있으면 ``None``.

    실측 로그·학습 모델·추정이 모두 없는 후보의 카드에 'AI 예측(예측)' 으로 보여줄 값이다.
    이 값은 이 시설을 측정한 것이 아니라 업종의 일반적 하루 패턴을 코드화한 휴리스틱 예측이라,
    호출부는 반드시 ``source='predicted'`` 로만 노출한다(모듈 상단 주석 참조). ``now`` 는 tz-aware
    datetime(가정 시각 또는 현재 UTC)이며 내부에서 KST 로 변환해 시각·요일을 읽는다 — 같은
    가게라도 심야와 점심, 평일과 주말에 값이 달라진다.
    """
    if not facility_type:
        return None
    moment = (now or datetime.now(timezone.utc)).astimezone(_KST)
    norm_type = normalize_facility_type(facility_type)
    peak = _PREDICTED_PEAK_BY_TYPE.get(norm_type, _PREDICTED_PEAK_DEFAULT)
    shape = _PREDICTED_HOUR_SHAPE.get(norm_type, _PREDICTED_HOUR_SHAPE_DEFAULT)
    weekday_factor = _PREDICTED_WEEKDAY_FACTOR[moment.weekday()]
    level = peak * shape[moment.hour] * weekday_factor
    return round(max(0.0, min(1.0, level)), 3)
