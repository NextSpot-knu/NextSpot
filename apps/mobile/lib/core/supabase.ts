// Supabase 클라이언트 — 앱 전체에 하나.
//
// 웹 원본: apps/web/lib/supabase.ts (기준 커밋 e07ea61)
// 바꾼 것(Expo 안내 https://docs.expo.dev/guides/using-supabase/ · 계획 §7.1):
//   · storage = 전역 localStorage(expo-sqlite — index.ts 가 라우터보다 먼저 깐다). 세션이 앱 재실행에도 남는다.
//   · detectSessionInUrl: false — 앱에는 읽을 URL 이 없다. OAuth·메일 링크의 code 교환은 콜백 라우트 **한 곳**이
//     exchangeCodeForSession 으로 직접 한다(계획 §7.2 — 안드로이드에서 같은 딥링크를 두 번 교환하지 않게). 여기서 하지 않는다.
//   · flowType: 'pkce' 는 웹과 같다(supabase-js 기본값은 implicit).
//   · 토큰 자동 갱신은 앱이 앞에 있을 때만 돈다 — AppState 'active' 에서 startAutoRefresh, 그 밖에서 stopAutoRefresh.
//   · 6초 fetch 타임아웃은 웹과 같다(무한 로딩 방지).
//   · `lock` 옵션은 주지 않는다 — 설치된 auth-js 가 lock 없이 갱신을 조율하고 lock 옵션을 폐기 예정으로 경고한다.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, type AppStateStatus } from 'react-native';

import { env } from './env';

const REQUEST_TIMEOUT_MS = 6000;

function timeoutFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const external = init?.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

let client: SupabaseClient | null = null;
let appStateWired = false;

function wireAutoRefresh(supabase: SupabaseClient): void {
  if (appStateWired) return;
  appStateWired = true;
  const apply = (state: AppStateStatus) => {
    if (state === 'active') void supabase.auth.startAutoRefresh();
    else void supabase.auth.stopAutoRefresh();
  };
  // 처음 상태도 반영한다 — 리스너는 '바뀔 때' 만 불린다.
  apply(AppState.currentState);
  AppState.addEventListener('change', apply);
  // auth-js 의 initialize 는 끝에서(_handleVisibilityChange) 브라우저가 아니면 갱신 타이머를 '무조건' 켠다. 백그라운드에서
  // 시작됐으면(알림·딥링크로 깨어남) 위의 stop 이 덮이므로, 초기화가 끝난 뒤 지금 상태를 한 번 더 적용한다.
  supabase.auth
    .initialize()
    .then(() => apply(AppState.currentState))
    .catch(() => undefined);
}

/** 웹과 같은 이름 — 화면·웹 이식 코드가 그대로 부를 수 있게. */
export function createPublicClient(): SupabaseClient {
  if (!client) {
    if (!env.supabaseConfigured) {
      console.warn('[supabase] EXPO_PUBLIC_SUPABASE_URL · EXPO_PUBLIC_SUPABASE_ANON_KEY 가 없습니다 — 세션을 만들 수 없습니다.');
    }
    client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: {
        storage: globalThis.localStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: 'pkce',
      },
      global: { fetch: timeoutFetch },
    });
    wireAutoRefresh(client);
  }
  return client;
}

/** 앱 코드용 짧은 이름. */
export const getSupabase = createPublicClient;
