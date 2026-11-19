"""S4 분산 결정 재생 — 반출 CSV 검증 · 구역 시계열 · 정보 집합 · 정답 조회(순수 함수, 파일 I/O 없음).

`docs/SEOUL_TESTBED_PLAN.md` §4(V3) · §6 S4. 운영 DB 는 읽기 전용이고 에이전트는 접근하지 않는다. 사람이 SQL
Editor 에서 읽기 전용 SELECT(``scripts/crowd_dispersion_replay.py sql``)로 받은 CSV 를 스크립트가 읽어
여기에 행(dict)과 파일 이름(basename)만 넘긴다.

## 검증은 운영 코드를 그대로 탄다
CSV 한 줄(+ 그 관측의 예측 행 + 대체값 표시)을 최소 CITYDATA 응답으로 다시 만들어
``seoul_citydata_service.parse_citydata``(수집기의 검증 — 이름 정규화 · 4등급 · 뒤집힌 범위 비우기)에 넣고,
``seoul_provider.observation_from_parsed`` → ``store.snapshot_row`` → ``zone_evidence.reading_from_snapshot`` 순서로
수집기가 이중 저장하는 ``zone_crowd_snapshots`` 행과 엔진이 읽는 관측을 만든다. 검증 규칙을 손으로 옮겨 적지 않는다.

## 문제는 한꺼번에, 크게
모든 문제(파일 · 줄 · 칸 · 코드 · 설명)를 모은 뒤 ``ReplayInputError`` 하나로 던진다. 잘린 반출(Q0 목록과 개수가
다름)은 오류다 — 조용히 덜 채운 기간으로 돌지 않는다. 경고는 코드별 개수로 보고서 ``inputs.warnings`` 에 남는다.

## 값을 지어내지 않는다
보간 · 앞값 채우기 · 정답 대체가 없다. 정보 집합(시각 t 에 받아 둔 행 = ``fetched_at <= t``)과 정답 조회
(도착 시각에 가장 가까운 **이후** 관측, 허용 오차 안)만 있다.
"""

from __future__ import annotations

import json
import math
import re
from bisect import bisect_left, bisect_right
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Sequence

from app.services import seoul_citydata_service as citydata
from app.services.crowd import seoul_provider
from app.services.crowd.store import snapshot_row
from app.services.crowd.zone_evidence import (
    LEVEL_BANDS,
    ZoneDefinition,
    ZoneReading,
    _SNAPSHOT_LOOKBACK,
    reading_from_snapshot,
    select_latest_reading,
)
from app.services.engine_validation_metrics import actual_grade
from app.services.kst_calendar import KST, kst_date
from app.services.spot.travel import calculate_haversine_distance

# ── CSV 모양(반출 SQL 의 별칭과 같다 — tests/scripts 가 대조한다) ─────────────────────

REQUIRED_OBS_COLUMNS: tuple[str, ...] = (
    "area_cd", "area_nm", "bucket_at", "observed_at", "fetched_at", "congest_lvl", "ppltn_min", "ppltn_max",
)
REQUIRED_FCST_COLUMNS: tuple[str, ...] = (
    "area_cd", "area_nm", "bucket_at", "fcst_time", "fcst_congest_lvl", "fcst_ppltn_min", "fcst_ppltn_max",
)
REQUIRED_COUNTS_COLUMNS: tuple[str, ...] = (
    "area_nm", "area_cd", "n_obs_total", "first_bucket_at", "last_bucket_at", "per_kst_date", "n_fcst_kept",
)
REQUIRED_REPLACED_COLUMNS: tuple[str, ...] = ("zone_id", "bucket_at", "replaced")
# Q3 행 수 목록(counts_replaced.csv) — 잘린 Q3 를 '표시 없음' 으로 읽지 않게 대조한다(S4 검토).
REQUIRED_REPLACED_COUNTS_COLUMNS: tuple[str, ...] = ("zone_id", "n_rows", "per_kst_date")

BUCKET = timedelta(minutes=10)
REGION = "seoul"

_UTC = timezone.utc
_OFFSET_SHORT = re.compile(r"([+-]\d{2})$")


# ── 입력 · 문제 ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CsvFile:
    """CSV 한 파일 — 스크립트가 읽어 넘긴다. ``name`` 은 basename(보고서에 절대 경로가 남지 않게)."""

    name: str
    header: tuple[str, ...]
    rows: tuple[Mapping[str, str], ...]
    # 각 행의 실제 줄 번호(csv.reader.line_num). 없으면 머리줄 다음부터 2, 3, … 로 센다.
    lines: tuple[int, ...] | None = None
    sha256: str | None = None
    # 칸 수가 머리줄과 다른 행의 (줄 번호, 실제 칸 수). 잘린 내려받기·손으로 고친 행이다 — 적재가 문제로 올린다
    # (빈 칸으로 메우면 NULL 처럼 읽히고, 남는 칸은 소리 없이 버려진다).
    width_mismatches: tuple[tuple[int, int], ...] = ()

    def line_of(self, index: int) -> int:
        if self.lines is not None and index < len(self.lines):
            return self.lines[index]
        return index + 2


@dataclass(frozen=True)
class Problem:
    file: str
    line: int | None
    column: str | None
    code: str
    detail: str = ""

    def format(self) -> str:
        where = self.file + (f":{self.line}" if self.line is not None else "")
        col = f" [{self.column}]" if self.column else ""
        tail = f" — {self.detail}" if self.detail else ""
        return f"{where}{col} {self.code}{tail}"


