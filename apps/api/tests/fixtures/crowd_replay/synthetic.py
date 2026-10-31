"""S4 재생 테스트용 **합성** 반출 CSV 생성기(실제 데이터 아님 — 형식만 반출 SQL 을 따른다).

``write_export(tmp_path, cluster, ...)`` 가 counts.csv · obs_<site>.csv · fcst_<site>.csv 를 반출 SQL 의 별칭 그대로 만든다.
등급은 ``band_fn(zone_index, kst_datetime) -> 0..3`` 이 정한다. 예측은 정시(KST) 대상이 [관측, 관측+3시간] 인 점만 —
반출 Q2 와 같은 범위다. 목록(counts.csv)은 만든 행에서 계산하므로 언제나 맞는다(잘림 테스트는 일부러 지운다).
"""

from __future__ import annotations

import csv
import json
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

KST = timezone(timedelta(hours=9))
UTC = timezone.utc
LABELS = ("여유", "보통", "약간 붐빔", "붐빔")
OBS_HEADER = ["area_cd", "area_nm", "bucket_at", "observed_at", "fetched_at", "congest_lvl", "ppltn_min", "ppltn_max"]
FCST_HEADER = ["area_cd", "area_nm", "bucket_at", "fcst_time", "fcst_congest_lvl", "fcst_ppltn_min", "fcst_ppltn_max"]
COUNTS_HEADER = ["area_nm", "area_cd", "n_obs_total", "first_bucket_at", "last_bucket_at", "per_kst_date", "n_fcst_kept"]

CLUSTER_SITES = {
    "hongdae": [("POI007", "홍대 관광특구"), ("POI073", "연남동"), ("POI053", "합정역")],
    "jongno": [("POI008", "경복궁"), ("POI066", "북촌한옥마을"), ("POI078", "인사동"), ("POI012", "창덕궁·종묘")],
}


def utc_text(moment: datetime, *, micros: bool = False) -> str:
    moment = moment.astimezone(UTC)
    if micros:
        return moment.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def default_band(zone_index: int, local: datetime) -> int:
    """구역마다 위상이 다른 하루 곡선 — 붐비는 출발지와 덜 붐비는 이웃이 자주 생긴다."""
    hour = local.hour + local.minute / 60.0
    shift = (zone_index * 5) % 24
    phase = (hour + shift) % 24
    if 11 <= phase < 15:
        return 3
    if 9 <= phase < 11 or 15 <= phase < 18:
        return 2
    if 7 <= phase < 9 or 18 <= phase < 21:
        return 1
    return 0


