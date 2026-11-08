import assert from 'node:assert/strict';

import { PEEK_BOTTOM_GAP, PEEK_MIN, nextPeekHeight, peekMaxHeight, peekSnapHeight } from './sheetPeek';

// 상한: 시트 컨테이너 52% 에서 24 아래 — 모르면 창의 40%
assert.equal(peekMaxHeight(752, 833), Math.round(752 * 0.52 - 24));
assert.equal(peekMaxHeight(0, 833), Math.round(833 * 0.4));
assert.equal(peekMaxHeight(0, 0), 0);
const max = peekMaxHeight(752, 833);
// 손잡이 + 묶음 + 여백
assert.equal(peekSnapHeight(186, 22, max), 22 + 186 + PEEK_BOTTOM_GAP);
// 하한 · 상한(분할 화면처럼 컨테이너가 짧으면 기본 높이 아래로 자른다)
assert.equal(peekSnapHeight(10, 22, max), PEEK_MIN);
assert.equal(peekSnapHeight(600, 22, max), max);
assert.equal(peekSnapHeight(186, 22, peekMaxHeight(300, 833)), Math.round(300 * 0.52 - 24));
assert.ok((peekSnapHeight(186, 22, peekMaxHeight(300, 833)) ?? 0) < 300 * 0.52, '기본 높이보다 낮다');
// 잴 수 없으면 null
assert.equal(peekSnapHeight(0, 22, max), null);
assert.equal(peekSnapHeight(Number.NaN, 22, max), null);
assert.equal(peekSnapHeight(186, 22, 0), null);

// 처음엔 그대로 쓰고, 4dp 이하 흔들림은 무시, 그보다 크면 바꾼다
assert.equal(nextPeekHeight(null, 220), 220);
assert.equal(nextPeekHeight(220, 223), 220);
assert.equal(nextPeekHeight(220, 216), 220);
assert.equal(nextPeekHeight(220, 225), 225);
assert.equal(nextPeekHeight(220, null), 220);
assert.equal(nextPeekHeight(null, null), null);
// 이전 값이 줄어든 상한을 넘으면 작은 차이라도 바꾼다
assert.equal(nextPeekHeight(220, 217, 217), 217);
assert.equal(nextPeekHeight(220, 217, 300), 220);

console.log('sheetPeek ok');
