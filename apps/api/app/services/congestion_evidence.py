"""Rules for deciding which observed congestion may influence ranking.

추정(estimated) 근거도 이 파일이 다룬다 — 다만 **순위에 들어가는 문(rankable_measured_level)과는
완전히 분리된 옆문**으로만 붙는다. 이유는 아래 ``attach_estimate`` 주석 참조.

'지금' 판정(``measurement_is_current``)은 이 파일에만 있다. 추천·코스·지도 세 경로와 화면이 모두
이 한 함수의 결론(``is_current``)을 받아 쓴다 — 같은 판단을 각자 구현하면 갈라지기 때문이다.
"""
import asyncio
from datetime import datetime, timedelta, timezone
from typing import NamedTuple

import structlog

from app.services.crowd.zone_evidence import (
    ZONE_EVIDENCE_TIER,
    ZONE_FORECAST_MATCH_WINDOW,
    ZONE_FORECAST_MAX_ISSUE_AGE,
    ZONE_NOW_WINDOW,
    band_for_level,
    zone_reading_is_current,
)

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
    · measured + 구역 관측(``zone_measured``, 서울 S3) → 구역 규칙(매핑된 구역 **전부**가
      0 ≤ 벽시계 − 관측 ≤ 30분, ``zone_evidence_all_current``). 신뢰 등급 표(TRUSTED_EVIDENCE_TIERS)는 건드리지 않는다 —
      구역 관측은 '지금' 을 말할 수는 있어도 ``rankable_measured_level`` 의 문은 통과하지 않는다(순위는
      도착 시각 규칙 ``zone_arrival_level`` 로만 들어간다).
    """
    if not evidence:
        return False
    source = evidence.get("source")
    if source == "predicted":
        return True
    if source != "measured":
        return False
    if evidence.get("evidence_tier") == ZONE_EVIDENCE_TIER:
        return zone_evidence_all_current(evidence, wall_now=(now or datetime.now(timezone.utc)))
    return measurement_is_current(
        evidence.get("evidence_tier"), evidence.get("timestamp"), now=now
    )


# ── 구역 근거의 도착 시각 혼잡(서울 S3 — docs/SEOUL_TESTBED_PLAN.md) ───────────────


class ZoneArrival(NamedTuple):
    """구역 근거가 **도착 시각**에 말하는 혼잡 — 순위·재배치 기여·코스 표시가 모두 이 값을 쓴다."""

    level: float
    basis: str            # 'persistence'(지금 관측을 그대로) | 'provider_forecast'(공급원 예측)
    band: str | None      # relaxed | normal | slightly_busy | busy
    zone_id: str
    zone_name: str | None
    level_scale: str | None
    observed_at: str | None
    forecast_target_at: str | None


# 구역 혼잡의 자체 모델은 아직 없다. 자리만 남겨 둔다(호출해도 언제나 None — 순위에 닿지 않는다).
def own_model_zone_level(_zone: dict, _arrival: datetime) -> float | None:
    return None


def _utc(moment: datetime) -> datetime:
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def _unit_level(value: object) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        level = float(value)
    except (TypeError, ValueError):
        return None
    return level if 0.0 <= level <= 1.0 else None


def _zone_arrival(zone: dict, arrival: datetime, wall_now: datetime) -> ZoneArrival | None:
    """구역 하나의 도착 시각 혼잡. 지금 관측(persistence)과 공급원 예측 중 **시간상 더 가까운 쪽**.

      · persistence — 0 ≤ 도착 − 관측 ≤ 30분 **그리고** 0 ≤ 벽시계 − 관측 ≤ 30분. 간격 gap_p = 도착 − 관측.
      · 예측 — 벽시계 − 관측(=발행) ≤ 90분이고, 단계가 있는 예측점 가운데 도착에 가장 가까운 점의
        간격 gap_f = |대상 − 도착| ≤ 30분.
      · 둘 다 되면 gap_p ≤ gap_f 일 때 persistence(동점은 persistence), 아니면 예측.
      · 도착이 관측보다 앞서면(음의 지평) 이 구역은 말하지 않는다.
    """
    observed = _parse_timestamp(zone.get("observed_at"))
    if observed is None:
        return None
    horizon = arrival - observed
    if horizon < timedelta(0):
        return None
    issue_age = wall_now - observed
    if issue_age < timedelta(0):
        return None  # 미래 관측(시계 어긋남)은 근거가 아니다

    scale = zone.get("level_scale")
    persistence = None
    current_level = _unit_level(zone.get("level"))
    if current_level is not None and horizon <= ZONE_NOW_WINDOW and issue_age <= ZONE_NOW_WINDOW:
        persistence = (horizon, current_level, zone.get("level_band") or band_for_level(current_level, scale))

    forecast = None
    if issue_age <= ZONE_FORECAST_MAX_ISSUE_AGE:
        for point in zone.get("forecast") or []:
            if not isinstance(point, dict):
                continue
            target = _parse_timestamp(point.get("target_at"))
            level = _unit_level(point.get("level"))
            if target is None or level is None or target < observed:
                continue
            gap = abs(target - arrival)
            if gap > ZONE_FORECAST_MATCH_WINDOW:
                continue
            band = point.get("level_band") or band_for_level(level, scale)
            if forecast is None or (gap, target) < (forecast[0], forecast[3]):
                forecast = (gap, level, band, target)

    common = {
        "zone_id": str(zone.get("id") or ""),
        "zone_name": zone.get("name"),
        "level_scale": scale,
        "observed_at": observed.isoformat(),
    }
    if persistence is not None and (forecast is None or persistence[0] <= forecast[0]):
        return ZoneArrival(
            level=persistence[1], basis="persistence", band=persistence[2],
            forecast_target_at=None, **common,
        )
    if forecast is not None:
        return ZoneArrival(
            level=forecast[1], basis="provider_forecast", band=forecast[2],
            forecast_target_at=forecast[3].isoformat(), **common,
        )
    return None


def zone_evidence_is_partial(evidence: dict | None) -> bool:
    """구역 근거인데 매핑된 구역 가운데 관측이 빠진 구역이 있는가(``mapped_zone_count`` > 관측 구역 수)."""
    if not evidence or evidence.get("evidence_tier") != ZONE_EVIDENCE_TIER:
        return False
    mapped = evidence.get("mapped_zone_count")
    if isinstance(mapped, bool) or not isinstance(mapped, int):
        return False
    zones = [z for z in (evidence.get("zones") or []) if isinstance(z, dict)]
    return mapped > len(zones)


def zone_evidence_all_current(evidence: dict | None, *, wall_now: datetime) -> bool:
    """구역 근거가 시설의 '지금' 을 말할 수 있는가 — 매핑된 구역이 전부 관측되었고(부분 아님) 전부 30분 안이다.

    조용한 '지금' 구역 하나와 30분을 넘긴(2시간 조회 범위 안) 붐비는 구역이 섞이면 '지금' 이 아니다 —
    빈 구역(``zone_evidence_is_partial``)과 같은 규칙이다(`zone_evidence.facility_zones_current` 와 같은 판정).
    """
    if not evidence or evidence.get("evidence_tier") != ZONE_EVIDENCE_TIER:
        return False
    if zone_evidence_is_partial(evidence):
        return False
    zones = [z for z in (evidence.get("zones") or []) if isinstance(z, dict)]
    if not zones:
        return zone_reading_is_current(_parse_timestamp(evidence.get("timestamp")), wall_now=wall_now)
    return all(
        zone_reading_is_current(_parse_timestamp(z.get("observed_at")), wall_now=wall_now) for z in zones
    )


def zone_arrival_level(
    evidence: dict | None, arrival: datetime, *, wall_now: datetime
) -> ZoneArrival | None:
    """구역 근거(``zone_measured``)가 도착 시각에 말하는 혼잡. 말할 수 없으면 ``None``.

    시계가 둘이다 — ``arrival`` 은 기준 시각(지금·가정 시각·코스 누적 출발) + 이동이고, ``wall_now`` 는
    실제 벽시계다. 관측·예측 발행의 나이는 언제나 벽시계로 잰다(가정 시각으로 재면 방금 받은 관측이
    낡은 것으로, 또는 한 달 전 관측이 신선한 것으로 보인다).

    여러 구역에 걸친 시설은 **도착 시각의 최댓값**(보수적)을 쓴다 — 지금 덜 붐비는 구역이 도착할 때는
    더 붐빌 수 있으므로 미리 하나로 줄이지 않는다. 동점은 구역 ID 로 결정적으로 깬다.
    최댓값이 보수적이려면 **매핑된 구역이 전부** 도착 시각을 말해야 한다 — 한 구역이라도 관측이 없거나
    (``mapped_zone_count`` > 관측 구역 수) 도착 시각을 말할 수 없으면 ``None`` 이다(조용한 구역 하나만으로
    순위를 매기지 않는다). 그 후보는 순위에서 근거 없음이 되고 카드는 'N분 전 관측' 만 보여 준다.
    """
    if not evidence or evidence.get("evidence_tier") != ZONE_EVIDENCE_TIER:
        return None
    if zone_evidence_is_partial(evidence):
        return None
    arrival_utc, now_utc = _utc(arrival), _utc(wall_now)
    best: ZoneArrival | None = None
    zones = [z for z in (evidence.get("zones") or []) if isinstance(z, dict)]
    for zone in sorted(zones, key=lambda z: str(z.get("id") or "")):
        candidate = _zone_arrival(zone, arrival_utc, now_utc)
        if candidate is None:
            return None
        if best is None or candidate.level > best.level:
            best = candidate
    return best


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
