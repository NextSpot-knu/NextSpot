'use client';

// 사업자 인증 요청 — 오프라인 인증(담당자가 실물 증거 확인)의 '기록' 부분.
//
// 실제 확인은 사람이 하되, 누가 어떤 가게를 요청했는지는 시스템이 큐로 받는다. 승인 한 번으로
// 역할 임명 + 가게 소유권 부여가 처리되고 감사 이력이 붙는다(백엔드 /api/v1/dev).
//
// 증빙 정책: **확인이 끝나면 보관하지 않는다.** 승인·거절 어느 쪽이든 결정과 같은 호출에서
// 서류 경로와 사업자번호 뒤 4자리를 지운다. 전체 번호는 어느 시점에도 저장하지 않으므로
// 이 화면에서도 받지 않는다.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Store, Clock, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { useT } from '@/lib/i18n/I18nProvider';
import { useAccount, canEnterMerchantConsole } from '@/lib/account';

interface RequestRow {
  id: string;
  storeName: string;
  facilityId: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  reviewNote: string | null;
}

export default function BusinessVerificationPage() {
  const router = useRouter();
  const t = useT();
  const { account, status: accountStatus, refresh } = useAccount();

  const [storeName, setStoreName] = useState('');
  const [contact, setContact] = useState('');
  const [last4, setLast4] = useState('');
  const [busy, setBusy] = useState(false);
  const [latest, setLatest] = useState<RequestRow | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiClient.get('/api/v1/account/verification-requests/mine');
        if (!alive) return;
        const items: RequestRow[] = Array.isArray(res?.items) ? res.items : [];
        // 목록은 최신순이다 — 가장 최근 건의 상태만 보여준다.
        setLatest(items[0] ?? null);
      } catch {
        // 조회 실패는 폼을 막지 않는다(제출은 서버가 중복을 걸러낸다).
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!storeName.trim() || !contact.trim()) return;
    setBusy(true);
    try {
      const created = await apiClient.post('/api/v1/account/verification-requests', {
        storeName: storeName.trim(),
        contact: contact.trim(),
        businessNumberLast4: last4.trim() || null,
      });
      setLatest(created as RequestRow);
      void refresh(); // pendingVerification 반영
    } catch (err) {
      toast.error(errorMessage(err) || t('account.submitFailed'));
    } finally {
      setBusy(false);
    }
  };

  // 게스트는 신청할 수 없다 — 승인 대상을 특정할 수 없고, 단말을 지우면 권한이 사라진다.
  const isGuest = !account || account.isAnonymous;

  return (
    <main className="min-h-screen bg-hanji text-muk px-5 py-7 font-sans">
      <div className="mx-auto max-w-md">
        <header className="mb-6 flex items-center gap-2">
          <button
            type="button"
            onClick={() => router.back()}
            aria-label={t('common.back')}
            className="rounded-xl border border-line bg-white p-2.5"
          >
            <ArrowLeft size={18} />
          </button>
          <h1 className="font-serif text-xl font-bold tracking-tight">{t('account.businessTitle')}</h1>
        </header>

        <div className="mb-5 flex items-start gap-3 rounded-2xl border border-gold/30 bg-gold/10 p-4">
          <Store size={20} className="mt-0.5 shrink-0 text-gold-deep" />
          <p className="text-xs leading-relaxed text-muk-soft">{t('account.businessDesc')}</p>
        </div>

        {/* 이미 사장님이면 폼 대신 콘솔로 안내한다. */}
        {canEnterMerchantConsole(account) ? (
          <div className="rounded-3xl border border-line bg-white p-6 text-center">
            <Check size={22} className="mx-auto mb-2 text-jade" />
            <p className="font-bold">{t('account.approvedTitle')}</p>
            <p className="mt-1 text-xs text-muk-soft">{t('account.approvedDesc')}</p>
            <button
              type="button"
              onClick={() => router.push('/merchant')}
              className="mt-4 w-full rounded-xl bg-gradient-to-r from-gold to-terracotta py-3 text-sm font-semibold text-white"
            >
              {t('account.goConsole')}
            </button>
          </div>
        ) : isGuest && accountStatus !== 'loading' ? (
          <div className="rounded-3xl border border-line bg-white p-6 text-center">
            <p className="text-sm font-semibold">{t('account.needAccount')}</p>
            <button
              type="button"
              onClick={() => router.push('/login?next=/account/business')}
              className="mt-4 w-full rounded-xl bg-gradient-to-r from-gold to-terracotta py-3 text-sm font-semibold text-white"
            >
              {t('landing.ctaLogin')}
            </button>
          </div>
        ) : loaded && latest?.status === 'pending' ? (
          <div className="rounded-3xl border border-line bg-white p-6 text-center">
            <Clock size={22} className="mx-auto mb-2 text-gold-deep" />
            <p className="font-bold">{t('account.pendingTitle')}</p>
            <p className="mt-1 text-xs text-muk-soft">{t('account.pendingDesc')}</p>
            <p className="mt-3 text-sm font-semibold">{latest.storeName}</p>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4 rounded-3xl border border-line bg-white p-6">
            {loaded && latest?.status === 'rejected' && (
              <div className="flex items-start gap-2 rounded-xl border border-terracotta/30 bg-terracotta/10 p-3">
                <X size={16} className="mt-0.5 shrink-0 text-terracotta" />
                <div>
                  <p className="text-xs font-bold text-terracotta">{t('account.rejectedTitle')}</p>
                  {latest.reviewNote && (
                    <p className="mt-0.5 text-xs text-muk-soft">{latest.reviewNote}</p>
                  )}
                </div>
              </div>
            )}

            <div>
              <label htmlFor="store-name" className="mb-1.5 block text-xs font-semibold text-muk-soft">
                {t('account.storeName')}
              </label>
              <input
                id="store-name"
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                required
                maxLength={200}
                className="w-full rounded-xl border border-line bg-hanji px-3.5 py-3 text-sm focus:border-gold/70 focus:outline-none focus:ring-2 focus:ring-gold/40"
              />
              <p className="mt-1 text-[11px] text-muk-soft">{t('account.storeNameHint')}</p>
            </div>

            <div>
              <label htmlFor="contact" className="mb-1.5 block text-xs font-semibold text-muk-soft">
                {t('account.contact')}
              </label>
              <input
                id="contact"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                required
                maxLength={200}
                className="w-full rounded-xl border border-line bg-hanji px-3.5 py-3 text-sm focus:border-gold/70 focus:outline-none focus:ring-2 focus:ring-gold/40"
              />
              <p className="mt-1 text-[11px] text-muk-soft">{t('account.contactHint')}</p>
            </div>

            <div>
              <label htmlFor="biz-last4" className="mb-1.5 block text-xs font-semibold text-muk-soft">
                {t('account.bizLast4')}
              </label>
              <input
                id="biz-last4"
                value={last4}
                onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                inputMode="numeric"
                maxLength={4}
                className="w-32 rounded-xl border border-line bg-hanji px-3.5 py-3 text-sm tracking-widest focus:border-gold/70 focus:outline-none focus:ring-2 focus:ring-gold/40"
              />
            </div>

            <p className="text-[11px] leading-relaxed text-muk-soft">{t('account.docNotice')}</p>

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-gradient-to-r from-gold to-terracotta py-3.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? t('account.submitting') : t('account.submit')}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
