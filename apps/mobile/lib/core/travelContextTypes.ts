// API 시그니처가 쓰는 여행 조건 타입 — 타입만 옮겨 적었다.
//
// 웹 원본: apps/web/lib/travelContext.ts(PlaceCategory·RequiredAttribute·CuisinePreference·TravelContext),
//          apps/web/lib/voice/voiceCommands.ts(VoiceAppCommand) (기준 커밋 e07ea61)
// 왜 import 하지 않나: travelContext.ts 가 lib/visits.ts 를 import 하고, visits.ts 가 `window.localStorage` 를 써서
// check:shared 의 의존 폐포 검사에 걸린다(타입만 import 해도 tsc 가 따라가므로 같이 센다). 웹 visits.ts 가 전역
// localStorage 로 바뀌면 이 파일을 지우고 `@/lib/travelContext` 를 그대로 import 한다(PORTING.md).

export type PlaceCategory = 'restaurant' | 'cafe' | 'attraction' | 'culture';

export type RequiredAttribute = 'indoor' | 'accessible' | 'stroller';

export type CuisinePreference = '한식' | '분식·국밥' | '양식' | '카페·디저트';

export interface TravelContext {
  categories: PlaceCategory[];
  cuisine?: CuisinePreference;
  maxWalkMinutes?: 5 | 10 | 20;
  availableMinutes?: 30 | 60 | 120;
  requiredAttributes: RequiredAttribute[];
  excludeVisited: boolean;
  visitedFacilityIds: string[];
}

export type VoiceAppCommand =
  | { name: 'set_facility_type'; args: { facilityType: PlaceCategory } }
  | { name: 'set_indoor_mode'; args: { enabled: boolean } }
  | { name: 'set_max_walk_minutes'; args: { maxWalkMinutes: 5 | 10 | 20 | null } }
  | { name: 'open_waiting_board'; args: Record<string, never> };
