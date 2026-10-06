// 이 일대 '지금' 붐빔 한 마디 — 관광객 화면들이 같은 재료 · 같은 규칙으로 말한다(리뷰 10-07).
//
// 왜: 같은 몇 분 안에 /main 혼잡 예측 줄의 칩은 '지금 이 일대 여유 · 추정', /explore/recommend 는 '지금 경주 시내 중심
// 보통 · 추정', /waiting 카드는 '추정 혼잡: 보통' 이라고 말했다. /main 칩만 추정 피드 **전체**(외곽까지 경주 전역)의
// 가운데값을 썼기 때문이다 — 시내 중심의 장소들은 보통인데 외곽의 한산한 장소가 가운데값을 끌어내렸다.
// 이제 '이 일대' 는 어느 화면이든 같은 뜻이다:
//   · 재료 — 추정 피드(GET /congestion/estimates) 하나. 세션 안에서 한 번 받아 /main · /waiting · /explore 가 나눠 쓴다
//     (loadSharedCongestionEstimates — 같은 스냅숏이라 화면마다 다른 시각의 값을 말하지 않는다).
//   · 범위 — 경주 시내 중심(REGION.center, 황리단길) 반경 1.5km 의 장소. /waiting 보드와 /explore 대안도 이 둘레의 장소다.
//   · 규칙 — 가운데값의 등급(boardOrder.medianLevel). /waiting · /explore 의 한 줄도 같은 가운데값 규칙이다.
// 장소가 3곳보다 적으면 말하지 않는다(null — 칩을 그리지 않는다, '모름' 을 말하지 않는다).

import { medianLevel } from './boardOrder';
import { haversineMeters } from './map/geo';
import { REGION } from './region';

/** 시내 중심 반경(m) — 황리단길·대릉원·첨성대·교촌이 들어오는 걸어서 닿는 둘레. */
export const AREA_NOW_RADIUS_M = 1500;
/** 이보다 적은 장소로는 '이 일대' 를 말하지 않는다(boardCrowdSpread 의 3곳과 같다). */
export const AREA_NOW_MIN_PLACES = 3;

export interface AreaNowPlace {
  latitude: number;
  longitude: number;
  /** 이 장소의 '지금' 추정(0~1, 신선도 검증을 거친 값). */
  level: number;
}

/** 시내 중심 반경 안 장소들의 '지금' 추정 가운데값. 모자라면 null. 순수 함수. */
export function areaNowLevel(
  places: readonly AreaNowPlace[],
  center: { lat: number; lng: number } = REGION.center,
  radiusM: number = AREA_NOW_RADIUS_M,
): number | null {
  const levels: number[] = [];
  for (const p of places) {
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || !Number.isFinite(p.level)) continue;
    if (haversineMeters(center.lat, center.lng, p.latitude, p.longitude) > radiusM) continue;
    levels.push(p.level);
  }
  return levels.length >= AREA_NOW_MIN_PLACES ? medianLevel(levels) : null;
}
