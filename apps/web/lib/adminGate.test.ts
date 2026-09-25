import { strict as assert } from 'node:assert';
import { decideAdminGate, type AdminGateInput } from './adminGate';

const base: AdminGateInput = {
  mounted: true,
  status: 'loading',
  unreachable: false,
  allowed: false,
  isLoginRoute: false,
  demo: false,
  optimisticAllowed: false,
};
const gate = (over: Partial<AdminGateInput>) => decideAdminGate({ ...base, ...over });

// ── 2026-09-26 01:21 회귀: 서버가 바빠 계정 조회가 타임아웃 → 로그인 화면으로 튕기면 안 된다 ──────────
{
  // 직전에 관리자로 확인된 브라우저(게이트 캐시 있음): 콘솔을 그대로 두고, 캐시도 지우지 않는다.
  const d = gate({ status: 'error', unreachable: true, optimisticAllowed: true });
  assert.equal(d.redirectToLogin, false, '서버에 닿지 못한 것은 권한 없음이 아니다 — 튕기지 않는다');
  assert.equal(d.view, 'console');
  assert.equal(d.cache, 'keep', '닿지 못했다고 긍정 캐시를 지우면 다음 방문도 로더에 갇힌다');
}
{
  // 캐시 없는 첫 방문: 로그인으로 보내지 않고 '서버 연결 확인 · 다시 시도' 를 보여 준다.
  const d = gate({ status: 'error', unreachable: true });
  assert.equal(d.redirectToLogin, false);
  assert.equal(d.view, 'server-unreachable');
  assert.equal(d.cache, 'keep');
}
{
  // 새로고침 실패지만 직전 계정을 알고 있음(resolveRefreshFailure 가 ready 로 유지) → 콘솔.
  const d = gate({ status: 'ready', unreachable: true, allowed: true });
  assert.equal(d.view, 'console');
  assert.equal(d.redirectToLogin, false);
  assert.equal(d.cache, 'save');
}

// ── 판정이 부정으로 끝났을 때만 로그인으로 보낸다(기존 동작 유지) ─────────────────────────────────
{
  // 세션 없음(401): AccountProvider 는 status 'error', unreachable false 로 끝낸다.
  const d = gate({ status: 'error', unreachable: false });
  assert.equal(d.redirectToLogin, true);
  assert.equal(d.view, 'loader');
  assert.equal(d.cache, 'clear');
}
{
  // 로그인했지만 관리자가 아님 — 게이트 캐시가 있어도 부정 판정이 이긴다.
  const d = gate({ status: 'ready', allowed: false, optimisticAllowed: true });
  assert.equal(d.redirectToLogin, true);
  assert.equal(d.view, 'loader', '부정으로 끝나면 낙관 렌더를 즉시 거둔다');
  assert.equal(d.cache, 'clear');
}
{
  // 관리자 확인 완료.
  const d = gate({ status: 'ready', allowed: true });
  assert.deepEqual(d, { view: 'console', redirectToLogin: false, cache: 'save' });
}

// ── 판정 전(로딩·마운트 전) ───────────────────────────────────────────────────────────────────
{
  assert.deepEqual(gate({ status: 'loading' }), { view: 'loader', redirectToLogin: false, cache: 'keep' });
  assert.deepEqual(gate({ status: 'loading', optimisticAllowed: true }), { view: 'console', redirectToLogin: false, cache: 'keep' });
  // 마운트 전에는 무엇도 확정하지 않는다(프리렌더·하이드레이션).
  assert.deepEqual(gate({ mounted: false, status: 'error' }), { view: 'loader', redirectToLogin: false, cache: 'keep' });
}

// ── 로그인 화면·데모는 언제나 통과, 데모는 남의 캐시를 건드리지 않는다 ───────────────────────────
{
  const login = gate({ isLoginRoute: true, status: 'error', unreachable: false });
  assert.equal(login.view, 'console');
  assert.equal(login.redirectToLogin, false, '로그인 화면에서 로그인 화면으로 보내지 않는다');

  const demoDenied = gate({ demo: true, status: 'error', unreachable: false });
  assert.deepEqual(demoDenied, { view: 'console', redirectToLogin: false, cache: 'keep' });
  const demoAllowed = gate({ demo: true, status: 'ready', allowed: true });
  assert.equal(demoAllowed.cache, 'keep');
}

console.log('adminGate.test.ts: ok');
