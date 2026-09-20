import assert from 'node:assert/strict';
import { classifyPasswordUpdateError, classifySignInError, classifySignUpError, shouldRetryGuestMerge } from './authErrors';
import { AuthError, HttpError, ServiceUnavailableError } from './api-client';

// 에러가 없으면 null — 호출부가 토스트를 띄우지 않는 경로.
assert.equal(classifySignUpError(null), null);
assert.equal(classifySignUpError(undefined), null);

// GoTrue error_code 기반 분류(운영 실측: 익명 승격 PUT /user → email_exists,
// 신규 signUp → user_already_exists / weak_password).
assert.equal(
  classifySignUpError({ code: 'email_exists', message: 'A user with this email address has already been registered' }),
  'email_exists',
);
assert.equal(
  classifySignUpError({ code: 'user_already_exists', message: 'User already registered' }),
  'email_exists',
);
assert.equal(
  classifySignUpError({ code: 'weak_password', message: 'Password should be at least 6 characters.' }),
  'weak_password',
);

// code 가 없는 응답(프록시·구버전·catch 로 문자열화된 에러)은 메시지로 폴백 분류.
assert.equal(
  classifySignUpError({ message: 'A user with this email address has already been registered' }),
  'email_exists',
);
assert.equal(classifySignUpError({ message: 'User already registered' }), 'email_exists');
assert.equal(classifySignUpError({ message: 'Password should be at least 6 characters.' }), 'weak_password');

// 그 외(레이트리밋·네트워크 등)는 unknown → 기존 일반 안내 유지.
assert.equal(
  classifySignUpError({ code: 'over_request_rate_limit', message: 'Request rate limit reached' }),
  'unknown',
);
assert.equal(classifySignUpError({ message: 'fetch failed' }), 'unknown');
assert.equal(classifySignUpError({}), 'unknown');

// ── classifySignInError ────────────────────────────────────────────────────
// 이 분류가 하는 일은 하나다: '비밀번호를 다시 치면 되는 실패' 와 '아무리 다시 쳐도 안 되는
// 실패' 를 가른다. 둘을 뭉개면 서버 장애 중에 사용자가 맞는 비밀번호를 의심하게 된다.

assert.equal(classifySignInError(null), null);
assert.equal(classifySignInError(undefined), null);

// 자격증명 오류 — GoTrue 는 400 + invalid_credentials 로 온다(400 이라고 전부 4xx 취급하면 안 된다).
assert.equal(
  classifySignInError({ code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 }),
  'invalid_credentials',
);
// code 가 없는 구버전/프록시 응답은 메시지로 폴백.
assert.equal(classifySignInError({ message: 'Invalid login credentials', status: 400 }), 'invalid_credentials');
assert.equal(classifySignInError({ code: 'invalid_grant', message: 'invalid_grant' }), 'invalid_credentials');

// 확인 메일을 아직 안 누른 계정 — 비밀번호는 맞다.
assert.equal(
  classifySignInError({ code: 'email_not_confirmed', message: 'Email not confirmed', status: 400 }),
  'email_not_confirmed',
);
assert.equal(classifySignInError({ message: 'Email not confirmed' }), 'email_not_confirmed');

// ── 사용자 잘못이 아닌 실패는 전부 server ───────────────────────────────────
assert.equal(classifySignInError({ message: 'Internal Server Error', status: 500 }), 'server');
assert.equal(classifySignInError({ message: 'unexpected_failure', status: 503 }), 'server');
// 레이트리밋도 '다시 쳐서' 풀리지 않는다.
assert.equal(
  classifySignInError({ code: 'over_request_rate_limit', message: 'Request rate limit reached', status: 429 }),
  'server',
);
// 네트워크 단절(AuthRetryableFetchError 는 status 0).
assert.equal(classifySignInError({ message: 'Failed to fetch', status: 0 }), 'server');
assert.equal(classifySignInError({ message: 'NetworkError when attempting to fetch resource.' }), 'server');
// lib/supabase.ts 의 6초 타임아웃은 AbortError 로 떨어진다 — 이것도 장애다.
assert.equal(classifySignInError({ message: 'The operation was aborted.' }), 'server');
assert.equal(classifySignInError({ message: 'signal is aborted without reason' }), 'server');
assert.equal(classifySignInError({}), 'server', '정보가 아무것도 없으면 비밀번호 탓으로 몰지 않는다');

