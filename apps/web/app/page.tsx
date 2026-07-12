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

  // 온보딩 흔적(localStorage 'nextspot_setup_prefs')이 있으면 /main 으로 바이패스, 없으면 /setup
  const resolveDestination = useCallback(() => {
    if (typeof window !== 'undefined' && window.localStorage.getItem('nextspot_setup_prefs')) {
      return '/main';
    }
    return '/setup';
  }, []);

  // 실제 이동 (한 번만 실행)
  const go = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    router.push(resolveDestination());
  }, [router, resolveDestination]);

  useEffect(() => {
    // Trigger fade-in animation shortly after mount
    const timer = setTimeout(() => {
      setIsVisible(true);
    }, 100);

    // 3초 후 자동 이동 (흔적 있으면 /main, 없으면 /setup)
    const redirectTimer = setTimeout(() => {
      go();
    }, 3000);

    // 아무 키나 누르면 즉시 스킵 (포커스와 무관하게 동작하도록 window 에 부착)
    const handleKey = () => go();
    window.addEventListener('keydown', handleKey);

    return () => {
      clearTimeout(timer);
      clearTimeout(redirectTimer);
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

        {/* '바로 시작' CTA — 3초 자동 이동/탭 스킵과 동일한 go() 재사용 */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            go();
          }}
          className="mt-8 px-8 py-3.5 rounded-full bg-gold hover:bg-gold-deep text-white font-bold text-base shadow-[0_8px_24px_rgba(197,148,74,0.35)] transition-colors"
        >
          {t('landing.ctaStart')}
        </button>
      </div>
    </div>
  );
}
