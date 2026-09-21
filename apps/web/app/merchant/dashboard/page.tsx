'use client';

// 사장님 콘솔 라우트 — 구현은 components/merchant/MerchantConsole.tsx 에 있다(그 파일 머리말 참조).
// 이 파일이 하는 일은 하나다: `?demo=1`(로그인 없는 읽기 전용 데모)인지 읽어 그대로 넘긴다.
//
// Suspense 래핑 — useSearchParams 는 클라이언트 전용 훅이라 정적 export(output:'export') 빌드에서
// CSR bailout 을 피하려면 반드시 Suspense 경계 안에 있어야 한다(app/login/page.tsx 와 같은 관례).

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { MerchantConsole } from '@/components/merchant/MerchantConsole';
import { isDemoParam } from '@/lib/demoFixtures';

function MerchantDashboardRoute() {
  const demo = isDemoParam(useSearchParams().get('demo'));
  return <MerchantConsole demo={demo} />;
}

export default function MerchantDashboardPage() {
  return (
    <Suspense fallback={<div className="min-h-screen w-full bg-hanji" />}>
      <MerchantDashboardRoute />
    </Suspense>
  );
}
