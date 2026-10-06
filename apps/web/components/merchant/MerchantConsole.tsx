'use client';

// 내 가게 대시보드(머천트 콘솔) — 4섹션: ① 예상 혼잡 ② 성적표 ③ 셀프 타임세일 ④ 좌석 상태 방송.
//
// 이 파일은 원래 app/merchant/dashboard/page.tsx 였다. `?demo=1`(로그인 없는 읽기 전용 데모)이
// **같은 화면**을 보여 줘야 해서 컴포넌트로 내렸다 — Next 앱 라우터의 page.tsx 는 default 말고
// 다른 이름을 내보낼 수 없으므로, 두 라우트가 한 구현을 공유하려면 컴포넌트 파일이어야 한다.
//   · /merchant/dashboard  → 로그인 + 소유권 판정 후 실데이터
//   · /merchant?demo=1     → 판정 없이 lib/demoFixtures.ts 고정값
// ⚠️ demo=true 인 동안 이 파일의 어떤 경로도 fetch/supabase 를 부르지 않는다(조회도 쓰기도 없다).
//    쓰기 버튼은 그대로 눌리되 "저장되지 않아요" 토스트만 띄운다 — 실 DB 는 절대 건드리지 않는다.
// 모바일 우선 · 한지(라이트) 팔레트. 각 섹션은 독립적으로 로딩/에러를 관리한다 — 백엔드 신규
// 엔드포인트(/api/v1/merchant/*)가 아직 배포되지 않았거나 마이그레이션 미적용이어도, 다른 섹션은
// 정상 동작하고 실패한 섹션만 "우아한 폴백"(재시도 버튼)으로 저하된다(무한 스켈레톤 금지).
// ① 예상 혼잡만은 예외로 실패해도 같은 업종의 요일·시간대 패턴 곡선으로 그린다(항상 보인다).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Loader2,
  RefreshCw,
  ChevronLeft,
  Ticket,
  MessageCircleWarning,
  ThumbsUp,
  Eye,
  Zap,
  Timer,
  X as XIcon,
  CircleCheck,
  CircleDot,
  CircleX,
  PowerOff,
  LogIn,
  LogOut,
  Navigation,
  ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { createPublicClient } from '@/lib/supabase';
import {
  getMerchantFacility,
  clearMerchantFacility,
  clearLegacyMerchantSession,
  type MerchantFacility,
} from '@/lib/merchant/localState';
import { useAccount, canEnterMerchantConsole } from '@/lib/account';
import {
  fetchMerchantStats,
  fetchActiveTimesales,
  createTimesale,
  cancelTimesale,
  updateSeatStatus,
  clearSeatStatus,
  fetchFacilityCongestionForecast,
  fetchMerchantBriefing,
  forecastNote,
  patternForecastPoints,
  timesaleConfirmPreview,
  timesalePublishNotice,
  timesaleRateHint,
  hasTimesaleOverlapNotice,
  MerchantApiError,
  TIMESALE_RATE_OPTIONS,
  type FacilityForecast,
  type MerchantStats,
  type MerchantTimesale,
  type SeatLevel,
} from '@/lib/merchant/api';
import { bestQuietHour, quietHourCopy } from '@/lib/merchant/forecastInsight';
import { FIRST_TIMESALE_PROMPT, scorecardIsEmpty, scorecardTiles, type ScorecardTileKey } from '@/lib/merchant/scorecard';
import { PREDICTED_BADGE } from '@/lib/adminPredictedView';

import { useT } from '@/lib/i18n/I18nProvider';
import {
  DEMO_MERCHANT_FACILITY,
  DEMO_MERCHANT_SEAT,
  DEMO_MERCHANT_SEAT_BY_HOUR,
  DEMO_MERCHANT_STATS,
  DEMO_MERCHANT_TODAY,
  DEMO_MERCHANT_WEEKLY,
  demoActiveTimesale,
  demoMerchantForecast,
} from '@/lib/demoFixtures';

const TYPE_LABEL: Record<string, string> = {
  restaurant: '음식점',
  cafe: '카페',
  attraction: '관광지',
  culture: '문화시설',
};

type AsyncState = 'loading' | 'ready' | 'error';

// 콘솔 토스트는 화면 위 가운데에 띄운다 — 전역 토스터(아래 가운데)는 ④ 좌석 버튼과 휴대폰 하단 바로 가기
// 바를 4초 동안 덮었다(방금 누른 버튼의 결과가 그 버튼을 가린다).
const TOAST_TOP = { position: 'top-center' } as const;

/** 데모의 쓰기 버튼 안내 — 공용 데모 토스트와 같은 문구, 콘솔 토스트와 같은 자리. */
function useConsoleDemoToast() {
  const t = useT();
  return () => {
    toast(t('demo.noSave'), TOAST_TOP);
  };
}

/** 콘솔 안의 다른 섹션(③ 타임세일 · ④ 좌석)으로 데려간다.
 *  넓은 화면에서는 ③④ 가 오른쪽 열에 이미 보이므로 화면을 크게 움직이지 않고(nearest) 잠깐 테를 둘러 알려 준다. */
function goToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const wide = typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;
  el.scrollIntoView({ behavior: 'smooth', block: wide ? 'nearest' : 'start' });
  el.classList.add('ring-2', 'ring-gold');
  window.setTimeout(() => el.classList.remove('ring-2', 'ring-gold'), 1400);
}

