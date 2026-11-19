// 홈 '🔮 혼잡 예측' 띠의 권역 한 시각 값 캐시 — 웹 apps/web/lib/areaDemandCurve.ts sessionAreaDemandAt 의 앱판(네트워크는 주입,
// 테스트: forecastStripModel.test.ts). 운영 자료원 연결은 forecastStripApi.ts.
//
// '+N시간 후' 한 시각만 묻는다(GET 1회) — 같은 시간대(지금 정시) 안에서 KST 정시마다 한 번만(+1·+2·+3 을 다 눌러도 3회).
// 그 정시가 표본 부족이면 가까운 쪽 이웃 정시를 한 번 더 본다. 전송 실패는 담아 두지 않는다(다음에 다시 묻는다).
// 웹과 다른 것: 웹은 이 점 캐시를 /waiting 6점 곡선과 나눈다. 앱 대기 보드(features/waiting/api.ts)는 곡선을 따로 묻는다 —
// 같은 정시가 두 번 나갈 수 있다(공개 GET, 서버 캐시). 합치려면 대기 api 가 이 캐시를 쓰게 한다(후속).
import type { AreaDemandCurve } from '~/features/waiting/areaCurve';

import { forecastPointAt, forecastPointShifts } from './forecastStripModel';

const HOUR_MS = 60 * 60 * 1000;

/** 한 시각의 경주 중심 권역 값 — 표본 부족이면 null, 전송 실패는 throw. */
export type ForecastPointFetcher = (at: Date) => Promise<number | null>;

const sessionPoints = new Map<string, Promise<number | null>>();

function sessionPoint(key: string, at: Date, fetchPoint: ForecastPointFetcher): Promise<number | null> {
  let pending = sessionPoints.get(key);
  if (!pending) {
    pending = fetchPoint(at).catch((error: unknown) => {
      sessionPoints.delete(key);
      throw error;
    });
    sessionPoints.set(key, pending);
  }
  return pending;
}

/** 지금 + hoursAhead 의 권역 수요를 그 정시 하나만 담은 곡선으로. 둘 다 표본이 없으면 빈 곡선, 전송 실패는 throw. */
export async function sessionAreaDemandAt(
  hoursAhead: number,
  nowMs: number,
  fetchPoint: ForecastPointFetcher,
): Promise<AreaDemandCurve> {
  const sessionKey = String(Math.floor(nowMs / HOUR_MS));
  for (const shift of forecastPointShifts(nowMs, hoursAhead)) {
    const point = forecastPointAt(nowMs, hoursAhead, shift);
    if (!point) continue;
    const level = await sessionPoint(`${sessionKey}:${point.hourKst}`, point.at, fetchPoint);
    if (level !== null) return { [point.hourKst]: level };
  }
  return {};
}

/** 테스트 전용 — 점 캐시를 비운다. */
export function resetForecastPointCache(): void {
  sessionPoints.clear();
}
