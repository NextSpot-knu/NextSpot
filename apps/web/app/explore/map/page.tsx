'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// 지도 정본은 /main(Home)으로 통합됨 — 히트맵·예측 타임슬라이더가 /main 에 이식되어
// 중복이던 CongestionMap(/explore/map)은 제거했다. 구 경로로 들어오면 /main 으로 보낸다.
export default function ExploreMapRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/main');
  }, [router]);
  return null;
}
