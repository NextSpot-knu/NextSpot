// 로그인 뒤 어디로 보낼지 — 순수 모듈(테스트: postLoginDest.test.ts).
//
// 웹 원본: apps/web/lib/postLoginDest.ts · apps/web/lib/oauthFlow.ts 의 safeNext (기준 커밋 0d145a1)
// 바꾼 것:
//   · 공모전 심사용 사장님 계정 예외를 뺐다(대회가 끝났고 앱에는 사장님 콘솔이 없다).
//   · admin → 관제 대시보드 규칙도 뺐다. 앱은 모든 역할이 관광객 화면을 본다(계획 §7.4 — 콘솔은 '웹에서 열기').
//     그래서 역할 조회(GET /account/me)가 필요 없다.
//   · `next` 는 '/' 로 시작하는 아무 경로가 아니라 **앱에 있는 관광객 경로 목록**만 받는다. 앱 라우터는 모르는 경로를
//     +not-found 로 보내지만, 로그인·콜백·첫 실행 경로로 되돌아가는 고리나 외부 스킴을 아예 만들지 않게 막는다.

/** 이메일 로그인 기본 목적지 — 웹 '/main' 의 앱판(홈 탭). */
export const DEFAULT_LOGIN_DEST = '/';
/** 새 가입 기본 목적지 — 웹과 같다. */
export const SIGNUP_DEST = '/setup';
/** 소셜 로그인 콜백 기본 목적지 — 웹 콜백의 safeNext 기본값과 같다. */
export const CALLBACK_DEFAULT_DEST = '/mypage';

/** 로그인 뒤 보내도 되는 앱 경로(쿼리 없이 정확히 같아야 한다). */
export const ALLOWED_NEXT_PATHS: readonly string[] = ['/', '/saved', '/course', '/waiting', '/mypage', '/setup'];

/**
 * 오픈 리다이렉트·고리 방지. 문자열이 아니거나, 목록에 없거나, `//`·스킴·`..`·백슬래시가 섞이면 fallback.
 * 끝 슬래시 하나는 허용한다('/mypage/' → '/mypage').
 */
export function safeAppNext(next: unknown, fallback: string = CALLBACK_DEFAULT_DEST): string {
  if (typeof next !== 'string') return fallback;
  const raw = next.trim();
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.includes('..') || raw.includes(':')) {
    return fallback;
  }
  const path = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
  return ALLOWED_NEXT_PATHS.includes(path) ? path : fallback;
}

/**
 * 판정 규칙. 명시 목적지가 (검증을 통과해) 있으면 그곳, 없으면 fallback.
 * @param explicitNext 화면 파라미터 `next`(검증 전 값). undefined·null·빈 문자열이면 '명시 안 함'.
 */
export function decidePostLoginDest(explicitNext: unknown, fallback: string): string {
  if (explicitNext === undefined || explicitNext === null || explicitNext === '') return fallback;
  return safeAppNext(explicitNext, fallback);
}
