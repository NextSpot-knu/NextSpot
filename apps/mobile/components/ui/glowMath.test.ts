import assert from 'node:assert/strict';

import { GLOW_PRESETS, glowCanvas, glowStops } from './glowMath';

// 검토 R1 예: 300 · σ100 · 15% → 캔버스 700, 중심 0.10.
assert.equal(glowCanvas(300, 100), 700);
const s = glowStops(0.15, 300, 100);
assert.equal(s.length, 3);
assert.ok(Math.abs(s[0].opacity - 0.1) < 0.002, `중심 ${s[0].opacity}`);
assert.equal(s[0].offset, 0);
assert.ok(Math.abs(s[1].offset - 150 / 350) < 1e-9);
assert.ok(Math.abs(s[1].opacity - s[0].opacity / 2) < 1e-12);
assert.deepEqual(s[2], { offset: 1, opacity: 0 });

// 프리셋은 모두 두 개(노을 + 금).
for (const [name, glows] of Object.entries(GLOW_PRESETS)) assert.equal(glows.length, 2, name);

console.log('glowMath.test OK');
