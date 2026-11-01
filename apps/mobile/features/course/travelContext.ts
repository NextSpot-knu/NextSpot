// 여행 조건 읽기·쓰기 — 웹 apps/web/lib/travelContext.ts 의 loadTravelContext·saveTravelContext·widenTimeBudget (기준 커밋 0d145a1).
// 웹 파일은 lib/visits.ts(window.localStorage)를 끌고 와 check:shared 에 걸려 import 하지 못한다(lib/core/travelContextTypes.ts 와 같은 이유).
// 저장 키·모양은 웹과 같다 — 온보딩이 같은 키로 쓰면 코스 화면이 그대로 읽는다.
// 방문 기록(excludeVisited)은 앱에 아직 없어 visitedFacilityIds 는 비워 보낸다(TODO: 방문 기록 이식 뒤 채운다).
import type { TravelContext } from '~/lib/core/travelContextTypes';

export const TRAVEL_CONTEXT_KEY = 'nextspot_setup_prefs';

export const EMPTY_TRAVEL_CONTEXT: TravelContext = {
  categories: [],
  requiredAttributes: [],
  excludeVisited: false,
  visitedFacilityIds: [],
};

/** 코스가 '설정한 여행 시간 안에 들르기 어려워요' 로 비었을 때 넓힐 다음 여행 시간. 30 → 60 → 120 → 제한 없음. 고르지 않았으면 null. */
export function widenTimeBudget(context: TravelContext): TravelContext | null {
  if (context.availableMinutes === undefined) return null;
  if (context.availableMinutes === 30) return { ...context, availableMinutes: 60 };
  if (context.availableMinutes === 60) return { ...context, availableMinutes: 120 };
  const { availableMinutes: _dropped, ...rest } = context;
  return rest;
}

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function store(): KeyValueStore | null {
  return (globalThis as { localStorage?: KeyValueStore }).localStorage ?? null;
}

export function parseTravelContext(raw: string | null): TravelContext {
  if (!raw) return EMPTY_TRAVEL_CONTEXT;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version === 2) {
      const { version: _v, ...context } = value as unknown as TravelContext & { version: 2 };
      return { ...EMPTY_TRAVEL_CONTEXT, ...context, visitedFacilityIds: [] };
    }
    return EMPTY_TRAVEL_CONTEXT;
  } catch {
    return EMPTY_TRAVEL_CONTEXT;
  }
}

export function loadTravelContext(): TravelContext {
  try {
    return parseTravelContext(store()?.getItem(TRAVEL_CONTEXT_KEY) ?? null);
  } catch {
    return EMPTY_TRAVEL_CONTEXT;
  }
}

export function saveTravelContext(context: TravelContext): void {
  try {
    store()?.setItem(TRAVEL_CONTEXT_KEY, JSON.stringify({ ...context, version: 2, visitedFacilityIds: [] }));
  } catch {
    /* 저장소 차단 — 이번 요청에만 쓰인다 */
  }
}
