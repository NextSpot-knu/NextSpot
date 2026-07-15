"""관광공사 집중률·연관관광지 스냅샷 적재 배치.

각 상품은 KorService2와 별도 활용신청이 필요하다. 미승인(403) 상품은 명확히 실패하며,
기존 POI 적재나 API 서버에는 영향을 주지 않는다.
"""

import argparse
import asyncio
import os
import sys
from datetime import date

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.supabase import supabase_admin
from app.services.tourapi.client import parse_items
from app.services.tourapi.insights import (
    concentration_forecast,
    normalized_concentration_rows,
    related_attractions,
)


async def run(*, dry_run: bool, base_ym: str) -> int:
    concentration_payload = await concentration_forecast()
    concentration_rows = normalized_concentration_rows(concentration_payload)
    related_payload = await related_attractions(base_ym=base_ym)
    related_items = parse_items(related_payload)

    print(f"집중률 전망 {len(concentration_rows)}행 · 연관관광지 {len(related_items)}행")
    if dry_run:
        for row in concentration_rows[:5]:
            print(row)
        return 0

    if concentration_rows:
        supabase_admin.table("tourism_concentration_forecasts").upsert(
            concentration_rows, on_conflict="tourist_attraction_name,forecast_date"
        ).execute()
    supabase_admin.table("tourism_insight_snapshots").upsert({
        "insight_type": "related_attraction",
        "reference_period": base_ym,
        "region_code": "47130",
        "payload": {"items": related_items},
    }, on_conflict="insight_type,reference_period,region_code").execute()
    return 0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--base-ym", default=date.today().strftime("%Y%m"))
    args = parser.parse_args()
    raise SystemExit(asyncio.run(run(dry_run=args.dry_run, base_ym=args.base_ym)))


if __name__ == "__main__":
    main()

