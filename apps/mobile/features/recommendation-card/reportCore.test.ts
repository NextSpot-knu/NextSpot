import assert from 'node:assert/strict';

import { AuthError, HttpError } from '~/lib/core/httpCore';

import { congestionReportErrorKey, hoursAnswerNotRecorded, rewardBadge } from './reportCore';

assert.equal(congestionReportErrorKey(new AuthError()), 'report.authError');
assert.equal(congestionReportErrorKey(new HttpError('forbidden', 403)), 'report.authError', '게스트는 로그인 안내');
assert.equal(congestionReportErrorKey(new HttpError('slow', 429)), 'report.cooldownError');
assert.equal(congestionReportErrorKey(new HttpError('boom', 500)), 'report.failError');
assert.equal(congestionReportErrorKey(new Error('network')), 'report.failError');

assert.equal(rewardBadge({ couponIssued: true }), '🎟️ +1');
assert.equal(rewardBadge({ nextRewardIn: 1 }), '🎯 2/3');
assert.equal(rewardBadge({ nextRewardIn: 0 }), null);
assert.equal(rewardBadge(undefined), null);

assert.equal(hoursAnswerNotRecorded(new HttpError('x', 403)), true);
assert.equal(hoursAnswerNotRecorded(new HttpError('x', 429)), true);
assert.equal(hoursAnswerNotRecorded(new HttpError('x', 500)), false);

console.log('reportCore.test OK');
