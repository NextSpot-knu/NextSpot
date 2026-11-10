import assert from 'node:assert/strict';

import { spotPoints } from './spotPoints';

assert.equal(spotPoints(0.548), 55);
assert.equal(spotPoints(54.8), 55);
assert.equal(spotPoints(0.4), 40);
assert.equal(spotPoints(1), 100);
assert.equal(spotPoints(0), 0);
assert.equal(spotPoints(null), 0);
assert.equal(spotPoints(undefined), 0);
assert.equal(spotPoints(Number.NaN), 0);

// 숫자 문자열은 웹처럼 숫자로 읽고, 음수·빈 문자열·숫자 아님은 0
assert.equal(spotPoints('55'), 55);
assert.equal(spotPoints('0.548'), 55);
assert.equal(spotPoints(' 54.8 '), 55);
assert.equal(spotPoints(''), 0);
assert.equal(spotPoints('abc'), 0);
assert.equal(spotPoints(-0.5), 0);
assert.equal(spotPoints(-20), 0);
