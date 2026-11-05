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

// ── 내부 검증 지역: '지금 이 일대' 는 구역 실측(S3) ─────────────────────────────────────────────────
//
// 내부 지역에는 추정 피드가 없다(경주 공영주차·관광 통계로 만든 피드라서). 대신 서버가 구역(일대)마다 실시간 인구 단계를
// 준다(GET /internal/regions/{id}/zones). 그 지역의 '지금 이 일대' 는 기준점(지역 중심)에서 **가장 가까운 지금 구역** 의
// 단계다 — 가운데값을 새로 만들지 않는다(구역 단계는 이미 일대의 값이다). 경주 화면은 이 함수를 부르지 않는다.

/** 구역 하나(GET /internal/regions/{id}/zones 의 InternalZoneView 중 이 판정이 읽는 필드). */
export interface AreaNowZone {
  zoneName: string;
  levelBand: string | null;
  isCurrent: boolean;
  centroid: { lat: number; lng: number };
  forecast?: readonly { targetAt: string; levelBand: string | null }[];
}

/** 가정 시각을 구역 예보로 말할 때 허용하는 차이 — 서버의 예보 맞춤 창(ZONE_FORECAST_MATCH_WINDOW)과 같은 30분. */
export const AREA_ZONE_FORECAST_WINDOW_MS = 30 * 60 * 1000;

/** 기준점에서 가장 가까운 '지금' 구역(단계가 있는 것만). 없으면 null. 순수 함수. */
export function nearestCurrentZone<Z extends AreaNowZone>(zones: readonly Z[], point: { lat: number; lng: number }): Z | null {
  let best: Z | null = null;
  let bestM = Infinity;
  for (const zone of zones) {
    if (!zone || zone.isCurrent !== true || !zone.levelBand || !zone.zoneName) continue;
    const c = zone.centroid;
    if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
    const m = haversineMeters(point.lat, point.lng, c.lat, c.lng);
    if (m < bestM) {
      best = zone;
      bestM = m;
    }
  }
  return best;
}

/** 구역 예보 중 atMs 에 가장 가까운(±30분 안) 단계. 없으면 null — 지금 단계로 대신 말하지 않는다. 순수 함수. */
export function zoneBandAt(zone: AreaNowZone, atMs: number): string | null {
  let best: string | null = null;
  let bestGap = Infinity;
  for (const point of zone.forecast ?? []) {
    const target = Date.parse(point.targetAt);
    if (!Number.isFinite(target) || !point.levelBand) continue;
    const gap = Math.abs(target - atMs);
    if (gap <= AREA_ZONE_FORECAST_WINDOW_MS && gap < bestGap) {
      best = point.levelBand;
      bestGap = gap;
    }
  }
  return best;
}
