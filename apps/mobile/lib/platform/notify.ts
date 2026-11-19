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
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

import { createNativeDeps, nativeNotifyState, setForegroundHandler, type NotificationsModule } from './notifyAdapter';
import {
  nativeModulesPresent,
  requiredNotificationModules,
  scheduleGoldenNotify,
  type GoldenNotifyInput,
  type GoldenNotifyOutcome,
  type GoldenNotifyState,
} from './notifyCore';

export type { GoldenNotifyOutcome, GoldenNotifyState } from './notifyCore';

let loaded: NotificationsModule | null | undefined;
let handlerSet = false;

/**
 * expo-notifications 를 처음 쓸 때 불러온다. 재빌드 전 개발 빌드(네이티브 모듈 없음)에서는 null — 버튼을 숨긴다('hidden').
 * 1차: 가져오기 전에 필요한 네이티브 모듈이 모두 있는지 requireOptionalNativeModule(없으면 null)로 본다. try 만으로는 못 막는다 —
 *   렌더 중 처음 require 한 모듈이 맨 위에서 throw 하면 Metro guardedLoadModule(metro-runtime require.js)이 잡아
 *   ErrorUtils.reportFatalError 로 넘기고 다시 던지지 않는다(빨간 화면·앱 종료).
 * 2차: 그래도 try/catch 로 감싼다(바깥 모듈을 불러오는 중이면 throw 가 그대로 올라온다).
 */
function N(): NotificationsModule | null {
  if (loaded !== undefined) return loaded;
  if (!nativeModulesPresent(requiredNotificationModules(Platform.OS), requireOptionalNativeModule)) {
    loaded = null;
    return loaded;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require('expo-notifications') as NotificationsModule;
  } catch {
    loaded = null;
  }
  return loaded;
}

/**
 * 앱 시작 때 한 번(app/_layout.tsx) — 앞 화면 알림 핸들러만 건다. 권한을 묻지 않고 토큰을 만들지 않는다.
 * 핸들러가 없으면 앱이 앞에 있는 동안 온 알림이 버려진다(안드로이드 SingleNotificationHandlerTask 시간 초과) — 배지가 있는
 * 화면이 아니어도 받아야 하므로 배지 마운트가 아니라 시작 때 건다. 모듈이 없으면 아무것도 하지 않는다.
 */
export function primeGoldenNotifyHandler(): void {
  if (handlerSet) return;
  const mod = N();
  if (!mod) return;
  try {
    setForegroundHandler(mod);
    handlerSet = true;
  } catch {
    /* 핸들러 실패는 예약을 막지 않는다 — 앱이 뒤에 있을 때는 시스템이 보인다 */
  }
}

/** 그리기 전 처음 모양(동기) — 모듈이 있으면 누를 수 있음으로 시작하고, 아래 확인으로 고친다. */
export function initialGoldenNotifyState(): GoldenNotifyState {
  return N() ? 'available' : 'hidden';
}

/** 이미 예약했는지 · 설정에서 막혔는지를 본다(권한을 묻지 않는다). 실패하면 누를 수 있음. */
export async function getGoldenNotifyState(facilityId: string): Promise<GoldenNotifyState> {
  const mod = N();
  if (!mod) return 'hidden';
  try {
    return await nativeNotifyState(mod, facilityId);
  } catch {
    return 'available';
  }
}

export function scheduleGolden(input: GoldenNotifyInput): Promise<GoldenNotifyOutcome> {
  const mod = N();
  if (!mod) return Promise.resolve('failed');
  primeGoldenNotifyHandler();
  return scheduleGoldenNotify(input, createNativeDeps(mod, Platform.OS, input));
}
