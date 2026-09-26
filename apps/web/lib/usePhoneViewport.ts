'use client';

import { useSyncExternalStore } from 'react';

// Tailwind `md` 경계(768px)의 바로 아래 — globals.css 의 `--tourist-nav-clearance` 모바일 값과 같은 질의다.
// 휴대폰 전용 배치(예: /main 추천 카드의 짧은 미리보기)를 켤지 판단한다. 태블릿·데스크톱은 false.
export const PHONE_VIEWPORT_QUERY = '(max-width: 767px)';

// MediaQueryList 는 한 번 만들어 두면 폭이 바뀔 때 matches 가 스스로 갱신된다. useSyncExternalStore 는
// 렌더마다 스냅샷을 두 번 이상 읽으므로 그때마다 새로 만들지 않게 **처음 읽을 때** 만든다(모듈 로드
// 시점에는 window 를 건드리지 않는다 — 정적 export 프리렌더에는 window 가 없다).
let phoneQuery: MediaQueryList | null = null;

function phoneQueryList(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  if (!phoneQuery) phoneQuery = window.matchMedia(PHONE_VIEWPORT_QUERY);
  return phoneQuery;
}

/** 지금 이 순간 휴대폰 폭인가 — 첫 렌더의 useState 초기값처럼 구독 없이 한 번 읽을 때 쓴다. */
export function isPhoneViewportNow(): boolean {
  return phoneQueryList()?.matches ?? false;
}

function subscribe(onChange: () => void): () => void {
  const query = phoneQueryList();
  if (!query) return () => {};
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** 휴대폰 폭(<768px) 여부를 구독한다. 서버 렌더(정적 export 프리렌더)에서는 false. */
export function usePhoneViewport(): boolean {
  return useSyncExternalStore(subscribe, isPhoneViewportNow, () => false);
}
