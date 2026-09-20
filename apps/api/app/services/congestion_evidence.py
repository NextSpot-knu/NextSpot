"""Rules for deciding which observed congestion may influence ranking.

추정(estimated) 근거도 이 파일이 다룬다 — 다만 **순위에 들어가는 문(rankable_measured_level)과는
완전히 분리된 옆문**으로만 붙는다. 이유는 아래 ``attach_estimate`` 주석 참조.

'지금' 판정(``measurement_is_current``)은 이 파일에만 있다. 추천·코스·지도 세 경로와 화면이 모두
이 한 함수의 결론(``is_current``)을 받아 쓴다 — 같은 판단을 각자 구현하면 갈라지기 때문이다.
"""
import asyncio
from datetime import datetime, timedelta, timezone

import structlog

logger = structlog.get_logger()

TRUSTED_EVIDENCE_TIERS = {"verified", "corroborated"}
RANKING_FRESHNESS = timedelta(minutes=30)

# 추정 근거의 source 값. congestion_estimator_service.ESTIMATE_SOURCE 와 같아야 한다
# (여기서 그 모듈을 최상단 import 하지 않는 이유는 load_current_estimates 주석 참조 —
#  테스트가 둘의 일치를 잠근다).
ESTIMATE_SOURCE = "estimated"

# 추천·지도 한 요청이 추정치를 기다리는 상한(초). 추정기는 5분 캐시라 거의 항상 즉시 돌아오고,
# 캐시가 빈 첫 요청만 DB 왕복(최신 스냅샷·주차장·시설 1,600여 곳·관광 통계)을 한다.
# 그 첫 요청이 추천 전체를 붙잡지 않게 상한을 두고, 넘기면 **이번 응답만 추정 없이** 나간다 —
# 계산은 shield 로 계속 돌아 캐시를 채우므로 다음 요청부터는 붙는다. 추정은 부가 정보다.
ESTIMATE_LOAD_TIMEOUT_SECONDS = 3.0


def _parse_timestamp(value: object) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def measurement_is_current(
    evidence_tier: object, timestamp: object, *, now: datetime | None = None
) -> bool:
    """이 관측이 **'지금' 을 말할 자격**이 있는가 — 신뢰 등급 × 30분. 저장소의 단 하나의 정의다.

    계획서 §5.2 의 "실측이 생기면 추정을 덮어쓴다" 는 *verified/corroborated · 30분 이내* 실측에만
    걸리는 문장이다. 그 조건을 여기 한 곳에 두고 세 소비자가 전부 이것만 부른다:
      · ``rankable_measured_level`` — 순위(measured_rules)에 들어갈 자격
      · ``evidence_is_current`` → ``attach_estimate`` — 추정이 자리를 비켜야 하는지
      · ``infrastructures`` 의 혼잡 info(``is_current``) — 지도 상세가 칠할 '지금' 값인지
    셋이 각자 판정하면 반드시 갈라진다(이 저장소는 같은 판단을 세 벌 복사해 이미 한 번 데였다).

    신선도 창을 24시간(``infrastructures._STALE_AFTER_HOURS``)이 아니라 30분으로 잡은 이유:
    24시간은 '이 값이 몹시 낡았다' 를 알리는 **경고선**이고(그래서 ``is_stale``), 30분은 '이 값이
    지금을 대표한다' 는 **주장선**이다. 한 달 전 관측은 is_stale 이 맞지만, 그 사이의 4시간짜리
    관측도 '지금' 은 아니다 — 사용자가 보는 문구도 이 30분 선으로 통일한다(card.lastObserved).
    """
    if evidence_tier not in TRUSTED_EVIDENCE_TIERS:
        return False
    parsed = _parse_timestamp(timestamp)
    if parsed is None:
        return False
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    age = current - parsed
    return timedelta(0) <= age <= RANKING_FRESHNESS


def rankable_measured_level(evidence: dict | None, *, now: datetime | None = None) -> float | None:
    """Return a measured level only when it is recent and independently trustworthy.

    ⚠️ 추정(``source='estimated'``)은 여기서 **절대 통과하지 않는다** — source 가 'measured' 인
    근거만 본다. 추정치는 evidence["estimate"] 옆 칸에만 실리고 evidence["source"]/["level"] 은
    원래 값 그대로 남으므로(추정이 붙은 낡은 실측도 source 는 'measured' 다) 이 함수·merchant 좌석
    오버라이드·대기 분 계산 어디에도 닿지 않는다. (추정이 순위에 닿는 곳은 딱 하나 — score.py 가
    area_stats_rules 후보의 붐빔 판정에 estimate 칸을 읽는다. 강등 전용.)
    """
    if not evidence or evidence.get("source") != "measured":
        return None
    if not measurement_is_current(
        evidence.get("evidence_tier"), evidence.get("timestamp"), now=now
    ):
        return None
    try:
        return max(0.0, min(1.0, float(evidence.get("level"))))
    except (TypeError, ValueError):
        return None


