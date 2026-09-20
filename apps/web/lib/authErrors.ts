// 회원가입 실패 원인 분류 — 로그인 화면이 원인별 안내 문구를 고르는 단일 판정점.
//
// 배경: 가입은 익명 세션 승격(PUT /user)과 신규 signUp 두 경로를 타는데, 어느 쪽이든
// "이미 가입된 이메일"(email_exists / user_already_exists)과 "짧은 비밀번호"(weak_password,
// 서버 최소 6자)가 사용자 실수로 흔히 발생한다. 이를 일반 실패와 구분하지 않으면
// "다시 시도해 주세요" 안내가 영원히 실패하는 재시도를 유도한다.

export type SignUpFailReason = 'email_exists' | 'weak_password' | 'unknown';

interface AuthErrorLike {
  /** GoTrue error_code (supabase-js v2.43+ AuthError.code). 없을 수 있다. */
  code?: string | null;
  message?: string | null;
  /** HTTP 상태(AuthApiError.status). 네트워크 단절이면 0 이거나 없다. */
  status?: number | null;
}

const EMAIL_EXISTS_CODES = new Set(['email_exists', 'user_already_exists']);
const EMAIL_EXISTS_MESSAGE = /already (?:been )?registered/i;
const WEAK_PASSWORD_MESSAGE = /password should be at least/i;

/** 가입 에러를 안내 문구용 원인으로 분류한다. 에러가 없으면 null. */
export function classifySignUpError(error: AuthErrorLike | null | undefined): SignUpFailReason | null {
  if (!error) return null;
  if (error.code && EMAIL_EXISTS_CODES.has(error.code)) return 'email_exists';
  if (error.code === 'weak_password') return 'weak_password';
  const message = error.message ?? '';
  if (EMAIL_EXISTS_MESSAGE.test(message)) return 'email_exists';
  if (WEAK_PASSWORD_MESSAGE.test(message)) return 'weak_password';
  return 'unknown';
}

// ── 로그인 실패 원인 ────────────────────────────────────────────────────────
//
// 왜 필요한가: 로그인 화면은 실패를 전부 "이메일 또는 비밀번호가 올바르지 않아요" 로 안내했다.
// 비밀번호가 맞는데 GoTrue 가 500 을 내거나 와이파이가 끊긴 순간에도 같은 문구가 떠서,
// 사용자는 맞는 비밀번호를 계속 다시 치게 된다(시연 중이면 "로그인이 안 되는 앱" 으로 읽힌다).
// 자격증명 문제(400/401)와 서버·네트워크 장애를 여기서 한 번만 가른다.

export type SignInFailReason =
  /** 400/401 invalid_credentials — 이메일·비밀번호가 실제로 틀렸다. */
  | 'invalid_credentials'
  /** 가입은 됐지만 확인 메일 링크를 아직 안 눌렀다. */
  | 'email_not_confirmed'
  /** 5xx · 네트워크 단절 · 타임아웃 — 사용자 잘못이 아니다. */
  | 'server'
  | 'unknown';

const INVALID_CREDENTIALS_CODES = new Set(['invalid_credentials', 'invalid_grant']);
const INVALID_CREDENTIALS_MESSAGE = /invalid (?:login )?credentials|invalid_grant/i;
const EMAIL_NOT_CONFIRMED_MESSAGE = /email not confirmed/i;
// supabase-js 는 fetch 실패를 AuthRetryableFetchError 로 감싸고 status 0 을 붙인다.
// lib/supabase.ts 의 6초 타임아웃은 AbortError("aborted"/"signal is aborted")로 떨어진다.
const NETWORK_MESSAGE = /failed to fetch|networkerror|network request failed|fetch failed|abort|timeout|load failed/i;

/**
 * 로그인 에러를 안내 문구용 원인으로 분류한다. 에러가 없으면 null.
 *
 * 판정 순서가 중요하다: 자격증명 코드/메시지를 먼저 보고, 그 다음에 상태 코드로 장애를 가린다.
 * (GoTrue 가 400 과 함께 invalid_credentials 를 주므로 상태부터 보면 4xx 를 전부 '틀린 비밀번호'
 *  로 뭉개게 된다 — 레이트리밋 429 까지 그렇게 읽히면 안 된다.)
 */
