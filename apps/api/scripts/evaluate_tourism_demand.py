"""Print a read-only tourism-demand differentiation report from the operating DB."""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.core.supabase import supabase_admin
from app.routers.infrastructures import fetch_active_facilities
from app.services.batch.tourism_demand_evaluation import (
    attach_and_measure_tourism_coverage,
    evaluate_tourism_demand_impact,
)
from app.services.travel_context import KST


async def build_report(forecast_date: str) -> dict:
    # Both operations are reads. Keep them sequential because the synchronous
    # Supabase client is shared and concurrent access can serialize internally.
    facilities = await fetch_active_facilities(
        supabase_admin, "id,name,type,latitude,longitude,is_active"
    )
    forecast_result = await asyncio.to_thread(
        lambda: (
            supabase_admin.table("tourism_concentration_forecasts")
            .select("tourist_attraction_name,concentration_rate,forecast_date")
            .eq("forecast_date", forecast_date)
            .execute()
        )
    )
    forecasts = forecast_result.data or []
    coverage = attach_and_measure_tourism_coverage(facilities, forecasts)
    report = evaluate_tourism_demand_impact(facilities)
    report["anchor_coverage"] = coverage
    report["forecast_date"] = forecast_date
    report["forecast_row_count"] = len(forecasts)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--forecast-date",
        default=datetime.now(KST).date().isoformat(),
        help="KTO forecast date (YYYY-MM-DD); defaults to today in KST",
    )
    parser.add_argument("--output", type=Path, help="Optional local JSON output path")
    args = parser.parse_args()

    report = asyncio.run(build_report(args.forecast_date))
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
