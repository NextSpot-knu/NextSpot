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

import React, { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Store, ChevronRight, Loader2, LogOut, Clock, ShieldAlert } from 'lucide-react';
import { createPublicClient } from '@/lib/supabase';
import { escapeLikeTerm } from '@/lib/facilitySearch';
import { useT } from '@/lib/i18n/I18nProvider';
import { useAccount, canEnterMerchantConsole, type OwnedFacility } from '@/lib/account';
import { JudgeAccountHint } from '@/components/JudgeAccountHint';
import {
  saveMerchantFacility,
  getMerchantFacility,
  type MerchantFacility,
} from '../../lib/merchant/localState';
import { MerchantConsole } from '@/components/merchant/MerchantConsole';
import { isDemoParam } from '@/lib/demoFixtures';

const TYPE_LABEL: Record<string, string> = {
  restaurant: '음식점',
  cafe: '카페',
  attraction: '관광지',
  culture: '문화시설',
};

// 라우트 진입점 — `?demo=1` 이면 게이트(계정 판정) 자체를 건너뛰고 읽기 전용 데모 콘솔을 그린다.
// 게이트 컴포넌트를 아예 렌더하지 않으므로 useAccount 기반 분기·리다이렉트도 돌지 않는다.
export default function MerchantEntryPage() {
  return (
    <Suspense fallback={<div className="min-h-screen w-full bg-hanji" />}>
      <MerchantEntry />
    </Suspense>
  );
}

function MerchantEntry() {
  const demo = isDemoParam(useSearchParams().get('demo'));
  if (demo) return <MerchantConsole demo />;
  return <MerchantGatePage />;
}

