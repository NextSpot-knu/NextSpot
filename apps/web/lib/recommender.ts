// 클라이언트 추천 점수·정렬·사유 엔진 — 백엔드 SPOT 메커니즘의 "미러".
//
// 용도(데모를 따로 분리):
//  1) 데모 전용 시설(합성 카페/관광지 그룹, 시간대 시뮬 mockHour)의 점수·사유
//  2) 백엔드(/api/v1/recommendations/by-type) 미가용 시 폴백
//  3) 지도 마커 정렬 캡 등 대량 점수(백엔드 호출 없이)
//
// 가중치는 백엔드 services/spot/score.py 와 동일하게 맞춘다(이전 main 인라인은
// 시간/혼잡분산 가중치가 뒤바뀐 0.30/0.25 였음 → 0.25/0.30 으로 정정).
//   W1(선호)=0.45, W2(시간비용)=0.25, W3(혼잡분산)=0.30

import type { RecommendationResponse } from "./api-client";

export const CATEGORY_VECTORS: Record<string, number[]> = {
  // dim0-3: 카테고리 원핫 / dim4: 맛·평점 / dim5: 감성·인스타 / dim6: 접근성·무장애 / dim7: 한적함
  restaurant: [1.0, 0.0, 0.0, 0.0, 0.3, 0.0, 0.0, 0.0],
  cafe: [0.0, 1.0, 0.0, 0.0, 0.1, 0.3, 0.0, 0.0],
  attraction: [0.0, 0.0, 1.0, 0.0, 0.0, 0.1, 0.2, 0.0],
  culture: [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.2, 0.2],
};

export interface Spot {
  score: number; // 0~100
  preferencePercent: number; // 0~100
  expectedWait: number; // 분
  expectedTravel: number; // 분
  timeToService: number; // 분
}

export interface ScoreOpts {
  userLocation: { lat: number; lng: number };
  preferredCategories?: string[];
  mockHour?: number | null;
  // 음식 의도(음성 발화 '고기/국밥/피자' 또는 온보딩 선호). 있으면 선호%를 음식종류 매칭으로 산출.
  cuisineIntent?: string | null;
}

// 음식 의도 키워드 → 관련 cuisine_tag 토큰. 의도와 시설 cuisine_tags 매칭으로 선호%를 결정한다.
const CUISINE_INTENT_MAP: { keys: string[]; tags: string[] }[] = [
  { keys: ["곱창", "막창", "대창"], tags: ["곱창,막창"] },
  { keys: ["국밥", "해장", "돼지국밥"], tags: ["국밥"] },
  { keys: ["순대", "순댓"], tags: ["순대"] },
  { keys: ["족발", "보쌈"], tags: ["족발,보쌈"] },
  { keys: ["피자", "파스타", "스테이크", "양식", "햄버거", "버거", "리조또", "스파게티"], tags: ["양식", "피자", "햄버거"] },
  { keys: ["칼국수", "국수", "냉면", "수제비", "막국수"], tags: ["국수", "칼국수", "수제비"] },
  { keys: ["치킨", "통닭", "닭강정"], tags: ["치킨"] },
  { keys: ["닭갈비", "찜닭", "백숙", "삼계탕"], tags: ["닭요리"] },
  { keys: ["중식", "짜장", "짬뽕", "탕수육", "마라"], tags: ["중식", "중국요리"] },
  { keys: ["초밥", "스시", "사시미", "돈까스", "우동", "라멘", "일식"], tags: ["일식", "돈까스,우동"] },
  { keys: ["물회", "해물", "생선", "조개", "복어", "수산"], tags: ["해물,생선", "회", "조개", "복어"] },
  { keys: ["분식", "떡볶이", "김밥", "토스트", "라볶이"], tags: ["분식", "간식"] },
  { keys: ["찌개", "전골", "부대찌개", "김치찌개", "된장찌개"], tags: ["찌개,전골"] },
  { keys: ["쌀국수", "베트남", "태국", "팟타이", "분짜"], tags: ["베트남음식", "동남아음식", "아시아음식"] },
  { keys: ["갈비"], tags: ["갈비", "육류,고기"] },
  // '고기/구이'는 갈비·곱창보다 뒤에 둬 더 구체적인 분류가 우선되게 한다.
  { keys: ["고기", "육류", "삼겹", "목살", "소고기", "돼지", "숯불", "구이", "한우"], tags: ["육류,고기", "갈비", "삼겹살"] },
  { keys: ["한식", "백반", "가정식", "집밥", "한정식"], tags: ["한식", "한정식"] },
  { keys: ["채식", "비건", "샐러드"], tags: ["채식"] },
];
const _BAR_TAGS_FE = ["술집", "호프", "오뎅바", "실내포장마차", "일본식주점", "호프,요리주점"];
const _HANSIK_SPECIFIC = ["육류,고기", "국밥", "순대", "찌개,전골", "갈비", "곱창,막창", "족발,보쌈", "국수", "칼국수", "닭요리", "해물,생선", "한식", "한정식"];