def evidence_is_current(evidence: dict | None, *, now: datetime | None = None) -> bool:
    """이 근거 dict 가 화면에 '지금' 으로 칠해져도 되는 값을 들고 있는가.

    · measured → 신뢰 등급 × 30분(``measurement_is_current``). 사장님 좌석 방송은 호출부가
      ``is_current=True`` 를 직접 찍어 이 함수를 타지 않는다(merchant_boost 가 이미 같은 30분 창을
      쓰는데, 그 판정과 이 판정 사이의 몇 초로 '방금 확인' 이 뒤집히면 안 되기 때문이다).
    · predicted → 언제나 True. 모델 예측은 '도착 시점' 을 계산한 값이고 승격 게이트를 통과해야만
      켜진다. 게다가 그 후보는 scoring_mode='model' 로 **그 숫자가 순위를 만든다** — 화면이 다른
      숫자(추정)를 보여 주면 "이 숫자 때문에 이 순위" 라는 설명이 어긋난다.
    · none → False. 채울 값이 없다는 뜻이고, 추정이 채우려던 자리가 바로 여기다.
    """
    if not evidence:
        return False
    source = evidence.get("source")
    if source == "predicted":
        return True
    if source != "measured":
        return False
    return measurement_is_current(
        evidence.get("evidence_tier"), evidence.get("timestamp"), now=now
    )


# ── 추정 모드(docs/CONGESTION_ENGINE_PLAN.md §5.2) ─────────────────────────────


async def load_current_estimates(
    *, timeout: float = ESTIMATE_LOAD_TIMEOUT_SECONDS
) -> dict | None:
    """지금의 시설별 추정 묶음. 쓸 수 없으면 ``None`` — **예외를 올리지 않는다.**

    추정기(congestion_estimator_service)를 함수 안에서 모듈째 부르는 이유 두 가지:
      · 이 파일은 score.py 가 import 한다. 추정기는 area_demand·parking_derived·관광 통계 서비스를
        끌고 오므로, 최상단에서 import 하면 채점 경로에 순환 import 위험을 들인다.
      · 테스트가 ``congestion_estimator_service.current_estimates`` 한 곳만 바꿔 끼우면 추천·코스·
        지도 세 경로가 모두 따라온다(conftest 의 기본 격리가 그 자리다).
    """
    from app.services import congestion_estimator_service as estimator

    try:
        current = await asyncio.wait_for(
            asyncio.shield(estimator.current_estimates()), timeout=timeout
        )
    except asyncio.TimeoutError:
        logger.info("congestion_estimates_deferred", timeout_s=timeout)
        return None
    except Exception as exc:  # noqa: BLE001 — 추정은 부가 정보다. 추천·지도를 죽이지 않는다.
        logger.warning("congestion_estimates_unavailable", error=str(exc))
        return None
    if not isinstance(current, dict) or not current.get("available"):
        return None
    return current


def estimate_for(
    current: dict | None, facility_id: object, *, now: datetime | None = None
) -> dict | None:
    """시설 하나의 추정 근거(estimate_evidence 모양) 또는 ``None``.

    모양을 한 번 더 확인한다: level 이 0..1 숫자가 아니거나 source 가 'estimated' 가 아니면 버린다.
    화면은 이 dict 를 그대로 그리므로, 여기서 새는 값은 곧 사용자에게 보이는 값이다.

    **내보내는 시점에도** 관측 나이를 다시 잰다. 추정기는 계산할 때만 60분 한도를 보고 결과를
    5분 캐시하므로, 캐시 끝자락에는 65분 된 주차를 '지금' 으로 내보낼 수 있었다(레드팀 지적).
    """
    if not current or facility_id is None:
        return None
    from app.services.congestion_estimator_service import estimate_evidence
    from app.services.parking_derived_congestion_service import MAX_SNAPSHOT_AGE

    try:
        estimate = estimate_evidence(current, str(facility_id))
    except Exception as exc:  # noqa: BLE001
        logger.warning("congestion_estimate_shape_error", facility_id=str(facility_id), error=str(exc))
        return None
    if not estimate or estimate.get("source") != ESTIMATE_SOURCE:
        return None
    try:
        level = float(estimate.get("level"))
    except (TypeError, ValueError):
        return None
    if not 0.0 <= level <= 1.0:
        return None
    observed = _parse_timestamp(estimate.get("observed_at"))
    if observed is None:
        return None
    age = (now or datetime.now(timezone.utc)).astimezone(timezone.utc) - observed
    # 미래 쪽은 시계 오차 5분까지 봐준다(수집기·API 서버 시계가 완전히 같지 않다).
    if age > MAX_SNAPSHOT_AGE or age < -timedelta(minutes=5):
        return None
    return estimate


