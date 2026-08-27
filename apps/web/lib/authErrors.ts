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