function _facilityCuisineTokens(facility: any): string[] {
  const raw = facility?.features?.cuisine_tags ?? facility?.features?.cuisine ?? facility?.cuisine;
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  if (typeof raw === "string") return [raw];
  return [];
}

// 음식 의도와 시설의 매칭도(0~1). 의도가 없거나 인식 불가면 null → 호출측에서 카테고리 선호로 폴백.
export function cuisineMatch(facility: any, intent: string | null | undefined): number | null {
  if (!intent) return null;
  // 음식 매칭은 음식점(restaurant)에만 적용. 카페/관광지/문화시설은 null → 카테고리 선호로 폴백(비음식점 선호% 오염 방지).
  if (facility?.type && facility.type !== "restaurant") return null;
  const it = String(intent).toLowerCase();
  const targetTags = new Set<string>();
  for (const grp of CUISINE_INTENT_MAP) {
    if (grp.keys.some((k) => it.includes(k.toLowerCase()))) grp.tags.forEach((t) => targetTags.add(t));
  }
  if (targetTags.size === 0) return null; // 인식 못한 의도 → 카테고리 선호 폴백
  const tags = _facilityCuisineTokens(facility);
  const name = String(facility?.name || "");
  if (tags.some((t) => _BAR_TAGS_FE.includes(t))) return 0.12; // 술집은 음식 의도에 거의 안 맞음
  if (tags.some((t) => targetTags.has(t))) return 0.95; // cuisine_tag 정확 일치
  // 상호 이름에 타깃 메뉴가 박힌 경우(예: '윤쉐프의고기집')
  if (CUISINE_INTENT_MAP.some((g) => g.tags.some((t) => targetTags.has(t)) && g.keys.some((k) => name.includes(k)))) return 0.85;
  if (tags.includes("한식") && [...targetTags].some((t) => _HANSIK_SPECIFIC.includes(t))) return 0.45; // 같은 대분류(한식) 약한 점수
  return 0.18; // 무관
}

const WALK_M_PER_MIN = 66.67; // 백엔드 WALKING_SPEED_M_PER_MIN 와 동일
const BROWSE_BASELINE_CONGESTION = 0.7; // 원본이 없는 브라우즈 랭킹의 혼잡 분산 기준선(백엔드와 동일)

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 현실성 컷오프: 사용자 위치에서 도보 비현실 거리(기본 1.5km≈22분)의 시설을 추천 후보에서 제외.
// 반경 내가 minKeep 미만이면 가까운 순으로 폴백(빈손/외곽 위치 방지). 백엔드 _MAX_RECO_DISTANCE_M 미러.
// 지도 마커 전체 표시에는 영향 없음(추천 후보 랭킹 직전에만 적용).
export const MAX_RECO_DISTANCE_M = 1500;
export function filterReachable(
  facilities: any[],
  origin: { lat: number; lng: number },
  maxM: number = MAX_RECO_DISTANCE_M,
  minKeep: number = 5,
): any[] {
  const withD = facilities
    .map((f) => ({ f, d: haversineMeters(origin.lat, origin.lng, f.latitude, f.longitude) }))
    .sort((a, b) => a.d - b.d);
  const reach = withD.filter((x) => x.d <= maxM).map((x) => x.f);
  return reach.length >= minKeep ? reach : withD.slice(0, minKeep).map((x) => x.f);
}

