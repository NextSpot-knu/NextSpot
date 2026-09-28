import assert from 'node:assert/strict';
import { fitWholeLines, type LineBlock } from './wholeLines';

// /waiting 대표 카드의 글 블록: 이름(12px × 1.375) → 메뉴(10px × 1.375, mt 2px) → 소개(10px × 1.375, mt 4px).
const name = (lines: number): LineBlock => ({ lineHeight: 16.5, lines, gapBefore: 0 });
const menu = (lines: number): LineBlock => ({ lineHeight: 13.75, lines, gapBefore: 2 });
const summary = (lines: number): LineBlock => ({ lineHeight: 13.75, lines, gapBefore: 4 });

// 넉넉하면 전부 그대로.
assert.deepEqual(fitWholeLines(200, [name(2), menu(2), summary(2)]), [2, 2, 2]);
// 이름 두 줄 + 메뉴 한 줄(15.75)까지만 온전히 들어간다(54px) — 메뉴가 잘렸으니 소개는 숨긴다.
assert.deepEqual(fitWholeLines(54, [name(2), menu(2), summary(2)]), [2, 1, 0]);
// 이름 한 줄 높이만 남으면 이름 한 줄만.
assert.deepEqual(fitWholeLines(16.5, [name(2), menu(2), summary(2)]), [1, 0, 0]);
// 소수 픽셀 반올림(32.999)에서도 이름 두 줄이 한 줄로 떨어지지 않는다.
assert.deepEqual(fitWholeLines(32.999, [name(2)]), [2]);
// 메뉴가 없는 카드(0줄)는 건너뛰고 소개가 그 자리를 쓴다 — 없는 블록 때문에 뒤를 숨기지 않는다.
assert.deepEqual(fitWholeLines(54, [name(1), menu(0), summary(2)]), [1, 0, 2]);
// 여백만 들어가고 줄은 안 들어가면 0, 그 뒤도 0.
assert.deepEqual(fitWholeLines(35, [name(2), menu(1), summary(1)]), [2, 0, 0]);
// 한 줄도 못 싣는 높이 — 모두 0(음수 줄 없음).
assert.deepEqual(fitWholeLines(10, [name(2), menu(1)]), [0, 0]);
// 잘못 잰 줄 높이(0·NaN)는 숨긴다(무한 줄 없음).
assert.deepEqual(fitWholeLines(100, [{ lineHeight: 0, lines: 2, gapBefore: 0 }]), [0]);
assert.deepEqual(fitWholeLines(100, [{ lineHeight: Number.NaN, lines: 2, gapBefore: 0 }]), [0]);

console.log('wholeLines tests passed');
