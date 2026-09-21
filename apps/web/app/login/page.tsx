'use client';

// 앱 자체 회원(이메일/비밀번호) 로그인/회원가입 — docs/archive/AUTH_MEMBERSHIP_PLAN.md.
// 랜딩 '바로 시작' → 이 페이지. 게스트 둘러보기(익명 세션)도 유지한다.
// 가입은 현재 익명 세션을 '정회원 전환'해 저장·취향 데이터를 승계한다(lib/auth signUpWithEmail).

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { Mail, Lock, User } from 'lucide-react';
import { signInWithEmail, signUpWithEmail, signInOAuth, type OAuthProvider } from '@/lib/auth';
import type { SignInFailReason } from '@/lib/authErrors';
import { safeNext } from '@/lib/oauthFlow';
import { resolvePostLoginDest } from '@/lib/postLoginDest';
import { reconcileUserData } from '@/lib/userData';
import { syncSaved } from '@/lib/savedFacilities';
import { createPublicClient } from '@/lib/supabase';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { JudgeAccountHint } from '@/components/JudgeAccountHint';
import { JUDGE_ACCOUNTS, judgeConsoleForNext } from '@/lib/judgeAccounts';
import { useT } from '@/lib/i18n/I18nProvider';

type Mode = 'login' | 'signup';

