import assert from 'node:assert/strict';

import { CALLBACK_DEFAULT_DEST, DEFAULT_LOGIN_DEST, SIGNUP_DEST, decidePostLoginDest, safeAppNext } from './postLoginDest';

assert.equal(DEFAULT_LOGIN_DEST, '/');
assert.equal(SIGNUP_DEST, '/setup');
assert.equal(CALLBACK_DEFAULT_DEST, '/mypage');

// 허용 목록의 앱 경로만
for (const ok of ['/', '/saved', '/course', '/waiting', '/mypage', '/setup']) assert.equal(safeAppNext(ok), ok);
assert.equal(safeAppNext('/mypage/'), '/mypage');
// 오픈 리다이렉트·스킴·고리·모르는 경로는 기본값
for (const bad of [
  '//evil.com',
  'https://evil.com',
  'javascript:alert(1)',
  'nextspot://auth/callback',
  '/auth/callback',
  '/login',
  '/intro',
  '/admin/dashboard',
  '/merchant',
  '/mypage/../login',
  '/\\evil.com',
  'mypage',
  '',
  '   ',
]) {
  assert.equal(safeAppNext(bad), CALLBACK_DEFAULT_DEST, bad);
}
assert.equal(safeAppNext(undefined), CALLBACK_DEFAULT_DEST);
assert.equal(safeAppNext(['/mypage']), CALLBACK_DEFAULT_DEST, '배열 파라미터는 받지 않는다');
assert.equal(safeAppNext('/evil', '/'), '/');

// 판정: 명시 목적지 > 기본값. 역할·심사 계정 예외 없음.
assert.equal(decidePostLoginDest(null, DEFAULT_LOGIN_DEST), '/');
assert.equal(decidePostLoginDest(undefined, SIGNUP_DEST), '/setup');
assert.equal(decidePostLoginDest('', DEFAULT_LOGIN_DEST), '/');
assert.equal(decidePostLoginDest('/saved', DEFAULT_LOGIN_DEST), '/saved');
assert.equal(decidePostLoginDest('/admin/dashboard', DEFAULT_LOGIN_DEST), '/', '검증 실패면 그 화면의 기본값');
assert.equal(decidePostLoginDest('//evil', SIGNUP_DEST), '/setup');

console.log('postLoginDest.test OK');
