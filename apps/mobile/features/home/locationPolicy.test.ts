import assert from 'node:assert/strict';

import {
  myLocationAction,
  READ_COOLDOWN_MS,
  shouldRecheckOnForeground,
  showsMyLocationButton,
  showsUserDot,
  withinCooldown,
} from './locationPolicy';

const base = { notice: null, readFailed: false, lastReadAttemptAt: null, now: 1_000_000 } as const;

// 거부 · 사전 안내 · 동의 없음 — 설정에서 바꾸고 왔을 수 있으니 다시 본다
assert.equal(shouldRecheckOnForeground({ ...base, status: 'denied' }), true);
assert.equal(shouldRecheckOnForeground({ ...base, status: 'needs-primer' }), true);
assert.equal(shouldRecheckOnForeground({ ...base, status: 'no-consent' }), true);
// 보는 중이면 겹쳐 보지 않는다
assert.equal(shouldRecheckOnForeground({ ...base, status: 'checking' }), false);

// 허용 + 정상 위치 — 돌아올 때마다 다시 읽지 않는다(정확도 창 고리 방지)
assert.equal(shouldRecheckOnForeground({ ...base, status: 'granted', lastReadAttemptAt: base.now - 10 * 60_000 }), false);
// 허용 + 읽기 실패 — 자동으로 다시 읽지 않는다
assert.equal(shouldRecheckOnForeground({ ...base, status: 'granted', readFailed: true, notice: 'coarse' }), false);
// 허용 + 대략적 위치 — 쿨다운 안이면 다시 읽지 않는다(창이 닫힌 직후의 active)
assert.equal(shouldRecheckOnForeground({ ...base, status: 'granted', notice: 'coarse', lastReadAttemptAt: base.now - 2_000 }), false);
// 쿨다운이 지났으면 한 번 다시 본다(설정에서 정확한 위치를 켜고 왔을 수 있다)
assert.equal(
  shouldRecheckOnForeground({ ...base, status: 'granted', notice: 'coarse', lastReadAttemptAt: base.now - READ_COOLDOWN_MS }),
  true,
);
// 경주 밖은 권한 문제가 아니다 — 다시 읽지 않는다
assert.equal(shouldRecheckOnForeground({ ...base, status: 'granted', notice: 'outOfRegion' }), false);

// 쿨다운 판정
assert.equal(withinCooldown(null, 100), false);
assert.equal(withinCooldown(100, 100 + READ_COOLDOWN_MS - 1), true);
assert.equal(withinCooldown(100, 100 + READ_COOLDOWN_MS), false);
assert.equal(withinCooldown(200, 100), false, '시계가 뒤로 가면 막지 않는다');

console.log('locationPolicy.test OK');

// ── 내 위치 점 · '내 위치로' 버튼 ──
{
  const loc = { known: false, notice: null, readFailed: false, canAskAgain: false } as const;
  // 점: 동의 + 허용 + 실제 위치일 때만
  assert.equal(showsUserDot({ status: 'granted', known: true }), true);
  assert.equal(showsUserDot({ status: 'granted', known: false }), false);
  assert.equal(showsUserDot({ status: 'no-consent', known: false }), false);
  assert.equal(showsUserDot({ status: 'denied', known: true }), false);
  // 버튼: 확인 중 · 사전 안내 동안만 숨긴다
  assert.equal(showsMyLocationButton('checking'), false);
  assert.equal(showsMyLocationButton('needs-primer'), false);
  assert.equal(showsMyLocationButton('no-consent'), true);
  assert.equal(showsMyLocationButton('denied'), true);
  assert.equal(showsMyLocationButton('granted'), true);
  // 동작
  assert.equal(myLocationAction({ ...loc, status: 'no-consent', canAskAgain: true }), 'consent');
  assert.equal(myLocationAction({ ...loc, status: 'needs-primer', canAskAgain: true }), 'request');
  assert.equal(myLocationAction({ ...loc, status: 'denied', canAskAgain: true }), 'request');
  assert.equal(myLocationAction({ ...loc, status: 'denied', canAskAgain: false }), 'settings');
  assert.equal(myLocationAction({ ...loc, status: 'granted', known: true }), 'recenter');
  assert.equal(myLocationAction({ ...loc, status: 'granted', notice: 'outOfRegion' }), 'outOfRegion');
  assert.equal(myLocationAction({ ...loc, status: 'granted', notice: 'coarse' }), 'coarse');
  assert.equal(myLocationAction({ ...loc, status: 'granted', readFailed: true }), 'retry');
  assert.equal(myLocationAction({ ...loc, status: 'checking' }), 'none');
}
