'use client';

import { useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/lib/i18n/I18nProvider';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';

export default function LoadingPage() {
  const router = useRouter();
  const t = useT();
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
    // 자동 이동(3초 타이머)은 제거했다 — 사용자가 '바로 시작'(또는 화면 탭/키 입력)으로 직접 시작한다.
    // 아무 키나 누르면 시작 (포커스와 무관하게 동작하도록 window 에 부착)
    const handleKey = () => go();
    window.addEventListener('keydown', handleKey);

    return () => {
      window.removeEventListener('keydown', handleKey);
    };
  }, [go]);

  return (
    <div
      onClick={go}
      className="min-h-screen bg-hanji text-muk relative overflow-hidden cursor-pointer"
    >
      {/* 언어 선택 — 진입 즉시 외국인 관광객이 전환 가능(부모 onClick 이동 방지) */}
      <div className="absolute top-4 right-4 z-20" onClick={(e) => e.stopPropagation()}>
        <LanguageSwitcher />
      </div>

      {/* 대릉원 능선은 장식보다 장소감을 주는 배경으로만 낮게 사용한다. */}
      <svg
        viewBox="0 0 1440 240"
        preserveAspectRatio="xMidYMax slice"
        className="absolute bottom-0 inset-x-0 w-full h-[30vh] min-h-[180px] pointer-events-none z-0"
        aria-hidden="true"
      >
        <path d="M-80 240 Q 260 40 620 240 Z" fill="var(--color-jade)" fillOpacity="0.09" />
        <path d="M520 240 Q 900 10 1300 240 Z" fill="var(--color-jade)" fillOpacity="0.09" />
        <path d="M-200 240 Q 120 90 460 240 Z" fill="var(--color-jade)" fillOpacity="0.18" />
        <path d="M880 240 Q 1240 70 1620 240 Z" fill="var(--color-jade)" fillOpacity="0.18" />
      </svg>

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-md flex-col px-6 pb-14 pt-7">
        <div className="text-sm font-semibold tracking-tight text-muk">NextSpot</div>

        <div className="mt-[18vh] text-left">
          <p className="mb-3 text-xs font-bold tracking-[0.16em] text-jade">GYEONGJU · NOW</p>
          <h1 className="max-w-[340px] whitespace-pre-line font-serif text-[2.3rem] font-bold leading-[1.22] tracking-[-0.035em] text-muk">
            {t('landing.tagline')}
          </h1>
          <p className="mt-5 max-w-[320px] text-[15px] leading-7 text-muk-soft">
            {t('landing.value1')} {t('landing.value2')} {t('landing.value3')}
          </p>
        </div>

        <div className="mt-auto">
        <button
          onClick={(e) => {
            e.stopPropagation();
            go();
          }}
          className="w-full border border-muk bg-muk px-6 py-4 text-left text-[15px] font-bold text-hanji transition-colors hover:bg-jade focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jade focus-visible:ring-offset-2 focus-visible:ring-offset-hanji"
        >
          {t('landing.ctaStart')} <span aria-hidden className="float-right">→</span>
        </button>

        {/* 보조 CTA — 로그인은 선택이다. 기기 간 동기화를 원하는 사용자만 여기로 가고,
            게스트로 쌓은 저장·취향은 나중에 가입해도 그대로 승계된다(익명→정회원 전환, uid 유지). */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            goLogin();
          }}
          className="mt-3 w-full py-2 text-left text-sm font-medium text-muk-soft transition-colors hover:text-muk focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jade"
        >
          {t('landing.ctaLogin')}
        </button>
        </div>
      </div>
    </div>
  );
}
