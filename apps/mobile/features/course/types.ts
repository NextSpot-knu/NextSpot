// 분산 코스 화면의 자료형 — 웹 apps/web/app/course/page.tsx 의 CourseStop·SlotOutcome·CoursePlan 을 그대로 옮겼다(기준 커밋 0d145a1).
// 순수 모듈 — react-native 를 import 하지 않는다(테스트가 tsx 로 직접 돌린다).
import type { CongestionEstimate } from '~/lib/core/apiClient';

export interface CourseFacility {
  id: string;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
  capacity?: number;
  currentCount?: number;
  /** 서버는 시설 행 전체를 싣는다 — 사진 필드가 함께 온다. 공유 링크로 복원한 행에는 없다. */
  imageUrl?: string | null;
  galleryImages?: string[] | null;
  features?: Record<string, unknown> | null;
}

export interface CourseStop {
  order: number;
  facility: CourseFacility;
  arrivalOffsetMin: number;
  predictedCongestion: number | null;
  spotScore: number;
  /** 서버가 만든 한국어 문장 — 화면에는 쓰지 않는다(이유는 이 화면의 언어로 만든다). 시간 분산 신호만 읽는다. */
  reason: string;
  openStatusAtArrival?: 'open_expected' | 'closing_soon' | 'closed_confirmed' | 'needs_confirmation';
  travelMinutes?: number | null;
  alternatives?: CourseAlternative[];
  /** 추정 모드(주차 실측 + 관광 통계). 구 서버는 필드 없음. */
  congestionEstimate?: CongestionEstimate | null;
}

/** 같은 자리의 차점 후보 — 서버가 이미 채점해 둔 값이라 그대로 보여 줘도 거짓이 아니다. */
export interface CourseAlternative {
  facility: { id: string; name: string; type: string; latitude: number; longitude: number };
  arrivalOffsetMin: number;
  predictedCongestion: number | null;
  spotScore: number;
  travelMinutes?: number | null;
  congestionEstimate?: CongestionEstimate | null;
}

export type SlotStatus =
  | 'filled'
  | 'no_candidate_of_type'
  | 'closed_at_arrival'
  | 'late_night_unconfirmed'
  | 'over_time_budget'
  | 'pin_unavailable';

/** 사용자가 짠 자리 하나의 결과. 응답의 order 는 채운 것만으로 다시 매겨지므로, 어느 자리가 왜 비었는지는 이것으로만 안다. */
export interface SlotOutcome {
  order: number;
  requestedType: string | null;
  status: SlotStatus;
  facilityId: string | null;
  pinned: boolean;
}

export interface CoursePlan {
  stops: CourseStop[];
  slotOutcomes: SlotOutcome[];
  /** 선택된 시설 id 열의 해시 — '정말 바뀌었는지' 를 추측이 아니라 사실로 판정하는 근거. */
  planId: string;
}

/** 순서 지정 피커의 한 칸. uid 는 같은 종류를 두 번 담아도 구분하려는 앱 전용 식별자. */
export interface SequenceItem {
  uid: string;
  type: string;
}

export const TYPE_OPTIONS = [
  { id: 'restaurant', emoji: '🍴' },
  { id: 'cafe', emoji: '☕' },
  { id: 'attraction', emoji: '📸' },
  { id: 'culture', emoji: '🏛️' },
] as const;

/** 백엔드 sequence 상한(최대 3)과 같다. */
export const MAX_SEQUENCE = 3;

/** 코스 요청 본문(웹 fetchCourse 의 body). */
export interface CoursePlanRequest {
  userId: string;
  userLat: number;
  userLng: number;
  context: unknown;
  sequence?: string[];
  types?: string[];
  pins?: { order: number; facilityId: string }[];
  /** 가정 시각(UTC ISO) — 'now' 프리셋이면 넣지 않는다(서버 현재 시각). 웹 body.assumedAt. */
  assumedAt?: string;
}
