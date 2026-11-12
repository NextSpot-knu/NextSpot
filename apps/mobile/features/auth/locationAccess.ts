// 위치를 읽어도 되는가 — 법적 동의(consent.ts)와 OS 권한을 한 번에 판정하는 순수 함수(테스트: locationAccess.test.ts).
// 계획 §6.2 · M20(위치정보법). 홈·대안 추천·코스가 모두 이 판정을 거친다.
//
// 순서가 중요하다: **동의가 없으면 OS 권한을 들여다보지도 않는다**. 동의가 없으면 결과는 'no-consent' 이고 화면은
// '권한 거부'와 똑같이 움직인다(황리단길 중심 · 시스템 창 없음 · 사전 안내 없음). 동의는 마이 설정의 위치정보 동의 줄이
// 동의 화면(LOCATION_CONSENT_ROUTE)을 열어 바꾼다.

export type LocationAccess =
  /** 위치정보 이용 동의가 없다 — 위치를 읽지도 묻지도 않는다. */
  | 'no-consent'
  /** 동의 + OS 권한 허용 — 한 번 읽는다. */
  | 'granted'
  /** 동의는 있고 OS 권한을 아직 묻지 않았다 — 홈만 사전 안내(버튼 하나)를 보인다. 다른 화면은 묻지 않는다. */
  | 'needs-primer'
  /** 동의는 있지만 OS 권한이 거부됐다(또는 권한을 읽지 못했다). */
  | 'denied';

export interface PermissionLike {
  granted: boolean;
  /** expo-location PermissionStatus 값: 'granted' | 'denied' | 'undetermined'. */
  status: string;
  canAskAgain: boolean;
}

/**
 * @param consent hasLocationConsent() 의 값.
 * @param permission OS 권한. 동의가 없으면 읽지 않으므로 null 을 넘겨도 된다. 동의가 있는데 null(읽기 실패)이면 'denied'.
 */
export function decideLocationAccess(consent: boolean, permission: PermissionLike | null): LocationAccess {
  if (!consent) return 'no-consent';
  if (!permission) return 'denied';
  if (permission.granted) return 'granted';
  if (permission.status === 'undetermined' && permission.canAskAgain) return 'needs-primer';
  return 'denied';
}

/** 좌표를 읽어도 되는가 — 'granted' 일 때만. */
export function mayReadPosition(access: LocationAccess): boolean {
  return access === 'granted';
}

/** 동의 화면 경로 — 첫 실행이 끝난 뒤에도 동의 단계만 바로 연다(app/intro.tsx 의 step 파라미터). */
export const LOCATION_CONSENT_ROUTE = '/intro?step=consent';
