// Cloudflare Turnstile — Supabase 인증 호출 전에 사람인지 확인하는 1회용 토큰을 받는다(PRODUCT_EVALUATION_PLAN §6 D3 (나)).
//
// 왜: 게스트 세션은 클릭 한 번이면 새로 생긴다. Supabase 는 익명 로그인에 CAPTCHA 를 강하게 권한다. 그런데 Supabase 의
//   CAPTCHA(Attack Protection)는 **프로젝트 전체** 설정이라 켜는 순간 익명 로그인 · 이메일 가입 · 비밀번호 로그인 ·
//   재설정 메일이 모두 captchaToken 을 요구한다. 그래서 이 네 호출이 전부 토큰을 싣는다:
//   익명 로그인은 lib/anonymousSession, 나머지 셋은 lib/auth 가 lib/authCaptcha 를 거쳐서.
//
// 켜는 법(순서 — 이 순서면 CAPTCHA 를 켠 순간에도 어떤 로그인도 깨지지 않는다):
//   ① NEXT_PUBLIC_TURNSTILE_SITE_KEY 를 넣고 웹 배포(네 호출이 모두 토큰을 싣기 시작한다 — CAPTCHA 가 꺼져 있어도 무해)
//   ② Supabase Auth → Attack Protection 에서 CAPTCHA(Turnstile, 비밀 키) 켜기
//   ③ 익명 로그인 IP 한도 낮추기.
//   사이트 키는 원래 공개값이다. **비밀 키는 Supabase 대시보드에만** 넣는다.
// 키가 없으면: 이 파일은 아무것도 하지 않는다 — 스크립트를 싣지 않고, 인증 호출 모양도 오늘과 똑같다.
// 실패하면: null 을 돌려준다. 호출부는 토큰 없이 한 번 시도한다 — CAPTCHA 가 아직 꺼져 있으면 그대로 통과하고,
//   켜져 있으면 서버가 거절한다. 그때 익명 로그인은 기존 재시도 창(5초→15초→…5분)마다 새 확인을 다시 받고(공개 화면은
//   그대로), 로그인·가입·재설정 화면은 '사람 확인을 마치지 못했어요'(login.captchaFailed)를 띄운다 — 조용히 실패하지 않는다.
// 화면: 위젯은 Cloudflare 대시보드에서 'Invisible' 로 만든다(권장 — 아무것도 보이지 않는다). 'Managed' 로 만들었다면
//   사람 확인이 필요할 때만(interaction-only) 화면 아래쪽에 상자가 잠깐 뜬다.

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string | undefined;
      remove: (widgetId: string) => void;
    };
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_TIMEOUT_MS = 8_000;
const TOKEN_TIMEOUT_MS = 20_000;

/** 공개 사이트 키(빌드 때 박힌다). 비어 있으면 Turnstile 을 쓰지 않는다. */
export const TURNSTILE_SITE_KEY = (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '').trim();

let scriptPromise: Promise<boolean> | null = null;

function loadScript(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.turnstile) return Promise.resolve(true);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<boolean>((resolve) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    const timer = setTimeout(() => resolve(!!window.turnstile), SCRIPT_TIMEOUT_MS);
    script.onload = () => {
      clearTimeout(timer);
      resolve(!!window.turnstile);
    };
    script.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    document.head.appendChild(script);
  }).then((ok) => {
    // 실패한 적재는 기억하지 않는다 — 다음 시도(재시도 창)에서 다시 싣는다.
    if (!ok) scriptPromise = null;
    return ok;
  });
  return scriptPromise;
}

/**
 * 한 번 쓰는 Turnstile 토큰을 받는다. 사이트 키가 없거나, 스크립트·확인이 실패하거나, 시간이 넘으면 null.
 * 토큰은 1회용이라 익명 로그인 시도마다 새로 받는다.
 */
export async function getTurnstileToken(siteKey: string = TURNSTILE_SITE_KEY): Promise<string | null> {
  if (!siteKey || typeof window === 'undefined' || typeof document === 'undefined') return null;
  if (!(await loadScript()) || !window.turnstile) return null;
  const api = window.turnstile;

  return new Promise<string | null>((resolve) => {
    const container = document.createElement('div');
    container.setAttribute('data-turnstile', 'anonymous-session');
    container.style.cssText =
      'position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:80;';
    document.body.appendChild(container);

    let widgetId: string | undefined;
    let settled = false;
    const finish = (token: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (widgetId) api.remove(widgetId);
      } catch {
        /* 이미 지워진 위젯 */
      }
      container.remove();
      resolve(token);
    };
    const timer = setTimeout(() => finish(null), TOKEN_TIMEOUT_MS);

    try {
      widgetId = api.render(container, {
        sitekey: siteKey,
        appearance: 'interaction-only',
        retry: 'never',
        callback: (token: string) => finish(token || null),
        'error-callback': () => finish(null),
        'timeout-callback': () => finish(null),
        'expired-callback': () => finish(null),
      });
    } catch {
      finish(null);
    }
  });
}
