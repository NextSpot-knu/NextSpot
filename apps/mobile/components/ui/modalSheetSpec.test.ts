import assert from 'node:assert/strict';

import { colors } from '../../lib/theme/tokens';
import {
  MODAL_SHEET_CLOSE_BOX,
  resolveBackdrop,
  resolveContentPadding,
  sheetSideMargin,
  sheetSurface,
} from './modalSheetSpec';

// ── 기본값 = B3 전 모양(회귀 잠금) ────────────────────────────────────
assert.deepEqual(resolveContentPadding(undefined, 0), { paddingHorizontal: 16, paddingTop: 0, paddingBottom: 16 });
assert.deepEqual(resolveContentPadding(undefined, 24), { paddingHorizontal: 16, paddingTop: 0, paddingBottom: 40 });
assert.deepEqual(resolveBackdrop(undefined), { color: '#000000', opacity: 0.35 });
assert.equal(sheetSideMargin(390, undefined), 0);
assert.deepEqual(sheetSurface('default', true, 'android'), {
  backgroundColor: colors.white,
  borderColor: colors.line,
  borderWidth: 1,
  borderRadius: 24,
});
assert.equal(sheetSurface('default', true, 'ios').backgroundColor, 'rgba(255, 255, 255, 0.95)');
assert.equal(sheetSurface('default', true, 'web').backgroundColor, 'rgba(255, 255, 255, 0.95)');

// ── 웹 값 ────────────────────────────────────────────────────────────
// 혼잡 제보: p-6, 막 muk/40, max-w-sm.
assert.deepEqual(resolveContentPadding({ x: 24, top: 24, bottom: 24 }, 0), { paddingHorizontal: 24, paddingTop: 24, paddingBottom: 24 });
assert.deepEqual(resolveBackdrop({ color: colors.muk, opacity: 0.4 }), { color: colors.muk, opacity: 0.4 });
// 일부만 주면 나머지는 기본값.
assert.deepEqual(resolveContentPadding({ top: 12, bottom: 20 }, 10), { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 30 });
assert.deepEqual(resolveBackdrop({ opacity: 0.3 }), { color: '#000000', opacity: 0.3 });
// 390 폭에서 max-w-sm(384) → 좌우 3, max-w-lg(512) → 0(화면이 더 좁음), 펼친 폴드(673) → 가운데.
assert.equal(sheetSideMargin(390, 384), 3);
assert.equal(sheetSideMargin(390, 512), 0);
assert.equal(sheetSideMargin(384, 384), 0);
assert.equal(sheetSideMargin(673, 512), 81);
// 한지 판: 플랫폼과 무관하게 불투명 한지, 테두리는 고른 대로.
assert.deepEqual(sheetSurface('hanji', false, 'android'), {
  backgroundColor: colors.hanji,
  borderColor: colors.line,
  borderWidth: 0,
  borderRadius: 24,
});
assert.equal(sheetSurface('hanji', true, 'web').borderWidth, 1);
// 머리 X 상자: p-1.5 → 30, p-2 → 34, 흰 원 테두리 → 36.
assert.deepEqual(MODAL_SHEET_CLOSE_BOX, { muted: 30, plain: 34, bordered: 36 });

console.log('modalSheetSpec ok');