def attach_estimate(
    evidence: dict, current: dict | None, facility_id: object, *, now: datetime | None = None
) -> dict:
    """근거 dict 에 ``estimate``·``is_current`` 칸을 채운 **사본**을 돌려준다. 원본은 건드리지 않는다.

    우선순위(2026-09-20 결정 — 계획서 §5.2 의 문장을 코드로 옮긴 것):

      1. **지금을 말할 자격이 있는 실측** — verified/corroborated · 30분 이내, 그리고 사장님 좌석
         방송(호출부가 ``is_current=True`` 로 찍는다). 추정은 붙지 않는다.
      2. **학습된 모델 예측** — 승격 게이트를 통과해야만 켜지고, 그 숫자가 순위를 만든다.
      3. **추정**(주차 실측 + 관광 통계).
      4. 아무것도 없음.

    바뀐 점은 하나다: **낡거나(30분 초과) 단건(single_report)인 실측은 더 이상 신선한 추정을 덮지
    않는다.** 예전에는 `source != 'none'` 이면 무조건 추정을 버렸고, 그래서 프로덕션에서 7월 시드와
    2026-08-21 제보 한 건이 한 달 내내 '실측' 으로 서 있었다 — 같은 시각의 주차 실측보다 그 값이
    더 정확하다고 주장할 근거가 하나도 없는데도. 순위 쪽은 이미 이 선을 쓰고 있었다는 점이 결정적
    이다(``rankable_measured_level`` 이 같은 30분·신뢰등급 조건이라, 낡은 실측 후보는 오래전부터
    measured_rules 가 아니었다). 화면만 순위와 다른 이야기를 하고 있었던 것이다.

    **관측을 지우지는 않는다.** ``source``/``level``/``timestamp``/``is_stale`` 은 한 글자도 건드리지
    않고 그대로 실려 나간다. 화면은 ``is_current=False`` 를 보고 추정을 '지금' 으로 칠하면서 그 낡은
    관측을 '마지막 관측 HH:MM' 으로 함께 보여 준다(apps/web/lib/congestionEstimate.ts
    congestionDisplay). 응답에서 빼지 않는 이유는 둘이다 — 정직(실제로 있었던 관측이다)과 배포 시차
    (구 번들은 ``is_current`` 를 모르므로 종전과 **똑같이** 그 실측을 그린다. 새 필드를 모르는 화면이
    갑자기 값을 잃지 않는다).

    추정이 실측 칸으로 새어 나갈 문은 여전히 없다: ``estimate`` 는 옆 칸이고 ``source`` 는 절대
    'estimated' 가 되지 않는다. 그래서 rankable_measured_level·대기 분·current_count·학습 데이터는
    추정을 한 번도 보지 못한다.
    """
    out = {**evidence, "estimate": None, "is_current": evidence_is_current(evidence, now=now)}
    if out["is_current"]:
        return out
    out["estimate"] = estimate_for(current, facility_id, now=now)
    return out


def estimate_applies_to_arrival(estimate: dict | None, arrival: datetime) -> bool:
    """이 추정(현재 관측)을 도착 시점의 혼잡으로 **보여 줘도 되는가.**

    area_demand_service._live_parking_applies_to_arrival 과 같은 규칙이다 — 관측 후 30분 안의
    도착에만 현재 관측을 쓴다. 코스의 2·3번 정류지(한 시간 넘게 뒤)에 '지금' 주차를 붙이면
    도착 시각의 값처럼 읽힌다. 그 자리는 이력 전망이 맡을 몫이고 추정기는 그걸 만들지 않는다.
    """
    if not estimate:
        return False
    observed = _parse_timestamp(estimate.get("observed_at"))
    if observed is None:
        return False
    if arrival.tzinfo is None:
        arrival = arrival.replace(tzinfo=timezone.utc)
    horizon = arrival.astimezone(timezone.utc) - observed
    return timedelta(0) <= horizon <= RANKING_FRESHNESS
