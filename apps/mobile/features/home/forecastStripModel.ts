// 홈 '🔮 혼잡 예측' 띠의 순수 규칙(G2-24 · H2b) — react-native 를 모른다(테스트: forecastStripModel.test.ts).
//
// 웹 원본: apps/web/lib/forecastStrip.ts(전부), lib/areaDemandCurve.ts 의 forecastPointAt, app/main/page.tsx 의
// stripBadge·stripLegend·showStrip·forecastLevel(마커 effect)·selectForecastHours 의 분기, components/main/ForecastTimeStrip.tsx 의
// stopAt·onKeyDown. 웹 forecastStrip.ts 는 type import 사슬(./areaDemandCurve → @/lib/api-client)이 window 를 써서 check:shared 에
// 걸리므로 복사했다(PORTING.md). 규칙을 바꾸면 웹과 같이 바꾼다.
//
//   · 띠는 지금 · +1시간 후 · +2시간 후 · +3시간 후 네 칸. +N 은 이 화면 상태로만 산다 — 저장하지 않고 '가정 시각' 프리셋
//     (대기·코스와 나누는 lib/core/assumedTime)에도 더하지 않는다.
//   · +N 을 고르면: 모델이 학습돼 있으면 장소별 예측(/predict/batch), 아니거나 실패하면 경주 중심 권역 전망의 그 시각 값.
//     둘 다 없으면 null — 화면은 알림 한 줄(map.predictFail)과 함께 지금으로 돌아간다.
//   · 카드도 그 시각 기준으로 다시 고른다 — 추천 요청 assumedAt = 지금 + N시간(relativeAssumedAtIso).
import { congestionKey, type CongestionKey } from '@/lib/congestionScale';
import type { AreaDemandCurve } from '~/features/waiting/areaCurve';

export type { AreaDemandCurve };

export const FORECAST_STOPS = [0, 1, 2, 3] as const;
export type ForecastHours = (typeof FORECAST_STOPS)[number];

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const KST_OFFSET_MS = 9 * HOUR_MS;
/** 권역 전망 서버 창(30분~6시간)에 양끝 2분 여유 — 웹 areaDemandCurve 와 같은 값. */
const WINDOW_MIN_MS = 32 * MINUTE_MS;
const WINDOW_MAX_MS = 6 * HOUR_MS - 2 * MINUTE_MS;
const MAX_SHIFT_MS = 30 * MINUTE_MS;

/** 0~3 으로 자른 정수. 이상한 값은 0(지금). */
export function clampForecastHours(value: unknown): ForecastHours {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(3, Math.max(0, n)) as ForecastHours;
}

/** 추천 요청에 실을 가정 시각(UTC ISO) — 지금이면 null(서버 현재 시각). */
export function relativeAssumedAtIso(nowMs: number, hours: number): string | null {
  const h = clampForecastHours(hours);
  return h === 0 ? null : new Date(nowMs + h * HOUR_MS).toISOString();
}

/** 지금 + N시간에 가장 가까운 KST 정시(0~23). 자정을 넘기면 다음 날의 시(23:40 + 1시간 → 1시). */
export function forecastTargetHourKst(nowMs: number, hours: number): number {
  const target = nowMs + clampForecastHours(hours) * HOUR_MS;
  const nearestHourMs = Math.round(target / HOUR_MS) * HOUR_MS;
  return new Date(nearestHourMs + KST_OFFSET_MS).getUTCHours();
}

/** 권역 곡선에서 지금 + N시간의 이 일대 수요(0~1). 그 정시가 없으면 가까운 쪽 이웃 → 반대쪽. 셋 다 없으면 null. */
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

/** 한 시각을 묻는 정시와 서버 창 안으로 당긴 도착 시각(웹 areaDemandCurve.forecastPointAt). 30분 이상 움직이면 null. */
export function forecastPointAt(nowMs: number, hoursAhead: number, shift = 0): { hourKst: number; at: Date } | null {
  const t = Math.round((nowMs + hoursAhead * HOUR_MS) / HOUR_MS) * HOUR_MS + shift * HOUR_MS;
  const at = Math.min(nowMs + WINDOW_MAX_MS, Math.max(nowMs + WINDOW_MIN_MS, t));
  if (Math.abs(at - t) >= MAX_SHIFT_MS) return null;
  return { hourKst: new Date(t + KST_OFFSET_MS).getUTCHours(), at: new Date(at) };
}

