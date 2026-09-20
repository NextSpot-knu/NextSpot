"""서울 실시간 도시데이터(OA-21285) 수집기 — 혼잡 엔진 **검증용 정답** 적재.

`docs/CONGESTION_ENGINE_PLAN.md` §5.3 Phase 1. 대상지(기본: 홍대 관광특구 1곳)마다 통합 API 를
10분에 한 번 부르고, 같은 응답에 함께 오는 두 가지를 한 행에 저장한다:

  · 정답   — `LIVE_PPLTN_STTS`: 서울시 인구 혼잡 4등급·인구 범위·서울시 자체 예측(FCST_PPLTN)
  · 추정   — `PRK_STTS` 의 실시간 주차장으로 **경주와 같은 추정기**를 돌린 값(level_est)

정답과 추정을 같은 행에 두면 지표(§6)가 SQL 한 번이다. 서울 API 는 이력을 주지 않으므로 표본은
이 수집기가 돈 날부터만 쌓인다(§2-6) — 그래서 Phase 1 을 가장 먼저 켠다.

## 추정은 새로 만들지 않는다

산식은 `congestion_estimator_service.blend_level`(0.7·주차 + 0.3·관광, 주차 없으면 None)과
`parking_derived_congestion_service.cell_demand_level`(2km 거리·면수 가중 점유율)을 **그대로** 쓴다.
서울만의 식을 두면 "서울에서 맞았다" 가 경주 추정기에 대한 증거가 아니게 된다(§5.1 한 산식, 두 지역).
달라지는 것은 측정 지점 하나다 — 경주는 0.005° 격자 중심, 서울은 **대상지(핫스팟) 기준 좌표**다.

## 키는 URL 경로에 있다

서울 열린데이터광장은 인증키를 쿼리가 아니라 **경로**(`/{KEY}/json/citydata/...`)에 넣는다. 그래서:
  · 예외 메시지·로그·응답에 URL 이나 원문을 싣지 않는다(오류는 코드만, `raise ... from None`).
  · httpx 는 INFO 로 `HTTP Request: GET <URL>` 을 찍고, 이 앱은 루트 로거가 INFO 다. 아래
    `_RedactSeoulKeyFilter` 가 그 한 줄에서 키 자리를 가린다.
  · 서울 API 는 HTTPS 를 받지 않는다(8088 평문, 2026-09-20 확인) — 키가 평문으로 오간다. 검증 전용
    무료 키라 감수하지만, 다른 키를 이 키로 재사용하지 않는다.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

import httpx
import structlog

from app.core.config import settings
from app.core.supabase import supabase_admin
from app.services.congestion_estimator_service import blend_level
from app.services.parking_derived_congestion_service import (
    MAX_SNAPSHOT_AGE,
    ParkingLot,
    cell_demand_level,
)
from app.services.tourapi.client import parse_total_count
from app.services.tourapi.insights import (
    SEOUL_TOURISM_AREA_CODE,
    concentration_forecast,
    normalized_concentration_rows,
)
from app.services.tourism_name_matching import normalize_tourism_anchor_name

logger = structlog.get_logger()

TABLE = "seoul_citydata_snapshots"
MIGRATION = "20260920120000_seoul_citydata_snapshots.sql"

_BASE_URL = "http://openapi.seoul.go.kr:8088"
_HOST = "openapi.seoul.go.kr"
_REQUEST_TIMEOUT_SECONDS = 10.0

# 산식이 바뀌면 올린다. 지표 모듈(engine_validation_metrics)은 최신 버전 행끼리만 비교한다.
# 구성: 주차 2km 가중 점유율(cell_demand_level) · 0.7/0.3 혼합(blend_level) · 보정 f = 항등.
ESTIMATOR_VERSION = "v1-parking2km-blend0.7-identity"

BUCKET = timedelta(minutes=10)
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_KST = timezone(timedelta(hours=9))

# 서울시 인구 혼잡 4등급. 마이그레이션 CHECK 와 같은 목록이어야 한다(테스트가 대조한다).
CONGEST_LEVELS = ("여유", "보통", "약간 붐빔", "붐빔")

# PRK_STTS / FCST_PPLTN 에서 저장할 원문 필드. 요금·주소 등은 검증에 쓰지 않아 행 크기만 키운다.
_PRK_FIELDS = (
    "PRK_NM", "PRK_CD", "PRK_TYPE", "CPCTY", "CUR_PRK_CNT", "CUR_PRK_TIME", "CUR_PRK_YN", "LAT", "LNG",
)
_FCST_FIELDS = ("FCST_TIME", "FCST_CONGEST_LVL", "FCST_PPLTN_MIN", "FCST_PPLTN_MAX")

_RESULT_CODE = re.compile(r"^(?:INFO|ERROR)-\d{3}$")
_XML_RESULT_CODE = re.compile(r"<CODE>\s*((?:INFO|ERROR)-\d{3})\s*</CODE>")

# 서울 열린데이터광장 공통 결과 코드 → 우리 오류 코드. 원문 메시지는 싣지 않는다.
# INFO-100 은 2026-09-20 잘못된 키로 직접 확인(JSON 을 요청해도 **XML** 로 온다).
# ERROR-337(일일 호출 한도 초과)은 공통 코드표 기준이고 아직 직접 보지 못했다.
_UPSTREAM_CODE_MAP = {
    "INFO-100": "seoul_key_invalid",
    "INFO-200": "seoul_no_data",
    "ERROR-337": "seoul_quota_exceeded",
    "ERROR-500": "seoul_upstream_error",
    "ERROR-600": "seoul_upstream_error",
    "ERROR-601": "seoul_upstream_error",
}


@dataclass(frozen=True)
class TargetProfile:
    """대상지별 추정 입력. 목록(SEOUL_CITYDATA_TARGETS)과 달리 이것은 **선택**이다.

    프로필이 없는 대상지도 수집·정답 저장은 그대로 된다. 달라지는 것은 둘뿐이다:
      · 측정 지점 — 기준 좌표 대신 그 시각 실시간 주차장들의 중심으로 잰다(덜 정확하다).
      · 관광 성분 — 시군구 코드를 모르면 집중률을 찾지 않는다(None → 주차 단독).
    """

    latitude: float
    longitude: float
    # 관광공사 집중률 API 의 signguCd(areaCd=11 서울). 모르면 None.
    signgu_code: int | None
    # 집중률 응답에서 이 대상지로 볼 관광지 이름(정확 일치 — 정규화는 표기 차이만 흡수한다).
    tourism_names: tuple[str, ...]


# 홍대 관광특구 기준 좌표는 서울시 실시간 도시데이터 지도 링크(hotspotNm=홍대 관광특구)의 값이다.
# 링크 파라미터는 x=위도·y=경도로 뒤바뀌어 있다 — 여기는 위도 37.55·경도 126.92 가 맞다.
# ⚠️ 집중률 관광지 이름은 **미확인**이다(로컬에 TourAPI 키가 없어 마포구 목록을 못 봤다 — §4 반영 7).
#    정확 일치만 쓰므로 틀린 이름은 "관광 성분 없음" 으로 떨어질 뿐 엉뚱한 값을 붙이지 않는다.
#    목록을 확인하면 여기에 이름만 보태면 된다.
_TARGET_PROFILES: dict[str, TargetProfile] = {
    "홍대 관광특구": TargetProfile(
        latitude=37.55391867558625,
        longitude=126.92127401787192,
        signgu_code=11440,
        tourism_names=("홍대 관광특구", "홍대 걷고싶은거리"),
    ),
}


class SeoulCitydataError(RuntimeError):
    """수집 실패. 코드(와 검증된 서울시 결과 코드)만 운반하고 URL·원문·키는 싣지 않는다."""

    def __init__(self, code: str, upstream_code: str | None = None):
        self.code = code
        self.upstream_code = upstream_code
        super().__init__(code)


class SeoulSnapshotPersistenceError(RuntimeError):
    """조회는 됐지만 저장(또는 읽기)이 실패했다. ``migration_not_applied`` 는 사람이 할 일이 남았다는 뜻."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


