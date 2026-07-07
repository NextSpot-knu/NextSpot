// web↔api 공유 계약 — SPOT 상수(spot.ts)의 단일 공급점.
// (과거 @deprecated 미사용 상태였으나 D5 결정(2026-07-07)으로 승격: 프론트는 이 패키지에서
//  SPOT 가중치를 import 하고, 백엔드 score.py 와의 정합성은 CI 패리티 테스트가 강제한다.)

export * from './spot';

// 1. 관광 장소(POI) 타입 정의
export type FacilityType = 'restaurant' | 'cafe' | 'attraction' | 'culture';

export interface Facility {
  id: string;
  name: string;
  type: FacilityType;
  location?: string;
  latitude?: number;
  longitude?: number;
  capacity: number;
  congestionThreshold: number;
  createdAt: string;
  updatedAt: string;
}

// 2. 실시간 혼잡도 로그 타입
export interface CongestionLog {
  id: string;
  facilityId: string;
  currentCount: number;
  congestionRate: number;
  status: 'smooth' | 'normal' | 'crowded' | 'critical';
  recordedAt: string;
}

// 3. SPOT(Smart Place Optimization for Tourism) 대안 장소 추천 타입
export interface SPOTRecommendation {
  id?: string;
  userId?: string;
  requestedFacilityId: string;
  recommendedFacilityId: string;
  recommendedFacilityName?: string;
  originalEstimatedWaitTime: number; // 분 단위
  recommendedEstimatedWaitTime: number; // 분 단위
  travelTimeSaved: number; // 분 단위
  reason?: string;
  status: 'offered' | 'accepted' | 'rejected';
  createdAt?: string;
}
