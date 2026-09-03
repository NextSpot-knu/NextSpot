'use client';

// 사장님 콘솔 입구 — 역할·소유권 기반 진입(RBAC P2).
//
// 예전에는 번들에 박힌 비밀번호 게이트를 통과하면 **전체 시설 1,600곳** 중 아무거나 골라
// 그 가게의 좌석 상태를 방송할 수 있었다. 이제 진입은 users.role='merchant' 로,
// 다룰 수 있는 가게는 facility_owners 로 정해진다. 여기서 보여주는 목록은
// GET /api/v1/account/me 가 내려준 **내 소유 가게뿐**이다.
//
// 프런트 분기는 UX 일 뿐이고 보안 경계는 백엔드다 — 이 화면을 우회해 dashboard 로 직접 가도
// 모든 API 가 403 을 돌려준다(app/core/authz.py).

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Store, ChevronRight, Loader2, LogOut, Clock, ShieldAlert } from 'lucide-react';
import { createPublicClient } from '@/lib/supabase';
import { useT } from '@/lib/i18n/I18nProvider';
import { useAccount, canEnterMerchantConsole, type OwnedFacility } from '@/lib/account';
import {
  saveMerchantFacility,
  getMerchantFacility,
  type MerchantFacility,
} from '../../lib/merchant/localState';

const TYPE_LABEL: Record<string, string> = {
  restaurant: '음식점',
  cafe: '카페',
  attraction: '관광지',
  culture: '문화시설',
};