# ── 키가 로그로 새지 않게 ─────────────────────────────────────────────────────

_KEY_IN_PATH = re.compile(r"(openapi\.seoul\.go\.kr(?::\d+)?/)[^/\s\"'<>]+")


class _RedactSeoulKeyFilter(logging.Filter):
    """httpx 의 요청 로그에서 서울 API 키(경로 첫 조각)를 가린다. 레코드는 버리지 않는다."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001 — 로그 포맷 실패로 요청을 깨뜨리지 않는다
            return True
        if _HOST in message:
            record.msg = _KEY_IN_PATH.sub(r"\1[redacted]", message)
            record.args = ()
        return True


def _install_log_redaction() -> None:
    httpx_logger = logging.getLogger("httpx")
    if not any(isinstance(f, _RedactSeoulKeyFilter) for f in httpx_logger.filters):
        httpx_logger.addFilter(_RedactSeoulKeyFilter())


_install_log_redaction()


# ── 상태(경주 parking_demand_service 의 _status 패턴) ──────────────────────────

def _initial_status() -> dict[str, Any]:
    return {
        "state": "not_run",  # not_run | ok | partial | failed
        "last_run_at": None,
        "last_success_at": None,
        "error_code": None,
        "targets": {},
    }


_status: dict[str, Any] = _initial_status()


def get_collection_status() -> dict[str, Any]:
    """마지막 수집 결과(프로세스 메모리). 재시작하면 비어 있다 — DB 최신 행과 함께 본다."""
    return {**_status, "targets": {name: dict(value) for name, value in _status["targets"].items()}}


def reset_state() -> None:
    """테스트 격리용."""
    global _status
    _status = _initial_status()
    _tourism_cache.clear()


# ── 설정 ──────────────────────────────────────────────────────────────────────

def _normalize_target_name(name: str) -> str:
    return " ".join(str(name or "").split())


def configured_targets() -> list[str]:
    """SEOUL_CITYDATA_TARGETS(콤마 구분)를 순서 유지·중복 제거해 읽는다."""
    names: list[str] = []
    for raw in str(settings.SEOUL_CITYDATA_TARGETS or "").split(","):
        name = _normalize_target_name(raw)
        if name and name not in names:
            names.append(name)
    return names


def key_configured() -> bool:
    return bool((settings.SEOUL_OPENDATA_KEY or "").strip())


def target_profile(area_nm: str) -> TargetProfile | None:
    return _TARGET_PROFILES.get(_normalize_target_name(area_nm))


def bucket_start(moment: datetime) -> datetime:
    """UTC 10분 버킷의 시작. pg_cron 보충 호출(date_bin 10분, epoch 기준)과 같은 경계다."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    moment = moment.astimezone(timezone.utc)
    steps = (moment - _EPOCH) // BUCKET
    return _EPOCH + steps * BUCKET