function MerchantGatePage() {
  const router = useRouter();
  const t = useT();
  const { account, status, unreachable, refresh } = useAccount();
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

  // 0) 서버에 닿지 못했다 → '로그인 필요'가 아니다. 세션은 그대로일 수 있으니 다시 묻는 길만 준다
  //    (로그인을 다시 시키면 같은 장애 창 안에서 같은 화면으로 되돌아온다 — 2026-09-22 실측).
  if (!account && unreachable) {
    return (
      <Shell onLeave={leave}>
        <Card
          icon={<ShieldAlert size={22} className="text-gold-deep" />}
          title={t('merchantGate.serverTitle')}
          desc={t('merchantGate.serverDesc')}
          action={{ label: t('common.retry'), onClick: () => void refresh() }}
          secondary={{ label: t('demo.enter'), onClick: () => router.push('/merchant?demo=1') }}
        />
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
          secondary={{ label: t('demo.enter'), onClick: () => router.push('/merchant?demo=1') }}
        />
        <JudgeAccountHint only="merchant" className="mt-4" />
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
              : {
                  // 게스트(익명 세션)와 관리자 계정은 신청 대상이 아니라 버튼이 없었고, 이 화면이 막다른
                  // 길이었다. '바로 시작'으로 들어온 심사위원이 정확히 이 경로다 — 로그인으로 보낸다.
                  // 이미 로그인한 관리자 계정에게 '로그인'은 세션이 끊긴 것처럼 읽혀 '다른 계정으로'라고 쓴다.
                  label: account.isAnonymous ? t('login.submitLogin') : t('judgeAccount.switchAccount'),
                  onClick: () => router.push('/login?next=/merchant'),
                }
          }
          secondary={{ label: t('demo.enter'), onClick: () => router.push('/merchant?demo=1') }}
        />
        <JudgeAccountHint only="merchant" className="mt-4" />
        {/* 가입한 관광객 계정이면 카드 버튼이 '사업자 인증'이라 계정을 바꿀 길이 따로 필요하다. */}
        {canApply && (
          <button
            type="button"
            onClick={() => router.push('/login?next=/merchant')}
            className="mt-3 flex min-h-10 w-full items-center justify-center rounded-xl text-sm font-medium text-muk-soft underline transition-colors hover:text-muk focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
          >
            {t('judgeAccount.switchAccount')}
          </button>
        )}
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
          secondary={{ label: t('demo.enter'), onClick: () => router.push('/merchant?demo=1') }}
        />
      </Shell>
    );
  }

  // 4) 여러 가게 → **내 가게만** 나열한 피커(일반 사장님에게 전체 시설 검색은 없앴다).
  //    개발자만 예외로 전체 가게를 검색할 수 있다(운영 지원). 서버도 developer 만 소유권을 우회한다.
  const last = getMerchantFacility();
  return (
    <Shell onLeave={leave}>
      <div className="toss-surface rounded-3xl border border-line bg-white p-6">
        <p className="mb-4 text-base font-bold text-muk">
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
              className={`toss-pressable flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 ${
                last?.id === f.id ? 'border-gold bg-gold/10' : 'border-line hover:bg-hanji'
              }`}
            >
              <span className="flex items-center gap-3">
                {/* 가게 아바타 — 목록이 텍스트만일 때보다 행 단위 스캔이 빨라진다(마지막 선택 가게는 금색). */}
                <span
                  className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border ${
                    last?.id === f.id
                      ? 'border-gold/40 bg-gold/15 text-gold-deep'
                      : 'border-line bg-hanji text-muk-soft'
                  }`}
                >
                  <Store size={18} />
                </span>
                <span>
                  <span className="block text-[15px] font-bold text-muk">{f.name}</span>
                  <span className="block text-[13px] text-muk-soft">
                    {TYPE_LABEL[f.type] || f.type}
                  </span>
                </span>
              </span>
              <ChevronRight size={18} className="flex-shrink-0 text-muk-soft" />
            </button>
          ))}
        </div>
        {isDeveloper && (
          <>
            <p className="mt-4 rounded-xl border border-jade/30 bg-jade/10 px-3 py-2 text-[13px] text-muk-soft">
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
  // 조회 자체가 실패했는가. '결과 없음' 과 반드시 구분한다 — 같은 저장소의 lib/facilitySearch.ts
  // 가 같은 이유로 failed 플래그를 둔다(그쪽 주석에 사고 사례가 적혀 있다).
  // 예전에는 실패해도 rows=[] 만 남아 화면이 "조건에 맞는 가게가 없어요" 라고 말했다.
  const [failed, setFailed] = useState(false);
  // 사람이 눌러 다시 조회하기 위한 토큰(자동 무한 재시도가 아니다).
  const [reloadToken, setReloadToken] = useState(0);

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
        // LIKE 메타문자를 값으로 되돌린다 — 안 하면 사용자가 친 '%'·'_' 가 와일드카드가 되어
        // 엉뚱한 가게가 딸려 온다(lib/facilitySearch.ts 가 같은 이유로 같은 헬퍼를 쓴다).
        if (term) query = query.ilike('name', `%${escapeLikeTerm(term)}%`);
        if (type) query = query.eq('type', type);
        // supabase-js 는 쿼리 오류를 **던지지 않고** error 로 돌려준다 — 이걸 읽지 않으면
        // try/catch 가 있어도 실패가 조용히 '결과 0건' 이 된다(원래 버그의 절반이 이것이었다).
        const { data, count, error } = await query;
        if (!alive) return;
        if (error) throw error;
        const mapped = (data ?? []).map((r) => ({
          id: String(r.id),
          name: String(r.name ?? ''),
          type: String(r.type ?? ''),
          couponRate: 0,
        }));
        // 첫 페이지는 갈아끼우고, 이후 페이지는 이어 붙인다.
        setRows((prev) => (page === 0 ? mapped : [...prev, ...mapped]));
        setTotal(typeof count === 'number' ? count : null);
        setFailed(false);
      } catch {
        if (!alive) return;
        setFailed(true);
        // 이어붙이기(page>0) 실패는 이미 받아 둔 목록을 지우지 않는다 — 보이던 가게가 사라지면
        // 그것대로 '없어졌다' 는 거짓말이 된다.
        if (page === 0) {
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
  }, [q, type, page, reloadToken]);

  // 총 건수를 못 받은(실패한) 상태에서 '더 보기' 를 권하지 않는다.
  const hasMore = !failed && total !== null && rows.length < total;

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <label htmlFor="dev-facility-q" className="text-[13px] font-semibold text-muk-soft">
          {t('merchantGate.developerSearch')}
        </label>
        {total !== null && (
          <span className="text-[13px] tabular-nums text-muk-soft">
            {t('merchantGate.developerCount').replace('{count}', String(total))}
          </span>
        )}
      </div>

      <input
        id="dev-facility-q"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('merchantGate.developerSearchHint')}
        className="min-h-11 w-full rounded-xl border border-line bg-hanji px-3.5 py-2.5 text-sm text-muk placeholder:text-muk-soft/70 focus:border-gold/70 focus:outline-none"
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
              className={`min-h-9 rounded-full border px-3 py-1.5 text-[13px] font-semibold transition-colors ${
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
            className="flex min-h-11 items-center justify-between rounded-lg border border-line px-3 py-2 text-left text-sm text-muk hover:bg-hanji"
          >
            <span className="truncate">{f.name}</span>
            <span className="ml-2 shrink-0 text-[13px] text-muk-soft">
              {TYPE_LABEL[f.type] || f.type}
            </span>
          </button>
        ))}

        {hasMore && (
          <button
            type="button"
            onClick={() => setPage((n) => n + 1)}
            disabled={busy}
            className="min-h-11 rounded-lg border border-dashed border-line px-3 py-2 text-[13px] font-semibold text-muk-soft hover:bg-hanji disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="mx-auto animate-spin" /> : t('merchantGate.developerMore')}
          </button>
        )}

        {/* 실패와 '결과 없음' 은 다른 말을 한다. 실패에는 다시 시도할 길을 붙인다. */}
        {!busy && failed && (
          <div className="flex flex-col items-center gap-2 py-3">
            <p className="text-center text-[13px] text-terracotta">{t('common.error')}</p>
            <button
              type="button"
              onClick={() => setReloadToken((n) => n + 1)}
              className="min-h-10 rounded-lg border border-line px-3.5 py-1.5 text-[13px] font-semibold text-muk hover:bg-hanji focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
            >
              {t('common.retry')}
            </button>
          </div>
        )}

        {!busy && !failed && rows.length === 0 && (
          <p className="py-3 text-center text-[13px] text-muk-soft">{t('merchantGate.developerEmpty')}</p>
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
              className="-ml-1 inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muk-soft transition-colors hover:bg-white hover:text-muk focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
            >
              <LogOut size={16} /> {t('merchantGate.leave')}
            </button>
          </div>
        )}
        {/* 브랜드 헤더 — 금→주칠 그라데이션 심볼 + 서비스 라벨 칩 + 큰 제목.
            콘솔 첫인상이 '전문 B2B 도구' 로 읽히도록 위계를 칩(무엇) → 제목(어디) 순서로 세운다. */}
        <div className="mb-8 flex flex-col items-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-gold to-terracotta text-white shadow-lg shadow-terracotta/20">
            <Store size={30} />
          </div>
          <span className="mb-2 rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-[13px] font-bold tracking-tight text-gold-deep">
            {t('merchantGate.subtitle')}
          </span>
          <h1 className="font-serif text-[26px] font-bold tracking-tight text-muk">
            {t('merchantGate.title')}
          </h1>
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
  secondary,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  action?: { label: string; onClick: () => void };
  /** 보조 행동(테두리 버튼) — 지금은 '데모로 둘러보기' 가 여기 들어간다. */
  secondary?: { label: string; onClick: () => void };
}) {
  return (
    <div className="toss-surface rounded-3xl border border-line bg-white p-7 text-center">
      {/* 아이콘을 원판 위에 올려 상태(안내·대기)가 한눈에 잡히게 한다 — 고령 사용자 가독 우선. */}
      <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-gold/25 bg-gold/10">
        {icon}
      </div>
      <p className="text-lg font-bold text-muk">{title}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-muk-soft">{desc}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="toss-pressable mt-5 flex min-h-12 w-full items-center justify-center rounded-xl bg-gradient-to-r from-gold to-terracotta text-[15px] font-bold text-white shadow-md shadow-terracotta/20 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
        >
          {action.label}
        </button>
      )}
      {secondary && (
        <button
          type="button"
          onClick={secondary.onClick}
          className="toss-pressable mt-2.5 flex min-h-12 w-full items-center justify-center rounded-xl border border-line bg-white text-[15px] font-bold text-muk transition-colors hover:bg-hanji focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
        >
          {secondary.label}
        </button>
      )}
    </div>
  );
}
