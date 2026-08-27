'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';
import { toast } from 'sonner';
import { createPublicClient } from '@/lib/supabase';
import { updatePassword } from '@/lib/auth';
import { useT } from '@/lib/i18n/I18nProvider';

export default function ResetPasswordPage() {
  const router = useRouter();
  const t = useT();
  const [ready, setReady] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = createPublicClient();
    let alive = true;
    const timer = setTimeout(() => { if (alive && !ready) setInvalid(true); }, 8000);
    void supabase.auth.getSession().then(({ data }) => {
      if (alive && data.session && !data.session.user.is_anonymous) setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (alive && session && !session.user.is_anonymous && (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN')) setReady(true);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      data.subscription.unsubscribe();
    };
  }, [ready]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || password.length < 8 || password !== confirm) {
      toast.error(t(password !== confirm ? 'password.mismatch' : 'password.tooShort'));
      return;
    }
    setBusy(true);
    const { error } = await updatePassword(password);
    if (error) {
      setBusy(false);
      toast.error(t('password.updateFailed'));
      return;
    }
    await createPublicClient().auth.signOut({ scope: 'local' });
    toast.success(t('password.updateSuccess'));
    router.replace('/login');
  };

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-b from-hanji via-hanji-deep to-sunset-1/20 px-6 text-muk">
      <div className="w-full max-w-[380px]">
        <h1 className="text-2xl font-bold font-serif">{t('password.updateTitle')}</h1>
        <p className="mt-2 mb-7 text-sm text-muk-soft">{t('password.updateDesc')}</p>
        {!ready ? (
          <div className="rounded-2xl border border-line bg-white p-5 text-sm text-muk-soft">
            {invalid ? t('password.invalidLink') : t('common.loading')}
          </div>
        ) : (
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
