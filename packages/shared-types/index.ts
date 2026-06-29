// @deprecated 미사용 — 실제 계약은 apps/web/lib/types.ts 및 supabase/migrations/20250523120000_init.sql 기준. 어느 코드에서도 import되지 않음.

// 1. 공용 인프라 타입 정의
export type InfrastructureType = 'cafeteria' | 'parking' | 'meeting_room' | 'rest_area';

export interface Infrastructure {
  id: string;
  name: string;
  type: InfrastructureType;
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
  infrastructureId: string;
  currentOccupancy: number;
  congestionRate: number;
  status: 'smooth' | 'normal' | 'crowded' | 'critical';
  recordedAt: string;
}

// 3. 예약 타입
export interface Reservation {
  id: string;
  infrastructureId: string;
  userId: string;
  startTime: string;
  endTime: string;
  status: 'confirmed' | 'cancelled' | 'completed';
  createdAt: string;
}

// 4. TTTV(Total Time to Value) 알고리즘 대안 추천 타입
export interface TTTVRecommendation {
  id?: string;
  userId?: string;
  requestedInfraId: string;
  recommendedInfraId: string;
  recommendedInfraName?: string;
  originalEstimatedWaitTime: number; // 분 단위
  recommendedEstimatedWaitTime: number; // 분 단위
  travelTimeSaved: number; // 분 단위
  reason?: string;
  status: 'offered' | 'accepted' | 'rejected';
  createdAt?: string;
}
