"""구역 혼잡 계층 — 인터페이스 · 서울 어댑터 · 서울 구역 정의.

픽스처는 서울 수집기 테스트와 같은 두 개다(`tests/fixtures/seoul_citydata_*.json`):
  · 광화문 샘플 — 2026-09-20 공개 샘플키로 받은 **실제 응답 모양**(AREA_CD POI009, 예측 12개).
  · 홍대 합성 — 홍대 관광특구 모양의 합성 응답(AREA_CD 가 일부러 'POI_SYNTHETIC').
"""

from __future__ import annotations

import asyncio
import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.core.config import settings
from app.services import seoul_citydata_service as seoul
from app.services.crowd import observation as crowd_obs
from app.services.crowd import seoul_provider as provider
from app.services.crowd.observation import CrowdObservation, CrowdProvider

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
KST = timezone(timedelta(hours=9))
FAKE_KEY = "SEOULKEY0123456789abcdef"
HONGDAE = "홍대 관광특구"
GWANGHWAMUN = "광화문·덕수궁"
FETCHED_AT = datetime(2026, 9, 20, 14, 41, 30, tzinfo=KST).astimezone(timezone.utc)


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _sample() -> dict:
    return _fixture("seoul_citydata_gwanghwamun_sample.json")


def _hongdae() -> dict:
    return _fixture("seoul_citydata_hongdae_synthetic.json")


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    monkeypatch.setattr(settings, "SEOUL_OPENDATA_KEY", "")
    monkeypatch.setattr(settings, "TOURAPI_KEY", "")


# ── 인터페이스 ─────────────────────────────────────────────────────────────────


def test_seoul_provider_satisfies_the_provider_protocol():
    assert isinstance(provider.SeoulCitydataProvider(), CrowdProvider)


def test_describe_states_cadence_scale_and_license():
    description = provider.SeoulCitydataProvider().describe()
    assert description.source == "seoul_citydata"
    assert description.region == "seoul"
    assert description.level_scale == provider.LEVEL_SCALE
    assert description.provides_forecast is True
    # 서울 API 는 이력을 주지 않는다 — 표본은 수집한 날부터만 있다.
    assert description.provides_history is False
    assert "공공누리" in description.license


def _observation(**overrides) -> CrowdObservation:
    base = dict(
        zone_id="seoul:POI007", source="seoul_citydata",
        observed_at=FETCHED_AT, fetched_at=FETCHED_AT, level_scale="x",
    )
    base.update(overrides)
    return CrowdObservation(**base)


@pytest.mark.parametrize("level", [-0.01, 1.01])
def test_observation_rejects_level_outside_unit_interval(level):
    with pytest.raises(ValueError):
        _observation(level=level)


def test_observation_rejects_inverted_population_range():
    with pytest.raises(ValueError):
        _observation(population_min=10, population_max=5)


def test_observation_defaults_mean_unknown_not_zero():
    observation = _observation()
    assert observation.level is None
    assert observation.population_point is None
    assert observation.forecast == ()
    assert observation.quality == {}


def test_forecasts_within_keeps_only_the_horizon():
    parsed = seoul.parse_citydata(_sample(), GWANGHWAMUN)
    observation = provider.observation_from_parsed(parsed, fetched_at=FETCHED_AT)
    assert observation is not None
    # 관측 02:30 KST, 예측은 04:00 부터 정시 간격 — 2시간 안에는 04:00 하나뿐이다.
    within = crowd_obs.forecasts_within([observation], timedelta(hours=2))
    assert [item.target_at for item in within] == [datetime(2026, 9, 20, 4, 0, tzinfo=KST)]
    assert crowd_obs.forecasts_within([observation], timedelta(minutes=30)) == []


# ── 어댑터: 실제 응답 모양 ───────────────────────────────────────────────────────


