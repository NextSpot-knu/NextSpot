'use client';

// 앱 자체 회원(이메일/비밀번호) 로그인/회원가입 — docs/AUTH_MEMBERSHIP_PLAN.md.
// 랜딩 '바로 시작' → 이 페이지. 게스트 둘러보기(익명 세션)도 유지한다.
// 가입은 현재 익명 세션을 '정회원 전환'해 저장·취향 데이터를 승계한다(lib/auth signUpWithEmail).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Mail, Lock, User } from 'lucide-react';
import { signInWithEmail, signUpWithEmail, linkOAuth, type OAuthProvider } from '@/lib/auth';
import { reconcileUserData } from '@/lib/userData';
import { syncSaved } from '@/lib/savedFacilities';
import { createPublicClient } from '@/lib/supabase';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useT } from '@/lib/i18n/I18nProvider';

type Mode = 'login' | 'signup';

export default function LoginPage() {
  const router = useRouter();
  const t = useT();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);

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
    router.push(dest);
  };

  // SNS 계속하기 — linkOAuth(회원가입/로그인 통합, 콜백에서 자동 분기). 성공 시 프로바이더로 리다이렉트.
  const handleOAuth = async (provider: OAuthProvider) => {
    if (busy) return;
    setBusy(true);
    const { error } = await linkOAuth(provider, '/main');
    if (error) {
      // 실제 원인(예: "Manual linking is disabled")을 콘솔에 남긴다 — 토스트는 사용자용 일반 문구.
      console.warn('[login] SNS 계속하기 실패:', error);
      setBusy(false);
      toast.error(t('auth.linkError'));
    }
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
        const { error } = await signInWithEmail(email.trim(), password);
        if (error) {
          toast.error(t('login.loginError'));
          setBusy(false);
          return;
        }
        await afterAuth('/main');
      } else {
        const { error, needsConfirmation } = await signUpWithEmail(email.trim(), password, nickname);
        if (error) {
          toast.error(t('login.signupError'));
          setBusy(false);
          return;
        }
        if (needsConfirmation) {
          toast.success(t('login.confirmSent'));
          setMode('login');
          setBusy(false);
          return;
        }
        await afterAuth('/setup');
      }
    } catch {
      toast.error(t('login.signupError'));
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
              onClick={() => setMode(m)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-colors ${
                mode === m ? 'bg-gold text-white' : 'text-muk-soft hover:text-muk'
              }`}
            >
              {t(m === 'login' ? 'login.tabLogin' : 'login.tabSignup')}
            </button>
          ))}
        </div>

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
        </form>

        {/* 로그인 탭에만: SNS 계속하기(카카오/구글) — 회원가입/로그인 통합(linkOAuth). */}
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
