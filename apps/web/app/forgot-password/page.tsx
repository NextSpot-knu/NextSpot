'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { requestPasswordReset } from '@/lib/auth';
import { useT } from '@/lib/i18n/I18nProvider';

export default function ForgotPasswordPage() {
  const router = useRouter();
  const t = useT();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    // 빈 값·형식 오류는 input 의 type="email" + required 가 브라우저 기본 안내로 막는다
    // (전용 i18n 키 없이도 사용자 언어로 뜬다). 여기까지 왔는데 비어 있으면 조용히 무시.
    if (!email.trim()) return;
    setBusy(true);
    try {
      const { error } = await requestPasswordReset(email.trim());
      if (error) {
        toast.error(t('password.requestFailed'));
        return;
      }
      setSent(true);
    } finally {
      // 무슨 일이 있어도 버튼은 되살린다 — 여기서 걸리면 재설정 자체가 막힌다.
      setBusy(false);
    }
  };

  return (
    <main className="min-h-[100dvh] bg-gradient-to-b from-hanji via-hanji-deep to-sunset-1/20 px-6 py-8 text-muk">
      <div className="mx-auto w-full max-w-[380px]">
        <button type="button" onClick={() => router.push('/login')} aria-label={t('common.back')} className="mb-8 rounded-xl border border-line bg-white p-2.5 text-muk-soft">
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-2xl font-bold font-serif">{t('password.requestTitle')}</h1>
        <p className="mt-2 mb-7 text-sm text-muk-soft">{t('password.requestDesc')}</p>
        {sent ? (
          <div className="space-y-3">
            <div className="rounded-2xl border border-jade/30 bg-jade/10 p-5 text-sm leading-relaxed">
              {t('password.requestSent')}
            </div>
            {/* 메일을 기다리는 동안에도 앞으로 갈 길을 남긴다. */}
            <button
              type="button"
              onClick={() => router.push('/login')}
              className="w-full rounded-xl border border-line bg-white py-3 text-sm font-bold text-muk transition-colors hover:bg-hanji-deep"
            >
              {t('login.tabLogin')}
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <label className="flex items-center gap-2 rounded-xl border border-line bg-white px-3.5 py-3 focus-within:border-gold">
              <Mail size={18} className="shrink-0 text-muk-soft" />
              {/* required: 빈 값·형식 오류를 브라우저 기본 안내로 잡는다 — 버튼을 죽여 놓으면
                  왜 눌리지 않는지 아무도 모른다. */}
              <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder={t('login.email')} autoComplete="email" className="min-w-0 flex-1 bg-transparent outline-none" />
            </label>
            <button type="submit" disabled={busy} className="w-full rounded-xl bg-gold py-3.5 font-bold text-white disabled:opacity-50">
              {busy ? t('common.loading') : t('password.requestSubmit')}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
