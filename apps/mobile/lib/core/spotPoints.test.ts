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
