// 길안내를 열 때 '진행 중인 여정' 을 남기는 자리 — 웹 apps/web/lib/visits.ts 의 recordActiveTrip.
// 여정 저장은 features/recommendation-card 에서 따로 이식 중이다. 합쳐질 때 이 파일의 본문만 그쪽 함수 호출로 바꾼다
// (코스 화면은 이 파일만 부른다 — 시그니처는 웹과 같다).
export interface TripFacility {
  id: string;
  name?: string;
  type?: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface ActiveTripOptions {
  recommendationId?: string;
  walkMinutes?: number;
  context?: Record<string, unknown>;
  navigationMode?: 'walk' | 'car';
}

export function recordActiveTrip(_facility: TripFacility, _options?: ActiveTripOptions): void {
  // TODO(features/recommendation-card): 여정 저장소가 들어오면 `recordActiveTrip(facility, options)` 로 위임한다.
  // 그 전까지는 아무것도 저장하지 않는다 — 길안내는 그대로 열린다.
}
