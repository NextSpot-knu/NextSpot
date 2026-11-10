// expo-notifications 를 notifyCore 의 주입 의존으로 잇는 부분 — 모듈과 OS 를 인자로 받는다(테스트가 가짜 모듈로 부른다).
// 값으로는 expo-notifications 를 가져오지 않는다(타입만). 실제 모듈은 notify.ts 가 네이티브 모듈 확인 뒤 넘긴다.
import type * as NotificationsTypes from 'expo-notifications';

import {
  GOLDEN_CHANNEL_ID,
  channelNameFrom,
  goldenNotificationId,
  stateFromPermission,
  type GoldenNotifyDeps,
  type GoldenNotifyInput,
  type GoldenNotifyState,
  type PermissionSnapshot,
} from './notifyCore';

export type NotificationsModule = Pick<
  typeof NotificationsTypes,
  | 'getPermissionsAsync'
  | 'requestPermissionsAsync'
  | 'setNotificationChannelAsync'
  | 'cancelScheduledNotificationAsync'
  | 'scheduleNotificationAsync'
  | 'getAllScheduledNotificationsAsync'
  | 'setNotificationHandler'
  | 'IosAuthorizationStatus'
  | 'AndroidImportance'
  | 'SchedulableTriggerInputTypes'
>;

/** 앱이 앞에 있을 때 온 알림도 배너·목록·소리로 보인다(배지 숫자는 쓰지 않는다). */
export const FOREGROUND_BEHAVIOR = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
} as const;

export function setForegroundHandler(N: NotificationsModule): void {
  N.setNotificationHandler({ handleNotification: async () => ({ ...FOREGROUND_BEHAVIOR }) });
}

/** iOS 는 임시 허용(PROVISIONAL)·앱 클립(EPHEMERAL)도 알림이 간다 — granted 가 false 여도 허용으로 본다. */
export function snapshotFrom(N: NotificationsModule, p: NotificationsTypes.NotificationPermissionsStatus): PermissionSnapshot {
  const iosStatus = p.ios?.status;
  const iosAllowed =
    iosStatus === N.IosAuthorizationStatus.PROVISIONAL || iosStatus === N.IosAuthorizationStatus.EPHEMERAL;
  return { granted: p.granted || iosAllowed, canAskAgain: p.canAskAgain };
}

/** 날짜가 있으면 DATE 트리거, 없으면 바로. 안드로이드는 두 경우 모두 골든타임 채널에 싣는다. */
export function triggerFor(N: NotificationsModule, os: string, at: Date | null): NotificationsTypes.NotificationTriggerInput {
  const channel = os === 'android' ? { channelId: GOLDEN_CHANNEL_ID } : null;
  return at ? { type: N.SchedulableTriggerInputTypes.DATE, date: at, ...channel } : channel;
}

export async function nativeNotifyState(N: NotificationsModule, facilityId: string): Promise<GoldenNotifyState> {
  const id = goldenNotificationId(facilityId);
  const [perm, all] = await Promise.all([N.getPermissionsAsync(), N.getAllScheduledNotificationsAsync()]);
  return stateFromPermission(snapshotFrom(N, perm), all.some((r) => r.identifier === id));
}

export function createNativeDeps(
  N: NotificationsModule,
  os: string,
  input: Pick<GoldenNotifyInput, 'title'>,
  now: () => Date = () => new Date(),
): GoldenNotifyDeps {
  return {
    prepare: async () => {
      if (os !== 'android') return;
      await N.setNotificationChannelAsync(GOLDEN_CHANNEL_ID, {
        name: channelNameFrom(input.title),
        importance: N.AndroidImportance.HIGH,
      });
    },
    getPermission: async () => snapshotFrom(N, await N.getPermissionsAsync()),
    requestPermission: async () =>
      snapshotFrom(N, await N.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } })),
    schedule: async ({ id, title, body, at }) => {
      // 같은 시설은 하나만 — 앞 예약을 지우고 새로 건다.
      await N.cancelScheduledNotificationAsync(id);
      await N.scheduleNotificationAsync({ identifier: id, content: { title, body, sound: true }, trigger: triggerFor(N, os, at) });
    },
    now,
  };
}
