'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Home, Bookmark, Route, User } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useT } from '@/lib/i18n/I18nProvider';

// 관광객 앱 주 내비게이션 — 반응형:
//  · 데스크톱(md+): 왼쪽 세로 레일(인플로우 flex 자식 → 콘텐츠 폭을 차지).
//  · 모바일(<md): 기존 하단 가로 바(fixed 오버레이 → 페이지는 pb-[120px] 로 클리어런스 확보).
// 숨김 경로에서는 null 을 반환하므로 레이아웃 flex-row 에서 레일이 사라지면 콘텐츠가 전체폭을 차지한다.
export default function BottomNav() {
  const pathname = usePathname();
  const router = useRouter();
  const t = useT();

  // 빠른 UI 반응을 위한 낙관적 탭 상태
  const [optimisticTab, setOptimisticTab] = useState<string | null>(null);

  // URL 경로가 변경되면 낙관적 탭 초기화 (페이지 전환 완료 시점)
  useEffect(() => {
    setOptimisticTab(null);
  }, [pathname]);

  // 루트 경로나 지원하지 않는 경로에서는 네비게이션 숨김 처리
  if (!pathname || pathname === '/' || pathname.includes('/admin') || pathname.includes('/merchant') || pathname.includes('/setup')) return null;

  const tabs = [
    { id: 'Home', icon: Home, label: t('nav.home'), path: '/main' },
    { id: 'Saved', icon: Bookmark, label: t('nav.saved'), path: '/saved' },
    { id: 'Course', icon: Route, label: t('nav.course'), path: '/course' },
    { id: 'MyPage', icon: User, label: t('nav.mypage'), path: '/mypage' }
  ];

  const getActiveTab = () => {
    if (optimisticTab) return optimisticTab;
    if (pathname.includes('/saved')) return 'Saved';
    if (pathname.includes('/course')) return 'Course';
    if (pathname.includes('/mypage')) return 'MyPage';
    return 'Home'; // default
  };

  const activeTab = getActiveTab();
  const activeIndex = tabs.findIndex(t => t.id === activeTab);

  const handleTabClick = (tab: { id: string; path: string }) => {
    if (tab.id === activeTab) return;

    // 즉각적인 시각 피드백 제공 (Next.js 렌더링 블락 회피)
    setOptimisticTab(tab.id);

    // 인위적 지연 없이 즉시 라우팅 (낙관적 인디케이터는 위에서 이미 갱신됨)
    router.push(tab.path);
  };

  return (
    <>
      {/* ── 데스크톱: 왼쪽 세로 레일 (인플로우) ── */}
      <nav
        aria-label="주요 내비게이션"
        className="hidden md:flex shrink-0 w-[76px] sticky top-0 h-screen z-40 bg-white/90 backdrop-blur-xl border-r border-line shadow-[2px_0_14px_rgba(43,35,32,0.06)] flex-col items-center py-6"
      >
        {/* 워드마크(신라금 명조 이니셜) */}
        <div className="w-10 h-10 rounded-2xl bg-gold/10 border border-gold/25 flex items-center justify-center mb-8">
          <span className="font-serif font-black text-gold-deep text-lg leading-none">N</span>
        </div>

        <div className="relative flex flex-col items-center gap-2">
          {/* 활성 탭 세로 슬라이딩 인디케이터 */}
          <div
            className="absolute left-0 w-16 h-16 bg-gold/15 rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.2,0,0,1)] pointer-events-none"
            style={{ top: `calc(${activeIndex} * 4.5rem)` }}
          />
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => handleTabClick(tab)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative z-10 flex flex-col items-center justify-center gap-1 transition-colors w-16 h-16 rounded-2xl ${
                  isActive ? 'text-gold-deep' : 'text-muk-soft hover:text-muk'
                }`}
              >
                <div className="transition-transform duration-300 ease-out hover:scale-110">
                  <Icon size={24} className={isActive ? 'text-gold-deep' : 'text-muk-soft'} />
                </div>
                <span className={`text-[11px] font-medium ${isActive ? 'text-gold-deep' : ''}`}>
                  {tab.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* ── 모바일: 하단 가로 바 (fixed 오버레이) ── */}
      <nav
        aria-label="주요 내비게이션"
        className="md:hidden fixed bottom-0 left-0 w-full z-40 bg-white/90 backdrop-blur-xl border-t border-line shadow-[0_-2px_14px_rgba(43,35,32,0.06)] px-6 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
      >
        <div className="relative flex justify-around items-center w-full">
          {/* 활성 탭 가로 슬라이딩 인디케이터 — 탭 수 기반 일반화(중심 = (idx+0.5)/N). */}
          <div
            className="absolute top-0 h-12 w-14 bg-gold/15 rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.2,0,0,1)] pointer-events-none"
            style={{ left: `calc(${(activeIndex + 0.5) * (100 / tabs.length)}% - 1.75rem)` }}
          />
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => handleTabClick(tab)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative z-10 flex flex-col items-center justify-center transition-colors w-14 h-12 ${
                  isActive ? 'text-gold-deep' : 'text-muk-soft hover:text-muk'
                }`}
              >
                <div className="mb-0.5 transition-transform duration-300 ease-out hover:scale-110">
                  <Icon size={22} className={isActive ? 'text-gold-deep' : 'text-muk-soft'} />
                </div>
                <span className={`text-[11px] font-medium ${isActive ? 'text-gold-deep' : ''}`}>
                  {tab.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
}
