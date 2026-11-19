// 추천 카드 시트가 받는 자료형 — 서버 추천 응답(RecommendationResponse)을 그대로 받는다.
//
// 웹은 /main 이 응답을 클라이언트 Facility(spot·pickKind …)로 바꿔 카드에 흩어 넘겼다. 앱은 그 변환을 홈 화면에 맡기지 않고
// 카드가 서버 응답에서 직접 읽는다(buildCardModel). 핀·검색으로 직접 고른 장소(추천 응답이 없다)는 candidateFromPlace 로 감싼다.
import type { RecommendationResponse, TravelContext } from '~/lib/core/apiClient';

export type { TravelContext };

/** 카드가 읽는 장소 필드 — 서버 facility 에 TourAPI 새로고침용 식별자·카카오 좌표를 더한 것. 전부 선택(핀으로 고른 곳은 일부만 있다). */
export type CardFacility = Partial<RecommendationResponse['facility']> & {
  id: string;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
  contentid?: string | null;
  contenttypeid?: number | null;
};

/**
 * 시트가 그리는 후보 한 곳. 서버 추천 응답에서 facility 만 필수로 두고 나머지는 선택(핀으로 고른 장소는 점수·근거가 없다).
 * `userPicked` 가 true 면 '직접 고른 장소' — 순위 배지 대신 '선택한 장소', '대신 갈 곳 보기' 가 열린다.
 */
export type SheetCandidate = Partial<Omit<RecommendationResponse, 'facility'>> & {
  facility: CardFacility;
  userPicked?: boolean;
};

/** 핀·검색으로 고른 장소를 시트 후보로. */
export function candidateFromPlace(place: CardFacility): SheetCandidate {
  return { facility: place, userPicked: true };
}

export interface LatLngPoint {
  lat: number;
  lng: number;
}

/** 비교 헤더의 기준 명소(지도에서 먼저 고른 곳 — '대신 갈 곳'의 A). 없으면 비교 줄은 혜택 문장으로 돌아간다. */
export interface CompareAnchor {
  name: string;
  distanceM: number | null;
  /** 기준 명소 자체의 혼잡 추정(0~1). */
  level?: number | null;
}
