import type { Session } from '@supabase/supabase-js';
import { createPublicClient } from './supabase';

interface AnonymousAuthClient {
  getSession(): Promise<{ data: { session: Session | null } }>;
  signInAnonymously(): Promise<{
    data: { session: Session | null };
    error: { message: string } | null;
  }>;
}

/**
 * 익명 로그인이 거절된 뒤 다음 시도까지 기다리는 창(ms). 다섯 번째부터는 마지막 값(5분)을 계속 쓴다.
 *
 * 왜 필요한가(2026-10-06 감사 I22): 거절(Supabase IP 한도 429)된 뒤에도 다음 호출이 곧바로 다시
 * POST /auth/v1/signup 을 보냈다. /waiting 한 번이 4유형 × 2패스 + 자동 재시도로 14~17번을 보내
 * 한도가 풀리기도 전에 다시 채웠다. 창 안에서는 네트워크 없이 null 을 돌려준다.
 */
const BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const;

export interface AnonymousSessionEnsurer {
  (): Promise<Session | null>;
  /** 다음 익명 로그인 시도까지 남은 시간(ms). 창이 없으면 0. */
  retryInMs(): number;
  /** '다시 시도' 처럼 사람이 직접 누른 재시도 — 창을 건너뛰고 다음 호출이 바로 묻는다(실패 횟수는 남긴다). */
  resetBackoff(): void;
}

/**
 * 첫 방문의 익명 로그인과 추천 요청이 경합하지 않도록 앱 전체에서 하나의 Promise를 공유한다.
 * 실패하면 null을 반환해 공개 화면은 계속 동작하되, 존재하지 않는 고정 mock user id는 만들지 않는다.
 * 거절된 뒤에는 BACKOFF_MS 창마다 한 번만 다시 묻는다. 저장된 세션은 창과 무관하게 언제나 먼저 본다 —
 * 이메일 로그인·재방문자는 창 때문에 막히지 않는다.
 */
export function createAnonymousSessionEnsurer(
  getAuth: () => AnonymousAuthClient,
  now: () => number = Date.now,
): AnonymousSessionEnsurer {
  // 익명 세션 "생성 중"인 동안만 공유한다. 완료된 Session 객체를 영구 캐시하면 이메일 로그인이나
  // 로그아웃 뒤에도 과거 uid를 추천 본문에 넣게 되어 현재 JWT uid와 불일치(403)가 발생한다.
  let sessionPromise: Promise<Session | null> | null = null;
  // 메모리에만 둔다 — 새로고침하면 한 번은 다시 묻는다(Supabase 토큰 버킷은 거절된 시도로 줄지 않는다).
  let failures = 0;
  let nextAttemptAt = 0;

  const recordFailure = () => {
    failures += 1;
    nextAttemptAt = now() + BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
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
      // 이 호출이 끝난 뒤에는 다음 호출이 Supabase의 최신 세션을 다시 읽게 한다.
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

export const ensureAnonymousSession = createAnonymousSessionEnsurer(
  () => createPublicClient().auth as AnonymousAuthClient,
);
