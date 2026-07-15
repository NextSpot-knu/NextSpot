// 클라이언트 추천 점수·정렬·사유 엔진 — 백엔드 SPOT 메커니즘의 "미러".
//
// 용도(데모를 따로 분리):
//  1) 데모 전용 시설(합성 카페/관광지 그룹, 시간대 시뮬 mockHour)의 점수·사유
//  2) 백엔드(/api/v1/recommendations/by-type) 미가용 시 폴백
//  3) 지도 마커 정렬 캡 등 대량 점수(백엔드 호출 없이)
//
// 가중치는 공유 상수(packages/shared-types/spot.ts)의 SPOT_WEIGHTS 를 그대로 쓴다 — 하드코딩 금지.
// 소스 오브 트루스는 백엔드 apps/api/app/services/spot/score.py 이며, score.py ↔ shared-types 의
// 정합성은 apps/api 의 패리티 테스트(test_spot.py)가 CI 에서 강제한다.
// 인센티브 항(w3, 2026-07-07 설계): 0.5·쿠폰항(coupon_rate/0.20 상한) + 0.5·수요재배치(완화)항.

import { SPOT_WEIGHTS, SPOT_INCENTIVE } from "shared-types";
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
  // A4: 행사 혼잡 보정 배지용 — 백엔드 breakdown 원본 그대로 실어 나른다(recToSpot 전용, 클라 미러 계산엔 없음).
  eventBoost?: number;
  eventTitle?: string;
}

export interface ScoreOpts {
  userLocation: { lat: number; lng: number };
  preferredCategories?: string[];
  mockHour?: number | null;
  // 음식 의도(음성 발화 '고기/국밥/피자' 또는 온보딩 선호). 있으면 선호%를 음식종류 매칭으로 산출.
  cuisineIntent?: string | null;
}

// ── 이 모듈이 실제로 '읽는' 필드만 담은 최소 구조 타입 ──
// 호출측(main/page.tsx 의 로컬 Facility 등)의 더 풍부한 타입이 구조적으로 만족한다.
// congestionLevel 은 혼잡 로그가 없으면 null(합성값 금지)이므로 null 을 그대로 반영.
interface ScorableFeatures {
  cuisine_tags?: string[] | string | null;
  cuisine?: string[] | string | null;
  barrier_free?: unknown; // truthy 여부만 본다(JSONB 혼합 타입)
  instagrammable?: unknown; // truthy 여부만 본다
  average_processing_time?: number | null;
  [key: string]: unknown; // 그 외 features JSONB 키 통과
}

interface ScorableFacility {
  name?: string | null;
  type: string; // CATEGORY_VECTORS·기본 처리시간의 인덱스 키
  latitude?: number;
  longitude?: number;
  congestionLevel?: number | null;
  coupon_rate?: number | null;
  cuisine?: string[] | string | null; // features 밖(레거시 위치) 폴백
  features?: ScorableFeatures | null;
  spot?: Spot | null;
  reason?: string | null;
}

