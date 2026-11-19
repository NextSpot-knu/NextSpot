// 콘솔 입구 주소 — 웹 consoleLinks 규칙(역할 없으면 데모)을 운영 웹 주소에 붙인다.
import assert from 'node:assert/strict';

import { WEB_ORIGIN } from '../platform/shareUrls';
import { consoleEntryUrls } from './consoleEntries';

const guest = consoleEntryUrls(null);
assert.equal(guest.merchant, `${WEB_ORIGIN}/merchant?demo=1`);
assert.equal(guest.admin, `${WEB_ORIGIN}/admin/dashboard?demo=1`);

const other = consoleEntryUrls(null, 'https://example.test');
assert.equal(other.merchant, 'https://example.test/merchant?demo=1');

console.log('ok consoleEntries');
