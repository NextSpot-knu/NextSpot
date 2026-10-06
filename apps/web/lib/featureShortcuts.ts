// 랜딩(데스크톱 첫 화면)과 서비스 소개의 '이렇게 써 보세요' 다섯 줄 — 어디로 보내는가.
//
// 왜 한 곳에 두나: 심사위원은 기능설명서 §5 의 핵심 기능 1~5 를 옆에 두고 차례로 눌러 본다. 줄 순서·목적지가
// 화면마다 갈라지면 문서와 앱이 다른 말을 한다. 순서는 문서와 같고(1 혼잡 예측 지도 … 5 사장님·관제),
// 1~4번은 /main 의 ?focus 계약(지도 화면이 마운트 때 한 번 읽는다 — 예측 띠·실시간 정보·음성 비서에 불을 켠다),
// 5번은 링크 하나가 아니라 두 콘솔 버튼이다(목적지는 lib/consoleLinks.ts 의 역할 규칙 그대로).

import type { Account } from './accountRoles';
import { consoleLinks, type ConsoleLinks } from './consoleLinks';

export const FEATURE_SHORTCUT_KEYS = ['forecast', 'card', 'live', 'voice', 'console'] as const;
export type FeatureShortcutKey = (typeof FEATURE_SHORTCUT_KEYS)[number];

/** /main 이 마운트 때 읽는 ?focus 값 — forecast(히트맵 + 예측 띠), live(관광지 카드의 실시간 정보), voice(음성 비서). */
export const MAIN_FOCUS_PATHS = {
  forecast: '/main?focus=forecast',
  card: '/main',
  live: '/main?focus=live',
  voice: '/main?focus=voice',
} as const;

export interface FeatureShortcut {
  key: FeatureShortcutKey;
  /** 1~4번: 줄 전체가 이 링크다. */
  href?: string;
  /** 5번: 사장님 콘솔 · 관제 대시보드 두 버튼의 목적지. */
  consoles?: ConsoleLinks;
}

export function featureShortcuts(account: Account | null): FeatureShortcut[] {
  return FEATURE_SHORTCUT_KEYS.map((key) =>
    key === 'console' ? { key, consoles: consoleLinks(account) } : { key, href: MAIN_FOCUS_PATHS[key] },
  );
}

// ── 이미 /main 에 있을 때(지도 화면 레일의 '서비스 소개' 모달에서 누른 경우) ─────────────────────────
// /main → /main?focus=… 는 같은 화면 안의 소프트 이동이라 지도 화면이 다시 마운트되지 않고, 마운트 때 한 번
// 읽는 ?focus 처리기도 다시 돌지 않는다 — 모달만 닫히고 아무 데도 불이 안 켜졌다(2026-10-07 리뷰).
// 그래서 /main 위에서는 주소를 바꾸지 않고 이 이벤트를 쏜다. /main 은 ?focus 와 같은 갈래를 이 이벤트로도
// 돌린다(onMainFocus 로 구독). detail 은 줄 키 — 'card'(대안 추천 카드)는 이미 그 화면이라 무시해도 된다.

export type MainFocusKey = keyof typeof MAIN_FOCUS_PATHS;
export const MAIN_FOCUS_EVENT = 'nextspot:main-focus';

/** /main 에서 누른 바로가기 — 지도 화면에 '이 기능에 불을 켜라'고 알린다. */
export function requestMainFocus(key: MainFocusKey, target: EventTarget = window): void {
  target.dispatchEvent(new CustomEvent<MainFocusKey>(MAIN_FOCUS_EVENT, { detail: key }));
}

/** 지도 화면 쪽 구독 — 해제 함수를 돌려준다(useEffect 의 정리 함수로 그대로 쓴다). */
export function onMainFocus(handler: (key: MainFocusKey) => void, target: EventTarget = window): () => void {
  const listener = (event: Event) => {
    const key = (event as CustomEvent<unknown>).detail;
    if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(MAIN_FOCUS_PATHS, key)) handler(key as MainFocusKey);
  };
  target.addEventListener(MAIN_FOCUS_EVENT, listener);
  return () => target.removeEventListener(MAIN_FOCUS_EVENT, listener);
}

/** 지금 화면이 지도 화면(/main)인가 — 이때만 바로가기가 이동 대신 이벤트를 쏜다. */
export function isMainPath(pathname: string | null | undefined): boolean {
  return pathname === '/main' || pathname === '/main/';
}
