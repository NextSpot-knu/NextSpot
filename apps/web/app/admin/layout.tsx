'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAccount, canEnterAdminConsole } from '@/lib/account';

// 정적 export 에서는 Next 미들웨어가 실행되지 않으므로, /admin/* 보호는
// 이 클라이언트 레이아웃 가드가 담당한다.
//  - 인증 = Supabase 계정 + users.role ∈ {admin, developer}. 판정은 lib/account.tsx 단일 출처.
//    (예전엔 번들에 박힌 비밀번호와 localStorage 플래그였다 — 콘솔 한 줄로 통과 가능했다.)
//  - 이 가드는 UX 일 뿐이다. 우회해도 관리자 API 는 서버가 매 요청 role 을 확인해 403 을 낸다.
//  - status==='loading' 동안만 로더를 보인다. /account/me 가 실패하면 status='error' 로 끝나므로
//    "권한 확인 중" 에 영원히 갇히지 않는다(로그인 화면으로 보낸다).
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
  const { account, status } = useAccount();
  const resolved = mounted && status !== 'loading';
  const authed = resolved && canEnterAdminConsole(account);

  useEffect(() => {
    if (resolved && !isLoginRoute && !authed) {
      router.replace('/admin/login');
    }
  }, [resolved, isLoginRoute, authed, pathname, router]);

  // 로그인 페이지는 항상 통과.
  if (isLoginRoute) {
    return <>{children}</>;
  }

  // 마운트 전(프리렌더) 또는 미인증(로그인으로 리다이렉트 진행 중)에는 로더.
  if (!authed) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-hanok text-hanok-muted">
        <Loader2 className="animate-spin" size={20} />
        <span className="ml-2 text-sm">권한 확인 중…</span>
      </div>
    );
  }

  return <>{children}</>;
}
