import assert from 'node:assert/strict';

import {
  isPredictModelTrained,
  parsePredictModelInfo,
  resetPredictModelGateForTest,
  type PredictModelInfo,
} from './predictModel';

// 응답 모양 — 모르면 null(학습됐다고 지어내지 않는다).
assert.deepEqual(parsePredictModelInfo({ trained: false, fallback_state: 'degraded_rules' }), {
  trained: false,
  fallbackState: 'degraded_rules',
});
assert.deepEqual(parsePredictModelInfo({ trained: true }), { trained: true, fallbackState: null });
assert.equal(parsePredictModelInfo({ trained: 'false' }), null);
assert.equal(parsePredictModelInfo(null), null);
assert.equal(parsePredictModelInfo('ok'), null);

async function main() {
  // 세션당 한 번만 묻는다 — 카드를 몇 번 펼쳐도 model-info 는 한 번.
  resetPredictModelGateForTest();
  let calls = 0;
  const untrained = async (): Promise<PredictModelInfo> => { calls += 1; return { trained: false, fallbackState: 'degraded_rules' }; };
  const answers = await Promise.all([isPredictModelTrained(untrained), isPredictModelTrained(untrained), isPredictModelTrained(untrained)]);
  assert.deepEqual(answers, [false, false, false]);
  assert.equal(await isPredictModelTrained(untrained), false);
  assert.equal(calls, 1, 'model-info 를 두 번 이상 물었다');

  // 학습된 모델이면 true.
  resetPredictModelGateForTest();
  assert.equal(await isPredictModelTrained(async () => ({ trained: true, fallbackState: null })), true);

  // 묻지 못했으면(네트워크 실패·모양 오류) 학습 안 됨으로 본다 — /predict/day 를 부르지 않는다.
  resetPredictModelGateForTest();
  assert.equal(await isPredictModelTrained(async () => null), false);
  resetPredictModelGateForTest();
  assert.equal(await isPredictModelTrained(async () => { throw new Error('network'); }), false);

  console.log('predictModel tests passed');
}

void main();
