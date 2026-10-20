'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Home, Bookmark, Timer, Route, User, Store, Landmark } from 'lucide-react';
import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useT } from '@/lib/i18n/I18nProvider';
import { GuideButton } from '@/components/guide/GuideProvider';
import { haptic, interactionSpring } from '@/lib/motion';
import { useAccount } from '@/lib/account';
import { consoleLinks } from '@/lib/consoleLinks';

// 관광객 앱 주 내비게이션 — 반응형:
//  · 데스크톱(md+): 왼쪽에 떠 있는 유리 캡슐 셋(fixed → 폭을 차지하지 않는다. /main 외 페이지는 투명 여백 --rail-gutter 만 비운다).
//  · 모바일(<md): 기존 하단 가로 바(fixed 오버레이 → 페이지는 pb-[120px] 로 클리어런스 확보).
// 숨김 경로에서는 null 을 반환하므로 레이아웃 flex-row 에서 레일이 사라지면 콘텐츠가 전체폭을 차지한다.
//
// 콘솔 입구(사장님 콘솔 · 관제 대시보드)도 여기 둔다 — 기능 5 를 찾는 심사위원이 관광객 화면 어디서든
// 한 번에 들어가게(2026-10-06 감사 I14). 탭이 아니라 링크다: 5탭 폭은 그대로 두고, 레일은 구분선 아래,
// 폰은 하단 바 위 안내 줄의 오른쪽에 작게. 목적지는 역할로 갈린다(lib/consoleLinks.ts — 역할 없으면 데모).
export default function BottomNav() {
  const pathname = usePathname();
  const router = useRouter();
  const t = useT();
  const { account } = useAccount();

  // 빠른 UI 반응을 위한 낙관적 탭 상태
  const [optimisticTab, setOptimisticTab] = useState<string | null>(null);

  // URL 경로가 변경되면 낙관적 탭 초기화 (페이지 전환 완료 시점)
  useEffect(() => {
    setOptimisticTab(null);
  }, [pathname]);

  // 네비게이션은 '앱 페이지'에서만 표시한다(allowlist). 랜딩·로그인·auth·setup·admin·merchant 등
  // chrome 없는 페이지는 기본적으로 숨김 → 새 chrome-less 페이지가 실수로 네비에 노출되는 것을 원천 차단.
  const NAV_ROUTES = ['/main', '/saved', '/waiting', '/course', '/mypage', '/explore'];
  if (!pathname || !NAV_ROUTES.some((r) => pathname === r || pathname.startsWith(r + '/'))) return null;

  const tabs = [
    { id: 'Home', icon: Home, label: t('nav.home'), path: '/main' },
    { id: 'Saved', icon: Bookmark, label: t('nav.saved'), path: '/saved' },
    // 라벨이 유일하게 긴 탭('지금 출발하면?') — 모바일 바에서만 폰트를 한 단계 줄여 5탭 폭에 수용.
    { id: 'Waiting', icon: Timer, label: t('nav.waiting'), path: '/waiting', mobileLabelClass: 'text-[10px] tracking-tight' },
    { id: 'Course', icon: Route, label: t('nav.course'), path: '/course' },
    { id: 'MyPage', icon: User, label: t('nav.mypage'), path: '/mypage' }
  ];

  const getActiveTab = () => {
    if (optimisticTab) return optimisticTab;
    if (pathname.includes('/saved')) return 'Saved';
    if (pathname.includes('/waiting')) return 'Waiting';
    if (pathname.includes('/course')) return 'Course';
    if (pathname.includes('/mypage')) return 'MyPage';
    return 'Home'; // default
  };

  const activeTab = getActiveTab();
  const activeIndex = tabs.findIndex(t => t.id === activeTab);

  const links = consoleLinks(account);
  const consoles = [
    { id: 'merchant', icon: Store, label: t('nav.merchantConsole'), shortLabel: t('nav.merchantShort'), href: links.merchant },
    { id: 'admin', icon: Landmark, label: t('nav.adminDashboard'), shortLabel: t('nav.adminShort'), href: links.admin },
  ];

  const handleTabClick = (tab: { id: string; path: string }) => {
    if (tab.id === activeTab) return;

    // 즉각적인 시각 피드백 제공 (Next.js 렌더링 블락 회피)
    haptic('selection');
    setOptimisticTab(tab.id);

    // 인위적 지연 없이 즉시 라우팅 (낙관적 인디케이터는 위에서 이미 갱신됨)
    router.push(tab.path);
  };

  return (
    <>
      {/* ── 데스크톱: 왼쪽 떠 있는 유리 캡슐 세 개 (10-19 PM — iOS 26 탭 바처럼 화면 옆을 막지 않고 지도 위에 뜬다) ──
          · 자리를 차지하지 않는다(nav 는 fixed). /main 은 지도가 바 뒤까지 이어지고, 다른 페이지는 아래 투명 여백(--rail-gutter)만큼 비워
            본문이 캡슐에 가려지지 않게 한다. nav 자체는 pointer-events-none — 캡슐 바깥 빈 곳은 그 밑 지도·본문을 그대로 누른다.
          · 캡슐 둘(10-19 PM: 고양이 프로필 아이콘은 뺐다): 탭 5개 · 콘솔 입구 둘 + 서비스 소개. 한 줄로 두면 키 낮은 창에서 넘쳐 역할별로 나눴다.
            탭은 위쪽, 콘솔은 아래쪽(bottom-10 — Kakao 지도 로고(왼쪽 아래)를 가리지 않는다). 세로 순서는 e2e 가 잠근다(탭 → 콘솔 → 서비스 소개).
          · 키 낮은 창(short: 높이 720px 미만)에서는 칸을 64→56px 로 줄여 콘솔 입구·서비스 소개까지 스크롤 없이 들어간다(1366×650 실측 기준). */}
      {/* 지도(/main)와 분산코스(/course)는 화면이 캡슐 뒤까지 이어진다(10-20 PM: 캡슐 뒤가 잘린 듯 비어 보이지 않게) — 본문 쪽에서 --rail-gutter 만큼 비운다. */}
      {!['/main', '/course'].some((r) => pathname === r || pathname.startsWith(r + '/')) && <div aria-hidden className="hidden shrink-0 md:block w-[var(--rail-gutter)]" />}
      <nav
        aria-label="주요 내비게이션"
        className="pointer-events-none fixed inset-y-0 left-3 z-40 hidden w-20 md:block"
      >
        {/* 탭 캡슐 — --rail-step = 탭 높이 + 간격. 인디케이터가 같은 값으로 움직여야 짧은 창에서도 탭에 맞는다. */}
        {/* 두 캡슐을 한 묶음으로 세로 가운데에(10-20 PM: 위에 붙어 너무 높았다). 묶음이 가운데라 키 낮은 창에서도 서로 겹치지 않고, 바닥의 Kakao 로고도 비켜 간다. */}
        <div className="pointer-events-none absolute inset-y-0 left-0 flex w-20 flex-col justify-center gap-3">
        <div className="rail-glass pointer-events-auto flex w-20 shrink-0 flex-col items-center rounded-[2rem] border px-[7px] py-2">
          <div className="relative flex flex-col items-center gap-2 [--rail-step:4.5rem] short:gap-1 short:[--rail-step:3.75rem]">
            {/* 활성 탭 세로 슬라이딩 인디케이터 — iOS 26 처럼 밝은 유리 알약(어두운 캡슐 위) */}
            <motion.div
              aria-hidden
              className="absolute left-0 w-16 h-16 short:h-14 rounded-full bg-hanji/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] pointer-events-none"
              animate={{ top: `calc(${activeIndex} * var(--rail-step))` }}
              transition={interactionSpring}
            />
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <motion.button
                  key={tab.id}
                  onClick={() => handleTabClick(tab)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`toss-pressable relative z-10 flex flex-col items-center justify-center gap-1 w-16 h-16 short:h-14 rounded-full ${
                    isActive ? 'text-gold-deep' : 'text-muk-soft hover:text-muk'
                  }`}
                >
                  <div className="transition-transform duration-300 ease-out hover:scale-110">
                    <Icon size={24} className={isActive ? 'text-gold-deep' : 'text-muk-soft'} />
                  </div>
                  {/* 긴 라벨('지금 출발하면?')은 공백 기준 2줄로 자연 래핑 — h-16 안에 수용된다. */}
                  <span className={`text-[11px] font-medium leading-tight text-center break-keep ${isActive ? 'text-gold-deep' : ''}`}>
                    {tab.label}
                  </span>
                </motion.button>
              );
            })}
          </div>
        </div>

        {/* 콘솔 캡슐 — 콘솔 입구 둘 + 서비스 소개. 라벨은 낱말 사이에서만 두 줄로 접는다(keep-all).
            ja 는 띄어쓰기가 없어 사전에 폭 없는 공백(U+200B)으로 낱말 경계를 둔다('オーナー|コンソール'·'運営|ダッシュボード').
            'ダッシュボード' 는 일곱 자라 칸(64px)보다 길다 — 라벨만 캡슐 폭(80px)까지 쓰고 ja 는 10px 로 한 줄에 넣는다. */}
        <div className="rail-glass pointer-events-auto flex w-20 shrink-0 flex-col items-center gap-1 rounded-[2rem] border px-[7px] py-2">
          {consoles.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.id}
                href={item.href}
                prefetch={false}
                data-console-entry={item.id}
                className="flex w-16 h-14 flex-col items-center justify-center gap-1 rounded-2xl text-muk-soft transition-colors hover:bg-gold/10 hover:text-muk focus-visible:outline-2 focus-visible:outline-gold-deep"
              >
                <Icon size={22} aria-hidden />
                <span className="-mx-1.5 w-[calc(100%+0.75rem)] text-[11px] font-medium leading-tight text-center [word-break:keep-all] [&:lang(ja)]:text-[10px]">{item.label}</span>
              </Link>
            );
          })}
          <div aria-hidden className="my-1 h-px w-10 bg-line" />
          <GuideButton className="min-h-14 w-16 flex-col py-1.5" />
        </div>
        </div>
      </nav>

      {/* ── 모바일: 하단 가로 바 (fixed 오버레이) ── */}
      <nav
        aria-label="주요 내비게이션"
        className="md:hidden fixed bottom-0 left-0 w-full z-40 bg-white/90 backdrop-blur-xl border-t border-line shadow-[0_-2px_14px_rgba(43,35,32,0.06)] px-6 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
      >
        {/* 안내 줄 — 왼쪽 서비스 소개, 오른쪽 콘솔 입구 두 개(12px). 줄 높이는 그대로라 페이지 하단 여백이 바뀌지 않는다. */}
        <div className="mb-1 flex h-8 items-center justify-between gap-1 border-b border-line pb-1">
          <GuideButton compact className="min-h-8 shrink-0 px-1" />
          <div className="flex min-w-0 items-center gap-1">
            {consoles.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  prefetch={false}
                  data-console-entry={item.id}
                  className="inline-flex min-h-8 items-center gap-1 whitespace-nowrap rounded-lg px-1.5 text-xs font-medium text-muk-soft transition-colors hover:bg-gold/10 hover:text-muk focus-visible:outline-2 focus-visible:outline-gold-deep"
                >
                  <Icon size={14} aria-hidden />
                  {item.shortLabel}
                </Link>
              );
            })}
          </div>
        </div>
        <div className="relative flex justify-around items-center w-full">
          {/* 활성 탭 가로 슬라이딩 인디케이터 — 탭 한 칸 폭(100/N %)의 틀을 transform 으로만 옮긴다(x = 칸 수 × 100%).
              예전에는 left 를 움직여 매 프레임 배치를 다시 계산했다(10-10 인터랙션 감사). 알약은 틀 가운데. */}
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 flex justify-center"
            style={{ width: `${100 / tabs.length}%` }}
            initial={false}
            animate={{ x: `${activeIndex * 100}%` }}
            transition={interactionSpring}
          >
            <span className="h-12 w-14 rounded-2xl bg-gold/15" />
          </motion.div>
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <motion.button
                key={tab.id}
                onClick={() => handleTabClick(tab)}
                aria-current={isActive ? 'page' : undefined}
                className={`toss-pressable relative z-10 flex flex-col items-center justify-center flex-1 min-w-0 h-12 ${
                  isActive ? 'text-gold-deep' : 'text-muk-soft hover:text-muk'
                }`}
              >
                <div className="mb-0.5 transition-transform duration-300 ease-out hover:scale-110">
                  <Icon size={22} className={isActive ? 'text-gold-deep' : 'text-muk-soft'} />
                </div>
                <span className={`${(tab as { mobileLabelClass?: string }).mobileLabelClass ?? 'text-[11px]'} font-medium whitespace-nowrap ${isActive ? 'text-gold-deep' : ''}`}>
                  {tab.label}
                </span>
              </motion.button>
            );
          })}
        </div>
      </nav>
    </>
  );
}
