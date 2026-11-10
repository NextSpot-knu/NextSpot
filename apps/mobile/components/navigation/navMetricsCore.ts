// 하단 탭 막대 치수(순수 계산 — React Native import 없음, 테스트가 tsx 로 읽는다) — 화면이 아래 여백을 정할 때 쓰는 한 곳(docs/MOBILE_WEB_PARITY.md §4.2 F1).
//
// 앱은 막대를 '보통 흐름'으로 둔다: 막대는 탭 내비게이터의 기본 자리(높이 NAV_BAR_HEIGHT + 아래 안전 영역)에 있고
// 탭 화면은 그 위에서 끝난다. 웹은 막대를 겹쳐 두고 내용에 --tourist-nav-clearance(116) 여백을 주므로,
// 웹 `clearance + X` 는 탭 화면 안에서 `NAV_GAP + X`(116 − 101 = 15) 다.
// 화면 코드에 15·24·101·116 을 직접 쓰지 않는다 — 이 파일과 tokens 의 NAV_BAR_HEIGHT·NAV_CLEARANCE 만 쓴다.
import { NAV_BAR_HEIGHT, NAV_CLEARANCE } from '../../lib/theme/tokens';

/** 탭 화면 안에서 막대 위로 남기는 간격 — 웹 clearance(116) − 막대(101). */
export const NAV_GAP = NAV_CLEARANCE - NAV_BAR_HEIGHT;

/** 토스트가 막대 위로 띄우는 간격(웹 sonner offset). */
const TOAST_ABOVE_BAR = 8;
/** 막대가 없는 화면에서 토스트의 아래 간격. */
const TOAST_NO_BAR = 16;

/** 웹 BottomNav NAV_ROUTES 와 같은 규칙 — 앱 홈은 '/'(웹 '/main'). */
const TAB_ROUTES = ['/saved', '/waiting', '/course', '/mypage', '/explore'] as const;

/** 막대가 보이는 경로인가(웹 components/shell/BottomNav.tsx 의 NAV_ROUTES). */
export function isTabRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  if (pathname === '/') return true;
  return TAB_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

export type NavInsets = {
  /** 탭 화면 안에서 내용 아래에 둘 간격(막대가 없으면 0). 웹 `clearance + X` → `gap + X`. */
  gap: number;
  /** 지금 경로에 막대가 보이는가. */
  onTab: boolean;
  /** 막대가 차지하는 높이(안전 영역 포함, 막대가 없으면 0). */
  barHeight: number;
  /** 화면 아래에서 잰 토스트 자리 — 탭 화면은 막대 위 8, 그 밖은 16 + 아래 안전 영역. */
  toastBottom: number;
  /** 웹이 화면 아래에서 잰 값(px)을 탭 화면 안 좌표로 — 막대가 없으면 그대로. */
  fromScreenBottom: (px: number) => number;
};

/** 순수 계산 — 테스트와 훅이 같이 쓴다. */
export function navInsetsFor(pathname: string | null | undefined, bottomInset: number): NavInsets {
  const onTab = isTabRoute(pathname);
  const barHeight = onTab ? NAV_BAR_HEIGHT + bottomInset : 0;
  return {
    gap: onTab ? NAV_GAP : 0,
    onTab,
    barHeight,
    toastBottom: onTab ? barHeight + TOAST_ABOVE_BAR : TOAST_NO_BAR + bottomInset,
    fromScreenBottom: (px) => (onTab ? px - NAV_BAR_HEIGHT : px),
  };
}

