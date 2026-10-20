'use client';

import { useSyncExternalStore } from 'react';
import { MAP_DESKTOP_MIN_WIDTH } from './mainPanelLayout';

// 지도 배치만 간결하게 표시할 폭. 주 내비게이션의 md 경계와는 독립적이다.
export const COMPACT_MAP_VIEWPORT_QUERY = `(max-width: ${MAP_DESKTOP_MIN_WIDTH - 1}px)`;
let compactMapQuery: MediaQueryList | null = null;

function queryList(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  if (!compactMapQuery) compactMapQuery = window.matchMedia(COMPACT_MAP_VIEWPORT_QUERY);
  return compactMapQuery;
}

export function isCompactMapViewportNow(): boolean {
  return queryList()?.matches ?? false;
}

function subscribe(onChange: () => void): () => void {
  const query = queryList();
  if (!query) return () => {};
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export function useCompactMapViewport(): boolean {
  return useSyncExternalStore(subscribe, isCompactMapViewportNow, () => false);
}
