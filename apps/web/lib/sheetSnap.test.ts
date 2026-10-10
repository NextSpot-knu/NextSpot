import assert from 'node:assert/strict';
import { nextSheetState, projectedOffset, sheetElastic } from './sheetSnap';

// 투영 = 이동 + 속도 × 0.25초.
assert.equal(projectedOffset(40, 200), 90);
assert.equal(projectedOffset(Number.NaN, Number.POSITIVE_INFINITY), 0);

// 예전 기준을 잇는다 — 멈춘 손가락은 50px 초과 이동에서, 제자리 튕김은 200px/s 초과에서 바뀐다.
assert.equal(nextSheetState('normal', 51, 0), 'minimized');
assert.equal(nextSheetState('normal', 50, 0), 'normal');
assert.equal(nextSheetState('normal', 0, 201), 'minimized');
assert.equal(nextSheetState('normal', 0, 200), 'normal');
assert.equal(nextSheetState('normal', -51, 0), 'expanded');
assert.equal(nextSheetState('normal', 0, -201), 'expanded');

// 고친 경우: 아래로 80px 끌다가 위로 되튕기면 접히지 않는다(예전에는 접혔다).
assert.equal(nextSheetState('expanded', 80, -600), 'expanded');
assert.equal(nextSheetState('normal', 80, -400), 'normal');
// 되튕김이 이동보다 세면 마지막 방향(위)을 따른다 — 80 − 150 = −70.
assert.equal(nextSheetState('normal', 80, -600), 'expanded');
// 위로 끌다가 아래로 되튕겨도 마찬가지.
assert.equal(nextSheetState('minimized', -80, 600), 'minimized');
// 느리게 조금 끌고 놓은 것은 그대로(흔들린 탭).
assert.equal(nextSheetState('minimized', -6, -100), 'minimized');
assert.equal(nextSheetState('normal', 6, 100), 'normal');

// 한 번에 한 칸만 — 펼침에서 세게 내려도 기본까지, 미리보기에서 세게 올려도 기본까지.
assert.equal(nextSheetState('expanded', 300, 3000), 'normal');
assert.equal(nextSheetState('minimized', -300, -3000), 'normal');
// 갈 곳 없는 방향은 그대로.
assert.equal(nextSheetState('expanded', -300, -3000), 'expanded');
assert.equal(nextSheetState('minimized', 300, 3000), 'minimized');

// 끝 방향은 단단히, 열린 방향은 잘 따라온다.
assert.deepEqual(sheetElastic('minimized'), { top: 0.3, bottom: 0.08 });
assert.deepEqual(sheetElastic('normal'), { top: 0.3, bottom: 0.3 });
assert.deepEqual(sheetElastic('expanded'), { top: 0.08, bottom: 0.3 });

console.log('sheetSnap tests passed');
