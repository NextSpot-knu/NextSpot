'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/lib/i18n/I18nProvider';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';

export default function LoadingPage() {
  const router = useRouter();
  const t = useT();
  const [isVisible, setIsVisible] = useState(false);
  // 자동 리다이렉트와 탭 스킵이 겹쳐 중복 이동하는 것을 방지
  const navigatedRef = useRef(false);

  // '바로 시작'은 로그인 없이 곧장 온보딩(→ /setup)으로 보낸다 — 관광객 무마찰이 이 제품의 핵심 원칙이고
  // 발표 대본(docs/DEMO_SCENARIO.md "이 전체 흐름이 로그인 절차 없이 3분 안에 끝납니다")과
  // JUDGE_QA Q10("로그인 UI 없이도 동작한다")이 이 경로를 전제로 한다.
  // 온보딩 흔적이 있으면 /main 으로 바이패스(재방문자가 3문항을 다시 겪지 않게).
  // 로그인/회원가입은 아래 보조 CTA 로 언제든 갈 수 있고, 게스트로 쌓은 데이터는 가입 시 승계된다
  // (익명→정회원 전환은 uid 유지 — docs/AUTH_MEMBERSHIP_PLAN.md).
  const go = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    const seen = typeof window !== 'undefined' && window.localStorage.getItem('nextspot_setup_prefs');
    router.push(seen ? '/main' : '/setup');
  }, [router]);

  const goLogin = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    router.push('/login');
  }, [router]);

  useEffect(() => {
    // Trigger fade-in animation shortly after mount
    const timer = setTimeout(() => {
      setIsVisible(true);
    }, 100);

    // 자동 이동(3초 타이머)은 제거했다 — 사용자가 '바로 시작'(또는 화면 탭/키 입력)으로 직접 시작한다.
    // 아무 키나 누르면 시작 (포커스와 무관하게 동작하도록 window 에 부착)
    const handleKey = () => go();
    window.addEventListener('keydown', handleKey);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKey);
    };
  }, [go]);

  return (
    <div
      onClick={go}
      className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-hanji via-hanji-deep to-sunset-1/25 relative overflow-hidden cursor-pointer"
    >
      {/* 언어 선택 — 진입 즉시 외국인 관광객이 전환 가능(부모 onClick 이동 방지) */}
      <div className="absolute top-4 right-4 z-20" onClick={(e) => e.stopPropagation()}>
        <LanguageSwitcher />
      </div>

      {/* 은은한 금빛 광원 (기존 콜드 blue 글로우 대체) */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[300px] bg-gold/15 rounded-full blur-[100px] pointer-events-none z-0"></div>

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
        className={`z-10 flex flex-col items-center text-center transition-opacity duration-1000 ${
          isVisible ? 'opacity-100 animate-fade-in' : 'opacity-0'
        }`}
      >
        <h1 className="text-5xl font-serif font-bold tracking-tight text-muk mb-4">
          NextSpot
        </h1>
        <p className="text-lg text-muk-soft font-medium">
          {t('landing.tagline')}
        </p>

        {/* 가치 선전달: 도착 전 핵심 가치 3가지를 먼저 보여줘 이탈을 줄인다 */}
        <ul className="mt-6 flex flex-col items-center gap-1.5 text-sm text-muk-soft">
          <li>{t('landing.value1')}</li>
          <li>{t('landing.value2')}</li>
          <li>{t('landing.value3')}</li>
        </ul>

        {/* '바로 시작'(게스트, 로그인 불필요) — 화면 탭/키 입력과 동일한 go() 재사용 */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            go();
          }}
          className="mt-8 px-8 py-3.5 rounded-full bg-gold hover:bg-gold-deep text-white font-bold text-base shadow-[0_8px_24px_rgba(197,148,74,0.35)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-deep focus-visible:ring-offset-2 focus-visible:ring-offset-hanji"
        >
          {t('landing.ctaStart')}
        </button>

        {/* 보조 CTA — 로그인은 선택이다. 기기 간 동기화를 원하는 사용자만 여기로 가고,
            게스트로 쌓은 저장·취향은 나중에 가입해도 그대로 승계된다(익명→정회원 전환, uid 유지). */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            goLogin();
          }}
          className="mt-3 px-4 py-2 text-sm font-medium text-muk-soft hover:text-muk underline underline-offset-4 decoration-line transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-deep rounded-lg"
        >
          {t('landing.ctaLogin')}
        </button>
      </div>
    </div>
  );
}
