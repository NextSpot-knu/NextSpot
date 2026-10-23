'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { trackEvent } from '@/lib/usageEvents';

// 화면을 옮길 때마다 page_view 한 건(경로만 — 쿼리·해시는 담지 않는다). 보낼지 말지는 lib/usageEvents 가 정한다.
export function UsageTracker() {
  const pathname = usePathname();
  useEffect(() => {
    trackEvent('page_view');
  }, [pathname]);
  return null;
}
