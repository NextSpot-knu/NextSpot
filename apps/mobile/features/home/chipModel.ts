// 홈 칩 · 여행 조건 · 제안 상자 · 지도 세션 기억의 순수 규칙 — react-native 를 모른다(테스트: chipModel.test.ts).
//
// 웹 원본(yunseong e8d1c07): apps/web/lib/travelContext.ts(isIndoorEligible · matchesTravelContext · chipCandidates),
// apps/web/lib/firstViewCategory.ts(pickFirstViewCategory — 타입 import 사슬이 lib/visits 에 닿아 복사),
// apps/web/app/main/page.tsx 의 pinAttributesOf · hasPinAttributes · countPinsByType(:255-275), cardConditions(:3436-3453),
// removeCondition(:3458-3476), onBarrierFreeChip · onStrollerChip · showAttributePins(:3549-3632), suggestedCategories ·
// attributePinChips · strollerPinsNone(:3634-3672), noOpenTodayOnly(:2540-2547), 지도 세션 기억(:2968-3030, 3329).
// 웹 lib/travelContext 는 lib/visits(window.localStorage)를 끌고 와 check:shared 에 걸린다 — 필요한 판정만 다시 썼다(PORTING.md).
import { haversineMeters } from '@/lib/map/geo';
import { isClosedToday, isRecommendationOpen } from '@/lib/restDate';
import { isStrollerFriendly } from '~/lib/core/strollerSupport';
import type { PlaceCategory, RequiredAttribute, TravelContext } from '~/lib/core/travelContextTypes';

import { relaxWalkLimit } from './homeContext';
import { CATEGORIES, isBar, type HomeFacility } from './homeModel';

/** 백엔드 WALKING_SPEED_M_PER_MIN 와 같다(웹 travelContext). */
const WALKING_SPEED_M_PER_MIN = 66.67;
/** 도보 제한을 고르지 않았을 때의 반경(서버 _DEFAULT_BROWSE_WALK_MINUTES 와 같은 20분). */
const DEFAULT_WALK_MINUTES = 20;

/** 실내로 보는 문화시설 분류(TourAPI cat3) — 서버 INDOOR_CULTURE_CAT3 와 같은 목록(웹 travelContext). */
const INDOOR_CULTURE_CAT3 = new Set([
  'A02060100', 'A02060200', 'A02060300', 'A02060400', 'A02060500',
  'A02060700', 'A02060800', 'A02060900', 'A02061000', 'A02061200',
]);

type ContextFacility = Pick<HomeFacility, 'id' | 'type' | 'latitude' | 'longitude' | 'barrierFree' | 'features'>;

/** 서버 facility_is_indoor_eligible 의 미러(웹 isIndoorEligible) — 근거가 없으면 아니다(fail-closed). */
export function isIndoorEligible(facility: { type: string; features?: Record<string, unknown> | null }): boolean {
  const features = facility.features ?? {};
  if (features.indoor === false || features.indoor_verified === false) return false;
  if (features.indoor === true || features.indoor_verified === true) return true;
  if (facility.type === 'culture' && INDOOR_CULTURE_CAT3.has(String(features.cat3 ?? ''))) return true;
  return facility.type === 'restaurant' || facility.type === 'cafe';
}

/** 웹 matchesTravelContext — 분류 · 방문 제외 · 직선거리 도보 상한 · 꼭 맞아야 하는 조건. */
export function matchesTravelContext(facility: ContextFacility, context: TravelContext, origin: { lat: number; lng: number }): boolean {
  if (context.categories.length && !context.categories.includes(facility.type as PlaceCategory)) return false;
  if (context.excludeVisited && context.visitedFacilityIds.includes(facility.id)) return false;
  const maxWalkMinutes = context.maxWalkMinutes ?? DEFAULT_WALK_MINUTES;
  if (haversineMeters(origin.lat, origin.lng, facility.latitude, facility.longitude) > maxWalkMinutes * WALKING_SPEED_M_PER_MIN) return false;
  const features = facility.features ?? {};
  for (const attribute of context.requiredAttributes) {
    if (attribute === 'accessible') {
      if (facility.barrierFree !== true && features.barrier_free !== true && features.accessible_verified !== true) return false;
    } else if (attribute === 'stroller') {
      if (!isStrollerFriendly(facility)) return false;
    } else if (!isIndoorEligible(facility)) {
      return false;
    }
  }
  return true;
}

/**
 * 칩 하나의 후보와 그때 쓴 조건(웹 chipCandidates) — 칩이 유형을 정했으니 categories 는 비우고, 엄격한 조건으로 0곳이고
 * 도보 제한이 있으면 그것만 풀어 한 번 더 본다.
 */
