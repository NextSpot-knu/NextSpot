// 첫 실행 단계 판정 — 순수 모듈(저장소 주입, 테스트: firstRun.test.ts).
//
// 순서: 소개(intro) → 위치정보 이용 동의(법적, consent) → 첫 설정 5문항(setup) → 탭.
//   · 소개: 웹 랜딩의 '첫 방문 소개 모달'(nextspot_intro_seen — 웹과 같은 키).
//   · 동의: features/auth/consentCore 의 기록(현재 약관 판). 거절도 '결정함' 이다 — 다시 막지 않는다.
//   · 설정: 기기 단위 표식(nextspot_app_setup_seen). 웹은 nextspot_setup_prefs 유무로 판정하지만 그 키는 계정이 바뀌면
//     지워지는(USER_SCOPED_KEYS) 사용자 데이터라, 로그인 한 번에 다음 실행마다 첫 설정이 다시 뜬다. 앱은 '이 기기에서
//     첫 설정 화면을 지나갔다' 를 따로 적는다. 건너뛰기도 지나간 것이다.
// 소개·설정 표식은 첫 실행 흐름 전용이라 USER_SCOPED_KEYS 에 넣지 않는다.
import { hasLocationConsentDecisionIn } from '../auth/consentCore';

export const INTRO_SEEN_KEY = 'nextspot_intro_seen';
export const SETUP_SEEN_KEY = 'nextspot_app_setup_seen';

export type FirstRunStep = 'intro' | 'consent' | 'setup';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function flag(store: Store | null, key: string): boolean | null {
  if (!store) return null;
  try {
    return store.getItem(key) === '1';
  } catch {
    return null;
  }
}

/**
 * 지금 보여야 할 첫 실행 단계. 다 지났으면 null.
 * 저장소를 아예 못 읽으면(null) 소개·설정은 건너뛰되(앱을 못 쓰게 가두지 않는다 — 웹 랜딩과 같은 태도),
 * 동의는 '결정 없음' 으로 본다 — 위치는 동의 기록이 있을 때만 쓴다(hasLocationConsent 가 false).
 */
export function computeFirstRunStep(
  store: Store | null,
  /** 이번 실행 동안 지난 단계(저장에 실패해도 같은 화면에 갇히지 않게 — firstRun.ts 가 메모리에 든다). */
  passedThisRun: ReadonlySet<FirstRunStep> = new Set(),
): FirstRunStep | null {
  const intro = flag(store, INTRO_SEEN_KEY);
  if (intro === false && !passedThisRun.has('intro')) return 'intro';
  if (store && !hasLocationConsentDecisionIn(store) && !passedThisRun.has('consent')) {
    // 저장소는 읽히는데 결정이 없다 → 묻는다. 결정을 저장하지 못하면 화면이 알리고 이번 실행은 '동의 없음' 으로
    // 넘어간다(hasLocationConsent 는 false 그대로 — 다음 실행에 다시 묻는다).
    return 'consent';
  }
  const setup = flag(store, SETUP_SEEN_KEY);
  if (setup === false && !passedThisRun.has('setup')) return 'setup';
  return null;
}

export function markFlag(store: Store | null, key: string): void {
  if (!store) return;
  try {
    store.setItem(key, '1');
  } catch {
    /* 저장 실패 — 다음 실행에 다시 보일 뿐이다 */
  }
}

/** 각 단계의 화면 경로. 소개와 동의는 같은 화면(app/intro.tsx)이 단계에 맞춰 그린다. */
export const FIRST_RUN_ROUTES: Record<FirstRunStep, '/intro' | '/setup'> = {
  intro: '/intro',
  consent: '/intro',
  setup: '/setup',
};

/** 첫 실행 중에도 열 수 있는 경로 — 로그인·재설정 메일·OAuth 복귀는 첫 실행을 끊지 않는다. */
export const FIRST_RUN_PASS_THROUGH: readonly string[] = ['/login', '/forgot-password', '/auth/callback'];

/**
 * 지금 경로에서 첫 실행 화면으로 보내야 하면 그 경로, 아니면 null.
 * 첫 실행이 끝났으면(step null) 아무 데도 보내지 않는다(소개·설정 화면을 다시 여는 것은 허용 — 가이드·설정 다시 하기).
 */
export function decideFirstRunRedirect(step: FirstRunStep | null, pathname: string | null | undefined): string | null {
  if (!step) return null;
  const path = (pathname ?? '/').split('?')[0] || '/';
  const target = FIRST_RUN_ROUTES[step];
  if (path === target) return null;
  if (FIRST_RUN_PASS_THROUGH.some((p) => path === p || path.startsWith(`${p}/`))) return null;
  return target;
}

/**
 * 탭(app/(tabs)/_layout)에 들어오기 전 판정 — 첫 실행 단계가 남았으면 탭 화면을 하나도 띄우지 않고 그 단계로 보낸다.
 * 소셜 로그인 왕복 중(oauthPending)에는 보내지 않는다 — 콜백 화면이 code 를 처리하기 전에 바꿔치기하지 않게.
 */
export function decideTabsFirstRunRedirect(
  step: FirstRunStep | null,
  oauthPending: boolean,
): '/intro' | '/setup' | null {
  if (!step || oauthPending) return null;
  return FIRST_RUN_ROUTES[step];
}

/**
 * 이용 기록(page_view)을 지금 경로로 남겨도 되는가 — 첫 실행 화면으로 보낼 참이면(redirectTo 가 있으면) 남기지 않는다.
 * 콜드 스타트의 첫 경로 '/'(웹 '/main')가 소개로 바뀌기 전에 기록되지 않게 한다.
 */
export function shouldTrackPageView(redirectTo: string | null): boolean {
  return redirectTo === null;
}
