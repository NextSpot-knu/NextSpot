import { getVisitHistory } from '@/lib/visits';

export type PlaceCategory = 'restaurant' | 'cafe' | 'attraction' | 'culture';
export type RequiredAttribute = 'indoor' | 'accessible';

export interface TravelContext {
  categories: PlaceCategory[];
  maxWalkMinutes?: 5 | 10 | 20;
  availableMinutes?: 30 | 60 | 120;
  requiredAttributes: RequiredAttribute[];
  excludeVisited: boolean;
  visitedFacilityIds: string[];
}

interface StoredTravelPreferences extends TravelContext { version: 2 }
export const TRAVEL_CONTEXT_KEY = 'nextspot_setup_prefs';

export const EMPTY_TRAVEL_CONTEXT: TravelContext = {
  categories: [], requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [],
};

export function loadTravelContext(): TravelContext {
  if (typeof window === 'undefined') return EMPTY_TRAVEL_CONTEXT;
  try {
    const raw = localStorage.getItem(TRAVEL_CONTEXT_KEY);
    if (!raw) return EMPTY_TRAVEL_CONTEXT;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version === 2) {
      const context = value as unknown as StoredTravelPreferences;
      return { ...context, visitedFacilityIds: context.excludeVisited ? visitedIds() : [] };
    }
    const legacyMap: Record<string, PlaceCategory> = {
      '음식점': 'restaurant', '카페': 'cafe', '관광지': 'attraction', '문화시설': 'culture',
    };
    const category = legacyMap[String(value.category ?? '')];
    return { ...EMPTY_TRAVEL_CONTEXT, categories: category ? [category] : [] };
  } catch { return EMPTY_TRAVEL_CONTEXT; }
}

function visitedIds(): string[] {
  return [...new Set(getVisitHistory().map((entry) => entry.facilityId))].slice(0, 200);
}

export function saveTravelContext(context: TravelContext): void {
  const stored: StoredTravelPreferences = { ...context, version: 2, visitedFacilityIds: [] };
  try {
    localStorage.setItem(TRAVEL_CONTEXT_KEY, JSON.stringify(stored));
    localStorage.setItem('nextspot_onboarding_done', '1');
  } catch { /* noop */ }
}
