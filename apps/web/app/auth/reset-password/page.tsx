'use client';

// 새 비밀번호 설정 — 재설정 메일 링크의 종착지.
//
// 이 화면이 열리는 정상 경로는 하나뿐이다:
//   /forgot-password → 메일 → /auth/callback?next=/auth/reset-password (PKCE 교환) → 여기.
// 콜백이 교환을 끝내면서 복구 표식을 남기므로, 이 화면은 **표식**(또는 URL 의 복구 토큰)으로
// 폼을 연다. 예전에는 '익명이 아닌 세션이 있으면' 으로 판단해서 두 가지가 깨져 있었다
// (2026-09-20 배포본 실측):
//   · 이미 로그인한 사람이 주소만 쳐도 비밀번호 변경 폼이 그대로 떴다.
//   · 로그아웃 상태로 만료된 링크를 타면 8초 스피너 뒤에 "링크가 만료…" 만 남고 끝이었다 —
//     메일을 다시 받을 버튼도, 로그인으로 돌아갈 길도 없었다.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';
import { toast } from 'sonner';
import { createPublicClient } from '@/lib/supabase';
import { clearPasswordRecoveryMark, hasPasswordRecoveryMark, updatePassword } from '@/lib/auth';
import { isPasswordRecoveryEntry } from '@/lib/oauthFlow';
import { useT } from '@/lib/i18n/I18nProvider';

/** 복구 세션이 성립하기를 기다리는 한도. 넘으면 '링크가 만료됐다' 로 안내한다. */
const SESSION_WAIT_MS = 8000;

type Phase = 'checking' | 'ready' | 'invalid';

export default function ResetPasswordPage() {
  const router = useRouter();
  const t = useT();
  const [phase, setPhase] = useState<Phase>('checking');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  // 효과 안에서 현재 단계를 읽되, 단계가 바뀔 때마다 구독을 다시 걸지는 않는다
  // (예전 코드는 deps 에 ready 가 들어 있어 준비되는 순간 리스너를 통째로 재설치했다).
  const phaseRef = useRef<Phase>('checking');
  const settle = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  useEffect(() => {
    // 복구 흐름으로 들어왔다는 증거가 없으면 기다릴 이유가 없다 — 곧바로 안내한다.
    // (8초를 기다려 봐야 결론은 같고, 그 8초 동안 사용자는 될 줄 알고 기다린다.)
    const entered = isPasswordRecoveryEntry({
      search: window.location.search,
      hash: window.location.hash,
      marker: hasPasswordRecoveryMark(),
    });

    let alive = true;
    // 증거가 없으면 기다림 없이(다음 틱) 안내한다 — 8초를 기다려도 결론은 같은데,
    // 그동안 사용자는 될 줄 알고 기다린다.
    const timer = setTimeout(() => {
      if (alive && phaseRef.current === 'checking') settle('invalid');
    }, entered ? SESSION_WAIT_MS : 0);
    if (!entered) {
      return () => {
        alive = false;
        clearTimeout(timer);
      };
    }

    const supabase = createPublicClient();
    const accept = (isAnonymous: boolean | undefined) => {
      if (!alive || phaseRef.current !== 'checking') return;
      if (isAnonymous === false) settle('ready');
    };

    void supabase.auth.getSession().then(({ data }) => accept(data.session?.user.is_anonymous));
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN' || event === 'USER_UPDATED' || event === 'TOKEN_REFRESHED') {
        accept(session?.user.is_anonymous);
      }
    });

    return () => {
      alive = false;
      clearTimeout(timer);
      data.subscription.unsubscribe();
    };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    // 입력 문제는 입력 문제로만 말한다(예전에는 busy 중 클릭까지 '비밀번호 불일치' 로 읽혔다).
    if (password !== confirm) {
      toast.error(t('password.mismatch'));
      return;
    }
    if (password.length < 8) {
      toast.error(t('password.tooShort'));
      return;
    }
    setBusy(true);
    const { error, reason } = await updatePassword(password);
    if (error) {
      setBusy(false);
      if (reason === 'expired_link') {
        // 이 화면에서 다시 눌러도 영원히 실패한다 — 메일을 다시 받는 쪽으로 화면을 바꾼다.
        clearPasswordRecoveryMark();
        settle('invalid');
        toast.error(t('password.invalidLink'));
        return;
      }
      toast.error(t(reason === 'weak_password' ? 'password.tooShort' : 'password.updateFailed'));
      return;
    }
    clearPasswordRecoveryMark();
    await createPublicClient().auth.signOut({ scope: 'local' });
    toast.success(t('password.updateSuccess'));
    router.replace('/login');
  };

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-b from-hanji via-hanji-deep to-sunset-1/20 px-6 text-muk">
      <div className="w-full max-w-[380px]">
        <h1 className="text-2xl font-bold font-serif">{t('password.updateTitle')}</h1>
        <p className="mt-2 mb-7 text-sm text-muk-soft">{t('password.updateDesc')}</p>
        {phase === 'checking' && (
          <div className="rounded-2xl border border-line bg-white p-5 text-sm text-muk-soft">{t('common.loading')}</div>
        )}
        {phase === 'invalid' && (
          // 막다른 길을 만들지 않는다 — 여기서 메일을 다시 받거나 로그인으로 돌아갈 수 있어야 한다.
          <div className="space-y-3">
            <div className="rounded-2xl border border-line bg-white p-5 text-sm leading-relaxed text-muk-soft">
              {t('password.invalidLink')}
            </div>
            <button
              type="button"
              onClick={() => router.replace('/forgot-password')}
              className="w-full rounded-xl bg-gold py-3.5 font-bold text-white transition-colors hover:bg-gold-deep"
            >
              {t('password.requestSubmit')}
            </button>
            <button
              type="button"
              onClick={() => router.replace('/login')}
              className="w-full rounded-xl border border-line bg-white py-3 text-sm font-bold text-muk transition-colors hover:bg-hanji-deep"
            >
              {t('login.tabLogin')}
            </button>
          </div>
        )}
        {phase === 'ready' && (
          <form onSubmit={submit} className="space-y-3">
            {[{ value: password, set: setPassword, placeholder: t('password.newPassword') }, { value: confirm, set: setConfirm, placeholder: t('password.confirmPassword') }].map((field) => (
              <label key={field.placeholder} className="flex items-center gap-2 rounded-xl border border-line bg-white px-3.5 py-3 focus-within:border-gold">
                <Lock size={18} className="shrink-0 text-muk-soft" />
                <input type="password" value={field.value} onChange={(event) => field.set(event.target.value)} placeholder={field.placeholder} autoComplete="new-password" className="min-w-0 flex-1 bg-transparent outline-none" />
              </label>
            ))}
            <button type="submit" disabled={busy} className="w-full rounded-xl bg-gold py-3.5 font-bold text-white disabled:opacity-50">
              {busy ? t('common.loading') : t('password.updateSubmit')}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
