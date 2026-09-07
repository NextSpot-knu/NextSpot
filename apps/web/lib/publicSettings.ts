// 운영자 공개 설정(점검 모드·공지·혼잡 경계) — 파싱과 표시 판정만 두는 순수 모듈.
//
// 출처: GET /api/v1/system/public-settings
//   { maintenanceMode: boolean, noticeText: string, congestionThreshold: number(0~100) }
//
// 이 파일에 React 가 없는 이유: 판정 한 칸이 틀리면 **조회 실패가 '점검 중' 으로 보인다.**
// 백엔드가 아직 없거나(동시 작업 중), 콜드 스타트로 타임아웃 나거나, 404 가 오는 창이
// 실제로 존재하는데 그때 전면 점검 화면을 띄우면 멀쩡한 서비스를 우리 손으로 내리는 것이다.
// 그래서 판정을 렌더에서 떼어내 lib/publicSettings.test.ts 로 직접 고정한다
// (lib/adminMetricState.ts 가 같은 이유로 분리돼 있다).
//
// 원칙: **모르는 것은 그리지 않는다.** 실패·미배포·형식 이상은 전부 '평소 화면' 으로 떨어진다.

import { DEFAULT_BUSY_THRESHOLD, normalizeBusyThreshold } from './congestionScale';

export interface PublicSettings {
  /** 전면 점검 안내를 띄울지. 응답이 명시적으로 true 일 때만 true. */
  maintenanceMode: boolean;
  /** 상단 배너 문구. 빈 문자열이면 배너를 그리지 않는다. */
  noticeText: string;
  /** '혼잡' 등급 경계(0..1). 설정을 못 받으면 DEFAULT_BUSY_THRESHOLD. */
  busyThreshold: number;
}

/** 조회 전·조회 실패·미배포일 때의 값. 화면에 아무것도 더 그리지 않는 상태다. */
export const FALLBACK_PUBLIC_SETTINGS: PublicSettings = {
  maintenanceMode: false,
  noticeText: '',
  busyThreshold: DEFAULT_BUSY_THRESHOLD,
};

/** 공지 배너 문구 최대 길이 — 운영자가 실수로 붙여 넣은 장문이 화면을 덮지 않게 자른다. */
const NOTICE_MAX_LENGTH = 300;

/** API 응답(카멜 변환 후) → PublicSettings. 어떤 형태가 와도 예외를 던지지 않는다.
 *
 * 필드별로 따로 판정한다 — 공지 하나가 이상하다고 혼잡 경계까지 버릴 이유가 없다. */
export function parsePublicSettings(raw: unknown): PublicSettings {
  if (typeof raw !== 'object' || raw === null) return FALLBACK_PUBLIC_SETTINGS;
  const body = raw as Record<string, unknown>;
  return {
    // `=== true` 로 좁힌다: 'false' 문자열·1·null 같은 값이 점검 모드를 켜지 못하게.
    maintenanceMode: body.maintenanceMode === true,
    noticeText: typeof body.noticeText === 'string'
      ? body.noticeText.trim().slice(0, NOTICE_MAX_LENGTH)
      : '',
    busyThreshold: normalizeBusyThreshold(body.congestionThreshold),
  };
}

// 점검 안내·공지 배너를 띄우지 않는 경로. 관리자·상인 콘솔은 **점검을 푸는 쪽**이라
// 점검 모드에 스스로 갇히면 안 된다(/dev 도 같은 이유). layout.tsx 의 테마 부트스트랩
// 스크립트가 admin|merchant 를 제외하는 것과 같은 갈래다.
const CONSOLE_PREFIXES = ['/admin', '/merchant', '/dev'];

/** 이 경로가 관광객 앱인가(= 점검 안내·공지를 띄우는 대상인가). */
export function isTouristPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return !CONSOLE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
