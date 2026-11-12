// 외부 AI 전송 허용 상태를 구독하는 훅 — 설정에서 철회하면 자유 입력 칸이 바로 꺼진다.
import { useCallback, useSyncExternalStore } from 'react';

import { getAiConsentStatus, setAiConsent, subscribeAiConsent, type AiConsentStatus } from './aiConsent';

export interface AiConsentState {
  status: AiConsentStatus;
  /** 'granted' 일 때만 true — 이때만 입력한 문장을 보낸다. */
  allowed: boolean;
  /** 허용을 적는다. 저장에 실패하면 false. */
  allow: () => boolean;
  /** 허용 안 함(철회 포함)을 적는다. */
  decline: () => boolean;
}

export function useAiConsent(): AiConsentState {
  const status = useSyncExternalStore(subscribeAiConsent, getAiConsentStatus, getAiConsentStatus);
  const allow = useCallback(() => setAiConsent('granted'), []);
  const decline = useCallback(() => setAiConsent('declined'), []);
  return { status, allowed: status === 'granted', allow, decline };
}
