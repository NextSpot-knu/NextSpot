import assert from 'node:assert/strict';
import {
  canEnterAdminConsole,
  canEnterDevConsole,
  canEnterMerchantConsole,
  canRequestBusinessVerification,
  normalizeRole,
  parseAccount,
  type Account,
  type AccountRole,
} from './accountRoles';

// 프런트 권한 분기의 단일 출처. 여기가 백엔드(app/core/authz.py)와 어긋나면
// "들어가지긴 하는데 모든 요청이 403" 인 막다른 화면이 생긴다.

function account(role: AccountRole, over: Partial<Account> = {}): Account {
  return {
    id: 'u1',
    role,
    isAnonymous: false,
    nickname: '테스터',
    ownedFacilities: [],
    pendingVerification: false,
    ...over,
  };
}

// ── normalizeRole — 모르는 값은 최소 권한으로 ──────────────────────────────
assert.equal(normalizeRole('merchant'), 'merchant');
assert.equal(normalizeRole('developer'), 'developer');
// 서버가 새 역할을 늘렸거나 응답이 오염됐을 때 권한을 얻는 방향으로 실패하면 안 된다.
assert.equal(normalizeRole('superuser'), 'tourist');
assert.equal(normalizeRole('ADMIN'), 'tourist', '대소문자 다른 값이 admin 으로 통과했다');
assert.equal(normalizeRole(undefined), 'tourist');
assert.equal(normalizeRole(null), 'tourist');
assert.equal(normalizeRole(42), 'tourist');
assert.equal(normalizeRole({ role: 'admin' }), 'tourist');

// ── 사장님 콘솔 ────────────────────────────────────────────────────────────
assert.equal(canEnterMerchantConsole(account('merchant')), true);
assert.equal(canEnterMerchantConsole(account('developer')), true);
assert.equal(canEnterMerchantConsole(account('tourist')), false);
// 관제와 사장님 콘솔은 완전히 분리한다 — '관리자 열람 모드' 예외를 두지 않기로 한 결정.
// 이게 true 로 바뀌면 백엔드(authz.owns_facility)와 어긋나 admin 이 403 화면에 갇힌다.
assert.equal(canEnterMerchantConsole(account('admin')), false, 'admin 이 사장님 콘솔에 들어갔다');
assert.equal(canEnterMerchantConsole(null), false);

// ── 관제 대시보드 ──────────────────────────────────────────────────────────
assert.equal(canEnterAdminConsole(account('admin')), true);
assert.equal(canEnterAdminConsole(account('developer')), true, 'developer 는 admin 의 상위집합이다');
assert.equal(canEnterAdminConsole(account('merchant')), false);
assert.equal(canEnterAdminConsole(account('tourist')), false);
assert.equal(canEnterAdminConsole(null), false);

// ── 개발자 콘솔 ────────────────────────────────────────────────────────────
assert.equal(canEnterDevConsole(account('developer')), true);
assert.equal(canEnterDevConsole(account('admin')), false, 'admin 이 임명 권한까지 가졌다');
assert.equal(canEnterDevConsole(account('merchant')), false);
assert.equal(canEnterDevConsole(account('tourist')), false);
assert.equal(canEnterDevConsole(null), false);

// ── 사업자 인증 신청 ───────────────────────────────────────────────────────
assert.equal(canRequestBusinessVerification(account('tourist')), true);
// 게스트는 신원이 없어 심사할 수 없다 — 먼저 계정을 만들어야 한다.
assert.equal(
  canRequestBusinessVerification(account('tourist', { isAnonymous: true })),
  false,
  '익명 세션이 사업자 인증을 신청했다',
);
// 이미 권한이 있는 계정에는 신청 버튼을 띄우지 않는다.
assert.equal(canRequestBusinessVerification(account('merchant')), false);
assert.equal(canRequestBusinessVerification(account('admin')), false);
assert.equal(canRequestBusinessVerification(account('developer')), false);
assert.equal(canRequestBusinessVerification(null), false);

