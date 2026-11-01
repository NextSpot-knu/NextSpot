// 마이페이지 계정 영역의 순수 규칙 — 소셜 연결 범위(계획 §7.2 M3) · 프로필 표시 이름 · 삭제 흐름의 순서.
// 웹 원본: apps/web/app/mypage/page.tsx(프로필 파생) · components/AccountSection.tsx(프로바이더 목록) · app/mypage/settings/page.tsx(삭제 순서). 기준 커밋 0d145a1.

export type OAuthProvider = 'kakao' | 'google';

/**
 * 이 기기에서 보일 소셜 로그인 버튼. 웹은 [kakao, google].
 *  · iOS — 없음(App Store 4.8: 제3자 로그인을 쓰면 Apple 로그인도 필요 — v1.1 에 함께. 버튼·연결 경로를 하나도 두지 않는다).
 *  · 안드로이드 — 구글만(카카오는 비즈 앱 전환 전까지 숨김).
 *  · 그 밖(웹 미리보기 등) — 없음.
 */
export function visibleProviders(os: string): OAuthProvider[] {
  return os === 'android' ? ['google'] : [];
}

/** 표시 이름 우선순위: 서버 닉네임 > (기기 한정) 직접 정한 이름 > 이메일 앞부분 > null(게스트 — 문구는 렌더 때). */
export function pickDisplayName(input: {
  remoteNickname?: string | null;
  email?: string | null;
  storedName?: string | null;
}): string | null {
  const remote = input.remoteNickname?.trim();
  if (remote) return remote;
  const stored = input.storedName?.trim();
  if (stored) return stored;
  const email = input.email?.trim();
  if (email) return email.split('@')[0] || null;
  return null;
}

/** 저장 목록 JSON → 개수. 깨졌으면 0. */
export function countJsonArray(raw: string | null | undefined): number {
  if (!raw) return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** 줄인 대기 시간(분)의 최저시급 환산 금액(원) — 10원 단위 반올림. 웹 MIN_WAGE_KRW_PER_HOUR 와 같은 값. */
export const MIN_WAGE_KRW_PER_HOUR = 10320;
export function wageValueKrw(minutes: number): number {
  return Math.round((minutes * MIN_WAGE_KRW_PER_HOUR) / 60 / 10) * 10;
}

/**
 * 계정(가입 계정이든 게스트든) 삭제 흐름의 단계 — 서버 삭제가 성공한 뒤에만 로컬을 지운다.
 * 서버가 실패하면 아무것도 지우지 않고 오류를 알린다(웹 settings 와 같은 순서). 의존은 주입(테스트용).
 */
export async function runAccountDeletion(deps: {
  deleteOnServer: () => Promise<void>;
  signOutLocal: () => Promise<void>;
  clearLocalData: () => void;
  startGuestSession: () => Promise<void>;
}): Promise<'ok' | 'failed'> {
  try {
    await deps.deleteOnServer();
  } catch {
    return 'failed';
  }
  // 서버 쪽은 이미 지워졌다 — 이후 단계의 실패는 삭제 실패가 아니다(남은 로컬 정리는 최대한 한다).
  try { await deps.signOutLocal(); } catch { /* 세션이 이미 없을 수 있다 */ }
  try { deps.clearLocalData(); } catch { /* 저장소 차단 */ }
  try { await deps.startGuestSession(); } catch { /* 앱이 앞으로 올 때 SessionBootstrap 이 다시 만든다 */ }
  return 'ok';
}
