// 홈 위치를 언제 다시 볼지 — 순수 모듈(테스트: locationPolicy.test.ts). 쓰는 곳: useUserLocation.
//
// 왜 필요한가: 안드로이드는 getCurrentPositionAsync 가 '위치 정확도 켜기' 시스템 창을 띄울 수 있다. 그 창이 닫히면 앱이
// 다시 'active' 가 되는데, 그때마다 다시 읽으면 창이 또 뜨고 — 끝없이 돈다. 그래서:
//   · 거부 · 사전 안내 · 동의 없음일 때만 돌아올 때 다시 본다(설정 앱에서 권한·동의를 바꾸고 왔을 수 있다).
//   · 허용 상태는 돌아올 때마다 다시 읽지 않는다 — 동의 문구대로 '화면을 열 때' 한 번 읽는다.
//     예외는 대략적 위치(coarse)뿐이다(설정에서 정확한 위치를 켜고 왔을 수 있다). 그래도 읽기 실패 뒤나
//     마지막 읽기 시도에서 READ_COOLDOWN_MS 안에는 다시 읽지 않는다.
import type { LocationNotice } from './homeModel';

export type ForegroundStatus = 'checking' | 'needs-primer' | 'granted' | 'denied' | 'no-consent';

/** 읽기 시도 뒤 이 시간 안에는 앱이 돌아와도 다시 읽지 않는다(정확도 창이 닫힌 직후의 'active' 를 거른다). */
export const READ_COOLDOWN_MS = 60_000;
/** 마지막으로 알려진 위치를 이만큼 최근 것이면 그대로 쓴다(시스템 창 없이 바로 답한다). */
export const LAST_KNOWN_MAX_AGE_MS = 2 * 60_000;
/** 마지막으로 알려진 위치의 정확도 요구(m) — 이보다 거칠면 새로 읽는다. */
export const LAST_KNOWN_REQUIRED_ACCURACY_M = 200;

export interface ForegroundInput {
  status: ForegroundStatus;
  notice: LocationNotice;
  readFailed: boolean;
  /** 마지막 읽기 시도 시각(ms). 시도한 적 없으면 null. */
  lastReadAttemptAt: number | null;
  now: number;
}

/** 앱이 다시 앞으로 왔을 때 권한·위치를 다시 볼까. */
export function shouldRecheckOnForeground(input: ForegroundInput): boolean {
  const { status } = input;
  if (status === 'denied' || status === 'needs-primer' || status === 'no-consent') return true;
  if (status !== 'granted') return false; // 'checking' — 이미 보는 중
  if (input.readFailed) return false;
  if (input.notice !== 'coarse') return false;
  return !withinCooldown(input.lastReadAttemptAt, input.now);
}

/** 마지막 읽기 시도에서 아직 쿨다운 안인가. */
export function withinCooldown(lastReadAttemptAt: number | null, now: number, cooldownMs = READ_COOLDOWN_MS): boolean {
  return lastReadAttemptAt !== null && now - lastReadAttemptAt >= 0 && now - lastReadAttemptAt < cooldownMs;
}

// ── 내 위치 점 · '내 위치로' 버튼 ───────────────────────────────────────────

export interface MyLocationInput {
  status: ForegroundStatus;
  /** 정말 내 위치인가(경주 밖 · 대략적 위치 · 읽기 전이면 false — 황리단길 중심으로 바꾼 값). */
  known: boolean;
  notice: LocationNotice;
  readFailed: boolean;
  /** OS 가 권한 창을 다시 띄울 수 있는가(expo-location canAskAgain). 거부 상태에서만 본다. */
  canAskAgain: boolean;
}

/** 내 위치 점은 동의 + OS 허용 + 실제로 읽은 내 위치일 때만 — 지역 중심으로 바꾼 자리에 '내 위치'를 그리지 않는다. */
export function showsUserDot(input: Pick<MyLocationInput, 'status' | 'known'>): boolean {
  return input.status === 'granted' && input.known;
}

/** '내 위치로' 버튼을 그리는가 — 확인 중 · 사전 안내(전면 안내가 떠 있다)일 때만 숨긴다. */
export function showsMyLocationButton(status: ForegroundStatus): boolean {
  return status !== 'checking' && status !== 'needs-primer';
}

export type MyLocationAction =
  /** 내 위치로 지도를 옮긴다(최근에 읽지 않았으면 한 번 다시 읽는다 — 앱을 쓰는 중 사용자가 누른 것이다). */
  | 'recenter'
  /** 위치정보 이용 동의 화면(동의 없이는 OS 권한을 보지도 묻지도 않는다). */
  | 'consent'
  /** 사전 안내의 '계속'과 같다 — 시스템 권한 창(아직 묻지 않았거나, 안드로이드에서 한 번 거부해 다시 물을 수 있을 때). */
  | 'request'
  /** 다시 물을 수 없게 거부됐다 — 설명을 보이고 설정 앱으로(Linking.openSettings). */
  | 'settings'
  /** 허용했는데 위치를 못 읽었다 — 다시 읽는다. */
  | 'retry'
  /** 허용했지만 경주 밖 · 대략적 위치 — 이유를 알린다(대략적이면 정확한 위치를 켜러 설정으로). */
  | 'outOfRegion'
  | 'coarse'
  /** 아직 확인 중 — 아무것도 하지 않는다. */
  | 'none';

/** '내 위치로' 버튼을 눌렀을 때 할 일. 동의가 없으면 어떤 경우에도 위치·권한에 손대지 않는다. */
export function myLocationAction(input: MyLocationInput): MyLocationAction {
  switch (input.status) {
    case 'no-consent':
      return 'consent';
    case 'needs-primer':
      return 'request';
    case 'denied':
      return input.canAskAgain ? 'request' : 'settings';
    case 'granted':
      if (input.known) return 'recenter';
      if (input.notice === 'outOfRegion') return 'outOfRegion';
      if (input.notice === 'coarse') return 'coarse';
      return 'retry';
    default:
      return 'none';
  }
}
