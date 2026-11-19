import assert from 'node:assert/strict';

import {
  clearLocationConsentIn,
  hasLocationConsentDecisionIn,
  hasLocationConsentIn,
  LOCATION_CONSENT_KEY,
  LOCATION_TERMS_VERSION,
  MIN_CONSENT_AGE,
  readLocationConsent,
  writeLocationConsent,
} from './consentCore';

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

const now = new Date('2026-11-02T00:00:00.000Z');
assert.equal(MIN_CONSENT_AGE, 14);

// 처음: 결정 없음 → 위치 사용 불가
const s = memoryStore();
assert.equal(hasLocationConsentIn(s), false);
assert.equal(hasLocationConsentDecisionIn(s), false);

// 14세 확인 없는 동의는 받지 않는다(던진다 — 화면이 버튼을 막아야 한다)
assert.throws(() => writeLocationConsent(s, 'granted', false, now));
assert.equal(hasLocationConsentIn(s), false);

// 동의
assert.equal(writeLocationConsent(s, 'granted', true, now), true);
assert.equal(hasLocationConsentIn(s), true);
assert.deepEqual(readLocationConsent(s), {
  decision: 'granted',
  ageConfirmed: true,
  termsVersion: LOCATION_TERMS_VERSION,
  decidedAt: '2026-11-02T00:00:00.000Z',
});

// 거절도 '결정함' 이지만 위치는 못 쓴다
assert.equal(writeLocationConsent(s, 'declined', false, now), true);
assert.equal(hasLocationConsentIn(s), false);
assert.equal(hasLocationConsentDecisionIn(s), true);

// 약관 판이 다르면 결정 없음(다시 묻는다)
s.setItem(
  LOCATION_CONSENT_KEY,
  JSON.stringify({ decision: 'granted', ageConfirmed: true, termsVersion: 'old', decidedAt: now.toISOString() }),
);
assert.equal(hasLocationConsentIn(s), false);
assert.equal(hasLocationConsentDecisionIn(s), false);

// 손으로 고친 기록: 14세 확인 없는 granted 는 무효
s.setItem(
  LOCATION_CONSENT_KEY,
  JSON.stringify({ decision: 'granted', ageConfirmed: false, termsVersion: LOCATION_TERMS_VERSION, decidedAt: 'x' }),
);
assert.equal(hasLocationConsentIn(s), false);
// 깨진 JSON·다른 모양
s.setItem(LOCATION_CONSENT_KEY, '{oops');
assert.equal(hasLocationConsentIn(s), false);
s.setItem(LOCATION_CONSENT_KEY, JSON.stringify({ decision: 'yes' }));
assert.equal(hasLocationConsentDecisionIn(s), false);
s.setItem(LOCATION_CONSENT_KEY, 'true');
assert.equal(hasLocationConsentIn(s), false);

// 지우면 다시 묻는다
writeLocationConsent(s, 'granted', true, now);
clearLocationConsentIn(s);
assert.equal(hasLocationConsentDecisionIn(s), false);

// 저장소를 못 읽으면 '동의 없음'으로 닫는다
assert.equal(hasLocationConsentIn(null), false);
const throwing = {
  getItem: (): string | null => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};
assert.equal(hasLocationConsentIn(throwing), false);
assert.equal(writeLocationConsent(throwing, 'granted', true, now), false, '저장 실패는 false');
assert.equal(writeLocationConsent(null, 'declined', false, now), false);

console.log('consent.test OK');
