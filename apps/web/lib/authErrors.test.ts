import assert from 'node:assert/strict';
import { classifySignUpError } from './authErrors';

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

console.log('authErrors tests passed');