def test_real_sample_becomes_a_normalised_observation():
    parsed = seoul.parse_citydata(_sample(), GWANGHWAMUN)
    observation = provider.observation_from_parsed(parsed, fetched_at=FETCHED_AT)

    assert observation is not None
    # 광화문·덕수궁은 9곳 구역 정의에 없다 → 응답의 AREA_CD 로 구역 ID 를 만든다.
    assert observation.zone_id == "seoul:POI009"
    assert observation.source == "seoul_citydata"
    assert observation.observed_at == datetime(2026, 9, 20, 2, 30, tzinfo=KST)
    assert observation.period_seconds == 300
    assert (observation.population_min, observation.population_max) == (3000, 3500)
    assert observation.population_point == 3250.0
    # 여유 → 구간 중앙값 0.125(서울 대안 패널·검증 화면과 같은 눈금).
    assert observation.level == pytest.approx(0.125)
    assert observation.level_label == "여유"
    assert observation.level_scale == "seoul_congest_4"
    assert len(observation.forecast) == 12
    first = observation.forecast[0]
    assert first.target_at == datetime(2026, 9, 20, 4, 0, tzinfo=KST)
    assert (first.population_min, first.population_max) == (1500, 2000)
    assert first.level == pytest.approx(0.125)
    assert first.issued_at == observation.observed_at
    assert [item.target_at for item in observation.forecast] == sorted(item.target_at for item in observation.forecast)
    assert observation.quality["provider_zone_code"] == "POI009"
    assert observation.quality["replaced"] is False
    assert observation.quality["lag_seconds"] > 0


def test_defined_zone_wins_over_response_code_and_flags_the_mismatch():
    parsed = seoul.parse_citydata(_hongdae(), HONGDAE)
    observation = provider.observation_from_parsed(parsed, fetched_at=FETCHED_AT)

    assert observation is not None
    assert observation.zone_id == "seoul:POI007"
    assert observation.level == pytest.approx(0.625)  # 약간 붐빔
    assert observation.quality["provider_zone_code"] == "POI_SYNTHETIC"
    assert observation.quality["provider_zone_code_mismatch"] is True
    assert observation.quality["lag_seconds"] == 11 * 60 + 30


def test_missing_population_range_is_flagged_not_invented():
    payload = _hongdae()
    payload["CITYDATA"]["LIVE_PPLTN_STTS"][0]["AREA_PPLTN_MIN"] = "50000"  # 뒤집힌 범위 → 파서가 비운다
    parsed = seoul.parse_citydata(payload, HONGDAE)
    observation = provider.observation_from_parsed(parsed, fetched_at=FETCHED_AT)

    assert observation is not None
    assert observation.population_min is None and observation.population_point is None
    assert observation.quality["population_range_missing"] is True
    assert observation.level == pytest.approx(0.625), "등급(정답의 본체)은 남는다"


def test_replaced_flag_follows_replace_yn():
    payload = _sample()
    live = payload["CITYDATA"]["LIVE_PPLTN_STTS"]
    (live[0] if isinstance(live, list) else live)["REPLACE_YN"] = "Y"
    observation = provider.observation_from_parsed(seoul.parse_citydata(payload, GWANGHWAMUN), fetched_at=FETCHED_AT)
    assert observation is not None and observation.quality["replaced"] is True


def test_unknown_forecast_grade_keeps_population_but_no_level():
    payload = _sample()
    live = payload["CITYDATA"]["LIVE_PPLTN_STTS"]
    live = live[0] if isinstance(live, list) else live
    live["FCST_PPLTN"][0]["FCST_CONGEST_LVL"] = "알수없음"
    live["FCST_PPLTN"][1]["FCST_TIME"] = "not a time"
    observation = provider.observation_from_parsed(seoul.parse_citydata(payload, GWANGHWAMUN), fetched_at=FETCHED_AT)
    assert observation is not None
    assert len(observation.forecast) == 11, "시각을 읽을 수 없는 예측은 버린다"
    first = observation.forecast[0]
    assert first.level is None and first.level_label is None
    assert first.population_min == 1500


def test_no_zone_and_no_code_means_no_observation():
    parsed = seoul.parse_citydata(_sample(), GWANGHWAMUN)
    parsed["area_cd"] = None
    assert provider.observation_from_parsed(parsed, fetched_at=FETCHED_AT) is None


# ── 어댑터: fetch_current (실패는 '관측 없음') ─────────────────────────────────


def _zone(name: str):
    zone = provider.zone_for_name(name)
    assert zone is not None
    return zone


def test_fetch_current_without_key_returns_nothing_and_calls_nothing(monkeypatch):
    async def must_not_call(*_args, **_kwargs):
        raise AssertionError("키가 없으면 부르지 않는다")

    monkeypatch.setattr(seoul, "fetch_citydata", must_not_call)
    assert asyncio.run(provider.SeoulCitydataProvider().fetch_current([_zone(HONGDAE)])) == []


