import assert from 'node:assert/strict';

import {
  FOREGROUND_BEHAVIOR,
  createNativeDeps,
  nativeNotifyState,
  setForegroundHandler,
  snapshotFrom,
  triggerFor,
  type NotificationsModule,
} from './notifyAdapter';
import { nativeModulesPresent, requiredNotificationModules, scheduleGoldenNotify } from './notifyCore';

// expo-notifications 57 의 enum 값(Notifications.types / NotificationPermissions.types)과 같게.
const IOS = { NOT_DETERMINED: 0, DENIED: 1, AUTHORIZED: 2, PROVISIONAL: 3, EPHEMERAL: 4 };
const DATE = 'date';
const HIGH = 6;

type Perm = { granted: boolean; canAskAgain: boolean; ios?: { status: number } };

function fakeModule(perm: Perm, afterAsk: Perm, scheduledIds: string[] = []) {
  const calls: unknown[][] = [];
  const mod = {
    IosAuthorizationStatus: IOS,
    AndroidImportance: { HIGH },
    SchedulableTriggerInputTypes: { DATE },
    getPermissionsAsync: async () => (calls.push(['get']), perm),
    requestPermissionsAsync: async (req: unknown) => (calls.push(['ask', req]), afterAsk),
    setNotificationChannelAsync: async (id: string, ch: unknown) => (calls.push(['channel', id, ch]), null),
    cancelScheduledNotificationAsync: async (id: string) => void calls.push(['cancel', id]),
    scheduleNotificationAsync: async (req: unknown) => (calls.push(['schedule', req]), 'x'),
    getAllScheduledNotificationsAsync: async () => scheduledIds.map((identifier) => ({ identifier })),
    setNotificationHandler: (h: unknown) => void calls.push(['handler', h]),
  } as unknown as NotificationsModule;
  return { mod, calls };
}

const GRANTED: Perm = { granted: true, canAskAgain: true };
const UNDECIDED: Perm = { granted: false, canAskAgain: true };

async function main() {
  // --- 네이티브 모듈 확인: 하나라도 없으면 false, probe 가 던져도 false ---
  const android = requiredNotificationModules('android');
  const ios = requiredNotificationModules('ios');
  assert.ok(android.includes('ExpoNotificationScheduler'));
  assert.ok(android.includes('ExpoNotificationChannelManager'));
  assert.ok(android.includes('ExpoApplication'));
  assert.ok(!ios.includes('ExpoNotificationChannelManager'));
  assert.equal(android.length, ios.length + 2);
  assert.equal(nativeModulesPresent(android, () => ({})), true);
  assert.equal(nativeModulesPresent(android, (n) => (n === 'ExpoBadgeModule' ? null : {})), false);
  assert.equal(
    nativeModulesPresent(android, () => {
      throw new Error('boom');
    }),
    false,
  );

  // --- 권한 스냅샷: iOS 임시 허용·EPHEMERAL 은 허용 ---
  const { mod } = fakeModule(GRANTED, GRANTED);
  const snap = (p: Perm) => snapshotFrom(mod, p as never);
  assert.deepEqual(snap({ granted: false, canAskAgain: true, ios: { status: IOS.PROVISIONAL } }), { granted: true, canAskAgain: true });
  assert.deepEqual(snap({ granted: false, canAskAgain: false, ios: { status: IOS.EPHEMERAL } }), { granted: true, canAskAgain: false });
  assert.deepEqual(snap({ granted: false, canAskAgain: false, ios: { status: IOS.DENIED } }), { granted: false, canAskAgain: false });
  assert.deepEqual(snap({ granted: true, canAskAgain: true }), { granted: true, canAskAgain: true });

  // --- 트리거 모양 ---
  const at = new Date(2026, 10, 11, 16, 0);
  assert.deepEqual(triggerFor(mod, 'android', at), { type: DATE, date: at, channelId: 'golden-hour' });
  assert.deepEqual(triggerFor(mod, 'ios', at), { type: DATE, date: at });
  assert.deepEqual(triggerFor(mod, 'android', null), { channelId: 'golden-hour' });
  assert.equal(triggerFor(mod, 'ios', null), null);

  // --- 앞 화면 핸들러: 배너·목록·소리, 배지 숫자 없음 ---
  {
    const f = fakeModule(GRANTED, GRANTED);
    setForegroundHandler(f.mod);
    const h = f.calls[0][1] as { handleNotification: () => Promise<unknown> };
    assert.deepEqual(await h.handleNotification(), FOREGROUND_BEHAVIOR);
    assert.equal(FOREGROUND_BEHAVIOR.shouldSetBadge, false);
  }

  // --- 안드로이드: 채널 → 권한 확인 → 묻기 → 지우고 예약(같은 id) ---
  {
    const f = fakeModule(UNDECIDED, GRANTED);
    const deps = createNativeDeps(f.mod, 'android', { title: '🕐 골든타임이에요' }, () => new Date(2026, 10, 11, 14, 0));
    const out = await scheduleGoldenNotify({ facilityId: 'f1', start: 16, title: '🕐 골든타임이에요', body: 'B' }, deps);
    assert.equal(out, 'scheduled');
    assert.deepEqual(
      f.calls.map((c) => c[0]),
      ['channel', 'get', 'ask', 'cancel', 'schedule'],
    );
    assert.deepEqual(f.calls[0].slice(1), ['golden-hour', { name: '골든타임이에요', importance: HIGH }]);
    assert.deepEqual(f.calls[2][1], { ios: { allowAlert: true, allowSound: true, allowBadge: false } });
    assert.deepEqual(f.calls[3][1], 'nextspot-golden-f1');
    const req = f.calls[4][1] as { identifier: string; content: unknown; trigger: { type: string; date: Date; channelId: string } };
    assert.equal(req.identifier, 'nextspot-golden-f1');
    assert.deepEqual(req.content, { title: '🕐 골든타임이에요', body: 'B', sound: true });
    assert.equal(req.trigger.type, DATE);
    assert.equal(req.trigger.date.getHours(), 16);
    assert.equal(req.trigger.channelId, 'golden-hour');
  }
  // --- iOS: 채널 없음, 지난 시각은 바로(trigger null) ---
  {
    const f = fakeModule(GRANTED, GRANTED);
    const deps = createNativeDeps(f.mod, 'ios', { title: 'T' }, () => new Date(2026, 10, 11, 16, 30));
    assert.equal(await scheduleGoldenNotify({ facilityId: 'f2', start: 16, title: 'T', body: 'B' }, deps), 'scheduled');
    assert.deepEqual(
      f.calls.map((c) => c[0]),
      ['get', 'cancel', 'schedule'],
    );
    assert.equal((f.calls[2][1] as { trigger: unknown }).trigger, null);
  }

  // --- 처음 모양: 예약 목록에 같은 id 가 있으면 '예약됨', 막혔으면 숨김 ---
  {
    const f = fakeModule(GRANTED, GRANTED, ['nextspot-golden-f1']);
    assert.equal(await nativeNotifyState(f.mod, 'f1'), 'scheduled');
    assert.equal(await nativeNotifyState(f.mod, 'f9'), 'available');
    const b = fakeModule({ granted: false, canAskAgain: false }, GRANTED);
    assert.equal(await nativeNotifyState(b.mod, 'f1'), 'hidden');
  }
  console.log('notifyAdapter ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
