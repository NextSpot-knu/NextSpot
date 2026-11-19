// 외부 AI 전송 허용 — 앱 전체가 부르는 입구. 규칙·형식은 aiConsentCore.ts.
//
// 입력한 문장을 외부 AI 로 보낼 수 있는 화면(홈 검색 폴백 · 여행 상황 변경 · 실험실 직접 설명하기)은 보내기 **전에**
// canSendToAi() 를 본다. 'unknown' 이면 처음 쓸 때 묻는다(promptAiConsent 또는 AiConsentNotice 의 허용 · 허용 안 함).
import { Alert } from 'react-native';

import {
  aiConsentStatusIn,
  canSendToAiIn,
  clearAiConsentIn,
  readAiConsent,
  writeAiConsent,
  type AiConsentDecision,
  type AiConsentRecord,
  type AiConsentStatus,
} from './aiConsentCore';

export {
  AI_CONSENT_KEY,
  AI_CONSENT_VERSION,
  type AiConsentDecision,
  type AiConsentRecord,
  type AiConsentStatus,
} from './aiConsentCore';

function store(): Storage | null {
  return (globalThis as { localStorage?: Storage }).localStorage ?? null;
}

const listeners = new Set<() => void>();
function emit(): void {
  for (const l of [...listeners]) l();
}

export function getAiConsentStatus(): AiConsentStatus {
  return aiConsentStatusIn(store());
}

export function canSendToAi(): boolean {
  return canSendToAiIn(store());
}

export function getAiConsent(): AiConsentRecord | null {
  return readAiConsent(store());
}

/** 결정을 적고 듣는 쪽에 알린다. 저장에 실패하면 false(호출부는 허용받지 못한 것으로 다룬다). */
export function setAiConsent(decision: AiConsentDecision): boolean {
  const ok = writeAiConsent(store(), decision, new Date());
  emit();
  return ok;
}

/** 기록을 지운다 — 다음 사용 때 다시 묻는다. */
export function clearAiConsent(): void {
  clearAiConsentIn(store());
  emit();
}

export function subscribeAiConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type Translate = (key: string) => string;

let pending: Promise<AiConsentStatus> | null = null;
/** 창을 닫기만 하고(안드로이드 바깥 누름) 고르지 않았으면 이번 실행 동안은 다시 띄우지 않는다 — 검색마다 묻지 않게. */
let dismissedThisRun = false;

/**
 * 처음 쓸 때 묻는 시스템 창 — '허용 안 함' · '허용'. 이미 정했으면 묻지 않고 그 값을 돌려준다.
 * 고르지 않고 닫으면 기록하지 않는다(정하지 않았으면 'unknown' — 보내지 않는다). 동시에 여러 번 불러도 창은 하나다.
 * force: 이미 정했어도 다시 묻는다(설정 화면의 '허용하기').
 */
export function promptAiConsent(t: Translate, options: { force?: boolean } = {}): Promise<AiConsentStatus> {
  const current = getAiConsentStatus();
  if (!options.force) {
    if (current !== 'unknown') return Promise.resolve(current);
    if (dismissedThisRun) return Promise.resolve('unknown');
  }
  if (pending) return pending;
  pending = new Promise<AiConsentStatus>((resolve) => {
    let settled = false;
    const done = (decision: AiConsentDecision | null) => {
      if (settled) return; // 버튼과 닫기가 함께 불려도 한 번만
      settled = true;
      pending = null;
      if (!decision) {
        if (!options.force) dismissedThisRun = true;
        resolve(getAiConsentStatus());
        return;
      }
      setAiConsent(decision);
      resolve(getAiConsentStatus());
    };
    Alert.alert(
      t('app.aiConsent.promptTitle'),
      t('app.aiConsent.promptBody'),
      [
        { text: t('app.aiConsent.decline'), style: 'cancel', onPress: () => done('declined') },
        { text: t('app.aiConsent.allow'), onPress: () => done('granted') },
      ],
      { cancelable: true, onDismiss: () => done(null) },
    );
  });
  return pending;
}
