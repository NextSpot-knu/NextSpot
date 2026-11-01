// 대안 화면 → 방문 기록·여행 맥락 어댑터.
//
// 웹은 apps/web/lib/visits.ts(recordActiveTrip)·travelContext.ts(loadTravelContext)·tasteBadge.ts(markTasteFeedback)를 직접 부른다.
// 셋 다 window.localStorage 에 묶여 check:shared 에 걸리고, 앱판은 features/recommendation-card 에서 병렬로 쓰이는 중이다.
// 이 화면은 아래 시그니처만 안다 — 통합 때 recommendation-card 의 구현으로 바꿔 끼운다.
import type { TravelContext } from '~/lib/core/apiClient';

export interface TripFacility {
  id: string;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
}

export interface TripRecordOptions {
  recommendationId: string;
  walkMinutes: number;
  /** 웹은 loadTravelContext() 를 그대로 싣는다. */
  context?: Record<string, unknown>;
  navigationMode: 'walk' | 'car';
}

/**
 * 웹 recordActiveTrip(facility, options) 대응 — '지금 가는 중' 방문을 저장한다.
 * TODO(integrator): features/recommendation-card 의 방문 저장소(recordActiveTrip)로 연결한다.
 * 연결 전에는 아무것도 저장하지 않는다(길안내·피드백 전송은 이 화면이 그대로 한다).
 */
export function recordActiveTrip(facility: TripFacility, options: TripRecordOptions): void {
  void facility;
  void options;
}

/**
 * 웹 loadTravelContext() 대응 — 저장된 여행 맥락(동행·유모차 등). 없으면 undefined(서버 기본).
 * TODO(integrator): 앱판 여행 맥락 저장소로 연결한다.
 */
export function loadTravelContext(): TravelContext | undefined {
  return undefined;
}

/**
 * 웹 markTasteFeedback() 대응 — 취향 학습 행동(길안내·좋아요/별로예요)을 했다고 남긴다(마이페이지 '실시간 학습 반영' 조건).
 * TODO(integrator): 앱판 마이페이지 취향 배지 저장소로 연결한다.
 */
export function markTasteFeedback(): void {
  // 연결 전에는 비어 있다.
}
