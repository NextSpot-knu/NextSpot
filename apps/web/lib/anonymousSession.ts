import type { Session } from '@supabase/supabase-js';
import { createPublicClient } from './supabase';

let sessionPromise: Promise<Session | null> | null = null;

/**
 * 첫 방문의 익명 로그인과 추천 요청이 경합하지 않도록 앱 전체에서 하나의 Promise를 공유한다.
 * 실패하면 null을 반환해 공개 화면은 계속 동작하되, 존재하지 않는 고정 mock user id는 만들지 않는다.
 */
export function ensureAnonymousSession(): Promise<Session | null> {
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    try {
      const supabase = createPublicClient();
      const current = await supabase.auth.getSession();
      if (current.data.session) return current.data.session;

      const signedIn = await supabase.auth.signInAnonymously();
      if (signedIn.error) {
        console.warn('[auth] 익명 세션을 만들지 못했습니다.', signedIn.error.message);
        return null;
      }
      return signedIn.data.session;
    } catch (error) {
      console.warn('[auth] 익명 세션 준비 중 오류가 발생했습니다.', error);
      return null;
    }
  })();

  return sessionPromise;
}
