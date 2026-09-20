'use client';

// OAuth 콜백 처리 — docs/archive/OAUTH_PLAN.md F3.
// 카카오·구글 로그인/연동 후 Supabase 가 ?code= 를 실어 이 경로로 복귀시킨다. lib/supabase.ts 의
// detectSessionInUrl(PKCE)이 code 를 자동 교환하며, 여기서는 교환이 '연동 계정' 상태로 반영될 때까지
// 기다렸다가 프로필을 백필하고 원래 위치(next)로 돌려보낸다.
//
// 정적 export 호환: 클라이언트 컴포넌트 + 고정 경로(/auth/callback)라 서버 라우트가 필요 없다.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { resolvePostLoginDest } from '@/lib/postLoginDest';
import { createPublicClient } from '@/lib/supabase';
import { discardCapturedGuestData, getAuthState, markPasswordRecovery, syncProfileFromProvider, mergeCapturedGuestData, signInOAuth, type OAuthProvider } from '@/lib/auth';
import { useT } from '@/lib/i18n/I18nProvider';

// 오픈 리다이렉트 방지 — 앱 내부 절대경로만 허용(lib/auth.ts 와 동일 규칙).
function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/mypage';
  return next;
}

export default function AuthCallbackPage() {
  const router = useRouter();
  const t = useT();
  // null=처리중, 'generic'=일반 실패, 'already_linked'=이 소셜 계정이 이미 다른 계정에 연동됨,
  // 'recovery'=비밀번호 재설정 메일 왕복의 실패(`?next=/auth/reset-password`). 마지막 것은
  // 안내 문구도 '다음에 할 일' 도 로그인 실패와 다르다 — 만료된 링크는 메일을 다시 받아야 한다.
  const [failed, setFailed] = useState<null | 'generic' | 'already_linked' | 'recovery'>(null);
  const recoveryFlow = failed === 'recovery';

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    const next = safeNext(params.get('next'));
    const isRecovery = next.startsWith('/auth/reset-password');
    // 이 왕복에서 '일반 실패' 가 무엇으로 보여야 하는지.
    const genericFail = isRecovery ? 'recovery' : 'generic';
    // 프로바이더/Supabase 가 거부하면 error(_code/_description) 로 복귀한다.
    const oauthError = params.get('error_description') || params.get('error');
    if (oauthError) {
      const errorCode = params.get('error_code');
      const rawProvider = params.get('provider');
      const provider: OAuthProvider | null =
        rawProvider === 'kakao' || rawProvider === 'google' ? rawProvider : null;
      const isRetry = params.get('retry') === '1';

      // '계속하기' 단일 버튼의 핵심: '연동(회원가입)'하려던 소셜 계정이 이미 다른 사용자에 연결돼 있으면
      //   (identity_already_exists) → 같은 프로바이더로 '로그인(계정 전환)'을 자동 재시도한다.
      //   사용자에겐 버튼 하나로 신규=회원가입 / 기존=로그인이 자동 분기되는 것처럼 보인다.
      //   retry 표식이 있으면(이미 폴백 로그인 경로) 재폴백하지 않는다(무한 루프 방지).
      if (errorCode === 'identity_already_exists' && provider && !isRetry) {
        void (async () => {
          const { error } = await signInOAuth(provider, next);
          if (error) setFailed(genericFail); // 폴백 로그인 개시 자체가 실패하면 일반 안내.
        })();
        return; // 리다이렉트 진행 중 — 스피너 유지.
      }

      discardCapturedGuestData();
      setFailed(errorCode === 'identity_already_exists' ? 'already_linked' : genericFail);
      return;
    }

    let done = false;
    // detectSessionInUrl 이 code 를 소비하도록 클라이언트를 확보(레이아웃 SessionBootstrap 과 동일 싱글턴).
    const supabase = createPublicClient();

    const finish = async () => {
      if (done) return;
      done = true;
      // 복구 링크 왕복이면 여기서 표식을 남긴다 — 비밀번호 변경 화면은 '세션이 있다' 가 아니라
      // 이 표식으로 폼을 연다(주소만 치고 들어온 사람에게 폼이 열리면 안 된다).
      if (isRecovery) markPasswordRecovery();
      try {
        await mergeCapturedGuestData();
        await syncProfileFromProvider();
        // `?next=` 가 없어 기본값(/mypage)으로 온 경우에만 역할을 본다 — admin 은 관제로.
        const explicit = params.get('next');
        router.replace(await resolvePostLoginDest(explicit ? next : null, next));
      } catch (err) {
        // 부가 작업(병합·프로필·역할 조회)이 어떻게 실패하든 **이동은 반드시 한다**.
        // 여기서 예외가 새면 done=true 라 폴링도 실패 처리를 못 해 스피너가 영원히 남는다.
        console.warn('[auth/callback] 후처리 실패 — 목적지로 그대로 이동:', err);
        router.replace(next);
      }
    };

    // 완료 판정: code 교환이 '연동 계정' 상태로 반영되면(getAuthState → linked) 복귀한다.
    // 익명 세션이 이미 있어서 '세션 존재'만으로는 교환 완료를 구분할 수 없어, 연동 여부로 판정한다.
    const tryFinishIfLinked = async () => {
      const state = await getAuthState();
      if (state.status === 'linked') await finish();
    };

    // 이벤트(교환 완료 시 SIGNED_IN/USER_UPDATED)와 폴링(리스너 부착 전 이벤트를 놓친 경우 대비)을 병행.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      // PASSWORD_RECOVERY 는 복구 토큰이 세션으로 바뀐 순간이다 — 표식의 1차 출처.
      if (event === 'PASSWORD_RECOVERY') markPasswordRecovery();
      if (event === 'SIGNED_IN' || event === 'USER_UPDATED' || event === 'TOKEN_REFRESHED' || event === 'PASSWORD_RECOVERY') {
        void tryFinishIfLinked();
      }
    });

    let tries = 0;
    const poll = setInterval(() => {
      tries += 1;
      void tryFinishIfLinked();
      if (tries >= 27) {
        // ~8초(300ms×27) 내 연동 반영이 안 되면 실패 안내(교환 실패/설정 부재 등).
        clearInterval(poll);
        if (!done) setFailed(genericFail);
      }
    }, 300);
    void tryFinishIfLinked();

    return () => {
      sub.subscription.unsubscribe();
      clearInterval(poll);
    };
  }, [router]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-hanji text-muk px-6 text-center">
      {failed ? (
        // 실패 화면은 **반드시 나갈 길을 준다**. 복구 링크 왕복이면 '메일 다시 받기' 가,
        // 그 밖에는 마이페이지와 로그인 재시도가 다음 걸음이다.
        <div className="animate-fade-in flex flex-col items-center">
          <p className="text-lg font-serif font-bold text-muk mb-2">
            {recoveryFlow
              ? t('password.requestTitle')
              : t(failed === 'already_linked' ? 'auth.callbackAlreadyLinkedTitle' : 'auth.callbackFailedTitle')}
          </p>
          <p className="text-sm text-muk-soft mb-6 max-w-xs break-keep">
            {recoveryFlow
              ? t('password.invalidLink')
              : t(failed === 'already_linked' ? 'auth.callbackAlreadyLinkedDesc' : 'auth.callbackFailedDesc')}
          </p>
          <button
            type="button"
            onClick={() => router.replace(recoveryFlow ? '/forgot-password' : '/mypage')}
            className="px-6 py-3 rounded-full bg-gold hover:bg-gold-deep text-white font-bold transition-colors"
          >
            {recoveryFlow ? t('password.requestSubmit') : t('auth.callbackBackToMypage')}
          </button>
          <button
            type="button"
            onClick={() => router.replace('/login')}
            className="mt-3 px-4 py-2 text-sm text-muk-soft underline hover:text-muk transition-colors"
          >
            {t('login.tabLogin')}
          </button>
        </div>
      ) : (
        <div className="animate-fade-in flex flex-col items-center">
          {/* 금빛 스피너 — 브랜드 톤 유지 */}
          <div className="w-10 h-10 rounded-full border-[3px] border-gold/25 border-t-gold animate-spin mb-4" />
          <p className="text-sm text-muk-soft">{t('auth.callbackLoading')}</p>
        </div>
      )}
    </div>
  );
}
