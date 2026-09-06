"""LOCALDATA 식품 인허가 정규화 규칙.

네트워크와 DB에 의존하지 않는 모듈로 유지해 CSV 필드 변형, 좌표, 상태 및
중복 판정을 단위 테스트할 수 있게 한다. LOCALDATA의 현재 좌표계는 EPSG:5174이며
오래된 행에만 EPSG:2097을 보조 후보로 사용한다.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Iterable

from pyproj import Transformer

SERVICE_BOUNDS = (35.82, 35.85, 129.19, 129.24)
ACTIVE_STATUS = "01"
SOURCE = "localdata"
SERVICE_CODES = {"07_24_04_P", "07_24_05_P"}

_T5174 = Transformer.from_crs(5174, 4326, always_xy=True)
_T2097 = Transformer.from_crs(2097, 4326, always_xy=True)
_SPACE = re.compile(r"[\s\-_,.()（）]+")
_AUTO_EXCLUDE = re.compile(
    r"단란주점|유흥주점|감성주점|헌팅포차|룸살롱|편의점|자동판매기|자판기|휴게소|푸드트럭|노점"
)
_CAFE = re.compile(r"커피|카페|다방|제과|베이커리|아이스크림|차")

ALIASES = {
    "external_id": ("관리번호", "MGTNO", "mgtNo"),
    "name": ("사업장명", "업소명", "BPLCNM", "bplcNm"),
    "road_address": ("도로명전체주소", "도로명주소", "RDNWHLADDR", "rdnWhlAddr"),
    "lot_address": ("소재지전체주소", "지번주소", "SITEWHLADDR", "siteWhlAddr"),
    "status": ("영업상태구분코드", "TRDSTATGBCD", "trdStateGbn"),
    "status_name": ("영업상태명", "TRDSTATGBN", "trdStateNm"),
    "updated_at": ("데이터갱신일자", "최종수정시점", "UPDATE_DT", "UPDATEDT", "updateDt", "lastModTs"),
    "x": ("좌표정보(X)", "좌표정보x", "X", "XPOS", "x"),
    "y": ("좌표정보(Y)", "좌표정보y", "Y", "YPOS", "y"),
    "business_type": ("업태구분명", "UPTAENM", "uptaeNm"),
}


def pick(row: dict, field: str) -> str:
    for key in ALIASES[field]:
        value = row.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def normalize_text(value: str) -> str:
    return _SPACE.sub("", value).casefold()


def normalize_address(value: str) -> str:
    value = re.sub(r"\([^)]*\)", "", value)
    return normalize_text(value.replace("경상북도", "경북"))


def in_service_bounds(lat: float, lng: float) -> bool:
    min_lat, max_lat, min_lng, max_lng = SERVICE_BOUNDS
    return min_lat <= lat <= max_lat and min_lng <= lng <= max_lng


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    from math import asin, cos, radians, sin, sqrt

    lat1, lng1 = map(radians, a)
    lat2, lng2 = map(radians, b)
    dlat, dlng = lat2 - lat1, lng2 - lng1
    return 6371000 * 2 * asin(sqrt(sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlng / 2) ** 2))


@dataclass(frozen=True)
class CoordinateResult:
    latitude: float | None
    longitude: float | None
    crs: str | None
    reason: str | None = None


def transform_coordinate(x_raw: str, y_raw: str, *, allow_legacy: bool = False) -> CoordinateResult:
    try:
        x, y = float(x_raw), float(y_raw)
    except (TypeError, ValueError):
        return CoordinateResult(None, None, None, "invalid_coordinate")
    candidates = []
    transforms = [("EPSG:5174", _T5174)]
    if allow_legacy:
        transforms.append(("EPSG:2097", _T2097))
    for crs, transformer in transforms:
        lng, lat = transformer.transform(x, y)
        if in_service_bounds(lat, lng):
            candidates.append((crs, lat, lng))
    if not candidates:
        return CoordinateResult(None, None, None, "outside_service_bounds")
    primary = next((c for c in candidates if c[0] == "EPSG:5174"), None)
    if len(candidates) == 2 and haversine_m(candidates[0][1:], candidates[1][1:]) > 100:
        return CoordinateResult(None, None, None, "ambiguous_crs")
    crs, lat, lng = primary or candidates[0]
    return CoordinateResult(lat, lng, crs)


def classify(service_code: str, business_type: str, name: str) -> tuple[str | None, str | None]:
    combined = f"{business_type} {name}"
    if _AUTO_EXCLUDE.search(combined):
        return None, "excluded_business_type"
    if not business_type.strip() or business_type in {"기타", "기타 휴게음식점"}:
        return None, "ambiguous_business_type"
    if service_code == "07_24_05_P" and _CAFE.search(combined):
        return "cafe", None
    if service_code in SERVICE_CODES:
        return "restaurant", None
    return None, "unsupported_service"


def stable_hash(payload: dict) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def parse_updated_at(value: str) -> str | None:
    if not value:
        return None
    compact = re.sub(r"[^0-9]", "", value)
    for length, fmt in ((14, "%Y%m%d%H%M%S"), (8, "%Y%m%d")):
        if len(compact) >= length:
            try:
                return datetime.strptime(compact[:length], fmt).isoformat() + "+09:00"
            except ValueError:
                pass
    return None


def capacity_for(facility_type: str) -> int:
    return 30 if facility_type == "restaurant" else 24


def normalize_record(row: dict, service_code: str) -> tuple[dict | None, str | None]:
    external_id, name = pick(row, "external_id"), pick(row, "name")
    address = pick(row, "road_address") or pick(row, "lot_address")
    if not external_id or not name or not address:
        return None, "missing_required_field"
    updated_raw = pick(row, "updated_at")
    updated_digits = re.sub(r"[^0-9]", "", updated_raw)
    allow_legacy = bool(updated_digits[:4] and int(updated_digits[:4]) < 2011)
    coordinate = transform_coordinate(pick(row, "x"), pick(row, "y"), allow_legacy=allow_legacy)
    if coordinate.reason:
        return None, coordinate.reason
    facility_type, reason = classify(service_code, pick(row, "business_type"), name)
    if reason:
        return None, reason
    status = pick(row, "status")
    payload = {
        "external_id": external_id,
        "source_status": status,
        "source_updated_at": parse_updated_at(updated_raw),
        "name": name,
        "address": address,
        "type": facility_type,
        "latitude": coordinate.latitude,
        "longitude": coordinate.longitude,
        "capacity": capacity_for(facility_type),
        "operating_hours": {},
        "features": {
            "indoor": True,
            "indoor_evidence": "fixed_food_establishment",
            "capacity_evidence": "synthetic_type_default",
            "localdata_service_code": service_code,
            "localdata_business_type": pick(row, "business_type"),
        },
        "is_active": status == ACTIVE_STATUS,
        "coordinate_crs": coordinate.crs,
        "normalized_name": normalize_text(name),
        "normalized_address": normalize_address(address),
    }
    payload["source_hash"] = stable_hash(payload)
    return payload, None


def find_duplicate(record: dict, facilities: Iterable[dict]) -> tuple[str | None, str | None]:
    exact_address, nearby = [], []
    for facility in facilities:
        if normalize_text(str(facility.get("name") or "")) != record["normalized_name"]:
            continue
        if normalize_address(str(facility.get("address") or "")) == record["normalized_address"]:
            exact_address.append(str(facility["id"]))
            continue
        try:
            distance = haversine_m(
                (record["latitude"], record["longitude"]),
                (float(facility["latitude"]), float(facility["longitude"])),
            )
        except (KeyError, TypeError, ValueError):
            continue
        if distance <= 50:
            nearby.append(str(facility["id"]))
    matches = exact_address or nearby
    if len(matches) == 1:
        return matches[0], "name_address" if exact_address else "name_50m"
    if len(matches) > 1:
        return None, "multiple_duplicate_candidates"
    return None, None
