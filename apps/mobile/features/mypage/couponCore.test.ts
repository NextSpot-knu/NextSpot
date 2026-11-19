import assert from 'node:assert/strict';

import { couponPercent, ddayBadge, daysUntil } from './couponCore';

const NOW = Date.parse('2026-11-02T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

assert.equal(daysUntil(null, NOW), null);
assert.equal(daysUntil('not-a-date', NOW), null);
assert.equal(daysUntil(new Date(NOW + 2 * DAY).toISOString(), NOW), 2);
assert.equal(daysUntil(new Date(NOW + 1).toISOString(), NOW), 1, '올림');
assert.equal(daysUntil(new Date(NOW - DAY).toISOString(), NOW), -1);

assert.equal(couponPercent(0.2), 20);
assert.equal(couponPercent('0.15'), 15);
assert.equal(couponPercent(undefined), 0);

assert.equal(ddayBadge({ status: 'used', expiresAt: new Date(NOW + DAY).toISOString() }, NOW), null, '사용 완료는 뱃지 없음');
assert.equal(ddayBadge({ status: 'issued', expiresAt: null }, NOW), null, '만료 없음은 뱃지 없음');
assert.deepEqual(ddayBadge({ status: 'issued', expiresAt: new Date(NOW + 3 * DAY).toISOString() }, NOW), { daysLeft: 3, urgent: true });
assert.deepEqual(ddayBadge({ status: 'issued', expiresAt: new Date(NOW + 4 * DAY).toISOString() }, NOW), { daysLeft: 4, urgent: false });
console.log('couponCore ok');
