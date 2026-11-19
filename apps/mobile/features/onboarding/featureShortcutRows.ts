// '이렇게 써 보세요' 다섯 줄 중 앱에 보일 줄 — 순수 모듈(테스트: featureShortcutRows.test.ts).
//
// 웹 원본: apps/web/lib/featureShortcuts.ts(기준 커밋 0d145a1) — 줄 순서·키(FEATURE_SHORTCUT_KEYS)만 옮겼다.
// 웹 모듈은 requestMainFocus 가 window·CustomEvent 를 써서 check:shared 에 걸린다(검토 R1 G1-09) — import 하지 않는다.
// 앱 규칙(결정 D6 ①·D7 ①, docs/MOBILE_WEB_PARITY.md §3.2):
//   · forecast(혼잡 예측 지도)·voice(AI 음성 비서)는 앱에 아직 없어 숨긴다(D12 히트맵 v1.1, D9 음성 v1.1).
//   · card·live 는 홈으로(웹 /main · /main?focus=live — 앱 홈은 카드의 실시간 정보를 늘 보인다).
//   · console 은 두 콘솔을 운영 웹으로 연다(lib/core/consoleEntries) — SHOW_CONSOLE_ENTRIES 가 false 면 숨긴다.
export const FEATURE_SHORTCUT_KEYS = ['forecast', 'card', 'live', 'voice', 'console'] as const;
export type FeatureShortcutKey = (typeof FEATURE_SHORTCUT_KEYS)[number];

/** 앱에 아직 없는 기능 — 이식되면 여기서 뺀다. */
const NOT_IN_APP: ReadonlySet<FeatureShortcutKey> = new Set(['forecast', 'voice']);

/** 앱 소개에 보일 줄(웹 순서 그대로). 번호는 보이는 줄 기준으로 1부터 다시 매긴다(화면이 index + 1). */
export function appFeatureShortcuts(showConsoles: boolean): FeatureShortcutKey[] {
  return FEATURE_SHORTCUT_KEYS.filter((key) => !NOT_IN_APP.has(key) && (key !== 'console' || showConsoles));
}
