import assert from 'node:assert/strict';
import { ADMIN_HOME, DEFAULT_LOGIN_DEST, MERCHANT_HOME, decidePostLoginDest } from './postLoginDest';
import { parseAccount, type Account, type AccountRole } from './accountRoles';
import { keysToCamel } from './caseTransform';
import { JUDGE_ACCOUNTS } from './judgeAccounts';

// resolvePostLoginDest 는 apiClient(→ supabase 세션)를 부르므로 노드에서 그대로 못 돌린다.
// 대신 그 함수가 역할 조회 결과를 넣어 부르는 **판정 함수(decidePostLoginDest)** 를 직접 검증한다.
function pickDest(explicitNext: string | null, account: Account | null, email: string | null = null): string {
  return decidePostLoginDest(explicitNext, email, account?.role ?? null);
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
// 심사용 사장님 계정이어도 next 가 있으면 그곳이다.
assert.equal(pickDest('/saved', acct('merchant'), JUDGE_ACCOUNTS.merchant), '/saved');

// ── next 가 없을 때만 역할을 본다 ──────────────────────────────────────────
// 관리자 계정은 관광객 앱을 쓸 일이 없다 — 로그인하면 바로 관제로.
assert.equal(pickDest(null, acct('admin')), ADMIN_HOME);
assert.equal(pickDest(null, acct('admin'), JUDGE_ACCOUNTS.admin), ADMIN_HOME);

// 사장님은 관광객 앱도 쓴다(계획서 §9-5 가 강제 리다이렉트를 하지 않기로 한 근거).
assert.equal(pickDest(null, acct('merchant')), DEFAULT_LOGIN_DEST);
assert.equal(pickDest(null, acct('merchant'), 'owner@example.invalid'), DEFAULT_LOGIN_DEST);

// 개발자도 관광객 화면을 가장 많이 보는 계정이라 강제 이동하지 않는다.
assert.equal(pickDest(null, acct('developer')), DEFAULT_LOGIN_DEST);

assert.equal(pickDest(null, acct('tourist')), DEFAULT_LOGIN_DEST);

// ── 심사용 사장님 계정 하나만 콘솔로 ────────────────────────────────────────
// 심사위원은 기능 5(사장님 콘솔)를 보러 이 계정으로 로그인한다. /main 에 떨어지면 콘솔이 없는 것처럼
// 읽힌다(2026-10-06 감사 I14). 다른 사장님은 §9-5 그대로 /main 이다.
assert.equal(MERCHANT_HOME, '/merchant');
assert.equal(pickDest(null, acct('merchant'), JUDGE_ACCOUNTS.merchant), MERCHANT_HOME);
// 역할 조회가 실패해도(계정 null) 콘솔 관문으로 보낸다 — 관문이 다시 판정한다.
assert.equal(pickDest(null, null, JUDGE_ACCOUNTS.merchant), MERCHANT_HOME);
// 사람이 친 대소문자·앞뒤 공백은 같은 계정이다.
assert.equal(pickDest(null, acct('merchant'), '  OpenAPI@Naver.com '), MERCHANT_HOME);
// 비슷하게 생긴 다른 주소는 아니다.
assert.equal(pickDest(null, acct('merchant'), 'openapi@naver.com.evil'), DEFAULT_LOGIN_DEST);
assert.equal(pickDest(null, acct('merchant'), 'xopenapi@naver.com'), DEFAULT_LOGIN_DEST);

// ── 역할을 못 읽었을 때 ────────────────────────────────────────────────────
// 백엔드가 흔들렸다고 로그인 자체를 막을 이유는 없다 — 기본 목적지로 보낸다.
assert.equal(pickDest(null, null), DEFAULT_LOGIN_DEST);
// 기본 목적지는 호출부가 정한다(가입 직후는 /setup).
assert.equal(decidePostLoginDest(null, null, null, '/setup'), '/setup');

// 알 수 없는 role 값은 normalizeRole 이 tourist 로 떨어뜨리므로 관제로 새지 않는다.
const weird = parseAccount(keysToCamel({ id: 'u2', role: 'ADMIN', is_anonymous: false }));
assert.equal(pickDest(null, weird), DEFAULT_LOGIN_DEST, '대소문자 변형이 관제로 통과했다');

console.log('postLoginDest tests passed');
