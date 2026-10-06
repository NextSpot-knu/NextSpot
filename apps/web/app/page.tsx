'use client';

import { useEffect, useCallback, useRef, type MouseEvent } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, Database, Landmark, Store } from 'lucide-react';
import { useT } from '@/lib/i18n/I18nProvider';
import { warmBackend } from '@/lib/api-client';
import { useAccount } from '@/lib/account';
import { consoleLinks } from '@/lib/consoleLinks';
import { requestGuideDataSection } from '@/lib/guideDataSection';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { GuideButton } from '@/components/guide/GuideProvider';
import GuideHero from '@/components/guide/GuideHero';
import FeatureShortcuts from '@/components/guide/FeatureShortcuts';
import guideStyles from '@/components/guide/guide.module.css';
import FestivalBanner from '@/components/main/FestivalBanner';
import NextSpotMascot from '@/components/NextSpotMascot';

// 랜딩은 폭으로 두 벌이다(2026-10-06 감사 I35·PE06, 계획 B1).
//  · 1024px 이상(심사위원이 가장 많이 여는 노트북·PC): 서비스 소개와 같은 두 칸 히어로가 곧 첫 화면이다. 왼쪽은
//    가치 문장·'바로 시작'·축제 배너·데이터 띠, 오른쪽은 핵심 기능 다섯 개로 바로 가는 '이렇게 써 보세요'.
//    소개 모달은 저절로 열지 않고, 빈 곳을 눌러도 앱으로 넘어가지 않는다(오른쪽 칸을 읽다 화면이 바뀌면 안 된다).
//  · 그보다 좁은 화면(폰·태블릿): 예전 세로 첫 화면 그대로 — 가치 칩, 화면 아무 곳이나 눌러 시작, 첫 방문엔 소개
//    모달이 한 번 열린다(모달 첫 칸에 같은 '이렇게 써 보세요'가 있다). 콘솔 입구 한 줄과 더 큰 출처 줄이 더해졌다.
// 둘 다 DOM 에 있고 CSS(lg:)로 하나만 보인다 — 숨은 쪽은 접근성 트리·클릭에서 빠진다.
const DESKTOP_QUERY = '(min-width: 1024px)';

function isDesktopViewport(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches;
  } catch {
    return false;
  }
}

// 바깥 화면 탭(go)으로 새지 않게 — 링크·축제 패널(포털이라도 React 트리로 버블링된다)을 감싼다.
const stopTap = (event: MouseEvent) => event.stopPropagation();

