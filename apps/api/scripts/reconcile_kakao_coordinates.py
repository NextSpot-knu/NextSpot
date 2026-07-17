"""기존 facilities 좌표를 엄격 매칭된 Kakao 장소 좌표로 교정한다."""

import asyncio
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.supabase import supabase_admin
from app.services.kakao_coordinate_service import reconcile_row_coordinate


async def main() -> int:
    rows = (supabase_admin.table("facilities")
            .select("id,name,address,latitude,longitude,features,contentid")
            .not_.is_("contentid", "null").execute().data or [])
    matched = 0
    for row in rows:
        if await reconcile_row_coordinate(row):
            payload = {k: row[k] for k in ("latitude", "longitude", "features")}
            supabase_admin.table("facilities").update(payload).eq("id", row["id"]).execute()
            matched += 1
            print(f"[match] {row['name']} -> Kakao {row['latitude']},{row['longitude']}")
        else:
            print(f"[skip] {row['name']} (확실한 Kakao 일치 후보 없음)")
    print(f"완료: {matched}/{len(rows)}곳 Kakao 좌표 교정")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
