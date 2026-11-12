// 홈 지도 핀을 놓는 순서 — 웹 SPOT 점수 순(G2-03). react-native 를 모른다(테스트: pinOrder.test.ts).
//
// 웹 원본(기준 커밋 0d145a1): apps/web/lib/recommender.ts 의 scoreFacility · compareSpot · evidenceTier · cuisineMatch(+ 음식 의도 사전),
// apps/web/app/main/page.tsx 의 computeDisplayFacilities 정렬(순위 핀 먼저, 그다음 compareSpot).
// 웹 recommender.ts 는 api-client 타입 사슬 때문에 check:shared 를 통과하지 못해 이 핀 고르기에 필요한 부분만 옮겼다(PORTING.md 에 기록 요청).
// 지금까지 앱은 순위 다음 '거리 순'이라 같은 화면에서 웹과 다른 핀이 보였다.
//
// 옮기지 않은 것: 서버 영업·경로 등급(eligibilityTier — 지도 시설 목록에는 없다), 쿠폰 인센티브의 원점 혼잡 완화항(웹도 브라우즈에서는 null).
import { SPOT_INCENTIVE, SPOT_WEIGHTS } from 'shared-types';

import { haversineMeters } from '@/lib/map/geo';
import { estimateWalkingMinutes } from '~/features/explore/port/walking';

export type ScoringMode = 'model' | 'measured_rules' | 'area_stats_rules' | 'degraded_rules';

/** 근거 등급 — 낮을수록 강한 근거(백엔드 EVIDENCE_TIER_BY_SCORING_MODE 미러). */
const EVIDENCE_TIER: Record<ScoringMode, number> = { model: 0, measured_rules: 0, area_stats_rules: 1, degraded_rules: 2 };
const WEAKEST_EVIDENCE_TIER = 2;
/** 이 이상이면 '이미 붐빈다' 로 보고 등급 이점을 주지 않는다(백엔드 CROWDED_EVIDENCE_CUTOFF). */
const CROWDED_EVIDENCE_CUTOFF = 0.9;

export function evidenceTier(mode: ScoringMode | null | undefined, congestionLevel?: number | null): number {
  const tier = mode ? (EVIDENCE_TIER[mode] ?? WEAKEST_EVIDENCE_TIER) : WEAKEST_EVIDENCE_TIER;
  if (typeof congestionLevel !== 'number' || !Number.isFinite(congestionLevel)) return tier;
  return congestionLevel >= CROWDED_EVIDENCE_CUTOFF ? Math.max(tier, WEAKEST_EVIDENCE_TIER) : tier;
}

// dim0-3: 카테고리 원핫 / dim4: 맛·평점 / dim5: 감성·인스타 / dim6: 접근성·무장애 / dim7: 한적함
const CATEGORY_VECTORS: Record<string, number[]> = {
  restaurant: [1.0, 0.0, 0.0, 0.0, 0.3, 0.0, 0.0, 0.0],
  cafe: [0.0, 1.0, 0.0, 0.0, 0.1, 0.3, 0.0, 0.0],
  attraction: [0.0, 0.0, 1.0, 0.0, 0.0, 0.1, 0.2, 0.0],
  culture: [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.2, 0.2],
};

export interface Spot {
  score: number;
  preferencePercent: number;
  expectedWait: number;
  expectedTravel: number;
  timeToService: number;
  scoringMode: ScoringMode;
  rankingCongestion: number | null;
}

export interface ScorableFacility {
  name?: string | null;
  type: string;
  latitude?: number;
  longitude?: number;
  congestionLevel?: number | null;
  features?: Record<string, unknown> | null;
}

export interface ScoreOpts {
  userLocation: { lat: number; lng: number };
  preferredCategories?: readonly string[];
  /** 데모 시뮬 시각(UTC 시). 없으면 지금. */
  mockHour?: number | null;
  /** 음식 의도(첫 설정의 음식 취향 → homeContext.cuisineIntentOf). */
  cuisineIntent?: string | null;
}

// ── 음식 의도 매칭(웹 CUISINE_INTENT_MAP — 순서가 구체성, 앞이 우선) ─────────────────────────────────────

