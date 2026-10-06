// /main '🔮 혼잡 예측' 시간 줄의 규칙(계획 B3 · I01 web · P3) — 화면 없이 시험할 수 있는 부분만 여기 둔다.
//
//   · 줄은 지금 · +1시간 후 · +2시간 후 · +3시간 후 네 칸이다. +N 은 **이 화면의 상태로만** 산다 — 저장하지 않고,
//     /waiting·/course 와 나누는 '가정 시각' 프리셋(ASSUMED_TIME_PRESETS)에도 더하지 않는다(레드팀: 상대 시각이
//     공유 캐시에 새면 다른 화면이 엉뚱한 시각의 보드를 그린다).
//   · +N 을 고르면: 예측 모델이 학습돼 있으면 장소별 예측(/predict/batch)을, 아니거나 실패하면 경주 중심 권역 전망에서
//     그 시각 하나의 이 일대 값을 쓴다(lib/areaDemandCurve.sessionAreaDemandAt — 세션 · 정시마다 GET 1회).
//     둘 다 없으면 null — 화면은 알림 한 줄과 함께 '지금' 으로 돌아간다.
//   · 카드도 그 시각 기준으로 다시 고른다 — 추천 요청의 assumedAt = 지금 + N시간.
import type { AreaDemandCurve } from './areaDemandCurve';

export const FORECAST_STOPS = [0, 1, 2, 3] as const;
export type ForecastHours = (typeof FORECAST_STOPS)[number];

const HOUR_MS = 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * HOUR_MS;

/** 0~3 으로 자른 정수. 이상한 값은 0(지금). */
export function clampForecastHours(value: unknown): ForecastHours {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(3, Math.max(0, n)) as ForecastHours;
}

/** 추천 요청에 실을 가정 시각(UTC ISO) — 지금이면 null(서버 현재 시각 = 기존 동작). */
export function relativeAssumedAtIso(nowMs: number, hours: number): string | null {
  const h = clampForecastHours(hours);
  return h === 0 ? null : new Date(nowMs + h * HOUR_MS).toISOString();
}

/** 지금 + N시간에 가장 가까운 KST 정시(0~23). 자정을 넘기면 다음 날의 시가 된다(23:40 + 1시간 → 1시). */
export function forecastTargetHourKst(nowMs: number, hours: number): number {
  const target = nowMs + clampForecastHours(hours) * HOUR_MS;
  const nearestHourMs = Math.round(target / HOUR_MS) * HOUR_MS;
  return new Date(nearestHourMs + KST_OFFSET_MS).getUTCHours();
}

/**
 * 권역 곡선에서 지금 + N시간의 이 일대 수요(0~1). 그 정시 값이 없으면 한 시간 앞뒤(가까운 쪽 먼저)를 본다 —
 * 곡선은 분 58·59 처럼 서버 창 때문에 첫 정시가 빠질 수 있다. 셋 다 없으면 null(지어내지 않는다).
 */
export function areaLevelAt(curve: AreaDemandCurve | null | undefined, nowMs: number, hours: number): number | null {
  if (!curve || clampForecastHours(hours) === 0) return null;
  const target = nowMs + clampForecastHours(hours) * HOUR_MS;
  const key = forecastTargetHourKst(nowMs, hours);
  const towardLater = target - Math.floor(target / HOUR_MS) * HOUR_MS >= HOUR_MS / 2;
  const order = [key, towardLater ? key - 1 : key + 1, towardLater ? key + 1 : key - 1].map((k) => (k + 24) % 24);
  for (const k of order) {
    const value = curve[k];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.min(1, Math.max(0, value));
  }
  return null;
}

export type ModelPredictions = Record<string, { level: number; anchored: boolean }>;

export type StripForecast =
  | { hours: ForecastHours; basis: 'model'; predictions: ModelPredictions; anchored: boolean }
  | { hours: ForecastHours; basis: 'area'; level: number };

