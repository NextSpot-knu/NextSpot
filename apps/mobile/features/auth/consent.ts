// 위치정보 이용 동의 — 앱 전체가 부르는 입구. 규칙·형식은 consentCore.ts.
//
// 다른 화면(홈의 위치 권한 안내, 대안 추천, 코스)은 위치를 읽기 **전에** 반드시 hasLocationConsent() 를 본다.
// false 면 OS 권한 창을 띄우지도, 좌표를 읽지도, 서버에 보내지도 않고 황리단길 중심으로 추천한다.
import {
  clearLocationConsentIn,
  hasLocationConsentDecisionIn,
  hasLocationConsentIn,
  readLocationConsent,
  writeLocationConsent,
  type ConsentDecision,
  type LocationConsentRecord,
} from './consentCore';

export {
  LOCATION_CONSENT_KEY,
  LOCATION_TERMS_VERSION,
  MIN_CONSENT_AGE,
  type ConsentDecision,
  type LocationConsentRecord,
} from './consentCore';

function store(): Storage | null {
  return (globalThis as { localStorage?: Storage }).localStorage ?? null;
}

type Listener = (granted: boolean) => void;
const listeners = new Set<Listener>();

/** 위치정보 이용에 동의했는가(현재 약관 판 · 만 14세 이상 확인). 못 읽으면 false. */
export function hasLocationConsent(): boolean {
  return hasLocationConsentIn(store());
}

/** 동의·거절 중 하나를 이미 골랐는가(첫 실행 단계 판정용). */
export function hasLocationConsentDecision(): boolean {
  return hasLocationConsentDecisionIn(store());
}

export function getLocationConsent(): LocationConsentRecord | null {
  return readLocationConsent(store());
}

/** 결정을 적고 듣는 쪽에 알린다. 저장에 실패하면 false. 'granted' 는 ageConfirmed 가 true 여야 한다. */
export function setLocationConsent(decision: ConsentDecision, ageConfirmed: boolean): boolean {
  const ok = writeLocationConsent(store(), decision, ageConfirmed, new Date());
  const granted = hasLocationConsent();
  for (const l of [...listeners]) l(granted);
  return ok;
}

/** 기록을 지운다 — 다음 첫 실행 판정에서 다시 묻는다. */
export function clearLocationConsent(): void {
  clearLocationConsentIn(store());
  for (const l of [...listeners]) l(false);
}

/** 동의 상태가 바뀌면 알린다(설정에서 철회했을 때 홈이 위치 사용을 멈추게). */
export function subscribeLocationConsent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
