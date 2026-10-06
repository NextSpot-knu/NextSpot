// 레이더 출처 배지(리뷰 10-07) — 새 게스트에게 '실시간 학습 반영' 을 붙이지 않는다. node:assert 독립 스크립트.
import assert from 'node:assert/strict';
import { tasteBadge } from './tasteBadge';

const uniform = new Array(8).fill(1 / Math.sqrt(8));
const onboarding = [0.6, 0.5, 0.4, 0.2, 0.2, 0.2, 0.2, 0.2];
const learned = [0.75, 0.35, 0.4, 0.2, 0.15, 0.2, 0.2, 0.2];

// 서버가 돌려준 균등 벡터(벡터가 아직 없는 새 게스트) — 배우지 않았다.
assert.equal(tasteBadge('learned', uniform, { uniform, onboarding: null }, true), null, '균등 벡터에 학습 배지');
assert.equal(tasteBadge('learned', uniform, { uniform, onboarding }, true), 'onboarding');
// 처음 고른 취향과 같은 서버 벡터 — 아직 '처음 고른 취향 반영'.
assert.equal(tasteBadge('learned', onboarding.map((v) => v + 0.005), { uniform, onboarding }, true), 'onboarding');
// 서버가 /setup 취향으로 따로 만든 첫 벡터(화면의 온보딩 벡터와 값이 다르다) — 학습 행동 전이면 학습을 말하지 않는다
// (리뷰 10-07 화면: 저장·방문 0 게스트에게 '실시간 학습 반영').
assert.equal(tasteBadge('learned', learned, { uniform, onboarding }, false), 'onboarding');
assert.equal(tasteBadge('learned', learned, { uniform, onboarding: null }, false), null);
// 수락·거절로 움직였다 — 그때부터 '실시간 학습 반영'.
assert.equal(tasteBadge('learned', learned, { uniform, onboarding }, true), 'learned');
assert.equal(tasteBadge('learned', learned, { uniform, onboarding: null }, true), 'learned');
// 서버 벡터가 없을 때의 폴백은 종전 그대로.
assert.equal(tasteBadge('onboarding', onboarding, { uniform, onboarding }, false), 'onboarding');
assert.equal(tasteBadge('default', uniform, { uniform, onboarding: null }, false), null);

console.log('tasteBadge: ok');
