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
