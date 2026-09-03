// 좌표 유틸 — 두 지점 간 하버사인 거리(m). 지도 파생 컴포넌트(한산 TOP3 등)의 근접 정렬·표기용 경량 헬퍼.
// lib/recommender 에도 동일 계산(haversineMeters)이 있으나, 지도 표시 컴포넌트가 추천 엔진(SPOT)에
// 의존하지 않도록 순수 좌표 계산만 별도 제공한다(드리프트 없는 무상태 함수).

// 지구 반경(m). 하버사인 근사에는 평균 반경으로 충분하다.
const EARTH_RADIUS_M = 6371000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  // asin 인자를 1로 클램프해 부동소수 오차로 NaN 이 나오지 않게 한다.
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// 거리(m) → 사람이 읽는 짧은 표기. 1km 미만은 m, 이상은 소수 1자리 km(단위 기호는 로케일 공통).
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '';
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}
