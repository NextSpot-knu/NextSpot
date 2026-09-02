import assert from 'node:assert/strict';
import {
  canEnterAdminConsole,
  canEnterDevConsole,
  canEnterMerchantConsole,
  canRequestBusinessVerification,
  canRequestRoleChange,
  normalizeRole,
  parseAccount,
  resolveRefreshFailure,
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

// ── 역할 변경 신청 자격 ────────────────────────────────────────────────────
// canRequestBusinessVerification 보다 넓다. 좁게 두면 사장님·관리자에게 신청 경로가
// 아예 없어진다(마이페이지 버튼이 통째로 안 보인다).
{
  const make = (role: string, isAnonymous = false) =>
    parseAccount(keysToCamel({ id: 'x', role, is_anonymous: isAnonymous }));

  assert.equal(canRequestRoleChange(make('tourist')), true);
  assert.equal(canRequestRoleChange(make('merchant')), true, '사장님도 관리자 권한을 신청할 수 있어야 한다');
  assert.equal(canRequestRoleChange(make('admin')), true);
  // 개발자는 /dev 콘솔에서 직접 바꾼다 — 자기 자신에게 신청서를 낼 이유가 없다.
  assert.equal(canRequestRoleChange(make('developer')), false);
  // 게스트는 서버가 403 으로 막는다. 폼을 열어 주면 반드시 실패하는 폼이 된다.
  assert.equal(canRequestRoleChange(make('tourist', true)), false);
  assert.equal(canRequestRoleChange(null), false);
}

// ── 조회 실패 후 상태 — 실패는 '계정 없음' 이 아니다 ──────────────────────
// 실제로 났던 버그: 마이페이지의 역할 변경 신청 버튼이 "한 번 들어갔다 나오면 사라진다".
// 원인은 여기였다 — 모든 실패를 account=null 로 처리했고, null 은 게스트와 같은 값이라
// 타임아웃 한 번이 곧 로그아웃처럼 보였다. 루트 레이아웃 프로바이더의 메모리 상태라
// 화면을 옮겨도 다시 조회하지 않아, 한 번 사라지면 새로고침 전까지 돌아오지 않았다.
{
  const known = account('merchant');

  // 401 만이 '계정이 없다' 다.
  assert.deepEqual(resolveRefreshFailure(known, true), { account: null, status: 'error' });

  // 타임아웃·503·오프라인 — 알던 계정을 지우지 않는다. 이게 버그의 수정점이다.
  const kept = resolveRefreshFailure(known, false);
  assert.equal(kept.account, known, '일시적 실패가 알던 계정을 지웠다');
  assert.equal(kept.status, 'ready', '유지한 계정을 error 로 두면 화면이 로딩에 갇힌다');

  // 첫 조회부터 실패하면 보여 줄 것이 없다 — 게스트로 떨어뜨린다(기존 동작).
  assert.deepEqual(resolveRefreshFailure(null, false), { account: null, status: 'error' });
  assert.deepEqual(resolveRefreshFailure(null, true), { account: null, status: 'error' });

  // 증상 자체를 잠근다: 일시적 실패 뒤에도 버튼 판정이 그대로여야 한다.
  assert.equal(
    canRequestRoleChange(resolveRefreshFailure(account('tourist'), false).account),
    true,
    '일시적 실패 뒤에 역할 변경 신청 버튼이 사라졌다',
  );
  // 반대 방향도 잠근다 — 세션이 진짜 없으면 버튼은 사라져야 한다.
  assert.equal(
    canRequestRoleChange(resolveRefreshFailure(account('tourist'), true).account),
    false,
  );
}

console.log('parseAccount contract tests passed');
