import assert from 'node:assert/strict';

import { CONFIRM_ENTER_MS, confirmPlan, createConfirmRegistry } from './confirmToastCore';

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

// 시간·초점 결정.
// 보통: 라이브러리 시간 초과(duration + 등장 300) 뒤 500 여유로 예비 타이머, 초점 이동 없음.
assert.deepEqual(confirmPlan({ duration: 8000, screenReader: false }), { toastDuration: 8000, fallbackMs: 8800, focus: false });
assert.deepEqual(confirmPlan({ duration: 10000, screenReader: false }), { toastDuration: 10000, fallbackMs: 10800, focus: false });
// 화면 읽기: 시간 제한 없음 + 초점 이동, 예비 타이머는 '그려지지 않음' 판정용(3초 + 300 + 500).
assert.deepEqual(confirmPlan({ duration: 8000, screenReader: true }), { toastDuration: Infinity, fallbackMs: 3800, focus: true });
// 예비 타이머는 늘 라이브러리 시간 초과보다 늦다(먼저 오면 펼쳐 읽는 중인 토스트를 닫는다).
for (const duration of [1, 4000, 8000, 10000]) {
  assert.ok(confirmPlan({ duration, screenReader: false }).fallbackMs > duration + CONFIRM_ENTER_MS);
}

console.log('confirmToastCore ok');
