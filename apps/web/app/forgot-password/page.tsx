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
    if (!email.trim() || busy) return;
    setBusy(true);
    const { error } = await requestPasswordReset(email.trim());
    setBusy(false);
    if (error) {
      toast.error(t('password.requestFailed'));
      return;
    }
    setSent(true);
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
          <div className="rounded-2xl border border-jade/30 bg-jade/10 p-5 text-sm leading-relaxed">
            {t('password.requestSent')}
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <label className="flex items-center gap-2 rounded-xl border border-line bg-white px-3.5 py-3 focus-within:border-gold">
              <Mail size={18} className="shrink-0 text-muk-soft" />
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder={t('login.email')} autoComplete="email" className="min-w-0 flex-1 bg-transparent outline-none" />
            </label>
            <button type="submit" disabled={busy || !email.trim()} className="w-full rounded-xl bg-gold py-3.5 font-bold text-white disabled:opacity-50">
              {busy ? t('common.loading') : t('password.requestSubmit')}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
