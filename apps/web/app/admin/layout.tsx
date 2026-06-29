'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { isAdminAuthed } from '@/lib/admin-auth';

// 정적 export 에서는 Next 미들웨어가 실행되지 않으므로, /admin/* 보호는
// 이 클라이언트 레이아웃 가드가 담당한다.
//  - 인증 = 로컬 비밀번호 세션(동기). 마운트 후 매 렌더에서 isAdminAuthed() 를 직접 평가한다.
//  - 비동기 상태머신을 쓰지 않으므로 "권한 확인 중" 로더에 영원히 갇히는 일이 없다.
//  - 로그인 페이지(/admin/login)는 공개로 통과. 그 외 /admin/* 는 세션 없으면 로그인으로 보낸다.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const isLoginRoute = pathname === '/admin/login';
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // 마운트 후에만 localStorage 평가(서버 프리렌더/하이드레이션 불일치 방지).
  const authed = mounted && isAdminAuthed();

  useEffect(() => {
    if (mounted && !isLoginRoute && !authed) {
      router.replace('/admin/login');
    }
  }, [mounted, isLoginRoute, authed, pathname, router]);

  // 로그인 페이지는 항상 통과.
  if (isLoginRoute) {
    return <>{children}</>;
  }

  // 마운트 전(프리렌더) 또는 미인증(로그인으로 리다이렉트 진행 중)에는 로더.
  if (!authed) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-[#070b19] text-slate-300">
        <Loader2 className="animate-spin" size={20} />
        <span className="ml-2 text-sm">권한 확인 중…</span>
      </div>
    );
  }

  return <>{children}</>;
}
