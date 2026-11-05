import assert from 'node:assert/strict';

import {
  AI_CONSENT_KEY,
  AI_CONSENT_VERSION,
  aiConsentStatusIn,
  canSendToAiIn,
  clearAiConsentIn,
  readAiConsent,
  writeAiConsent,
} from './aiConsentCore';

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const now = new Date('2026-11-02T00:00:00Z');

// 처음엔 정하지 않았다 — 보내지 않는다.
{
  const s = memoryStore();
  assert.equal(aiConsentStatusIn(s), 'unknown');
  assert.equal(canSendToAiIn(s), false);
}

// 허용 → 보낸다. 철회(허용 안 함) → 보내지 않는다. 지우면 다시 묻는다.
{
  const s = memoryStore();
  assert.equal(writeAiConsent(s, 'granted', now), true);
  assert.equal(aiConsentStatusIn(s), 'granted');
  assert.equal(canSendToAiIn(s), true);
  assert.deepEqual(readAiConsent(s), { decision: 'granted', version: AI_CONSENT_VERSION, decidedAt: now.toISOString() });
  assert.equal(writeAiConsent(s, 'declined', now), true);
  assert.equal(aiConsentStatusIn(s), 'declined');
  assert.equal(canSendToAiIn(s), false);
  clearAiConsentIn(s);
  assert.equal(aiConsentStatusIn(s), 'unknown');
}

// 옛 판·손상·모양이 틀린 기록은 '아직 안 정함'.
{
  const s = memoryStore();
  s.setItem(AI_CONSENT_KEY, JSON.stringify({ decision: 'granted', version: 'old', decidedAt: now.toISOString() }));
  assert.equal(aiConsentStatusIn(s), 'unknown', '판이 바뀌면 다시 묻는다');
  s.setItem(AI_CONSENT_KEY, '{broken');
  assert.equal(aiConsentStatusIn(s), 'unknown');
  s.setItem(AI_CONSENT_KEY, JSON.stringify({ decision: 'yes', version: AI_CONSENT_VERSION, decidedAt: 'x' }));
  assert.equal(canSendToAiIn(s), false);
}

// 저장소가 없거나 막히면 보내지 않는 쪽.
{
  assert.equal(aiConsentStatusIn(null), 'unknown');
  assert.equal(writeAiConsent(null, 'granted', now), false);
  const blocked = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  assert.equal(canSendToAiIn(blocked), false);
  assert.equal(writeAiConsent(blocked, 'granted', now), false);
  clearAiConsentIn(blocked);
}

console.log('aiConsentCore.test OK');
