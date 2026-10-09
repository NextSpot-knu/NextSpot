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

/** 아직 아무것도 고르지 않은 상태. **정말로 비어 있어야 한다.**
 *
 * 예전에는 여기에 `maxWalkMinutes: 20` 이 들어 있었다. 그런데 이 값은 두 곳에서 '사용자가 고른
 * 조건' 으로 취급된다:
 *   · 온보딩에서 **건너뛰기**를 눌러도 이 객체가 그대로 저장돼, 사용자가 대지 않은 조건이
 *     자기 선호로 기록됐다(setup/page.tsx).
 *   · 백엔드는 max_walk_minutes 가 오면 '명시적 도보 제한 = 엄격한 자격 규칙' 으로 보고,
 *     후보가 부족할 때의 '가까운 순 폴백' 을 끈다(courses.py / recommendations.py).
 *     그 폴백은 외곽·데이터 희소 위치에서 코스가 끊기지 않게 하려고 둔 것인데, 정작
 *     아무것도 고르지 않은 사용자에게 영원히 닿지 않았다.
 *
 * 비워도 반경은 그대로다 — 서버 기본값이 같은 20분이고(_DEFAULT_BROWSE_WALK_MINUTES),
 * 클라이언트 필터도 `context.maxWalkMinutes ?? 20` 으로 읽는다(matchesTravelContext).
 * 달라지는 것은 '고르지 않은 사람에게 폴백이 열린다' 하나뿐이다. */
export const EMPTY_TRAVEL_CONTEXT: TravelContext = {
  categories: [], requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [],
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

/** 카테고리 칩 하나 안에서 쓰는 조건. 칩이 이미 유형을 정했으므로 저장된 categories 는 비운다 —
 *  온보딩 카테고리는 처음 켜질 칩을 고를 뿐, 다른 칩을 '추천할 곳 0곳' 으로 막지 않는다. */
export function chipRankingContext(context: TravelContext): TravelContext {
  return { ...context, categories: [] };
}

/** 도보 제한이 칩을 비웠을 때 한 번만 넓혀 볼 조건(서버 기본 20분 반경으로 돌아간다).
 *  도보 제한을 고르지 않았으면 넓힐 것이 없어 null. 키 자체를 빼야 서버에 null 로 실려 가지 않는다. */
export function relaxWalkLimit(context: TravelContext): TravelContext | null {
  if (context.maxWalkMinutes === undefined) return null;
  const { maxWalkMinutes: _dropped, ...rest } = context;
  return rest;
}

/** 코스가 '설정한 여행 시간 안에 들르기 어려워요' 로 비었을 때 한 번에 넓힐 다음 여행 시간.
 *  30 → 60 → 120 → 제한 없음(키를 뺀다 — 서버에 null 로 실려 가지 않게). 고르지 않았으면 넓힐 것이 없어 null. */
export function widenTimeBudget(context: TravelContext): TravelContext | null {
  if (context.availableMinutes === undefined) return null;
  if (context.availableMinutes === 30) return { ...context, availableMinutes: 60 };
  if (context.availableMinutes === 60) return { ...context, availableMinutes: 120 };
  const { availableMinutes: _dropped, ...rest } = context;
  return rest;
}

/** 칩 하나의 후보와 그때 쓴 조건 — 엄격한 조건으로 0곳이고 도보 제한이 있으면 그것만 풀어 한 번 더 본다.
 *  카드는 실제 도보 분을 그대로 말하므로(예: '도보 12분') 넓힌 사실을 따로 알리지 않는다. */
export function chipCandidates<T>(
  items: T[],
  context: TravelContext,
  matcher: (context: TravelContext) => (item: T) => boolean,
): { context: TravelContext; items: T[] } {
  const strict = chipRankingContext(context);
  const strictItems = items.filter(matcher(strict));
  const relaxed = strictItems.length === 0 ? relaxWalkLimit(strict) : null;
  return relaxed
    ? { context: relaxed, items: items.filter(matcher(relaxed)) }
    : { context: strict, items: strictItems };
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