export function classifySignInError(error: AuthErrorLike | null | undefined): SignInFailReason | null {
  if (!error) return null;
  const message = error.message ?? '';
  const code = error.code ?? '';

  if (INVALID_CREDENTIALS_CODES.has(code)) return 'invalid_credentials';
  if (code === 'email_not_confirmed' || EMAIL_NOT_CONFIRMED_MESSAGE.test(message)) return 'email_not_confirmed';
  if (INVALID_CREDENTIALS_MESSAGE.test(message)) return 'invalid_credentials';

  const status = error.status ?? 0;
  // 5xx 는 물론이고, 429(레이트리밋)와 status 를 못 붙인 fetch 실패도 '장애' 쪽이다 —
  // 어느 쪽이든 사용자가 비밀번호를 다시 치는 것으로는 해결되지 않는다.
  if (status >= 500 || status === 429) return 'server';
  if (!status && NETWORK_MESSAGE.test(message)) return 'server';
  if (!status && !message) return 'server';
  return 'unknown';
}

// ── 게스트 데이터 병합 재시도 판정 ──────────────────────────────────────────

/**
 * `POST /account/merge-guest` 실패를 **다시 시도할 가치가 있는지** 판정한다.
 *
 * 왜 필요한가: 병합 캡처(sessionStorage)는 실패하면 보존되고 다음 인증 이벤트마다 재시도된다.
 * 원래 의도는 '서버가 잠깐 흔들린 경우 데이터를 잃지 않는다' 였는데, 판정이 없어서
 * **영구 실패까지 영원히 재시도**한다. 백엔드가 만료·손상된 게스트 토큰을 422 로 바꾼 뒤
 * (2026-09-21 API 변경) 그 경로가 눈에 보이게 됐다: 한 시간 넘게 게스트로 둘러본 뒤 로그인하면
 * 토큰이 이미 만료라 422 가 확정인데, 인증 상태가 바뀔 때마다 같은 요청을 계속 보낸다.
 *
 * 규칙: 4xx 는 요청 자체가 틀렸다는 뜻이므로 캡처를 버린다(승계할 게 없거나 이미 늦었다).
 * 5xx·네트워크·타임아웃만 재시도한다.
 */
export function shouldRetryGuestMerge(error: unknown): boolean {
  const status =
    typeof error === 'object' && error !== null && typeof (error as { status?: unknown }).status === 'number'
      ? ((error as { status: number }).status)
      : undefined;
  if (status === undefined) return true; // 상태가 없다 = 응답을 못 받았다(네트워크·중단).
  if (status >= 500) return true;
  if (status === 408 || status === 429) return true; // 타임아웃·레이트리밋은 일시적이다.
  return false;
}

// ── 비밀번호 변경 실패 원인 ─────────────────────────────────────────────────

export type PasswordUpdateFailReason =
  /** 복구 세션이 없거나 만료됐다 — 재설정 메일을 다시 받아야 한다. */
  | 'expired_link'
  /** 서버가 요구하는 최소 길이/복잡도 미달. */
  | 'weak_password'
  | 'unknown';

const EXPIRED_LINK_CODES = new Set([
  'session_not_found',
  'session_expired',
  'refresh_token_not_found',
  'otp_expired',
  'bad_jwt',
]);
const EXPIRED_LINK_MESSAGE = /session (?:not found|expired)|auth session missing|jwt expired|token has expired|invalid (?:claim|token)/i;

/**
 * 새 비밀번호 저장 실패를 분류한다.
 *
 * 만료된 복구 링크는 '변경 실패' 가 아니라 '링크를 다시 받아야 함' 이다 — 같은 화면에서
 * 다시 눌러도 영원히 실패하므로, 화면이 재설정 메일 요청으로 유도할 수 있게 갈라 준다.
 */
export function classifyPasswordUpdateError(
  error: AuthErrorLike | null | undefined,
): PasswordUpdateFailReason | null {
  if (!error) return null;
  const message = error.message ?? '';
  const code = error.code ?? '';

  if (EXPIRED_LINK_CODES.has(code)) return 'expired_link';
  if (code === 'weak_password' || WEAK_PASSWORD_MESSAGE.test(message)) return 'weak_password';
  if (EXPIRED_LINK_MESSAGE.test(message)) return 'expired_link';
  // 복구 세션이 없으면 GoTrue 가 401/403 을 준다.
  if (error.status === 401 || error.status === 403) return 'expired_link';
  return 'unknown';
}
