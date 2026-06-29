"""
카카오 로컬 REST API로 지정한 사각형 범위 내 식당을 수집하고,
지도 이미지의 1~7번 그룹으로 분류하여 지정된 CSV 양식으로 저장합니다.

[준비]
1. 카카오 API 키 재발급(노출된 키는 폐기 권장):  https://developers.kakao.com
2. 환경변수 설정 (Windows PowerShell):
       $env:KAKAO_REST_API_KEY="새로_발급받은_키"
3. pip install requests

[출력 컬럼]
   id,name,type,latitude,longitude,capacity,operating_hours,features
   - id           : null (고정)
   - name         : 카카오 place_name
   - type         : 카테고리를 영문 분류로 매핑 (restaurant/cafeteria/cafe/fastfood/bar/...)
   - latitude     : 위도 (y)
   - longitude    : 경도 (x)
   - capacity     : null
   - operating_hours : null  (카카오 카테고리 API 미제공)
   - features     : {"has_vegetarian": null, "average_price": null, "cuisine_tags": [...]}
                    cuisine_tags 는 카테고리 문자열에서 추출

[정렬]
   - 그룹 번호(1~7) 오름차순으로 행 정렬
   - 1~6번 그룹은 아래 GROUPS 의 중심좌표+반경 원에 들어가면 해당 그룹
   - 어느 원에도 안 들어가면 7번
   * GROUPS 의 중심/반경은 업로드 지도 이미지를 근사한 값이므로,
     실제 결과를 보고 미세조정하세요.
"""

import os
import csv
import json
import time
import math
import requests

# ─────────────────────────────────────────────────────────────
# 설정
# ─────────────────────────────────────────────────────────────
KAKAO_API_KEY = os.environ.get("KAKAO_REST_API_KEY", "여기에_REST_API_키_입력")

# 주신 4개 꼭짓점을 감싸는 최소/최대 좌표 (사각형 범위)
#  좌상단 36.125695,128.357904 / 좌하단 36.082791,128.339333
#  우하단 36.085218,128.392306 / 우상단 36.124167,128.392965
MIN_LAT = 36.082791
MAX_LAT = 36.125695
MIN_LNG = 128.339333
MAX_LNG = 128.392965

GRID_STEP_M = 300      # 격자 칸 크기(m). 밀집 지역 누락 시 줄이세요.
CATEGORY_CODE = "FD6"  # 음식점. 카페까지 원하면 ("FD6","CE7") 로 확장 가능
REQUEST_DELAY = 0.2
OUTPUT_CSV = "gumi_restaurants_grouped.csv"

# 그룹 원: (그룹번호, 중심위도, 중심경도, 반경m) — 지도 이미지 근사값
GROUPS = [
    (1, 36.1205, 128.3690, 700),   # 우상단 강변코오롱/하늘채 일대
    (2, 36.1190, 128.3540, 650),   # 좌상단 금오테크노밸리 위
    (3, 36.1060, 128.3585, 600),   # 롯데마트~이마트 세로 띠
    (4, 36.0930, 128.3490, 750),   # 좌하단 산호아파트 일대
    (5, 36.0880, 128.3640, 500),   # 임은코오롱 하늘채 위
    (6, 36.1020, 128.3760, 650),   # 우측 롯데시네마/국가산단 일대
]

# 카테고리 문자열 → type 영문 매핑 규칙 (위에서부터 먼저 매칭)
TYPE_RULES = [
    ("패스트푸드", "fastfood"),
    ("분식",       "fastfood"),
    ("도시락",     "cafeteria"),
    ("뷔페",       "cafeteria"),
    ("구내식당",   "cafeteria"),
    ("카페",       "cafe"),
    ("디저트",     "cafe"),
    ("술집",       "bar"),
    ("호프",       "bar"),
    ("주점",       "bar"),
    ("요리주점",   "bar"),
]
DEFAULT_TYPE = "restaurant"

API_URL = "https://dapi.kakao.com/v2/local/search/category.json"


def meters_to_degrees(meters, latitude):
    dlat = meters / 111_320.0
    dlng = meters / (111_320.0 * math.cos(math.radians(latitude)))
    return dlat, dlng