const CUISINE_INTENT_MAP: { keys: string[]; tags: string[] }[] = [
  { keys: ['곱창', '막창', '대창'], tags: ['곱창,막창'] },
  { keys: ['국밥', '해장', '돼지국밥'], tags: ['국밥'] },
  { keys: ['순대', '순댓'], tags: ['순대'] },
  { keys: ['족발', '보쌈'], tags: ['족발,보쌈'] },
  { keys: ['피자', '파스타', '스테이크', '양식', '햄버거', '버거', '리조또', '스파게티'], tags: ['양식', '피자', '햄버거'] },
  { keys: ['칼국수', '국수', '냉면', '수제비', '막국수'], tags: ['국수', '칼국수', '수제비'] },
  { keys: ['치킨', '통닭', '닭강정'], tags: ['치킨'] },
  { keys: ['닭갈비', '찜닭', '백숙', '삼계탕'], tags: ['닭요리'] },
  { keys: ['중식', '짜장', '짬뽕', '탕수육', '마라'], tags: ['중식', '중국요리'] },
  { keys: ['초밥', '스시', '사시미', '돈까스', '우동', '라멘', '일식'], tags: ['일식', '돈까스,우동'] },
  { keys: ['물회', '해물', '생선', '조개', '복어', '수산'], tags: ['해물,생선', '회', '조개', '복어'] },
  { keys: ['분식', '떡볶이', '김밥', '토스트', '라볶이'], tags: ['분식', '간식'] },
  { keys: ['찌개', '전골', '부대찌개', '김치찌개', '된장찌개'], tags: ['찌개,전골'] },
  { keys: ['쌀국수', '베트남', '태국', '팟타이', '분짜'], tags: ['베트남음식', '동남아음식', '아시아음식'] },
  { keys: ['갈비'], tags: ['갈비', '육류,고기'] },
  { keys: ['고기', '육류', '삼겹', '목살', '소고기', '돼지', '숯불', '구이', '한우'], tags: ['육류,고기', '갈비', '삼겹살'] },
  { keys: ['한식', '백반', '가정식', '집밥', '한정식'], tags: ['한식', '한정식'] },
  { keys: ['채식', '비건', '샐러드'], tags: ['채식'] },
];
const BAR_TAGS = ['술집', '호프', '오뎅바', '실내포장마차', '일본식주점', '호프,요리주점', '포차', '선술집'];
const HANSIK_SPECIFIC = ['육류,고기', '국밥', '순대', '찌개,전골', '갈비', '곱창,막창', '족발,보쌈', '국수', '칼국수', '닭요리', '해물,생선', '한식', '한정식'];
const CAT3_CUISINE: Record<string, string> = {
  A05020100: '한식',
  A05020200: '양식',
  A05020300: '일식',
  A05020400: '중식',
  A05020700: '이색음식점',
};

function cuisineTokens(facility: ScorableFacility): string[] {
  const features = facility.features;
  const raw = features?.cuisineTags ?? features?.cuisine_tags ?? features?.cuisine;
  const tags = Array.isArray(raw) ? raw.map((x) => String(x)) : typeof raw === 'string' ? [raw] : [];
  const cat3 = features?.cat3;
  if (typeof cat3 === 'string' && CAT3_CUISINE[cat3]) tags.push(CAT3_CUISINE[cat3]);
  return tags;
}

function menuTokens(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  return raw.split(/[,/\s]+/).map((s) => s.trim()).filter((s) => s.length >= 2);
}

function firstMatchingGroup(token: string, exact: boolean) {
  return CUISINE_INTENT_MAP.find((g) => g.keys.some((k) => (exact ? token === k : token.includes(k))));
}

function menuMatchesIntent(facility: ScorableFacility, target: Set<string>): boolean {
  const first = menuTokens(facility.features?.first_menu ?? facility.features?.firstMenu);
  const treat = menuTokens(facility.features?.treat_menu ?? facility.features?.treatMenu);
  const hits = (tokens: string[], exact: boolean) =>
    tokens.some((tok) => firstMatchingGroup(tok, exact)?.tags.some((t) => target.has(t)));
  return hits(first, false) || hits(treat, true);
}

/** 음식 의도와 시설의 매칭도(0~1). 의도가 없거나 알아듣지 못하면 null → 카테고리 선호로 폴백. */
export function cuisineMatch(facility: ScorableFacility, intent: string | null | undefined): number | null {
  if (!intent) return null;
  if (facility.type && facility.type !== 'restaurant') return null;
  const it = String(intent).toLowerCase();
  const target = new Set<string>();
  for (const grp of CUISINE_INTENT_MAP) {
    if (grp.keys.some((k) => it.includes(k.toLowerCase()))) grp.tags.forEach((t) => target.add(t));
  }
  if (target.size === 0) return null;
  const tags = cuisineTokens(facility);
  const name = String(facility.name || '');
  if (tags.some((t) => BAR_TAGS.includes(t))) return 0.12;
  if (tags.some((t) => target.has(t))) return 0.95;
  if (menuMatchesIntent(facility, target)) return 0.9;
  const nameGroup = CUISINE_INTENT_MAP.find((g) => g.keys.some((k) => name.includes(k)));
  if (nameGroup && nameGroup.tags.some((t) => target.has(t))) return 0.85;
  if (tags.includes('한식') && [...target].some((t) => HANSIK_SPECIFIC.includes(t))) return 0.45;
  return 0.18;
}

function preferenceMatch(facility: ScorableFacility, preferredCategories: readonly string[]): number {
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
    if (facility.features.instagrammable && facility.type === 'cafe') fv[5] += 0.2;
  }
  const fn = Math.sqrt(fv.reduce((s, v) => s + v * v, 0));
  const ff = fv.map((v) => (fn > 0 ? v / fn : v));
  let dot = 0;
  for (let i = 0; i < 8; i++) dot += uf[i] * ff[i];
  return Math.max(0, Math.min(1, dot));
}

