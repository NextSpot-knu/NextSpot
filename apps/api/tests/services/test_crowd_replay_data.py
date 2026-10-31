"""S4 재생 입력 — 반출 CSV 검증(운영 parse_citydata 사슬) · 목록 대조 · 정보 집합 · 정답 · 이동 행렬."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.services import seoul_citydata_service as citydata
from app.services.batch import crowd_replay_data as data_mod
from app.services.batch.crowd_replay_data import (
    CsvFile,
    ReplayInputError,
    cluster_zones,
    load_replay_inputs,
    parse_utc,
    travel_matrix,
)
from app.services.crowd import seoul_provider
from app.services.crowd.store import snapshot_row
from app.services.crowd.zone_evidence import reading_from_snapshot
from tests.fixtures.crowd_replay.synthetic import (
    COUNTS_HEADER,
    FCST_HEADER,
    KST,
    OBS_HEADER,
    counts_rows,
    csv_file,
    fcst_row,
    memory_inputs,
    obs_row,
    steady_rows,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
T0 = datetime(2026, 9, 20, 14, 0, tzinfo=KST)
HONG, YEON, HAP = "홍대 관광특구", "연남동", "합정역"


def _codes(exc: ReplayInputError) -> list[str]:
    return [p.code for p in exc.problems]


def _load(obs, fcst=(), **kw):
    return load_replay_inputs("hongdae", **{**memory_inputs(obs, fcst), **kw})


def _load_problems(obs) -> ReplayInputError:
    with pytest.raises(ReplayInputError) as info:
        _load(obs)
    return info.value


# ── 형식 ──────────────────────────────────────────────────────────────────────


def test_missing_and_extra_columns_are_both_reported():
    rows = steady_rows("hongdae", T0, 2, {HONG: 1})
    header = [c for c in OBS_HEADER if c != "ppltn_max"] + ["prk"]
    files = memory_inputs(rows)
    files["observations"] = [CsvFile("obs_bad.csv", tuple(header), tuple(rows))]
    with pytest.raises(ReplayInputError) as info:
        load_replay_inputs("hongdae", **files)
    codes = _codes(info.value)
    assert "missing_column" in codes and "extra_column" in codes
    assert any(p.column == "ppltn_max" and p.file == "obs_bad.csv" for p in info.value.problems)


def test_bad_congest_level_goes_through_parse_citydata_with_file_and_line(monkeypatch):
    calls = []
    real = citydata.parse_citydata

    def _spy(payload, name):
        calls.append(name)
        return real(payload, name)

    monkeypatch.setattr(citydata, "parse_citydata", _spy)
    rows = steady_rows("hongdae", T0, 3, {HONG: 1})
    rows[1]["congest_lvl"] = "매우 붐빔"
    with pytest.raises(ReplayInputError) as info:
        _load(rows)
    problem = next(p for p in info.value.problems if p.code == "invalid_congest_lvl")
    assert (problem.file, problem.line, problem.column) == ("obs_test.csv", 3, "congest_lvl")
    assert calls  # 운영 검증기를 실제로 탔다
    assert "obs_test.csv:3" in str(info.value)


def test_unknown_and_out_of_cluster_sites_and_non_10min_bucket_are_listed_together():
    rows = steady_rows("hongdae", T0, 2, {HONG: 1})
    rows.append({**obs_row(HONG, T0, 1), "area_nm": "없는 곳"})
    rows.append(obs_row("경복궁", T0, 1))
    odd = obs_row(YEON, T0, 1)
    odd["bucket_at"] = "2026-09-20T05:05:00Z"
    rows.append(odd)
    codes = _codes(_load_problems(rows))
    assert {"unknown_site", "site_not_in_cluster", "bucket_not_10min"} <= set(codes)


def test_identical_duplicates_merge_and_conflicting_duplicates_fail():
    rows = steady_rows("hongdae", T0, 2, {HONG: 1, YEON: 0, HAP: 0})
    same = dict(rows[0])
    files = memory_inputs(rows)
    files["observations"].append(csv_file("obs_dup.csv", OBS_HEADER, [same]))
    data = load_replay_inputs("hongdae", **files)
    assert data.inputs["duplicates_identical"] == 1

    other = {**rows[0], "congest_lvl": "붐빔"}
    files = memory_inputs(rows)
    files["observations"].append(csv_file("obs_dup.csv", OBS_HEADER, [other]))
    with pytest.raises(ReplayInputError) as info:
        load_replay_inputs("hongdae", **files)
    assert "conflicting_duplicate" in _codes(info.value)


def test_orphan_forecast_row_is_an_error():
    rows = steady_rows("hongdae", T0, 2, {HONG: 1, YEON: 0, HAP: 0})
    orphan = fcst_row({**rows[0], "bucket_at": "2026-09-01T00:00:00Z"}, T0 + timedelta(hours=1), 2)
    good = fcst_row(rows[0], T0 + timedelta(hours=1), 2)
    with pytest.raises(ReplayInputError) as info:
        _load(rows, [good, orphan])
    assert "forecast_without_observation" in _codes(info.value)


def test_bom_and_supabase_default_timestamps_are_accepted(tmp_path):
    from scripts.crowd_dispersion_replay import read_csv
    from tests.fixtures.crowd_replay.synthetic import write_csv

    rows = steady_rows("hongdae", T0, 2, {HONG: 1, YEON: 0, HAP: 2})
    for row in rows:
        for column in ("bucket_at", "observed_at"):
            row[column] = row[column].replace("T", " ").replace("Z", "+00")
    write_csv(tmp_path / "obs_x.csv", OBS_HEADER, [[r[c] for c in OBS_HEADER] for r in rows], bom=True)
    counts = counts_rows(steady_rows("hongdae", T0, 2, {HONG: 1, YEON: 0, HAP: 2}))
    write_csv(tmp_path / "counts.csv", COUNTS_HEADER, [[r[c] for c in COUNTS_HEADER] for r in counts], bom=True)
    data = load_replay_inputs(
        "hongdae", observations=[read_csv(tmp_path / "obs_x.csv")], counts=read_csv(tmp_path / "counts.csv"),
        forecasts_enabled=False,
    )
    assert data.inputs["rows_total"] == 6
    assert parse_utc("2026-09-20 05:00:00+00") == datetime(2026, 9, 20, 5, tzinfo=timezone.utc)
    assert parse_utc("2026-09-20T05:00:00") is None  # 시간대 없는 값은 받지 않는다


def test_inverted_population_range_is_emptied_with_a_warning():
    rows = steady_rows("hongdae", T0, 2, {HONG: 1, YEON: 0, HAP: 0})
    rows[0]["ppltn_min"], rows[0]["ppltn_max"] = "5000", "3000"
    data = _load(rows)
    assert data.inputs["warnings"]["inverted_population_range"] == 1
    record = data.timelines["seoul:POI007"].records[0]
    assert record.ppltn_min is None and record.ppltn_max is None


# ── 목록 대조(a~e) ─────────────────────────────────────────────────────────────


def _manifest_case(mutator):
    rows = steady_rows("hongdae", T0, 3, {HONG: 1, YEON: 0, HAP: 0})
    fc = [fcst_row(rows[0], T0 + timedelta(hours=1), 2)]
    counts = counts_rows(rows, fc)
    rows, fc, counts = mutator(rows, fc, counts)
    with pytest.raises(ReplayInputError) as info:
        load_replay_inputs("hongdae", **memory_inputs(rows, fc, counts=counts))
    return info.value


def test_manifest_a_obs_date_missing_from_manifest():
    def mut(rows, fc, counts):
        rows.append(obs_row(HONG, T0 + timedelta(days=1), 1))
        return rows, fc, counts

    exc = _manifest_case(mut)
    assert any(p.code == "export_truncated_or_partial" and "목록에 없다" in p.detail for p in exc.problems)


def test_manifest_b_manifest_date_without_obs_rows():
    def mut(rows, fc, counts):
        per_day = json.loads(counts[0]["per_kst_date"])
        per_day["2026-09-21"] = 5
        counts[0]["per_kst_date"] = json.dumps(per_day)
        return rows, fc, counts

    exc = _manifest_case(mut)
    assert any("관측이 없다" in p.detail for p in exc.problems)


def test_manifest_c_counts_differ():
    def mut(rows, fc, counts):
        del rows[1]  # 홍대 관광특구 한 행이 잘렸다
        return rows, fc, counts

    exc = _manifest_case(mut)
    assert any(p.column == "n_obs_total" for p in exc.problems)
    assert any("날짜별 행 수" in p.detail for p in exc.problems)


def test_manifest_d_forecast_rows_differ():
    def mut(rows, fc, counts):
        for row in counts:
            if row["area_nm"] == HONG:
                row["n_fcst_kept"] = "9"
        return rows, fc, counts

    exc = _manifest_case(mut)
    assert any(p.column == "n_fcst_kept" for p in exc.problems)


def test_manifest_e_cluster_site_without_manifest_row():
    def mut(rows, fc, counts):
        return rows, fc, [c for c in counts if c["area_nm"] != HAP]

    exc = _manifest_case(mut)
    assert any(HAP in p.detail and "목록(Q0)" in p.detail for p in exc.problems)


def test_all_problems_are_reported_at_once():
    def mut(rows, fc, counts):
        rows[0]["congest_lvl"] = "??"
        return rows, fc, [c for c in counts if c["area_nm"] != HAP]

    exc = _manifest_case(mut)
    codes = _codes(exc)
    assert "invalid_congest_lvl" in codes and "export_truncated_or_partial" in codes


# ── 정규화 사슬 대조 ────────────────────────────────────────────────────────────


def test_csv_row_matches_the_collector_normalisation_chain():
    payload = json.loads((FIXTURES / "seoul_citydata_hongdae_synthetic.json").read_text(encoding="utf-8"))
    live = payload["CITYDATA"]["LIVE_PPLTN_STTS"][0]
    fetched = datetime(2026, 9, 20, 5, 32, 10, tzinfo=timezone.utc)
    bucket = datetime(2026, 9, 20, 5, 30, tzinfo=timezone.utc)
    zone = next(z for z in cluster_zones("hongdae") if z.name == HONG)
    parsed = citydata.parse_citydata(payload, HONG)
    expected = reading_from_snapshot(
        snapshot_row(seoul_provider.observation_from_parsed(parsed, fetched_at=fetched), bucket_at=bucket), zone
    )
    observed = datetime.strptime(live["PPLTN_TIME"], "%Y-%m-%d %H:%M").replace(tzinfo=KST)
    row = {
        "area_cd": payload["CITYDATA"]["AREA_CD"], "area_nm": HONG, "bucket_at": "2026-09-20T05:30:00Z",
        "observed_at": observed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fetched_at": "2026-09-20T05:32:10.000000Z", "congest_lvl": live["AREA_CONGEST_LVL"],
        "ppltn_min": live["AREA_PPLTN_MIN"], "ppltn_max": live["AREA_PPLTN_MAX"],
    }
    fc = [
        {"area_cd": row["area_cd"], "area_nm": HONG, "bucket_at": row["bucket_at"], "fcst_time": f["FCST_TIME"],
         "fcst_congest_lvl": f["FCST_CONGEST_LVL"], "fcst_ppltn_min": f["FCST_PPLTN_MIN"],
         "fcst_ppltn_max": f["FCST_PPLTN_MAX"]}
        for f in live["FCST_PPLTN"]
    ]
    others = steady_rows("hongdae", T0, 1, {YEON: 0, HAP: 0})
    data = _load([row, *others], fc)
    record = data.timelines["seoul:POI007"].records[0]
    assert record.reading == expected
    assert data.inputs["warnings"]["provider_zone_code_mismatch"] == 1  # 합성 픽스처의 AREA_CD


# ── 정보 집합 · 정답 ────────────────────────────────────────────────────────────


def _timeline(rows, zone_id="seoul:POI007", **kw):
    data = _load(rows, **kw)
    return data.timelines[zone_id]


def test_info_set_never_shows_rows_fetched_after_t():
    rows = steady_rows("hongdae", T0, 3, {YEON: 0, HAP: 0})
    rows += [obs_row(HONG, T0, 1), obs_row(HONG, T0 + timedelta(minutes=10), 3, fetched_offset_s=630)]
    timeline = _timeline(rows)
    t = (T0 + timedelta(minutes=20)).astimezone(timezone.utc)
    assert timeline.latest_reading(t).level_band == "normal"  # 10분 버킷 행은 t+30초에 왔다
    assert timeline.latest_reading(t + timedelta(seconds=30)).level_band == "busy"


def test_info_set_drops_rows_older_than_two_hours_and_skips_replaced():
    rows = steady_rows("hongdae", T0, 1, {YEON: 0, HAP: 0}) + [obs_row(HONG, T0, 2)]
    timeline = _timeline(rows)
    assert timeline.latest_reading(T0 + timedelta(minutes=119)) is not None
    assert timeline.latest_reading(T0 + timedelta(minutes=121)) is None


def test_truth_tolerance_is_per_zone_cadence():
    ten = _timeline(steady_rows("hongdae", T0, 6, {HONG: 1, YEON: 0, HAP: 0}))
    assert ten.tolerance == timedelta(minutes=5)
    rows = steady_rows("jongno", T0, 6, {"경복궁": 1, "북촌한옥마을": 0, "인사동": 0, "창덕궁·종묘": 0}, cadence_minutes=30)
    data = load_replay_inputs("jongno", **memory_inputs(rows))
    assert data.timelines["seoul:POI008"].tolerance == timedelta(minutes=15)


def test_truth_must_be_after_the_decision_and_ties_go_to_the_later_observation():
    rows = steady_rows("hongdae", T0, 1, {YEON: 0, HAP: 0})
    rows += [obs_row(HONG, T0 + timedelta(minutes=10 * i), i % 4, observed_offset_min=1) for i in range(6)]
    timeline = _timeline(rows)
    t = (T0 + timedelta(minutes=10)).astimezone(timezone.utc)
    # 목표가 두 관측(:21, :31) 정확히 가운데(:26) → 늦은 :31 이 정답
    hit, why = timeline.truth(T0 + timedelta(minutes=26), t=t)
    assert why is None and hit.record.observed_at == (T0 + timedelta(minutes=31)).astimezone(timezone.utc)
    # t 에 이미 보이던 관측(:01, :11)은 정답이 될 수 없다
    hit, why = timeline.truth(T0 + timedelta(minutes=11), t=t + timedelta(minutes=3))
    assert hit is None and why == "not_after_decision"
    # 허용 오차(5분) 밖은 비운다 — 보간하지 않는다
    hit, why = timeline.truth(T0 + timedelta(minutes=200), t=t)
    assert hit is None and why == "missing"


def test_truth_requires_fetch_after_t():
    rows = steady_rows("hongdae", T0, 1, {YEON: 0, HAP: 0})
    rows += [obs_row(HONG, T0, 1), obs_row(HONG, T0 + timedelta(minutes=10), 2, fetched_offset_s=60)]
    timeline = _timeline(rows)
    # 10분 버킷 행은 T0+11 관측, T0+11 에 받음 → t = T0+12 에서는 이미 보이므로 정답이 아니다
    hit, why = timeline.truth(T0 + timedelta(minutes=11), t=(T0 + timedelta(minutes=12)).astimezone(timezone.utc))
    assert hit is None and why == "not_after_decision"


# ── 이동 ──────────────────────────────────────────────────────────────────────


def test_travel_matrix_matches_the_plan_table():
    names = {z.zone_id: z.name for z in cluster_zones("hongdae")}
    names.update({z.zone_id: z.name for z in cluster_zones("jongno")})
    expected = {
        ("홍대 관광특구", "연남동"): 19, ("홍대 관광특구", "합정역"): 21, ("연남동", "합정역"): 35,
        ("경복궁", "북촌한옥마을"): 15, ("경복궁", "인사동"): 23, ("경복궁", "창덕궁·종묘"): 31,
        ("북촌한옥마을", "인사동"): 20, ("북촌한옥마을", "창덕궁·종묘"): 20, ("인사동", "창덕궁·종묘"): 18,
    }
    got = {}
    for cluster in ("hongdae", "jongno"):
        for (a, b), leg in travel_matrix(cluster_zones(cluster), detour=1.4, speed_m_per_min=66.67).items():
            got[(names[a], names[b])] = leg.minutes
    for (a, b), minutes in expected.items():
        assert got[(a, b)] == minutes and got[(b, a)] == minutes, (a, b)
    hong = travel_matrix(cluster_zones("hongdae"), detour=1.4, speed_m_per_min=66.67)
    assert round(hong[("seoul:POI007", "seoul:POI073")].straight_m) == 861


def test_unknown_cluster_fails_loudly():
    with pytest.raises(ReplayInputError) as info:
        load_replay_inputs("busan", observations=[], counts=None)
    assert _codes(info.value) == ["unknown_cluster"]


def test_replace_flags_drop_rows_and_report_coverage():
    rows = steady_rows("hongdae", T0, 3, {HONG: 1, YEON: 0, HAP: 0})
    flags = [
        {"zone_id": "seoul:POI007", "bucket_at": rows[0]["bucket_at"], "replaced": "true"},
        {"zone_id": "seoul:POI007", "bucket_at": rows[1]["bucket_at"], "replaced": "false"},
        {"zone_id": "seoul:POI007", "bucket_at": rows[2]["bucket_at"], "replaced": ""},
    ]
    data = _load(rows, replaced=csv_file("replaced.csv", list(data_mod.REQUIRED_REPLACED_COLUMNS), flags),
                 replaced_counts=_replaced_counts(flags))
    records = data.timelines["seoul:POI007"].records
    assert [r.replaced for r in records] == [True, False, None]
    assert records[0].reading is None  # 운영처럼 엔진 입력에서 빠진다
    stats = data.inputs["replace_flags"]["per_zone"]["seoul:POI007"]
    assert stats["rows_with_flag"] == 2 and abs(stats["coverage"] - 2 / 3) < 1e-9
    assert data.inputs["replace_flags"]["per_zone"]["seoul:POI073"]["coverage"] == 0.0


def test_header_constants_match_fixture_headers():
    assert list(data_mod.REQUIRED_OBS_COLUMNS) == OBS_HEADER
    assert list(data_mod.REQUIRED_FCST_COLUMNS) == FCST_HEADER
    assert list(data_mod.REQUIRED_COUNTS_COLUMNS) == COUNTS_HEADER


# ── Q3 대체값 표시: 조각 + 행 수 목록(S4 검토 — 잘린 Q3 를 '표시 없음' 으로 읽지 않는다) ──


def _replaced_counts(flags, *, drop_zone=None, bump=None):
    per_zone: dict[str, dict[str, int]] = {}
    for row in flags:
        day = parse_utc(row["bucket_at"]).astimezone(KST).date().isoformat()
        per_zone.setdefault(row["zone_id"], {}).setdefault(day, 0)
        per_zone[row["zone_id"]][day] += 1
    rows = []
    for zone_id, days in sorted(per_zone.items()):
        if zone_id == drop_zone:
            continue
        total = sum(days.values()) + (bump or 0)
        rows.append({"zone_id": zone_id, "n_rows": str(total), "per_kst_date": json.dumps(days)})
    return csv_file("counts_replaced.csv", list(data_mod.REQUIRED_REPLACED_COUNTS_COLUMNS), rows)


def _flags(rows, zone_by_name):
    return [
        {"zone_id": zone_by_name[r["area_nm"]], "bucket_at": r["bucket_at"], "replaced": "true" if i % 2 else "false"}
        for i, r in enumerate(rows)
    ]


_ZONE_BY_NAME = {HONG: "seoul:POI007", YEON: "seoul:POI073", HAP: "seoul:POI053"}


def test_truncated_q3_is_rejected_instead_of_reading_missing_flags_as_unknown():
    rows = steady_rows("hongdae", T0, 6, {HONG: 1, YEON: 0, HAP: 0})
    flags = _flags(rows, _ZONE_BY_NAME)
    manifest = _replaced_counts(flags)
    cut = flags[: len(flags) - 4]  # 편집기 한도에 바닥이 잘린 Q3(ORDER BY zone_id, bucket_at — 마지막 구역의 뒤 행)
    with pytest.raises(ReplayInputError) as info:
        _load(rows, replaced=csv_file("replaced.csv", list(data_mod.REQUIRED_REPLACED_COLUMNS), cut),
              replaced_counts=manifest)
    assert "export_truncated_or_partial" in _codes(info.value)


def test_q3_without_its_count_manifest_fails_loudly():
    rows = steady_rows("hongdae", T0, 3, {HONG: 1, YEON: 0, HAP: 0})
    flags = _flags(rows, _ZONE_BY_NAME)
    with pytest.raises(ReplayInputError) as info:
        _load(rows, replaced=csv_file("replaced.csv", list(data_mod.REQUIRED_REPLACED_COLUMNS), flags))
    assert _codes(info.value) == ["replaced_counts_missing"]


@pytest.mark.parametrize("kind", ["zone_missing_from_manifest", "total_off_by_one", "files_missing"])
def test_q3_manifest_mismatches_are_reported(kind):
    rows = steady_rows("hongdae", T0, 3, {HONG: 1, YEON: 0, HAP: 0})
    flags = _flags(rows, _ZONE_BY_NAME)
    files = [csv_file("replaced.csv", list(data_mod.REQUIRED_REPLACED_COLUMNS), flags)]
    manifest = _replaced_counts(flags)
    if kind == "zone_missing_from_manifest":
        manifest = _replaced_counts(flags, drop_zone="seoul:POI073")
    elif kind == "total_off_by_one":
        manifest = _replaced_counts(flags, bump=1)
    else:
        files = []
    with pytest.raises(ReplayInputError) as info:
        _load(rows, replaced=files, replaced_counts=manifest)
    assert "export_truncated_or_partial" in _codes(info.value)


def test_q3_chunks_merge_and_identical_overlaps_are_tolerated():
    rows = steady_rows("hongdae", T0, 4, {HONG: 1, YEON: 0, HAP: 0})
    flags = _flags(rows, _ZONE_BY_NAME)
    header = list(data_mod.REQUIRED_REPLACED_COLUMNS)
    first = csv_file("replaced_a.csv", header, flags[:7])
    second = csv_file("replaced_b.csv", header, flags[5:])  # 경계 두 줄이 겹친다(같은 값)
    data = _load(rows, replaced=[first, second], replaced_counts=_replaced_counts(flags))
    flagged = sum(1 for zid in data.timelines for r in data.timelines[zid].records if r.replaced is not None)
    assert flagged == len(rows)
    assert [f["name"] for f in data.inputs["replaced_files"]] == ["replaced_a.csv", "replaced_b.csv"]
    assert data.inputs["replaced_counts_file"]["name"] == "counts_replaced.csv"

    conflicting = [dict(flags[5], replaced="true" if flags[5]["replaced"] == "false" else "false")]
    with pytest.raises(ReplayInputError) as info:
        _load(rows, replaced=[first, csv_file("replaced_c.csv", header, conflicting)],
              replaced_counts=_replaced_counts(flags))
    assert "conflicting_duplicate" in _codes(info.value)
