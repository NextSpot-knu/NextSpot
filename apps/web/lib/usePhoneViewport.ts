'use client';

import { useSyncExternalStore } from 'react';

// Tailwind `md` 경계(768px)의 바로 아래 — globals.css 의 `--tourist-nav-clearance` 모바일 값과 같은 질의다.
// 휴대폰 전용 배치(예: /main 추천 카드의 짧은 미리보기)를 켤지 판단한다. 태블릿·데스크톱은 false.
export const PHONE_VIEWPORT_QUERY = '(max-width: 767px)';

/** 지금 이 순간 휴대폰 폭인가 — 첫 렌더의 useState 초기값처럼 구독 없이 한 번 읽을 때 쓴다. */
export function isPhoneViewportNow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(PHONE_VIEWPORT_QUERY).matches;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(PHONE_VIEWPORT_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** 휴대폰 폭(<768px) 여부를 구독한다. 서버 렌더(정적 export 프리렌더)에서는 false. */
export function usePhoneViewport(): boolean {
  return useSyncExternalStore(subscribe, isPhoneViewportNow, () => false);
}
