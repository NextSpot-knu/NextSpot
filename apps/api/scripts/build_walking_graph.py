"""OpenStreetMap 보행 가능 도로를 경주 중심 소형 런타임 그래프로 만든다.

생성물은 ODbL 1.0의 OpenStreetMap 데이터 파생물이다. 앱 실행 중 외부 라우팅 API를 호출하지
않으므로 추천 지연과 API 키가 늘지 않는다. 데이터 갱신은 이 스크립트를 다시 실행해 검토한다.

그래프를 새로 받으면 옆에 압축 그래프(`*.csr.bin`, WALKING_ROUTE_KERNEL=csr 가 읽는다)도 함께 쓴다.
원본은 그대로 두고 압축 그래프만 다시 만들려면 `--emit-csr`(네트워크 없음). 둘 다 커밋한다 —
`tests/services/test_walking_csr.py` 가 커밋된 이진 = 원본에서 새로 만든 바이트인지 확인한다.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import sys

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.spot import walking_csr  # noqa: E402 — 순수 모듈(설정·시크릿 없음)

DEFAULT_BBOX = (35.80, 129.17, 35.88, 129.25)
DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter"
EXCLUDED_HIGHWAYS = {
    "motorway", "motorway_link", "construction", "proposed", "raceway", "abandoned",
}
EXCLUDED_ACCESS = {"private", "no"}


def _distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lng1, lat2, lng2 = map(math.radians, [a[0], a[1], b[0], b[1]])
    dlat, dlng = lat2 - lat1, lng2 - lng1
    value = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 6_371_000 * 2 * math.asin(min(1.0, math.sqrt(value)))


def build_graph(elements: list[dict[str, Any]], bbox: tuple[float, float, float, float]) -> dict[str, Any]:
    coordinates = {
        int(element["id"]): (float(element["lat"]), float(element["lon"]))
        for element in elements
        if element.get("type") == "node" and "lat" in element and "lon" in element
    }
    edges: set[tuple[int, int, int]] = set()
    used_nodes: set[int] = set()
    way_count = 0
    for element in elements:
        if element.get("type") != "way":
            continue
        tags = element.get("tags") or {}
        highway = str(tags.get("highway") or "")
        if not highway or highway in EXCLUDED_HIGHWAYS:
            continue
        if str(tags.get("access") or "") in EXCLUDED_ACCESS or str(tags.get("foot") or "") in EXCLUDED_ACCESS:
            continue
        nodes = [int(node) for node in element.get("nodes") or [] if int(node) in coordinates]
        if len(nodes) < 2:
            continue
        foot_oneway = str(tags.get("oneway:foot") or "").lower() in {"yes", "1", "true"}
        for start, end in zip(nodes, nodes[1:]):
            meters = max(1, round(_distance(coordinates[start], coordinates[end])))
            edges.add((start, end, meters))
            if not foot_oneway:
                edges.add((end, start, meters))
            used_nodes.update((start, end))
        way_count += 1
    node_rows = [[node, *coordinates[node]] for node in sorted(used_nodes)]
    return {
        "metadata": {
            "source": "OpenStreetMap contributors",
            "license": "ODbL-1.0",
            "source_url": "https://www.openstreetmap.org/copyright",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "bbox": list(bbox),
            "way_count": way_count,
        },
        "nodes": node_rows,
        "edges": [list(edge) for edge in sorted(edges)],
    }


def csr_path_for(source: Path) -> Path:
    name = source.name
    stem = name[: -len(".json.gz")] if name.endswith(".json.gz") else name
    return source.with_name(stem + ".csr.bin")


def emit_csr(source: Path) -> Path:
    """원본 .json.gz 바이트에서 압축 그래프를 만들어 옆에 쓴다(결정적 — 같은 원본이면 같은 바이트)."""
    data = source.read_bytes()
    raw = json.loads(gzip.decompress(data).decode("utf-8"))
    graph = walking_csr.build_from_raw(raw, walking_csr.source_digest(data))
    target = csr_path_for(source)
    target.write_bytes(walking_csr.to_bytes(graph))
    return target


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "app/data/gyeongju_walking_graph.json.gz",
    )
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument(
        "--emit-csr", action="store_true",
        help="Overpass 를 부르지 않고 --output 의 원본에서 압축 그래프(.csr.bin)만 다시 만든다",
    )
    args = parser.parse_args()
    if args.emit_csr:
        target = emit_csr(args.output)
        print(json.dumps({"output": str(target), "bytes": target.stat().st_size}, ensure_ascii=False))
        return
    south, west, north, east = DEFAULT_BBOX
    query = (
        "[out:json][timeout:180];"
        f"way[\"highway\"]({south},{west},{north},{east});"
        "(._;>;);out body qt;"
    )
    response = httpx.post(
        args.endpoint,
        content=query.encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "NextSpot/1.0"},
        timeout=240,
    )
    response.raise_for_status()
    payload = response.json()
    graph = build_graph(payload.get("elements") or [], DEFAULT_BBOX)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(args.output, "wt", encoding="utf-8", compresslevel=9) as target:
        json.dump(graph, target, ensure_ascii=False, separators=(",", ":"))
    csr_target = emit_csr(args.output)
    print(json.dumps({
        "output": str(args.output),
        "csr": str(csr_target),
        "nodes": len(graph["nodes"]),
        "edges": len(graph["edges"]),
        "ways": graph["metadata"]["way_count"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
