"""서울 실시간 도시데이터(OA-21285) → `CrowdObservation` 어댑터와 서울 구역 정의.

`docs/SEOUL_TESTBED_PLAN.md` §3.1 · §6 S1·S2. 조회·파싱·키 가리기·대상지명 대조는 지금 수집기
(`seoul_citydata_service`)가 이미 검증된 채로 갖고 있다. 이 모듈은 그것을 **다시 만들지 않고** 감싼다:

    fetch_citydata → parse_citydata  (수집기의 것 그대로)
                   → observation_from_parsed  (여기 — 정규화만)

그래서 기존 수집 경로(`POST /seoul/collect` · `seoul_citydata_snapshots` · pg_cron)는 한 줄도 다르게
돌지 않고, 정규화 행(`zone_crowd_snapshots`)이 **옆에 함께** 쌓인다(수집기의 이중 저장).

## 등급 → 0~1
서울시 4등급을 `seoul_alternatives_service.grade_level`(등급 구간 중앙값: 0.125·0.375·0.625·0.875)로
바꾼다. 서울 대안 패널·검증 화면과 **같은 눈금**이다 — 새 눈금을 만들지 않는다.

## 구역 정의(`SEOUL_ZONES`)
마이그레이션 `20261031120000_crowd_zones.sql` 의 시드와 **같은 값**이다(테스트가 대조한다).
코드·이름은 서울 열린데이터광장 OA-21285 '서울시 주요 121장소 목록.xlsx'(2026-04-02 판), 중심·반지름은
같은 곳의 '서울시 주요 121장소 영역.zip'(WGS84 다각형)에서 계산했다: 중심 = 다각형 넓이 중심,
반지름 = 같은 넓이 원의 반지름(m). 다각형 자체는 아직 싣지 않는다(S3 시설 매핑 때 적재).
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any, Sequence

import httpx
import structlog

from app.core.config import settings
from app.services import engine_validation_metrics as metrics
from app.services import seoul_alternatives_service as alternatives
from app.services.crowd.observation import (
    CrowdForecast,
    CrowdObservation,
    ProviderDescription,
    Zone,
    forecasts_within,
)

logger = structlog.get_logger()

SOURCE = "seoul_citydata"
REGION = "seoul"
# 서울시 4등급을 구간 중앙값으로 환산한 눈금. zone_crowd_snapshots.level_scale 에 그대로 남는다.
LEVEL_SCALE = "seoul_congest_4"
# 서울시 실시간 인구 갱신 주기(실시간 도시데이터 매뉴얼: 인구 5분).
PERIOD_SECONDS = 300

_KST = timezone(timedelta(hours=9))


def _zone(code: str, name: str, cluster: str, lat: float, lng: float, radius_m: int) -> Zone:
    return Zone(
        zone_id=f"{REGION}:{code}",
        region=REGION,
        kind="hotspot_polygon",
        name=name,
        provider=SOURCE,
        provider_zone_code=code,
        provider_zone_name=name,
        cluster=cluster,
        centroid_lat=lat,
        centroid_lng=lng,
        radius_m=radius_m,
    )


# S2 대상지 9곳 = 종로 유산 권역 4 + 홍대 권역 3 + 추정 폴백 검증 2(§6 S2 · §7 A2).
# ⚠️ 계획의 '인사동·익선동'은 공식 목록에 **한 장소로 없다** — 인사동(POI078)과 익선동(POI116)이 따로다.
#    여기서는 인사동을 넣었다(넓이 0.34km² 로 표본이 크고, 창덕궁·종묘와 경계가 덜 겹친다).
#    익선동으로 바꾸거나 더하려면 이 표·마이그레이션 시드·SEOUL_CITYDATA_TARGETS 를 함께 고친다.
SEOUL_ZONES: tuple[Zone, ...] = (
    _zone("POI008", "경복궁", "jongno", 37.579876, 126.976764, 375),
    _zone("POI066", "북촌한옥마을", "jongno", 37.582236, 126.984001, 597),
    _zone("POI078", "인사동", "jongno", 37.573863, 126.986063, 328),
    _zone("POI012", "창덕궁·종묘", "jongno", 37.578695, 126.993351, 592),
    _zone("POI007", "홍대 관광특구", "hongdae", 37.553919, 126.921276, 634),
    _zone("POI073", "연남동", "hongdae", 37.561617, 126.922338, 351),
    _zone("POI053", "합정역", "hongdae", 37.549376, 126.911733, 392),
    _zone("POI003", "명동 관광특구", "validation", 37.564149, 126.981851, 542),
    _zone("POI002", "동대문 관광특구", "validation", 37.567311, 127.011023, 440),
)

_ZONES_BY_NAME = {zone.provider_zone_name: zone for zone in SEOUL_ZONES}


def _normalize_name(name: Any) -> str:
    return " ".join(str(name or "").split())


def zone_for_name(area_nm: str) -> Zone | None:
    return _ZONES_BY_NAME.get(_normalize_name(area_nm))


def zone_id_for(area_nm: str, area_cd: str | None) -> str | None:
    """요청 이름 → 구역 ID. 정의된 구역이 먼저, 없으면 응답의 AREA_CD 로 만든다(`seoul:POI…`)."""
    zone = zone_for_name(area_nm)
    if zone is not None:
        return zone.zone_id
    code = str(area_cd or "").strip()
    return f"{REGION}:{code}" if code else None


def _parse_kst(value: Any) -> datetime | None:
    text = str(value or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=_KST)
        except ValueError:
            continue
    return None


def _nonnegative_int(value: Any) -> int | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        number = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number < 0:
        return None
    return int(number)


def level_for_label(label: Any) -> float | None:
    """서울시 등급 문자열 → 0~1(구간 중앙값). 모르는 문자열은 None."""
    return alternatives.grade_level(metrics.actual_grade(label))


def _population_range(raw_min: Any, raw_max: Any) -> tuple[int | None, int | None]:
    low, high = _nonnegative_int(raw_min), _nonnegative_int(raw_max)
    if low is not None and high is not None and low > high:
        return None, None
    return low, high


def _forecasts(zone_id: str, issued_at: datetime, rows: Any) -> tuple[CrowdForecast, ...]:
    items: list[CrowdForecast] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        target_at = _parse_kst(row.get("FCST_TIME"))
        if target_at is None:
            continue
        label = _normalize_name(row.get("FCST_CONGEST_LVL")) or None
        level = level_for_label(label)
        low, high = _population_range(row.get("FCST_PPLTN_MIN"), row.get("FCST_PPLTN_MAX"))
        items.append(
            CrowdForecast(
                zone_id=zone_id,
                source=SOURCE,
                issued_at=issued_at,
                target_at=target_at,
                population_min=low,
                population_max=high,
                level=level,
                level_label=label if level is not None else None,
            )
        )
    items.sort(key=lambda item: item.target_at)
    return tuple(items)


def observation_from_parsed(parsed: dict[str, Any], *, fetched_at: datetime) -> CrowdObservation | None:
    """`seoul_citydata_service.parse_citydata` 결과 → 관측 한 건. 구역을 정할 수 없으면 None.

    `parse_citydata` 가 이미 이름 대조·등급 검증·뒤집힌 범위 비우기를 끝낸 값을 받는다 — 여기서 다시
    거르지 않는다. 품질 플래그만 덧붙인다.
    """
    area_nm = parsed["area_nm"]
    area_cd = parsed.get("area_cd")
    zone_id = zone_id_for(area_nm, area_cd)
    if zone_id is None:
        return None
    observed_at: datetime = parsed["observed_at"]
    low, high = parsed.get("ppltn_min"), parsed.get("ppltn_max")
    label = parsed["congest_lvl"]
    zone = zone_for_name(area_nm)
    quality: dict[str, Any] = {
        "provider_zone_code": area_cd,
        "provider_zone_name": area_nm,
        "lag_seconds": max(0, int((fetched_at - observed_at).total_seconds())),
    }
    if low is None or high is None:
        quality["population_range_missing"] = True
    replace_yn = parsed.get("replace_yn")
    if replace_yn in ("Y", "N"):
        # 서울시가 실측 대신 대체값을 넣었는가(REPLACE_YN). 'Y' 면 그 관측은 실측이 아니다.
        quality["replaced"] = replace_yn == "Y"
    if zone is not None and area_cd and area_cd != zone.provider_zone_code:
        # 이름은 맞는데 코드가 다르다 — 서울시가 코드를 다시 매겼을 수 있다. 구역은 이름으로 정한다.
        quality["provider_zone_code_mismatch"] = True
    return CrowdObservation(
        zone_id=zone_id,
        source=SOURCE,
        observed_at=observed_at,
        fetched_at=fetched_at.astimezone(timezone.utc),
        level_scale=LEVEL_SCALE,
        period_seconds=PERIOD_SECONDS,
        population_min=low,
        population_max=high,
        population_point=(low + high) / 2.0 if low is not None and high is not None else None,
        level=level_for_label(label),
        level_label=label,
        forecast=_forecasts(zone_id, observed_at, parsed.get("fcst")),
        quality=quality,
    )


class SeoulCitydataProvider:
    """`CrowdProvider` 의 서울 구현. 호출 1번 = 구역 1곳(일 1,000회 한도를 쓴다)."""

    source = SOURCE

    def describe(self) -> ProviderDescription:
        return ProviderDescription(
            source=SOURCE,
            region=REGION,
            cadence_seconds=PERIOD_SECONDS,
            expected_latency_seconds=15 * 60,
            spatial_resolution="주요 장소(핫스팟) 다각형 — 서울시 121곳, 권역 단위",
            level_scale=LEVEL_SCALE,
            provides_forecast=True,
            provides_history=False,
            license="공공누리 제1유형(출처표시)",
        )

    async def fetch_current(
        self, zones: Sequence[Zone], *, client: httpx.AsyncClient | None = None
    ) -> list[CrowdObservation]:
        """구역마다 한 번 부른다. 실패한 구역은 빠진다(코드만 로그) — 예외는 밖으로 내지 않는다."""
        # 지연 import: 수집기(seoul_citydata_service)가 이 모듈을 import 한다(이중 저장).
        from app.services import seoul_citydata_service as seoul

        if not seoul.key_configured() or not zones:
            return []
        key = settings.SEOUL_OPENDATA_KEY.strip()
        observations: list[CrowdObservation] = []
        owned = client is None
        http = client or httpx.AsyncClient(timeout=10.0, follow_redirects=False)
        try:
            for zone in zones:
                name = zone.provider_zone_name or zone.name
                try:
                    payload = await seoul.fetch_citydata(http, key, name)
                    parsed = seoul.parse_citydata(payload, name)
                except seoul.SeoulCitydataError as exc:
                    logger.warning("crowd_seoul_fetch_failed", zone_id=zone.zone_id, error_code=exc.code)
                    continue
                observation = observation_from_parsed(parsed, fetched_at=datetime.now(timezone.utc))
                if observation is not None:
                    observations.append(observation)
        finally:
            if owned:
                await http.aclose()
        return observations

    async def fetch_forecast(
        self, zones: Sequence[Zone], horizon: timedelta, *, client: httpx.AsyncClient | None = None
    ) -> list[CrowdForecast]:
        """서울 예측(FCST_PPLTN)은 현재값과 **같은 응답**에 온다 — 별도 호출이 없다(구역당 1회)."""
        return forecasts_within(await self.fetch_current(zones, client=client), horizon)