/** sessionAreaDemandAt 이 그 정시 다음으로 볼 이웃 쪽(웹과 같은 순서) — [0, -1] 또는 [0, +1]. */
export function forecastPointShifts(nowMs: number, hoursAhead: number): [0, -1 | 1] {
  const target = nowMs + hoursAhead * HOUR_MS;
  const towardLater = target - Math.floor(target / HOUR_MS) * HOUR_MS >= HOUR_MS / 2;
  return [0, towardLater ? -1 : 1];
}

export type ModelPredictions = Record<string, { level: number; anchored: boolean }>;

export type StripForecast =
  | { hours: ForecastHours; basis: 'model'; predictions: ModelPredictions; anchored: boolean }
  | { hours: ForecastHours; basis: 'area'; level: number };

export interface ForecastDeps {
  /** 예측 모델이 학습돼 있는가(앱 실행당 한 번 묻는다). */
  modelTrained: () => Promise<boolean>;
  /** POST /predict/batch — 장소별 예측. 실패는 throw. */
  batch: (hours: ForecastHours) => Promise<ModelPredictions>;
  /** 그 시각 하나만 담은 권역 곡선(GET 1회 — 세션 공용 점 캐시). 실패는 throw. */
  areaCurve: (hours: ForecastHours) => Promise<AreaDemandCurve>;
}

/** /predict/batch 응답 → 장소별 예측. 숫자가 아닌 항목은 버린다(웹 selectForecastHours 의 batch). */
export function predictionsFromBatch(
  res: { predictions?: { facilityId?: unknown; predictedCongestion?: unknown; anchored?: unknown }[] } | null | undefined,
): ModelPredictions {
  const out: ModelPredictions = {};
  for (const p of res?.predictions ?? []) {
    if (typeof p?.predictedCongestion === 'number') {
      out[String(p.facilityId)] = { level: p.predictedCongestion, anchored: p.anchored !== false };
    }
  }
  return out;
}

/** +N시간의 예측: 모델(학습돼 있을 때만) → 권역 곡선 → null. 0시간은 언제나 null. */
export async function resolveStripForecast(hours: number, deps: ForecastDeps, nowMs: number): Promise<StripForecast | null> {
  const h = clampForecastHours(hours);
  if (h === 0) return null;
  let trained = false;
  try {
    trained = await deps.modelTrained();
  } catch {
    trained = false;
  }
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
    // 곡선도 없다.
  }
  return null;
}

/** 띠 상태 — 지금 · 받는 중 · 예측. */
export type StripState =
  | { status: 'now'; failed: boolean }
  | { status: 'loading'; hours: ForecastHours; previous: StripState }
  | { status: 'forecast'; hours: ForecastHours; forecast: StripForecast };

export type StripEvent =
  | { type: 'select'; hours: number }
  | { type: 'resolved'; hours: number; forecast: StripForecast | null }
  | { type: 'reset' };

export const STRIP_NOW: StripState = { status: 'now', failed: false };

/** 상태 기계(웹 stripReducer 그대로): 늦게 온 옛 답은 버리고, 결과가 null 이면 지금으로(failed). */
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

/** 화면이 보여 줄 칸(받는 중이면 고른 칸) — 웹 cardHours. */
export function stripHours(state: StripState): ForecastHours {
  return state.status === 'now' ? 0 : state.hours;
}

/** 예측 결과의 대표 혼잡도 — 이 일대 값, 또는 모델 예측의 가운데값(ids 를 주면 그 장소들만). */
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

// ── 화면 값(웹 page.tsx 3931-3962) ───────────────────────────────────────────────

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface StripBadge {
  /** 긴 배지(읽기 이름) — '🔮 +2시간 후 예측 · 이 일대 여유 · 추정'. */
  text: string;
  /** 휴대폰 줄 안의 짧은 배지 — '🔮 여유 예측'. */
  short: string;
  grade: CongestionKey | null;
}