// 분류 못 한 4xx 는 기존 동작(자격증명 안내) 유지.
assert.equal(classifySignInError({ code: 'signup_disabled', message: 'Signups not allowed', status: 422 }), 'unknown');

// 회귀 방지: 500 이 자격증명 오류로 읽히면 안 된다(이 작업의 출발점).
assert.notEqual(classifySignInError({ message: 'Internal Server Error', status: 500 }), 'invalid_credentials');

// ── shouldRetryGuestMerge ──────────────────────────────────────────────────
// 캡처를 보존한다 = 다음 인증 이벤트마다 같은 요청을 다시 보낸다. 확정된 실패를 보존하면
// 그 반복이 영원히 끝나지 않는다(2026-09-21 백엔드가 만료 토큰을 422 로 바꾼 뒤 드러난 경로).

// api-client 가 실제로 던지는 타입으로 검증한다 — 던지는 쪽과 읽는 쪽이 갈라지면 의미가 없다.
assert.equal(shouldRetryGuestMerge(new HttpError('guest token expired', 422)), false, '422 는 다시 보내도 확정 실패다');
assert.equal(shouldRetryGuestMerge(new AuthError()), false, '401 도 재시도로는 안 풀린다');
assert.equal(shouldRetryGuestMerge(new HttpError('bad request', 400)), false);
assert.equal(shouldRetryGuestMerge(new HttpError('not found', 404)), false);

assert.equal(shouldRetryGuestMerge(new ServiceUnavailableError()), true, '503 은 잠깐 흔들린 것이다');
assert.equal(shouldRetryGuestMerge(new HttpError('internal', 500)), true);
assert.equal(shouldRetryGuestMerge(new HttpError('timeout', 408)), true);
assert.equal(shouldRetryGuestMerge(new HttpError('rate limited', 429)), true);

// 응답 자체를 못 받은 경우(네트워크 단절·AbortError)는 상태가 없다 → 데이터를 지키기 위해 재시도.
assert.equal(shouldRetryGuestMerge(new Error('Failed to fetch')), true);
assert.equal(shouldRetryGuestMerge(undefined), true);
assert.equal(shouldRetryGuestMerge({ status: 'nope' }), true, '숫자가 아닌 status 는 없는 것으로 본다');

// ── classifyPasswordUpdateError ────────────────────────────────────────────
assert.equal(classifyPasswordUpdateError(null), null);

// 만료/부재한 복구 세션 — 같은 화면에서 다시 눌러도 영원히 실패하므로 갈라내야 한다.
assert.equal(
  classifyPasswordUpdateError({ code: 'session_not_found', message: 'Session from session_id claim in JWT does not exist' }),
  'expired_link',
);
assert.equal(classifyPasswordUpdateError({ message: 'Auth session missing!' }), 'expired_link');
assert.equal(classifyPasswordUpdateError({ message: 'JWT expired', status: 401 }), 'expired_link');
assert.equal(classifyPasswordUpdateError({ message: 'whatever', status: 403 }), 'expired_link');
assert.equal(classifyPasswordUpdateError({ code: 'otp_expired', message: 'Email link is invalid or has expired' }), 'expired_link');

assert.equal(
  classifyPasswordUpdateError({ code: 'weak_password', message: 'Password should be at least 6 characters.' }),
  'weak_password',
);
assert.equal(classifyPasswordUpdateError({ message: 'Password should be at least 6 characters.' }), 'weak_password');

assert.equal(classifyPasswordUpdateError({ message: 'Internal Server Error', status: 500 }), 'unknown');

console.log('authErrors tests passed');
