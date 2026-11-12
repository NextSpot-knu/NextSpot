import assert from 'node:assert/strict';

import { PROGRESS_SEGMENTS, STEP_COUNT, narrationKey, nextStep } from './loadingRevealModel';

// 진행 바: 28초 = 4% + 5% + 7% + 84%, 94% 에서 끝(100% 에 닿지 않는다)
assert.equal(PROGRESS_SEGMENTS.reduce((s, p) => s + p.durationMs, 0), 28_000);
assert.equal(PROGRESS_SEGMENTS[PROGRESS_SEGMENTS.length - 1].toPercent, 94);
assert.deepEqual(PROGRESS_SEGMENTS.map((p) => p.toPercent), [46, 68, 76, 94]);

// 내레이션은 마지막 문장에서 멈춘다
let s = 0;
for (let i = 0; i < 10; i++) s = nextStep(s);
assert.equal(s, STEP_COUNT - 1);

assert.equal(narrationKey('waiting', 0), 'loadingReveal.waiting.step1');
assert.equal(narrationKey('course', 2), 'loadingReveal.course.step3');
assert.equal(narrationKey('shared', 1), 'loadingReveal.shared.step2');
assert.equal(narrationKey('waiting', 0, '서울'), 'region.loadingStep1');
assert.equal(narrationKey('waiting', 1, '서울'), 'loadingReveal.waiting.step2');
assert.equal(narrationKey('course', 0, '서울'), 'loadingReveal.course.step1');

console.log('loadingRevealModel ok');
