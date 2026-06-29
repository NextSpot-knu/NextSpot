'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// 정적 export 환경 — 서버 리다이렉트가 동작하지 않으므로 클라이언트에서 대시보드로 보낸다.
// (접근 권한은 admin/layout 가드가 담당)
export default function AdminPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin/dashboard');
  }, [router]);
  return null;
}
