import assert from 'node:assert/strict';

import { REASON_CODES, answeredKey, formatRecommendedAt, withoutItem } from './labCore';

assert.equal(REASON_CODES.length, 9);
assert.equal(REASON_CODES[REASON_CODES.length - 1], 'other');
assert.equal(new Set(REASON_CODES).size, 9);
assert.equal(answeredKey({ updatedVector: true }), 'lab.answeredTaste');
assert.equal(answeredKey({ updatedVector: false }), 'lab.answered');
assert.equal(formatRecommendedAt('nope', 'ko'), '');
assert.ok(formatRecommendedAt('2026-11-02T03:00:00Z', 'en').length > 0);
assert.deepEqual(withoutItem([{ id: 'a' }, { id: 'b' }], 'a'), [{ id: 'b' }]);
console.log('labCore ok');
