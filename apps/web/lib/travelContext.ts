import { getVisitHistory } from '@/lib/visits';

export type PlaceCategory = 'restaurant' | 'cafe' | 'attraction' | 'culture';
export type RequiredAttribute = 'indoor' | 'accessible';

/** 온보딩 음식 취향. v1 의 `food` 필드를 그대로 되살린 값이라 라벨 문자열을 쓴다 —
 *  아래 CUISINE_INTENT 가 검색 의도 문자열로 옮긴다. */
export type CuisinePreference = '한식' | '분식·국밥' | '양식' | '카페·디저트';

export const CUISINES: CuisinePreference[] = ['한식', '분식·국밥', '양식', '카페·디저트'];

/** 취향 라벨 → 추천 점수에 넘길 검색 의도 문자열.
 *  v1 이 main/page.tsx 안에서 하던 매핑을 여기로 옮겼다(저장 형태를 아는 모듈이 책임진다). */
export const CUISINE_INTENT: Record<CuisinePreference, string> = {
  '한식': '한식',
  '분식·국밥': '분식 국밥 김밥',
  '양식': '양식',
  '카페·디저트': '카페 디저트',
};

export interface TravelContext {
  categories: PlaceCategory[];
  /** 음식 취향(선택). 미선택이면 undefined — 의도를 지어내지 않는다. */
  cuisine?: CuisinePreference;
  maxWalkMinutes?: 5 | 10 | 20;
  availableMinutes?: 30 | 60 | 120;
  requiredAttributes: RequiredAttribute[];
  excludeVisited: boolean;
  visitedFacilityIds: string[];
}

interface StoredTravelPreferences extends TravelContext { version: 2 }
export const TRAVEL_CONTEXT_KEY = 'nextspot_setup_prefs';

export const EMPTY_TRAVEL_CONTEXT: TravelContext = {
  categories: [], maxWalkMinutes: 20, requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [],
};

const WALKING_SPEED_M_PER_MIN = 66.67;

export function isIndoorEligible(facility: {
  type: string; features?: Record<string, unknown> | null;
}): boolean {
  const features = facility.features ?? {};
  if (features.indoor === false || features.indoor_verified === false) return false;
  if (features.indoor === true || features.indoor_verified === true) return true;
  return facility.type === 'restaurant' || facility.type === 'cafe';
}

export function matchesTravelContext(facility: {
  id: string; type: string; latitude: number; longitude: number;
  barrierFree?: unknown; barrier_free?: unknown;
  features?: Record<string, unknown> | null;
}, context: TravelContext, origin: { lat: number; lng: number }, distanceMeters: (lat1: number, lng1: number, lat2: number, lng2: number) => number): boolean {
  if (context.categories.length && !context.categories.includes(facility.type as PlaceCategory)) return false;
  if (context.excludeVisited && context.visitedFacilityIds.includes(facility.id)) return false;
  const maxWalkMinutes = context.maxWalkMinutes ?? 20;
  // 서버의 네트워크 경로/보수 추정이 최종 하드 캡이다. 클라이언트는 직선거리로 불가능한 후보만 선제 제거한다.
  if (distanceMeters(origin.lat, origin.lng, facility.latitude, facility.longitude) > maxWalkMinutes * WALKING_SPEED_M_PER_MIN) return false;
  const features = facility.features ?? {};
  for (const attribute of context.requiredAttributes) {
    if (attribute === 'accessible') {
      if ((facility.barrierFree ?? facility.barrier_free) !== true && features.accessible_verified !== true) return false;
    } else if (!isIndoorEligible(facility)) {
      return false;
    }
  }
  return true;
}

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
    // v1 은 음식 취향을 `food` 에 라벨 문자열로 담았다. 같은 값을 그대로 쓰므로 옮겨만 준다.
    const legacyFood = String(value.food ?? '') as CuisinePreference;
    return {
      ...EMPTY_TRAVEL_CONTEXT,
      categories: category ? [category] : [],
      cuisine: CUISINES.includes(legacyFood) ? legacyFood : undefined,
    };
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
