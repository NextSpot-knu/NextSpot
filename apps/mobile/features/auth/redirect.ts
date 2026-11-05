// 인증 복귀 딥링크(nextspot://auth/callback) 판별·해석 — 순수 모듈(테스트: redirect.test.ts).
//
// 웹 원본: apps/web/lib/oauthFlow.ts 의 buildRedirectTo, apps/web/app/auth/callback/page.tsx 의 쿼리 읽기 (기준 커밋 0d145a1)
// 바꾼 것:
//   · 복귀 주소에 next·provider·retry 를 싣지 않는다. 딥링크는 다른 앱도 보낼 수 있어 그 값을 믿을 수 없다 —
//     흐름의 맥락은 시작할 때 기기 저장소에 적은 '진행 중 흐름'(pendingFlow.ts)에서만 읽는다.
//   · `new URL` 을 쓰지 않는다. +native-intent 에 오는 값은 '경로인지 URL 인지 보장이 없다'(Expo 문서)이고,
//     스킴 URL 의 host/pathname 해석은 런타임마다 다르다. 문자열로 직접 자른다.
//   · 쿼리와 # 조각을 함께 읽는다. PKCE 성공은 ?code=, 실패는 ?error=… 이지만 공급자에 따라 # 로 올 수 있다.

/** 앱 스킴(app.json expo.scheme). */
export const APP_SCHEME = 'nextspot';
/** Supabase signInWithOAuth 의 redirectTo · openAuthSessionAsync 의 redirectUrl. 대시보드 Redirect URLs 에 있어야 한다. */
export const AUTH_CALLBACK_URL = `${APP_SCHEME}://auth/callback`;
/** Expo Router 경로. */
export const AUTH_CALLBACK_ROUTE = '/auth/callback';

export interface AuthCallbackParams {
  code: string | null;
  error: string | null;
  errorCode: string | null;
  errorDescription: string | null;
}

/** 스킴·앞 슬래시·Expo Go 의 `--/` 를 걷어 낸 경로와 나머지(? · #)를 나눈다. */
function splitPath(input: string): { path: string; query: string; fragment: string } {
  let rest = input.trim();
  const hashAt = rest.indexOf('#');
  const fragment = hashAt >= 0 ? rest.slice(hashAt + 1) : '';
  if (hashAt >= 0) rest = rest.slice(0, hashAt);
  const queryAt = rest.indexOf('?');
  const query = queryAt >= 0 ? rest.slice(queryAt + 1) : '';
  if (queryAt >= 0) rest = rest.slice(0, queryAt);
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
  if (scheme) {
    // 앱 스킴만 받는다. https://악성.example/auth/callback 같은 주소를 콜백으로 읽지 않는다.
    if (scheme[1].toLowerCase() !== APP_SCHEME) return { path: '\u0000', query: '', fragment: '' };
    rest = rest.slice(scheme[0].length);
  }
  rest = rest.replace(/^\/+/, '').replace(/^--\//, '').replace(/\/+$/, '');
  return { path: rest, query, fragment };
}

/** 인증 복귀 딥링크인가. `nextspot://auth/callback?…` · `/auth/callback?…` · `auth/callback` 를 모두 받는다. */
export function isAuthCallbackUrl(input: string | null | undefined): boolean {
  if (typeof input !== 'string' || input.length === 0) return false;
  return splitPath(input).path.toLowerCase() === 'auth/callback';
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return part;
  }
}

/** `a=1&b=2` 를 Map 으로. 같은 키가 둘이면 처음 것(덮어쓰기로 값을 바꿔치기하지 못하게). */
export function parseParams(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = decode(eq >= 0 ? pair.slice(0, eq) : pair);
    const value = decode(eq >= 0 ? pair.slice(eq + 1) : '');
    if (key && !out.has(key)) out.set(key, value);
  }
  return out;
}

/** 콜백 URL 에서 code·error 를 읽는다. 쿼리가 우선이고 없으면 # 조각을 본다. 빈 값은 null. */
export function parseAuthCallback(input: string): AuthCallbackParams {
  const { query, fragment } = splitPath(input);
  const q = parseParams(query);
  const h = parseParams(fragment);
  const pick = (key: string): string | null => {
    const v = q.get(key) ?? h.get(key);
    return v && v.trim() ? v.trim() : null;
  };
  return {
    code: pick('code'),
    error: pick('error'),
    errorCode: pick('error_code'),
    errorDescription: pick('error_description'),
  };
}