// 정렬(compareSpot)이 읽는 필드만 — spot 미부여 항목은 이름순 폴백.
interface SpotRankable {
  name?: string | null;
  spot?: Spot | null;
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

// TourAPI 소분류(cat3) → cuisine 토큰. 실 TourAPI POI(69곳)는 cuisine_tags 가 없고 cat3 만 있으므로
// 이 매핑으로 세부분류 필터/선호 매칭에 참여시킨다(음식점 39 하위 소분류 코드 기준).
const _CAT3_CUISINE: Record<string, string> = {
  A05020100: "한식",
  A05020200: "양식",
  A05020300: "일식",
  A05020400: "중식",
  A05020700: "이색음식점",
};

function _facilityCuisineTokens(facility: ScorableFacility | null | undefined): string[] {
  const raw = facility?.features?.cuisine_tags ?? facility?.features?.cuisine ?? facility?.cuisine;
  const tags = Array.isArray(raw) ? raw.map((x) => String(x)) : typeof raw === "string" ? [raw] : [];
  const cat3 = facility?.features?.cat3;
  if (typeof cat3 === "string" && _CAT3_CUISINE[cat3]) tags.push(_CAT3_CUISINE[cat3]);
  return tags;
}

// TourAPI 공식 메뉴(first_menu=대표메뉴/treat_menu=취급메뉴) 텍스트를 콤마·슬래시·공백으로 분리한 토큰들.
// 2자 미만 토큰(조사·'등' 같은 잔여어)은 잡음이라 버린다. apiClient 응답은 features 내부 키까지
// camelCase 로 재귀 변환되므로(firstMenu) 원본 snake_case(first_menu, supabase 직접 조회 경로)와 함께 지원한다.
function _menuTokens(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  return raw.split(/[,/\s]+/).map((s) => s.trim()).filter((s) => s.length >= 2);
}

// 토큰이 속하는 CUISINE_INTENT_MAP 상 '첫 매칭 그룹' — 상호명 구체성 원칙(nameGroup)과 동일하게,
// 맵 순서상 가장 앞선(가장 구체적인) 그룹을 그 토큰의 정체로 본다.
// exact=true(treat_menu 전용): 완전일치만 인정 — 취급메뉴는 부수 항목이 길게 나열돼 '불고기'처럼
// 무관 그룹 키워드('고기')를 우연히 포함하는 복합어가 섞이기 쉬워(밀면집 사이드 '석쇠불고기'가
// '고기' 의도에 잡히던 사례를 실측으로 확인) 부분일치를 허용하지 않는다.
function _firstMatchingGroup(token: string, exact: boolean): { keys: string[]; tags: string[] } | undefined {
  return CUISINE_INTENT_MAP.find((g) => g.keys.some((k) => (exact ? token === k : token.includes(k))));
}

// 공식 메뉴(first_menu/treat_menu)가 의도 태그와 겹치는지. first_menu 는 단일 대표 메뉴라 신뢰도가 높아
// 부분일치를 허용하고, treat_menu 는 완전일치만 인정한다(위 _firstMatchingGroup 주석 참조).
function _menuMatchesIntent(facility: ScorableFacility | null | undefined, targetTags: Set<string>): boolean {
  const first = _menuTokens(facility?.features?.first_menu ?? facility?.features?.firstMenu);
  const treat = _menuTokens(facility?.features?.treat_menu ?? facility?.features?.treatMenu);
  const hits = (tokens: string[], exact: boolean) =>
    tokens.some((tok) => {
      const grp = _firstMatchingGroup(tok, exact);
      return !!grp && grp.tags.some((t) => targetTags.has(t));
    });
  return hits(first, false) || hits(treat, true);
}

// 음식 의도와 시설의 매칭도(0~1). 의도가 없거나 인식 불가면 null → 호출측에서 카테고리 선호로 폴백.
export function cuisineMatch(facility: ScorableFacility | null | undefined, intent: string | null | undefined): number | null {
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
  // 공식 메뉴(TourAPI first_menu/treat_menu) 매칭 — 왜 0.95 다음·0.85(상호명 추측) 앞인가: 실제 취급
  // 메뉴 데이터가 상호명에서 종류를 유추하는 것보다 신뢰도가 높다(공식 메뉴 > 상호명 추측).
  // 상호명과 동일한 '첫 매칭 그룹=구체성' 원칙: 토큰별 맵 순서상 첫 매칭 그룹의 태그만 인정한다
  // (예: first_menu '한우물회' → 첫 그룹은 '물회'(해물) — 고기 의도엔 안 잡히고 물회/해물 의도에만 잡힘).
  if (_menuMatchesIntent(facility, targetTags)) return 0.9;
  // 상호 이름에 타깃 메뉴가 박힌 경우(예: '윤쉐프의고기집'). 이름이 여러 분류 키워드에 걸치면
  // (예: '한우국밥' — 한우=고기, 국밥=국밥) 맵 순서상 첫 번째(더 구체적인) 분류를 상호의 정체로 보고
  // 그 분류가 의도와 겹칠 때만 인정한다 — '한우국밥'이 고기·구이 필터에 잡히던 오분류 방지.
  const nameGroup = CUISINE_INTENT_MAP.find((g) => g.keys.some((k) => name.includes(k)));
  if (nameGroup && nameGroup.tags.some((t) => targetTags.has(t))) return 0.85;
  if (tags.includes("한식") && [...targetTags].some((t) => _HANSIK_SPECIFIC.includes(t))) return 0.45; // 같은 대분류(한식) 약한 점수
  return 0.18; // 무관
}

const WALK_M_PER_MIN = 66.67; // 백엔드 WALKING_SPEED_M_PER_MIN 와 동일
const BROWSE_BASELINE_CONGESTION = 0.7; // 원본이 없는 브라우즈 랭킹의 완화항 기준(원점) 혼잡 — 백엔드와 동일

// 인센티브(w3) = couponShare·쿠폰항 + (1−couponShare)·완화항 — 백엔드 score.py 산식 미러.
//  - 쿠폰항: 할인율 coupon_rate(0.10=10%)를 상한 couponRateCap(20%)으로 정규화. 컬럼 없는 행은 0.
//  - 완화항: max(0, min(1, 원점 혼잡 − 후보 혼잡)) — 수요 재배치 기여. 백엔드는 '도착시점 예측' 혼잡을
//    쓰지만 클라 미러는 예측이 없어 현재 혼잡으로 근사한다. 혼잡 로그가 없으면(null) 완화항 0.
function incentiveTerm(facility: ScorableFacility | null | undefined, candidateCongestion: number | null | undefined, originCongestion: number): number {
  const coupon = Math.min(1, (facility?.coupon_rate ?? 0) / SPOT_INCENTIVE.couponRateCap);
  const relief = typeof candidateCongestion === "number"
    ? Math.max(0, Math.min(1, originCongestion - candidateCongestion))
    : 0;
  return SPOT_INCENTIVE.couponShare * coupon + (1 - SPOT_INCENTIVE.couponShare) * relief;
}

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
export function filterReachable<T extends { latitude: number; longitude: number }>(
  facilities: T[],
  origin: { lat: number; lng: number },
  maxM: number = MAX_RECO_DISTANCE_M,
  minKeep: number = 5,
): T[] {
  const withD = facilities
    .map((f) => ({ f, d: haversineMeters(origin.lat, origin.lng, f.latitude, f.longitude) }))
    .sort((a, b) => a.d - b.d);
  const reach = withD.filter((x) => x.d <= maxM).map((x) => x.f);
  return reach.length >= minKeep ? reach : withD.slice(0, minKeep).map((x) => x.f);
}

function preferenceMatch(facility: ScorableFacility, preferredCategories: string[]): number {
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
export function rescoreWithPreference(t: Spot, pref: number, facility?: ScorableFacility): Spot {
  const { preference: w1, time: w2, incentive: w3 } = SPOT_WEIGHTS;
  const timeCost = Math.min(1.0, ((t.expectedWait || 0) + (t.expectedTravel || 0)) / 60.0);
  const incentive = incentiveTerm(facility, facility?.congestionLevel, BROWSE_BASELINE_CONGESTION);
  const raw = w1 * pref - w2 * timeCost + w3 * incentive;
  const finalScore = Math.max(0, Math.min(1, (raw + w2) / (w1 + w2 + w3)));
  return {
    ...t, // expectedWait/expectedTravel/timeToService = 백엔드 예측 보존
    score: isNaN(finalScore) ? t.score : Math.round(finalScore * 100),
    preferencePercent: isNaN(pref) ? t.preferencePercent : Math.round(pref * 100),
  };
}

export function scoreFacility(facility: ScorableFacility | null | undefined, opts: ScoreOpts): Spot {
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

  // 백엔드 동일 가중치(shared-types SPOT_WEIGHTS): w1·선호 − w2·시간비용 + w3·인센티브, Min-Max 정규화
  const { preference: w1, time: w2, incentive: w3 } = SPOT_WEIGHTS;
  const timeCost = Math.min(1.0, (expectedWait + expectedTravel) / 60.0);
  // 혼잡 로그 없는 시설은 congestionLevel=null → 완화항 0 (합성값 사용 금지)
  const incentive = incentiveTerm(facility, facility.congestionLevel, BROWSE_BASELINE_CONGESTION);
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

export function compareSpot(a: SpotRankable, b: SpotRankable): number {
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
export function rankFacilities<T extends ScorableFacility>(facilities: T[], opts: ScoreOpts): (T & { spot: Spot; reason: string })[] {
  const scored = facilities.map((f) => {
    const spot = scoreFacility(f, opts);
    return { ...f, spot, reason: f.reason || "" }; // 사유는 백엔드 템플릿(f.reason)만. 클라 하드코딩 제거.
  });
  scored.sort(compareSpot);
  return scored;
}

// 백엔드 RecommendItem(camelCase) → 카드용 Spot 형태로 변환.
export function recToSpot(rec: RecommendationResponse): Spot {
  const b: Partial<RecommendationResponse["breakdown"]> = rec.breakdown || {};
  const wait = typeof b.waitTime === "number" ? b.waitTime : 0;
  const travel = typeof b.travelTime === "number" ? b.travelTime : (rec.distanceM || 0) / WALK_M_PER_MIN;
  const score01 = rec.spotScore <= 1 ? rec.spotScore : rec.spotScore / 100;
  return {
    score: Math.round(score01 * 100),
    preferencePercent: Math.round((typeof b.preference === "number" ? b.preference : 0) * 100),
    expectedWait: Math.round(wait * 10) / 10,
    expectedTravel: Math.round(travel * 10) / 10,
    timeToService: Math.round((wait + travel) * 10) / 10,
    eventBoost: typeof b.eventBoost === "number" ? b.eventBoost : undefined,
    eventTitle: typeof b.eventTitle === "string" ? b.eventTitle : undefined,
  };
}