export function MerchantConsole({ demo = false }: { demo?: boolean }) {
  const router = useRouter();
  const t = useT();
  const { account, status } = useAccount();
  const [mounted, setMounted] = useState(false);
  // 데모는 고를 가게가 없다 — 고정 가게로 바로 시작한다(로컬 저장소도 읽지 않는다).
  const [facility, setFacility] = useState<MerchantFacility | null>(demo ? DEMO_MERCHANT_FACILITY : null);

  useEffect(() => {
    setMounted(true);
    if (demo) return; // 데모는 로컬 세션 흔적조차 건드리지 않는다.
    clearLegacyMerchantSession(); // 구 비밀번호 세션 흔적 제거(권한과 무관한 잔재).
  }, [demo]);

  // 권한·소유권 판정은 /account/me 가 단일 출처다. 여기 분기는 UX 이고, 실제 차단은
  // 백엔드가 매 요청 수행한다 — 이 화면을 우회해도 모든 머천트 API 가 403 을 돌려준다.
  useEffect(() => {
    if (demo) return; // 데모: 계정·소유권 판정 없음 → 게이트로 되돌리는 리다이렉트도 없다.
    if (status === 'loading') return;
    if (!canEnterMerchantConsole(account)) {
      router.replace('/merchant');
      return;
    }
    const fac = getMerchantFacility();
    // 저장된 가게가 없거나, **더 이상 내 소유가 아니면** 게이트로 되돌린다
    // (소유권이 회수된 뒤 로컬에 남은 값으로 계속 들어오는 것을 막는다).
    const owned = account?.ownedFacilities ?? [];
    const stillMine =
      account?.role === 'developer' || owned.some((f) => f.id === fac?.id);
    if (!fac || !stillMine) {
      clearMerchantFacility();
      router.replace('/merchant');
      return;
    }
    setFacility(fac);
  }, [demo, status, account, router]);

  const handleChangeFacility = () => {
    clearMerchantFacility();
    router.push('/merchant');
  };

  if (!mounted || !facility) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-hanji text-muk-soft">
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-hanji font-sans pb-16">
      {/* 콘솔 톱바 — 흰 서페이스 위에 가게 이름을 주인공으로 세운다(종류는 금색 칩).
          좌우 조작은 모두 44px 급 버튼으로 — 스크린샷·고령 사용자 모두에서 '전문 도구' 로 읽히게.
          데모 표시는 떠다니는 배지 대신 이 톱바 안의 '예시 화면' 칩 하나다(sticky 라 스크롤해도 남는다).
          넓은 화면에서는 왼쪽에 NextSpot 로고와 '사장님 콘솔' 을 세워 어느 화면인지부터 읽히게 한다(I40). */}
      <header className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-line px-3 py-2.5">
        <div className="mx-auto flex max-w-6xl flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          {/* 데모에서도 목적지는 콘솔 홈(/merchant) 이다 — 게이트에 로그인·데모·심사 계정 안내가 모여 있다.
              앱으로 나가는 길은 오른쪽 '나가기' 가 따로 맡는다. */}
          <div className="flex flex-shrink-0 items-center gap-2.5">
            <button
              onClick={() => router.push('/merchant')}
              aria-label="사장님 콘솔 홈으로"
              className="toss-pressable flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-line bg-white text-muk-soft hover:bg-hanji hover:text-muk transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
            >
              <ChevronLeft size={20} aria-hidden="true" />
            </button>
            {/* 휴대폰 폭에서는 가게 이름이 눌리지 않게 감춘다(그 폭의 순서·모양은 그대로). */}
            <span className="hidden items-end gap-2 sm:flex">
              {/* eslint-disable-next-line @next/next/no-img-element -- 정적 export, public 자산 직접 참조 */}
              <img src="/nextspot-logo.png" alt="NextSpot" className="h-6 w-auto" />
              <span className="pb-px text-[15px] font-bold leading-none text-muk">사장님 콘솔</span>
            </span>
          </div>
          <div className="min-w-0 text-center">
            <p className="truncate text-[15px] font-bold font-serif text-muk">{facility.name}</p>
            <div className="mt-0.5 flex items-center justify-center gap-1.5">
              <span className="rounded-full border border-gold/30 bg-gold/10 px-2 py-px text-[13px] font-semibold leading-5 text-gold-deep">
                {TYPE_LABEL[facility.type] || facility.type}
              </span>
              {demo && (
                <span className="rounded-full border border-muk/20 bg-muk px-2 py-px text-[13px] font-bold leading-5 text-hanji">
                  {t('demo.sampleChip')}
                </span>
              )}
            </div>
          </div>
          {/* 오른쪽은 '가게 변경'(콘솔 안에서 대상 바꾸기)과 '나가기'(콘솔 밖으로) 둘이다.
              여기 나가기가 없던 동안 대시보드에서 앱으로 돌아갈 길은 게이트를 한 번 거치는
              것뿐이었다 — 하단 내비도 /merchant 경로에서는 숨겨진다(BottomNav 의 allowlist).
              목적지를 못박는 이유는 게이트의 leave 주석 참조(히스토리 back 은 못 나간다). */}
          <div className="flex flex-shrink-0 items-center gap-1.5">
            {/* 넓은 화면에서는 실제 계정으로 넘어가는 길도 이 줄에 둔다 — 톱바를 한 줄로 유지해 ③④ 가 첫 화면에 들어오게. */}
            {demo && (
              <button
                onClick={() => router.push('/merchant')}
                className="toss-pressable hidden min-h-11 items-center gap-1.5 rounded-xl border border-gold/40 bg-gold/10 px-3 text-[13px] font-semibold text-gold-deep hover:bg-gold/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 lg:flex"
              >
                <LogIn size={14} aria-hidden="true" /> {t('demo.realLogin')}
              </button>
            )}
            {/* 데모에는 고를 다른 가게가 없다 — 버튼 자체를 감춘다(눌러도 할 일이 없는 버튼을 두지 않는다). */}
            {!demo && <button
              onClick={handleChangeFacility}
              className="toss-pressable min-h-11 rounded-xl border border-line bg-white px-3 text-[13px] font-semibold text-muk hover:bg-hanji transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
            >
              가게 변경
            </button>}
            <button
              onClick={() => router.push('/main')}
              aria-label="관광객 앱으로 나가기"
              className="toss-pressable flex min-h-11 items-center gap-1 rounded-xl border border-line bg-white px-3 text-[13px] font-semibold text-muk-soft hover:bg-hanji hover:text-muk transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
            >
              <LogOut size={14} aria-hidden="true" /> 나가기
            </button>
          </div>
        </div>
        {/* 데모에서 실제 계정으로 넘어가는 길 — 위 줄에 끼워 넣으면 390px 에서 가게 이름이 눌린다(넓은 화면은 위 줄). */}
        {demo && (
          <button
            onClick={() => router.push('/merchant')}
            className="toss-pressable flex min-h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-gold/40 bg-gold/10 px-3 text-[13px] font-semibold text-gold-deep hover:bg-gold/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 lg:hidden"
          >
            <LogIn size={14} aria-hidden="true" /> {t('demo.realLogin')}
          </button>
        )}
        </div>
      </header>

      {/* 1024px 이상은 두 열 — 왼쪽은 읽을 것(브리핑·① 예상 혼잡·② 성적표), 오른쪽은 할 일(③ 타임세일·④ 좌석 방송).
          예전에는 640px 한 줄이라 심사위원이 눌러 볼 ③④ 가 세 화면 아래였다(PE10). 오른쪽 열은 화면에 붙어 있고,
          화면보다 길면 그 열만 스크롤한다 — 왼쪽을 읽는 동안에도 두 행동이 늘 보인다.
          휴대폰 순서는 그대로이고, 대신 아래쪽에 ③④ 로 바로 가는 고정 바가 있다. */}
      <main className="mx-auto max-w-2xl px-4 py-6 pb-28 lg:grid lg:max-w-6xl lg:grid-cols-2 lg:items-start lg:gap-5 lg:pb-6 lg:pt-4">
        <div className="flex flex-col gap-5">
          {/* key=시설 id — 가게가 바뀌면 카드 상태(이전 가게 브리핑)를 통째로 리셋한다 */}
          <BriefingCard key={facility.id} facilityId={facility.id} demo={demo} />
          {demo && <DemoTodaySummary />}
          <ForecastSection facilityId={facility.id} facilityType={facility.type} demo={demo} />
          <StatsSection facilityId={facility.id} demo={demo} />
          {demo && <DemoWeeklyTrend />}
        </div>
        <div
          data-testid="merchant-actions"
          className="mt-5 flex flex-col gap-5 lg:sticky lg:top-[4.75rem] lg:mt-0 lg:max-h-[calc(100dvh-5.5rem)] lg:overflow-y-auto lg:rounded-3xl"
        >
          <TimesaleSection
            facilityId={facility.id}
            demo={demo}
            demoCouponRate={demo ? DEMO_MERCHANT_FACILITY.couponRate : null}
          />
          <SeatStatusSection facilityId={facility.id} demo={demo} />
        </div>
      </main>

      {/* 휴대폰 하단 바로 가기 — ③④ 는 화면 아래쪽에 있어서, 들어오자마자 두 행동이 있다는 걸 먼저 보여 준다(P10). */}
      <nav
        aria-label="사장님 바로 가기"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white/95 px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur lg:hidden"
      >
        <div className="mx-auto grid max-w-2xl grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => goToSection('merchant-timesale')}
            className="toss-pressable flex min-h-12 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-gold-deep to-terracotta px-3 text-[15px] font-bold text-white shadow-md shadow-terracotta/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
          >
            ⚡ 타임세일 발행
          </button>
          <button
            type="button"
            onClick={() => goToSection('merchant-seat')}
            className="toss-pressable flex min-h-12 items-center justify-center gap-1.5 rounded-xl border-2 border-muk bg-white px-3 text-[15px] font-bold text-muk focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
          >
            🪑 좌석 상태 방송
          </button>
        </div>
      </nav>
    </div>
  );
}

// =========================================================================
// 공용 UI 조각
// =========================================================================

