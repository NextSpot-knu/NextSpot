// 대안 화면 → 방문 기록·여행 맥락 어댑터.
//
// 웹은 apps/web/lib/visits.ts(recordActiveTrip)·travelContext.ts(loadTravelContext)·tasteBadge.ts(markTasteFeedback)를 직접 부른다.
// 셋 다 window.localStorage 에 묶여 check:shared 에 걸려, 앱판은 각자 한 곳에만 있다 — 이 화면은 그걸 그대로 위임한다.
//   · recordActiveTrip·markTasteFeedback → features/recommendation-card(여정 저장소 · 취향 학습 표시, 웹과 같은 키)
//   · loadTravelContext → features/course/travelContext(nextspot_setup_prefs v2, 온보딩이 쓰는 같은 키)
import { markTasteFeedback as markTaste, recordActiveTrip as saveActiveTrip } from '~/features/recommendation-card';
import { loadTravelContext as readTravelContext } from '~/features/course/travelContext';
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

/** 웹 recordActiveTrip(facility, options) 대응 — '지금 가는 중' 방문을 저장한다. */
export function recordActiveTrip(facility: TripFacility, options: TripRecordOptions): void {
  saveActiveTrip(facility, options);
}

/** 웹 loadTravelContext() 대응 — 저장된 여행 맥락(동행·유모차 등). 저장이 없으면 빈 맥락(서버 기본과 같다). */
export function loadTravelContext(): TravelContext {
  return readTravelContext();
}

/** 웹 markTasteFeedback() 대응 — 취향 학습 행동(길안내·좋아요/별로예요)을 했다고 남긴다(마이페이지 '실시간 학습 반영' 조건). */
export function markTasteFeedback(): void {
  markTaste();
}