// ── 세 콘솔은 서로 배타적인가(developer 만 예외) ───────────────────────────
for (const role of ['tourist', 'merchant', 'admin'] as AccountRole[]) {
  const a = account(role);
  const entered = [canEnterMerchantConsole(a), canEnterAdminConsole(a), canEnterDevConsole(a)];
  assert.equal(
    entered.filter(Boolean).length <= 1,
    true,
    `${role} 이 콘솔 두 곳 이상에 들어갔다`,
  );
}

console.log('accountRoles tests passed');

// ── parseAccount — API 응답과 프런트 사이의 계약 ───────────────────────────
// 아래 payload 는 **실제 프로덕션 응답을 그대로 옮긴 것**이다(2026-08-28,
// GET https://nextspot-api.onrender.com/api/v1/account/me). 키를 손으로 바꾸지 말 것 —
// 손으로 맞추는 순간 이 테스트는 실제 계약이 아니라 내 기대를 검사하게 된다.
const REAL_PAYLOAD = {
  id: 'fab95350-95fe-423f-8b4b-b2fd138e7a00',
  role: 'merchant',
  is_anonymous: false,
  nickname: null,
  owned_facilities: [
    { id: '2cff2c71-5101-4b68-aa8e-dd18f7539400', name: '이풍녀 구로쌈밥', type: 'restaurant' },
  ],
  pending_verification: false,
};

const parsed = parseAccount(REAL_PAYLOAD);
assert.equal(parsed.id, REAL_PAYLOAD.id);
assert.equal(parsed.role, 'merchant');
// 이 세 줄이 이번 회귀의 핵심이다. camelCase 로 읽으면 전부 조용히 기본값이 되고,
// 특히 ownedFacilities 가 빈 배열이 되어 **모든 사장님이 "인증 대기" 화면에 갇힌다**.
assert.equal(parsed.ownedFacilities.length, 1, 'owned_facilities 를 못 읽었다 — 사장님 콘솔이 죽는다');
assert.equal(parsed.ownedFacilities[0].name, '이풍녀 구로쌈밥');
assert.equal(parsed.isAnonymous, false);

// 익명 게스트 — is_anonymous 를 놓치면 게스트에게 사업자 인증 폼이 열린다.
const guest = parseAccount({ id: 'g1', role: 'tourist', is_anonymous: true, owned_facilities: [] });
assert.equal(guest.isAnonymous, true, 'is_anonymous 를 못 읽었다 — 게스트가 정회원으로 취급된다');
assert.equal(canRequestBusinessVerification(guest), false);

// 심사 대기 — pending_verification 을 놓치면 "심사 중" 상태가 화면에 안 뜬다.
const pending = parseAccount({ id: 'p1', role: 'tourist', is_anonymous: false, pending_verification: true });
assert.equal(pending.pendingVerification, true);

// camelCase 로 온 응답은 **믿지 않는다**. 서버가 규약을 바꾼 것이므로 조용히 통과시키면
// 어느 쪽이 맞는지 알 수 없게 된다 — 기본값으로 떨어뜨려 테스트가 깨지게 둔다.
const wrongCase = parseAccount({ id: 'x', role: 'merchant', isAnonymous: true, ownedFacilities: [{ id: 'a' }] });
assert.equal(wrongCase.ownedFacilities.length, 0);
assert.equal(wrongCase.isAnonymous, false);

// 방어 — 응답이 비었거나 깨져도 화면이 죽으면 안 된다.
for (const bad of [null, undefined, {}, { owned_facilities: 'nope' }, { owned_facilities: [null] }]) {
  const a = parseAccount(bad);
  assert.equal(a.role, 'tourist');
  assert.ok(Array.isArray(a.ownedFacilities));
}

console.log('parseAccount contract tests passed');
