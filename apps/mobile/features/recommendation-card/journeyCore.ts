// 진행 중 여행 카드(ActiveJourneyCard)의 순수 판정 — 재계획 조건 · 후보 정렬 · 저장된 여행 조건 읽기.
// 웹 원본: apps/web/components/main/ActiveJourneyCard.tsx, lib/travelContext.ts(loadTravelContext), lib/recommender.ts(eligibilityTierRank)(기준 커밋 0d145a1).
// 웹의 travelContext · recommender 는 check:shared 에 걸려(visits · api-client 사슬) 필요한 만큼만 다시 썼다.
import type { PlaceCategory, RequiredAttribute, TravelContext } from '~/lib/core/travelContextTypes';

import { getVisitHistory, type KeyValueStore } from './tripLoop';

export const TRAVEL_CONTEXT_KEY = 'nextspot_setup_prefs';

export const EMPTY_TRAVEL_CONTEXT: TravelContext = {
  categories: [], requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [],
};

export const REPLAN_CATEGORIES: readonly PlaceCategory[] = ['restaurant', 'cafe', 'attraction', 'culture'];
export const REPLAN_WALKS = [5, 10, 20] as const;
export const REPLAN_AVAILABLE = [30, 60, 120] as const;
export const REPLAN_ATTRIBUTES: readonly RequiredAttribute[] = ['indoor', 'accessible', 'stroller'];
/** 재계획 응답을 기다리는 한도 — 넘기면 '없다' 가 아니라 '시간 초과' 로 말한다(replanOutcome). */
export const REPLAN_RESPONSE_BUDGET_MS = 3000;

function defaultStore(): KeyValueStore | null {
  try {
    return (globalThis as { localStorage?: KeyValueStore }).localStorage ?? null;
  } catch {
    return null;
  }
}

function visitedIds(store: KeyValueStore | null): string[] {
  return [...new Set(getVisitHistory(store).map((e) => e.facilityId))].slice(0, 200);
}

/** 온보딩에서 저장한 여행 조건. 없거나 손상되면 빈 조건. v2 만 읽는다(앱은 웹 v1 값을 만들지 않는다). */
export function loadTravelContext(store: KeyValueStore | null = defaultStore()): TravelContext {
  try {
    const raw = store?.getItem(TRAVEL_CONTEXT_KEY);
    if (!raw) return EMPTY_TRAVEL_CONTEXT;
    const value = JSON.parse(raw) as Partial<TravelContext> & { version?: number };
    if (value.version !== 2) return EMPTY_TRAVEL_CONTEXT;
    return {
      ...EMPTY_TRAVEL_CONTEXT,
      ...value,
      categories: Array.isArray(value.categories) ? value.categories : [],
      requiredAttributes: Array.isArray(value.requiredAttributes) ? value.requiredAttributes : [],
      visitedFacilityIds: value.excludeVisited ? visitedIds(store) : [],
    };
  } catch {
    return EMPTY_TRAVEL_CONTEXT;
  }
}

/** 조건이 하나라도 골라졌는가(재추천 버튼 활성). */
export function hasCondition(value: Partial<TravelContext> | null): boolean {
  return Boolean(
    value && (value.categories?.length || value.maxWalkMinutes || value.availableMinutes
      || value.requiredAttributes?.length || value.excludeVisited),
  );
}

const TIER_ORDER: Record<string, number> = {
  verified_open_route: 0,
  verified_open_estimated_route: 1,
  hours_confirmation_required_route: 2,
  hours_and_route_confirmation_required: 3,
};

/** 영업 근거 등급 순위 — 낮을수록 확실하다. 등급이 없고 영업 확인만 'unknown' 이면 미확인 등급(2). */
export function eligibilityTierRank(item: { eligibilityTier?: string | null; informationConfidence?: string | null }): number {
  const tier = item.eligibilityTier ? TIER_ORDER[item.eligibilityTier] : undefined;
  if (typeof tier === 'number') return tier;
  return item.informationConfidence === 'unknown' ? TIER_ORDER.hours_confirmation_required_route : 0;
}

interface Rankable {
  eligibilityTier?: string | null;
  informationConfidence?: string | null;
  spotScore?: number;
  distanceM?: number;
  facility: { id: string };
}

/** 갈아타기 후보 정렬 — 종류가 여럿이면 영업 근거 등급을 점수보다 먼저 본다(점수만 보면 다른 종류의 미확인 가게가 영업 확인 곳을 이긴다). */
export function sortReplanCandidates<T extends Rankable>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) =>
      eligibilityTierRank(a) - eligibilityTierRank(b)
      || (b.spotScore ?? 0) - (a.spotScore ?? 0)
      || (a.distanceM ?? 0) - (b.distanceM ?? 0)
      || a.facility.id.localeCompare(b.facility.id),
  );
}

/** 재계획에 보낼 조건 — 확정한 조건이 여정의 조건을 덮고, 지난 방문 제외는 이력에서 만든다. */
export function buildReplanContext(
  base: TravelContext,
  confirmed: Partial<TravelContext> | undefined,
  visited: readonly string[],
): TravelContext {
  const excludeVisited = confirmed?.excludeVisited ?? base.excludeVisited;
  return {
    ...base,
    ...confirmed,
    categories: confirmed?.categories ?? base.categories,
    requiredAttributes: confirmed?.requiredAttributes ?? base.requiredAttributes,
    visitedFacilityIds: excludeVisited ? [...new Set(visited)].slice(0, 200) : [],
  };
}

/** 칩 토글 — 있으면 빼고 없으면 더한다. */
export function toggled<T>(values: readonly T[] | undefined, value: T): T[] {
  const list = values ?? [];
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** 이 여정이 찾을 종류 — 조건에 종류가 있으면 그것, 없으면 지금 가는 곳과 같은 종류. */
export function replanFacilityTypes(context: TravelContext, tripType: string): string[] {
  return context.categories.length ? [...context.categories] : [tripType];
}

/** 여정 하나를 가리키는 열쇠 — 같은 장소를 다시 수락하면 acceptedAt 이 달라 다른 여정이다. */
export function tripKey(trip: { facilityId: string; acceptedAt: number }): string {
  return `${trip.facilityId}@${trip.acceptedAt}`;
}

/**
 * 이 열쇠를 처음 보는가 — 처음이면 기억하고 true. 'trip_resumed' 를 여정마다 한 번만 보내는 데 쓴다
 * (홈이 카드를 다시 붙이거나 앱이 앞으로 올 때마다 보내면 이용 기록이 부풀었다).
 */
export function firstSighting(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

const NO_HIDDEN: ReadonlySet<string> = new Set();

/**
 * 진행 중 여행 카드가 보여 줄 여정 — 길안내 중이고, hidden 에 든 여정이 아닐 때만.
 * 카드는 hidden 을 넘기지 않는다(G3-32 나 — 웹처럼 '아직 가는 중'은 카드 상태만 비우고, 다시 읽으면 돌아온다).
 * hidden 은 특정 여정을 숨겨야 하는 호출자를 위해 남겨 둔다. 새로 수락한 여정(열쇠가 다름)은 hidden 과 상관없이 보인다.
 */
export function visibleTrip<T extends { facilityId: string; acceptedAt: number; status: string }>(
  found: T | null,
  hidden: ReadonlySet<string> = NO_HIDDEN,
): T | null {
  if (!found || found.status !== 'navigating') return null;
  return hidden.has(tripKey(found)) ? null : found;
}