# ── 파서(순수 함수) ────────────────────────────────────────────────────────────

def _parse_kst(value: Any) -> datetime | None:
    """서울시 시각 문자열(KST, 시간대 표기 없음)을 aware datetime 으로."""
    text = str(value or "").strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=_KST)
        except ValueError:
            continue
    return None


def _to_number(value: Any) -> float | None:
    """서울시 응답의 숫자는 전부 문자열이다. 빈 문자열·None·NaN 은 '값 없음'."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        number = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _to_nonnegative_int(value: Any) -> int | None:
    number = _to_number(value)
    if number is None or number < 0:
        return None
    return int(number)


def upstream_result_code(payload: Any) -> str | None:
    """응답의 서울시 결과 코드(INFO-000 등). 형식이 맞는 코드만 돌려준다(원문 메시지는 버린다)."""
    if not isinstance(payload, dict):
        return None
    candidates: list[Any] = [payload.get("RESULT")]
    citydata = payload.get("CITYDATA")
    if isinstance(citydata, dict):
        candidates.append(citydata.get("RESULT"))
    for result in candidates:
        if not isinstance(result, dict):
            continue
        code = str(result.get("RESULT.CODE") or result.get("CODE") or "").strip()
        if _RESULT_CODE.match(code):
            return code
    return None


def map_upstream_code(code: str) -> str:
    if code in _UPSTREAM_CODE_MAP:
        return _UPSTREAM_CODE_MAP[code]
    if code.startswith("ERROR-3"):
        return "seoul_bad_request"
    return "seoul_upstream_error"


def parse_citydata(payload: Any, requested_name: str) -> dict[str, Any]:
    """통합 응답에서 정답(인구)·서울시 예측·주차장 원문을 꺼낸다. 형식이 깨지면 코드로 던진다."""
    code = upstream_result_code(payload)
    if code is not None and code != "INFO-000":
        raise SeoulCitydataError(map_upstream_code(code), code)
    citydata = payload.get("CITYDATA") if isinstance(payload, dict) else None
    if not isinstance(citydata, dict):
        raise SeoulCitydataError("seoul_invalid_response", code)

    area_nm = _normalize_target_name(citydata.get("AREA_NM"))
    # 샘플키는 어떤 이름을 요청해도 광화문·덕수궁을 돌려준다(2026-09-20 확인). 이름을 대조하지 않으면
    # 다른 곳의 인구를 이 대상지의 정답으로 저장하게 된다 — 지표 전체가 조용히 오염된다.
    if area_nm != _normalize_target_name(requested_name):
        raise SeoulCitydataError("seoul_area_mismatch", code)
    area_cd = str(citydata.get("AREA_CD") or "").strip() or None

    live = citydata.get("LIVE_PPLTN_STTS")
    if isinstance(live, list):
        live = live[0] if live else None
    if not isinstance(live, dict):
        raise SeoulCitydataError("seoul_no_population", code)
    congest_lvl = _normalize_target_name(live.get("AREA_CONGEST_LVL"))
    observed_at = _parse_kst(live.get("PPLTN_TIME"))
    if congest_lvl not in CONGEST_LEVELS or observed_at is None:
        raise SeoulCitydataError("seoul_no_population", code)
    ppltn_min = _to_nonnegative_int(live.get("AREA_PPLTN_MIN"))
    ppltn_max = _to_nonnegative_int(live.get("AREA_PPLTN_MAX"))
    if ppltn_min is not None and ppltn_max is not None and ppltn_min > ppltn_max:
        # 뒤집힌 범위는 어느 쪽이 틀렸는지 알 수 없다 — 등급(정답의 본체)은 살리고 범위만 비운다.
        ppltn_min = ppltn_max = None

    fcst_raw = live.get("FCST_PPLTN")
    fcst = [
        {field: row.get(field) for field in _FCST_FIELDS}
        for row in (fcst_raw if isinstance(fcst_raw, list) else [])
        if isinstance(row, dict)
    ]
    prk_raw = citydata.get("PRK_STTS")
    prk_rows = [row for row in (prk_raw if isinstance(prk_raw, list) else []) if isinstance(row, dict)]
    return {
        "area_cd": area_cd,
        "area_nm": area_nm,
        "observed_at": observed_at,
        "congest_lvl": congest_lvl,
        "ppltn_min": ppltn_min,
        "ppltn_max": ppltn_max,
        "fcst": fcst,
        "prk_rows": prk_rows,
    }


def live_parking_lots(
    prk_rows: list[dict[str, Any]], *, fetched_at: datetime
) -> tuple[list[ParkingLot], list[dict[str, Any]], int]:
    """실시간 대수를 주는 주차장만 ParkingLot 으로 만든다. (lots, 저장할 원문, 오래된 탓에 뺀 수).

    통과 조건은 경주 스냅샷 적재(area_demand_snapshot_service)와 같은 정직성 기준이다:
    CUR_PRK_YN='Y', 총면 > 0, 0 ≤ 현재 대수 ≤ 총면, 좌표가 한국 범위. 광화문 실측으로는 29곳 중
    1곳만 남는다 — 나머지는 총면만 있고 현재 대수가 비어 있다.

    현재 대수 시각(CUR_PRK_TIME)이 수집 시각보다 MAX_SNAPSHOT_AGE(60분) 넘게 오래됐으면 뺀다.
    경주 추정기가 60분 넘은 스냅샷으로 추정을 만들지 않는 것과 같은 이유다 — 한 시간 전 주차를
    지금의 구역 혼잡으로 채점하면 추정기가 억울하게(혹은 운 좋게) 틀린다.
    """
    lots: list[ParkingLot] = []
    used: list[dict[str, Any]] = []
    stale = 0
    seen: set[str] = set()
    for row in prk_rows:
        if str(row.get("CUR_PRK_YN") or "").strip().upper() != "Y":
            continue
        total = _to_number(row.get("CPCTY"))
        current = _to_number(row.get("CUR_PRK_CNT"))
        latitude = _to_number(row.get("LAT"))
        longitude = _to_number(row.get("LNG"))
        if total is None or current is None or latitude is None or longitude is None:
            continue
        total_spaces = int(total)
        current_count = int(current)
        if total_spaces <= 0 or not 0 <= current_count <= total_spaces:
            continue
        if not (33.0 <= latitude <= 39.0 and 124.0 <= longitude <= 132.0):
            continue
        observed = _parse_kst(row.get("CUR_PRK_TIME"))
        if observed is not None and fetched_at - observed > MAX_SNAPSHOT_AGE:
            stale += 1
            continue
        name = str(row.get("PRK_NM") or "").strip()
        lot_id = str(row.get("PRK_CD") or "").strip() or name
        if not lot_id or lot_id in seen:
            continue
        seen.add(lot_id)
        lots.append(
            ParkingLot(
                lot_id=lot_id,
                name=name or lot_id,
                latitude=latitude,
                longitude=longitude,
                total_spaces=total_spaces,
                available_spaces=total_spaces - current_count,
            )
        )
        used.append({field: row.get(field) for field in _PRK_FIELDS})
    return lots, used, stale


def reference_point(area_nm: str, lots: list[ParkingLot]) -> tuple[float, float] | None:
    """추정을 재는 지점. 프로필 좌표 → 없으면 실시간 주차장 중심 → 둘 다 없으면 None."""
    profile = target_profile(area_nm)
    if profile is not None:
        return profile.latitude, profile.longitude
    if not lots:
        return None
    return (
        sum(lot.latitude for lot in lots) / len(lots),
        sum(lot.longitude for lot in lots) / len(lots),
    )


def estimate_levels(
    area_nm: str, lots: list[ParkingLot], tourism_level: float | None
) -> dict[str, float | None]:
    """§5.1 추정기를 서울 제공자로 돌린다. 계산은 전부 기존 함수에 맡긴다."""
    parking_level: float | None = None
    point = reference_point(area_nm, lots)
    if lots and point is not None:
        demand = cell_demand_level(lots, point[0], point[1])
        parking_level = demand["level"] if demand else None
    return {
        "parking_level": parking_level,
        "tourism_level": tourism_level,
        "level_est": blend_level(parking_level, tourism_level),
    }


def build_snapshot_row(
    parsed: dict[str, Any],
    *,
    fetched_at: datetime,
    tourism_level: float | None,
) -> tuple[dict[str, Any], int]:
    """테이블 한 행과 (오래돼서 뺀 주차장 수)를 만든다. DB 접근 없음."""
    lots, used, stale = live_parking_lots(parsed["prk_rows"], fetched_at=fetched_at)
    levels = estimate_levels(parsed["area_nm"], lots, tourism_level)
    row = {
        "area_cd": parsed["area_cd"],
        "area_nm": parsed["area_nm"],
        "bucket_at": bucket_start(fetched_at).isoformat(),
        "observed_at": parsed["observed_at"].isoformat(),
        "fetched_at": fetched_at.astimezone(timezone.utc).isoformat(),
        "congest_lvl": parsed["congest_lvl"],
        "ppltn_min": parsed["ppltn_min"],
        "ppltn_max": parsed["ppltn_max"],
        "fcst": parsed["fcst"],
        "prk": used,
        "live_lot_count": len(lots),
        **levels,
        "estimator_version": ESTIMATOR_VERSION,
    }
    return row, stale


# ── 외부 호출 ─────────────────────────────────────────────────────────────────

def _citydata_url(key: str, area_nm: str) -> str:
    return f"{_BASE_URL}/{quote(key, safe='')}/json/citydata/1/5/{quote(area_nm, safe='')}"


async def fetch_citydata(client: httpx.AsyncClient, key: str, area_nm: str) -> Any:
    """통합 API 한 번. 실패는 전부 코드로 바꾸고, 원인 예외는 끊는다(예외 문자열에 URL=키가 있다)."""
    try:
        response = await client.get(_citydata_url(key, area_nm))
    except httpx.TimeoutException:
        raise SeoulCitydataError("seoul_timeout") from None
    except httpx.HTTPError:
        raise SeoulCitydataError("seoul_unavailable") from None
    if response.status_code != 200:
        raise SeoulCitydataError("seoul_http_error")
    try:
        return response.json()
    except (json.JSONDecodeError, ValueError, UnicodeDecodeError):
        pass
    # 인증 오류는 JSON 을 요청해도 XML(<RESULT><CODE>INFO-100</CODE>…)로 온다.
    match = _XML_RESULT_CODE.search(response.text[:4000])
    if match:
        code = match.group(1)
        raise SeoulCitydataError(map_upstream_code(code) if code != "INFO-000" else "seoul_invalid_response", code)
    raise SeoulCitydataError("seoul_invalid_response")


# ── 관광 성분(선택) ───────────────────────────────────────────────────────────

# {area_nm: (만료 monotonic, KST 날짜, level)}. 집중률은 **하루 한 값**이라 10분마다 부를 이유가 없다.
_tourism_cache: dict[str, tuple[float, str, float | None]] = {}
_TOURISM_TTL_SECONDS = 6 * 3600.0
_TOURISM_FAIL_TTL_SECONDS = 3600.0
_TOURISM_TIMEOUT_SECONDS = 15.0
_TOURISM_PAGE_SIZE = 1_000
_TOURISM_MAX_PAGES = 5


def match_tourism_level(
    rows: list[dict[str, Any]], names: tuple[str, ...], date_kst: str
) -> float | None:
    """정규화 후 **정확 일치**하는 관광지의 오늘 집중률 / 100. 이름 우선순위는 names 순서."""
    by_name: dict[str, float] = {}
    for row in rows:
        if row.get("forecast_date") != date_kst:
            continue
        key = normalize_tourism_anchor_name(row.get("tourist_attraction_name"))
        if key and key not in by_name:
            by_name[key] = float(row["concentration_rate"])
    for name in names:
        key = normalize_tourism_anchor_name(name)
        if key in by_name:
            return round(max(0.0, min(1.0, by_name[key] / 100.0)), 4)
    return None


async def _load_signgu_concentration(signgu_code: int) -> list[dict[str, Any]]:
    first = await concentration_forecast(
        page=1, rows=_TOURISM_PAGE_SIZE, area_code=SEOUL_TOURISM_AREA_CODE, signgu_code=signgu_code
    )
    payloads = [first]
    pages = min(_TOURISM_MAX_PAGES, max(1, math.ceil(parse_total_count(first) / _TOURISM_PAGE_SIZE)))
    for page in range(2, pages + 1):
        payloads.append(
            await concentration_forecast(
                page=page, rows=_TOURISM_PAGE_SIZE,
                area_code=SEOUL_TOURISM_AREA_CODE, signgu_code=signgu_code,
            )
        )
    rows: list[dict[str, Any]] = []
    for payload in payloads:
        rows.extend(normalized_concentration_rows(payload))
    return rows


async def tourism_level_for(area_nm: str, *, date_kst: str) -> float | None:
    """관광공사 집중률에서 이 대상지의 오늘 기준선(0~1). **어떤 실패든 None** — 수집을 막지 않는다.

    일치하는 관광지가 없으면 None 이고, 그때 서울 추정은 주차 단독이다(§4 반영 7). 0.7/0.3 가중치를
    서울에서 정할 수 없게 되지만, 없는 관광 성분을 지어내는 것보다 낫다.
    """
    profile = target_profile(area_nm)
    if profile is None or profile.signgu_code is None or not profile.tourism_names:
        return None
    if not (settings.TOURAPI_KEY or "").strip():
        return None
    cached = _tourism_cache.get(area_nm)
    now = time.monotonic()
    if cached and cached[1] == date_kst and cached[0] > now:
        return cached[2]
    try:
        rows = await asyncio.wait_for(
            _load_signgu_concentration(profile.signgu_code), timeout=_TOURISM_TIMEOUT_SECONDS
        )
        level = match_tourism_level(rows, profile.tourism_names, date_kst)
        ttl = _TOURISM_TTL_SECONDS
    except Exception as exc:  # noqa: BLE001 — 관광 성분은 선택이다. 미승인(403)·타임아웃 모두 None
        # 예외 문자열에는 serviceKey 가 든 URL 이 섞일 수 있어 종류만 남긴다.
        logger.warning("seoul_tourism_level_unavailable", area_nm=area_nm, error_type=type(exc).__name__)
        level = None
        ttl = _TOURISM_FAIL_TTL_SECONDS
    _tourism_cache[area_nm] = (now + ttl, date_kst, level)
    return level


# ── 저장 ──────────────────────────────────────────────────────────────────────

_TABLE_MISSING_SIGNALS = ("pgrst205", "42p01", "could not find the table")


def is_missing_table(exc: BaseException) -> bool:
    """`20260920120000_seoul_citydata_snapshots.sql` 이 아직 적용되지 않았는가.

    마이그레이션은 사람이 SQL Editor 에 붙여넣는다 — API 배포가 먼저 나가는 순서가 실제로 가능하다
    (parking_derived_congestion_service._is_missing_source_migration 과 같은 상황). 그때 500 을 내면
    '서버가 고장났다' 로 읽히지만 실제로는 **할 일이 하나 남았다** 는 뜻이라 409 로 구분한다.
    컬럼 부재(42703)는 여기 넣지 않는다 — 그건 미적용이 아니라 스키마 불일치다.
    """
    code = str(getattr(exc, "code", "") or "").lower()
    if code in {"pgrst205", "42p01"}:
        return True
    text = str(getattr(exc, "message", None) or exc).lower()
    if any(signal in text for signal in _TABLE_MISSING_SIGNALS):
        return True
    return TABLE in text and "relation" in text and "does not exist" in text and "column" not in text


def _upsert_row(row: dict[str, Any]) -> None:
    # 같은 (대상지, 10분 버킷) 재호출은 최신 응답으로 덮어쓴다 — 보충 호출·수동 호출이 겹쳐도 한 행.
    supabase_admin.table(TABLE).upsert(row, on_conflict="area_nm,bucket_at").execute()


async def _persist(row: dict[str, Any]) -> None:
    try:
        await asyncio.to_thread(_upsert_row, row)
    except Exception as exc:  # noqa: BLE001 — 코드로만 넘긴다
        if is_missing_table(exc):
            raise SeoulSnapshotPersistenceError("migration_not_applied") from None
        logger.error("seoul_citydata_persist_failed", area_nm=row.get("area_nm"), error_type=type(exc).__name__)
        raise SeoulSnapshotPersistenceError("seoul_persistence_failed") from None


_LATEST_COLUMNS = (
    "area_cd,area_nm,bucket_at,observed_at,fetched_at,congest_lvl,ppltn_min,ppltn_max,"
    "live_lot_count,parking_level,tourism_level,level_est,estimator_version"
)


def _load_latest_row(area_nm: str) -> dict[str, Any] | None:
    response = (
        supabase_admin.table(TABLE)
        .select(_LATEST_COLUMNS)
        .eq("area_nm", area_nm)
        .order("bucket_at", desc=True)
        .limit(1)
        .execute()
    )
    return response.data[0] if response.data else None


async def latest_rows(targets: list[str]) -> dict[str, dict[str, Any] | None]:
    """대상지별 최신 행(주차장·예측 원문은 빼고). 표가 없으면 migration_not_applied."""
    latest: dict[str, dict[str, Any] | None] = {}
    for name in targets:
        try:
            latest[name] = await asyncio.to_thread(_load_latest_row, name)
        except Exception as exc:  # noqa: BLE001
            if is_missing_table(exc):
                raise SeoulSnapshotPersistenceError("migration_not_applied") from None
            logger.error("seoul_citydata_latest_failed", area_nm=name, error_type=type(exc).__name__)
            raise SeoulSnapshotPersistenceError("seoul_status_unavailable") from None
    return latest


# ── 수집 ──────────────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _record_failure_status(code: str, run_at: datetime) -> None:
    _status.update({"state": "failed", "last_run_at": run_at.isoformat(), "error_code": code})


async def _collect_one(
    client: httpx.AsyncClient, key: str, area_nm: str, fetched_at: datetime
) -> dict[str, Any]:
    payload = await fetch_citydata(client, key, area_nm)
    parsed = parse_citydata(payload, area_nm)
    tourism_level = await tourism_level_for(area_nm, date_kst=fetched_at.astimezone(_KST).date().isoformat())
    row, stale = build_snapshot_row(parsed, fetched_at=fetched_at, tourism_level=tourism_level)
    await _persist(row)
    return {
        "area_nm": area_nm,
        "state": "stored",
        "error_code": None,
        "upstream_code": None,
        "area_cd": row["area_cd"],
        "bucket_at": row["bucket_at"],
        "observed_at": row["observed_at"],
        "congest_lvl": row["congest_lvl"],
        "live_lot_count": row["live_lot_count"],
        "stale_lot_count": stale,
        "parking_level": row["parking_level"],
        "tourism_level": row["tourism_level"],
        "level_est": row["level_est"],
    }


async def collect_seoul_citydata(*, now: datetime | None = None) -> dict[str, Any]:
    """설정된 대상지를 한 번씩 수집해 10분 버킷에 저장한다.

    대상지 하나의 실패는 그 대상지 결과에만 남고 나머지는 계속 돈다. 예외로 끝나는 경우는
    '어느 대상지도 시도할 수 없는' 셋뿐이다 — 키 없음·대상지 없음·표 없음(마이그레이션 미적용).
    표가 없으면 첫 대상지에서 멈춘다: 나머지를 불러 봐야 저장할 곳이 없고 호출 한도만 쓴다.
    """
    run_at = now or _now()
    targets = configured_targets()
    if not key_configured():
        _record_failure_status("seoul_key_missing", run_at)
        raise SeoulCitydataError("seoul_key_missing")
    if not targets:
        _record_failure_status("seoul_targets_missing", run_at)
        raise SeoulCitydataError("seoul_targets_missing")
    key = settings.SEOUL_OPENDATA_KEY.strip()

    results: list[dict[str, Any]] = []
    # 순차 호출: 대상지 1곳 기준으로는 차이가 없고, 늘어나도 서울 API 에 동시 요청을 몰지 않는다.
    # pg_cron 요청 제한 90초 안에 끝나야 하므로 대상지는 대략 6곳(10초 × 6 + 여유)까지가 안전하다.
    async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS, follow_redirects=False) as client:
        for area_nm in targets:
            fetched_at = now or _now()
            try:
                result = await _collect_one(client, key, area_nm, fetched_at)
            except SeoulSnapshotPersistenceError as exc:
                if exc.code == "migration_not_applied":
                    _record_failure_status("migration_not_applied", run_at)
                    raise
                result = {"area_nm": area_nm, "state": "failed", "error_code": exc.code, "upstream_code": None}
            except SeoulCitydataError as exc:
                result = {
                    "area_nm": area_nm, "state": "failed",
                    "error_code": exc.code, "upstream_code": exc.upstream_code,
                }
            except Exception as exc:  # noqa: BLE001 — 한 대상지의 버그가 다른 대상지를 막지 않게
                logger.error("seoul_citydata_target_failed", area_nm=area_nm, error_type=type(exc).__name__)
                result = {"area_nm": area_nm, "state": "failed", "error_code": "unexpected_error", "upstream_code": None}
            if result["state"] == "failed":
                logger.warning(
                    "seoul_citydata_target_failed",
                    area_nm=area_nm, error_code=result["error_code"], upstream_code=result["upstream_code"],
                )
            results.append(result)

    stored = [r for r in results if r["state"] == "stored"]
    failed = [r for r in results if r["state"] == "failed"]
    state = "ok" if not failed else ("partial" if stored else "failed")
    finished_at = _now() if now is None else now
    _status["state"] = state
    _status["last_run_at"] = finished_at.isoformat()
    _status["error_code"] = failed[0]["error_code"] if failed else None
    if stored:
        _status["last_success_at"] = finished_at.isoformat()
    for result in results:
        entry = {
            "state": result["state"],
            "checked_at": finished_at.isoformat(),
            "error_code": result["error_code"],
            "upstream_code": result["upstream_code"],
        }
        if result["state"] == "stored":
            entry.update({
                "area_cd": result["area_cd"],
                "bucket_at": result["bucket_at"],
                "live_lot_count": result["live_lot_count"],
                "last_success_at": finished_at.isoformat(),
            })
        else:
            previous = _status["targets"].get(result["area_nm"], {})
            for kept in ("area_cd", "bucket_at", "live_lot_count", "last_success_at"):
                if kept in previous:
                    entry[kept] = previous[kept]
        _status["targets"][result["area_nm"]] = entry
    logger.info("seoul_citydata_collected", state=state, stored=len(stored), failed=len(failed))
    return {
        "state": state,
        "run_at": run_at.isoformat(),
        "bucket_at": bucket_start(run_at).isoformat(),
        "estimator_version": ESTIMATOR_VERSION,
        "stored_count": len(stored),
        "failed_count": len(failed),
        "targets": results,
    }
