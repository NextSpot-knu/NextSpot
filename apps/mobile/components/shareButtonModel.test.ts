import assert from 'node:assert/strict';

import { COPIED_CHECK_MS, SHARE_FAILED_TOAST_MS, reactionFor } from './shareButtonModel';

assert.deepEqual(reactionFor('copied'), { copied: true, toast: 'copied' });
assert.deepEqual(reactionFor('failed'), { copied: false, toast: 'failed' });
assert.deepEqual(reactionFor('shared'), { copied: false, toast: null });
assert.deepEqual(reactionFor('dismissed'), { copied: false, toast: null });
assert.equal(COPIED_CHECK_MS, 2000);
assert.equal(SHARE_FAILED_TOAST_MS, 10000);
console.log('shareButtonModel ok');