function preferenceMatch(facility: any, preferredCategories: string[]): number {
  const userVec = [0, 0, 0, 0, 0, 0, 0, 0];
  let count = 0;
  const cats = preferredCategories.length > 0 ? preferredCategories : Object.keys(CATEGORY_VECTORS);
  cats.forEach((c) => {
    if (CATEGORY_VECTORS[c]) {
      for (let i = 0; i < 8; i++) userVec[i] += CATEGORY_VECTORS[c][i];
      count++;
    }
  });
  const nu = count > 0 ? userVec.map((v) => v / count) : userVec.map(() => 1 / Math.sqrt(8));
  const un = Math.sqrt(nu.reduce((s, v) => s + v * v, 0));
  const uf = nu.map((v) => (un > 0 ? v / un : v));

  const fv = [...(CATEGORY_VECTORS[facility.type] || [0, 0, 0, 0, 0, 0, 0, 0])];
  if (facility.features) {
    if (facility.features.barrier_free) fv[6] += 0.3;
    if (facility.features.instagrammable && facility.type === "cafe") fv[5] += 0.2;
  }
  const fn = Math.sqrt(fv.reduce((s, v) => s + v * v, 0));
  const ff = fv.map((v) => (fn > 0 ? v / fn : v));

  let dot = 0;
  for (let i = 0; i < 8; i++) dot += uf[i] * ff[i];
  return Math.max(0, Math.min(1, dot));
}

// 백엔드 SPOT(예측 대기·이동·incentive)를 '보존'하고 선호 항만 cuisineMatch 로 교체해 동일 가중치·산식으로
// score 만 재유도한다. 라이브 by-type 경로에서 scoreFacility 통째 재계산이 백엔드 Vertex 예측값을 버려
// 사유와 수치가 어긋나던 문제를 막는다. 비식당/미인식(cMatch=null)은 호출측이 이 함수를 안 부르고 백엔드 spot 유지.
export function rescoreWithPreference(t: Spot, pref: number, congestionLevel: number): Spot {
  const w1 = 0.45, w2 = 0.25, w3 = 0.3;
  const timeCost = Math.min(1.0, ((t.expectedWait || 0) + (t.expectedTravel || 0)) / 60.0);
  const incentive = Math.max(0, BROWSE_BASELINE_CONGESTION - (congestionLevel ?? 0));
  const raw = w1 * pref - w2 * timeCost + w3 * incentive;
  const finalScore = Math.max(0, Math.min(1, (raw + w2) / (w1 + w2 + w3)));
  return {
    ...t, // expectedWait/expectedTravel/timeToService = 백엔드 예측 보존
    score: isNaN(finalScore) ? t.score : Math.round(finalScore * 100),
    preferencePercent: isNaN(pref) ? t.preferencePercent : Math.round(pref * 100),
  };
}