def write_csv(path: Path, header: list[str], rows: list[list], *, bom: bool = False) -> None:
    with path.open("w", encoding="utf-8-sig" if bom else "utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)


def write_export(
    folder: Path,
    cluster: str,
    *,
    start: date = date(2026, 9, 20),
    days: int = 2,
    cadence_minutes: int = 10,
    band_fn: Callable[[int, datetime], int] = default_band,
    fetch_delay_seconds: int = 60,
    observed_lag_minutes: int = 5,
    forecasts: bool = True,
    forecast_band_fn: Callable[[int, datetime], int] | None = None,
    skip: Callable[[int, datetime], bool] | None = None,
) -> dict[str, list[list]]:
    """폴더에 반출 CSV 를 쓴다. 돌려주는 값은 대상지별 관측 행(테스트가 고쳐 쓸 수 있게)."""
    folder.mkdir(parents=True, exist_ok=True)
    sites = CLUSTER_SITES[cluster]
    begin = datetime(start.year, start.month, start.day, tzinfo=KST)
    end = begin + timedelta(days=days)
    counts_rows = []
    out: dict[str, list[list]] = {}
    fcst_fn = forecast_band_fn or band_fn
    for index, (code, name) in enumerate(sites):
        obs_rows, fcst_rows = [], []
        per_day: Counter = Counter()
        moment = begin
        while moment < end:
            if skip is None or not skip(index, moment):
                bucket = moment.astimezone(UTC)
                observed = (moment - timedelta(minutes=observed_lag_minutes)).replace(second=0)
                fetched = bucket + timedelta(seconds=fetch_delay_seconds)
                band = band_fn(index, observed)
                wiggle = 10 * ((moment.hour * 6 + moment.minute // 10) % 7)  # 인구가 버킷마다 조금씩 달라 '낡음'이 아니다
                obs_rows.append([
                    code, name, utc_text(bucket), utc_text(observed), utc_text(fetched, micros=True),
                    LABELS[band], 1000 * (band + 1) + wiggle, 1000 * (band + 1) + 500 + wiggle,
                ])
                per_day[moment.date().isoformat()] += 1
                if forecasts:
                    hour = observed.replace(minute=0, second=0) + timedelta(hours=1)
                    while hour <= observed + timedelta(hours=3):
                        fband = fcst_fn(index, hour)
                        fcst_rows.append([
                            code, name, utc_text(bucket), hour.strftime("%Y-%m-%d %H:%M"), LABELS[fband],
                            1000 * (fband + 1), 1000 * (fband + 1) + 500,
                        ])
                        hour += timedelta(hours=1)
            moment += timedelta(minutes=cadence_minutes)
        slug = "_".join(name.split())
        write_csv(folder / f"obs_{slug}.csv", OBS_HEADER, obs_rows)
        if forecasts:
            write_csv(folder / f"fcst_{slug}.csv", FCST_HEADER, fcst_rows)
        if obs_rows:
            counts_rows.append([
                name, code, len(obs_rows), obs_rows[0][2], obs_rows[-1][2],
                json.dumps(dict(sorted(per_day.items())), ensure_ascii=False), len(fcst_rows),
            ])
        out[name] = obs_rows
    write_csv(folder / "counts.csv", COUNTS_HEADER, counts_rows)
    return out


# ── 메모리 입력(손으로 짠 장면) ────────────────────────────────────────────────


def obs_row(
    name: str, bucket_kst: datetime, band: int, *, observed_offset_min: float = 1.0, fetched_offset_s: float = 120.0,
    ppltn: tuple[int | str, int | str] | None = None, label: str | None = None,
) -> dict[str, str]:
    """관측 CSV 한 행(dict). 관측 = 버킷 + ``observed_offset_min``, 받은 시각 = 버킷 + ``fetched_offset_s``."""
    code = {n: c for sites in CLUSTER_SITES.values() for c, n in sites}[name]
    bucket = bucket_kst.astimezone(UTC)
    observed = bucket + timedelta(minutes=observed_offset_min)
    fetched = bucket + timedelta(seconds=fetched_offset_s)
    low, high = ppltn if ppltn is not None else (
        1000 * (band + 1) + bucket_kst.minute, 1000 * (band + 1) + 500 + bucket_kst.minute
    )
    return {
        "area_cd": code, "area_nm": name, "bucket_at": utc_text(bucket), "observed_at": utc_text(observed),
        "fetched_at": utc_text(fetched, micros=True), "congest_lvl": label if label is not None else LABELS[band],
        "ppltn_min": str(low), "ppltn_max": str(high),
    }


def fcst_row(obs: dict[str, str], target_kst: datetime, band: int | None) -> dict[str, str]:
    return {
        "area_cd": obs["area_cd"], "area_nm": obs["area_nm"], "bucket_at": obs["bucket_at"],
        "fcst_time": target_kst.strftime("%Y-%m-%d %H:%M"), "fcst_congest_lvl": LABELS[band] if band is not None else "",
        "fcst_ppltn_min": "", "fcst_ppltn_max": "",
    }


def counts_rows(obs_rows: list[dict[str, str]], fcst_rows: list[dict[str, str]] = ()) -> list[dict[str, str]]:
    """관측·예측 행에서 Q0 목록을 계산한다(언제나 맞는 목록)."""
    by_site: dict[str, list[dict[str, str]]] = {}
    for row in obs_rows:
        by_site.setdefault(row["area_nm"], []).append(row)
    fcst_count = Counter(row["area_nm"] for row in fcst_rows)
    out = []
    for name, rows in sorted(by_site.items()):
        buckets = sorted(row["bucket_at"] for row in rows)
        per_day = Counter(
            datetime.fromisoformat(b.replace("Z", "+00:00")).astimezone(KST).date().isoformat() for b in buckets
        )
        out.append({
            "area_nm": name, "area_cd": rows[0]["area_cd"], "n_obs_total": str(len(rows)),
            "first_bucket_at": buckets[0], "last_bucket_at": buckets[-1],
            "per_kst_date": json.dumps(dict(sorted(per_day.items())), ensure_ascii=False),
            "n_fcst_kept": str(fcst_count.get(name, 0)),
        })
    return out


def csv_file(name: str, header: list[str], rows: list[dict[str, str]]):
    from app.services.batch.crowd_replay_data import CsvFile

    return CsvFile(name, tuple(header), tuple(rows), None, "0" * 64)


def memory_inputs(
    obs_rows: list[dict[str, str]], fcst_rows: list[dict[str, str]] = (), *, counts: list[dict[str, str]] | None = None,
) -> dict:
    """load_replay_inputs 키워드 인자(메모리 CsvFile). 예측 행이 없으면 forecasts_enabled=False."""
    return {
        "observations": [csv_file("obs_test.csv", OBS_HEADER, list(obs_rows))],
        "forecasts": [csv_file("fcst_test.csv", FCST_HEADER, list(fcst_rows))] if fcst_rows else [],
        "counts": csv_file("counts.csv", COUNTS_HEADER, counts if counts is not None else counts_rows(obs_rows, fcst_rows)),
        "forecasts_enabled": bool(fcst_rows),
    }


def steady_rows(
    cluster: str, start_kst: datetime, buckets: int, bands: dict[str, int], *, cadence_minutes: int = 10, **kw
) -> list[dict[str, str]]:
    """대상지마다 같은 등급이 이어지는 관측 행."""
    rows = []
    for name, band in bands.items():
        for i in range(buckets):
            rows.append(obs_row(name, start_kst + timedelta(minutes=cadence_minutes * i), band, **kw))
    return rows
