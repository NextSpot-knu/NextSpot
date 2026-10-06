import assert from 'node:assert/strict';
import {
  ADMIN_CONSOLE_PATH,
  ADMIN_DEMO_PATH,
  MERCHANT_CONSOLE_PATH,
  MERCHANT_DEMO_PATH,
  consoleLinks,
} from './consoleLinks';
import { parseAccount, type Account, type AccountRole } from './accountRoles';
import { keysToCamel } from './caseTransform';

// 레일·폰 줄·마이페이지의 콘솔 입구는 역할이 맞으면 실제 콘솔, 아니면 데모로 간다.
// 역할 없는 사람을 실제 콘솔로 보내면 '권한 없음' 관문에서 멈추고, 역할 있는 사람을 데모로 보내면
// 자기 가게 대신 예시 가게를 본다 — 둘 다 심사 동선에서 기능이 없는 것처럼 읽힌다.

function acct(role: AccountRole, isAnonymous = false): Account {
  return parseAccount(
    keysToCamel({ id: 'u1', role, is_anonymous: isAnonymous, nickname: null, owned_facilities: [], pending_verification: false }),
  );
}

// ── 계정을 모를 때·게스트 → 둘 다 데모 ─────────────────────────────────────
assert.deepEqual(consoleLinks(null), { merchant: MERCHANT_DEMO_PATH, admin: ADMIN_DEMO_PATH });
assert.deepEqual(consoleLinks(acct('tourist', true)), { merchant: MERCHANT_DEMO_PATH, admin: ADMIN_DEMO_PATH });
// 가입한 관광객도 두 콘솔의 역할이 없다.
assert.deepEqual(consoleLinks(acct('tourist')), { merchant: MERCHANT_DEMO_PATH, admin: ADMIN_DEMO_PATH });

// ── 역할이 맞는 콘솔만 실제로 ────────────────────────────────────────────────
// 사장님은 자기 콘솔은 실제로, 관제는 데모로(두 콘솔은 완전히 분리 — accountRoles.ts).
assert.deepEqual(consoleLinks(acct('merchant')), { merchant: MERCHANT_CONSOLE_PATH, admin: ADMIN_DEMO_PATH });
// 관리자는 관제만 실제로 — 사장님 콘솔에 들어갈 역할이 아니다.
assert.deepEqual(consoleLinks(acct('admin')), { merchant: MERCHANT_DEMO_PATH, admin: ADMIN_CONSOLE_PATH });
// 개발자는 두 콘솔 모두 들어간다.
assert.deepEqual(consoleLinks(acct('developer')), { merchant: MERCHANT_CONSOLE_PATH, admin: ADMIN_CONSOLE_PATH });

// 알 수 없는 role 값은 tourist 로 떨어지므로 실제 콘솔로 새지 않는다.
const weird = parseAccount(keysToCamel({ id: 'u2', role: 'ADMIN', is_anonymous: false }));
assert.deepEqual(consoleLinks(weird), { merchant: MERCHANT_DEMO_PATH, admin: ADMIN_DEMO_PATH });

// 경로 자체 — 데모는 각 콘솔이 읽는 ?demo=1, 관제는 리다이렉트 껍데기(/admin)를 거치지 않는다.
assert.equal(MERCHANT_CONSOLE_PATH, '/merchant');
assert.equal(MERCHANT_DEMO_PATH, '/merchant?demo=1');
assert.equal(ADMIN_CONSOLE_PATH, '/admin/dashboard');
assert.equal(ADMIN_DEMO_PATH, '/admin/dashboard?demo=1');

console.log('consoleLinks tests passed');
