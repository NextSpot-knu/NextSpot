import assert from 'node:assert/strict';

import { FRAME_MIN_VIEWPORT, PHONE_FRAME_WIDTH, framedWindow, isFramedViewport, webFrameCss } from './webFrameCore';

const phone = { width: 412, height: 915, scale: 2, fontScale: 1 };
const desktop = { width: 1440, height: 900, scale: 1, fontScale: 1 };

// 폰 폭 창은 그대로(같은 객체 — 쓸데없이 새로 그리지 않게).
assert.equal(framedWindow(phone), phone);
assert.equal(isFramedViewport(phone.width), false);

// 데스크톱 창은 폭만 기둥 폭으로, 높이·배율은 그대로.
assert.deepEqual(framedWindow(desktop), { ...desktop, width: PHONE_FRAME_WIDTH });
assert.equal(isFramedViewport(FRAME_MIN_VIEWPORT), true);
assert.equal(isFramedViewport(FRAME_MIN_VIEWPORT - 1), false);

// 기둥 폭은 기둥을 켜는 창 폭보다 좁아야 한다(기둥이 창보다 넓으면 가로 스크롤이 생긴다).
assert.ok(PHONE_FRAME_WIDTH < FRAME_MIN_VIEWPORT);

// CSS 와 JS 가 같은 숫자를 쓴다.
const css = webFrameCss({ page: '#faf5ec', outside: '#e9e1d2' });
assert.ok(css.includes(`@media (min-width: ${FRAME_MIN_VIEWPORT}px)`));
assert.ok(css.includes(`width: ${PHONE_FRAME_WIDTH}px`));