function SectionCard({
  id,
  badge,
  title,
  tag,
  honestNote,
  children,
}: {
  /** 콘솔 안 다른 곳에서 이 섹션으로 스크롤해 올 때의 앵커(예: ① 콜아웃 → ③). */
  id?: string;
  badge: string;
  title: string;
  /** 제목 옆 작은 칩(예: ① 의 '예측'). */
  tag?: string;
  honestNote?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="toss-surface bg-white border border-line rounded-3xl p-5 lg:p-4 scroll-mt-28">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="flex-shrink-0 px-2.5 py-0.5 rounded-full text-[13px] font-bold border bg-gold/15 text-gold-deep border-gold/30">
            {badge}
          </span>
          <h2 className="text-[17px] font-bold font-serif text-muk">{title}</h2>
          {tag && (
            <span className="flex-shrink-0 rounded-full border border-violet-400/50 bg-violet-500/10 px-2 py-px text-[13px] font-bold text-violet-700">
              {tag}
            </span>
          )}
        </div>
      </div>
      {honestNote && <p className="text-[13px] text-muk-soft mb-3 leading-relaxed">{honestNote}</p>}
      {children}
    </section>
  );
}

function ErrorFallback({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-8">
      <p className="text-sm text-terracotta text-center leading-relaxed">{message}</p>
      <button
        onClick={onRetry}
        className="toss-pressable flex min-h-11 items-center gap-2 px-5 py-2 rounded-xl border border-line bg-white text-muk text-sm font-semibold hover:bg-hanji transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
      >
        <RefreshCw size={14} aria-hidden="true" /> 다시 시도
      </button>
    </div>
  );
}

function SkeletonBlock({ heightClass = 'h-24' }: { heightClass?: string }) {
  return <div className={`w-full ${heightClass} rounded-xl bg-hanji-deep animate-pulse`} />;
}

// =========================================================================
// AI 브리핑 카드(P1-5) — GET /api/v1/merchant/briefing 후행(비차단) fetch.
// 예측 섹션 렌더를 막지 않는 독립 카드다: 로딩 중·실패·briefing=null 이면 아무것도 렌더하지
// 않는다(스켈레톤·에러 UI 없음 — LLM 은 항상 '보조'라 없어도 대시보드는 완전하다).
// 문구의 모든 수치는 서버가 계산·치환한 값이다(LLM 은 프로즈만) — merchant_briefing_service 참조.
// =========================================================================

function BriefingCard({ facilityId, demo = false }: { facilityId: string; demo?: boolean }) {
  const t = useT();
  const [briefing, setBriefing] = useState<string | null>(null);

  useEffect(() => {
    if (demo) return; // 데모: 서버 브리핑을 부르지 않는다(아래에서 고정 문구를 쓴다).
    let alive = true;
    fetchMerchantBriefing(facilityId)
      .then((data) => {
        if (alive && data && typeof data.briefing === 'string' && data.briefing.trim()) {
          setBriefing(data.briefing);
        }
      })
      .catch(() => {
        /* 실패 시 미렌더 — 브리핑은 부가 기능이라 에러 UI 도 띄우지 않는다 */
      });
    return () => {
      alive = false;
    };
  }, [facilityId, demo]);

  const text = demo ? t('demo.merchantBriefingText') : briefing;
  if (!text) return null;

  // 브리핑은 '오늘 무엇을 할지' 를 알려주는 카드라 일반 섹션보다 반 톤 밝은 금빛 서페이스로 띄운다.
  return (
    <section className="toss-surface bg-gradient-to-br from-gold/10 via-white to-white border border-gold/30 rounded-3xl p-5">
      <div className="flex items-center gap-2 mb-2">
        <span className="flex-shrink-0 px-2.5 py-0.5 rounded-full text-[13px] font-bold border bg-gold/15 text-gold-deep border-gold/30">
          AI 실행 브리핑
        </span>
        <h2 className="text-[17px] font-bold font-serif text-muk">오늘의 실행 브리핑</h2>
      </div>
      <p className="text-[15px] text-muk leading-relaxed">{text}</p>
    </section>
  );
}

// =========================================================================
// ① 시간대별 예상 혼잡 — 앞으로 6시간 곡선. 학습된 모델이 있으면 POST /predict/batch(hours_ahead 0..6)
// 에서 내 시설만 뽑고, 아니면 같은 업종의 요일·시간대 패턴이다(lib/merchant/api.ts 참조).
// 어느 쪽이든 섹션은 **항상** 그려진다 — 어떤 실패도 패턴 곡선으로 내려앉는다(재시도 상자 없음).
// ⚠️ 이 값은 '혼잡도 예측'이다. 방문객 수·유입 인원·매출이 아니다 — 라벨을 그렇게 읽히게 쓰지 말 것.
// =========================================================================