export default function MerchantGatePage() {
  const router = useRouter();
  const t = useT();
  const { account, status } = useAccount();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // 소유 가게가 하나면 고를 이유가 없다 — 바로 대시보드로 보낸다.
  useEffect(() => {
    if (status !== 'ready' || !canEnterMerchantConsole(account)) return;
    const owned = account?.ownedFacilities ?? [];
    if (owned.length !== 1) return;
    saveMerchantFacility(toStored(owned[0]));
    router.replace('/merchant/dashboard');
  }, [status, account, router]);

  // 나가기는 관광객 앱으로 — **히스토리 기반 back 은 콘솔을 나가지 못한다**.
  // 가게를 여러 곳 둘러봤으면 게이트↔대시보드가 히스토리에 쌓여 있어 직전에 보던 가게로
  // 되짚어 갈 뿐이다. 개발자 콘솔(/dev)·관제 사이드바처럼 목적지를 못박는다.
  // replace 가 아니라 push 인 이유: 나가기도 정상 이동이라, 뒤로가기로 콘솔에 되돌아오는 편이 자연스럽다.
  const leave = () => router.push('/main');

  if (!mounted || status === 'loading') {
    return (
      <Shell>
        <div className="flex items-center justify-center gap-2 py-10 text-muk-soft">
          <Loader2 className="animate-spin" size={20} />
        </div>
      </Shell>
    );
  }

  // 1) 세션 없음 → 로그인으로.
  if (!account) {
    return (
      <Shell onLeave={leave}>
        <Card
          icon={<ShieldAlert size={22} className="text-gold-deep" />}
          title={t('merchantGate.needLoginTitle')}
          desc={t('merchantGate.needLoginDesc')}
          action={{
            label: t('landing.ctaLogin'),
            onClick: () => router.push('/login?next=/merchant'),
          }}
        />
      </Shell>
    );
  }

  // 2) 일반 유저·관리자 → 진입 불가. **관리자도 tourist 와 동일하게 취급한다**
  //    (관제 대시보드와 사장님 콘솔은 완전히 분리 — '관리자 열람 모드' 예외를 두지 않는다).
  if (!canEnterMerchantConsole(account)) {
    const canApply = !account.isAnonymous && account.role === 'tourist';
    return (
      <Shell onLeave={leave}>
        <Card
          icon={<ShieldAlert size={22} className="text-gold-deep" />}
          title={t('merchantGate.notMerchantTitle')}
          desc={t('merchantGate.notMerchantDesc')}
          action={
            canApply
              ? {
                  label: t('account.businessTitle'),
                  onClick: () => router.push('/account/business'),
                }
              : undefined
          }
        />
      </Shell>
    );
  }

  const owned = account.ownedFacilities;
  const isDeveloper = account.role === 'developer';

  // 3) 사업자인데 아직 연결된 가게가 없음 → 인증 대기.
  //    개발자는 소유권을 우회하므로 이 화면에 갇히면 안 된다 — 아래 전체 가게 선택으로 보낸다.
  if (owned.length === 0 && !isDeveloper) {
    return (
      <Shell onLeave={leave}>
        <Card
          icon={<Clock size={22} className="text-gold-deep" />}
          title={t('merchantGate.noStoreTitle')}
          desc={t('merchantGate.noStoreDesc')}
          action={{
            label: t('account.businessTitle'),
            onClick: () => router.push('/account/business'),
          }}
        />
      </Shell>
    );
  }

  // 4) 여러 가게 → **내 가게만** 나열한 피커(일반 사장님에게 전체 시설 검색은 없앴다).
  //    개발자만 예외로 전체 가게를 검색할 수 있다(운영 지원). 서버도 developer 만 소유권을 우회한다.
  const last = getMerchantFacility();
  return (
    <Shell onLeave={leave}>
      <div className="rounded-3xl border border-line bg-white p-6 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
        <p className="mb-4 text-sm font-semibold text-muk">
          {owned.length > 0 ? t('merchantGate.pickStore') : t('merchantGate.developerPickAny')}
        </p>
        <div className="flex flex-col gap-2">
          {owned.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                saveMerchantFacility(toStored(f));
                router.push('/merchant/dashboard');
              }}
              className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 ${
                last?.id === f.id ? 'border-gold bg-gold/10' : 'border-line hover:bg-hanji'
              }`}
            >
              <span>
                <span className="block text-sm font-semibold text-muk">{f.name}</span>
                <span className="block text-[11px] text-muk-soft">
                  {TYPE_LABEL[f.type] || f.type}
                </span>
              </span>
              <ChevronRight size={16} className="text-muk-soft" />
            </button>
          ))}
        </div>
        {isDeveloper && (
          <>
            <p className="mt-4 rounded-xl border border-jade/30 bg-jade/10 px-3 py-2 text-[11px] text-muk-soft">
              {t('merchantGate.developerNote')}
            </p>
            <DeveloperFacilityPicker
              onPick={(f) => {
                saveMerchantFacility(f);
                router.push('/merchant/dashboard');
              }}
            />
          </>
        )}
      </div>
    </Shell>
  );
}

// 개발자 전용 가게 선택 — anon RLS 로 공개 시설 목록을 조회한다.
// 일반 사장님 경로에는 없다(예전에 남의 가게를 고를 수 있던 원인이 바로 이 전체 목록이었다).
//
// 개편 전 콘솔처럼 **전체 목록을 훑을 수 있어야** 한다는 요청(2026-08-28)으로 검색 전용에서
// 브라우징으로 바꿨다. 다만 시설이 1,600곳이라 통째로 뿌리면 못 쓴다 — 종류 필터와
// 페이지 단위 로드를 함께 둔다. 검색어는 이제 '좁히기'이고, 비워 두면 전체가 나온다.
const PAGE_SIZE = 30;
const DEV_TYPES = ['restaurant', 'cafe', 'attraction', 'culture'] as const;

function DeveloperFacilityPicker({ onPick }: { onPick: (f: MerchantFacility) => void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [type, setType] = useState<string | null>(null);
  const [rows, setRows] = useState<MerchantFacility[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);

  // 필터가 바뀌면 첫 페이지부터 다시 — 안 그러면 이전 조건의 페이지가 이어 붙는다.
  useEffect(() => {
    setPage(0);
  }, [q, type]);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    const term = q.trim();
    const timer = setTimeout(async () => {
      try {
        let query = createPublicClient()
          .from('facilities')
          .select('id, name, type', { count: 'exact' })
          .order('name')
          .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
        if (term) query = query.ilike('name', `%${term}%`);
        if (type) query = query.eq('type', type);
        const { data, count } = await query;
        if (!alive) return;
        const mapped = (data ?? []).map((r) => ({
          id: String(r.id),
          name: String(r.name ?? ''),
          type: String(r.type ?? ''),
          couponRate: 0,
        }));
        // 첫 페이지는 갈아끼우고, 이후 페이지는 이어 붙인다.
        setRows((prev) => (page === 0 ? mapped : [...prev, ...mapped]));
        setTotal(typeof count === 'number' ? count : null);
      } catch {
        if (alive && page === 0) {
          setRows([]);
          setTotal(null);
        }
      } finally {
        if (alive) setBusy(false);
      }
    }, term ? 300 : 0);   // 타이핑 중에만 디바운스 — 필터·페이지는 즉시.
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, type, page]);

  const hasMore = total !== null && rows.length < total;

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <label htmlFor="dev-facility-q" className="text-xs font-semibold text-muk-soft">
          {t('merchantGate.developerSearch')}
        </label>
        {total !== null && (
          <span className="text-[11px] tabular-nums text-muk-soft">
            {t('merchantGate.developerCount').replace('{count}', String(total))}
          </span>
        )}
      </div>

      <input
        id="dev-facility-q"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('merchantGate.developerSearchHint')}
        className="w-full rounded-xl border border-line bg-hanji px-3.5 py-2.5 text-sm focus:border-gold/70 focus:outline-none"
      />

      <div className="mt-2 flex flex-wrap gap-1.5">
        {[null, ...DEV_TYPES].map((tp) => {
          const on = type === tp;
          return (
            <button
              key={tp ?? 'all'}
              type="button"
              onClick={() => setType(tp)}
              aria-pressed={on}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                on ? 'border-gold bg-gold/10 text-gold-deep' : 'border-line text-muk-soft hover:bg-hanji'
              }`}
            >
              {tp === null ? t('merchantGate.developerAllTypes') : TYPE_LABEL[tp] || tp}
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex max-h-72 flex-col gap-1.5 overflow-y-auto">
        {rows.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => onPick(f)}
            className="flex min-h-10 items-center justify-between rounded-lg border border-line px-3 py-2 text-left text-sm hover:bg-hanji"
          >
            <span className="truncate">{f.name}</span>
            <span className="ml-2 shrink-0 text-[11px] text-muk-soft">
              {TYPE_LABEL[f.type] || f.type}
            </span>
          </button>
        ))}

        {hasMore && (
          <button
            type="button"
            onClick={() => setPage((n) => n + 1)}
            disabled={busy}
            className="min-h-10 rounded-lg border border-dashed border-line px-3 py-2 text-xs font-semibold text-muk-soft hover:bg-hanji disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="mx-auto animate-spin" /> : t('merchantGate.developerMore')}
          </button>
        )}

        {!busy && rows.length === 0 && (
          <p className="py-3 text-center text-xs text-muk-soft">{t('merchantGate.developerEmpty')}</p>
        )}
      </div>
    </div>
  );
}

