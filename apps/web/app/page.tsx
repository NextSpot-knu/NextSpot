'use client';

import { useEffect, useState, useCallback, useRef, type MouseEvent } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { useT } from '@/lib/i18n/I18nProvider';
import { warmBackend } from '@/lib/api-client';
import { requestGuideDataSection } from '@/lib/guideDataSection';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { GuideButton } from '@/components/guide/GuideProvider';
import NextSpotMascot from '@/components/NextSpotMascot';

export default function LoadingPage() {
  const router = useRouter();
  const t = useT();
  const [isVisible, setIsVisible] = useState(false);
  // 자동 리다이렉트와 탭 스킵이 겹쳐 중복 이동하는 것을 방지
  const navigatedRef = useRef(false);
  // 첫 방문 서비스 소개 자동 노출용 — 가이드 버튼을 프로그램적으로 눌러 모달을 연다(아래 useEffect).
  const introTriggerRef = useRef<HTMLSpanElement>(null);

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

  // 푸터의 '데이터 출처' 줄 → 서비스 소개 모달의 '데이터' 절. 모달을 여는 경로는 가이드 버튼
  // 하나뿐이라(GuideProvider 의 컨텍스트 API), 여기서도 같은 버튼을 눌러 열고 어느 절을 펼칠지는
  // 모듈 신호로 넘긴다(lib/guideDataSection.ts) — 본문이 dynamic import 라 클릭 직후엔 없다.
  const openDataSection = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation(); // 화면 전체 탭(go)으로 새지 않게
    requestGuideDataSection();
    introTriggerRef.current?.querySelector('button')?.click();
  }, []);

  const goLogin = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    router.push('/login');
  }, [router]);

  useEffect(() => {
    // 첫 화면에서 백엔드 캐시 워밍을 미리 발사 — 사용자가 지도·대기보드·코스에 도달할 즈음
    // 백엔드가 웜 상태가 되게 한다(실패·404 무해, UI 무영향).
    warmBackend();
    // Trigger fade-in animation shortly after mount
    const timer = setTimeout(() => {
      setIsVisible(true);
    }, 100);

    return () => {
      clearTimeout(timer);
    };
  }, [go]);

  // 첫 방문자에게 서비스 소개(가이드)를 자동으로 띄운다 — 아무것도 모르는 심사위원이 첫 화면에서
  // 3초 안에 가치를 이해하도록. 이미 본 사용자·재방문자에겐 안 띄운다(localStorage 게이트).
  // 저장소 차단 환경(사파리 사생활 보호 등)은 조용히 건너뛴다 — 자동 노출만 생략하고 진행은 막지 않는다.
  useEffect(() => {
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
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const markSeen = () => {
      try { window.localStorage.setItem('nextspot_intro_seen', '1'); } catch { /* 저장 실패 무시 */ }
    };
    const tryOpen = () => {
      if (cancelled) return;
      const dialog = document.querySelector('dialog');
      if (dialog?.open) { markSeen(); return; } // 열림 확인 → 완료
      attempts += 1;
      if (attempts > 4) { markSeen(); return; } // 반복 실패 — 다음 방문에 다시 괴롭히지 않는다
      introTriggerRef.current?.querySelector('button')?.click();
      timer = setTimeout(tryOpen, 900);
    };
    timer = setTimeout(tryOpen, 900);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  return (
    <div
      onClick={go}
      className="relative flex min-h-[100dvh] flex-col items-center overflow-x-hidden bg-gradient-to-b from-hanji via-hanji-deep to-sunset-1/25 cursor-pointer"
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

      <div
        className={`z-10 flex w-full flex-1 flex-col items-center justify-center px-6 pb-8 pt-20 text-center transition-opacity duration-1000 ${
          isVisible ? 'opacity-100 animate-fade-in' : 'opacity-0'
        }`}
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
        <span ref={introTriggerRef} className="contents">
          <GuideButton compact className="mt-2 min-h-11 px-5" />
        </span>
      </div>

      {/* 공공데이터 출처 — 누르면 서비스 소개의 '데이터' 절(어떤 공공 API 를 어느 화면에 쓰는지
          표 + 실시간 신선도)이 펼쳐진 채로 열린다. 화면 전체 onClick(go)과 겹치므로 전파를 막는다. */}
      <div className="relative z-10 shrink-0 px-4 pb-3 text-center">
        <button
          type="button"
          onClick={openDataSection}
          className="toss-pressable inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-xs text-muk-soft underline decoration-line underline-offset-4 transition-colors hover:text-muk focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-deep"
        >
          {t('landing.dataAttribution')}
          <ChevronRight size={13} aria-hidden />
          <span className="sr-only">{t('dataTab.footerHint')}</span>
        </button>
      </div>
    </div>
  );
}