function ForecastSection({
  facilityId,
  facilityType,
  demo = false,
}: {
  facilityId: string;
  facilityType: string;
  demo?: boolean;
}) {
  // 데모: 고정 하루 흐름에서 지금부터 6시간을 즉시 그린다(예측 API 호출 없음).
  const [forecast, setForecast] = useState<FacilityForecast | null>(() =>
    demo ? { points: demoMerchantForecast(), basis: 'model' } : null
  );

  useEffect(() => {
    if (demo) return;
    let alive = true;
    fetchFacilityCongestionForecast(facilityId, facilityType, 6)
      // 계약상 거부하지 않지만, 혹시 던져도 ① 은 비지 않는다.
      .catch((): FacilityForecast => ({ points: patternForecastPoints(facilityType, 6), basis: 'pattern' }))
      .then((data) => {
        if (alive) setForecast(data);
      });
    return () => {
      alive = false;
    };
  }, [facilityId, facilityType, demo]);

  const points = forecast?.points ?? [];
  const chartData = points.map((p) => ({
    label: p.hoursAhead === 0 ? '지금' : `${p.hour}시`,
    hourLabel: p.hoursAhead === 0 ? `지금(${p.hour}시)` : `${p.hour}시`,
    congestion: Math.round(p.congestion * 100),
  }));
  // 곡선을 실제로 그릴 때만 '무엇을 보여주는지' 를 말한다.
  const curveShown = chartData.length > 0;
  const quiet = bestQuietHour(points);
  const quietCopy = quiet ? quietHourCopy(quiet) : null;

  return (
    <SectionCard
      badge="① 예상 혼잡"
      title="시간대별 예상 혼잡"
      tag={PREDICTED_BADGE}
      honestNote={forecastNote({
        curveShown,
        basis: forecast?.basis ?? 'pattern',
        anchored: points.some((p) => p.anchored),
      })}
    >
      {!forecast && <SkeletonBlock heightClass="h-48" />}
      {/* 곡선에서 '그래서 언제?' 를 바로 읽어 준다 — 영업 시간대에 뚜렷이 한가한 때가 있을 때만. */}
      {quietCopy && (
        <div className="mb-3 flex flex-col gap-1 rounded-2xl border border-gold/40 bg-gold/10 px-4 py-3">
          <p className="text-[17px] font-bold text-muk">{quietCopy.title}</p>
          <p className="text-[13px] leading-relaxed text-muk-soft">{quietCopy.body}</p>
          <button
            type="button"
            onClick={() => goToSection('merchant-timesale')}
            className="toss-pressable mt-1 flex min-h-11 items-center gap-1.5 self-start rounded-xl border border-gold/50 bg-white px-3.5 text-[15px] font-bold text-gold-deep transition-colors hover:bg-gold/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
          >
            <Zap size={15} aria-hidden="true" /> 타임세일 열기
          </button>
        </div>
      )}
      {curveShown && (
        <div className="h-48 w-full">
          <ResponsiveContainer width="100%" height="100%">
            {/* 색은 globals.css 토큰(var)만 쓴다 — hex 를 여기 다시 박으면 팔레트 조정 시 이 차트만 뒤처진다.
                축 글자는 13px — 고령 사용자 최소 가독 크기를 차트에도 동일 적용.
                Y축 폭 52 · 왼쪽 여백 0 — 더 좁으면 맨 위 눈금 '100%' 가 '00%' 로 잘린다. */}
            <LineChart data={chartData} margin={{ top: 5, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--nextspot-line)" />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fill: 'var(--nextspot-muk-soft)', fontSize: 13 }}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fill: 'var(--nextspot-muk-soft)', fontSize: 13 }}
                domain={[0, 100]}
                tickFormatter={(v) => `${v}%`}
                width={52}
              />
              <Tooltip
                formatter={(value: unknown) => [`${value}%`, '예상 혼잡도']}
                labelFormatter={(_label, payload) => (payload?.[0]?.payload?.hourLabel ?? '')}
                contentStyle={{
                  borderRadius: '10px',
                  border: '1px solid var(--nextspot-line)',
                  color: 'var(--nextspot-muk)',
                  fontSize: 13,
                }}
              />
              <Line
                type="monotone"
                dataKey="congestion"
                stroke="var(--nextspot-terracotta)"
                strokeWidth={3}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </SectionCard>
  );
}

// =========================================================================
// ② 성적표 — GET /api/v1/merchant/stats (최근 7일)
// =========================================================================

function StatsSection({ facilityId, demo = false }: { facilityId: string; demo?: boolean }) {
  const [state, setState] = useState<AsyncState>('loading');
  const [stats, setStats] = useState<MerchantStats | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const load = useCallback(async () => {
    // 데모: 최근 7일 성적표를 고정값으로 채운다(집계 API 호출 없음).
    if (demo) {
      setStats(DEMO_MERCHANT_STATS);
      setState('ready');
      return;
    }
    setState('loading');
    try {
      const data = await fetchMerchantStats(facilityId);
      setStats(data);
      setState('ready');
    } catch (e) {
      setErrorMessage(e instanceof MerchantApiError ? e.message : '성적표를 다시 불러올게요.');
      setState('error');
    }
  }, [facilityId, demo]);

  useEffect(() => {
    load();
  }, [load]);

  // 모든 항목이 0 이면 숫자 타일 대신 '아직 기록 없음 + 다음 행동'을 보여준다 — 0 만 늘어놓으면
  // 사장님이 "고장났나?" 로 읽는다(감사 P1). 0 이 아닌 숫자만 타일로 세운다(lib/merchant/scorecard.ts, PM 4.18).
  const isEmpty = !!stats && scorecardIsEmpty(stats);
  const card = stats ? scorecardTiles(stats) : null;

  return (
    <SectionCard badge="② 성적표" title={`최근 ${stats?.window_days ?? 7}일 활동`}>
      {state === 'loading' && <SkeletonBlock heightClass="h-32" />}
      {state === 'error' && <ErrorFallback message={errorMessage} onRetry={load} />}
      {state === 'ready' && stats && isEmpty && (
        <div className="flex flex-col gap-3">
          <div className="px-3 py-4 rounded-xl bg-hanji border border-line">
            <p className="text-[15px] font-bold text-muk mb-1">우리 가게 성적표가 여기에 쌓입니다</p>
            <p className="text-[13px] text-muk-soft leading-relaxed">
              손님 추천 노출·길안내·쿠폰 사용이 최근 {stats.window_days}일 기준으로 쌓여요. 아래 두 가지부터
              시작해 보세요.
            </p>
          </div>
          <div className="px-3 py-3 rounded-xl bg-hanji border border-line">
            <p className="text-[13px] font-bold text-muk mb-1.5">이렇게 시작해 보세요</p>
            <ul className="text-[13px] text-muk-soft leading-relaxed list-disc pl-4 flex flex-col gap-1">
              <li>③ 타임세일을 열면 손님 추천에서 우리 가게가 더 잘 보여요.</li>
              <li>④ 좌석 상태를 알리면 30분 동안 손님 추천에 지금 우리 가게 상황이 반영돼요.</li>
            </ul>
          </div>
        </div>
      )}
      {state === 'ready' && card && !isEmpty && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            {card.tiles.map((tile) => (
              <div key={tile.key} className={tile.hero ? 'col-span-2' : undefined}>
                <StatTile icon={STAT_ICONS[tile.key]} label={tile.label} value={tile.value} sub={tile.sub} hero={tile.hero} />
              </div>
            ))}
          </div>
          {/* 쿠폰을 한 번도 안 줬으면 '0 / 0' 타일 대신 다음 행동 한 줄. */}
          {card.showFirstTimesalePrompt && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gold/40 bg-gold/10 px-3.5 py-3">
              <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-muk">{FIRST_TIMESALE_PROMPT}</p>
              <button
                type="button"
                onClick={() => goToSection('merchant-timesale')}
                className="toss-pressable flex min-h-10 items-center gap-1.5 rounded-xl border border-gold/50 bg-white px-3 text-[13px] font-bold text-gold-deep transition-colors hover:bg-gold/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
              >
                <Zap size={14} aria-hidden="true" /> 타임세일 열기
              </button>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}

const STAT_ICONS: Record<ScorecardTileKey, React.ReactNode> = {
  exposed: <Eye size={16} />,
  accepted: <Navigation size={16} />,
  coupons: <Ticket size={16} />,
  reports: <MessageCircleWarning size={16} />,
  arrivals: <CircleCheck size={16} />,
};

function StatTile({
  icon,
  label,
  value,
  sub,
  hero = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  sub?: string;
  /** 두 칸을 쓰는 맨 앞 타일 — 숫자를 한 단계 크게. */
  hero?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 px-3.5 py-3.5 rounded-2xl bg-hanji border border-line">
      <div className="flex items-center gap-1.5">
        {/* 아이콘만 금색으로 — 숫자(먹빛)와 역할이 섞이지 않게 한다. */}
        <span aria-hidden="true" className="flex items-center text-gold-deep">
          {icon}
        </span>
        <span className="text-[13px] font-semibold text-muk-soft">{label}</span>
      </div>
      <span className={`${hero ? 'text-3xl' : 'text-2xl'} font-bold tabular-nums text-muk`}>{value}</span>
      {sub && <span className="text-[13px] text-muk-soft">{sub}</span>}
    </div>
  );
}

// =========================================================================
// ③ 셀프 타임세일 — POST /timesale · GET /timesale · POST /timesale/cancel
// =========================================================================

const RATE_OPTIONS = TIMESALE_RATE_OPTIONS;
// 고른 칩은 꽉 찬 먹색 — 예전의 옅은 금색은 고르지 않은 굵은 검정 칩보다 오히려 약해 보였다(PH10, /setup 과 같은 규칙).
const SELECTED_CHIP = 'border-muk bg-muk text-hanji';
const SelectedMark = () => (
  <span aria-hidden="true" className="mr-1">
    ✓
  </span>
);
const DURATION_OPTIONS = [
  { minutes: 60, label: '1시간' },
  { minutes: 120, label: '2시간' },
  { minutes: 180, label: '3시간' },
] as const;

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return '종료됨';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  if (hours > 0) return `${hours}시간 ${minutes}분 남음`;
  if (minutes > 0) return `${minutes}분 ${seconds}초 남음`;
  return `${seconds}초 남음`;
}

function TimesaleSection({
  facilityId,
  demo = false,
  demoCouponRate = null,
}: {
  facilityId: string;
  demo?: boolean;
  /** 데모 가게의 기본 쿠폰율(데모는 조회하지 않는다). */
  demoCouponRate?: number | null;
}) {
  const demoToast = useConsoleDemoToast();
  const [state, setState] = useState<AsyncState>('loading');
  const [sales, setSales] = useState<MerchantTimesale[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [selectedRate, setSelectedRate] = useState<(typeof RATE_OPTIONS)[number] | null>(null);
  const [selectedDuration, setSelectedDuration] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // 발행 직전 확인 스냅샷 — 확인 화면에 보여준 조건 그대로 발행한다(확인 후 선택이 바뀌는 사고 방지).
  const [publishConfirm, setPublishConfirm] = useState<{
    rate: number;
    minutes: number;
    label: string;
    endsAtMs: number;
  } | null>(null);
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);
  // 서버가 알려준 '실제 적용 할인율' 안내. 토스트는 몇 초 뒤 사라지는데 이건 사장님이 방금
  // 넣은 값과 실제 적용값이 다르다는 사실이라, 화면에도 남겨 둔다(다음 선택 때 사라진다).
  const [effectiveNote, setEffectiveNote] = useState<string | null>(null);
  // 우리 가게 기본 쿠폰율 — 고른 할인율이 이보다 높아야 추천·배지에 더해진다. 모르면 null(안내 생략).
  const [baseCouponRate, setBaseCouponRate] = useState<number | null>(demo ? demoCouponRate : null);

  // 기본 쿠폰율은 facilities 공개 컬럼이라 anon 으로 한 번 읽는다(④ 좌석 섹션과 같은 경로).
  // 실패하면 조용히 null — 조건 안내만 생략되고 발행은 그대로 된다.
  useEffect(() => {
    if (demo) return;
    let alive = true;
    createPublicClient()
      .from('facilities')
      .select('coupon_rate')
      .eq('id', facilityId)
      .maybeSingle()
      .then(
        ({ data }) => {
          const rate = (data as { coupon_rate?: unknown } | null)?.coupon_rate;
          if (alive && typeof rate === 'number') setBaseCouponRate(rate);
        },
        () => {
          /* 조회 실패 — 안내 생략 */
        }
      );
    return () => {
      alive = false;
    };
  }, [facilityId, demo]);
  const rateHint = selectedRate === null ? null : timesaleRateHint(baseCouponRate, selectedRate);
  const canPublish = selectedRate !== null && selectedDuration !== null;

  const load = useCallback(async () => {
    // 데모: 진행 중인 20% 타임세일 하나를 고정으로 보여 준다(목록 API 호출 없음).
    if (demo) {
      setSales([demoActiveTimesale()]);
      setState('ready');
      return;
    }
    setState('loading');
    try {
      const data = await fetchActiveTimesales(facilityId);
      setSales(data);
      setState('ready');
    } catch (e) {
      setErrorMessage(e instanceof MerchantApiError ? e.message : '타임세일 목록을 다시 불러올게요.');
      setState('error');
    }
  }, [facilityId, demo]);

  useEffect(() => {
    load();
  }, [load]);

  // 카운트다운 갱신(1초 간격) — 활성 세일이 있을 때만 돈다.
  useEffect(() => {
    if (sales.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sales.length]);

  const activeSales = useMemo(
    () => sales.filter((s) => !s.canceled_at && new Date(s.ends_at).getTime() > now),
    [sales, now]
  );
  // 확인 단계의 배지 미리보기 — 진행 중인 세일이 더 높으면 손님은 그 값을 본다.
  const confirmPreview = publishConfirm
    ? timesaleConfirmPreview(baseCouponRate, publishConfirm.rate, activeSales.map((s) => s.rate))
    : null;

  const openPublishConfirm = () => {
    if (selectedRate === null || selectedDuration === null) return;
    const opt = DURATION_OPTIONS.find((o) => o.minutes === selectedDuration);
    setPublishError('');
    setPublishConfirm({
      rate: selectedRate,
      minutes: selectedDuration,
      label: opt?.label ?? `${selectedDuration}분`,
      endsAtMs: Date.now() + selectedDuration * 60_000,
    });
  };

  const handlePublish = async () => {
    if (!publishConfirm) return;
    // 데모: 발행 버튼은 눌리되 아무것도 쓰지 않는다.
    if (demo) {
      demoToast();
      setPublishConfirm(null);
      return;
    }
    const { rate, minutes } = publishConfirm;
    setPublishing(true);
    setPublishError('');
    try {
      // 응답에는 '지금 실제로 적용되는 할인율' 안내가 함께 온다 — 활성 세일이 겹치면 추천에는
      // 최댓값만 반영되므로, 방금 넣은 값이 적용되지 않을 수 있다는 사실을 사장님께 전한다.
      const created = await createTimesale(facilityId, rate as 0.15 | 0.2 | 0.3, minutes as 60 | 120 | 180);
      const notice = timesalePublishNotice(created, baseCouponRate);
      const overlapped = hasTimesaleOverlapNotice(created);
      setSelectedRate(null);
      setSelectedDuration(null);
      setPublishConfirm(null);
      setEffectiveNote(overlapped ? notice : null);
      await load();
      toast.success(`${Math.round(rate * 100)}% 타임세일을 발행했습니다.`, {
        ...TOAST_TOP,
        description: notice,
        // 중복 안내는 한 줄 더 길고 더 중요하다 — 기본 시간보다 오래 띄운다.
        duration: overlapped ? 10000 : undefined,
      });
    } catch (e) {
      const message = e instanceof MerchantApiError ? e.message : '타임세일 발행에 실패했습니다.';
      setPublishError(message);
      toast.error(message, TOAST_TOP);
    } finally {
      setPublishing(false);
    }
  };

  const handleCancel = async (id: string) => {
    // 데모: 취소도 쓰기다 — 토스트만.
    if (demo) {
      demoToast();
      setCancelConfirmId(null);
      return;
    }
    setCancelingId(id);
    setPublishError('');
    try {
      await cancelTimesale(id, facilityId);
      setCancelConfirmId(null);
      // 세일 하나가 사라지면 '실제 적용 할인율' 안내는 더 이상 사실이 아니다 — 같이 지운다.
      setEffectiveNote(null);
      await load();
      toast.success('타임세일을 취소했습니다.', { ...TOAST_TOP, description: '손님 추천 카드의 할인 배지도 함께 내려가요.' });
    } catch (e) {
      const message = e instanceof MerchantApiError ? e.message : '타임세일 취소에 실패했습니다.';
      setPublishError(message);
      toast.error(message, TOAST_TOP);
    } finally {
      setCancelingId(null);
    }
  };

  return (
    <SectionCard
      badge="③ 셀프 타임세일"
      id="merchant-timesale"
      title="지금 할인, 지금 발행"
      honestNote="발행하면 바로 손님 추천에서 우리 가게가 더 잘 보여요. 할인 중에는 추천 카드에 할인 배지가 붙어요."
    >
      {state === 'loading' && <SkeletonBlock heightClass="h-20" />}
      {state === 'error' && <ErrorFallback message={errorMessage} onRetry={load} />}
      {state === 'ready' && (
        <div className="flex flex-col gap-4">
          {activeSales.length > 0 && (
            <div className="flex flex-col gap-2">
              {/* 진행 중 배너 — '발행했다' 가 아니라 '지금 손님 추천에 붙어 있다' 를 보여 준다(PH10·I68).
                  손님 카드에 실제로 붙는 배지 모양 그대로의 미리보기와, 그 카드를 직접 열어 보는 길까지. */}
              {activeSales.map((sale) => (
                <div
                  key={sale.id}
                  data-testid="timesale-active"
                  className="flex flex-wrap items-start justify-between gap-2 px-3.5 py-3 rounded-2xl bg-terracotta/10 border border-terracotta/30"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-terracotta/15 text-terracotta">
                      <Zap size={16} aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[18px] font-bold leading-snug text-muk">
                        ⚡ {Math.round(sale.rate * 100)}% 타임세일 진행 중
                        <span className="whitespace-nowrap font-semibold text-muk-soft tabular-nums">
                          {' · '}
                          <Timer size={13} className="inline -mt-0.5" aria-hidden="true" /> {formatRemaining(new Date(sale.ends_at).getTime() - now)}
                        </span>
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[13px] font-bold border bg-gold/15 text-gold-deep border-gold/30">
                          <span className="h-1.5 w-1.5 rounded-full bg-gold-deep animate-pulse" aria-hidden="true" />
                          추천 반영 중
                        </span>
                        <span className="whitespace-nowrap rounded-md border border-gold/60 bg-gold/25 px-1.5 py-px text-[13px] font-black text-gold-deep">
                          ⚡ 타임세일 {Math.round(sale.rate * 100)}%
                        </span>
                        {/* 손님 화면 — 이 가게를 '선택한 장소' 카드로 연다(/main?place=). 데모 가게는 실제 지도에 없어서 감춘다. */}
                        {!demo && (
                          <Link
                            href={`/main?place=${encodeURIComponent(facilityId)}`}
                            className="inline-flex min-h-8 items-center gap-1 rounded-lg px-1.5 text-[13px] font-bold text-terracotta underline underline-offset-2 hover:text-muk focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                          >
                            손님 화면에서 보기 <ExternalLink size={12} aria-hidden="true" />
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>
                  {cancelConfirmId === sale.id ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] text-muk font-semibold">지금 종료할까요?</span>
                      <button
                        onClick={() => setCancelConfirmId(null)}
                        disabled={cancelingId === sale.id}
                        className="min-h-10 px-3 py-1.5 rounded-lg border border-line bg-white text-muk-soft text-[13px] font-semibold hover:bg-hanji transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                      >
                        유지
                      </button>
                      <button
                        onClick={() => handleCancel(sale.id)}
                        disabled={cancelingId === sale.id}
                        className="flex min-h-10 items-center gap-1 px-3 py-1.5 rounded-lg border border-terracotta bg-white text-terracotta text-[13px] font-bold hover:bg-terracotta/10 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
                      >
                        {cancelingId === sale.id && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                        종료
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setCancelConfirmId(sale.id)}
                      aria-label={`${Math.round(sale.rate * 100)}% 할인 타임세일 취소`}
                      className="flex min-h-10 items-center gap-1 px-3 py-1.5 rounded-lg border border-line bg-white text-muk-soft text-[13px] font-semibold hover:bg-hanji transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                    >
                      <XIcon size={12} aria-hidden="true" />
                      취소
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div>
            {/* 넓은 화면(오른쪽 열)에서는 할인율·지속 시간을 나란히 — ③ 이 짧아야 ④ 까지 첫 화면에 들어온다. */}
            <div className="lg:grid lg:grid-cols-2 lg:gap-3">
              <div>
                <p className="text-[13px] font-semibold text-muk-soft mb-2" id="timesale-rate-label">
                  할인율
                </p>
                <div className="grid grid-cols-3 gap-2 mb-3" role="group" aria-labelledby="timesale-rate-label">
                  {RATE_OPTIONS.map((rate) => (
                    <button
                      key={rate}
                      onClick={() => {
                        setSelectedRate(rate);
                        setPublishConfirm(null);
                        setEffectiveNote(null);
                      }}
                      aria-pressed={selectedRate === rate}
                      className={`toss-pressable min-h-11 py-2.5 rounded-xl border-2 text-base font-bold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
                        selectedRate === rate ? SELECTED_CHIP : 'border-line bg-white text-muk hover:bg-hanji'
                      }`}
                    >
                      {selectedRate === rate && <SelectedMark />}
                      {Math.round(rate * 100)}%
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-[13px] font-semibold text-muk-soft mb-2" id="timesale-duration-label">
                  지속 시간
                </p>
                <div className="grid grid-cols-3 gap-2 mb-3" role="group" aria-labelledby="timesale-duration-label">
                  {DURATION_OPTIONS.map((opt) => (
                    <button
                      key={opt.minutes}
                      onClick={() => {
                        setSelectedDuration(opt.minutes);
                        setPublishConfirm(null);
                        setEffectiveNote(null);
                      }}
                      aria-pressed={selectedDuration === opt.minutes}
                      className={`toss-pressable min-h-11 py-2.5 rounded-xl border-2 text-base font-bold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
                        selectedDuration === opt.minutes ? SELECTED_CHIP : 'border-line bg-white text-muk hover:bg-hanji'
                      }`}
                    >
                      {selectedDuration === opt.minutes && <SelectedMark />}
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {/* 고른 할인율이 기본 쿠폰율에 묻힐 때만 — 그 밖에는 조건을 되풀이하지 않는다.
                확인 단계가 열려 있으면 그쪽이 같은 사실을 말하므로 여기서는 감춘다(한 화면에 한 번). */}
            {rateHint && !publishConfirm && (
              <p className="mb-3 rounded-xl border border-line bg-hanji px-3 py-2.5 text-[13px] leading-relaxed text-muk">
                {rateHint}
              </p>
            )}

            {publishError && <p className="text-[13px] text-terracotta mb-2">{publishError}</p>}

            {/* 실제 적용 할인율 안내 — 발행은 성공했으나 추천에 반영되는 값이 방금 넣은 값과
                다를 때만 뜬다. 오류가 아니므로 경고색이 아니라 정보색으로 둔다. */}
            {effectiveNote && (
              <div className="mb-2 flex items-start gap-2 px-3 py-2.5 rounded-xl bg-jade/10 border border-jade/30 text-[13px] text-muk leading-relaxed">
                <Zap size={14} className="flex-shrink-0 mt-0.5 text-jade" aria-hidden="true" />
                <span>{effectiveNote}</span>
              </div>
            )}

            {publishConfirm ? (
              // 발행 전 확인 — 무거운 모달 없이 인라인 단계로(레포에 shadcn 없음).
              <div data-testid="timesale-confirm" className="flex flex-col gap-2.5 px-3 py-3 rounded-xl border border-gold/40 bg-gold/10">
                <p className="text-[15px] text-muk leading-relaxed">
                  <span className="font-bold">{Math.round(publishConfirm.rate * 100)}% 할인</span>을 지금부터{' '}
                  <span className="font-bold">{publishConfirm.label}</span> 동안 발행합니다. 종료 예정{' '}
                  <span className="font-bold">{formatClock(publishConfirm.endsAtMs)}</span>.
                </p>
                <p className="text-[13px] text-muk-soft leading-relaxed">
                  {confirmPreview &&
                    (confirmPreview.kind === 'baseCoupon' ? (
                      confirmPreview.text
                    ) : (
                      <>
                        {confirmPreview.ongoing ? '손님 추천 카드에는 지금 진행 중인' : '손님 추천 카드에'}{' '}
                        <span className="whitespace-nowrap rounded-md border border-gold/60 bg-gold/25 px-1.5 py-px font-black text-gold-deep">
                          ⚡ 타임세일 {Math.round(confirmPreview.rate * 100)}%
                        </span>{' '}
                        {confirmPreview.ongoing ? '배지가 그대로 붙어요.' : '배지가 붙어요.'}
                      </>
                    ))}{' '}
                  이대로 발행할까요?
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setPublishConfirm(null)}
                    disabled={publishing}
                    className="toss-pressable min-h-11 py-2.5 rounded-xl border border-line bg-white text-muk text-sm font-semibold hover:bg-hanji transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                  >
                    다시 고르기
                  </button>
                  <button
                    onClick={handlePublish}
                    disabled={publishing}
                    className="toss-pressable min-h-11 py-2.5 rounded-xl font-bold text-sm text-white bg-gradient-to-r from-gold-deep to-terracotta shadow-md shadow-terracotta/20 hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                  >
                    {publishing ? (
                      <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Zap size={15} aria-hidden="true" />
                    )}
                    발행 확인
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* 두 가지를 다 고르기 전에는 테두리만 있는 버튼 + 무엇을 고르면 되는지 한 줄.
                    예전에는 흐린 그라데이션이라 '고장난 버튼' 처럼 보였다(PH10). */}
                <button
                  disabled={!canPublish}
                  onClick={openPublishConfirm}
                  aria-describedby={canPublish ? undefined : 'timesale-publish-hint'}
                  className={`toss-pressable min-h-12 w-full py-3 rounded-xl font-bold text-[15px] transition-opacity flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
                    canPublish
                      ? 'text-white bg-gradient-to-r from-gold-deep to-terracotta shadow-md shadow-terracotta/20 hover:opacity-90'
                      : 'border-2 border-line bg-white text-muk-soft cursor-not-allowed'
                  }`}
                >
                  <Zap size={15} aria-hidden="true" />
                  타임세일 발행
                </button>
                {!canPublish && (
                  <p id="timesale-publish-hint" className="mt-2 text-center text-[13px] text-muk-soft">
                    할인율과 시간을 고르면 발행할 수 있어요
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

// =========================================================================
// ④ 좌석 상태 방송 — POST /seat-status (facilities.features.seat_status 병합)
// =========================================================================

const SEAT_OPTIONS: { level: SeatLevel; label: string; icon: React.ReactNode }[] = [
  { level: 'low', label: '여유', icon: <CircleCheck size={20} /> },
  { level: 'mid', label: '보통', icon: <CircleDot size={20} /> },
  { level: 'full', label: '만석', icon: <CircleX size={20} /> },
];

const SEAT_LABEL: Record<SeatLevel, string> = { low: '여유', mid: '보통', full: '만석' };
// 토스트 문장의 조사 — '(으)로' 를 그대로 보이지 않는다(여유로 · 보통으로 · 만석으로).
const SEAT_JOSA_RO: Record<SeatLevel, string> = { low: '로', mid: '으로', full: '으로' };

// 추천 반영 유효 창(분) — 백엔드 merchant_boost.SEAT_STATUS_FRESH_MINUTES 와 동일해야 한다.
// 이보다 오래된 방송은 추천에서 무시되므로 콘솔도 '만료됨'으로 표시한다(방송 중으로 오해 금지).
const SEAT_FRESH_MINUTES = 30;

function SeatStatusSection({ facilityId, demo = false }: { facilityId: string; demo?: boolean }) {
  const t = useT();
  const demoToast = useConsoleDemoToast();
  const [state, setState] = useState<AsyncState>('loading');
  const [current, setCurrent] = useState<{ level: SeatLevel; updated_at: string } | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [submitting, setSubmitting] = useState<SeatLevel | null>(null);
  const [clearing, setClearing] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    // 데모: 12분 전 '보통' 방송이 아직 반영 중인 상태(supabase 조회 없음).
    if (demo) {
      setCurrent({
        level: DEMO_MERCHANT_SEAT.level,
        updated_at: new Date(Date.now() - DEMO_MERCHANT_SEAT.minutesAgo * 60_000).toISOString(),
      });
      setState('ready');
      return;
    }
    setState('loading');
    try {
      const supabase = createPublicClient();
      const { data, error } = await supabase
        .from('facilities')
        .select('features')
        .eq('id', facilityId)
        .maybeSingle();
      if (error) throw error;
      const seatStatus = (data?.features as Record<string, unknown> | null)?.seat_status as
        | { level?: string; updated_at?: string }
        | undefined;
      if (seatStatus?.level && ['low', 'mid', 'full'].includes(seatStatus.level)) {
        setCurrent({ level: seatStatus.level as SeatLevel, updated_at: seatStatus.updated_at || '' });
      } else {
        setCurrent(null);
      }
      setState('ready');
    } catch {
      setErrorMessage('좌석 상태를 다시 불러올게요.');
      setState('error');
    }
  }, [facilityId, demo]);

  useEffect(() => {
    load();
  }, [load]);

  // 만료 카운트다운 — 방송값이 있을 때만 30초 간격으로 갱신한다.
  // (now 가 과거로 뒤처져 있어도 minutesAgo 가 0 으로 클램프되어 '방금 방송'으로 보이고, 30초 안에 보정된다.)
  const updatedAt = current?.updated_at ?? null;
  useEffect(() => {
    if (!updatedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [updatedAt]);

  const handleBroadcast = async (level: SeatLevel) => {
    // 데모: 방송은 facilities 에 쓰는 동작이다 — 토스트만 띄우고 끝낸다.
    if (demo) {
      demoToast();
      return;
    }
    setSubmitting(level);
    setSubmitError('');
    try {
      const res = await updateSeatStatus(facilityId, level);
      // 서버는 이 방송을 시계열 관측으로도 남겼는지(observation_status)를 함께 보내지만, 그건 내부
      // 모델 학습 사정이라 사장님 화면에는 옮기지 않는다(2026-10-06 — 학습 반영 안내 줄 삭제).
      setCurrent({ level: res.level, updated_at: res.updated_at });
      // 제목만 — 30분 동안 반영된다는 사실은 섹션 안내와 상태 줄이 이미 말한다(같은 말 세 번 금지).
      toast.success(`좌석 상태를 '${SEAT_LABEL[level]}'${SEAT_JOSA_RO[level]} 알렸어요.`, TOAST_TOP);
    } catch (e) {
      const message = e instanceof MerchantApiError ? e.message : '좌석 상태 갱신에 실패했습니다.';
      setSubmitError(message);
      toast.error(message, TOAST_TOP);
    } finally {
      setSubmitting(null);
    }
  };

  const handleClear = async () => {
    if (demo) {
      demoToast();
      return;
    }
    setClearing(true);
    setSubmitError('');
    try {
      await clearSeatStatus(facilityId);
      setCurrent(null);
      toast.success('좌석 상태 방송을 껐습니다.', TOAST_TOP);
    } catch (e) {
      const message = e instanceof MerchantApiError ? e.message : '좌석 상태 방송을 끄지 못했습니다.';
      setSubmitError(message);
      toast.error(message, TOAST_TOP);
    } finally {
      setClearing(false);
    }
  };

  // updated_at 이 없거나 깨졌으면 '만료'로 본다 — 신선함을 증명 못 하면 방송 중으로 보여주지 않는다.
  const broadcast = useMemo(() => {
    if (!current?.updated_at) return null;
    const ts = new Date(current.updated_at).getTime();
    if (Number.isNaN(ts)) return null;
    const minutesAgo = Math.max(0, Math.floor((now - ts) / 60_000));
    const minutesLeft = SEAT_FRESH_MINUTES - minutesAgo;
    return {
      minutesAgo,
      minutesLeft,
      fresh: minutesLeft > 0,
      clockLabel: formatClock(ts),
    };
  }, [current, now]);

  // 추천에 실제로 반영 중인 레벨만 '선택됨'으로 칠한다(만료값을 선택된 것처럼 보이게 하지 않는다).
  const activeLevel = broadcast?.fresh ? (current?.level ?? null) : null;

  return (
    <SectionCard
      badge="④ 좌석 상태 방송"
      id="merchant-seat"
      title="지금 우리 가게 상태"
      honestNote={`누르면 ${SEAT_FRESH_MINUTES}분 동안 손님 추천에 지금 우리 가게 상황이 반영돼요.`}
    >
      {state === 'loading' && <SkeletonBlock heightClass="h-20" />}
      {state === 'error' && <ErrorFallback message={errorMessage} onRetry={load} />}
      {state === 'ready' && (
        <div className="flex flex-col gap-3">
          <div
            className={`flex items-center justify-between flex-wrap gap-2 px-3.5 py-3 rounded-2xl border ${
              broadcast?.fresh ? 'bg-gold/10 border-gold/30' : 'bg-hanji border-line'
            }`}
          >
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muk-soft">현재 방송</span>
                <span className="text-[15px] font-bold text-muk">
                  {current ? SEAT_LABEL[current.level] : '방송 대기'}
                </span>
                {current && (
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[13px] font-bold border ${
                      broadcast?.fresh
                        ? 'bg-gold/15 text-gold-deep border-gold/30'
                        : 'bg-white text-muk-soft border-line'
                    }`}
                  >
                    {/* 방송이 살아 있는 동안만 점이 깜빡인다 — '지금 반영 중' 을 글자보다 먼저 전달. */}
                    {broadcast?.fresh && (
                      <span className="h-1.5 w-1.5 rounded-full bg-gold-deep animate-pulse" aria-hidden="true" />
                    )}
                    {broadcast?.fresh ? '적용 중' : '만료됨'}
                  </span>
                )}
              </div>
              <p className="text-[13px] text-muk-soft">
                {!current && '아래에서 현재 좌석 상태를 누르면 30분 동안 손님 추천에 바로 반영됩니다.'}
                {current &&
                  broadcast?.fresh &&
                  `${broadcast.clockLabel} 방송 · 약 ${broadcast.minutesLeft}분 뒤 만료(추천 반영 중)`}
                {current &&
                  broadcast &&
                  !broadcast.fresh &&
                  `${broadcast.minutesAgo}분 전 방송 · 다시 누르면 30분간 재반영됩니다`}
                {current && !broadcast && '지금 다시 방송하시면 30분 동안 추천에 반영됩니다.'}
              </p>
            </div>
            {current && (
              <button
                onClick={handleClear}
                disabled={clearing || submitting !== null}
                aria-label="좌석 상태 방송 끄기"
                className="flex min-h-10 items-center gap-1 px-3 py-1.5 rounded-lg border border-line bg-white text-muk-soft text-[13px] font-semibold hover:bg-hanji transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
              >
                {clearing ? (
                  <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                ) : (
                  <PowerOff size={12} aria-hidden="true" />
                )}
                방송 끄기
              </button>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="좌석 상태 방송">
            {SEAT_OPTIONS.map((opt) => (
              <button
                key={opt.level}
                onClick={() => handleBroadcast(opt.level)}
                disabled={submitting !== null || clearing}
                aria-pressed={activeLevel === opt.level}
                className={`toss-pressable flex min-h-[72px] lg:min-h-[60px] flex-col items-center justify-center gap-1.5 py-3 lg:py-2 rounded-xl border-2 text-[15px] font-bold transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
                  activeLevel === opt.level ? SELECTED_CHIP : 'border-line bg-white text-muk hover:bg-hanji'
                }`}
              >
                {submitting === opt.level ? (
                  <Loader2 size={20} className="animate-spin" aria-hidden="true" />
                ) : (
                  <span aria-hidden="true" className="flex items-center">
                    {opt.icon}
                  </span>
                )}
                {opt.label}
              </button>
            ))}
          </div>
          {/* 데모 전용 — 시간대별 좌석 여유(오늘). 실제 콘솔에는 아직 이 시계열이 없다. */}
          {demo && (
            <div className="rounded-2xl border border-line bg-hanji px-3.5 py-3">
              <p className="text-[13px] font-bold text-muk">{t('demo.seatByHourTitle')}</p>
              <p className="mb-2.5 text-[13px] text-muk-soft">{t('demo.seatByHourNote')}</p>
              <div className="flex items-end justify-between gap-1.5">
                {DEMO_MERCHANT_SEAT_BY_HOUR.map((slot) => (
                  <div key={slot.hour} className="flex flex-1 flex-col items-center gap-1">
                    <div className="flex h-20 w-full items-end rounded-md bg-white">
                      <div
                        className={`w-full rounded-md ${slot.available >= 60 ? 'bg-jade' : slot.available >= 30 ? 'bg-gold' : 'bg-terracotta'}`}
                        style={{ height: `${Math.max(6, slot.available)}%` }}
                      />
                    </div>
                    <span className="text-[13px] tabular-nums text-muk-soft">{slot.hour}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {submitError && <p className="text-[13px] text-terracotta">{submitError}</p>}
        </div>
      )}
    </SectionCard>
  );
}

// =========================================================================
// 데모 전용 카드 — 실제 콘솔에는 아직 없는 두 장(오늘 요약 · 주간 추이).
// 고정값(lib/demoFixtures.ts)만 읽고 어떤 네트워크 호출도 하지 않는다. 데모 표시는 톱바의
// '예시 화면' 칩 하나라, 이 카드 배지는 기간('오늘' · '최근 7일')을 말한다.
// =========================================================================

function DemoTodaySummary() {
  const t = useT();
  const tiles: { label: string; value: number; unit: string; icon: React.ReactNode }[] = [
    { label: t('demo.exposures'), value: DEMO_MERCHANT_TODAY.exposures, unit: t('demo.unitTimes'), icon: <Eye size={16} /> },
    { label: t('demo.accepted'), value: DEMO_MERCHANT_TODAY.accepted, unit: t('demo.unitCases'), icon: <ThumbsUp size={16} /> },
    { label: t('demo.couponsUsed'), value: DEMO_MERCHANT_TODAY.couponsUsed, unit: t('demo.unitCases'), icon: <Ticket size={16} /> },
    { label: t('demo.arrivals'), value: DEMO_MERCHANT_TODAY.arrivals, unit: t('demo.unitCases'), icon: <CircleCheck size={16} /> },
  ];
  return (
    <SectionCard badge={t('demo.todayBadge')} title={t('demo.todayTitle')} honestNote={t('demo.todayNote')}>
      <div className="grid grid-cols-2 gap-3">
        {tiles.map((tile) => (
          <StatTile
            key={tile.label}
            icon={tile.icon}
            label={tile.label}
            value={`${tile.value.toLocaleString()}${tile.unit}`}
          />
        ))}
      </div>
    </SectionCard>
  );
}

function DemoWeeklyTrend() {
  const t = useT();
  return (
    <SectionCard badge={t('demo.weeklyBadge')} title={t('demo.weeklyTitle')} honestNote={t('demo.weeklyNote')}>
      <div className="h-52 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={DEMO_MERCHANT_WEEKLY} margin={{ top: 5, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--nextspot-line)" />
            <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: 'var(--nextspot-muk-soft)', fontSize: 13 }} />
            <YAxis axisLine={false} tickLine={false} tick={{ fill: 'var(--nextspot-muk-soft)', fontSize: 13 }} width={42} />
            <Tooltip
              contentStyle={{
                borderRadius: '10px',
                border: '1px solid var(--nextspot-line)',
                color: 'var(--nextspot-muk)',
                fontSize: 13,
              }}
            />
            <Line type="monotone" dataKey="exposures" name={t('demo.exposures')} stroke="var(--nextspot-gold)" strokeWidth={3} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="accepted" name={t('demo.accepted')} stroke="var(--nextspot-terracotta)" strokeWidth={3} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="couponsUsed" name={t('demo.couponsUsed')} stroke="var(--nextspot-jade)" strokeWidth={3} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex flex-wrap gap-3">
        {[
          { label: t('demo.exposures'), color: 'var(--nextspot-gold)' },
          { label: t('demo.accepted'), color: 'var(--nextspot-terracotta)' },
          { label: t('demo.couponsUsed'), color: 'var(--nextspot-jade)' },
        ].map((item) => (
          <span key={item.label} className="flex items-center gap-1.5 text-[13px] text-muk-soft">
            <span className="h-2 w-2 rounded-full" style={{ background: item.color }} aria-hidden="true" />
            {item.label}
          </span>
        ))}
      </div>
    </SectionCard>
  );
}
