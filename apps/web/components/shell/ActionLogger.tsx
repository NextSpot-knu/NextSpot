'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { installActionLog, logAction, sanitizeQuery } from '@/lib/actionLog';

// 접속·조작 기록(lib/actionLog) — 한 번 설치하고, 화면(경로)이 바뀔 때마다 page_view 한 줄.
// 같은 경로에서 쿼리만 바뀐 이동(검색 조건 등)은 lib/actionLog 가 history 를 감싸 page_view(nav='query')로 남긴다 —
// 여기서 useSearchParams 를 쓰면 정적 export 프리렌더에 Suspense 경계가 필요해진다.
// 익명 이용 기록(UsageTracker)과 별개다. 남길지 말지(운영 주소 · 자동화 아님)는 lib/actionLog 가 정한다.
export function ActionLogger() {
  const pathname = usePathname();
  const previous = useRef<string | null>(null);

  useEffect(() => {
    installActionLog();
  }, []);

  useEffect(() => {
    // 개발 모드 StrictMode 의 이중 실행은 한 번으로 친다(같은 경로를 두 번 남기지 않는다).
    if (!pathname || previous.current === pathname) return;
    const from = previous.current;
    previous.current = pathname;
    logAction('page_view', { from, nav: from === null ? 'load' : 'route', query: sanitizeQuery(window.location.search) });
  }, [pathname]);

  return null;
}
