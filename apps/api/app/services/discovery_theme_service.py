"""Factual theme eligibility for famous-place-based alternatives.

Themes narrow the candidate pool before SPOT scoring; they never add points or invent
descriptions. A place qualifies only through an official TourAPI related-destination
link or text already stored with the facility (name, category, overview, features).
"""

from __future__ import annotations

from typing import Any, Literal

DiscoveryTheme = Literal[
    "silla_core", "night_heritage", "hanok_cafe", "indoor_history", "gyochon_walk"
]

_THEME_TERMS: dict[DiscoveryTheme, tuple[str, ...]] = {
    "silla_core": (
        "신라", "고분", "왕릉", "천마총", "대릉원", "첨성대", "월성", "계림",
        "교촌", "월정교", "향교", "최부자", "동궁", "월지",
    ),
    "night_heritage": (
        "야경", "야간", "조명", "일몰", "노을", "동궁과 월지", "월정교", "첨성대",
    ),
    "hanok_cafe": ("한옥", "고택", "전통", "황리단", "정원", "마당", "기와"),
    "indoor_history": (
        "박물관", "미술관", "전시", "기념관", "체험관", "교육관", "문화관", "홍보관",
    ),
    "gyochon_walk": ("교촌", "월정교", "향교", "최부자", "한옥", "전통", "기와", "남천"),
}


def _flatten_text(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, dict):
        parts: list[str] = []
        for item in value.values():
            parts.extend(_flatten_text(item))
        return parts
    if isinstance(value, (list, tuple, set)):
        parts = []
        for item in value:
            parts.extend(_flatten_text(item))
        return parts
    return [str(value)]


def discovery_theme_match(facility: dict[str, Any], theme: DiscoveryTheme) -> dict[str, str] | None:
    """Return auditable eligibility evidence, or ``None`` when the theme is unproven."""
    related_rank = facility.get("tourapi_related_rank")
    if isinstance(related_rank, int) and related_rank > 0:
        return {"source": "tourapi_related", "value": str(related_rank)}

    facts = [
        facility.get("name"), facility.get("overview"), facility.get("category_name"),
        facility.get("features"),
    ]
    haystack = " ".join(_flatten_text(facts)).casefold()
    for term in _THEME_TERMS[theme]:
        if term.casefold() in haystack:
            return {"source": "facility_fact", "value": term}
    return None
