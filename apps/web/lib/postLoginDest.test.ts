import assert from 'node:assert/strict';
import { ADMIN_HOME, DEFAULT_LOGIN_DEST } from './postLoginDest';
import { parseAccount, type Account, type AccountRole } from './accountRoles';
import { keysToCamel } from './caseTransform';

// resolvePostLoginDest 는 apiClient(→ supabase 세션)를 부르므로 노드에서 그대로 못 돌린다.
// 대신 **판정 규칙만** 같은 형태로 떼어 검증한다. 규칙이 갈라지지 않게 아래 pickDest 는
// postLoginDest.ts 의 분기와 1:1 로 대응한다 — 그쪽을 고치면 여기도 같이 고쳐야 한다.
function pickDest(explicitNext: string | null, account: Account | null): string {
  if (explicitNext) return explicitNext;
  if (account?.role === 'admin') return ADMIN_HOME;
  return DEFAULT_LOGIN_DEST;
}

function acct(role: AccountRole): Account {
  return parseAccount(
    keysToCamel({
      id: 'u1',
      role,
      is_anonymous: false,
      nickname: null,
      owned_facilities: [],
      pending_verification: false,
    }),
  );
}

// ── 명시된 목적지가 언제나 이긴다 ──────────────────────────────────────────
// 권한 화면이 `/login?next=/merchant` 로 보냈는데 역할 때문에 딴 데로 가면
// 사용자는 자기가 누른 곳으로 영영 못 간다.
assert.equal(pickDest('/merchant', acct('merchant')), '/merchant');
assert.equal(pickDest('/merchant/dashboard', acct('admin')), '/merchant/dashboard');
assert.equal(pickDest('/course?s=abc', acct('tourist')), '/course?s=abc');

// ── next 가 없을 때만 역할을 본다 ──────────────────────────────────────────
// 관리자 계정은 관광객 앱을 쓸 일이 없다 — 로그인하면 바로 관제로.
assert.equal(pickDest(null, acct('admin')), ADMIN_HOME);

// 사장님은 관광객 앱도 쓴다(계획서 §9-5 가 강제 리다이렉트를 하지 않기로 한 근거).
assert.equal(pickDest(null, acct('merchant')), DEFAULT_LOGIN_DEST);

// 개발자도 관광객 화면을 가장 많이 보는 계정이라 강제 이동하지 않는다.
assert.equal(pickDest(null, acct('developer')), DEFAULT_LOGIN_DEST);

assert.equal(pickDest(null, acct('tourist')), DEFAULT_LOGIN_DEST);

// ── 역할을 못 읽었을 때 ────────────────────────────────────────────────────
// 백엔드가 흔들렸다고 로그인 자체를 막을 이유는 없다 — 기본 목적지로 보낸다.
assert.equal(pickDest(null, null), DEFAULT_LOGIN_DEST);

// 알 수 없는 role 값은 normalizeRole 이 tourist 로 떨어뜨리므로 관제로 새지 않는다.
const weird = parseAccount(keysToCamel({ id: 'u2', role: 'ADMIN', is_anonymous: false }));
assert.equal(pickDest(null, weird), DEFAULT_LOGIN_DEST, '대소문자 변형이 관제로 통과했다');

console.log('postLoginDest tests passed');
