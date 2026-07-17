"""기존 facilities 좌표를 엄격 매칭된 Kakao 장소 좌표로 교정한다."""

import asyncio
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.supabase import supabase_admin
from app.services.kakao_coordinate_service import reconcile_row_coordinate


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Kakao 기준 시설 좌표 전수 감사")
    parser.add_argument("--apply", action="store_true", help="확정된 교정을 DB에 반영(기본은 dry-run)")
    parser.add_argument(
        "--report", default="scratch/kakao_coordinate_audit.json",
        help="감사 결과 JSON 경로(저장소 루트 기준)",
    )
    return parser.parse_args()


async def main() -> int:
    args = parse_args()
    rows = (supabase_admin.table("facilities")
            .select("id,name,address,latitude,longitude,features,contentid")
            .not_.is_("contentid", "null").execute().data or [])
    matched = 0
    changed = 0
    report: list[dict] = []
    for row in rows:
        before = {"latitude": row.get("latitude"), "longitude": row.get("longitude")}
        if await reconcile_row_coordinate(row):
            payload = {k: row[k] for k in ("latitude", "longitude", "features")}
            matched += 1
            is_changed = before != {"latitude": row["latitude"], "longitude": row["longitude"]}
            changed += int(is_changed)
            if args.apply and is_changed:
                supabase_admin.table("facilities").update(payload).eq("id", row["id"]).execute()
            status = "apply" if args.apply and is_changed else "match"
            print(f"[{status}] {row['name']} -> Kakao {row['latitude']},{row['longitude']}")
            report.append({
                "id": row["id"], "name": row["name"], "address": row.get("address"),
                "status": "changed" if is_changed else "unchanged", "before": before,
                "after": {"latitude": row["latitude"], "longitude": row["longitude"]},
                "kakao_place_id": row["features"].get("kakao_place_id"),
                "kakao_place_url": row["features"].get("kakao_place_url"),
            })
        else:
            print(f"[skip] {row['name']} (확실한 Kakao 일치 후보 없음)")
            report.append({
                "id": row["id"], "name": row["name"], "address": row.get("address"),
                "status": "unresolved", "before": before,
            })
    repo_root = Path(__file__).resolve().parents[2]
    report_path = Path(args.report)
    if not report_path.is_absolute():
        report_path = repo_root / report_path
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps({
        "mode": "apply" if args.apply else "dry-run", "total": len(rows),
        "matched": matched, "changed": changed, "unresolved": len(rows) - matched,
        "facilities": report,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"완료: 일치 {matched}/{len(rows)}, 좌표 변경 대상 {changed}, 미해결 {len(rows) - matched}")
    print(f"감사 보고서: {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