def haversine_m(lat1, lng1, lat2, lng2):
    R = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def make_grid(step_m):
    mid_lat = (MIN_LAT + MAX_LAT) / 2
    dlat, dlng = meters_to_degrees(step_m, mid_lat)
    cells, lat = [], MIN_LAT
    while lat < MAX_LAT:
        lng = MIN_LNG
        while lng < MAX_LNG:
            cells.append((lng, lat, min(lng + dlng, MAX_LNG), min(lat + dlat, MAX_LAT)))
            lng += dlng
        lat += dlat
    return cells


def search_cell(session, rect):
    out, rect_str, page = [], f"{rect[0]},{rect[1]},{rect[2]},{rect[3]}", 1
    while page <= 3:
        params = {"category_group_code": CATEGORY_CODE, "rect": rect_str, "page": page, "size": 15}
        r = session.get(API_URL, params=params, timeout=10)
        if r.status_code != 200:
            print(f"  [경고] {r.status_code}: {r.text[:120]}")
            break
        data = r.json()
        out.extend(data.get("documents", []))
        if data.get("meta", {}).get("is_end", True):
            break
        page += 1
        time.sleep(REQUEST_DELAY)
    return out


def classify_group(lat, lng):
    """가장 가까운(반경 내) 그룹 번호 반환. 없으면 7."""
    best, best_dist = 7, None
    for gid, glat, glng, radius in GROUPS:
        d = haversine_m(lat, lng, glat, glng)
        if d <= radius and (best_dist is None or d < best_dist):
            best, best_dist = gid, d
    return best


def map_type(category_name):
    cat = category_name or ""
    for kw, t in TYPE_RULES:
        if kw in cat:
            return t
    return DEFAULT_TYPE


def cuisine_tags(category_name):
    """'음식점 > 한식 > 국밥' 형태에서 의미있는 토큰 추출."""
    if not category_name:
        return []
    parts = [p.strip() for p in category_name.split(">")]
    parts = [p for p in parts if p and p != "음식점"]
    seen, tags = set(), []
    for p in parts:
        if p not in seen:
            seen.add(p)
            tags.append(p)
    return tags


def main():
    if KAKAO_API_KEY in ("", "여기에_REST_API_키_입력"):
        raise SystemExit("환경변수 KAKAO_REST_API_KEY 를 설정하세요.")

    session = requests.Session()
    session.headers.update({"Authorization": f"KakaoAK {KAKAO_API_KEY}"})

    cells = make_grid(GRID_STEP_M)
    print(f"격자 {len(cells)}칸 수집 시작...")
    seen = {}
    for i, rect in enumerate(cells, 1):
        for d in search_cell(session, rect):
            seen[d["id"]] = d
        print(f"  [{i}/{len(cells)}] 누적 {len(seen)}건")
        time.sleep(REQUEST_DELAY)

    rows = []
    for d in seen.values():
        lat, lng = float(d["y"]), float(d["x"])
        # 사각형 밖이면 제외(격자가 경계를 살짝 넘을 수 있음)
        if not (MIN_LAT <= lat <= MAX_LAT and MIN_LNG <= lng <= MAX_LNG):
            continue
        group = classify_group(lat, lng)
        features = {
            "has_vegetarian": None,
            "average_price": None,
            "cuisine_tags": cuisine_tags(d.get("category_name", "")),
        }
        rows.append({
            "_group": group,
            "id": "null",
            "name": d.get("place_name", ""),
            "type": map_type(d.get("category_name", "")),
            "latitude": round(lat, 6),
            "longitude": round(lng, 6),
            "capacity": "null",
            "operating_hours": "null",
            "features": json.dumps(features, ensure_ascii=False),
        })

    rows.sort(key=lambda r: (r["_group"], r["name"]))
    print(f"\n총 {len(rows)}개 식당. 그룹별 분포:")
    for g in range(1, 8):
        print(f"  그룹 {g}: {sum(1 for r in rows if r['_group'] == g)}개")

    fieldnames = ["id", "name", "type", "latitude", "longitude",
                  "capacity", "operating_hours", "features"]
    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)

    print(f"\n완료: {OUTPUT_CSV}")


if __name__ == "__main__":
    main()