def test_fetch_current_skips_failed_zones_instead_of_raising(monkeypatch):
    monkeypatch.setattr(settings, "SEOUL_OPENDATA_KEY", FAKE_KEY)
    calls: list[str] = []

    async def fetch(_client, key, area_nm):
        assert key == FAKE_KEY
        calls.append(area_nm)
        if area_nm == "연남동":
            raise seoul.SeoulCitydataError("seoul_timeout")
        return copy.deepcopy(_hongdae())

    monkeypatch.setattr(seoul, "fetch_citydata", fetch)
    observations = asyncio.run(
        provider.SeoulCitydataProvider().fetch_current([_zone("연남동"), _zone(HONGDAE)])
    )
    assert calls == ["연남동", HONGDAE]
    assert [item.zone_id for item in observations] == ["seoul:POI007"]


def test_fetch_current_drops_a_mismatched_answer(monkeypatch):
    """샘플키는 무엇을 요청해도 광화문을 준다 — 그 답이 다른 구역의 관측이 되면 안 된다."""
    monkeypatch.setattr(settings, "SEOUL_OPENDATA_KEY", FAKE_KEY)

    async def fetch(_client, _key, _area_nm):
        return copy.deepcopy(_sample())

    monkeypatch.setattr(seoul, "fetch_citydata", fetch)
    assert asyncio.run(provider.SeoulCitydataProvider().fetch_current([_zone(HONGDAE)])) == []


def test_fetch_forecast_reuses_the_same_single_call(monkeypatch):
    monkeypatch.setattr(settings, "SEOUL_OPENDATA_KEY", FAKE_KEY)
    calls: list[str] = []

    async def fetch(_client, _key, area_nm):
        calls.append(area_nm)
        return copy.deepcopy(_hongdae())

    monkeypatch.setattr(seoul, "fetch_citydata", fetch)
    forecasts = asyncio.run(
        provider.SeoulCitydataProvider().fetch_forecast([_zone(HONGDAE)], timedelta(hours=3))
    )
    assert calls == [HONGDAE]
    assert [item.level_label for item in forecasts] == ["붐빔", "붐빔"]
    assert all(item.zone_id == "seoul:POI007" for item in forecasts)


# ── 서울 구역 정의(S2) ─────────────────────────────────────────────────────────


def test_nine_zones_in_three_clusters():
    clusters: dict[str, list[str]] = {}
    for zone in provider.SEOUL_ZONES:
        clusters.setdefault(zone.cluster or "", []).append(zone.name)
    assert clusters == {
        "jongno": ["경복궁", "북촌한옥마을", "인사동", "창덕궁·종묘"],
        "hongdae": ["홍대 관광특구", "연남동", "합정역"],
        "validation": ["명동 관광특구", "동대문 관광특구"],
    }
    ids = [zone.zone_id for zone in provider.SEOUL_ZONES]
    assert len(set(ids)) == 9
    for zone in provider.SEOUL_ZONES:
        assert zone.zone_id == f"seoul:{zone.provider_zone_code}"
        assert zone.kind in crowd_obs.ZONE_KINDS
        assert 37.4 < zone.centroid_lat < 37.7 and 126.7 < zone.centroid_lng < 127.2
        assert zone.radius_m and 100 < zone.radius_m < 1500


def test_existing_codes_agree_with_the_alternatives_panel():
    """홍대 권역 코드는 대안 패널(실측 확인분)과 같아야 한다 — 두 곳이 다른 코드를 쓰면 안 된다."""
    from app.services import seoul_alternatives_service as alternatives

    for place in alternatives.DEMO_CLUSTER:
        assert _zone(place.area_nm).provider_zone_code == place.area_cd


def test_hongdae_zone_centre_matches_the_estimator_reference_point():
    """홍대 프로필 좌표(서울시 지도 링크)와 공식 다각형 넓이 중심이 같은 점이다 — 출처가 같다는 확인."""
    profile = seoul.target_profile(HONGDAE)
    zone = _zone(HONGDAE)
    assert profile is not None
    assert zone.centroid_lat == pytest.approx(profile.latitude, abs=1e-5)
    assert zone.centroid_lng == pytest.approx(profile.longitude, abs=1e-5)


def test_default_targets_are_exactly_the_nine_zones(monkeypatch):
    default = type(settings).model_fields["SEOUL_CITYDATA_TARGETS"].default
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", default)
    assert sorted(seoul.configured_targets()) == sorted(zone.provider_zone_name for zone in provider.SEOUL_ZONES)
    for name in seoul.configured_targets():
        assert seoul.target_profile(name) is not None, f"{name} 추정 기준 좌표가 없다"
