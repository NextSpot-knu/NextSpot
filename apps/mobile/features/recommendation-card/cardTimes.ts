// 카드의 큰 숫자 · 칩 · 출발→도착 타임라인이 같은 분을 쓰게 하는 계산.
// 웹 원본 apps/web/lib/cardTimes.ts(기준 커밋 0d145a1). 바꾼 것: displayWalkingMinutes 를 recommender(api-client 사슬로
// check:shared 에 걸린다)에서 가져오지 않고 같은 식(올림 · 최소 1분)을 여기 둔다 — 카드는 직선거리 폴백 없이 분만 받는다.

export interface CardTimes {
  walkMin: number;
  waitMin: number | null;
  totalMin: number;
  arrival: Date | null;
  service: Date | null;
}

/** 사용자에게 보여주는 도보 분 — 과소 안내하지 않게 올림, 최소 1분. */
export function displayWalkMinutes(routeMinutes: number | null | undefined): number {
  const resolved = typeof routeMinutes === 'number' && Number.isFinite(routeMinutes) && routeMinutes >= 0 ? routeMinutes : 0;
  return Math.max(1, Math.ceil(resolved));
}

export function cardTimes(
  expectedTravel: number | null | undefined,
  expectedWait: number | null | undefined,
  depart: Date | null,
): CardTimes {
  const walkMin = displayWalkMinutes(expectedTravel);
  const waitMin =
    typeof expectedWait === 'number' && Number.isFinite(expectedWait) ? Math.max(0, Math.ceil(expectedWait)) : null;
  const totalMin = walkMin + (waitMin ?? 0);
  const arrival = depart ? new Date(depart.getTime() + walkMin * 60_000) : null;
  const service = arrival && waitMin !== null ? new Date(arrival.getTime() + waitMin * 60_000) : null;
  return { walkMin, waitMin, totalMin, arrival, service };
}