// 로그인 실패 원인 → 안내 문구 키.
//
// 핵심은 '서버 장애' 를 '비밀번호가 틀렸다' 로 말하지 않는 것이다. 전자는 사용자가 아무리 다시
// 쳐도 안 되고, 후자는 다시 치면 된다 — 반대로 안내하면 사용자는 맞는 비밀번호를 의심한다.
// ⚠️ 여기 문구는 전부 **이미 있는 키**다(이 작업은 lib/i18n 을 건드릴 수 없다).
//    login.serverError / login.emailNotConfirmed 전용 키가 생기면 아래를 그리로 옮길 것.
const SIGN_IN_ERROR_KEY: Record<SignInFailReason, string> = {
  invalid_credentials: 'login.loginError',
  // "확인 메일을 보냈어요. 메일 링크로 인증한 뒤 로그인하세요." — 가입 시 발송된 그 메일 얘기다.
  email_not_confirmed: 'login.confirmSent',
  // "문제가 발생했어요" — 자격증명 문구와 확실히 구분되는 일반 장애 안내.
  server: 'common.error',
  // 분류되지 않은 4xx 는 기존 동작(자격증명 안내)을 유지한다 — 대부분 실제로 그 경우다.
  unknown: 'login.loginError',
};

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useT();
  // 로그인 후 돌아갈 곳. /merchant·/admin/dashboard 처럼 권한이 필요한 화면이
  // ?next= 로 보내온다. safeNext 로 앱 내부 절대경로만 허용한다(오픈 리다이렉트 방지).
  const nextPath = safeNext(searchParams.get('next') ?? undefined);
  // 기존 동작 유지: next 가 없으면 로그인은 /main, 신규 가입은 /setup.
  const hasNext = searchParams.get('next') !== null;
  const loginDest = hasNext ? nextPath : '/main';
  // 소셜 로그인은 프로바이더 왕복 뒤 /auth/callback 이 이동을 맡으므로 역할 판정도 거기서 한다.
  // 여기(이메일 로그인)는 afterAuth 가 처리한다.
  const signUpDest = hasNext ? nextPath : '/setup';
  // 콘솔 관문(/merchant·/admin)이 보내온 로그인이면 그 콘솔의 심사용 계정을 이메일 칸에 미리 넣는다.
  // 계정이 둘이라 직접 고르게 두면 반대 계정으로 들어가 '권한 없음'에서 멈춘다(lib/judgeAccounts.ts).
  const judgeConsole = judgeConsoleForNext(hasNext ? nextPath : null);
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState(() => (judgeConsole ? JUDGE_ACCOUNTS[judgeConsole] : ''));
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const busyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  // 버튼이 영영 비활성으로 남지 않게 하는 안전망 두 개.
  //
  // (1) 뒤로가기 복귀(bfcache): 'SNS 계속하기' → 카카오 동의 화면 → **뒤로가기** 로 돌아오면
  //     브라우저가 페이지를 얼린 그대로(busy=true) 되살린다 — 화면은 로그인 폼인데 모든 버튼이
  //     죽어 있고, 새로고침 말고는 방법이 없다. 심사위원이 동의를 취소하면 정확히 이 경로다.
  // (2) 타이머: 리다이렉트가 시작되지 않은 경우(armBusyRelease).
  useEffect(() => {
    const revive = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(false);
    };
    window.addEventListener('pageshow', revive);
    return () => {
      window.removeEventListener('pageshow', revive);
      if (busyTimer.current) clearTimeout(busyTimer.current);
    };
  }, []);

  const armBusyRelease = () => {
    if (busyTimer.current) clearTimeout(busyTimer.current);
    busyTimer.current = setTimeout(() => setBusy(false), 8000);
  };

  // 인증 성공 후: 세션 uid 로 이전(게스트) 로컬 데이터를 격리하고 이 계정의 저장 목록을 복원한 뒤 이동.
  const afterAuth = async (dest: string) => {
    try {
      const {
        data: { user },
      } = await createPublicClient().auth.getUser();
      reconcileUserData(user?.id ?? null);
      await syncSaved();
    } catch {
      /* 무시 — 이동은 계속 */
    }
    // 목적지가 명시되지 않았으면 역할을 보고 정한다(admin → 관제 대시보드).
    // replace 인 이유: push 로 보내면 **뒤로가기가 로그인 폼으로 돌아온다**. 이미 로그인된
    // 상태로 빈 로그인 화면을 다시 보면 "로그인이 안 된 건가" 로 읽힌다(/auth/callback 도 replace).
    router.replace(await resolvePostLoginDest(hasNext ? dest : null, dest));
  };

  // SNS 계속하기 — 이 화면은 '로그인하러 온' 곳이므로 signInOAuth(계정 전환)를 **바로** 쓴다.
  //
  // 왜 linkOAuth 가 아닌가(2026-08-27 변경): linkOAuth 는 현재(익명) 세션에 소셜 identity 를
  // 붙이려 시도하는데, 이미 그 소셜 계정으로 가입한 사용자면 identity_already_exists 로 실패한다.
  // 그러면 콜백이 signInOAuth 로 자동 폴백하므로 결과적으로는 로그인되지만, **프로바이더를 두 번
  // 왕복**하게 된다 — 사용자 눈에는 계정 선택 화면이 두 번 떠서 "처음엔 실패했다" 로 읽힌다.
  // 재방문자는 전부 이 경로라 출시 후 다수 사용자가 매번 겪는다.
  //
  // 게스트 데이터는 잃지 않는다: signInOAuth 가 captureGuestSession() 으로 익명 토큰을 잡아두고,
  // 콜백의 mergeCapturedGuestData() → POST /account/merge-guest 가 원자 병합한다(취향·닉네임·
  // 저장·쿠폰·제보·추천 이력까지 — merge_guest_account_data RPC).
  //
  // 게스트 승격 진입점(마이페이지 AccountSection)은 그대로 linkOAuth 를 쓴다 — 거긴 '내 계정을
  // 만든다' 는 의도라 uid 를 유지하는 편이 맞고, 병합조차 필요 없다.
  const handleOAuth = async (provider: OAuthProvider) => {
    if (busy) return;
    setBusy(true);
    const { error } = await signInOAuth(provider, loginDest);
    if (error) {
      // 실제 원인(예: "Manual linking is disabled")을 콘솔에 남긴다 — 토스트는 사용자용 일반 문구.
      console.warn('[login] SNS 계속하기 실패:', error);
      setBusy(false);
      toast.error(t('auth.linkError'));
      return;
    }
    // 에러가 없으면 곧 프로바이더로 떠난다. 그런데 '곧' 이 보장되지는 않는다 —
    // 팝업 차단·리다이렉트 누락이면 화면은 그대로인데 버튼만 영영 비활성으로 남는다.
    // 안전망으로 되살린다(정상 경로에서는 그 전에 페이지가 사라져 실행되지 않는다).
    armBusyRelease();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!email.trim() || !password) {
      toast.error(t('login.needFields'));
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        const { error, reason } = await signInWithEmail(email.trim(), password);
        if (error) {
          toast.error(t(SIGN_IN_ERROR_KEY[reason ?? 'unknown']));
          setBusy(false);
          return;
        }
        await afterAuth(loginDest);
      } else {
        const { error, reason, needsConfirmation } = await signUpWithEmail(email.trim(), password, nickname);
        if (error) {
          // 원인별 안내 — 이미 가입된 이메일은 재시도 대신 로그인 탭으로 유도한다.
          if (reason === 'email_exists') {
            toast.error(t('login.signupEmailExists'));
            setMode('login');
          } else if (reason === 'weak_password') {
            toast.error(t('login.signupWeakPassword'));
          } else {
            toast.error(t('login.signupError'));
          }
          setBusy(false);
          return;
        }
        if (needsConfirmation) {
          toast.success(t('login.confirmSent'));
          setMode('login');
          setBusy(false);
          return;
        }
        await afterAuth(signUpDest);
      }
    } catch {
      // 여기까지 왔다면 던져진 예외(네트워크·라우팅)다 — 자격증명 문제가 아니다.
      // 가입 탭에서 로그인 문구가, 로그인 탭에서 회원가입 문구가 뜨지 않게 모드별로 고른다.
      toast.error(t(mode === 'login' ? 'common.error' : 'login.signupError'));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[100dvh] bg-gradient-to-b from-hanji via-hanji-deep to-sunset-1/20 px-6 relative">
      <div className="absolute top-4 right-4 z-20">
        <LanguageSwitcher />
      </div>

      {/* 은은한 금빛 광원 */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[280px] h-[280px] bg-gold/12 rounded-full blur-[100px] pointer-events-none" />

      <div className="w-full max-w-[380px] z-10">
        <h1 className="text-3xl font-serif font-bold text-muk text-center mb-1">NextSpot</h1>
        <p className="text-sm text-muk-soft text-center mb-8">{t('login.subtitle')}</p>

        {/* 로그인/회원가입 탭 */}
        <div className="flex bg-white border border-line rounded-2xl p-1 mb-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
          {(['login', 'signup'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                // 심사용 계정을 미리 넣어둔 채 가입 탭으로 가면 '이미 가입된 이메일'로 튕긴다 — 비운다.
                if (m === 'signup' && judgeConsole && email === JUDGE_ACCOUNTS[judgeConsole]) setEmail('');
              }}
              className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-colors ${
                mode === m ? 'bg-gold text-white' : 'text-muk-soft hover:text-muk'
              }`}
            >
              {t(m === 'login' ? 'login.tabLogin' : 'login.tabSignup')}
            </button>
          ))}
        </div>

        {/* 공모전 심사용 계정 안내 — 가입 탭에는 필요 없다. 콘솔에서 넘어왔으면 그 콘솔 계정만 보여준다. */}
        {mode === 'login' && (
          <JudgeAccountHint
            only={judgeConsole ?? undefined}
            onFill={(judgeEmail) => {
              setEmail(judgeEmail);
              passwordRef.current?.focus();
            }}
            className="mb-4"
          />
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex items-center gap-2 bg-white border border-line rounded-xl px-3.5 py-3 focus-within:border-gold transition-colors">
            <Mail size={18} className="text-muk-soft shrink-0" />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('login.email')}
              autoComplete="email"
              className="flex-1 bg-transparent outline-none text-muk placeholder:text-muk-soft/70"
            />
          </label>

          <label className="flex items-center gap-2 bg-white border border-line rounded-xl px-3.5 py-3 focus-within:border-gold transition-colors">
            <Lock size={18} className="text-muk-soft shrink-0" />
            <input
              ref={passwordRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('login.password')}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              className="flex-1 bg-transparent outline-none text-muk placeholder:text-muk-soft/70"
            />
          </label>

          {mode === 'signup' && (
            <>
              <label className="flex items-center gap-2 bg-white border border-line rounded-xl px-3.5 py-3 focus-within:border-gold transition-colors">
                <User size={18} className="text-muk-soft shrink-0" />
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder={t('login.nickname')}
                  maxLength={20}
                  className="flex-1 bg-transparent outline-none text-muk placeholder:text-muk-soft/70"
                />
              </label>
              <p className="text-xs text-muk-soft -mt-1 ml-1">{t('login.passwordHint')}</p>
            </>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-2 py-3.5 rounded-xl bg-gold hover:bg-gold-deep disabled:opacity-50 text-white font-bold transition-colors"
          >
            {t(mode === 'login' ? 'login.submitLogin' : 'login.submitSignup')}
          </button>
          {mode === 'login' && (
            <button type="button" onClick={() => router.push('/forgot-password')} className="self-end text-xs text-muk-soft underline hover:text-muk">
              {t('password.forgot')}
            </button>
          )}
        </form>

        {/* 로그인 탭에만: SNS 계속하기(카카오/구글) — signInOAuth(계정 전환) 단일 왕복. 위 handleOAuth 주석 참조. */}
        {mode === 'login' && (
          <>
            <div className="flex items-center gap-3 my-5">
              <span className="h-px flex-1 bg-line" />
              <span className="text-xs text-muk-soft">{t('login.or')}</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => handleOAuth('kakao')}
                className="flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm bg-[#FEE500] text-[#191600] hover:brightness-95 transition-all disabled:opacity-50"
              >
                {t('auth.continueKakao')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => handleOAuth('google')}
                className="flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm bg-white text-muk border border-line hover:bg-hanji-deep transition-all disabled:opacity-50"
              >
                {t('auth.continueGoogle')}
              </button>
            </div>
          </>
        )}

        {/* 게스트 둘러보기 — 익명 세션 유지, 무마찰 흐름(/setup).
            ⚠️ 이 앱의 핵심 원칙은 '관광객 무마찰'이고 발표 대본(DEMO_SCENARIO "로그인 절차 없이")과
            JUDGE_QA Q10 이 이 경로를 전제한다. 회색 각주로 묻으면 로그인이 사실상 강제된다 —
            테두리 있는 실제 버튼으로 유지할 것. */}
        <div className="mt-5 pt-5 border-t border-line">
          <button
            type="button"
            onClick={() => router.push('/setup')}
            className="w-full py-3 rounded-xl border border-line bg-white text-muk font-bold text-sm hover:bg-hanji-deep transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            {t('login.guest')}
          </button>
          <p className="mt-2 text-xs text-muk-soft text-center">{t('login.guestHint')}</p>
        </div>
      </div>
    </div>
  );
}

// Suspense 래핑 — useSearchParams(?next= 읽기)는 클라이언트 전용 훅이라 정적 export
// (output:'export') 빌드에서 CSR bailout 을 피하려면 반드시 Suspense 경계 안에 있어야 한다.
// 없으면 `next build` 가 /login 프리렌더 단계에서 통째로 실패한다 — 배포가 아예 안 나간다
// (course·explore/recommend 페이지와 동일 관례).
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-hanji" />}>
      <LoginForm />
    </Suspense>
  );
}
