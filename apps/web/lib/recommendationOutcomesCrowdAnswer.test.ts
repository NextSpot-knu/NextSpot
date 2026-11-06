import assert from 'node:assert/strict';
import {
  CROWD_ANSWER_EVENT,
  flushRecommendationOutcomes,
  isUnrecordedCrowdAnswer,
  readCrowdAnswer,
  type CrowdAnswerDetail,
} from './recommendationOutcomes';
import { apiClient } from './api-client';

// D3 M3: 서버가 게스트 혼잡 답을 저장하지 않았으면(crowd_answer not_recorded_*) 방문 확인 카드가 '기록했어요' 만
// 보여 주지 않고 중립 문장을 단다. 응답은 큐 전송 뒤에 오므로 flush 가 창 이벤트로 알린다.

assert.equal(readCrowdAnswer({ success: true, crowdAnswer: 'guest_shadow' }), 'guest_shadow');
assert.equal(readCrowdAnswer({ success: true }), null);
assert.equal(readCrowdAnswer(null), null);
for (const code of ['not_recorded_shared_network', 'not_recorded_cooldown', 'not_recorded_pending_migration']) {
  assert.equal(isUnrecordedCrowdAnswer(code), true, code);
}
for (const code of ['registered', 'guest_shadow', 'guest_live', null, undefined]) {
  assert.equal(isUnrecordedCrowdAnswer(code), false, String(code));
}

const store = new Map<string, string>();
const events: CrowdAnswerDetail[] = [];
const localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as Record<string, unknown>).localStorage = localStorage;
(globalThis as Record<string, unknown>).window = {
  localStorage,
  dispatchEvent: (event: Event) => {
    if (event.type === CROWD_ANSWER_EVENT) events.push((event as CustomEvent<CrowdAnswerDetail>).detail);
    return true;
  },
};

const REC_A = '11111111-1111-4111-8111-111111111111';
const REC_B = '22222222-2222-4222-8222-222222222222';

void (async () => {
  (apiClient as unknown as { patch: (p: string, b?: unknown) => Promise<unknown> }).patch = async (path: string) =>
    path.includes(REC_A) ? { success: true, crowdAnswer: 'not_recorded_shared_network' } : { success: true };
  store.set('nextspot_recommendation_outcome_queue', JSON.stringify([
    { recommendationId: REC_A, stage: 'rated', rating: 'up', observedCongestion: 'busy', queuedAt: Date.now() - 2000 },
    // 답 없이 평가만 — 알릴 혼잡 답이 없다.
    { recommendationId: REC_B, stage: 'rated', rating: 'down', queuedAt: Date.now() - 1000 },
  ]));
  await flushRecommendationOutcomes();
  assert.deepEqual(events, [{ recommendationId: REC_A, crowdAnswer: 'not_recorded_shared_network' }]);
  console.log('recommendationOutcomes crowd answer tests passed');
})();