export function chipCandidates<T extends ContextFacility>(
  items: readonly T[],
  context: TravelContext,
  origin: { lat: number; lng: number },
): { context: TravelContext; items: T[] } {
  const strict: TravelContext = { ...context, categories: [] };
  const strictItems = items.filter((f) => matchesTravelContext(f, strict, origin));
  const relaxed = strictItems.length === 0 ? relaxWalkLimit(strict) : null;
  return relaxed
    ? { context: relaxed, items: items.filter((f) => matchesTravelContext(f, relaxed, origin)) }
    : { context: strict, items: strictItems };
}

/** 그 칩의 추천 풀 — 같은 유형, 음식점이면 술집 제외(웹 typeOk). */
export function chipPool<T extends HomeFacility>(facilities: readonly T[], type: PlaceCategory): T[] {
  return facilities.filter((f) => f.type === type && !(type === 'restaurant' && isBar(f)));
}

export type CategoryCounts = Record<PlaceCategory, number>;

/**
 * 칩마다 카드에 오를 수 있는 곳의 수(웹 suggestedCategories · barrierFreeCandidatesByType · maybeSwitchFirstView 의 셈).
 * excluded: 빼고 셀 id(거절·저장). openOnly: 지금 추천할 수 있는 곳만(웹 isRecommendationOpen — 밤의 첫 화면).
 */
export function candidateCountsByType(
  facilities: readonly HomeFacility[],
  context: TravelContext,
  origin: { lat: number; lng: number },
  opts: { excluded?: ReadonlySet<string>; openOnly?: boolean; now?: Date } = {},
): CategoryCounts {
  const counts = { restaurant: 0, cafe: 0, attraction: 0, culture: 0 } as CategoryCounts;
  for (const type of CATEGORIES) {
    let items = chipCandidates(chipPool(facilities, type), context, origin).items;
    if (opts.excluded) items = items.filter((f) => !opts.excluded?.has(f.id));
    if (opts.openOnly) {
      items = items.filter((f) => isRecommendationOpen(f.type, f.operatingHours as Parameters<typeof isRecommendationOpen>[1], opts.now));
    }
    counts[type] = items.length;
  }
  return counts;
}

/** 지금 칩의 순위를 도보 제한 없이 매겼는가(웹 clientWalkRelaxed) — 그러면 '🚶 도보 N분 이내' 칩을 감춘다. */
export function clientWalkRelaxed(
  facilities: readonly HomeFacility[],
  type: PlaceCategory,
  context: TravelContext,
  origin: { lat: number; lng: number },
): boolean {
  if (context.maxWalkMinutes === undefined) return false;
  return chipCandidates(chipPool(facilities, type), context, origin).context.maxWalkMinutes === undefined;
}

/**
 * 밤의 첫 화면(웹 pickFirstViewCategory · G2-29): 지금 칩을 뺀 나머지 중 지금 추천할 곳이 가장 많은 칩(같은 수면 앞 칩).
 * 모두 0 이면 null(옮기지 않는다).
 */
export function pickFirstViewCategory(counts: Partial<CategoryCounts>, current: PlaceCategory | null): PlaceCategory | null {
  let best: { type: PlaceCategory; count: number } | null = null;
  for (const type of CATEGORIES) {
    if (type === current) continue;
    const count = counts[type] ?? 0;
    if (count > 0 && (!best || count > best.count)) best = { type, count };
  }
  return best?.type ?? null;
}

/** 가장 많은 칩(같은 수면 앞 칩) — 0 이면 null. 지금 칩도 후보에 넣는다(웹 best = 정렬 첫째). */
export function bestCategory(counts: CategoryCounts): { type: PlaceCategory; count: number } | null {
  let best: { type: PlaceCategory; count: number } | null = null;
  for (const type of CATEGORIES) {
    if (!best || counts[type] > best.count) best = { type, count: counts[type] };
  }
  return best && best.count > 0 ? best : null;
}

// ── ♿·👶 조건 핀 ─────────────────────────────────────────────────────────

export type PinAttribute = 'accessible' | 'stroller';
const PIN_ATTRIBUTES: readonly PinAttribute[] = ['accessible', 'stroller'];

export function pinAttributesOf(required: readonly string[]): PinAttribute[] {
  return PIN_ATTRIBUTES.filter((attribute) => required.includes(attribute));
}

type PinCandidate = { type: string; barrierFree?: unknown; features?: Record<string, unknown> | null };

/** 지도 핀 필터와 같은 판정(웹 hasPinAttributes) — 휠체어는 barrierFree 만, 유모차는 isStrollerFriendly. */
export function hasPinAttributes(f: PinCandidate, attributes: readonly PinAttribute[]): boolean {
  return attributes.every((attribute) => (attribute === 'stroller'
    ? isStrollerFriendly(f)
    : (f.barrierFree ?? f.features?.barrier_free) === true));
}

