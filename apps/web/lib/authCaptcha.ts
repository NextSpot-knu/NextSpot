// Supabase 인증 호출에 사람 확인 토큰(Cloudflare Turnstile)을 붙이는 공용 배관.
//
// 왜: Supabase Auth 의 CAPTCHA(Attack Protection)는 **프로젝트 전체** 설정이다. 켜는 순간 익명 로그인뿐 아니라
//   이메일 가입(signUp) · 비밀번호 로그인(signInWithPassword) · 재설정 메일(resetPasswordForEmail)도 captchaToken 이
//   없으면 거절된다. 그래서 이 저장소에서 그 세 호출과 익명 로그인(lib/anonymousSession)이 모두 토큰을 싣는다.
//   토큰이 필요 없는 호출: updateUser(게스트→회원 전환·비밀번호 변경, PUT /user), signInWithOAuth·linkIdentity
//   (리다이렉트), PKCE code 교환(/auth/callback), getSession·signOut.
// 사이트 키가 없으면: 토큰을 받지 않고 호출 모양도 오늘과 같다(options 를 붙이지 않는다).
// 토큰을 못 받으면: 토큰 없이 한 번 부른다 — 대시보드 CAPTCHA 가 아직 꺼져 있으면 그대로 통과한다. 켜져 있어 서버가
//   거절하면 lib/authErrors 의 분류(reason 'captcha')가 그 실패를 가려 화면이 '사람 확인을 마치지 못했어요' 를 띄운다(조용한 실패 없음).

import { getTurnstileToken, TURNSTILE_SITE_KEY } from './turnstile';

export type CaptchaTokenGetter = () => Promise<string | null>;

/** 사이트 키가 있을 때만 토큰 공급자를 둔다. 없으면 undefined — 호출은 오늘과 똑같다. */
export const authCaptchaTokenGetter: CaptchaTokenGetter | undefined = TURNSTILE_SITE_KEY
  ? () => getTurnstileToken(TURNSTILE_SITE_KEY)
  : undefined;

/**
 * 새 토큰을 받아(1회용이라 호출마다) call 에 넘긴다. 공급자가 없거나 토큰을 못 받으면 undefined 를 넘긴다.
 * 토큰 실패를 여기서 오류로 만들지 않는다 — 대시보드 CAPTCHA 가 꺼진 동안은 토큰 없이도 통과해야 하고,
 * 켜진 뒤의 거절은 서버 응답으로 가린다(lib/authErrors isCaptchaRejection → reason 'captcha').
 */
export async function runWithCaptcha<T>(
  getter: CaptchaTokenGetter | undefined,
  call: (captchaToken: string | undefined) => Promise<T>,
): Promise<T> {
  let token: string | null = null;
  if (getter) {
    try {
      token = await getter();
    } catch (error) {
      console.warn('[auth] 사람 확인(Turnstile) 토큰을 받지 못했습니다 — 토큰 없이 시도합니다.', error);
    }
  }
  return call(token ?? undefined);
}

/** options 에 섞을 조각 — 토큰이 없으면 빈 객체(호출 모양을 바꾸지 않는다). */
export function captchaOption(captchaToken: string | undefined): { captchaToken?: string } {
  return captchaToken ? { captchaToken } : {};
}
