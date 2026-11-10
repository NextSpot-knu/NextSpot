import assert from 'node:assert/strict';

import { HOME_TOAST, nextToast } from './homeToastSpec';

assert.equal(HOME_TOAST.fromScreenBottom, 350);
assert.equal(HOME_TOAST.maxWidth, 384);
assert.equal(HOME_TOAST.durationMs, 3000);
const a = nextToast(null, '첫째');
const b = nextToast(a, '둘째');
assert.equal(a.id, 1);
assert.equal(b.id, 2);
assert.equal(b.message, '둘째');
console.log('homeToastSpec ok');
