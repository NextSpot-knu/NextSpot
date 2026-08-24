"""Conservative matching between KTO forecast names and NextSpot facilities.

The forecast feed does not carry coordinates.  A name match therefore becomes a
geographic anchor and must be much stricter than ordinary search.  Only harmless
presentation differences are normalized and ambiguous keys are rejected.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
import re
import unicodedata
from typing import Any


TOURISM_ANCHOR_TYPES = frozenset({"attraction", "culture"})

_BRACKETED = re.compile(r"\(([^()]*)\)|\[([^\[\]]*)\]|【([^【】]*)】")
_SAFE_METADATA_BLOCK = re.compile(
    r"(?:"
    r"(?:unesco|유네스코)(?:세계(?:문화)?유산)?|"
    r"세계(?:문화)?유산|국가(?:문화)?유산|"
    r"(?:사적|국보|보물|명승)(?:제?\d+호)?"
    r")",
    re.IGNORECASE,
)
_GYEONGJU_PREFIX = re.compile(r"^(?:경주시|경주)\s+")
_AREA_SUFFIX = re.compile(r"\s+일원$")
_UNESCO_SUFFIX = re.compile(
    r"(?:\s*[-·]\s*|\s+)(?:unesco|유네스코)(?:\s*세계(?:문화)?유산)?$",
    re.IGNORECASE,
)
_SPACES = re.compile(r"\s+")


@dataclass(frozen=True)
class TourismAnchorMatch:
    facility: dict[str, Any]
    forecast: dict[str, Any]
    normalized_name: str


def _metadata_block_replacement(match: re.Match[str]) -> str:
    content = next((group for group in match.groups() if group is not None), "")
    compact = _SPACES.sub("", unicodedata.normalize("NFKC", content)).casefold()
    if _SAFE_METADATA_BLOCK.fullmatch(compact):
        return " "
    return match.group(0)


def normalize_tourism_anchor_name(value: object) -> str:
    """Normalize only presentation-level differences that cannot change identity.

    Branch/location parentheses are deliberately preserved.  For example,
    ``박물관(신관)`` and ``박물관(본관)`` must not collapse to one anchor.
    """
    name = unicodedata.normalize("NFKC", str(value or "")).strip()
    if not name:
        return ""
    name = _BRACKETED.sub(_metadata_block_replacement, name)
    name = _GYEONGJU_PREFIX.sub("", name)
    name = _AREA_SUFFIX.sub("", name)
    name = _UNESCO_SUFFIX.sub("", name)
    return _SPACES.sub("", name).casefold().strip()


def match_tourism_forecasts_to_facilities(
    facilities: list[dict[str, Any]], forecasts: list[dict[str, Any]]
) -> list[TourismAnchorMatch]:
    """Return one-to-one, type-safe anchor matches and reject every collision."""
    facility_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for facility in facilities:
        if facility.get("type") not in TOURISM_ANCHOR_TYPES:
            continue
        key = normalize_tourism_anchor_name(facility.get("name"))
        if key:
            facility_groups[key].append(facility)

    forecast_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for forecast in forecasts:
        if forecast.get("concentration_rate") is None:
            continue
        key = normalize_tourism_anchor_name(forecast.get("tourist_attraction_name"))
        if key:
            forecast_groups[key].append(forecast)

    matches = []
    for key in sorted(facility_groups.keys() & forecast_groups.keys()):
        matching_facilities = facility_groups[key]
        matching_forecasts = forecast_groups[key]
        if len(matching_facilities) != 1 or len(matching_forecasts) != 1:
            continue
        matches.append(
            TourismAnchorMatch(
                facility=matching_facilities[0],
                forecast=matching_forecasts[0],
                normalized_name=key,
            )
        )
    return matches
