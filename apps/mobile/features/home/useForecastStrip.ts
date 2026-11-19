// 홈 '🔮 혼잡 예측' 띠의 상태 — 웹 app/main/page.tsx 의 strip(useReducer) · selectForecastHours · selectAssumedPreset 의 앱판(G2-24).
//
// 이 훅은 띠의 값(고른 칸 · 받는 중 · 받은 예측 · 걸린 요일 프리셋)과 그 바꾸기만 맡는다. 카드 다시 고르기(웹 startRecalc ·
// abandonRecalc)와 알림(map.predictFail)은 홈 화면 몫이라 콜백으로 알린다 — 연결은 H3b.
//   · +N(지금 포함)을 고르면 프리셋이 걸려 있었으면 'now' 로 풀고(대기·코스와 나누는 값), onChange({kind:'hours'}) 뒤 예측을 받는다.
//     예측이 없으면 지금으로 돌아가며 onFail() — 그 사이 다른 칸을 골랐으면 부르지 않는다(웹 stripRequestRef).
//   · '다른 시간' 프리셋을 고르면 +N 을 비우고 프리셋을 저장한 뒤 onChange({kind:'preset'}).
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import { useAssumedPreset } from '~/components/AssumedTimeSelect';
import { ASSUMED_TIME_PRESETS, assumedAtIsoForPreset, setStoredAssumedPreset } from '~/lib/core/assumedTime';

import { forecastDeps } from './forecastStripApi';
import {
  cardAssumedAtIso,
  clampForecastHours,
  resolveStripForecast,
  STRIP_NOW,
  stripHours,
  stripReducer,
  type ForecastDeps,
  type ForecastHours,
  type StripForecast,
  type StripState,
} from './forecastStripModel';

export type ForecastStripChange = { kind: 'hours'; hours: ForecastHours } | { kind: 'preset'; id: string };

export interface UseForecastStripOptions {
  /** 칸·프리셋이 바뀌었다 — 홈은 카드를 그 시각 기준으로 다시 고른다(웹 startRecalc). 라벨은 t('forecast.now'|'forecast.ahead'|프리셋). */
  onChange?: (change: ForecastStripChange) => void;
  /** +N 예측을 못 받아 지금으로 돌아갔다 — 홈은 다시 계산을 거두고 t('map.predictFail') 한 줄(웹 abandonRecalc + showToast). */
  onFail?: () => void;
  /** 테스트·미리보기용 자료원. */
  deps?: ForecastDeps;
}

export interface ForecastStripController {
  state: StripState;
  /** 고른 칸(받는 중 포함) — 웹 cardHours. 카드는 고르는 즉시 이 시각 기준으로 다시 고른다. */
  hours: ForecastHours;
  loading: boolean;
  /** 받은 예측(없으면 null) — 핀 다시 칠하기·배지·범례(웹 stripForecast). */
  forecast: StripForecast | null;
  /** forecast !== null(웹 forecastMode). */
  forecastMode: boolean;
  /** 걸린 요일 프리셋 id('now' 면 없음). */
  presetId: string;
  /** 가정 시각이 지금이 아닌가(+N 또는 프리셋 — 웹 timeShifted). 카드가 지금 값을 그 시각처럼 말하지 않게. */
  timeShifted: boolean;
  /** 추천 순위의 기준 키 조각(웹 rankBasis 의 `${cardHours}|${assumedPreset}`). 화면이 여행 조건을 뒤에 붙인다. */
  basisKey: string;
  selectHours: (hours: number) => void;
  selectPreset: (id: string) => void;
  /** 추천 요청의 assumedAt(웹 page.tsx 2167) — 부를 때의 지금 기준. */
  assumedAtIso: (nowMs?: number) => string | null;
}

export function useForecastStrip(options: UseForecastStripOptions = {}): ForecastStripController {
  const [state, dispatch] = useReducer(stripReducer, STRIP_NOW);
  const presetId = useAssumedPreset();
  const hours = stripHours(state);
  // 웹 stripRequestRef — 지금 기다리는 칸. 옛 요청의 실패가 새 선택을 되돌리지 않게.
  const requestRef = useRef<number>(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const selectHours = useCallback(
    (value: number) => {
      const next = clampForecastHours(value);
      const presetActive = presetId !== 'now';
      if (next === hours && !presetActive) return;
      if (presetActive) setStoredAssumedPreset('now');
      dispatch({ type: 'select', hours: next });
      requestRef.current = next;
      optionsRef.current.onChange?.({ kind: 'hours', hours: next });
      if (next === 0) return;
      const requested = next;
      void resolveStripForecast(requested, optionsRef.current.deps ?? forecastDeps, Date.now()).then((forecast) => {
        if (!mounted.current) return;
        dispatch({ type: 'resolved', hours: requested, forecast });
        if (!forecast && requestRef.current === requested) {
          requestRef.current = 0;
          optionsRef.current.onFail?.();
        }
      });
    },
    [hours, presetId],
  );

  const selectPreset = useCallback(
    (id: string) => {
      if (id === presetId && state.status === 'now') return;
      requestRef.current = 0;
      dispatch({ type: 'reset' });
      setStoredAssumedPreset(id);
      optionsRef.current.onChange?.({ kind: 'preset', id });
    },
    [presetId, state.status],
  );

  const forecast = state.status === 'forecast' ? state.forecast : null;
  const assumedAtIso = useCallback(
    (nowMs: number = Date.now()) => cardAssumedAtIso(nowMs, hours, assumedAtIsoForPreset(presetId, nowMs)),
    [hours, presetId],
  );

  return useMemo(
    () => ({
      state,
      hours,
      loading: state.status === 'loading',
      forecast,
      forecastMode: forecast !== null,
      presetId,
      timeShifted: hours > 0 || presetId !== 'now',
      basisKey: `${hours}|${presetId}`,
      selectHours,
      selectPreset,
      assumedAtIso,
    }),
    [state, hours, forecast, presetId, selectHours, selectPreset, assumedAtIso],
  );
}

/** '다른 시간' 메뉴의 프리셋('지금' 제외) — 웹 stripPresets. 라벨은 t(labelKey). */
export const STRIP_PRESETS = ASSUMED_TIME_PRESETS.filter((p) => p.id !== 'now');
