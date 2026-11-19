// 대기 보드·저장 화면이 쓰는 공개 GET 호출 — 웹 apps/web/lib/api-client.ts · areaDemandCurve.ts · GoldenHourBadge.tsx 의
// 같은 호출을 apiClient.get 으로 옮겼다. 모두 부가 정보다: 실패는 조용히 삼키고 호출부는 내장 곡선·숨김으로 계속 동작한다.
import { REGION } from '@/lib/region';
import { apiClient } from '~/lib/core/apiClient';

import {
  forecastArrivalTimes,
  levelFromForecast,
  type AreaDemandCurve,
  type ForecastArrival,
} from './areaCurve';

const FAN_OUT = 3;

/** 한 시각의 권역 전망 — GET /api/v1/area-demand/forecast. 표본 부족이면 null, 전송 실패는 throw. */
async function fetchPoint(arrival: ForecastArrival, signal?: AbortSignal): Promise<number | null> {
  const data = await apiClient.get('/api/v1/area-demand/forecast', {
    params: { lat: String(REGION.center.lat), lng: String(REGION.center.lng), arrivalAt: arrival.at.toISOString() },
    timeoutMs: 8000,
    signal,
    noRetry: true,
  });
  return levelFromForecast(data);
}

/**
 * 지금부터 앞으로 6시간의 정시 권역 수요. 첫 정시 하나를 먼저 기다려(서버 캐시를 데운다) 전망이 오면 나머지를 최대 3개
 * 동시로, 아니면 하나씩 묻는다(웹과 같은 호출 순서). 실패한 시각은 비워 둔다.
 */
export async function fetchAreaDemandCurve(
  signal?: AbortSignal,
  nowMs: number = Date.now(),
  /** 가정 시각 프리셋의 절대 시각(D11). 없으면 지금. 서버 창은 늘 실제 지금(nowMs) 기준이라 먼 프리셋은 0점이 정상이다. */
  baseAt: Date = new Date(nowMs),
): Promise<AreaDemandCurve> {
  const curve: AreaDemandCurve = {};
  const points = forecastArrivalTimes(baseAt, nowMs);
  if (points.length === 0 || signal?.aborted) return curve;
  const one = async (p: ForecastArrival): Promise<boolean> => {
    try {
      const level = await fetchPoint(p, signal);
      if (level !== null) curve[p.hourKst] = level;
      return level !== null;
    } catch {
      return false;
    }
  };
  const warm = await one(points[0]);
  const rest = points.slice(1);
  let next = 0;
  const worker = async () => {
    while (next < rest.length) {
      if (signal?.aborted) return;
      await one(rest[next++]);
    }
  };
  await Promise.all(Array.from({ length: warm ? Math.min(FAN_OUT, rest.length) : Math.min(1, rest.length) }, worker));
  return curve;
}

// 같은 정시 안에서는 한 번만 묻는다(세션 곡선). 실패·빈 곡선은 담아 두지 않아 다음에 다시 묻는다.
const sessionCurves = new Map<string, Promise<AreaDemandCurve>>();

export function sessionAreaDemandCurve(nowMs: number = Date.now()): Promise<AreaDemandCurve> {
  const key = String(Math.floor(nowMs / (60 * 60 * 1000)));
  const cached = sessionCurves.get(key);
  if (cached) return cached;
  const pending = fetchAreaDemandCurve(undefined, nowMs).then(
    (curve) => {
      if (Object.keys(curve).length === 0) sessionCurves.delete(key);
      return curve;
    },
    (error: unknown) => {
      sessionCurves.delete(key);
      throw error;
    },
  );
  sessionCurves.set(key, pending);
  return pending;
}

/** 골든타임 — GET /predict/golden-hour. 오늘 남은 시간 중 가장 한산한 60분 창. 알림 예약은 앱 v1 에 없다(계획 §3.1). */
export interface GoldenHour {
  start: number;
  end: number;
}

export async function fetchGoldenHour(facilityId: string, signal?: AbortSignal): Promise<GoldenHour | null> {
  try {
    const res = await apiClient.get(`/predict/golden-hour?facilityId=${encodeURIComponent(facilityId)}`, { signal });
    if (!res?.available || typeof res.start !== 'number' || typeof res.end !== 'number') return null;
    return { start: res.start, end: res.end };
  } catch {
    return null;
  }
}