function toStored(f: OwnedFacility) {
  // 대시보드는 기존 계약(couponRate 포함)을 그대로 쓴다. 쿠폰율은 대시보드가 서버에서 받으므로
  // 여기서는 0 으로 두고 이름·종류만 넘긴다(가게 전환 시 화면 라벨용).
  return { id: f.id, name: f.name, type: f.type, couponRate: 0 };
}

function Shell({ children, onLeave }: { children: React.ReactNode; onLeave?: () => void }) {
  const t = useT();
  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center bg-hanji px-5 py-10 font-sans">
      <div className="w-full max-w-md">
        {onLeave && (
          <div className="mb-4">
            <button
              type="button"
              onClick={onLeave}
              className="-ml-1 inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-muk-soft transition-colors hover:bg-white hover:text-muk focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
            >
              <LogOut size={16} /> {t('merchantGate.leave')}
            </button>
          </div>
        )}
        <div className="mb-8 flex flex-col items-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-gold/30 bg-gold/15 text-gold-deep">
            <Store size={26} />
          </div>
          <h1 className="font-serif text-2xl font-bold tracking-tight text-muk">
            {t('merchantGate.title')}
          </h1>
          <p className="mt-1 text-sm text-muk-soft">{t('merchantGate.subtitle')}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function Card({
  icon,
  title,
  desc,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="rounded-3xl border border-line bg-white p-6 text-center shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
      <div className="mx-auto mb-2 w-fit">{icon}</div>
      <p className="font-bold text-muk">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-muk-soft">{desc}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-4 w-full rounded-xl bg-gradient-to-r from-gold to-terracotta py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