/** 묶음을 모두 만족하는 핀 수(유형별). 묶음이 비면 전부 0. */
export function countPinsByType(facilities: readonly PinCandidate[], attributes: readonly PinAttribute[]): CategoryCounts {
  const counts = { restaurant: 0, cafe: 0, attraction: 0, culture: 0 } as CategoryCounts;
  if (attributes.length === 0) return counts;
  for (const f of facilities) {
    if (f.type in counts && hasPinAttributes(f, attributes)) counts[f.type as PlaceCategory] += 1;
  }
  return counts;
}

/** 조건을 켜거나 끈 여행 조건(웹 toggleRequiredAttribute). */
export function withAttribute(context: TravelContext, attribute: RequiredAttribute, on: boolean): TravelContext {
  const has = context.requiredAttributes.includes(attribute);
  if (has === on) return context;
  const requiredAttributes = on
    ? [...new Set([...context.requiredAttributes, attribute])]
    : context.requiredAttributes.filter((item) => item !== attribute);
  return { ...context, requiredAttributes };
}

// ── 카드 조건 칩(G3-06) ───────────────────────────────────────────────────

export type ConditionKey = 'walk' | 'indoor' | 'barrierFree' | 'stroller';
const CONDITION_ATTRIBUTE: Record<Exclude<ConditionKey, 'walk'>, RequiredAttribute> = {
  indoor: 'indoor', barrierFree: 'accessible', stroller: 'stroller',
};

/**
 * 카드 가치 상자의 조건 칩 순서(웹 cardConditions) — 도보 칩은 그 조건이 지금 카드에 정말 걸려 있을 때만
 * (순위가 제한을 풀고 매겨졌거나 카드 도보 분이 조건보다 길면 띄우지 않는다).
 */
export function cardConditionKeys(context: TravelContext, opts: { walkRelaxed: boolean; cardWalkMin: number | null }): ConditionKey[] {
  const keys: ConditionKey[] = [];
  const max = context.maxWalkMinutes;
  if (max && !opts.walkRelaxed && (opts.cardWalkMin === null || opts.cardWalkMin <= max)) keys.push('walk');
  if (context.requiredAttributes.includes('indoor')) keys.push('indoor');
  if (context.requiredAttributes.includes('accessible')) keys.push('barrierFree');
  if (context.requiredAttributes.includes('stroller')) keys.push('stroller');
  return keys;
}

/** 칩 ✕ — 도보는 키 자체를 빼고(서버에 null 이 실려 가지 않게), 나머지는 그 조건만 끈다(웹 removeCondition). */
export function removeCondition(context: TravelContext, key: ConditionKey): TravelContext {
  if (key === 'walk') return relaxWalkLimit(context) ?? context;
  return withAttribute(context, CONDITION_ATTRIBUTE[key], false);
}

// ── 다른 칩 제안 상자(G2-30 · G3-27) ──────────────────────────────────────

export interface SuggestionModel {
  /** 고를 다른 칩(카드에 오를 곳 수 > 0, 지금 칩 제외). */
  chips: { type: PlaceCategory; count: number }[];
  /** 남은 곳이 전부 오늘 휴무(웹 noOpenTodayOnly) — map.noRecClosedBody 한 줄. */
  closedToday: boolean;
  /** 고를 칩이 없고 ♿·👶 조건 핀이 지금 칩에 있다 — '지도에 N곳' + 지도에서 보기. */
  pinsHere: number;
  /** 고를 칩도 지금 칩 핀도 없고 다른 칩에 조건 핀이 있다. */
  pinChips: { type: PlaceCategory; count: number }[];
  /** 👶 가 켜져 있는데 맞는 핀이 어디에도 없다 — '유모차 조건 끄기'. */
  strollerNone: boolean;
}

/** 제안 상자 내용(웹 :3634-3672). 아무것도 없으면 null — 상자를 그리지 않는다(웹 showSuggestion). */
export function suggestionModel(input: {
  category: PlaceCategory;
  candidateCounts: CategoryCounts;
  attributePins: CategoryCounts;
  pinAttributes: readonly PinAttribute[];
  strollerOn: boolean;
  closedToday: boolean;
}): SuggestionModel | null {
  const chips = CATEGORIES
    .filter((type) => type !== input.category && input.candidateCounts[type] > 0)
    .map((type) => ({ type, count: input.candidateCounts[type] }));
  const pinsHere = input.attributePins[input.category];
  const pinChips = input.pinAttributes.length > 0 && chips.length === 0 && pinsHere === 0
    ? CATEGORIES
      .filter((type) => type !== input.category && input.attributePins[type] > 0)
      .map((type) => ({ type, count: input.attributePins[type] }))
    : [];
  const strollerNone = input.strollerOn && chips.length === 0 && pinsHere === 0 && pinChips.length === 0;
  const model = { chips, closedToday: input.closedToday, pinsHere: chips.length === 0 ? pinsHere : 0, pinChips, strollerNone };
  return chips.length > 0 || model.closedToday || model.pinsHere > 0 || pinChips.length > 0 || strollerNone ? model : null;
}

