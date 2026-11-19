// 앱을 켜면 게스트(익명) 세션을 만들고, 세션이 정해질 때마다 사용자 데이터를 맞춘다.
//
// 웹 원본: apps/web/components/shell/SessionBootstrap.tsx (기준 커밋 e07ea61)
// 바꾼 것: 화면 보임 이벤트 → AppState(sessionHeal.ts). typeof window 가드 없음(프리렌더가 없다). CAPTCHA 없음(§7.6).
// 순서는 같다: ensureAnonymousSession → reconcileUserData(uid) → (세션이 있으면) mergeCapturedGuestData → syncSaved ·
// flushRecommendationOutcomes. 로그아웃(SIGNED_OUT)이면 새 게스트 세션을, SIGNED_IN·USER_UPDATED 면 다시 맞춘다.
//
// 이 컴포넌트는 OAuth code 를 교환하지 않는다 — 교환은 콜백 라우트 한 곳의 몫이다(계획 §7.2).
import type { Session } from '@supabase/supabase-js';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { ensureAnonymousSession } from './anonymousSession';
import { discardCapturedGuestData, mergeCapturedGuestData } from './guestMerge';
import { flushRecommendationOutcomes } from './recommendationOutcomes';
import { syncSaved } from './savedFacilities';
import { createHealScheduler } from './sessionHeal';
import { createPublicClient } from './supabase';
import { reconcileUserData } from './userData';

export default function SessionBootstrap(): null {
  useEffect(() => {
    let cancelled = false;

    const syncForSession = async (session: Session | null) => {
      if (cancelled) return;
      reconcileUserData(session?.user?.id ?? null);
      if (session?.user?.id) {
        await mergeCapturedGuestData();
        if (cancelled) return;
        void syncSaved();
        void flushRecommendationOutcomes();
      }
    };

    const healer = createHealScheduler({
      ensure: () => ensureAnonymousSession(),
      retryInMs: () => ensureAnonymousSession.retryInMs(),
      isActive: () => AppState.currentState === 'active',
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });

    const ensureThenSync = async () => {
      try {
        const session = await ensureAnonymousSession();
        await syncForSession(session);
        if (!session) healer.arm();
      } catch (err) {
        console.warn('[SessionBootstrap] 세션 부트스트랩 예외 — 게스트 없이 계속합니다.', err);
        healer.arm();
      }
    };

    void ensureThenSync();

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') healer.onActive();
    });

    const { data: authSubscription } = createPublicClient().auth.onAuthStateChange((event, session) => {
      // supabase-js 콜백 안에서 다른 auth 호출을 기다리면 교착할 수 있다 — 한 틱 미룬다(웹과 같다).
      if (event === 'SIGNED_OUT') {
        // 앱은 합치기 토큰을 1시간 영속한다(웹은 탭 수명) — 로그아웃 뒤 새 게스트 세션에 이전 게스트 데이터가 합쳐지지 않게 버린다.
        discardCapturedGuestData();
        setTimeout(() => { void ensureThenSync(); }, 0);
      } else if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
        setTimeout(() => { void syncForSession(session); }, 0);
      }
    });

    return () => {
      cancelled = true;
      healer.dispose();
      appStateSub.remove();
      authSubscription.subscription.unsubscribe();
    };
  }, []);

  return null;
}
