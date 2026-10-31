import assert from 'node:assert/strict';
import { captchaOption, runWithCaptcha } from './authCaptcha';
import { classifySignInError, classifySignUpError, isCaptchaRejection } from './authErrors';

// D3 H1: Supabase CAPTCHA 는 프로젝트 전체 설정이라 가입·로그인·재설정 메일도 토큰을 실어야 한다.
// 사이트 키가 없으면(공급자 없음) 호출 모양이 오늘과 같아야 하고, 토큰은 호출마다 새로 받는다(1회용).
async function run() {
  const seen: Array<string | undefined> = [];
  const call = async (token: string | undefined) => {
    seen.push(token);
    return token ?? 'none';
  };

  assert.equal(await runWithCaptcha(undefined, call), 'none');

  let issued = 0;
  const fresh = async () => `tok-${++issued}`;
  await runWithCaptcha(fresh, call);
  await runWithCaptcha(fresh, call);
  assert.deepEqual(seen, [undefined, 'tok-1', 'tok-2'], 'every auth call gets a fresh one-time token');

  // 확인 실패(null·예외)는 막지 않고 토큰 없이 부른다 — CAPTCHA 가 꺼진 동안은 그대로 통과한다.
  await runWithCaptcha(async () => null, call);
  await runWithCaptcha(async () => {
    throw new Error('script blocked');
  }, call);
  assert.deepEqual(seen.slice(3), [undefined, undefined]);

  assert.deepEqual(captchaOption(undefined), {});
  assert.deepEqual(captchaOption('t'), { captchaToken: 't' });

  // 켜진 뒤 서버 거절은 '사람 확인 실패' 로 가린다 — 비밀번호 오류·가입 일반 오류로 읽히지 않게.
  const rejected = { code: 'captcha_failed', message: 'captcha protection: request disallowed (no captcha response)', status: 400 };
  assert.equal(isCaptchaRejection(rejected), true);
  assert.equal(isCaptchaRejection({ message: 'Invalid login credentials', status: 400 }), false);
  assert.equal(isCaptchaRejection(null), false);
  assert.equal(classifySignInError(rejected), 'captcha');
  assert.equal(classifySignUpError(rejected), 'captcha');
  assert.equal(classifySignInError({ code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 }), 'invalid_credentials');

  console.log('auth captcha tests passed');
}

void run();
