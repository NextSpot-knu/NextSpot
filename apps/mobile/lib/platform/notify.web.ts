// 골든타임 '알림 받기'(Expo 웹 빌드) — 웹 apps/web/components/GoldenHourBadge.tsx(226df81)와 같은 브라우저 Notification + setTimeout.
// 탭이 열려 있는 동안만 산다(웹과 같은 세션 한정). 브라우저에 Notification 이 없으면 버튼을 숨긴다(웹과 같다).
// 웹과 다른 한 가지: 타이머를 배지가 아니라 이 모듈이 들고 있어, 카드를 접었다 펴도 예약이 남고 '예약됨'으로 다시 보인다
// (웹은 배지가 사라지면 타이머를 지워 '예약됨'을 본 알림이 조용히 사라진다).
// expo-notifications 를 가져오지 않는다(웹 번들에 넣지 않음). 서버로 가는 것이 없다.
import {
  goldenNotificationId,
  scheduleGoldenNotify,
  type GoldenNotifyInput,
  type GoldenNotifyOutcome,
  type GoldenNotifyState,
  type PermissionSnapshot,
} from './notifyCore';

export type { GoldenNotifyOutcome, GoldenNotifyState } from './notifyCore';

type BrowserPermission = 'default' | 'granted' | 'denied';
interface BrowserNotificationCtor {
  permission: BrowserPermission;
  requestPermission(): Promise<BrowserPermission>;
  new (title: string, options?: { body?: string; tag?: string; icon?: string }): unknown;
}

function browserNotification(): BrowserNotificationCtor | null {
  const N = (globalThis as { Notification?: BrowserNotificationCtor }).Notification;
  return typeof N === 'undefined' ? null : N;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function snapshot(p: BrowserPermission): PermissionSnapshot {
  return { granted: p === 'granted', canAskAgain: p === 'default' };
}

export function initialGoldenNotifyState(): GoldenNotifyState {
  return browserNotification() ? 'available' : 'hidden';
}

/** 웹처럼 권한이 막혀 있어도 버튼은 보인다(누르면 차단 문구). 숨기는 것은 Notification 이 없을 때뿐. */
export async function getGoldenNotifyState(facilityId: string): Promise<GoldenNotifyState> {
  if (!browserNotification()) return 'hidden';
  return timers.has(goldenNotificationId(facilityId)) ? 'scheduled' : 'available';
}

export function scheduleGolden(input: GoldenNotifyInput): Promise<GoldenNotifyOutcome> {
  const N = browserNotification();
  if (!N) return Promise.resolve('failed');
  return scheduleGoldenNotify(input, {
    getPermission: async () => snapshot(N.permission),
    requestPermission: async () => snapshot(await N.requestPermission()),
    schedule: async ({ id, title, body, at }) => {
      const prev = timers.get(id);
      if (prev) clearTimeout(prev);
      const delayMs = at ? Math.max(0, at.getTime() - Date.now()) : 0;
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          try {
            new N(title, { body, tag: id, icon: '/favicon.ico' });
          } catch {
            /* 알림 생성 실패는 무시(웹과 같다) */
          }
        }, delayMs),
      );
    },
    now: () => new Date(),
  });
}
