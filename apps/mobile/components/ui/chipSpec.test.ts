import assert from 'node:assert/strict';

import { CHIP_SPECS, chipAccessibilityLabel } from './chipSpec';

// 기본 variant(layer)는 지금 모양 그대로.
assert.equal(CHIP_SPECS.layer.selectedClass, 'border-jade bg-jade-chip');
assert.equal(CHIP_SPECS.layer.minHeight, 32);

// 보이는 높이 + 위아래 탭 영역 ≥ 44(DESIGN_PRINCIPLES).
for (const [name, s] of Object.entries(CHIP_SPECS)) {
  assert.ok(s.minHeight + 2 * s.hitSlopY >= 44, name);
  // 같은 속성 클래스는 하나씩만(바탕 하나·테두리색 하나 — 덧붙이면 CSS 순서로 진다).
  for (const cls of [s.selectedClass, s.idleClass]) {
    const parts = cls.split(/\s+/);
    assert.equal(parts.filter((c) => c.startsWith('bg-')).length, 1, `${name} ${cls}`);
    assert.equal(parts.filter((c) => c.startsWith('border-')).length, 1, `${name} ${cls}`);
  }
}

assert.equal(CHIP_SPECS.savedFilter.selectedClass, 'border-gold bg-gold/15');
assert.equal(CHIP_SPECS.savedFilter.labelWeight, 'medium');
assert.equal(CHIP_SPECS.courseType.selectedTextClass, 'text-gold-deep');
assert.equal(CHIP_SPECS.courseType.labelWeight, 'bold');
assert.ok(CHIP_SPECS.courseType.selectedShadow);
assert.equal(CHIP_SPECS.courseType.disabledClass, 'opacity-40');
assert.equal(CHIP_SPECS.labReason.minHeight, 30);
assert.equal(CHIP_SPECS.labReason.selectedClass, 'border-gold bg-button-gold');
assert.equal(CHIP_SPECS.labReason.selectedTextClass, 'text-white');

assert.equal(chipAccessibilityLabel('카페', 1, undefined), '카페 1');
assert.equal(chipAccessibilityLabel('카페', undefined, undefined), '카페');
assert.equal(chipAccessibilityLabel('카페', 3, '카페만 보기'), '카페만 보기');

console.log('chipSpec ok');
