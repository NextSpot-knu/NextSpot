// 앱 설정 — EXPO_PUBLIC_* 공개 값만 읽는다(docs/MOBILE_APP_PLAN.md §5.2 '환경 변수').
//
// Expo 는 `process.env.EXPO_PUBLIC_X` 를 **점 표기 그대로** 쓸 때만 번들 시점에 값으로 바꿔 넣는다.
// 구조 분해나 `process.env[name]` 으로 읽으면 값이 빈다 — 아래 rawEnv 의 모양을 바꾸지 않는다.
// 여기 들어가는 값은 번들에 그대로 실린다. API 주소·Supabase 주소·anon 키처럼 원래 공개인 값만 둔다.

/** 운영 API(싱가포르 Render `nextspot-t2ib` — docs/HANDOVER.md 2026-10-09 이전 기록). */
export const DEFAULT_API_URL = 'https://nextspot-t2ib.onrender.com';

export interface RawEnv {
  apiUrl?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  usageEvents?: string;
}

export interface AppEnv {
  /** FastAPI 주소(끝 슬래시 없음). */
  apiUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** Supabase 설정이 실제로 들어왔는가. 없으면 세션을 만들 수 없다(자리값 주소로 조용히 실패하지 않게 알린다). */
  supabaseConfigured: boolean;
  /**
   * 사용 기록(usage_events)을 보낼지. 웹은 운영 도메인일 때만 기록하는데 앱에는 도메인이 없어 빌드 설정으로 가른다
   * (계획 §7.5). EXPO_PUBLIC_USAGE_EVENTS=1 이면서 개발 빌드(__DEV__)가 아닐 때만 켠다.
   */
  usageEventsEnabled: boolean;
}

const PLACEHOLDER_SUPABASE_URL = 'https://your-supabase-project.supabase.co';
const PLACEHOLDER_SUPABASE_KEY = 'your-supabase-anon-key';

function clean(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 순수 해석 — 테스트가 직접 부른다. */
export function resolveEnv(raw: RawEnv, isDev: boolean): AppEnv {
  const apiUrl = (clean(raw.apiUrl) || DEFAULT_API_URL).replace(/\/+$/, '');
  const supabaseUrl = clean(raw.supabaseUrl);
  const supabaseAnonKey = clean(raw.supabaseAnonKey);
  const usage = clean(raw.usageEvents).toLowerCase();
  return {
    apiUrl,
    supabaseUrl: supabaseUrl || PLACEHOLDER_SUPABASE_URL,
    supabaseAnonKey: supabaseAnonKey || PLACEHOLDER_SUPABASE_KEY,
    supabaseConfigured: supabaseUrl !== '' && supabaseAnonKey !== '',
    usageEventsEnabled: !isDev && (usage === '1' || usage === 'true'),
  };
}

declare const __DEV__: boolean | undefined;

function isDevBuild(): boolean {
  // RN 번들에는 __DEV__ 가 있다. node 테스트에는 없으므로 개발로 본다(기록을 켜지 않는 쪽).
  return typeof __DEV__ === 'undefined' ? true : __DEV__ === true;
}

const rawEnv: RawEnv = {
  apiUrl: process.env.EXPO_PUBLIC_API_URL,
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  usageEvents: process.env.EXPO_PUBLIC_USAGE_EVENTS,
};

export const env: AppEnv = resolveEnv(rawEnv, isDevBuild());
