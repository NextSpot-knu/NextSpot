// 가정 시간(데모 '시간 시뮬레이터') — 웹 apps/web/lib/api-client.ts 의 ASSUMED_TIME_PRESETS·assumedAtIsoForPreset 을 옮겼다
// (원본: 웹 api-client.ts "가정 시각" 절, 기준 커밋 e89305a). 웹 파일은 window·CustomEvent 를 써서 check:shared 에 걸리므로
// 복사하고, 어긋남은 assumedTime.test.ts 가 웹 소스의 프리셋 표와 대조해 잡는다.
//
// 값은 절대 시각이 아니라 **프리셋 id** 를 저장한다 — 매 호출 때 '가장 가까운 그 요일/시각'을 다시 계산하므로
// 세션이 길어져도 어제 날짜가 굳지 않는다. 'now' 는 null(서버 현재 시각, 기존 동작과 같다).
//
// 웹과 다른 곳: 저장은 전역 localStorage(앱은 expo-sqlite 가 깐다, 웹 빌드는 브라우저 것)를 try/catch 로 읽고,
// 같은 앱 안의 화면 사이 동기화는 CustomEvent 대신 작은 구독 목록으로 한다(대기·코스·홈 예측 띠가 한 값을 같이 본다).

export const ASSUMED_TIME_STORAGE_KEY = 'nextspot_assumed_at';

export interface AssumedTimePreset {
  id: string;
  /** i18n 키(timeSim.*) */
  labelKey: string;
  /** JS getUTCDay 규약(0=일 … 6=토). 'now' 는 null. */
  dow: number | null;
  /** KST 기준 시(0-23). 'now' 는 null. */
  hour: number | null;
}

/** 프리셋: 지금(실시간) · 평일 12:00(수요일 고정) · 금 18:00 · 토 14:00 · 일 11:00. */
export const ASSUMED_TIME_PRESETS: AssumedTimePreset[] = [
  { id: 'now', labelKey: 'timeSim.now', dow: null, hour: null },
  { id: 'weekday_noon', labelKey: 'timeSim.weekdayNoon', dow: 3, hour: 12 },
  { id: 'fri_evening', labelKey: 'timeSim.friEve', dow: 5, hour: 18 },
  { id: 'sat_afternoon', labelKey: 'timeSim.satAfternoon', dow: 6, hour: 14 },
  { id: 'sun_morning', labelKey: 'timeSim.sunMorning', dow: 0, hour: 11 },
];

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function isAssumedPresetId(id: string | null | undefined): id is string {
  return !!id && ASSUMED_TIME_PRESETS.some((p) => p.id === id);
}

/** 프리셋 id → 라벨 i18n 키. 모르는 id 는 'timeSim.now'. */
export function assumedPresetLabelKey(id: string): string {
  return ASSUMED_TIME_PRESETS.find((p) => p.id === id)?.labelKey ?? 'timeSim.now';
}

/**
 * 프리셋 id → 백엔드로 보낼 절대 시각(UTC ISO). 'now'·미상은 null(기존 동작 = 서버 현재 시각).
 * `nowMs` 는 테스트용(기본 지금) — 웹 함수와 같은 식이다.
 */
export function assumedAtIsoForPreset(id: string, nowMs: number = Date.now()): string | null {
  const preset = ASSUMED_TIME_PRESETS.find((p) => p.id === id);
  if (!preset || preset.dow === null || preset.hour === null) return null;
  // KST 벽시계로 환산: 지금(UTC)에 +9h 한 Date 의 UTC 게터가 곧 'KST 벽시계' 다.
  const kstNow = new Date(nowMs + KST_OFFSET_MS);
  const deltaDays = (preset.dow - kstNow.getUTCDay() + 7) % 7;
  // 목표 KST 벽시계(요일+시각, 0분)의 실제 UTC instant = Date.UTC(...) − 9h.
  let utcMs =
    Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate() + deltaDays, preset.hour, 0, 0) -
    KST_OFFSET_MS;
  // 오늘이 그 요일이지만 시각이 이미 지났으면 다음 주 같은 요일로 굴린다(과거 시각 회피).
  if (utcMs <= nowMs) utcMs += WEEK_MS;
  return new Date(utcMs).toISOString();
}

// --- 저장 + 구독 -----------------------------------------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();
/** 저장소를 못 쓰는 환경(차단·읽기 실패)의 대비 — 이번 실행 동안만 값을 들고 있는다. */
let memoryPreset: string | null = null;

function storage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage;
  } catch {
    return undefined;
  }
}

/** 읽은 값 캐시 — useSyncExternalStore 가 렌더마다 부르는 getSnapshot 이 저장소를 매번 읽지 않게. 쓰기·첫 구독 때 비운다. */
let cache: string | null = null;
/** 마지막 저장이 실패했는가 — 그러면 저장소에 남은 옛 값보다 이번 실행의 메모리 값이 맞다. */
let writeFailed = false;

/** 캐시를 비운다(첫 구독 때·테스트). 다음 읽기가 저장소를 다시 본다. */
export function invalidateAssumedPresetCache(): void {
  cache = null;
}

/** 지금 저장된 프리셋 id. 없거나 모르는 값이면 'now'. */
export function getStoredAssumedPreset(): string {
  if (cache !== null) return cache;
  let result = 'now';
  if (writeFailed && isAssumedPresetId(memoryPreset)) {
    result = memoryPreset;
  } else {
    try {
      const v = storage()?.getItem(ASSUMED_TIME_STORAGE_KEY);
      if (isAssumedPresetId(v)) result = v;
      else if (v == null && isAssumedPresetId(memoryPreset)) result = memoryPreset;
    } catch {
      if (isAssumedPresetId(memoryPreset)) result = memoryPreset;
    }
  }
  cache = result;
  return result;
}

/** 저장하고 같은 앱의 구독자에게 알린다. 모르는 id 는 'now' 로. */
export function setStoredAssumedPreset(id: string): void {
  const valid = isAssumedPresetId(id) ? id : 'now';
  memoryPreset = valid;
  cache = valid;
  try {
    const s = storage();
    if (s) s.setItem(ASSUMED_TIME_STORAGE_KEY, valid);
    writeFailed = !s;
  } catch {
    /* 저장소 차단 — 이번 실행 동안만 바뀐다 */
    writeFailed = true;
  }
  for (const l of Array.from(listeners)) l();
}

/** 값이 바뀔 때 부른다. 돌려주는 함수로 해제. */
export function subscribeAssumedPreset(listener: Listener): () => void {
  if (listeners.size === 0) cache = null; // 구독 사이에 저장소가 바뀌었을 수 있다
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 현재 저장된 프리셋 기준 절대 시각(UTC ISO). 'now' 면 null. */
export function getAssumedAtIso(nowMs: number = Date.now()): string | null {
  return assumedAtIsoForPreset(getStoredAssumedPreset(), nowMs);
}
