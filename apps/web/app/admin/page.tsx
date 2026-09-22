'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// 정적 export 환경 — 서버 리다이렉트가 동작하지 않으므로 클라이언트에서 대시보드로 보낸다.
// (접근 권한은 admin/layout 가드가 담당)
export default function AdminPage() {
  const router = useRouter();
  useEffect(() => {
    // 쿼리를 보존한다 — /admin?demo=1 이 대시보드 데모로 이어지고, 레이아웃의 데모 판정과 어긋나지 않게.
    router.replace('/admin/dashboard' + window.location.search);
  }, [router]);
  return null;
}