/** 예측 배지(웹 stripBadge). typeIds: 지금 고른 분류의 장소 id(없으면 전부). 대표값이 없으면 null. */
export function stripBadgeFor(
  forecast: StripForecast | null,
  options: { typeIds?: Iterable<string>; busyAt: number; t: Translate },
): StripBadge | null {
  if (!forecast) return null;
  const level = forecastHeadlineLevel(forecast, options.typeIds);
  if (level === null) return null;
  const grade = congestionKey(level, options.busyAt);
  const levelText = options.t(`congestion.${grade}`);
  const text =
    forecast.basis === 'area'
      ? options.t('forecast.badgeArea', { h: forecast.hours, level: levelText })
      : `${options.t('forecast.badgeModel', { h: forecast.hours, level: levelText })}${forecast.anchored ? '' : ` · ${options.t('map.forecastEstimateTag')}`}`;
  return { text, short: options.t('forecast.badgeShort', { level: levelText }), grade };
}

export interface StripLegend {
  title: string;
  /** 예측 중이면 점선(순위 핀은 번호 원 + 점선 고리). */
  dashed: boolean;
}

/** 범례(웹 stripLegend) — 예측 중이거나 히트맵이 켜졌거나 등급 핀이 있을 때만. 휴대폰은 dashed 일 때만 그린다(ForecastStrip). */
export function stripLegendFor(
  forecast: StripForecast | null,
  options: { showHeatmap?: boolean; gradedPinCount: number; t: Translate },
): StripLegend | null {
  const forecastMode = forecast !== null;
  if (!(forecastMode || options.showHeatmap || options.gradedPinCount > 0)) return null;
  return {
    title: forecast ? options.t('forecast.legendAhead', { h: forecast.hours }) : options.t('forecast.legendNow'),
    dashed: forecastMode,
  };
}

/**
 * 띠를 보일지(웹 showStrip) — 경주(앱 v1 은 늘 참) · 주차장 탭이 아님 · 장소를 다 받았고 오류가 아니며 1곳 이상 · 카드가 펼쳐지지 않음.
 * cardExpanded = 웹 compactCardExpanded(선택 장소가 있고 · 다시 계산 중이 아니고 · 미리보기가 아님 — RecommendationCard onPeekChange).
 */
export function shouldShowForecastStrip(input: {
  parkingTab: boolean;
  loadingFacilities: boolean;
  facilitiesError: boolean;
  facilityCount: number;
  cardExpanded: boolean;
}): boolean {
  return !input.parkingTab && !input.loadingFacilities && !input.facilitiesError && input.facilityCount > 0 && !input.cardExpanded;
}

/**
 * 가정 시각에서 이 장소 핀에 칠할 예측 혼잡도(웹 마커 effect 의 forecastLevel · forecastLevelFor) — 장소별 모델이면 그 장소 값,
 * 권역 값이면 순위 핀에만. 예측이 없으면 null. 핀은 pinDisplay({ …, forecastMode: forecast !== null, forecastLevel }).
 */
export function forecastLevelFor(forecast: StripForecast | null, facilityId: string, ranked: boolean): number | null {
  if (!forecast) return null;
  if (forecast.basis === 'model') return forecast.predictions[facilityId]?.level ?? null;
  return ranked ? forecast.level : null;
}

/** 추천 요청의 가정 시각 — +N 이면 지금+N시간, 아니면 요일 프리셋(웹 page.tsx 2167). presetIso 는 assumedAtIsoForPreset(presetId). */
export function cardAssumedAtIso(nowMs: number, hours: number, presetIso: string | null): string | null {
  return clampForecastHours(hours) > 0 ? relativeAssumedAtIso(nowMs, hours) : presetIso;
}

// ── 트랙 조작(웹 ForecastTimeStrip stopAt · onKeyDown) ────────────────────────────

/** 트랙 안 x(왼쪽 끝 0)를 칸으로. 폭을 모르면 fallback. */
export function stopAtX(x: number, width: number, fallback: ForecastHours): ForecastHours {
  if (!(width > 0)) return fallback;
  return clampForecastHours(Math.floor((x / width) * FORECAST_STOPS.length - 1e-9));
}

/** 방향키 · Home · End · 접근성 increment/decrement → 다음 칸. 모르는 키는 null. 프리셋이 걸려 있으면 지금(0)에서 센다. */
export function stopForKey(key: string, hours: ForecastHours, presetActive: boolean): ForecastHours | null {
  const from = presetActive ? 0 : hours;
  if (key === 'ArrowRight' || key === 'ArrowUp' || key === 'increment') return clampForecastHours(Math.min(3, from + 1));
  if (key === 'ArrowLeft' || key === 'ArrowDown' || key === 'decrement') return clampForecastHours(Math.max(0, from - 1));
  if (key === 'Home') return 0;
  if (key === 'End') return 3;
  return null;
}
