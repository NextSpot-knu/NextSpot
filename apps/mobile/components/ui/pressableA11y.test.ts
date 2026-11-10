import assert from 'node:assert/strict';

import { webAriaProps } from './pressableA11y';

assert.deepEqual(webAriaProps('tab', { selected: true }), { 'aria-selected': true });
assert.deepEqual(webAriaProps('tab', { selected: false }), { 'aria-selected': false });
assert.deepEqual(webAriaProps('button', { selected: true }), { 'aria-pressed': true });
assert.deepEqual(webAriaProps(undefined, { selected: false }), { 'aria-pressed': false });
assert.deepEqual(webAriaProps('checkbox', { checked: true }), { 'aria-checked': true });
assert.deepEqual(webAriaProps('checkbox', { checked: 'mixed' }), { 'aria-checked': 'mixed' });
assert.deepEqual(webAriaProps('button', { expanded: false }), { 'aria-expanded': false });
assert.deepEqual(webAriaProps('button', { busy: true }), { 'aria-busy': true });
// busy=false·disabled 는 속성을 만들지 않는다(disabled 는 RNW 가 aria-disabled 로 이미 낸다).
assert.deepEqual(webAriaProps('button', { busy: false, disabled: true }), {});
assert.deepEqual(webAriaProps('button', undefined), {});
assert.deepEqual(webAriaProps('button', { selected: true, expanded: true }), { 'aria-pressed': true, 'aria-expanded': true });

assert.deepEqual(webAriaProps('radio', { selected: true }), { 'aria-checked': true });
assert.deepEqual(webAriaProps('checkbox', { selected: false }), { 'aria-checked': false });
assert.deepEqual(webAriaProps('radio', { selected: true, checked: false }), { 'aria-checked': false });

console.log('pressableA11y ok');
