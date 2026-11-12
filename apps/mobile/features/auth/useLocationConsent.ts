// 위치정보 이용 동의 상태를 구독하는 훅 — 설정에서 철회하거나 동의하면 위치를 쓰는 화면이 바로 따라간다.
import { useSyncExternalStore } from 'react';

import { hasLocationConsent, subscribeLocationConsent } from './consent';

function subscribe(onChange: () => void): () => void {
  return subscribeLocationConsent(() => onChange());
}

/** hasLocationConsent() 의 현재 값. 바뀌면 다시 그린다. */
export function useLocationConsent(): boolean {
  return useSyncExternalStore(subscribe, hasLocationConsent, hasLocationConsent);
}
