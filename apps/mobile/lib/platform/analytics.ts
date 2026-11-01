// 앱 이용 기록·제품 분석 — 웹 apps/web/lib/usageEvents.ts · apps/web/lib/analytics.ts 의 앱판(기준 커밋 e07ea61).
// 로직은 analyticsCore.ts, 여기는 앱 환경을 잇는다.
//
// 켜는 조건: 빌드 설정 EXPO_PUBLIC_USAGE_EVENTS === '1'(운영 빌드에서만 — 계획 §7.5) + 공개 지역(웹 regionRuntime).
//   웹은 운영 호스트일 때만 usage_events 를 보낸다. 앱은 호스트가 없어 빌드 설정으로 가른다. /events/track 도 같은
//   설정으로 막는다(웹은 지역만 본다 — 개발 빌드가 운영 API 를 볼 때 분석이 섞이지 않게 앱은 더 좁혔다).
// 보내는 수단은 주입한다: configureAnalytics({ insertUsageEvents, postTrack }). 이 파일은 Supabase 클라이언트·API
//   클라이언트를 import 하지 않는다(lib/core 가 만든다 — 그쪽이 X-NextSpot-Client 헤더를 붙인다).
// 익명 번호: localStorage(expo-sqlite) 'nextspot_anon_id' — 웹과 같은 키, expo-crypto randomUUID.
//   세션 번호: sessionStorage(앱 실행 동안 사는 대역, lib/sessionStorage.ts) 'nextspot_session_id'.
// 남은 묶음은 앱이 'active' 를 벗어날 때 보낸다(웹 pagehide 와 같은 자리).
import { AppState } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { getActiveRegion, isPublicRegion } from '@/lib/regionRuntime';
import { getCurrentLocale } from '~/lib/i18n/localeState';
import {
  createTracker,
  createUsageRecorder,
  type InsertUsageEvents,
  type PostTrack,
  type UsageEvent,
  type UsageProps,
} from './analyticsCore';

export { USAGE_EVENTS, usageCardProps, type UsageEvent, type UsageProps, type UsageRow, type InsertUsageEvents, type PostTrack } from './analyticsCore';

const ANON_ID_KEY = 'nextspot_anon_id';
const SESSION_ID_KEY = 'nextspot_session_id';
const STROLLER_SESSION_KEY = 'nextspot_stroller_unsupported_v1'; // 웹 lib/strollerSupport.ts 와 같은 키

let insertUsageEvents: InsertUsageEvents | null = null;
let postTrack: PostTrack | null = null;
let currentPage = '';

export interface AnalyticsTransport {
  /** supabase.from('usage_events').insert(rows) 를 감싼 함수. */
  insertUsageEvents?: InsertUsageEvents | null;
  /** POST {API}/api/v1/events/track — Content-Type: application/json 본문 그대로. */
  postTrack?: PostTrack | null;
}

/** 보내는 수단을 정한다. 앱 시작 때 lib/core 쪽에서 한 번 부른다. 정하기 전 이벤트는 버린다. */
export function configureAnalytics(transport: AnalyticsTransport): void {
  if (transport.insertUsageEvents !== undefined) insertUsageEvents = transport.insertUsageEvents;
  if (transport.postTrack !== undefined) postTrack = transport.postTrack;
}

/** 지금 화면 경로(usage_events.page). 루트 레이아웃이 expo-router usePathname() 으로 알려 준다. */
export function setUsagePage(path: string): void {
  currentPage = path;
}

export function usageEventsEnabledByBuild(): boolean {
  return process.env.EXPO_PUBLIC_USAGE_EVENTS === '1';
}

function enabled(): boolean {
  return usageEventsEnabledByBuild() && isPublicRegion(getActiveRegion());
}

function storedId(storage: Storage | undefined, key: string): string | null {
  try {
    if (!storage) return null;
    let value = storage.getItem(key);
    if (!value) {
      value = randomUUID();
      storage.setItem(key, value);
    }
    return value;
  } catch {
    return null; // 저장소 실패 — 번호 없이는 기록하지 않는다
  }
}

const recorder = createUsageRecorder({
  enabled,
  insert: () => insertUsageEvents,
  anonId: () => storedId(globalThis.localStorage, ANON_ID_KEY),
  sessionId: () => storedId(globalThis.sessionStorage, SESSION_ID_KEY),
  page: () => currentPage,
  locale: () => getCurrentLocale(),
  schedule: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
});

const tracker = createTracker({
  enabled,
  post: () => postTrack,
  serverSkipsStroller: () => {
    try {
      return globalThis.sessionStorage?.getItem(STROLLER_SESSION_KEY) === '1';
    } catch {
      return false;
    }
  },
  markServerSkipsStroller: () => {
    try {
      globalThis.sessionStorage?.setItem(STROLLER_SESSION_KEY, '1');
    } catch {
      /* 무시 */
    }
  },
});

/** 이벤트 하나를 모아 둔다(2초 안에 모인 것을 한 번에 보낸다). 웹 trackEvent 와 같은 이름·인자. */
export function trackEvent(event: UsageEvent, props: UsageProps = {}): void {
  recorder.trackEvent(event, props);
}

/** 남은 기록을 지금 보낸다. */
export function flushUsageEvents(): Promise<void> {
  return recorder.flush();
}

/** 익명 분석 이벤트 1건 → /api/v1/events/track. 웹 track 과 같은 이름·인자. */
export function track(event: string, props?: Record<string, unknown>): void {
  tracker.track(event, props);
}

AppState.addEventListener('change', (state) => {
  if (state !== 'active') void recorder.flush();
});
