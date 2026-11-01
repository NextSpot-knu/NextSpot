// 첫 실행 상태 — 앱 저장소(localStorage, expo-sqlite — 동기)에 묶은 쪽. 규칙은 firstRunCore.ts.
import {
  computeFirstRunStep,
  FIRST_RUN_ROUTES,
  INTRO_SEEN_KEY,
  markFlag,
  SETUP_SEEN_KEY,
  type FirstRunStep,
} from './firstRunCore';
import { readPendingFlow } from '../auth/pendingFlow';

export {
  decideFirstRunRedirect,
  decideTabsFirstRunRedirect,
  FIRST_RUN_ROUTES,
  shouldTrackPageView,
  type FirstRunStep,
} from './firstRunCore';

function store(): Storage | null {
  return (globalThis as { localStorage?: Storage }).localStorage ?? null;
}

type Listener = (step: FirstRunStep | null) => void;
const listeners = new Set<Listener>();

/** 이번 실행에서 지난 단계 — 저장에 실패해도 같은 화면에 갇히지 않게(다음 실행에는 다시 보인다). */
const passedThisRun = new Set<FirstRunStep>();

export function getFirstRunStep(): FirstRunStep | null {
  return computeFirstRunStep(store(), passedThisRun);
}

/** 이 단계를 이번 실행 동안 지난 것으로 둔다. 동의 화면은 결정 저장에 실패했을 때 'consent' 로 부른다. */
export function passFirstRunStep(step: FirstRunStep): void {
  passedThisRun.add(step);
  notifyFirstRunChanged();
}

/** 단계가 바뀌었음을 알린다(게이트가 다시 판정한다). 동의 화면처럼 다른 모듈이 기록을 바꾼 뒤에도 부른다. */
export function notifyFirstRunChanged(): void {
  const step = getFirstRunStep();
  for (const l of [...listeners]) l(step);
}

/** 소셜 로그인 왕복 중인가(진행 중 흐름 기록이 있다) — 그동안은 첫 실행 화면으로 보내지 않는다. */
export function isOAuthFlowPending(): boolean {
  return readPendingFlow(store(), Date.now()) !== null;
}

export function subscribeFirstRun(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function markIntroSeen(): void {
  markFlag(store(), INTRO_SEEN_KEY);
  passFirstRunStep('intro');
}

export function markSetupSeen(): void {
  markFlag(store(), SETUP_SEEN_KEY);
  passFirstRunStep('setup');
}

/** 첫 실행이 남았으면 그 화면 경로, 다 끝났으면 홈('/'). 각 단계 화면이 '다음' 을 누른 뒤 부른다. */
export function nextFirstRunRoute(): '/intro' | '/setup' | '/' {
  const step = getFirstRunStep();
  return step ? FIRST_RUN_ROUTES[step] : '/';
}

// 단계 화면이 직접 다음 화면으로 replace 한 직후에는 게이트가 같은 곳으로 또 replace 하지 않게 한다
// (경로 갱신보다 게이트 effect 가 먼저 돌면 같은 화면이 두 번 붙는다).
let lastNavigation: { target: string; at: number } | null = null;
const NAVIGATION_DEDUPE_MS = 1500;

/** 단계 화면이 router.replace(target) 직전에 부른다. */
export function noteFirstRunNavigation(target: string): void {
  lastNavigation = { target, at: Date.now() };
}

/** 방금 같은 곳으로 보냈는가(게이트용). */
export function navigatedRecentlyTo(target: string): boolean {
  return !!lastNavigation && lastNavigation.target === target && Date.now() - lastNavigation.at < NAVIGATION_DEDUPE_MS;
}
