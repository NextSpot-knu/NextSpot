'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';

export default function LoadingPage() {
  const router = useRouter();
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
      className="flex flex-col items-center justify-center min-h-screen bg-[url('/bg.png')] bg-cover bg-center relative overflow-hidden cursor-pointer"
    >
      {/* Dark overlay for readability */}
      <div className="absolute inset-0 bg-[#0b101e]/70 z-0"></div>

      {/* Background decoration for glassmorphism feel later */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[300px] bg-blue-600/20 rounded-full blur-[100px] pointer-events-none z-0"></div>

      <div
        className={`z-10 flex flex-col items-center text-center transition-opacity duration-1000 ${
          isVisible ? 'opacity-100 animate-fade-in' : 'opacity-0'
        }`}
      >
        <h1 className="text-5xl font-bold tracking-tight text-white mb-4">
          NextSpot
        </h1>
        <p className="text-lg text-gray-300 font-medium">
          기다림 없는 스마트한 경주 여행
        </p>
      </div>
    </div>
  );
}