/**
 * 추천을 다 넘긴 뒤 남은 곳(거절·저장 제외)이 있고 그 전부가 오늘 휴무인가(웹 noOpenTodayOnly) — '장소가 없어서'가 아니라
 * '오늘 다 쉬어서' 라고 말한다.
 */
export function onlyClosedTodayLeft(
  facilities: readonly HomeFacility[],
  type: PlaceCategory,
  excluded: ReadonlySet<string>,
  now: Date = new Date(),
): boolean {
  const rest = facilities.filter((f) => f.type === type && !excluded.has(f.id));
  const closed = (f: HomeFacility) => {
    const raw = f.features?.rest_date_raw ?? f.features?.restDateRaw;
    return isClosedToday(typeof raw === 'string' ? raw : null, now) === true;
  };
  return rest.length > 0 && rest.every(closed);
}

// ── 지도 위치 · 칩 세션 기억(G2-02) ───────────────────────────────────────

/** 웹과 같은 세션 키(경주는 접미사 없음 — regionCacheKey). */
export const MAP_SESSION_KEYS = {
  lat: 'nextspot_map_center_lat',
  lng: 'nextspot_map_center_lng',
  level: 'nextspot_map_level',
  filter: 'nextspot_active_filter',
} as const;

export type HomeTab = PlaceCategory | 'parking';

/** 웹 칩 id(세션에 그대로 쓴다 — 웹과 앱이 같은 값을 읽는다). */
export const FILTER_IDS: Record<HomeTab, string> = {
  restaurant: '음식점', cafe: '카페', attraction: '관광지', culture: '문화시설', parking: '주차장',
};

export function tabFromFilterId(raw: string | null | undefined): HomeTab | null {
  if (!raw) return null;
  const hit = (Object.entries(FILTER_IDS) as [HomeTab, string][]).find(([, id]) => id === raw);
  return hit ? hit[0] : null;
}

export interface MapSession {
  latitude: number;
  longitude: number;
  level: number | null;
}

/** 세션에 남은 지도 중심·레벨. 중심이 없거나 숫자가 아니면 null(레벨만 남은 것은 쓰지 않는다 — 웹도 중심이 있어야 복원). */
export function parseMapSession(lat: string | null, lng: string | null, level: string | null): MapSession | null {
  const latitude = lat ? parseFloat(lat) : NaN;
  const longitude = lng ? parseFloat(lng) : NaN;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const parsedLevel = level ? parseInt(level, 10) : NaN;
  return { latitude, longitude, level: Number.isFinite(parsedLevel) ? parsedLevel : null };
}

/** 복원한 중심이 기본 중심(지역 중심)과 사실상 같은가(±0.0005° ≈ 50m) — 그러면 띠 가운데 보정을 다시 한다(웹 restoredNearMyLocation). */
export function nearCenter(a: { latitude: number; longitude: number }, center: { lat: number; lng: number }): boolean {
  return Math.abs(a.latitude - center.lat) < 0.0005 && Math.abs(a.longitude - center.lng) < 0.0005;
}

// ── 카메라 띠 · 지도 패딩(G2-01 · F12) ────────────────────────────────────

/**
 * 띠 아래 두께(웹 mapInsets().bottom) — 아래 스택(예측 띠·카드 미리보기·제안 상자, 탭 막대 위 NAV_GAP 포함) 위끝 + 8.
 * 계획 §3.3 G2-01 ②: 카드가 펼쳐져 있어도 **미리보기 높이로** 잰다(펼친 카드 위끝으로 재면 첫 핀이 칩 줄 바로 아래로 간다).
 * 주차장 탭은 주차장 판 위끝. 아무것도 없으면 NAV_GAP + 8(웹 clearance + 8 과 같은 자리).
 */
export function bandBottomInset(input: { stackHeight: number; navGap: number; parkingPanelHeight?: number }): number {
  const parking = input.parkingPanelHeight && input.parkingPanelHeight > 0 ? input.parkingPanelHeight + input.navGap : 0;
  return Math.max(input.navGap, input.stackHeight, parking) + 8;
}

/** 지도 패딩 값은 8 단위로 — 카드 높이가 1~2pt 흔들릴 때마다 구글 지도 패딩(카메라 보정)을 다시 걸지 않는다. */
export function stablePadding(value: number): number {
  return Math.max(0, Math.ceil(value / 8) * 8);
}
