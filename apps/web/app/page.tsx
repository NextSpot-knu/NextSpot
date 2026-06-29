'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoadingPage() {
  const router = useRouter();
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    // Trigger fade-in animation shortly after mount
    const timer = setTimeout(() => {
      setIsVisible(true);
    }, 100);

    // Redirect to /setup after 3 seconds
    const redirectTimer = setTimeout(() => {
      router.push('/setup');
    }, 3000);

    return () => {
      clearTimeout(timer);
      clearTimeout(redirectTimer);
    };
  }, [router]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[url('/bg.png')] bg-cover bg-center relative overflow-hidden">
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
          InduSpot
        </h1>
        <p className="text-lg text-gray-300 font-medium">
          기다림 없는 스마트한 공단 생활
        </p>
      </div>
    </div>
  );
}
