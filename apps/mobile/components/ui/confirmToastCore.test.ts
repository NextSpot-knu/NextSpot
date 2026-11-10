import assert from 'node:assert/strict';

import { createConfirmRegistry } from './confirmToastCore';

function recorder() {
  const answers: boolean[] = [];
  return { answers, resolve: (v: boolean) => answers.push(v) };
}

// 행동 → true, 이어 오는 dismiss → onAutoClose 의 false 는 버린다.
{
  const reg = createConfirmRegistry();
  const a = recorder();
  reg.open('x', a.resolve);
  assert.equal(reg.settle('x', true, a.resolve), true);
  assert.equal(reg.settle('x', false, a.resolve), false);
  assert.deepEqual(a.answers, [true]);
  assert.equal(reg.pending(), 0);
}

// 취소 · 시간 초과 · 밀어 닫기 → false 한 번.
{
  const reg = createConfirmRegistry();
  const a = recorder();
  reg.open('x', a.resolve);
  reg.settle('x', false, a.resolve);
  reg.settle('x', false, a.resolve);
  assert.deepEqual(a.answers, [false]);
}

// 같은 id 로 새 확인 → 앞 확인은 false, 앞 토스트의 늦은 콜백은 새 확인에 답하지 않는다.
{
  const reg = createConfirmRegistry();
  const a = recorder();
  const b = recorder();
  reg.open('x', a.resolve);
  reg.open('x', b.resolve);
  assert.deepEqual(a.answers, [false]);
  assert.equal(reg.settle('x', false, a.resolve), false);
  assert.deepEqual(b.answers, []);
  assert.equal(reg.settle('x', true, b.resolve), true);
  assert.deepEqual(b.answers, [true]);
}

// 다른 id 는 서로 영향이 없다. 없는 id 에 답하면 아무 일 없음.
{
  const reg = createConfirmRegistry();
  const a = recorder();
  const b = recorder();
  reg.open('a', a.resolve);
  reg.open('b', b.resolve);
  assert.equal(reg.pending(), 2);
  reg.settle('b', true, b.resolve);
  assert.deepEqual(a.answers, []);
  assert.deepEqual(b.answers, [true]);
  assert.equal(reg.settle('nope', true), false);
}

console.log('confirmToastCore ok');