/** 웹 scoreFacility — 지도 시설 핀 정렬용(브라우즈: 원점 혼잡이 없어 인센티브는 쿠폰항만). */
export function scoreFacility(facility: ScorableFacility, opts: ScoreOpts): Spot {
  const cMatch = cuisineMatch(facility, opts.cuisineIntent);
  const pref = cMatch !== null ? cMatch : preferenceMatch(facility, opts.preferredCategories ?? []);

  const defaultTimes: Record<string, number> = { restaurant: 25, cafe: 12, attraction: 15, culture: 15 };
  const processing = facility.features?.average_processing_time;
  const avgProcess = typeof processing === 'number' ? processing : (defaultTimes[facility.type] ?? 15);
  // 백엔드가 UTC 도착 시각으로 피크 배수를 판정하므로 UTC 시를 쓴다(웹과 같다).
  const hour = opts.mockHour !== null && opts.mockHour !== undefined ? opts.mockHour : new Date().getUTCHours();
  let mult = 1.0;
  if (hour >= 11 && hour < 14) mult = 1.3;
  else if (hour >= 14 && hour < 18) mult = 1.2;

  const cong = facility.congestionLevel ?? 0;
  const expectedWait = cong * avgProcess * mult;

  const fLat = typeof facility.latitude === 'number' ? facility.latitude : opts.userLocation.lat;
  const fLng = typeof facility.longitude === 'number' ? facility.longitude : opts.userLocation.lng;
  const distanceM = haversineMeters(opts.userLocation.lat, opts.userLocation.lng, fLat, fLng);
  const expectedTravel = estimateWalkingMinutes(distanceM);

  const { preference: w1, time: w2, incentive: w3 } = SPOT_WEIGHTS;
  const timeCost = Math.min(1.0, (expectedWait + expectedTravel) / 60.0);
  const rate = facility.features?.coupon_rate;
  const coupon = Math.min(1, (typeof rate === 'number' ? rate : 0) / SPOT_INCENTIVE.couponRateCap);
  const incentive = SPOT_INCENTIVE.couponShare * coupon;
  const raw = w1 * pref - w2 * timeCost + w3 * incentive;
  const normalized = (raw + w2) / (w1 + w2 + w3);
  const finalScore = Math.max(0, Math.min(1, normalized));
  const round1 = (v: number) => (Number.isNaN(v) ? 0 : Math.round(v * 10) / 10);
  return {
    score: Number.isNaN(finalScore) ? 0 : Math.round(finalScore * 100),
    preferencePercent: Number.isNaN(pref) ? 0 : Math.round(pref * 100),
    expectedWait: round1(expectedWait),
    expectedTravel: round1(expectedTravel),
    timeToService: round1(expectedWait + expectedTravel),
    scoringMode: typeof facility.congestionLevel === 'number' ? 'measured_rules' : 'degraded_rules',
    rankingCongestion: typeof facility.congestionLevel === 'number' ? facility.congestionLevel : null,
  };
}

interface SpotRankable {
  name?: string | null;
  spot?: Spot | null;
}

/** 웹 compareSpot — 근거 등급 → 높은 점수 → 짧은 총 소요 → 높은 선호 → 짧은 이동 → 가나다. */
export function compareSpot(a: SpotRankable, b: SpotRankable): number {
  const at = a.spot;
  const bt = b.spot;
  if (!at || !bt) return (a.name || '').localeCompare(b.name || '', 'ko-KR');
  const aTier = evidenceTier(at.scoringMode, at.rankingCongestion);
  const bTier = evidenceTier(bt.scoringMode, bt.rankingCongestion);
  if (aTier !== bTier) return aTier - bTier;
  if (bt.score !== at.score) return bt.score - at.score;
  if (at.timeToService !== bt.timeToService) return at.timeToService - bt.timeToService;
  if (bt.preferencePercent !== at.preferencePercent) return bt.preferencePercent - at.preferencePercent;
  if (at.expectedTravel !== bt.expectedTravel) return at.expectedTravel - bt.expectedTravel;
  return (a.name || '').localeCompare(b.name || '', 'ko-KR');
}

/**
 * 핀 놓을 순서 — 서버 상위 추천(순위) 먼저, 같은 순위 안에서는 SPOT 점수 순(웹 computeDisplayFacilities).
 * homeModel.orderForPins(순위 → 거리)를 이것으로 바꾼다(H3b 가 호출 자리를 잇는다). 점수는 시설마다 한 번만 계산한다.
 */
export function orderPinsBySpot<T extends ScorableFacility & { id: string }>(
  list: readonly T[],
  rankById: ReadonlyMap<string, number>,
  opts: ScoreOpts,
): T[] {
  const scored = list.map((facility) => ({ facility, spot: scoreFacility(facility, opts) }));
  const rankOf = (id: string) => rankById.get(id) ?? 99;
  scored.sort(
    (a, b) =>
      rankOf(a.facility.id) - rankOf(b.facility.id) ||
      compareSpot({ name: a.facility.name, spot: a.spot }, { name: b.facility.name, spot: b.spot }),
  );
  return scored.map((s) => s.facility);
}
