import assert from 'node:assert/strict';

import { PEEK_BOTTOM_GAP, PEEK_MIN, nextPeekHeight, peekSnapHeight } from './sheetPeek';

// 손잡이 + 묶음 + 여백
assert.equal(peekSnapHeight(186, 833, 22), 22 + 186 + PEEK_BOTTOM_GAP);
// 하한 · 상한(창의 40%)
assert.equal(peekSnapHeight(10, 833, 22), PEEK_MIN);
assert.equal(peekSnapHeight(600, 833, 22), Math.round(833 * 0.4));
// 잴 수 없으면 null
assert.equal(peekSnapHeight(0, 833, 22), null);
assert.equal(peekSnapHeight(Number.NaN, 833, 22), null);
assert.equal(peekSnapHeight(186, 0, 22), null);

// 처음엔 그대로 쓰고, 4dp 이하 흔들림은 무시, 그보다 크면 바꾼다
assert.equal(nextPeekHeight(null, 220), 220);
assert.equal(nextPeekHeight(220, 223), 220);
assert.equal(nextPeekHeight(220, 216), 220);
assert.equal(nextPeekHeight(220, 225), 225);
assert.equal(nextPeekHeight(220, null), 220);
assert.equal(nextPeekHeight(null, null), null);

console.log('sheetPeek ok');