export function scoreFacility(facility: any, opts: ScoreOpts): Spot {
  if (!facility) return { score: 0, preferencePercent: 0, expectedWait: 0, expectedTravel: 0, timeToService: 0 };

  // 음식 의도(음성/온보딩)가 있으면 선호 = 음식종류 매칭(식당별로 변동), 없으면 기존 카테고리 선호.
  const cMatch = cuisineMatch(facility, opts.cuisineIntent);
  const pref = cMatch !== null ? cMatch : preferenceMatch(facility, opts.preferredCategories || []);

  const defaultTimes: Record<string, number> = {
    restaurant: 25,
    cafe: 12,
    attraction: 15,
    culture: 15,
  };
  const avgProcess = facility.features?.average_processing_time ?? defaultTimes[facility.type] ?? 15;
  // 라이브 폴백 시각은 백엔드(score.py/wait_time.py)가 UTC arrival_hour 로 피크 배수를 판정하는 것과
  // 정합되도록 getUTCHours() 를 쓴다(getHours()=브라우저 로컬=KST 면 9시간 어긋남). mockHour(데모 시뮬값)는 그대로.
  const hour = opts.mockHour !== null && opts.mockHour !== undefined ? opts.mockHour : new Date().getUTCHours();
  let mult = 1.0;
  if (hour >= 11 && hour < 14) mult = 1.3;
  else if (hour >= 14 && hour < 18) mult = 1.2;

  const cong = facility.congestionLevel ?? 0;
  const expectedWait = cong * avgProcess * mult;

  const fLat = typeof facility.latitude === "number" ? facility.latitude : opts.userLocation.lat;
  const fLng = typeof facility.longitude === "number" ? facility.longitude : opts.userLocation.lng;
  const distanceM = haversineMeters(opts.userLocation.lat, opts.userLocation.lng, fLat, fLng);
  const expectedTravel = distanceM / WALK_M_PER_MIN;

  // 백엔드 동일 가중치: 선호 0.45 − 시간비용 0.25 + 혼잡분산 0.30, Min-Max 정규화
  const w1 = 0.45,
    w2 = 0.25,
    w3 = 0.3;
  const timeCost = Math.min(1.0, (expectedWait + expectedTravel) / 60.0);
  const incentive = Math.max(0, BROWSE_BASELINE_CONGESTION - cong);
  const raw = w1 * pref - w2 * timeCost + w3 * incentive;
  const normalized = (raw + w2) / (w1 + w2 + w3);
  const finalScore = Math.max(0, Math.min(1, normalized));

  return {
    score: isNaN(finalScore) ? 0 : Math.round(finalScore * 100),
    preferencePercent: isNaN(pref) ? 0 : Math.round(pref * 100),
    expectedWait: isNaN(expectedWait) ? 0 : Math.round(expectedWait * 10) / 10,
    expectedTravel: isNaN(expectedTravel) ? 0 : Math.round(expectedTravel * 10) / 10,
    timeToService: isNaN(expectedWait + expectedTravel) ? 0 : Math.round((expectedWait + expectedTravel) * 10) / 10,
  };
}

export function compareSpot(a: any, b: any): number {
  const at = a.spot,
    bt = b.spot;
  if (!at || !bt) return (a.name || "").localeCompare(b.name || "", "ko-KR");
  if (bt.score !== at.score) return bt.score - at.score; // 1. 높은 점수
  if (at.timeToService !== bt.timeToService) return at.timeToService - bt.timeToService; // 2. 짧은 총 소요
  if (bt.preferencePercent !== at.preferencePercent) return bt.preferencePercent - at.preferencePercent; // 3. 높은 선호
  if (at.expectedTravel !== bt.expectedTravel) return at.expectedTravel - bt.expectedTravel; // 4. 짧은 이동
  return (a.name || "").localeCompare(b.name || "", "ko-KR"); // 5. 가나다
}

// 시설 배열에 spot+reason 을 부여하고 정렬(데모/폴백/마커 공용). 기존 reason 은 보존.
export function rankFacilities(facilities: any[], opts: ScoreOpts): any[] {
  const scored = facilities.map((f) => {
    const spot = scoreFacility(f, opts);
    return { ...f, spot, reason: f.reason || "" }; // 사유는 백엔드 Gemini(f.reason)만. 하드코딩 템플릿 제거.
  });
  scored.sort(compareSpot);
  return scored;
}

// 백엔드 RecommendItem(camelCase) → 카드용 Spot 형태로 변환.
export function recToSpot(rec: RecommendationResponse): Spot {
  const b = (rec.breakdown || {}) as any;
  const wait = typeof b.waitTime === "number" ? b.waitTime : 0;
  const travel = typeof b.travelTime === "number" ? b.travelTime : (rec.distanceM || 0) / WALK_M_PER_MIN;
  const score01 = rec.spotScore <= 1 ? rec.spotScore : rec.spotScore / 100;
  return {
    score: Math.round(score01 * 100),
    preferencePercent: Math.round((typeof b.preference === "number" ? b.preference : 0) * 100),
    expectedWait: Math.round(wait * 10) / 10,
    expectedTravel: Math.round(travel * 10) / 10,
    timeToService: Math.round((wait + travel) * 10) / 10,
  };
}
