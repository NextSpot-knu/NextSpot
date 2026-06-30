// @deprecated 미사용 — 실제 계약은 apps/web/lib/types.ts 및 supabase/migrations/20250523120000_init.sql 기준. 어느 코드에서도 import되지 않음.

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
