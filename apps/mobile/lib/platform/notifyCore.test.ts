import assert from 'node:assert/strict';

import {
  channelNameFrom,
  goldenNotificationId,
  goldenTriggerDate,
  reactionFor,
  scheduleGoldenNotify,
  stateFromPermission,
  type GoldenNotifyDeps,
  type GoldenScheduleRequest,
  type PermissionSnapshot,
} from './notifyCore';

function fakeDeps(initial: PermissionSnapshot, afterAsk: PermissionSnapshot, now: Date) {
  const calls: string[] = [];
  const scheduled: GoldenScheduleRequest[] = [];
  const deps: GoldenNotifyDeps = {
    prepare: async () => {
      calls.push('prepare');
    },
    getPermission: async () => {
      calls.push('get');
      return initial;
    },
    requestPermission: async () => {
      calls.push('ask');
      return afterAsk;
    },
    schedule: async (req) => {
      calls.push('schedule');
      scheduled.push(req);
    },
    now: () => now,
  };
  return { deps, calls, scheduled };
}

const GRANTED = { granted: true, canAskAgain: true };
const UNDECIDED = { granted: false, canAskAgain: true };
const BLOCKED = { granted: false, canAskAgain: false };
const input = { facilityId: 'f1', start: 16, title: 'T', body: 'B' };

async function main() {
  // --- id 는 웹 Notification tag 와 같은 값 ---
  assert.equal(goldenNotificationId('abc'), 'nextspot-golden-abc');

  // --- 오늘 start:00, 지났으면 바로(웹 delay 0) ---
  const at = goldenTriggerDate(16, new Date(2026, 10, 11, 14, 30));
  assert.ok(at);
  assert.equal(at.getHours(), 16);
  assert.equal(at.getMinutes(), 0);
  assert.equal(at.getDate(), 11);
  assert.equal(goldenTriggerDate(16, new Date(2026, 10, 11, 16, 0, 0, 0)), null);
  assert.equal(goldenTriggerDate(16, new Date(2026, 10, 11, 16, 20)), null);

  // --- 채널 이름: 앞 이모지만 뗀다 ---
  assert.equal(channelNameFrom('🕐 골든타임이에요'), '골든타임이에요');
  assert.equal(channelNameFrom('🕐 Golden hour!'), 'Golden hour!');
  assert.equal(channelNameFrom('골든타임'), '골든타임');
  assert.equal(channelNameFrom('🕐'), '🕐');

  // --- 처음 모양 ---
  assert.equal(stateFromPermission(GRANTED, false), 'available');
  assert.equal(stateFromPermission(UNDECIDED, false), 'available');
  assert.equal(stateFromPermission(BLOCKED, false), 'hidden');
  assert.equal(stateFromPermission(BLOCKED, true), 'scheduled');
  assert.equal(stateFromPermission(GRANTED, true), 'scheduled');

  // --- 누른 결과 → 버튼 ---
  assert.deepEqual(reactionFor('scheduled', false), { state: 'scheduled', deniedToast: false });
  assert.deepEqual(reactionFor('scheduled', true), { state: 'scheduled', deniedToast: false });
  assert.deepEqual(reactionFor('blocked', false), { state: 'hidden', deniedToast: false });
  assert.deepEqual(reactionFor('blocked', true), { state: null, deniedToast: true });
  assert.deepEqual(reactionFor('denied', false), { state: null, deniedToast: false });
  assert.deepEqual(reactionFor('failed', true), { state: null, deniedToast: false });

  const now = new Date(2026, 10, 11, 14, 30);

  // --- 이미 허용: 묻지 않고 채널 먼저 → 예약 ---
  {
    const f = fakeDeps(GRANTED, GRANTED, now);
    assert.equal(await scheduleGoldenNotify(input, f.deps), 'scheduled');
    assert.deepEqual(f.calls, ['prepare', 'get', 'schedule']);
    assert.equal(f.scheduled[0].id, 'nextspot-golden-f1');
    assert.equal(f.scheduled[0].at?.getHours(), 16);
    assert.equal(f.scheduled[0].title, 'T');
    assert.equal(f.scheduled[0].body, 'B');
  }
  // --- 처음 누름: 이때 묻는다 → 허용 → 예약 ---
  {
    const f = fakeDeps(UNDECIDED, GRANTED, now);
    assert.equal(await scheduleGoldenNotify(input, f.deps), 'scheduled');
    assert.deepEqual(f.calls, ['prepare', 'get', 'ask', 'schedule']);
  }
  // --- 거절(다시 물을 수 있음) → 예약 없음 ---
  {
    const f = fakeDeps(UNDECIDED, UNDECIDED, now);
    assert.equal(await scheduleGoldenNotify(input, f.deps), 'denied');
    assert.equal(f.scheduled.length, 0);
  }
  // --- 거절(설정에서만 풀림) → 묻지 않고 'blocked' ---
  {
    const f = fakeDeps(BLOCKED, GRANTED, now);
    assert.equal(await scheduleGoldenNotify(input, f.deps), 'blocked');
    assert.deepEqual(f.calls, ['prepare', 'get']);
  }
  // --- 묻는 중 두 번째 거절로 막힘 ---
  {
    const f = fakeDeps(UNDECIDED, BLOCKED, now);
    assert.equal(await scheduleGoldenNotify(input, f.deps), 'blocked');
  }
  // --- 시작이 지났으면 바로 알림(at null) ---
  {
    const f = fakeDeps(GRANTED, GRANTED, new Date(2026, 10, 11, 16, 5));
    assert.equal(await scheduleGoldenNotify(input, f.deps), 'scheduled');
    assert.equal(f.scheduled[0].at, null);
  }
  // --- 예약 실패·채널 실패는 'failed'(던지지 않는다) ---
  {
    const f = fakeDeps(GRANTED, GRANTED, now);
    f.deps.schedule = async () => {
      throw new Error('x');
    };
    assert.equal(await scheduleGoldenNotify(input, f.deps), 'failed');
    const g = fakeDeps(GRANTED, GRANTED, now);
    g.deps.prepare = async () => {
      throw new Error('y');
    };
    assert.equal(await scheduleGoldenNotify(input, g.deps), 'failed');
  }
  console.log('notifyCore ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
