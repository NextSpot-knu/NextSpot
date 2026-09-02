'use client';

// 계정 역할 변경 신청 — 오프라인 확인(담당자가 실물 증거·소속 확인)의 '기록' 부분.
//
// 원래 사업자 인증 전용 화면이었다. 신청할 수 있는 역할이 둘(사업자·관리자)로 늘면서
// 화면을 하나로 합쳤다 — 큐도, 심사 화면도, 감사 로그도 이미 공용이라 화면만 나누면
// 사용자가 어느 문으로 들어가야 하는지 매번 골라야 한다.
//
// 실제 확인은 사람이 하되, 누가 무엇을 요청했는지는 시스템이 큐로 받는다. 승인 한 번으로
// 역할 임명(+사업자면 가게 소유권 부여)이 처리되고 감사 이력이 붙는다(백엔드 /api/v1/dev).
//
// developer 는 신청 대상이 아니다 — 팀 내부 권한이라 /dev 콘솔에서 직접 임명한다.
//
// 증빙 정책: **확인이 끝나면 보관하지 않는다.** 승인·거절 어느 쪽이든 결정과 같은 호출에서
// 서류 경로와 사업자번호 뒤 4자리를 지운다. 전체 번호는 어느 시점에도 저장하지 않으므로
// 이 화면에서도 받지 않는다.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MYPAGE_BACK } from '@/lib/navigation';
import { ArrowLeft, Store, Clock, Check, X, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { useT } from '@/lib/i18n/I18nProvider';
import { useAccount, canEnterMerchantConsole, canEnterAdminConsole } from '@/lib/account';

/** 신청 가능한 역할. 백엔드 REQUESTABLE_ROLES 와 같은 집합이어야 한다. */
type RequestableRole = 'merchant' | 'admin';

interface RequestRow {
  id: string;
  storeName: string;
  facilityId: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  reviewNote: string | null;
  /** 컬럼이 없는 DB(마이그레이션 미적용)에서는 undefined → merchant 로 읽는다. */
  requestedRole?: RequestableRole;
}

export default function RoleChangeRequestPage() {
  const router = useRouter();
  const t = useT();
  const { account, status: accountStatus, refresh } = useAccount();

  const [requestedRole, setRequestedRole] = useState<RequestableRole>('merchant');
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

  const isMerchantRequest = requestedRole === 'merchant';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!storeName.trim() || !contact.trim()) return;
    setBusy(true);
    try {
      const created = await apiClient.post('/api/v1/account/verification-requests', {
        storeName: storeName.trim(),
        contact: contact.trim(),
        // 사업자번호는 사업자 신청에만 의미가 있다 — 관리자 신청에서는 보내지 않는다.
        businessNumberLast4: isMerchantRequest ? last4.trim() || null : null,
        requestedRole,
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
  // 이미 그 권한이 있으면 폼 대신 콘솔로 안내한다. **선택한 역할 기준**으로 판정한다 —
  // 사장님이 관리자 권한을 신청하는 경우가 있어, 역할과 무관하게 막으면 길이 없다.
  const alreadyHasRole = isMerchantRequest
    ? canEnterMerchantConsole(account)
    : canEnterAdminConsole(account);

  const roleOptions: { key: RequestableRole; label: string; desc: string; Icon: typeof Store }[] = [
    {
      key: 'merchant',
      label: t('account.roleMerchant'),
      desc: t('account.roleMerchantDesc'),
      Icon: Store,
    },
    {
      key: 'admin',
      label: t('account.roleAdmin'),
      desc: t('account.roleAdminDesc'),
      Icon: ShieldCheck,
    },
  ];

  return (
    <main className="min-h-screen bg-hanji text-muk px-5 py-7 font-sans">
      <div className="mx-auto max-w-md">
        <header className="mb-6 flex items-center gap-2">
          <button
            type="button"
            // 목적지를 못박는다 — 딥링크·새로고침이면 back() 은 죽는다(MYPAGE_BACK 주석).
            onClick={() => router.push(MYPAGE_BACK)}
            aria-label={t('common.back')}
            className="rounded-xl border border-line bg-white p-2.5"
          >
            <ArrowLeft size={18} />
          </button>
          <h1 className="font-serif text-xl font-bold tracking-tight">
            {t('account.roleRequestTitle')}
          </h1>
        </header>

        <div className="mb-5 flex items-start gap-3 rounded-2xl border border-gold/30 bg-gold/10 p-4">
          {isMerchantRequest ? (
            <Store size={20} className="mt-0.5 shrink-0 text-gold-deep" />
          ) : (
            <ShieldCheck size={20} className="mt-0.5 shrink-0 text-gold-deep" />
          )}
          <p className="text-xs leading-relaxed text-muk-soft">
            {isMerchantRequest ? t('account.businessDesc') : t('account.adminDesc')}
          </p>
        </div>

        {/* 역할 선택은 어느 분기에서도 보인다 — '이미 사장님'이어도 관리자 권한은 신청할 수 있다. */}
        <fieldset className="mb-5">
          <legend className="mb-2 text-xs font-semibold text-muk-soft">
            {t('account.roleLabel')}
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {roleOptions.map(({ key, label, desc, Icon }) => {
              const selected = requestedRole === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setRequestedRole(key)}
                  className={`rounded-2xl border p-3.5 text-left transition-colors ${
                    selected
                      ? 'border-gold bg-gold/10'
                      : 'border-line bg-white hover:border-gold/40'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-sm font-bold">
                    <Icon size={16} className={selected ? 'text-gold-deep' : 'text-muk-soft'} />
                    {label}
                  </span>
                  <span className="mt-1 block text-[11px] leading-snug text-muk-soft">{desc}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {alreadyHasRole ? (
          <div className="rounded-3xl border border-line bg-white p-6 text-center">
            <Check size={22} className="mx-auto mb-2 text-jade" />
            <p className="font-bold">
              {isMerchantRequest ? t('account.approvedTitle') : t('account.adminApprovedTitle')}
            </p>
            <p className="mt-1 text-xs text-muk-soft">
              {isMerchantRequest ? t('account.approvedDesc') : t('account.adminApprovedDesc')}
            </p>
            <button
              type="button"
              onClick={() => router.push(isMerchantRequest ? '/merchant' : '/admin/dashboard')}
              className="mt-4 w-full rounded-xl bg-gradient-to-r from-gold to-terracotta py-3 text-sm font-semibold text-white"
            >
              {isMerchantRequest ? t('account.goConsole') : t('account.goAdminConsole')}
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
            <p className="mt-3 text-sm font-semibold">
              {latest.requestedRole === 'admin'
                ? `${t('account.roleAdmin')} · ${latest.storeName}`
                : latest.storeName}
            </p>
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
                {isMerchantRequest ? t('account.storeName') : t('account.orgName')}
              </label>
              <input
                id="store-name"
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                required
                maxLength={200}
                className="w-full rounded-xl border border-line bg-hanji px-3.5 py-3 text-sm focus:border-gold/70 focus:outline-none focus:ring-2 focus:ring-gold/40"
              />
              <p className="mt-1 text-[11px] text-muk-soft">
                {isMerchantRequest ? t('account.storeNameHint') : t('account.orgNameHint')}
              </p>
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

            {/* 사업자등록번호는 사업자 신청에만 묻는다 — 관리자 신청에는 해당 사항이 없다. */}
            {isMerchantRequest && (
              <>
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
              </>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-gradient-to-r from-gold to-terracotta py-3.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? t('account.submitting') : t('account.roleSubmit')}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
