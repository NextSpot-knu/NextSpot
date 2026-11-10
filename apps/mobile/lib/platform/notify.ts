// 골든타임 '알림 받기'(네이티브) — 기기 안 로컬 예약만 한다(D10 ①). 웹 빌드는 notify.web.ts(브라우저 Notification).
//
// - expo-notifications 의 날짜 트리거로 오늘 start:00 에 한 번. 지났으면 바로(trigger 에 시각 없음).
// - 안드로이드: 채널을 먼저 만든다(13+ 는 채널이 있어야 POST_NOTIFICATIONS 권한 창이 뜬다). 정확한 알람 권한
//   (SCHEDULE_EXACT_ALARM)은 받지 않는다 — 라이브러리가 권한이 없으면 setAndAllowWhileIdle(부정확)로 예약하므로
//   도즈 상태에서는 몇 분 늦을 수 있다. '한산한 한 시간' 안내라 몇 분은 괜찮다(app.json blockedPermissions 로 잠금).
// - 권한은 버튼을 누를 때만 묻는다(앱 시작 때 묻지 않는다).
// - getExpoPushTokenAsync·getDevicePushTokenAsync 를 부르지 않는다 — 서버로 가는 것이 없다(처리방침 '푸시 없음').
// - 예약은 기기에 남는다(재부팅 뒤에도 — 라이브러리가 RECEIVE_BOOT_COMPLETED 로 다시 건다). 그래서 웹(탭 닫으면 사라짐)과 달리
//   다시 열어도 '예약됨'을 보여 줄 수 있다.
import { Platform } from 'react-native';
import type * as NotificationsTypes from 'expo-notifications';

import {
  GOLDEN_CHANNEL_ID,
  channelNameFrom,
  goldenNotificationId,
  scheduleGoldenNotify,
  stateFromPermission,
  type GoldenNotifyInput,
  type GoldenNotifyOutcome,
  type GoldenNotifyState,
  type PermissionSnapshot,
} from './notifyCore';

export type { GoldenNotifyOutcome, GoldenNotifyState } from './notifyCore';

type NotificationsModule = typeof NotificationsTypes;
let loaded: NotificationsModule | null | undefined;

/**
 * expo-notifications 를 처음 쓸 때 불러온다. 네이티브 모듈이 없는 빌드(F1 이전 개발 빌드·Expo Go)에서는 가져오기만으로
 * 앱이 죽으므로 try 로 감싸고, 없으면 null — 버튼을 숨긴다('hidden'). 재빌드 뒤에는 그대로 동작한다.
 * 불러올 때 한 번 앞 화면 알림 핸들러를 건다(권한을 묻지 않는다) — 없으면 앱이 앞에 있는 동안 온 알림이 버려진다.
 */
function N(): NotificationsModule | null {
  if (loaded !== undefined) return loaded;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-notifications') as NotificationsModule;
    mod.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
    loaded = mod;
  } catch {
    loaded = null;
  }
  return loaded;
}

function snapshot(Notifications: NotificationsModule, p: NotificationsTypes.NotificationPermissionsStatus): PermissionSnapshot {
  const iosStatus = p.ios?.status;
  const iosAllowed =
    iosStatus === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    iosStatus === Notifications.IosAuthorizationStatus.EPHEMERAL;
  return { granted: p.granted || iosAllowed, canAskAgain: p.canAskAgain };
}

async function isScheduled(Notifications: NotificationsModule, facilityId: string): Promise<boolean> {
  const id = goldenNotificationId(facilityId);
  const all = await Notifications.getAllScheduledNotificationsAsync();
  return all.some((r) => r.identifier === id);
}

/** 그리기 전 처음 모양(동기) — 네이티브는 알림을 쓸 수 있으니 누를 수 있음으로 시작하고, 아래 확인으로 고친다. */
export function initialGoldenNotifyState(): GoldenNotifyState {
  return N() ? 'available' : 'hidden';
}

/** 이미 예약했는지 · 설정에서 막혔는지를 본다(권한을 묻지 않는다). 실패하면 누를 수 있음. */
export async function getGoldenNotifyState(facilityId: string): Promise<GoldenNotifyState> {
  const Notifications = N();
  if (!Notifications) return 'hidden';
  try {
    const [perm, scheduled] = await Promise.all([Notifications.getPermissionsAsync(), isScheduled(Notifications, facilityId)]);
    return stateFromPermission(snapshot(Notifications, perm), scheduled);
  } catch {
    return 'available';
  }
}

export function scheduleGolden(input: GoldenNotifyInput): Promise<GoldenNotifyOutcome> {
  const Notifications = N();
  if (!Notifications) return Promise.resolve('failed');
  return scheduleGoldenNotify(input, {
    prepare: async () => {
      if (Platform.OS !== 'android') return;
      await Notifications.setNotificationChannelAsync(GOLDEN_CHANNEL_ID, {
        name: channelNameFrom(input.title),
        importance: Notifications.AndroidImportance.HIGH,
      });
    },
    getPermission: async () => snapshot(Notifications, await Notifications.getPermissionsAsync()),
    requestPermission: async () =>
      snapshot(
        Notifications,
        await Notifications.requestPermissionsAsync({
          ios: { allowAlert: true, allowSound: true, allowBadge: false },
        }),
      ),
    schedule: async ({ id, title, body, at }) => {
      // 같은 시설은 하나만 — 앞 예약을 지우고 새로 건다.
      await Notifications.cancelScheduledNotificationAsync(id);
      const channel = Platform.OS === 'android' ? { channelId: GOLDEN_CHANNEL_ID } : null;
      await Notifications.scheduleNotificationAsync({
        identifier: id,
        content: { title, body, sound: true },
        trigger: at ? { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, ...channel } : channel,
      });
    },
    now: () => new Date(),
  });
}
