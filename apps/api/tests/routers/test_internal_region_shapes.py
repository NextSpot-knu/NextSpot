"""내부 지역 API 응답 모양은 고정이다 — 웹(WP5)이 같은 칸 이름을 쓴다.

칸 이름을 바꾸려면 이 문자열과 웹 타입을 함께 바꾼다(한쪽만 바꾸면 이 테스트가 깨진다).
"""

from __future__ import annotations

import pytest

from app.routers import internal_regions as ir
from app.routers.infrastructures import InfrastructureItem


def _props(model) -> set[str]:
    return set(model.model_json_schema()["properties"])


FROZEN = {
    ir.InternalRegionsResponse: {"regions"},
    ir.InternalRegionView: {
        "id", "names", "center", "bounds", "presets", "address_token",
        "facility_count", "mapped_facility_count", "zone_count", "latest_observed_at",
    },
    ir.RegionNames: {"ko", "en", "ja", "zh"},
    ir.LatLng: {"lat", "lng"},
    ir.RegionBounds: {"min_lat", "max_lat", "min_lng", "max_lng"},
    ir.RegionPreset: {"id", "name", "lat", "lng"},
    ir.InternalRegionInfrastructuresResponse: {"region", "generated_at", "items"},
    ir.ZoneCrowdView: {
        "zone_id", "zone_name", "cluster", "level", "level_band", "observed_at",
        "is_current", "usual_comparison", "forecast",
    },
    ir.ZoneForecastPoint: {"target_at", "level", "level_band"},
    ir.InternalZonesResponse: {"region", "zones"},
}


@pytest.mark.parametrize("model", list(FROZEN), ids=lambda m: m.__name__)
def test_frozen_property_names(model):
    assert _props(model) == FROZEN[model]


def test_zone_view_is_crowd_view_plus_geometry():
    assert _props(ir.InternalZoneView) == FROZEN[ir.ZoneCrowdView] | {"centroid", "radius_m"}


def test_infrastructure_item_is_public_item_plus_zone():
    assert _props(ir.InternalRegionInfrastructureItem) == _props(InfrastructureItem) | {"zone"}


def test_zone_congestion_is_public_congestion_plus_tier():
    from app.routers.infrastructures import CongestionInfo

    assert _props(ir.InternalZoneCongestion) == _props(CongestionInfo) | {"evidence_tier"}


def test_level_bands_and_usual_comparisons_are_region_neutral():
    schema = ir.ZoneCrowdView.model_json_schema()
    band = schema["properties"]["level_band"]["anyOf"][0]["enum"]
    usual = schema["properties"]["usual_comparison"]["anyOf"][0]["enum"]
    assert band == ["relaxed", "normal", "slightly_busy", "busy"]
    assert usual == ["busier", "usual", "quieter"]
