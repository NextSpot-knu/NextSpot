// 길안내를 열 때 '진행 중인 여정' 을 남기는 자리 — 웹 apps/web/lib/visits.ts 의 recordActiveTrip.
// 저장은 features/recommendation-card 의 여정 저장소(웹과 같은 localStorage 키 3개)가 한다 — 홈의 진행 중 카드·방문 확인 카드가 그걸 읽는다.
// 코스 화면은 이 파일만 부른다(시그니처는 웹과 같다).
import { recordActiveTrip as saveActiveTrip } from '~/features/recommendation-card';

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

export function recordActiveTrip(facility: TripFacility, options?: ActiveTripOptions): void {
  saveActiveTrip(facility, options);
}
