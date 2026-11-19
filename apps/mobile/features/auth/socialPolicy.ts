// 소셜 로그인 노출 규칙 — 순수 모듈(테스트: socialPolicy.test.ts). 계획 §7.2 · §8.2(App Store 4.8).
//
// v1 결정(M3 권장안):
//   · 안드로이드: 구글만. 카카오는 비즈 앱 전환 전까지 막혀 있어 숨긴다.
//   · iOS: 소셜 로그인·계정 연결(linkIdentity)·'구글로 계속하기' 경로가 **하나도** 없어야 한다. 제3자 로그인을 주 계정
//     로그인으로 쓰면 Apple 로그인을 함께 줘야 하고(4.8), Apple 로그인을 넣으면 계정 삭제 때 토큰 철회가 필요하다(v1.1).
//   · 그 밖의 플랫폼(web 미리보기 등): 없음.
// 화면은 이 함수 결과만 보고 버튼을 그린다. OAuth 를 시작하는 유일한 함수(oauthSession.ts)도 같은 규칙으로 다시 막는다.

export type OAuthProvider = 'kakao' | 'google';
export type PlatformOS = 'ios' | 'android' | 'web' | 'windows' | 'macos' | (string & {});

/** 카카오 비즈 앱 전환(사람 작업) 전까지 false. */
export const KAKAO_LOGIN_ENABLED = false;

/**
 * 이 플랫폼에서 보일 소셜 로그인 버튼(순서대로 — 웹과 같이 카카오가 먼저).
 * kakaoEnabled 는 테스트용 — 화면은 기본값(KAKAO_LOGIN_ENABLED)만 쓴다. 마이 계정 카드도 이 함수를 따른다(결정 D5).
 */
export function socialProvidersFor(os: PlatformOS, kakaoEnabled: boolean = KAKAO_LOGIN_ENABLED): OAuthProvider[] {
  if (os !== 'android') return [];
  const providers: OAuthProvider[] = [];
  if (kakaoEnabled) providers.push('kakao');
  providers.push('google');
  return providers;
}

/** 이 플랫폼에서 이 공급자로 OAuth 를 시작해도 되는가. */
export function isSocialLoginAllowed(os: PlatformOS, provider: OAuthProvider): boolean {
  return socialProvidersFor(os).includes(provider);
}

/**
 * 게스트에 소셜 계정을 '연결'(linkIdentity)해도 되는가 — 마이페이지 계정 연결용. v1 은 어디서도 쓰지 않는다
 * (앱의 소셜은 계정 전환 로그인 하나뿐이고, 게스트 데이터는 합치기로 옮긴다). iOS 는 v1.1 전까지 절대 false.
 */
export function isIdentityLinkingAllowed(_os: PlatformOS): boolean {
  return false;
}