export default function LoadingPage() {
  const router = useRouter();
  const t = useT();
  const { account } = useAccount();
  const consoles = consoleLinks(account);
  // 자동 리다이렉트와 탭 스킵이 겹쳐 중복 이동하는 것을 방지
  const navigatedRef = useRef(false);
  // 서비스 소개 버튼 — 폭마다 한 개씩(폰 배치·데스크톱 배치). 첫 방문 자동 노출(폰)과 데이터 출처 줄이
  // 보이는 쪽 버튼을 프로그램적으로 눌러 모달을 연다(아래 openGuide).
  const phoneTriggerRef = useRef<HTMLSpanElement>(null);
  const deskTriggerRef = useRef<HTMLSpanElement>(null);
  const openGuide = useCallback(() => {
    const trigger = isDesktopViewport() ? deskTriggerRef.current : phoneTriggerRef.current;
    trigger?.querySelector('button')?.click();
  }, []);

  // '바로 시작'은 로그인 없이 곧장 온보딩(→ /setup)으로 보낸다 — 관광객 무마찰이 이 제품의 핵심 원칙이고
  // 발표 대본(docs/contest/DEMO_SCENARIO.md "이 전체 흐름이 로그인 절차 없이 3분 안에 끝납니다")과
  // JUDGE_QA Q10("로그인 UI 없이도 동작한다")이 이 경로를 전제로 한다.
  // 온보딩 흔적이 있으면 /main 으로 바이패스(재방문자가 3문항을 다시 겪지 않게).
  // 로그인/회원가입은 아래 보조 CTA 로 언제든 갈 수 있고, 게스트로 쌓은 데이터는 가입 시 승계된다
  // (익명→정회원 전환은 uid 유지 — docs/archive/AUTH_MEMBERSHIP_PLAN.md).
  const go = useCallback(() => {
    if (navigatedRef.current) return;
    // 저장소를 **래치보다 먼저** 읽는다. localStorage 접근은 차단 환경(사파리 사생활 보호,
    // 사이트 데이터 차단)에서 예외를 던지는데, 래치를 먼저 켜면 그 예외 뒤로는 탭도 키 입력도
    // 전부 이른 return 에 걸려 첫 화면이 통째로 먹통이 된다 — 앱에 들어갈 방법이 없어진다.
    let seen: string | null = null;
    try {
      seen = typeof window !== 'undefined' ? window.localStorage.getItem('nextspot_setup_prefs') : null;
    } catch {
      /* 저장소 차단 — 온보딩부터 시작한다(재방문 판별을 못 할 뿐 진행은 막지 않는다) */
    }
    navigatedRef.current = true;
    router.push(seen ? '/main' : '/setup');
  }, [router]);

  // 데스크톱(≥1024px)은 빈 곳을 눌러도 시작하지 않는다 — '이렇게 써 보세요'를 읽다가 앱으로 넘어가 버리면
  // 심사위원은 무엇을 눌렀는지 모른 채 첫 화면을 잃는다. 폰은 예전처럼 화면 아무 곳이나 눌러 시작한다.
  const onRootTap = useCallback(() => {
    if (isDesktopViewport()) return;
    go();
  }, [go]);

  // 출처 줄의 '데이터 출처' → 서비스 소개 모달의 '데이터' 절. 모달을 여는 경로는 가이드 버튼
  // 하나뿐이라(GuideProvider 의 컨텍스트 API), 여기서도 같은 버튼을 눌러 열고 어느 절을 펼칠지는
  // 모듈 신호로 넘긴다(lib/guideDataSection.ts) — 본문이 dynamic import 라 클릭 직후엔 없다.
  const openDataSection = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation(); // 화면 전체 탭(go)으로 새지 않게
    requestGuideDataSection();
    openGuide();
  }, [openGuide]);

  const goLogin = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    router.push('/login');
  }, [router]);

  useEffect(() => {
    // 첫 화면에서 백엔드 캐시 워밍을 미리 발사 — 사용자가 지도·대기보드·코스에 도달할 즈음
    // 백엔드가 웜 상태가 되게 한다(실패·404 무해, UI 무영향).
    warmBackend();
  }, []);

  // 첫 방문자에게 서비스 소개(가이드)를 자동으로 띄운다 — 아무것도 모르는 심사위원이 첫 화면에서
  // 3초 안에 가치를 이해하도록. 이미 본 사용자·재방문자에겐 안 띄운다(localStorage 게이트).
  // 저장소 차단 환경(사파리 사생활 보호 등)은 조용히 건너뛴다 — 자동 노출만 생략하고 진행은 막지 않는다.
  // 데스크톱(≥1024px)은 띄우지 않는다 — 랜딩 자체가 소개 히어로 + 기능 바로가기라, 모달이 그것을 가린다.
  useEffect(() => {
    if (isDesktopViewport()) return;
    let seenIntro: string | null = 'skip';
    try {
      seenIntro = typeof window !== 'undefined' ? window.localStorage.getItem('nextspot_intro_seen') : 'skip';
    } catch {
      seenIntro = 'skip';
    }
    if (seenIntro) return;
    // 가이드 버튼을 눌러 모달을 연다. 단발 클릭은 하이드레이션/로케일 로딩과 경합해 씹힐 수 있어
    // (라이브에서 재현: 600ms 단발 클릭 → 모달 안 열림, 수동 클릭은 정상) **열림이 확인될 때까지**
    // 900ms 간격으로 재시도하고, 플래그는 dialog.open 확인 후에만 세운다. 4회 실패면 조용히 포기.
    // 열림 확인은 누른 뒤 150ms 마다 한다 — 900ms 뒤 한 번만 보면, 그 사이에 방문자가 소개를 닫았을 때
    // '안 열렸다'로 읽고 다시 눌러 소개가 또 열렸다(닫아도 되살아나고, 다음 방문에도 다시 떴다).
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const markSeen = () => {
      try { window.localStorage.setItem('nextspot_intro_seen', '1'); } catch { /* 저장 실패 무시 */ }
    };
    const isOpen = () => Boolean(document.querySelector('dialog')?.open);
    const tryOpen = () => {
      if (cancelled) return;
      if (isOpen()) { markSeen(); return; } // 이미 열려 있다(방문자가 먼저 눌렀다) → 완료
      attempts += 1;
      if (attempts > 4) { markSeen(); return; } // 반복 실패 — 다음 방문에 다시 괴롭히지 않는다
      phoneTriggerRef.current?.querySelector('button')?.click();
      let checks = 0;
      const confirm = () => {
        if (cancelled) return;
        if (isOpen()) { markSeen(); return; } // 열림 확인 → 완료(이후 닫아도 다시 열지 않는다)
        checks += 1;
        timer = setTimeout(checks < 6 ? confirm : tryOpen, 150);
      };
      timer = setTimeout(confirm, 150);
    };
    timer = setTimeout(tryOpen, 900);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  return (
    <div
      onClick={onRootTap}
      className="relative flex min-h-[100dvh] flex-col items-center overflow-x-hidden bg-gradient-to-b from-hanji via-hanji-deep to-sunset-1/25 cursor-pointer lg:cursor-auto"
    >
      {/* 언어 선택 — 진입 즉시 외국인 관광객이 전환 가능(부모 onClick 이동 방지) */}
      <div className="absolute top-4 right-4 z-20" onClick={(e) => e.stopPropagation()}>
        <LanguageSwitcher />
      </div>

      {/* 은은한 금빛 광원 (기존 콜드 blue 글로우 대체) */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[300px] bg-gold/15 rounded-full blur-[100px] pointer-events-none z-0"></div>

      {/* 반딧불이 — 경주 여름밤의 은은한 금빛 점들이 천천히 떠다니며 숨쉬듯 밝아졌다 사그라든다.
          장식 전용(z-0·pointer-events-none), 위치·주기는 고정 배열(SSG 하이드레이션 안전),
          reduced-motion 이면 전역 규칙이 애니메이션을 눌러 정지 점광으로만 남는다. */}
      <style>{`
        @keyframes ns-firefly-drift {
          0%   { transform: translate(0, 0); }
          25%  { transform: translate(14px, -22px); }
          50%  { transform: translate(-10px, -38px); }
          75%  { transform: translate(-20px, -14px); }
          100% { transform: translate(0, 0); }
        }
        @keyframes ns-firefly-glow {
          0%, 100% { opacity: 0; }
          35%      { opacity: 0.9; }
          55%      { opacity: 0.45; }
          70%      { opacity: 0.85; }
        }
        .ns-firefly {
          position: absolute;
          border-radius: 9999px;
          background: radial-gradient(circle, rgba(255, 236, 180, 0.95) 0%, rgba(193, 154, 62, 0.55) 45%, rgba(193, 154, 62, 0) 75%);
          box-shadow: 0 0 10px 3px rgba(193, 154, 62, 0.35);
          opacity: 0;
          animation: ns-firefly-drift var(--ff-drift) ease-in-out infinite, ns-firefly-glow var(--ff-glow) ease-in-out infinite;
          animation-delay: var(--ff-delay), var(--ff-delay);
        }
      `}</style>
      <div className="pointer-events-none absolute inset-0 overflow-hidden z-0" aria-hidden="true">
        {([
          { left: '12%', top: '30%', size: 5, drift: '11s', glow: '5.2s', delay: '0s' },
          { left: '22%', top: '62%', size: 4, drift: '13s', glow: '6.1s', delay: '1.4s' },
          { left: '31%', top: '18%', size: 3, drift: '10s', glow: '4.6s', delay: '2.8s' },
          { left: '44%', top: '74%', size: 5, drift: '14s', glow: '5.8s', delay: '0.9s' },
          { left: '58%', top: '24%', size: 4, drift: '12s', glow: '5.0s', delay: '2.1s' },
          { left: '67%', top: '58%', size: 3, drift: '15s', glow: '6.6s', delay: '3.6s' },
          { left: '76%', top: '36%', size: 5, drift: '11.5s', glow: '4.9s', delay: '1.8s' },
          { left: '85%', top: '68%', size: 4, drift: '13.5s', glow: '5.5s', delay: '0.4s' },
          { left: '52%', top: '44%', size: 3, drift: '12.5s', glow: '6.3s', delay: '4.2s' },
          { left: '8%', top: '80%', size: 4, drift: '14.5s', glow: '5.7s', delay: '3.1s' },
        ] as const).map((fly, index) => (
          <span
            key={index}
            className="ns-firefly"
            style={{
              left: fly.left,
              top: fly.top,
              width: `${fly.size}px`,
              height: `${fly.size}px`,
              ['--ff-drift' as string]: fly.drift,
              ['--ff-glow' as string]: fly.glow,
              ['--ff-delay' as string]: fly.delay,
            }}
          />
        ))}
      </div>

      {/* 하단 경주 노을 광원 */}
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[420px] h-[280px] bg-sunset-1/20 rounded-full blur-[120px] pointer-events-none z-0"></div>

      {/* 대릉원 고분 능선 실루엣 — 첫 3초 안에 '경주'를 알리는 시각 시그니처(장식 전용, 레이아웃·포인터 영향 없음).
          원경(옅은 jade) 위에 근경(짙은 jade)을 겹쳐 노을 광원이 능선을 역광으로 비추는 구도. */}
      <svg
        viewBox="0 0 1440 240"
        preserveAspectRatio="xMidYMax slice"
        className="absolute bottom-0 inset-x-0 w-full h-[26vh] min-h-[140px] pointer-events-none z-0"
        aria-hidden="true"
      >
        <path d="M-80 240 Q 260 40 620 240 Z" fill="var(--color-jade)" fillOpacity="0.08" />
        <path d="M520 240 Q 900 10 1300 240 Z" fill="var(--color-jade)" fillOpacity="0.08" />
        <path d="M-200 240 Q 120 90 460 240 Z" fill="var(--color-jade)" fillOpacity="0.13" />
        <path d="M880 240 Q 1240 70 1620 240 Z" fill="var(--color-jade)" fillOpacity="0.13" />
      </svg>

      {/* ── 폰·태블릿(<1024px) 첫 화면 ── 첫 그림은 300ms 옅게 떠오르기만 한다(예전처럼 1초 넘게 비워 두지 않는다). */}
      <div
        className={`z-10 flex w-full flex-1 flex-col items-center justify-center px-6 pb-8 pt-20 text-center lg:hidden ${guideStyles.landingFade}`}
      >
        {/* 길잡이 마스코트는 장식 전용이며 aria-hidden은 컴포넌트 내부에서 처리한다. */}
        <NextSpotMascot variant="full" className="w-20 sm:w-24 shadow-[0_10px_28px_rgba(43,35,32,0.14)]" />

        {/* 서비스 지역 배지 */}
        <span className="mt-3 inline-flex items-center px-3 py-1.5 rounded-full bg-gold/15 border border-gold/30 text-xs font-bold text-gold-deep">
          {t('landing.badge')}
        </span>

        <h1 className="mt-3">
          <Image
            src="/nextspot-logo.png"
            alt="NextSpot"
            width={505}
            height={109}
            priority
            unoptimized
            className="nextspot-logo-light h-14 w-auto sm:h-[70px]"
          />
          <Image
            src="/nextspot-logo-dark.png"
            alt="NextSpot"
            width={505}
            height={109}
            priority
            unoptimized
            className="nextspot-logo-dark h-14 w-auto sm:h-[70px]"
          />
        </h1>

        {/* 가치 헤드라인 — 기존 tagline 을 세리프 헤드라인으로 승격(/course·/waiting 히어로와 같은 서체 문법). */}
        <p className="mt-4 max-w-md text-[22px] sm:text-[26px] font-serif font-black text-muk leading-[1.25] tracking-tight">
          {t('landing.tagline')}
        </p>
        <p className="mt-2.5 max-w-sm text-[15px] text-muk-soft leading-relaxed">
          {t('landing.subline')}
        </p>

        {/* 기능 스트립 — 수치 없는 정성 라벨만(fractal-glass 필, 다크 테마는 globals.css 가 bg-white/* 를 치환). */}
        <ul className="mt-4 flex max-w-md flex-wrap items-center justify-center gap-2">
          <li className="inline-flex items-center rounded-2xl border border-line/70 bg-white/70 fractal-glass px-3.5 py-2 text-sm font-semibold text-muk leading-snug shadow-[0_1px_2px_rgba(43,35,32,0.05)]">
            {t('landing.value1')}
          </li>
          <li className="inline-flex items-center rounded-2xl border border-line/70 bg-white/70 fractal-glass px-3.5 py-2 text-sm font-semibold text-muk leading-snug shadow-[0_1px_2px_rgba(43,35,32,0.05)]">
            {t('landing.value2')}
          </li>
          <li className="inline-flex items-center rounded-2xl border border-line/70 bg-white/70 fractal-glass px-3.5 py-2 text-sm font-semibold text-muk leading-snug shadow-[0_1px_2px_rgba(43,35,32,0.05)]">
            {t('landing.value3')}
          </li>
          <li className="inline-flex items-center rounded-2xl border border-line/70 bg-white/70 fractal-glass px-3.5 py-2 text-sm font-semibold text-muk leading-snug shadow-[0_1px_2px_rgba(43,35,32,0.05)]">
            {t('landing.value4')}
          </li>
        </ul>

        {/* '바로 시작'(게스트, 로그인 불필요) — 화면 탭/키 입력과 동일한 go() 재사용.
            금→주칠 그라디언트 CTA(/course·/waiting·추천 카드와 동일 문법) + toss-pressable 눌림. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            go();
          }}
          className="toss-pressable mt-6 inline-flex min-h-[52px] items-center gap-1.5 rounded-full bg-gradient-to-r from-gold to-terracotta px-10 text-[17px] font-bold text-white shadow-[0_8px_24px_rgba(193,85,59,0.28)] hover:from-gold-deep hover:to-terracotta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-deep focus-visible:ring-offset-2 focus-visible:ring-offset-hanji"
        >
          {t('landing.ctaStart')}
          <ChevronRight size={20} aria-hidden />
        </button>

        {/* 지금 경주에서 열리는 축제(TourAPI searchFestival2) — 진행 중일 때만 선다(없으면 자리째 숨는다). */}
        <div onClick={stopTap} className="mt-4 flex w-full justify-center empty:hidden">
          <FestivalBanner variant="banner" />
        </div>

        {/* 보조 CTA — 로그인은 선택이다. 기기 간 동기화를 원하는 사용자만 여기로 가고,
            게스트로 쌓은 저장·취향은 나중에 가입해도 그대로 승계된다(익명→정회원 전환, uid 유지). */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            goLogin();
          }}
          className="toss-pressable mt-3 inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-semibold text-muk-soft underline decoration-line underline-offset-4 transition-colors hover:text-muk focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-deep"
        >
          {t('landing.ctaLogin')}
        </button>
        <span ref={phoneTriggerRef} className="contents">
          <GuideButton compact className="mt-2 min-h-11 px-5" />
        </span>

        {/* 기능 5 입구 — 작은 글자 링크 한 줄(사장님 콘솔 · 관제 대시보드). 목적지는 역할로 갈린다
            (lib/consoleLinks.ts — 게스트는 로그인 없이 보는 데모). */}
        <div onClick={stopTap} className="mt-3 flex flex-wrap items-center justify-center gap-x-1 text-[13px] font-semibold text-muk-soft">
          <Link
            href={consoles.merchant}
            prefetch={false}
            className="toss-pressable inline-flex min-h-10 items-center gap-1 rounded-lg px-2 underline decoration-line underline-offset-4 transition-colors hover:text-muk focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-deep"
          >
            <Store size={14} aria-hidden />
            {t('nav.merchantShort')}
          </Link>
          <span aria-hidden>·</span>
          <Link
            href={consoles.admin}
            prefetch={false}
            className="toss-pressable inline-flex min-h-10 items-center gap-1 rounded-lg px-2 underline decoration-line underline-offset-4 transition-colors hover:text-muk focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-deep"
          >
            <Landmark size={14} aria-hidden />
            {t('nav.adminShort')}
          </Link>
        </div>
      </div>

      {/* 공공데이터 출처 — 누르면 서비스 소개의 '데이터' 절(어떤 공공 API 를 어느 화면에 쓰는지
          표 + 실시간 신선도)이 펼쳐진 채로 열린다. 화면 전체 onClick(go)과 겹치므로 전파를 막는다.
          예전 12px 회색 줄은 심사 기준(데이터 활용)에 비해 너무 작았다 — 13px 진한 글자로 키웠다. */}
      <div className="relative z-10 shrink-0 px-4 pb-3 text-center lg:hidden">
        <button
          type="button"
          onClick={openDataSection}
          className="toss-pressable inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-[13px] font-semibold text-muk underline decoration-line underline-offset-4 transition-colors hover:text-gold-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-deep"
        >
          {t('landing.dataAttribution')}
          <ChevronRight size={14} aria-hidden />
          <span className="sr-only">{t('dataTab.footerHint')}</span>
        </button>
      </div>

      {/* ── 데스크톱(≥1024px) 첫 화면 ── 서비스 소개와 같은 두 칸 히어로(components/guide/GuideHero.tsx). */}
      <div className={`relative z-10 hidden w-full flex-1 lg:block ${guideStyles.landingFade}`}>
        <GuideHero
          variant="landing"
          lead={(
            <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="inline-flex">
                <Image
                  src="/nextspot-logo.png"
                  alt="NextSpot"
                  width={505}
                  height={109}
                  priority
                  unoptimized
                  className="nextspot-logo-light h-10 w-auto"
                />
                <Image
                  src="/nextspot-logo-dark.png"
                  alt="NextSpot"
                  width={505}
                  height={109}
                  priority
                  unoptimized
                  className="nextspot-logo-dark h-10 w-auto"
                />
              </span>
              <span className="inline-flex items-center rounded-full border border-gold/30 bg-gold/15 px-3 py-1.5 text-xs font-bold text-gold-deep">
                {t('landing.badge')}
              </span>
            </div>
          )}
          cta={(
            <button
              type="button"
              onClick={go}
              className="toss-pressable inline-flex min-h-[52px] items-center gap-1.5 rounded-full bg-gradient-to-r from-gold to-terracotta px-10 text-[17px] font-bold text-white shadow-[0_8px_24px_rgba(193,85,59,0.28)] hover:from-gold-deep hover:to-terracotta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-deep focus-visible:ring-offset-2 focus-visible:ring-offset-hanji"
            >
              {t('landing.ctaStart')}
              <ChevronRight size={20} aria-hidden />
            </button>
          )}
          aside={<FeatureShortcuts />}
        >
          <div className="mt-3 empty:hidden">
            <FestivalBanner variant="banner" />
          </div>

          {/* 데이터 띠 — 무엇으로 고르는지 한 줄 + 출처 + 출처 표(서비스 소개 '데이터' 절을 펼친 채로 연다).
              공공기관은 출처(ⓒ)로만 적는다 — 운영 주체처럼 쓰지 않는다. */}
          <div className="mt-4 max-w-[560px] rounded-2xl border border-line bg-hanji-deep/80 px-4 py-3">
            <p className="flex items-start gap-2 text-[15px] font-semibold leading-snug text-muk">
              <Database size={17} aria-hidden className="mt-0.5 shrink-0 text-gold-deep" />
              {t('featureMap.dataLine')}
            </p>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-[25px] text-[13px] leading-snug text-muk-soft">
              <span>{t('landing.dataAttribution')}</span>
              <button
                type="button"
                onClick={openDataSection}
                className="toss-pressable inline-flex min-h-8 items-center gap-0.5 rounded font-semibold text-gold-deep underline decoration-gold/40 underline-offset-4 transition-colors hover:text-muk focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-deep"
              >
                {t('featureMap.dataMore')}
                <ChevronRight size={14} aria-hidden />
              </button>
            </p>
          </div>

          {/* 로그인(선택) · 서비스 소개 */}
          <div className="mt-3 flex flex-wrap items-center gap-x-1 text-sm">
            <button
              type="button"
              onClick={goLogin}
              className="toss-pressable inline-flex min-h-11 items-center rounded-lg px-2 font-semibold text-muk-soft underline decoration-line underline-offset-4 transition-colors hover:text-muk focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-deep"
            >
              {t('landing.ctaLogin')}
            </button>
            <span aria-hidden className="text-muk-soft">·</span>
            <span ref={deskTriggerRef} className="contents">
              <GuideButton compact className="min-h-11 px-3" />
            </span>
          </div>
        </GuideHero>
      </div>
    </div>
  );
}
