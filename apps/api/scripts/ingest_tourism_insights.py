"""관광공사 집중률·연관관광지 스냅샷 적재 배치.

두 데이터셋은 서로 다른 활용승인이 필요한 상품이다. 기본 실행은 주변 수요에 직접 쓰는
집중률만 수집한다. 연관관광지는 별도 승인된 환경에서 ``--dataset related``로 실행해,
한 상품의 미승인이 다른 상품의 유효한 관측까지 버리지 않게 한다.
"""

import argparse
import asyncio
import math
import os
import sys
from datetime import date, datetime, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.supabase import supabase_admin
from app.services.tourapi.client import parse_items, parse_total_count
from app.services.tourapi.insights import (
    concentration_forecast,
    normalized_concentration_rows,
    normalized_related_rows,
    related_attractions,
)

_CONCENTRATION_PAGE_SIZE = 1_000
_MAX_CONCENTRATION_PAGES = 50


async def _load_all_concentration_rows() -> list[dict]:
    """공식 totalCount를 따라 전 페이지를 수집하고 이름·날짜 중복을 제거한다."""
    first = await concentration_forecast(page=1, rows=_CONCENTRATION_PAGE_SIZE)
    total_count = parse_total_count(first)
    page_count = max(1, math.ceil(total_count / _CONCENTRATION_PAGE_SIZE))
    if page_count > _MAX_CONCENTRATION_PAGES:
        raise RuntimeError(
            f"집중률 응답이 안전한 페이지 상한을 넘었습니다(totalCount={total_count})."
        )
    payloads = [first]
    for page in range(2, page_count + 1):
        payloads.append(await concentration_forecast(page=page, rows=_CONCENTRATION_PAGE_SIZE))

    unique: dict[tuple[str, str], dict] = {}
    for payload in payloads:
        for row in normalized_concentration_rows(payload):
            key = (row["tourist_attraction_name"], row["forecast_date"])
            unique[key] = row
    return list(unique.values())


async def _ingest_concentration(*, dry_run: bool) -> None:
    rows = await _load_all_concentration_rows()
    if not rows:
        raise RuntimeError("집중률 API는 응답했지만 저장 가능한 전망 행이 없습니다.")
    print(f"집중률 전망 {len(rows)}행")
    if dry_run:
        for row in rows[:5]:
            print(row)
        return
    fetched_at = datetime.now(timezone.utc).isoformat()
    supabase_admin.table("tourism_concentration_forecasts").upsert(
        [{**row, "fetched_at": fetched_at} for row in rows],
        on_conflict="tourist_attraction_name,forecast_date",
    ).execute()


async def _ingest_related(*, dry_run: bool, base_ym: str) -> None:
    payload = await related_attractions(base_ym=base_ym)
    items = parse_items(payload)
    rows = normalized_related_rows(payload)
    print(f"연관관광지 원본 {len(items)}행/정규화 {len(rows)}행")
    if dry_run:
        return
    supabase_admin.table("tourism_insight_snapshots").upsert({
        "insight_type": "related_attraction",
        "reference_period": base_ym,
        "region_code": "47130",
        "payload": {"items": items, "normalized_items": rows},
    }, on_conflict="insight_type,reference_period,region_code").execute()


async def run(*, dry_run: bool, base_ym: str, dataset: str = "concentration") -> int:
    if dataset in {"concentration", "all"}:
        # all 모드에서도 먼저 저장한다. 뒤의 별도 상품이 실패해도 승인된 집중률은 남는다.
        await _ingest_concentration(dry_run=dry_run)
    if dataset in {"related", "all"}:
        await _ingest_related(dry_run=dry_run, base_ym=base_ym)
    return 0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--base-ym", default=date.today().strftime("%Y%m"))
    parser.add_argument(
        "--dataset",
        choices=("concentration", "related", "all"),
        default="concentration",
        help="기본은 승인된 집중률만 수집합니다. 연관관광지는 별도 승인 후 실행하세요.",
    )
    args = parser.parse_args()
    raise SystemExit(asyncio.run(run(
        dry_run=args.dry_run,
        base_ym=args.base_ym,
        dataset=args.dataset,
    )))


if __name__ == "__main__":
    main()
