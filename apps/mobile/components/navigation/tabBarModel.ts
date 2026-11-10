// 하단 탭 막대(TouristTabBar)의 순수 규칙 — React Native import 없음(tabBarModel.test.ts 가 tsx 로 읽는다).
// 웹 원본: apps/web/components/shell/BottomNav.tsx:41-77(탭 목록·getActiveTab·handleTabClick), :154-214(폰 막대 치수).
// 막대 치수의 합은 tokens.NAV_BAR_HEIGHT 와 같아야 한다(tabBarModel.test.ts) — 화면 아래 자리(NAV_GAP 등)가 그 값을 쓴다.

/** 탭 다섯 — app/(tabs) 의 Tabs.Screen 이름(웹 BottomNav tabs 순서). */
export type TabName = 'index' | 'saved' | 'waiting' | 'course' | 'mypage';

export const TAB_ORDER: readonly TabName[] = ['index', 'saved', 'waiting', 'course', 'mypage'];

/** 탭 글자 문구 키(웹 nav.*). */
export const TAB_LABEL_KEYS: Record<TabName, string> = {
  index: 'nav.home',
  saved: 'nav.saved',
  waiting: 'nav.waiting',
  course: 'nav.course',
  mypage: 'nav.mypage',
};

/**
 * 지금 경로(탭 내비게이터의 포커스 route 이름)의 활성 탭 — 웹 getActiveTab(:50-57)처럼 경로로 정한다.
 * 숨은 경로(explore/recommend · explore/map)와 모르는 이름은 '홈'(웹 기본값 :56), 마이 하위는 마이 Stack 안이라 'mypage'.
 */
export function activeTabFor(routeName: string | null | undefined): TabName {
  const top = (routeName ?? '').split('/')[0];
  return top === 'saved' || top === 'waiting' || top === 'course' || top === 'mypage' ? top : 'index';
}

/**
 * 누른 탭으로 이동할까 — 지금 그 탭 자리(탭 내비게이터의 포커스 route 가 그 탭)에서 다시 누르면 아무 일 없음
 * (웹 handleTabClick 첫 줄 :69, D13(d) — 마이 하위에서 '마이'도 무시). 숨은 경로(explore/*)에서 '홈'은 활성으로 그려지지만
 * 누르면 홈으로 간다 — 대안 화면에 머리가 없어 지도로 돌아갈 길이 막히지 않게(B6 검토 M5).
 */
export function shouldNavigateOnPress(pressed: TabName, focusedRouteName: string | null | undefined): boolean {
  return pressed !== focusedRouteName;
}

/**
 * 탭을 누를 때 navigate 에 줄 params — 마이는 늘 마이 첫 화면으로(웹 router.push('/mypage')).
 * 중첩 Stack 에 `pop: true` 로 보내야 이미 있는 index 까지 되돌아간다(없으면 StackRouter 가 index 를 하나 더 쌓는다).
 */
export function tabPressParams(tab: TabName): { screen: string; pop: true } | undefined {
  return tab === 'mypage' ? { screen: 'index', pop: true } : undefined;
}

/**
 * 막대 치수(pt, 안전 영역 제외) — 웹 폰 막대 `border-t px-6 py-2` + 안내 줄 `h-8 mb-1 pb-1 border-b` + 탭 줄 `h-12`.
 * 합 = NAV_BAR_HEIGHT(101, 웹 실측 0,743,390×101). 아래 안전 영역은 paddingBottom 에만 더한다.
 */
export const TAB_BAR = {
  borderTop: 1,
  paddingTop: 8,
  paddingBottom: 8,
  paddingX: 24,
  /** 안내 줄 높이(아래 테두리·pb-1 포함 — RN 은 border-box). */
  guideRow: 32,
  guideRowPaddingBottom: 4,
  guideRowMarginBottom: 4,
  tabRow: 48,
} as const;

export const TAB_BAR_CONTENT_HEIGHT =
  TAB_BAR.borderTop + TAB_BAR.paddingTop + TAB_BAR.guideRow + TAB_BAR.guideRowMarginBottom + TAB_BAR.tabRow + TAB_BAR.paddingBottom;

/** 활성 알약(웹 `h-12 w-14 rounded-2xl bg-gold/15`). */
export const TAB_PILL = { width: 56, height: 48, radius: 16 } as const;

/** 탭 아이콘(웹 Icon size 22) · 아이콘 아래 간격(mb-0.5). */
export const TAB_ICON_SIZE = 22;
export const TAB_ICON_GAP = 2;

/** 탭 글자 — 웹 text-[11px](줄 높이 1.5 = 16.5), 대기 탭만 text-[10px] tracking-tight(−0.25px, 줄 15)(G2-R02). */
export const TAB_LABEL = { fontSize: 11, lineHeight: 16.5 } as const;
export const TAB_LABEL_COMPACT = { fontSize: 10, lineHeight: 15, letterSpacing: -0.25 } as const;

/** 큰 글자 설정에서 탭·안내 줄 글자 배율 상한 — 칸 높이가 고정이라 넘치지 않게(아이콘이 뜻을 함께 전한다). */
export const TAB_LABEL_MAX_FONT_SCALE = 1.2;

/** 글자가 작은 탭(웹 mobileLabelClass) — 유일하게 긴 '지금 출발하면?'. */
export function isCompactLabel(tab: TabName): boolean {
  return tab === 'waiting';
}

/** 웹 막대 그림자 shadow-[0_-2px_14px_rgba(43,35,32,0.06)] — 토큰 shadows.tabBar 가 생기면 그것으로 바꾼다(요청 목록). */
export const TAB_BAR_SHADOW = '0px -2px 14px rgba(43, 35, 32, 0.06)';
