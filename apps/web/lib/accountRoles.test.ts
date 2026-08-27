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
import { keysToCamel, keysToSnake } from './caseTransform';

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

// ── parseAccount — 서버 응답부터 화면까지 체인 전체 ────────────────────────
// 이 테스트의 요점은 **raw 응답을 손으로 camelCase 로 고쳐 넣지 않는 것**이다.
// 실제 서버가 보낸 그대로를 실제 변환기(keysToCamel)에 통과시킨 뒤 파싱한다.
// 손으로 맞춘 payload 를 쓰면 계약이 아니라 내 기대를 검사하게 되고, 변환기가 빠지거나
// 서버 키가 바뀌어도 초록불이 유지된다 — 그 틈에서 실제로 한 번 틀렸다(2026-08-28).
const RAW_FROM_SERVER = {
  id: 'fab95350-95fe-423f-8b4b-b2fd138e7a00',
  role: 'merchant',
  is_anonymous: false,
  nickname: null,
  owned_facilities: [
    { id: '2cff2c71-5101-4b68-aa8e-dd18f7539400', name: '이풍녀 구로쌈밥', type: 'restaurant' },
  ],
  pending_verification: false,
};

const asClientSeesIt = keysToCamel(RAW_FROM_SERVER);
assert.equal(asClientSeesIt.ownedFacilities.length, 1, 'apiClient 변환이 깨졌다');
assert.equal(asClientSeesIt.isAnonymous, false);

const parsed = parseAccount(asClientSeesIt);
assert.equal(parsed.id, RAW_FROM_SERVER.id);
assert.equal(parsed.role, 'merchant');
// 이 줄이 핵심이다. 소유 가게를 못 읽으면 role 은 merchant 인데 다룰 가게가 없어
// **모든 사장님이 "인증 대기" 화면에 갇힌다** — 콘솔이 통째로 쓸모없어진다.
assert.equal(parsed.ownedFacilities.length, 1, '소유 가게를 못 읽었다 — 사장님 콘솔이 죽는다');
assert.equal(parsed.ownedFacilities[0].name, '이풍녀 구로쌈밥');
assert.equal(parsed.isAnonymous, false);

// 익명 게스트 — 놓치면 게스트에게 사업자 인증 폼이 열린다(백엔드는 403 이라 실패하는 폼).
const guest = parseAccount(keysToCamel({ id: 'g1', role: 'tourist', is_anonymous: true, owned_facilities: [] }));
assert.equal(guest.isAnonymous, true);
assert.equal(canRequestBusinessVerification(guest), false);

// 심사 대기 — 놓치면 "심사 중" 상태가 화면에 안 뜬다.
const pending = parseAccount(keysToCamel({ id: 'p1', role: 'tourist', is_anonymous: false, pending_verification: true }));
assert.equal(pending.pendingVerification, true);

// 변환기를 건너뛴 raw 를 그대로 넣으면 읽히지 않아야 한다 — 그래야 배선이 빠졌을 때
// 조용히 넘어가지 않고 여기서 드러난다.
const unconverted = parseAccount(RAW_FROM_SERVER);
assert.equal(unconverted.ownedFacilities.length, 0);
assert.equal(unconverted.isAnonymous, false);

// 방어 — 응답이 비었거나 깨져도 화면이 죽으면 안 된다.
for (const bad of [null, undefined, {}, { ownedFacilities: 'nope' }, { ownedFacilities: [null] }]) {
  const a = parseAccount(bad);
  assert.equal(a.role, 'tourist');
  assert.ok(Array.isArray(a.ownedFacilities));
}

// ── 변환기 자체 ────────────────────────────────────────────────────────────
assert.deepEqual(keysToCamel({ a_b: 1, c: { d_e: [{ f_g: 2 }] } }), { aB: 1, c: { dE: [{ fG: 2 }] } });
assert.deepEqual(keysToSnake({ aB: 1, c: { dE: [{ fG: 2 }] } }), { a_b: 1, c: { d_e: [{ f_g: 2 }] } });
assert.equal(keysToCamel(null), null);
assert.deepEqual(keysToCamel([1, 'x']), [1, 'x']);
// 이미 camelCase 인 키는 그대로 — 서버가 규약을 바꿔도 화면이 안 깨진다.
assert.deepEqual(keysToCamel({ alreadyCamel: 1 }), { alreadyCamel: 1 });

console.log('parseAccount contract tests passed');
