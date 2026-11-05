import assert from 'node:assert/strict';

import { AUTH_CALLBACK_URL, isAuthCallbackUrl, parseAuthCallback, parseParams } from './redirect';

// 콜백 주소 판별 — 스킴 URL · 경로 · Expo Go 형식 모두
assert.equal(AUTH_CALLBACK_URL, 'nextspot://auth/callback');
assert.equal(isAuthCallbackUrl('nextspot://auth/callback?code=abc'), true);
assert.equal(isAuthCallbackUrl('nextspot://auth/callback/'), true);
assert.equal(isAuthCallbackUrl('NextSpot://auth/callback#error=x'), true);
assert.equal(isAuthCallbackUrl('/auth/callback?code=abc'), true);
assert.equal(isAuthCallbackUrl('auth/callback'), true);
assert.equal(isAuthCallbackUrl('nextspot:///--/auth/callback?code=1'), true);
assert.equal(isAuthCallbackUrl('exp+nextspot://--/auth/callback'), false, '다른 스킴은 받지 않는다');
assert.equal(isAuthCallbackUrl('https://evil.example/auth/callback?code=1'), false, 'https 주소는 콜백이 아니다');
assert.equal(isAuthCallbackUrl('otherapp://auth/callback?code=1'), false, '다른 앱 스킴은 콜백이 아니다');
assert.equal(isAuthCallbackUrl('nextspot://auth/callbackx'), false);
assert.equal(isAuthCallbackUrl('nextspot://auth/callback/extra'), false);
assert.equal(isAuthCallbackUrl('nextspot://mypage'), false);
assert.equal(isAuthCallbackUrl('/'), false);
assert.equal(isAuthCallbackUrl(''), false);
assert.equal(isAuthCallbackUrl(null), false);
assert.equal(isAuthCallbackUrl(undefined), false);

// code 읽기
assert.deepEqual(parseAuthCallback('nextspot://auth/callback?code=abc-123'), {
  code: 'abc-123',
  error: null,
  errorCode: null,
  errorDescription: null,
});
// 오류는 쿼리 또는 # 조각, + 는 공백
assert.deepEqual(
  parseAuthCallback(
    'nextspot://auth/callback#error=access_denied&error_code=identity_already_exists&error_description=Identity+is+already+linked',
  ),
  { code: null, error: 'access_denied', errorCode: 'identity_already_exists', errorDescription: 'Identity is already linked' },
);
// 쿼리가 # 보다 우선
assert.equal(parseAuthCallback('nextspot://auth/callback?code=q#code=h').code, 'q');
// 같은 키가 둘이면 처음 것(뒤에서 바꿔치기 못 하게)
assert.equal(parseAuthCallback('nextspot://auth/callback?code=first&code=second').code, 'first');
// 빈 값·공백 값은 null
assert.equal(parseAuthCallback('nextspot://auth/callback?code=').code, null);
assert.equal(parseAuthCallback('nextspot://auth/callback?code=%20').code, null);
// 깨진 % 인코딩에도 던지지 않는다
assert.equal(parseAuthCallback('nextspot://auth/callback?code=%E0%A4%A').code, '%E0%A4%A');
assert.equal(parseParams('a=1&&b=&=x').get('a'), '1');
assert.equal(parseParams('a=1&&b=&=x').get('b'), '');

console.log('redirect.test OK');
