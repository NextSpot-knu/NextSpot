// 도보 시간 계산 — 웹 apps/web/lib/recommender.ts 의 estimateWalkingMinutes·displayWalkingMinutes·ScoringMode 만 옮겼다.
// 웹 recommender.ts 는 shared-types·api-client 타입을 끌어와 check:shared 에 걸려 통째로 쓸 수 없다(PORTING.md 참고).

export type ScoringMode = 'model' | 'measured_rules' | 'area_stats_rules' | 'degraded_rules';

const WALK_M_PER_MIN = 66.67; // 백엔드 WALKING_SPEED_M_PER_MIN 와 동일
const ESTIMATED_ROUTE_FACTOR = 1.18; // 보행망 응답 전 직선거리 폴백의 우회 보정(백엔드 동일)

/** 보행 경로가 아직 없을 때 직선거리에 우회 보정을 적용한 분 단위 추정치. */
export function estimateWalkingMinutes(distanceM: number | null | undefined): number {
  const distance = typeof distanceM === 'number' && Number.isFinite(distanceM) ? Math.max(0, distanceM) : 0;
  return (distance * ESTIMATED_ROUTE_FACTOR) / WALK_M_PER_MIN;
}

/** 사용자에게 보여주는 도보시간은 과소 안내하지 않도록 1분 이상 정수 올림한다. */
export function displayWalkingMinutes(
  routeMinutes: number | null | undefined,
  fallbackDistanceM?: number | null,
): number {
  const resolved =
    typeof routeMinutes === 'number' && Number.isFinite(routeMinutes) && routeMinutes >= 0
      ? routeMinutes
      : estimateWalkingMinutes(fallbackDistanceM);
  return Math.max(1, Math.ceil(resolved));
}
