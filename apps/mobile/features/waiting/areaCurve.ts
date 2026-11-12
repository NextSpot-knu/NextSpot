// 권역 주차 수요 전망 곡선 — 웹 apps/web/lib/areaDemandCurve.ts 의 앱판.
// '한산해지는 시각'(waitEstimate 의 areaCurve)의 근거다. 순수 계산(정시 고르기·곡선 병합)은 여기, 네트워크는 api.ts.
//
// 웹과 같은 것: 서버 창(도착이 지금+30분~+6시간)에 양끝 2분 여유를 두고 정시를 당겨 묻고, 30분 이상 움직이는 정시는
// 건너뛴다(다른 정시로 반올림되므로). 표본이 없는 시각은 맵에 넣지 않는다(0 으로 채우지 않는다).
// 다른 것: 내부 지역·가정 시각 프리셋이 없어 기준은 늘 '지금'. 세션 점 캐시(/main 시간 줄과의 공유)는 옮기지 않았다 —
// 앱 지도 화면은 시간 줄이 없다. 곡선 하나를 정시마다 한 번만 묻는다(api.ts).

/** KST 정시(0~23) → 권역 수요(0~1). 표본이 없는 시각은 키가 없다. */
export type AreaDemandCurve = Record<number, number>;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const WINDOW_MIN_MS = 32 * MINUTE_MS;
const WINDOW_MAX_MS = 6 * HOUR_MS - 2 * MINUTE_MS;
const MAX_SHIFT_MS = 30 * MINUTE_MS;
const MAX_POINTS = 6;
const CANDIDATES = 7;

export interface ForecastArrival {
  /** 곡선 키 — 당기기 전 정시의 KST 시(0~23). */
  hourKst: number;
  /** 실제로 묻는 도착 시각(서버 창 안으로 당긴 값). */
  at: Date;
}

/** baseAt 이후 정시들을 서버 창 안으로 당겨 최대 6개. 순수. */
export function forecastArrivalTimes(baseAt: Date, nowMs: number): ForecastArrival[] {
  const lo = nowMs + WINDOW_MIN_MS;
  const hi = nowMs + WINDOW_MAX_MS;
  const first = Math.ceil(baseAt.getTime() / HOUR_MS) * HOUR_MS;
  const out: ForecastArrival[] = [];
  for (let i = 0; i < CANDIDATES && out.length < MAX_POINTS; i++) {
    const t = first + i * HOUR_MS;
    const at = Math.min(hi, Math.max(lo, t));
    if (Math.abs(at - t) >= MAX_SHIFT_MS) continue;
    out.push({ hourKst: new Date(t + KST_OFFSET_MS).getUTCHours(), at: new Date(at) });
  }
  return out;
}

/** 응답 한 건 → 수요(0~1) 또는 null(표본 부족). */
export function levelFromForecast(data: { available?: boolean; forecast?: { level?: number | null } | null } | null | undefined): number | null {
  const level = data?.forecast?.level;
  return data?.available === true && typeof level === 'number' && Number.isFinite(level)
    ? Math.min(1, Math.max(0, level))
    : null;
}

/** 기준 시각 키('now' 또는 프리셋 시각 ms)로 곡선을 꺼낸다 — 비었거나 없으면 null(내장 곡선). 웹 curveForBase. */
export function curveForBase(curves: Record<string, AreaDemandCurve>, baseKey: string): AreaDemandCurve | null {
  const curve = Object.prototype.hasOwnProperty.call(curves, baseKey) ? curves[baseKey] : undefined;
  return curve && Object.keys(curve).length > 0 ? curve : null;
}

/**
 * 새로 받은 곡선을 기준 시각별 맵에 넣는다(웹 mergeAreaCurve). 바뀔 것이 없으면 prev 를 그대로 돌려준다.
 * 빈 재조회는 같은 기준의 좋은 곡선을 지우지 않고, 그 기준에 아직 아무것도 없으면 빈 곡선도 넣는다('알고 보니 없음').
 */
export function mergeAreaCurve(
  prev: Record<string, AreaDemandCurve>,
  baseKey: string,
  curve: AreaDemandCurve,
): Record<string, AreaDemandCurve> {
  const known = Object.prototype.hasOwnProperty.call(prev, baseKey);
  if (Object.keys(curve).length === 0 && known) return prev;
  return { ...prev, [baseKey]: curve };
}

/** 곡선이 비었으면 null — 호출부는 내장 시간대 곡선으로 계속 동작한다. */
export function usableCurve(curve: AreaDemandCurve | null | undefined): AreaDemandCurve | null {
  return curve && Object.keys(curve).length > 0 ? curve : null;
}
