'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Home, Bookmark, User } from 'lucide-react';
import { useState, useEffect } from 'react';

export default function BottomNav() {
  const pathname = usePathname();
  const router = useRouter();

  // 빠른 UI 반응을 위한 낙관적 탭 상태
  const [optimisticTab, setOptimisticTab] = useState<string | null>(null);

  // URL 경로가 변경되면 낙관적 탭 초기화 (페이지 전환 완료 시점)
  useEffect(() => {
    setOptimisticTab(null);
  }, [pathname]);

  // 루트 경로나 지원하지 않는 경로에서는 네비게이션 바 숨김 처리
  if (!pathname || pathname === '/' || pathname.includes('/admin') || pathname.includes('/setup')) return null;

  const tabs = [
    { id: 'Home', icon: Home, label: 'Home', path: '/main' },
    { id: 'Saved', icon: Bookmark, label: 'Saved', path: '/saved' },
    { id: 'MyPage', icon: User, label: 'My Page', path: '/mypage' }
  ];

  const getActiveTab = () => {
    if (optimisticTab) return optimisticTab;
    if (pathname.includes('/saved')) return 'Saved';
    if (pathname.includes('/mypage')) return 'MyPage';
    return 'Home'; // default
  };

  const activeTab = getActiveTab();
  const activeIndex = tabs.findIndex(t => t.id === activeTab);

  const handleTabClick = (tab: { id: string; path: string }) => {
    if (tab.id === activeTab) return;
    
    // 즉각적인 60fps 시각 피드백 제공 (Next.js 렌더링 블락 회피)
    setOptimisticTab(tab.id);
    
    // 애니메이션이 부드럽게 시작할 시간을 주고 라우팅 (프레임 드랍 완전 방지)
    setTimeout(() => {
      router.push(tab.path);
    }, 100);
  };

  return (
    <div className="fixed bottom-0 w-full z-[100] bg-[#0b101e]/90 backdrop-blur-xl border-t border-white/10 px-6 py-4 pb-8">
      <div className="relative flex justify-around items-center w-full">
        {/* CSS GPU-Accelerated Sliding Indicator */}
        <div 
          className="absolute top-0 h-16 w-16 bg-[#104bce]/10 rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.2,0,0,1)] pointer-events-none"
          style={{
            left: `calc(${(activeIndex * 33.333) + 16.666}% - 2rem)`
          }}
        />
        
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabClick(tab)}
              className={`relative z-10 flex flex-col items-center justify-center transition-colors w-16 h-16 ${
                isActive ? 'text-[#104bce]' : 'text-gray-500 hover:text-gray-400'
              }`}
            >
              <div className="mb-1 transition-transform duration-300 ease-out hover:scale-110">
                <Icon size={24} className={isActive ? 'text-[#104bce]' : 'text-gray-500'} />
              </div>
              <span className={`text-xs font-medium ${isActive ? 'text-[#104bce]' : ''}`}>
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
