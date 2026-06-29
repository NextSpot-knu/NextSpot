# -*- coding: utf-8 -*-
"""주차장 has_ev_charger 를 '추정' → '실데이터'로 보강 (Kakao 로컬 키워드검색 = 보유 REST 키, 추가 발급 불필요).

원리: 각 주차장의 **확정 주소**(facility_enrichment.json, 사내주차장 좌표는 무작위라 좌표 대신 주소 사용)를
  Kakao 주소검색으로 지오코딩 → 그 좌표 반경 내 "전기차충전소"(category_name='교통,수송 > 자동차 > 전기차 충전소')
  POI 를 키워드검색 → 결과 유무로 has_ev_charger, 건수로 충전소 수 근사. 출처 ev_source='kakao'.
  지오코딩 실패 시 기존 추정값 유지(ev_source 그대로).

실행(레포 루트, apps/api 의존성 venv 사용 — settings.KAKAO_REST_API_KEY 로드):
  apps/api/.venv/Scripts/python.exe scripts/fetch_ev_chargers.py            # 적용
  apps/api/.venv/Scripts/python.exe scripts/fetch_ev_chargers.py --dry-run  # 미리보기

적용 후: node --env-file=.env.local scripts/enrich_facilities.js 로 라이브 facilities.features 반영,
  필요 시 apps/api/scripts/seed_facility_embeddings.py 재시드(음성/의미검색 메타 갱신).
참고(2순위 보강): 충전기 타입·실시간 상태가 필요하면 한국환경공단 getChargerInfo(경북 zcode=47, data.go.kr 키 발급)로 교차.
"""
import csv, json, os, sys, time, math

_HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(_HERE)
_API = os.path.join(REPO, "apps", "api")
if _API not in sys.path:
    sys.path.insert(0, _API)

import requests  # noqa: E402
from app.core.config import settings  # noqa: E402

DRY = "--dry-run" in sys.argv
KEY = settings.KAKAO_REST_API_KEY
if not KEY:
    raise SystemExit("KAKAO_REST_API_KEY 가 없습니다(apps/api/.env / Secret Manager 확인).")
H = {"Authorization": f"KakaoAK {KEY}"}
RADIUS_M = 300  # 주소 지점 반경(사내 캠퍼스 포함 위해 다소 넉넉)


def geocode(addr):
    """주소 → (lat,lng). 주소검색 우선, 실패 시 키워드검색 폴백."""
    try:
        r = requests.get("https://dapi.kakao.com/v2/local/search/address.json",
                         params={"query": addr, "size": 1}, headers=H, timeout=8)
        docs = r.json().get("documents") if r.status_code == 200 else None
        if docs:
            return float(docs[0]["y"]), float(docs[0]["x"])
        r = requests.get("https://dapi.kakao.com/v2/local/search/keyword.json",
                         params={"query": addr, "size": 1}, headers=H, timeout=8)
        docs = r.json().get("documents") if r.status_code == 200 else None
        if docs:
            return float(docs[0]["y"]), float(docs[0]["x"])
    except Exception as e:
        print(f"  [geocode err] {addr}: {e}")
    return None


def ev_count_near(lat, lng, radius=RADIUS_M):
    """반경 내 '전기차 충전소' POI 수(category_name 으로 정확 필터)."""
    try:
        r = requests.get("https://dapi.kakao.com/v2/local/search/keyword.json",
                         params={"query": "전기차충전소", "y": lat, "x": lng, "radius": radius,
                                 "size": 15, "sort": "distance"}, headers=H, timeout=8)
        if r.status_code != 200:
            return None
        docs = r.json().get("documents", [])
        ev = [d for d in docs if "전기차 충전소" in (d.get("category_name") or "")]
        return len(ev)
    except Exception as e:
        print(f"  [ev err] {lat},{lng}: {e}")
        return None


def main():
    p = os.path.join(REPO, "samples", "facility_enrichment.json")
    recs = json.load(open(p, encoding="utf-8"))
    parking = [r for r in recs if r.get("type") == "parking"]
    print(f"주차장 {len(parking)}곳 EV 실데이터 조회 (Kakao, radius={RADIUS_M}m){' [dry-run]' if DRY else ''}")

    addr_cache = {}   # address -> (has, count) or None
    upd = {}          # name -> (has, count)
    for r in parking:
        addr = (r.get("address") or "").strip()
        if not addr:
            continue
        if addr not in addr_cache:
            coord = geocode(addr)
            if coord:
                cnt = ev_count_near(*coord)
                addr_cache[addr] = (cnt is not None and cnt > 0, cnt or 0) if cnt is not None else None
            else:
                addr_cache[addr] = None
            time.sleep(0.12)
        res = addr_cache[addr]
        if res is None:
            print(f"  ~ {r['name']}: 지오코딩/조회 실패 → 추정값 유지({r.get('has_ev_charger')})")
            continue
        has, cnt = res
        upd[r["name"]] = (has, cnt)
        r["has_ev_charger"] = bool(has)
        r["ev_charger_count"] = cnt or None
        r["ev_source"] = "kakao"

    real_true = sum(1 for h, _ in upd.values() if h)
    print(f"실데이터 적용: {len(upd)}곳 (EV 있음 {real_true} / 없음 {len(upd) - real_true}), 미적용(추정유지) {len(parking) - len(upd)}")
    for nm, (h, c) in list(upd.items())[:50]:
        print(f"  · {nm}: EV={'O' if h else 'X'} ({c}건)")

    if DRY:
        print("[dry-run] 파일 미수정.")
        return

    json.dump(recs, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"facility_enrichment.json 갱신 ({len(upd)}곳)")

    # 두 주차장 CSV features 갱신
    for rel in ["samples/gumi_parking.csv", "samples/gumi_parking_private.csv"]:
        path = os.path.join(REPO, *rel.split("/"))
        rows = list(csv.DictReader(open(path, encoding="utf-8-sig")))
        fields = list(rows[0].keys())
        n = 0
        for row in rows:
            u = upd.get(row["name"])
            if not u:
                continue
            try:
                feats = json.loads(row.get("features") or "{}")
            except Exception:
                feats = {}
            feats["has_ev_charger"] = bool(u[0])
            if u[1]:
                feats["ev_charger_count"] = u[1]
            elif "ev_charger_count" in feats:
                del feats["ev_charger_count"]
            feats["ev_source"] = "kakao"
            row["features"] = json.dumps(feats, ensure_ascii=False)
            n += 1
        with open(path, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
            w.writeheader()
            for row in rows:
                w.writerow(row)
        print(f"  {os.path.basename(path)}: {n}곳 갱신")
    print("DONE")


if __name__ == "__main__":
    main()
