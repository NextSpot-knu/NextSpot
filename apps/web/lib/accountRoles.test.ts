import assert from 'node:assert/strict';
import {
  canEnterAdminConsole,
  canEnterDevConsole,
  canEnterMerchantConsole,
  canRequestBusinessVerification,
  normalizeRole,
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
