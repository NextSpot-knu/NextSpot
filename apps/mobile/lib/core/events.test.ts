import assert from 'node:assert/strict';

import { appEvents, createEmitter } from './events';

interface Map1 {
  ping: { n: number };
  pong: string;
}

const emitter = createEmitter<Map1>();
const got: number[] = [];
const off = emitter.on('ping', (d) => got.push(d.n));
emitter.emit('ping', { n: 1 });
emitter.emit('pong', 'ignored');
assert.deepEqual(got, [1]);
assert.equal(emitter.listenerCount('ping'), 1);

// 구조 분해한 해제 함수도 동작한다.
off();
emitter.emit('ping', { n: 2 });
assert.deepEqual(got, [1]);
assert.equal(emitter.listenerCount('ping'), 0);

// 리스너 예외는 다른 리스너를 막지 않는다.
const origWarn = console.warn;
console.warn = () => {};
const order: string[] = [];
emitter.on('pong', () => { throw new Error('bad'); });
emitter.on('pong', (s) => order.push(s));
emitter.emit('pong', 'ok');
console.warn = origWarn;
assert.deepEqual(order, ['ok']);

// 발행 중 자기 해제해도 이번 회차는 끝까지 돈다.
const seen: string[] = [];
const offSelf = emitter.on('pong', () => { seen.push('a'); offSelf(); });
emitter.on('pong', () => seen.push('b'));
console.warn = () => {};
emitter.emit('pong', 'x');
emitter.emit('pong', 'y');
console.warn = origWarn;
assert.deepEqual(seen, ['a', 'b', 'b']);

// 앱 버스 — 웹 CustomEvent 이름의 대역.
let crowd: string | null = 'unset';
const offCrowd = appEvents.on('crowd-answer', (d) => { crowd = d.crowdAnswer; });
appEvents.emit('crowd-answer', { recommendationId: 'r', crowdAnswer: null });
assert.equal(crowd, null);
offCrowd();
let llm = 0;
const offLlm = appEvents.on('llm-debug', (d) => { if (d.feature === 'reason') llm = d.llmCount; });
appEvents.emit('llm-debug', { feature: 'reason', llmCount: 3, templateCount: 1 });
assert.equal(llm, 3);
offLlm();
