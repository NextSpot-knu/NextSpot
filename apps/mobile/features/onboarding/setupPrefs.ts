// 첫 설정 5문항의 값과 저장 — 순수 모듈(저장소 주입, 테스트: setupPrefs.test.ts).
//
// 웹 원본: apps/web/lib/travelContext.ts 의 EMPTY_TRAVEL_CONTEXT · CUISINES · saveTravelContext · TRAVEL_CONTEXT_KEY,
//          apps/web/app/setup/page.tsx 의 CATEGORIES · WALKS · AVAILABLE · CUISINE_LABEL_KEY (기준 커밋 0d145a1)
// 왜 다시 썼나: 웹 travelContext.ts 는 lib/visits.ts(window.localStorage)를 끌고 와 check:shared 에 걸린다
// (lib/core/travelContextTypes.ts 와 같은 사정). 저장 형식은 **웹과 똑같다**(키 nextspot_setup_prefs, version 2,
// visitedFacilityIds 는 비워 저장, nextspot_onboarding_done='1') — 홈·추천 화면이 웹과 같은 규칙으로 읽는다.
import type {
  CuisinePreference,
  PlaceCategory,
  RequiredAttribute,
  TravelContext,
} from '~/lib/core/travelContextTypes';

export type { CuisinePreference, PlaceCategory, RequiredAttribute, TravelContext };

export const TRAVEL_CONTEXT_KEY = 'nextspot_setup_prefs';
export const ONBOARDING_DONE_KEY = 'nextspot_onboarding_done';

/** 정말로 비어 있어야 한다 — 건너뛰기가 고르지 않은 조건을 선호로 저장하지 않게(웹 주석 참고). */
export const EMPTY_TRAVEL_CONTEXT: TravelContext = {
  categories: [],
  requiredAttributes: [],
  excludeVisited: false,
  visitedFacilityIds: [],
};

export const CATEGORIES: readonly PlaceCategory[] = ['restaurant', 'cafe', 'attraction', 'culture'];
export const CUISINES: readonly CuisinePreference[] = ['한식', '분식·국밥', '양식', '카페·디저트'];
export const WALKS = [5, 10, 20] as const;
export const AVAILABLE = [30, 60, 120] as const;

export const CUISINE_LABEL_KEY: Record<CuisinePreference, string> = {
  '한식': 'setup.foodKorean',
  '분식·국밥': 'setup.foodSnack',
  '양식': 'setup.foodWestern',
  '카페·디저트': 'setup.foodDessert',
};

type Store = Pick<Storage, 'setItem'>;

/** 웹 saveTravelContext 와 같은 모양으로 저장한다. 저장 실패는 조용히 넘긴다(웹과 같다). */
export function saveTravelContextTo(store: Store | null, context: TravelContext): void {
  if (!store) return;
  const stored = { ...context, version: 2 as const, visitedFacilityIds: [] as string[] };
  try {
    store.setItem(TRAVEL_CONTEXT_KEY, JSON.stringify(stored));
    store.setItem(ONBOARDING_DONE_KEY, '1');
  } catch {
    /* noop */
  }
}

export function toggleIn<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/** 사용 기록 context_applied 의 속성(웹과 같은 이름). */
export function contextAppliedProps(value: TravelContext): Record<string, unknown> {
  return {
    categories: value.categories,
    max_walk_minutes: value.maxWalkMinutes ?? null,
    available_minutes: value.availableMinutes ?? null,
    required_attributes: value.requiredAttributes,
    exclude_visited: value.excludeVisited,
  };
}
