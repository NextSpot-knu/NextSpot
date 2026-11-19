import assert from 'node:assert/strict';

import './sessionStorage';

// Node 에는 sessionStorage 전역이 없으므로 위 import 가 대역을 깐다.
const store = (globalThis as unknown as { sessionStorage: Storage }).sessionStorage;

store.setItem('a', '1');
assert.equal(store.getItem('a'), '1');
assert.equal(store.length, 1);
assert.equal(store.key(0), 'a');
store.removeItem('a');
assert.equal(store.getItem('a'), null);
store.setItem('b', '2');
store.clear();
assert.equal(store.length, 0);