class ReplayInputError(Exception):
    """입력·설정 문제 전부. 스크립트는 전부 출력하고 종료 코드 2 로 끝난다."""

    def __init__(self, problems: Sequence[Problem]):
        self.problems = sorted(
            problems, key=lambda p: (p.file, p.line if p.line is not None else -1, p.column or "", p.code, p.detail)
        )
        super().__init__("\n".join(p.format() for p in self.problems))


# ── 구역 ──────────────────────────────────────────────────────────────────────


def cluster_names() -> tuple[str, ...]:
    return tuple(sorted({str(zone.cluster) for zone in seoul_provider.SEOUL_ZONES if zone.cluster}))


def cluster_zones(cluster: str) -> tuple[ZoneDefinition, ...]:
    """``SEOUL_ZONES`` 에서 권역 구역 → ``ZoneDefinition``(zone_id 순). 모르는 권역이면 빈 튜플."""
    zones = [
        ZoneDefinition(
            zone_id=zone.zone_id,
            region=zone.region,
            name=zone.provider_zone_name,
            provider=zone.provider,
            cluster=zone.cluster,
            centroid_lat=float(zone.centroid_lat),
            centroid_lng=float(zone.centroid_lng),
            radius_m=float(zone.radius_m) if zone.radius_m is not None else None,
        )
        for zone in seoul_provider.SEOUL_ZONES
        if zone.cluster == cluster
    ]
    return tuple(sorted(zones, key=lambda z: z.zone_id))


def provider_code_for(zone_id: str) -> str:
    return zone_id.split(":", 1)[1] if ":" in zone_id else zone_id


# ── 시각 ──────────────────────────────────────────────────────────────────────


def parse_utc(value: Any) -> datetime | None:
    """반출 시각 → aware UTC. 'YYYY-MM-DDTHH:MM:SS[.ffffff]Z' 와 Supabase 기본 'YYYY-MM-DD HH:MM:SS+00' 을 받는다.
    시간대가 없는 값은 None(어느 시각인지 모른다)."""
    text = str(value or "").strip()
    if not text:
        return None
    text = text.replace("Z", "+00:00")
    text = _OFFSET_SHORT.sub(r"\1:00", text)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(_UTC)