export interface ForecastDeps {
  /** 예측 모델이 학습돼 있는가(세션당 한 번 묻는 lib/predictModel.isPredictModelTrained). */
  modelTrained: () => Promise<boolean>;
  /** POST /predict/batch — 장소별 예측. 실패는 throw. */
  batch: (hours: ForecastHours) => Promise<ModelPredictions>;
  /** 세션 공용 권역 값 — 그 시각 하나만 담은 곡선(lib/areaDemandCurve.sessionAreaDemandAt, GET 1회). 실패는 throw. */
  areaCurve: (hours: ForecastHours) => Promise<AreaDemandCurve>;
}

/**
 * +N시간의 예측을 정한다: 모델(학습돼 있을 때만 묻는다 — 미학습이면 배치는 언제나 503 이라 부르지 않는다) →
 * 권역 곡선 → 없음(null). 0시간은 언제나 null.
 */
export async function resolveStripForecast(hours: number, deps: ForecastDeps, nowMs: number): Promise<StripForecast | null> {
  const h = clampForecastHours(hours);
  if (h === 0) return null;
  let trained = false;
  try { trained = await deps.modelTrained(); } catch { trained = false; }
  if (trained) {
    try {
      const predictions = await deps.batch(h);
      const values = Object.values(predictions);
      if (values.length > 0) {
        return { hours: h, basis: 'model', predictions, anchored: values.every((p) => p.anchored) };
      }
    } catch {
      // 모델 예측 실패 — 권역 곡선으로 내려간다.
    }
  }
  try {
    const level = areaLevelAt(await deps.areaCurve(h), nowMs, h);
    if (level !== null) return { hours: h, basis: 'area', level };
  } catch {
    // 곡선도 없다 — null.
  }
  return null;
}

/** 시간 줄의 상태 — 지금 · 고르는 중(예측을 받는 중) · 예측. */
export type StripState =
  | { status: 'now'; failed: boolean }
  | { status: 'loading'; hours: ForecastHours; previous: StripState }
  | { status: 'forecast'; hours: ForecastHours; forecast: StripForecast };

export type StripEvent =
  | { type: 'select'; hours: number }
  | { type: 'resolved'; hours: number; forecast: StripForecast | null }
  | { type: 'reset' };

export const STRIP_NOW: StripState = { status: 'now', failed: false };

/**
 * 시간 줄 상태 기계. 순수 함수.
 *  - 지금(0)을 고르거나 reset → 지금.
 *  - +N 을 고르면 '받는 중'(같은 N 을 이미 보여 주는 중이면 그대로).
 *  - 받은 결과가 지금 기다리는 N 의 것이 아니면 버린다(늦게 온 옛 답).
 *  - 결과가 null 이면 지금으로 돌아가며 failed=true(화면이 알림 한 줄을 띄운다).
 */
export function stripReducer(state: StripState, event: StripEvent): StripState {
  if (event.type === 'reset') return STRIP_NOW;
  const hours = clampForecastHours(event.hours);
  if (event.type === 'select') {
    if (hours === 0) return STRIP_NOW;
    if (state.status === 'forecast' && state.hours === hours) return state;
    if (state.status === 'loading' && state.hours === hours) return state;
    return { status: 'loading', hours, previous: state.status === 'loading' ? state.previous : state };
  }
  if (state.status !== 'loading' || state.hours !== hours) return state;
  if (!event.forecast) return { status: 'now', failed: true };
  return { status: 'forecast', hours, forecast: event.forecast };
}

/** 화면이 지금 보여 줄 칸(받는 중이면 고른 칸). */
export function stripHours(state: StripState): ForecastHours {
  return state.status === 'now' ? 0 : state.hours;
}

/** 예측 결과의 대표 혼잡도 — 이 일대 값, 또는 모델 예측의 가운데값(배지 한 줄에 쓴다). */
export function forecastHeadlineLevel(forecast: StripForecast, ids?: Iterable<string>): number | null {
  if (forecast.basis === 'area') return forecast.level;
  const wanted = ids ? new Set(ids) : null;
  const values = Object.entries(forecast.predictions)
    .filter(([id]) => !wanted || wanted.has(id))
    .map(([, p]) => p.level)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}
