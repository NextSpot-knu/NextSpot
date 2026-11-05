// 익명(게스트) 세션 보장 — 순수 부분(Supabase·RN 을 import 하지 않는다. 타입만 쓴다).
//
// 웹 원본: apps/web/lib/anonymousSession.ts createAnonymousSessionEnsurer (기준 커밋 e07ea61)
// 웹 모듈은 lib/supabase·lib/turnstile 을 import 해 그대로 쓸 수 없다(check:shared). 핵심 로직만 옮겼다.
// 바꾼 것: CAPTCHA(Turnstile) 토큰 인자를 뺐다 — 앱은 CAPTCHA 를 켜지 않는다(계획 §7.6). 그 밖의 동작은 같다:
//   · 생성 중인 Promise 만 공유하고, 끝나면 다음 호출이 최신 세션을 다시 읽는다(로그인·로그아웃 뒤 옛 uid 를 쓰지 않게).
//   · 저장된 세션은 창과 무관하게 언제나 먼저 본다.
//   · 익명 로그인이 거절되면 BACKOFF_MS 창 안에서는 네트워크 없이 null(웹 감사 I22 — IP 한도 소진 방지).
import type { Session } from '@supabase/supabase-js';

export interface AnonymousAuthClient {
  getSession(): Promise<{ data: { session: Session | null } }>;
  signInAnonymously(): Promise<{
    data: { session: Session | null };
    error: { message: string } | null;
  }>;
}

/** 거절 뒤 다음 시도까지의 창(ms): 5초·15초·45초·2분·5분, 다섯 번째부터는 5분을 계속 쓴다. */
export const BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const;

/** n 번째(1부터) 연속 실패 뒤의 대기(ms). */
export function backoffDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
}

export interface AnonymousSessionEnsurer {
  (): Promise<Session | null>;
  /** 다음 익명 로그인 시도까지 남은 시간(ms). 창이 없으면 0. */
  retryInMs(): number;
  /** 사람이 직접 누른 재시도 — 창을 건너뛰고 다음 호출이 바로 묻는다(실패 횟수는 남긴다). */
  resetBackoff(): void;
}

export function createAnonymousSessionEnsurer(
  getAuth: () => AnonymousAuthClient,
  now: () => number = Date.now,
): AnonymousSessionEnsurer {
  let sessionPromise: Promise<Session | null> | null = null;
  let failures = 0;
  let nextAttemptAt = 0;

  const recordFailure = () => {
    failures += 1;
    nextAttemptAt = now() + backoffDelayMs(failures);
  };

  const ensureSession = function ensureSession(): Promise<Session | null> {
    if (sessionPromise) return sessionPromise;

    const pending = (async () => {
      try {
        const auth = getAuth();
        const current = await auth.getSession();
        if (current.data.session) {
          failures = 0;
          nextAttemptAt = 0;
          return current.data.session;
        }
        if (now() < nextAttemptAt) return null;

        const signedIn = await auth.signInAnonymously();
        if (signedIn.error || !signedIn.data.session) {
          recordFailure();
          console.warn('[auth] 익명 세션을 만들지 못했습니다.', signedIn.error?.message ?? 'no session');
          return null;
        }
        failures = 0;
        nextAttemptAt = 0;
        return signedIn.data.session;
      } catch (error) {
        recordFailure();
        console.warn('[auth] 익명 세션 준비 중 오류가 발생했습니다.', error);
        return null;
      }
    })();

    sessionPromise = pending;
    void pending.finally(() => {
      if (sessionPromise === pending) sessionPromise = null;
    });
    return pending;
  } as AnonymousSessionEnsurer;

  ensureSession.retryInMs = () => Math.max(0, nextAttemptAt - now());
  ensureSession.resetBackoff = () => {
    nextAttemptAt = 0;
  };
  return ensureSession;
}