def iso_utc(moment: datetime | None) -> str | None:
    if moment is None:
        return None
    return moment.astimezone(_UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def ceil_minute(moment: datetime) -> datetime:
    floor = moment.replace(second=0, microsecond=0)
    return floor if floor == moment else floor + timedelta(minutes=1)


def percentile(values: Sequence[float], q: float) -> float | None:
    """가장 가까운 순위 백분위수(보간 없음). 빈 목록은 None."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(q * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]


def median_gap_minutes(moments: Sequence[datetime]) -> float | None:
    """연속한 시각 사이 간격의 중앙값(분) — engine_validation_metrics.median_bucket_gap_minutes 와 같은 규칙."""
    gaps = sorted(
        (later - earlier).total_seconds() / 60.0
        for earlier, later in zip(moments, moments[1:])
        if later > earlier
    )
    if not gaps:
        return None
    middle = len(gaps) // 2
    value = gaps[middle] if len(gaps) % 2 else (gaps[middle - 1] + gaps[middle]) / 2
    return round(value, 1)


def band_index(band: str | None) -> int | None:
    """단계 이름(relaxed…busy) → 0..3."""
    if band is None:
        return None
    try:
        return LEVEL_BANDS.index(band)
    except ValueError:
        return None


# ── 관측 레코드 ────────────────────────────────────────────────────────────────


@dataclass
class ObsRecord:
    zone_id: str
    area_nm: str
    bucket_at: datetime
    observed_at: datetime
    fetched_at: datetime
    band: int
    label: str
    ppltn_min: int | None
    ppltn_max: int | None
    replaced: bool | None
    row: dict[str, Any]
    reading: ZoneReading | None
    source: str
    line: int
    stale: bool = False


@dataclass(frozen=True)
class TruthHit:
    record: ObsRecord
    offset_minutes: float  # observed_at − 목표 시각(분, 부호 있음)


@dataclass(frozen=True)
class Travel:
    straight_m: float
    route_m: float
    minutes: int


class ZoneTimeline:
    """한 구역의 관측(버킷 순) + 정보 집합 · 정답 조회."""

    def __init__(self, zone: ZoneDefinition, records: Sequence[ObsRecord], *, tolerance: timedelta | None = None):
        self.zone = zone
        self.records = sorted(records, key=lambda r: (r.bucket_at, r.observed_at, r.fetched_at))
        self._buckets = [r.bucket_at for r in self.records]
        skew = [r.bucket_at - r.fetched_at for r in self.records if r.bucket_at > r.fetched_at]
        self._negative_skew = max(skew) if skew else timedelta(0)
        by_fetch = sorted(self.records, key=lambda r: (r.fetched_at, r.observed_at))
        self._fetch_times = [r.fetched_at for r in by_fetch]
        self._max_observed_prefix: list[datetime] = []
        running: datetime | None = None
        for record in by_fetch:
            running = record.observed_at if running is None or record.observed_at > running else running
            self._max_observed_prefix.append(running)
        self._by_obs = sorted(self.records, key=lambda r: (r.observed_at, r.fetched_at))
        self._obs_times = [r.observed_at for r in self._by_obs]
        self.cadence_minutes = median_gap_minutes(self._buckets)
        cadence = self.cadence_minutes or 10.0
        self.tolerance = tolerance if tolerance is not None else timedelta(minutes=max(5.0, cadence / 2.0))
        self._reading_cache: dict[tuple[datetime, timedelta], ZoneReading | None] = {}

    # 정보 집합 --------------------------------------------------------------

    def rows_newest_first(self, t: datetime, *, lag: timedelta = timedelta(0)) -> list[dict[str, Any]]:
        """시각 ``t − lag`` 에 받아 둔 행 가운데 ``bucket_at >= t − lag − 2h`` 인 것(최신순: bucket desc, observed desc).

        운영 ``_read_latest_rows`` 와 같은 범위·순서다. ``fetched_at > t − lag`` 인 행은 절대 보이지 않는다.
        """
        cut = t - lag
        lo = bisect_left(self._buckets, cut - _SNAPSHOT_LOOKBACK)
        hi = bisect_right(self._buckets, cut + self._negative_skew)
        rows = [r for r in self.records[lo:hi] if r.fetched_at <= cut]
        rows.sort(key=lambda r: (r.bucket_at, r.observed_at), reverse=True)
        return [r.row for r in rows]

    def latest_reading(self, t: datetime, *, lag: timedelta = timedelta(0)) -> ZoneReading | None:
        key = (t, lag)
        if key not in self._reading_cache:
            self._reading_cache[key] = select_latest_reading(self.rows_newest_first(t, lag=lag), self.zone)
        return self._reading_cache[key]

    def latest_visible_observed(self, t: datetime) -> datetime | None:
        """``fetched_at <= t`` 인 행 가운데 가장 늦은 관측 시각(룩백 무관)."""
        index = bisect_right(self._fetch_times, t)
        return self._max_observed_prefix[index - 1] if index else None

    def has_rows_before(self, t: datetime) -> bool:
        return bool(self._fetch_times) and self._fetch_times[0] <= t

    # 정답 ------------------------------------------------------------------

    def truth(
        self, target: datetime, *, t: datetime, exclude_stale: bool = False
    ) -> tuple[TruthHit | None, str | None]:
        """목표 시각 ``target`` 의 실측 단계. (적중, None) 또는 (None, 'missing' | 'not_after_decision').

        조건: 대체값 아님 · (stale 제외 시) 낡음 표시 아님 · |observed − target| ≤ 허용 오차 ·
        observed > t 에 보이던 마지막 관측 · fetched > t. 가장 가까운 것, 동점은 늦은 관측, 같은 관측이 여러
        버킷이면 늦게 받은 것. 보간 · 앞값 채우기 없음.
        """
        lo = bisect_left(self._obs_times, target - self.tolerance)
        hi = bisect_right(self._obs_times, target + self.tolerance)
        visible = self.latest_visible_observed(t)
        best: ObsRecord | None = None
        best_key: tuple | None = None
        in_window = False
        for record in self._by_obs[lo:hi]:
            if record.replaced is True or (exclude_stale and record.stale):
                continue
            in_window = True
            if visible is not None and record.observed_at <= visible:
                continue
            if record.fetched_at <= t:
                continue
            gap = abs(record.observed_at - target)
            key = (gap, -record.observed_at.timestamp(), -record.fetched_at.timestamp())
            if best_key is None or key < best_key:
                best, best_key = record, key
        if best is not None:
            return TruthHit(best, (best.observed_at - target).total_seconds() / 60.0), None
        return None, ("not_after_decision" if in_window else "missing")

    # 요약 ------------------------------------------------------------------

    def fill_rate(self) -> float | None:
        if len(self.records) < 2 or not self.cadence_minutes:
            return 1.0 if self.records else None
        span = (self._buckets[-1] - self._buckets[0]).total_seconds() / 60.0
        expected = span / self.cadence_minutes + 1
        return min(1.0, len(set(self._buckets)) / expected) if expected > 0 else None


def travel_matrix(
    zones: Sequence[ZoneDefinition], *, detour: float, speed_m_per_min: float
) -> dict[tuple[str, str], Travel]:
    """구역 중심 간 도보: 분 = ceil(직선 × detour ÷ 속도). 경로 m = 직선 × detour."""
    out: dict[tuple[str, str], Travel] = {}
    for origin in zones:
        for target in zones:
            if origin.zone_id == target.zone_id:
                continue
            straight = calculate_haversine_distance(
                origin.centroid_lat, origin.centroid_lng, target.centroid_lat, target.centroid_lng
            )
            route = straight * detour
            out[(origin.zone_id, target.zone_id)] = Travel(straight, route, int(math.ceil(route / speed_m_per_min)))
    return out


# ── 적재 결과 ─────────────────────────────────────────────────────────────────


@dataclass
class ReplayData:
    cluster: str
    zones: tuple[ZoneDefinition, ...]
    timelines: dict[str, ZoneTimeline]
    period_from: datetime | None
    period_to: datetime | None
    inputs: dict[str, Any]
    warnings: Counter = field(default_factory=Counter)
    forecasts_supplied: bool = True

    def records(self) -> list[ObsRecord]:
        return [r for zid in sorted(self.timelines) for r in self.timelines[zid].records]


@dataclass
class _ObsDraft:
    file: CsvFile
    index: int
    raw: dict[str, str]
    area_nm: str
    zone: Any
    bucket_at: datetime
    observed_at: datetime
    fetched_at: datetime


def _header_problems(file: CsvFile, required: Sequence[str]) -> list[Problem]:
    header = [h.strip() for h in file.header]
    problems = [Problem(file.name, 1, col, "missing_column") for col in required if col not in header]
    problems += [Problem(file.name, 1, col, "extra_column") for col in header if col not in required]
    dupes = [col for col, n in Counter(header).items() if n > 1]
    problems += [Problem(file.name, 1, col, "duplicate_column") for col in dupes]
    problems += [
        Problem(file.name, line, None, "row_width_mismatch", f"칸 {got}개 — 머리줄은 {len(header)}개(잘린 파일·고친 행)")
        for line, got in file.width_mismatches
    ]
    return problems


def _clean(row: Mapping[str, Any]) -> dict[str, str]:
    return {str(k).strip(): ("" if v is None else str(v).strip()) for k, v in row.items() if k is not None}


def _int_or_none(text: str) -> tuple[int | None, bool]:
    """(값, 형식이 맞았나). 빈 칸은 (None, True)."""
    if text == "":
        return None, True
    try:
        number = float(text.replace(",", ""))
    except ValueError:
        return None, False
    if not math.isfinite(number) or number < 0 or number != int(number):
        return None, False
    return int(number), True


def _kst_text(moment: datetime) -> str:
    return moment.astimezone(KST).strftime("%Y-%m-%d %H:%M:%S")


def build_payload(
    raw: Mapping[str, str], observed_at: datetime, forecasts: Sequence[Mapping[str, str]], replace_yn: str | None
) -> dict[str, Any]:
    """CSV 관측 행 + 예측 행 + 대체값 표시 → 최소 CITYDATA 응답(parse_citydata 입력)."""
    live: dict[str, Any] = {
        "AREA_CONGEST_LVL": raw.get("congest_lvl", ""),
        "PPLTN_TIME": _kst_text(observed_at),
        "AREA_PPLTN_MIN": raw.get("ppltn_min", ""),
        "AREA_PPLTN_MAX": raw.get("ppltn_max", ""),
        "FCST_PPLTN": [
            {
                "FCST_TIME": f.get("fcst_time", ""),
                "FCST_CONGEST_LVL": f.get("fcst_congest_lvl", ""),
                "FCST_PPLTN_MIN": f.get("fcst_ppltn_min", ""),
                "FCST_PPLTN_MAX": f.get("fcst_ppltn_max", ""),
            }
            for f in forecasts
        ],
    }
    if replace_yn in ("Y", "N"):
        live["REPLACE_YN"] = replace_yn
    return {
        "CITYDATA": {
            "AREA_NM": raw.get("area_nm", ""),
            "AREA_CD": raw.get("area_cd", ""),
            "LIVE_PPLTN_STTS": [live],
        }
    }


def load_replay_inputs(
    cluster: str,
    *,
    observations: Sequence[CsvFile],
    forecasts: Sequence[CsvFile] = (),
    counts: CsvFile | None,
    replaced: CsvFile | Sequence[CsvFile] | None = None,
    forecasts_enabled: bool = True,
    truth_tolerance_minutes: float | None = None,
    replaced_counts: CsvFile | None = None,
) -> ReplayData:
    """CSV → 검증된 구역 시계열. 문제가 하나라도 있으면 전부 모아 ``ReplayInputError``.

    ``replaced`` 는 Q3 조각 파일들(대체값 표시), ``replaced_counts`` 는 Q3 행 수 목록(Q3-count)이다. 조각이 하나라도
    있으면 목록이 **반드시** 있어야 하고, 구역·KST 날짜별 행 수가 목록과 같아야 한다 — 잘린 Q3 를 받으면 그 뒤 행이
    '표시 없음' 이 되어 서울시가 대체값이라고 표시한 행이 엔진 입력·정답으로 쓰인다.
    """
    problems: list[Problem] = []
    warnings: Counter = Counter()
    zones = cluster_zones(cluster)
    if not zones:
        raise ReplayInputError([Problem("<config>", None, "cluster", "unknown_cluster", f"{cluster!r} (권역: {', '.join(cluster_names())})")])
    zone_by_name = {z.name: z for z in zones}
    if counts is None:
        problems.append(Problem("counts.csv", None, None, "counts_file_missing", "Q0 목록(counts.csv)이 필요하다"))
    if not observations:
        problems.append(Problem("obs_*.csv", None, None, "observation_files_missing"))
    if forecasts_enabled and not forecasts:
        problems.append(Problem("fcst_*.csv", None, None, "forecast_files_missing", "예측 없이 돌리려면 --no-forecast"))

    # 1) 관측 행 ---------------------------------------------------------------
    drafts: dict[tuple[str, datetime], _ObsDraft] = {}
    duplicates_identical = 0
    for file in observations:
        header_issues = _header_problems(file, REQUIRED_OBS_COLUMNS)
        if header_issues:
            problems += header_issues
            continue
        for index, raw_row in enumerate(file.rows):
            raw = _clean(raw_row)
            line = file.line_of(index)
            area_nm = " ".join(raw.get("area_nm", "").split())
            zone = seoul_provider.zone_for_name(area_nm)
            row_ok = True
            if zone is None:
                problems.append(Problem(file.name, line, "area_nm", "unknown_site", area_nm))
                row_ok = False
            elif zone.cluster != cluster:
                problems.append(Problem(file.name, line, "area_nm", "site_not_in_cluster", f"{area_nm} ∈ {zone.cluster}"))
                row_ok = False
            stamps: dict[str, datetime] = {}
            for column in ("bucket_at", "observed_at", "fetched_at"):
                value = parse_utc(raw.get(column))
                if value is None:
                    problems.append(Problem(file.name, line, column, "bad_timestamp", raw.get(column, "")))
                    row_ok = False
                else:
                    stamps[column] = value
            bucket = stamps.get("bucket_at")
            if bucket is not None and (bucket.minute % 10 or bucket.second or bucket.microsecond):
                problems.append(Problem(file.name, line, "bucket_at", "bucket_not_10min", raw.get("bucket_at", "")))
                row_ok = False
            if not row_ok:
                continue
            key = (area_nm, bucket)
            previous = drafts.get(key)
            if previous is not None:
                if previous.raw == raw:
                    duplicates_identical += 1
                else:
                    problems.append(Problem(
                        file.name, line, None, "conflicting_duplicate",
                        f"{area_nm} {iso_utc(bucket)} ≠ {previous.file.name}:{previous.file.line_of(previous.index)}",
                    ))
                continue
            drafts[key] = _ObsDraft(
                file, index, raw, area_nm, zone, bucket, stamps["observed_at"], stamps["fetched_at"]
            )

    # 2) 예측 행 ---------------------------------------------------------------
    fcst_by_obs: dict[tuple[str, datetime], dict[str, dict[str, str]]] = {}
    fcst_rows_per_site: Counter = Counter()
    if forecasts_enabled:
        for file in forecasts:
            header_issues = _header_problems(file, REQUIRED_FCST_COLUMNS)
            if header_issues:
                problems += header_issues
                continue
            for index, raw_row in enumerate(file.rows):
                raw = _clean(raw_row)
                line = file.line_of(index)
                area_nm = " ".join(raw.get("area_nm", "").split())
                bucket = parse_utc(raw.get("bucket_at"))
                if bucket is None:
                    problems.append(Problem(file.name, line, "bucket_at", "bad_timestamp", raw.get("bucket_at", "")))
                    continue
                key = (area_nm, bucket)
                if key not in drafts:
                    problems.append(Problem(
                        file.name, line, None, "forecast_without_observation", f"{area_nm} {iso_utc(bucket)}"
                    ))
                    continue
                label = " ".join(raw.get("fcst_congest_lvl", "").split())
                if label and actual_grade(label) is None:
                    warnings["unknown_forecast_label"] += 1
                slot = fcst_by_obs.setdefault(key, {})
                target_key = raw.get("fcst_time", "")
                if target_key in slot:
                    if slot[target_key] == raw:
                        duplicates_identical += 1
                    else:
                        problems.append(Problem(
                            file.name, line, None, "conflicting_duplicate",
                            f"예측 {area_nm} {iso_utc(bucket)} {target_key}",
                        ))
                    continue
                slot[target_key] = raw
                fcst_rows_per_site[area_nm] += 1

    # 3) 대체값 표시(선택) — Q3 조각 + Q3-count 목록 ------------------------------------
    replaced_files: list[CsvFile] = (
        [] if replaced is None else [replaced] if isinstance(replaced, CsvFile) else list(replaced)
    )
    zone_ids = {z.zone_id for z in zones}
    replace_flags: dict[tuple[str, datetime], str | None] = {}
    replaced_per_day: dict[str, Counter] = {}
    for file in replaced_files:
        header_issues = _header_problems(file, REQUIRED_REPLACED_COLUMNS)
        if header_issues:
            problems += header_issues
            continue
        for index, raw_row in enumerate(file.rows):
            raw = _clean(raw_row)
            line = file.line_of(index)
            zone_id = raw.get("zone_id", "")
            if zone_id not in zone_ids:
                problems.append(Problem(file.name, line, "zone_id", "zone_not_in_cluster", zone_id))
                continue
            bucket = parse_utc(raw.get("bucket_at"))
            if bucket is None:
                problems.append(Problem(file.name, line, "bucket_at", "bad_timestamp", raw.get("bucket_at", "")))
                continue
            flag = raw.get("replaced", "").lower()
            if flag not in ("true", "false", ""):
                problems.append(Problem(file.name, line, "replaced", "bad_replaced_flag", flag))
                continue
            value = {"true": "Y", "false": "N"}.get(flag)
            key = (zone_id, bucket)
            if key in replace_flags:
                if replace_flags[key] == value:
                    duplicates_identical += 1
                else:
                    problems.append(Problem(file.name, line, None, "conflicting_duplicate",
                                            f"대체값 표시 {zone_id} {iso_utc(bucket)}"))
                continue
            replace_flags[key] = value
            replaced_per_day.setdefault(zone_id, Counter())[kst_date(bucket).isoformat()] += 1
    if replaced_files and replaced_counts is None:
        problems.append(Problem(
            "counts_replaced.csv", None, None, "replaced_counts_missing",
            "Q3 조각이 있으면 Q3-count 목록(counts_replaced.csv)도 필요하다 — 잘린 Q3 를 '표시 없음' 으로 읽지 않게",
        ))
    if replaced_counts is not None:
        problems += _check_replaced_counts(replaced_counts, replaced_per_day, zone_ids, has_files=bool(replaced_files))

    # 4) 운영 검증 사슬 ---------------------------------------------------------
    records_by_zone: dict[str, list[ObsRecord]] = {z.zone_id: [] for z in zones}
    flag_stats: dict[str, dict[str, Any]] = {
        z.zone_id: {"rows": 0, "rows_with_flag": 0, "first_flagged_bucket": None} for z in zones
    }
    for key in sorted(drafts, key=lambda k: (k[0], k[1])):
        draft = drafts[key]
        zone_def = zone_by_name[draft.area_nm]
        raw = draft.raw
        line = draft.file.line_of(draft.index)
        fc_rows = [fcst_by_obs.get(key, {})[k] for k in sorted(fcst_by_obs.get(key, {}))]
        replace_yn = replace_flags.get((zone_def.zone_id, draft.bucket_at))
        payload = build_payload(raw, draft.observed_at, fc_rows, replace_yn)
        try:
            parsed = citydata.parse_citydata(payload, zone_def.name)
        except citydata.SeoulCitydataError as exc:
            congest = " ".join(raw.get("congest_lvl", "").split())
            if congest not in citydata.CONGEST_LEVELS:
                problems.append(Problem(draft.file.name, line, "congest_lvl", "invalid_congest_lvl", raw.get("congest_lvl", "")))
            else:
                problems.append(Problem(draft.file.name, line, None, f"parse_citydata:{exc.code}"))
            continue
        low, low_ok = _int_or_none(raw.get("ppltn_min", ""))
        high, high_ok = _int_or_none(raw.get("ppltn_max", ""))
        if not (low_ok and high_ok):
            warnings["population_unparsed"] += 1
        if low is not None and high is not None and low > high:
            warnings["inverted_population_range"] += 1
        if draft.observed_at > draft.fetched_at:
            warnings["future_observation"] += 1
        if draft.fetched_at < draft.bucket_at:
            warnings["fetched_before_bucket"] += 1
        area_cd = raw.get("area_cd", "")
        if area_cd and area_cd != provider_code_for(zone_def.zone_id):
            warnings["provider_zone_code_mismatch"] += 1
        observation = seoul_provider.observation_from_parsed(parsed, fetched_at=draft.fetched_at)
        if observation is None:  # 이름이 SEOUL_ZONES 에 있으니 생기지 않는다 — 그래도 조용히 넘기지 않는다
            problems.append(Problem(draft.file.name, line, "area_nm", "zone_unresolved", draft.area_nm))
            continue
        row = snapshot_row(observation, bucket_at=draft.bucket_at)
        reading = reading_from_snapshot(row, zone_def)
        grade = actual_grade(parsed["congest_lvl"])
        stats = flag_stats[zone_def.zone_id]
        stats["rows"] += 1
        if replace_yn in ("Y", "N"):
            stats["rows_with_flag"] += 1
            first = stats["first_flagged_bucket"]
            stats["first_flagged_bucket"] = draft.bucket_at if first is None or draft.bucket_at < first else first
        records_by_zone[zone_def.zone_id].append(ObsRecord(
            zone_id=zone_def.zone_id,
            area_nm=zone_def.name,
            bucket_at=draft.bucket_at,
            observed_at=draft.observed_at,
            fetched_at=draft.fetched_at,
            band=int(grade) if grade is not None else -1,
            label=parsed["congest_lvl"],
            ppltn_min=parsed.get("ppltn_min"),
            ppltn_max=parsed.get("ppltn_max"),
            replaced=(replace_yn == "Y") if replace_yn in ("Y", "N") else None,
            row=row,
            reading=reading,
            source=draft.file.name,
            line=line,
        ))

    # 5) Q0 목록 대조(a~e) -------------------------------------------------------
    period_from: datetime | None = None
    period_to: datetime | None = None
    if counts is not None:
        header_issues = _header_problems(counts, REQUIRED_COUNTS_COLUMNS)
        if header_issues:
            problems += header_issues
        else:
            obs_per_day: dict[str, Counter] = {}
            for (area_nm, bucket) in drafts:
                obs_per_day.setdefault(area_nm, Counter())[kst_date(bucket).isoformat()] += 1
            seen_sites: set[str] = set()
            for index, raw_row in enumerate(counts.rows):
                raw = _clean(raw_row)
                line = counts.line_of(index)
                area_nm = " ".join(raw.get("area_nm", "").split())
                zone = seoul_provider.zone_for_name(area_nm)
                if zone is None:
                    problems.append(Problem(counts.name, line, "area_nm", "unknown_site", area_nm))
                    continue
                if zone.cluster != cluster:
                    problems.append(Problem(counts.name, line, "area_nm", "site_not_in_cluster", area_nm))
                    continue
                if area_nm in seen_sites:
                    problems.append(Problem(counts.name, line, "area_nm", "duplicate_manifest_row", area_nm))
                    continue
                seen_sites.add(area_nm)
                total, total_ok = _int_or_none(raw.get("n_obs_total", ""))
                kept, kept_ok = _int_or_none(raw.get("n_fcst_kept", ""))
                first = parse_utc(raw.get("first_bucket_at"))
                last = parse_utc(raw.get("last_bucket_at"))
                try:
                    per_day_raw = json.loads(raw.get("per_kst_date", "") or "null")
                except json.JSONDecodeError:
                    per_day_raw = None
                if not (total_ok and kept_ok and total is not None and kept is not None and first and last
                        and isinstance(per_day_raw, dict)):
                    problems.append(Problem(counts.name, line, None, "bad_manifest_row", area_nm))
                    continue
                period_from = first if period_from is None or first < period_from else period_from
                period_to = last if period_to is None or last > period_to else period_to
                manifest_days = {str(d): int(n) for d, n in per_day_raw.items()}
                actual_days = obs_per_day.get(area_nm, Counter())
                missing_in_manifest = sorted(set(actual_days) - set(manifest_days))
                missing_in_obs = sorted(d for d in set(manifest_days) - set(actual_days) if manifest_days[d] > 0)
                differing = sorted(
                    d for d in set(manifest_days) & set(actual_days) if manifest_days[d] != actual_days[d]
                )
                if missing_in_manifest:
                    problems.append(Problem(counts.name, line, "per_kst_date", "export_truncated_or_partial",
                                            f"{area_nm}: 관측 날짜가 목록에 없다 {', '.join(missing_in_manifest)}"))
                if missing_in_obs:
                    problems.append(Problem(counts.name, line, "per_kst_date", "export_truncated_or_partial",
                                            f"{area_nm}: 목록 날짜의 관측이 없다 {', '.join(missing_in_obs)}"))
                if differing:
                    detail = ", ".join(f"{d} {actual_days[d]}/{manifest_days[d]}" for d in differing)
                    problems.append(Problem(counts.name, line, "per_kst_date", "export_truncated_or_partial",
                                            f"{area_nm}: 날짜별 행 수가 다르다(받음/목록) {detail}"))
                if sum(actual_days.values()) != total:
                    problems.append(Problem(counts.name, line, "n_obs_total", "export_truncated_or_partial",
                                            f"{area_nm}: 관측 {sum(actual_days.values())}행 ≠ 목록 {total}"))
                if forecasts_enabled and fcst_rows_per_site.get(area_nm, 0) != kept:
                    problems.append(Problem(counts.name, line, "n_fcst_kept", "export_truncated_or_partial",
                                            f"{area_nm}: 예측 {fcst_rows_per_site.get(area_nm, 0)}행 ≠ 목록 {kept}"))
            for zone in zones:
                if zone.name not in seen_sites:
                    problems.append(Problem(counts.name, None, "area_nm", "export_truncated_or_partial",
                                            f"{zone.name}: 목록(Q0)에 행이 없다"))

    if problems:
        raise ReplayInputError(problems)

    timelines: dict[str, ZoneTimeline] = {}
    tolerance = timedelta(minutes=truth_tolerance_minutes) if truth_tolerance_minutes is not None else None
    for zone in zones:
        records = records_by_zone[zone.zone_id]
        flag_stale(records)
        timelines[zone.zone_id] = ZoneTimeline(zone, records, tolerance=tolerance)

    replace_summary = {}
    for zone in zones:
        stats = flag_stats[zone.zone_id]
        replace_summary[zone.zone_id] = {
            "rows": stats["rows"],
            "rows_with_flag": stats["rows_with_flag"],
            "first_flagged_bucket": iso_utc(stats["first_flagged_bucket"]),
            "coverage": (stats["rows_with_flag"] / stats["rows"]) if stats["rows"] else 0.0,
        }

    def _file_entry(file: CsvFile) -> dict[str, Any]:
        return {"name": file.name, "sha256": file.sha256, "rows": len(file.rows)}

    inputs = {
        "observation_files": sorted((_file_entry(f) for f in observations), key=lambda e: e["name"]),
        "forecast_files": sorted((_file_entry(f) for f in forecasts), key=lambda e: e["name"]) if forecasts_enabled else [],
        "counts_file": _file_entry(counts) if counts is not None else None,
        "replaced_files": sorted((_file_entry(f) for f in replaced_files), key=lambda e: e["name"]),
        "replaced_counts_file": _file_entry(replaced_counts) if replaced_counts is not None else None,
        "rows_total": sum(len(timelines[z.zone_id].records) for z in zones),
        "forecast_rows_total": sum(fcst_rows_per_site.values()) if forecasts_enabled else 0,
        "duplicates_identical": duplicates_identical,
        "warnings": dict(sorted(warnings.items())),
        "replace_flags": {"per_zone": replace_summary},
        "forecast": "supplied" if forecasts_enabled else "disabled",
    }
    return ReplayData(
        cluster=cluster,
        zones=zones,
        timelines=timelines,
        period_from=period_from,
        period_to=period_to,
        inputs=inputs,
        warnings=warnings,
        forecasts_supplied=forecasts_enabled,
    )


def _check_replaced_counts(
    manifest: CsvFile, received: Mapping[str, Counter], zone_ids: set[str], *, has_files: bool,
) -> list[Problem]:
    """Q3-count 목록 대조 — 구역별 총 행 수와 KST 날짜별 행 수가 받은 Q3 조각과 같아야 한다."""
    header_issues = _header_problems(manifest, REQUIRED_REPLACED_COUNTS_COLUMNS)
    if header_issues:
        return header_issues
    problems: list[Problem] = []
    seen: set[str] = set()
    for index, raw_row in enumerate(manifest.rows):
        raw = _clean(raw_row)
        line = manifest.line_of(index)
        zone_id = raw.get("zone_id", "")
        if zone_id not in zone_ids:
            problems.append(Problem(manifest.name, line, "zone_id", "zone_not_in_cluster", zone_id))
            continue
        if zone_id in seen:
            problems.append(Problem(manifest.name, line, "zone_id", "duplicate_manifest_row", zone_id))
            continue
        seen.add(zone_id)
        total, total_ok = _int_or_none(raw.get("n_rows", ""))
        try:
            per_day_raw = json.loads(raw.get("per_kst_date", "") or "null")
        except json.JSONDecodeError:
            per_day_raw = None
        if not (total_ok and total is not None and isinstance(per_day_raw, dict)):
            problems.append(Problem(manifest.name, line, None, "bad_manifest_row", zone_id))
            continue
        expected = {str(d): int(n) for d, n in per_day_raw.items()}
        actual = received.get(zone_id, Counter())
        if total > 0 and not has_files:
            problems.append(Problem(manifest.name, line, "n_rows", "export_truncated_or_partial",
                                    f"{zone_id}: 목록은 {total}행인데 Q3 조각(replaced_*.csv)이 없다"))
            continue
        differing = sorted(d for d in set(expected) | set(actual) if expected.get(d, 0) != actual.get(d, 0))
        if differing:
            detail = ", ".join(f"{d} {actual.get(d, 0)}/{expected.get(d, 0)}" for d in differing[:10])
            problems.append(Problem(manifest.name, line, "per_kst_date", "export_truncated_or_partial",
                                    f"{zone_id}: 대체값 표시 날짜별 행 수가 다르다(받음/목록) {detail}"))
        if sum(actual.values()) != total:
            problems.append(Problem(manifest.name, line, "n_rows", "export_truncated_or_partial",
                                    f"{zone_id}: 대체값 표시 {sum(actual.values())}행 ≠ 목록 {total}"))
    for zone_id in sorted(set(received) - seen):
        problems.append(Problem(manifest.name, None, "zone_id", "export_truncated_or_partial",
                                f"{zone_id}: Q3 조각에 행이 있는데 목록(Q3-count)에 없다"))
    return problems


STALE_RUN_MIN_BUCKETS = 3


def flag_stale(records: list[ObsRecord], min_run: int = STALE_RUN_MIN_BUCKETS) -> None:
    """같은 관측 시각이 이어지거나 (등급, 인구 하한, 상한)이 그대로인 연속 버킷 ``min_run`` 개 이상 →
    둘째 행부터 낡음 표시(정답 민감도 'stale_excluded' 에서만 뺀다 — 기술 통계)."""
    ordered = sorted(records, key=lambda r: (r.bucket_at, r.observed_at))

    def _same(a: ObsRecord, b: ObsRecord) -> bool:
        if a.observed_at == b.observed_at:
            return True
        return (a.label, a.ppltn_min, a.ppltn_max) == (b.label, b.ppltn_min, b.ppltn_max) and a.ppltn_min is not None

    start = 0
    for index in range(1, len(ordered) + 1):
        if index < len(ordered) and _same(ordered[index - 1], ordered[index]):
            continue
        if index - start >= min_run:
            for record in ordered[start + 1:index]:
                record.stale = True
        start = index


def zone_summaries(data: ReplayData) -> list[dict[str, Any]]:
    """구역별 데이터 품질(V1 모양 — 보고용)."""
    out = []
    for zone in data.zones:
        timeline = data.timelines[zone.zone_id]
        records = timeline.records
        lags = [(r.fetched_at - r.observed_at).total_seconds() / 60.0 for r in records]
        overshoot = [
            (r.fetched_at - (r.bucket_at + BUCKET)).total_seconds() / 60.0
            for r in records if r.fetched_at > r.bucket_at + BUCKET
        ]
        out.append({
            "zone_id": zone.zone_id,
            "name": zone.name,
            "area_cd": provider_code_for(zone.zone_id),
            "cadence_minutes_median": timeline.cadence_minutes,
            "truth_tolerance_minutes": timeline.tolerance.total_seconds() / 60.0,
            "rows": len(records),
            "first_bucket_at": iso_utc(records[0].bucket_at) if records else None,
            "last_bucket_at": iso_utc(records[-1].bucket_at) if records else None,
            "fill_rate": timeline.fill_rate(),
            "lag_minutes_p50": percentile(lags, 0.5),
            "lag_minutes_p90": percentile(lags, 0.9),
            "fetched_after_bucket_end": {"n": len(overshoot), "p99_overshoot_minutes": percentile(overshoot, 0.99)},
            "stale_rows": sum(1 for r in records if r.stale),
            "replaced_rows": sum(1 for r in records if r.replaced is True),
        })
    return out


def service_days_span(data: ReplayData, service_day_fn) -> list[date]:
    """재생 기간이 덮는 서비스 날짜 전부(부트스트랩 블록 열쇠 — 결정이 없는 날도 자리를 갖는다)."""
    buckets = [r.bucket_at for r in data.records()]
    if not buckets:
        return []
    first = service_day_fn(min(buckets))
    last = service_day_fn(max(buckets) + timedelta(hours=2))
    days = []
    current = first
    while current <= last:
        days.append(current)
        current += timedelta(days=1)
    return days


def iter_zone_ids(data: ReplayData) -> Iterable[str]:
    return (z.zone_id for z in data.zones)
