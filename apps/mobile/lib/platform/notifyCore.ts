// 골든타임 '알림 받기' 흐름 — 웹 apps/web/components/GoldenHourBadge.tsx 의 handleNotify(기준 커밋 226df81)를 화면 없이 옮겼다(D10 ①).
// 순수 로직이며 권한·예약은 주입한다(notify.ts 가 expo-notifications 로, notify.web.ts 가 브라우저 Notification 으로 채운다).
//
//   1) 권한을 본다. 아직 묻지 않았으면(묻기 가능) 이때 처음 묻는다 — 앱 시작 때는 묻지 않는다(웹도 누를 때만 묻는다).
//   2) 거절이면 예약하지 않는다. 다시 물을 수 있으면 'denied', 시스템 설정에서만 풀리면 'blocked'.
//   3) 오늘 start:00(기기 시각 — 웹과 같은 전제)에 한 번 알린다. 이미 지났으면 웹(delay 0)처럼 바로 알린다.
//   4) 예약 id 는 시설마다 하나(`nextspot-golden-<id>` — 웹 Notification tag 와 같은 값)라 다시 예약하면 앞 것을 갈아 끼운다.
// 서버로 아무것도 보내지 않는다 — 푸시 토큰을 만들지도 않는다(처리방침 '푸시 없음').

export type GoldenNotifyOutcome = 'scheduled' | 'denied' | 'blocked' | 'failed';

/** 버튼 처음 모양: 누를 수 있음 · 이미 예약됨 · 숨김(알림을 쓸 수 없는 환경 — 웹도 미지원이면 버튼을 그리지 않는다). */
export type GoldenNotifyState = 'available' | 'scheduled' | 'hidden';

export interface PermissionSnapshot {
  granted: boolean;
  /** false 면 앱이 다시 물을 수 없다(안드로이드 13+ 두 번 거절 · iOS 한 번 거절 · 브라우저 차단). */
  canAskAgain: boolean;
}

export interface GoldenNotifyInput {
  facilityId: string;
  /** KST 시(0-23) — 가장 한산한 60분 창의 시작. */
  start: number;
  title: string;
  body: string;
}

export interface GoldenScheduleRequest {
  id: string;
  title: string;
  body: string;
  /** null 이면 바로 알린다. */
  at: Date | null;
}

export interface GoldenNotifyDeps {
  getPermission(): Promise<PermissionSnapshot>;
  requestPermission(): Promise<PermissionSnapshot>;
  /** 예약 전에 할 일(안드로이드 채널 만들기 — 13+ 는 채널이 있어야 권한 창이 뜬다). */
  prepare?(): Promise<void>;
  schedule(req: GoldenScheduleRequest): Promise<void>;
  now(): Date;
}

export const GOLDEN_CHANNEL_ID = 'golden-hour';

/**
 * `require('expo-notifications')` 가 가져오는 순간 requireNativeModule(없으면 throw)로 부르는 네이티브 모듈 전부
 * (expo-notifications 57.0.25 build/*.native.js · *.android.js 와 의존 expo-application 의 ExpoApplication).
 * 하나라도 없으면(재빌드 전 개발 빌드) 가져오지 않는다. 버전을 올리면 build 의 requireNativeModule 목록과 다시 맞춘다.
 * iOS 에는 채널 모듈이 없고 가져오지도 않는다(*.android.js 만 부른다).
 */
const NOTIFICATION_NATIVE_MODULES = [
  'ExpoBackgroundNotificationTasksModule',
  'ExpoBadgeModule',
  'ExpoNotificationCategoriesModule',
  'ExpoNotificationPermissionsModule',
  'ExpoNotificationPresenter',
  'ExpoNotificationScheduler',
  'ExpoNotificationsEmitter',
  'ExpoNotificationsHandlerModule',
  'ExpoPushTokenManager',
  'NotificationsServerRegistrationModule',
  'ExpoApplication',
] as const;
const ANDROID_ONLY_NATIVE_MODULES = ['ExpoNotificationChannelManager', 'ExpoNotificationChannelGroupManager'] as const;

export function requiredNotificationModules(os: string): string[] {
  return os === 'android' ? [...NOTIFICATION_NATIVE_MODULES, ...ANDROID_ONLY_NATIVE_MODULES] : [...NOTIFICATION_NATIVE_MODULES];
}

/** probe = expo 의 requireOptionalNativeModule(없으면 null, throw 하지 않음). 던지면 없는 것으로 본다. */
export function nativeModulesPresent(names: readonly string[], probe: (name: string) => unknown): boolean {
  return names.every((n) => {
    try {
      return probe(n) != null;
    } catch {
      return false;
    }
  });
}

export function goldenNotificationId(facilityId: string): string {
  return `nextspot-golden-${facilityId}`;
}

/** 오늘 start:00. 지금이 그 시각이거나 지났으면 null(바로 알림). */
export function goldenTriggerDate(start: number, now: Date): Date | null {
  const target = new Date(now.getTime());
  target.setHours(start, 0, 0, 0);
  return target.getTime() > now.getTime() ? target : null;
}

/** 알림 채널 이름 — 제목 문구 앞의 이모지를 뗀다("🕐 골든타임이에요" → "골든타임이에요"). 전용 키가 생기면 그것으로 바꾼다. */
export function channelNameFrom(title: string): string {
  const stripped = title.replace(/^[\p{Extended_Pictographic}️‍\s]+/u, '').trim();
  return stripped || title;
}

export function stateFromPermission(p: PermissionSnapshot, alreadyScheduled: boolean): GoldenNotifyState {
  if (alreadyScheduled) return 'scheduled';
  if (!p.granted && !p.canAskAgain) return 'hidden';
  return 'available';
}

/**
 * 누른 결과 → 버튼이 할 일.
 *  - scheduled: '예약됨'(비활성 — 웹과 같다).
 *  - denied(다시 물을 수 있음)·failed: 아무것도 하지 않는다(웹도 조용히 끝낸다).
 *  - blocked: 웹 빌드는 웹 알림 차단 문구(alert.denied · alert.deniedSub — '브라우저 설정' 이라 브라우저에서만 맞다)를 띄우고 버튼은 둔다.
 *    네이티브는 앱이 다시 물을 수 없으니 되지 않는 버튼을 남기지 않고 숨긴다(웹이 미지원 환경에서 버튼을 그리지 않는 것과 같은 원칙).
 */
export type GoldenNotifyReaction = { state: GoldenNotifyState | null; deniedToast: boolean };

export function reactionFor(outcome: GoldenNotifyOutcome, isWeb: boolean): GoldenNotifyReaction {
  if (outcome === 'scheduled') return { state: 'scheduled', deniedToast: false };
  if (outcome === 'blocked') return isWeb ? { state: null, deniedToast: true } : { state: 'hidden', deniedToast: false };
  return { state: null, deniedToast: false };
}

export async function scheduleGoldenNotify(input: GoldenNotifyInput, deps: GoldenNotifyDeps): Promise<GoldenNotifyOutcome> {
  try {
    await deps.prepare?.();
    let perm = await deps.getPermission();
    if (!perm.granted && perm.canAskAgain) perm = await deps.requestPermission();
    if (!perm.granted) return perm.canAskAgain ? 'denied' : 'blocked';
    await deps.schedule({
      id: goldenNotificationId(input.facilityId),
      title: input.title,
      body: input.body,
      at: goldenTriggerDate(input.start, deps.now()),
    });
    return 'scheduled';
  } catch {
    return 'failed';
  }
}
