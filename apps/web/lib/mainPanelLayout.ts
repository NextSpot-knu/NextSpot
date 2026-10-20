// /main 데스크톱 오른쪽 추천 패널의 폭 — 한 곳에서만 정한다(계획 B2 · I31).
//
// 왜 필요한가: 카드 열은 370px 고정이었고, 지도 가시영역을 계산하는 곳들(centerOnFreeArea ·
// fitBarrierFreePins)은 그 폭을 386 이라는 숫자로 따로 들고 있었다. 패널을 넓히면 지도 중심이 카드 밑으로
// 숨는다. 카드 · 재계산 스켈레톤 · 제안 카드 · 음성 슬롯이 같은 클래스(DESKTOP_PANEL_CLASS)를 쓰고, 지도 쪽은
// 같은 표(DESKTOP_PANEL_STEPS)에서 나온 desktopPanelReservePx() 로 같은 폭을 비운다(B3 의 시간 줄도 이 값을 쓴다).
//
// 지도 카드 배치 경계와 맞춘다: lg 1024 → 380px, xl 1280 → 420px, 2xl 1536 → 460px.
// 그 아래는 지도 위 하단 카드라 오른쪽 폭을 예약하지 않는다. 왼쪽 레일의 md 경계는 독립적이다.

/** 넓은 화면부터 — 첫 번째로 minWidth 이상인 단계의 폭을 쓴다. */
export const MAP_DESKTOP_MIN_WIDTH = 1024;

export const DESKTOP_PANEL_STEPS: readonly { minWidth: number; width: number }[] = [
  { minWidth: 1536, width: 460 },
  { minWidth: 1280, width: 420 },
  { minWidth: MAP_DESKTOP_MIN_WIDTH, width: 380 },
];

/** 패널과 화면 오른쪽 가장자리 사이(right-4). */
export const DESKTOP_PANEL_GUTTER_PX = 16;

/**
 * 패널 열의 위치·폭 클래스(lg 이상). 위 표와 같은 값이어야 한다 — lib/mainPanelLayout.test.ts 가 맞춰 본다.
 * Tailwind 가 소스에서 그대로 읽을 수 있게 문자열 리터럴로 둔다(조립하지 않는다).
 */
export const DESKTOP_PANEL_CLASS = 'lg:left-auto lg:right-4 lg:w-[380px] lg:px-0 xl:w-[420px] 2xl:w-[460px]';

/** 화면 폭에서 패널 폭(px). 간결한 지도 배치에서는 0. */
export function desktopPanelWidthPx(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth)) return 0;
  return DESKTOP_PANEL_STEPS.find((step) => viewportWidth >= step.minWidth)?.width ?? 0;
}

/**
 * 지도에서 패널이 가리는 오른쪽 폭(px) = 패널 폭 + 오른쪽 여백. 휴대폰이면 0.
 * 인자를 주지 않으면 지금 창 폭을 읽는다(서버 렌더에서는 0).
 */
export function desktopPanelReservePx(viewportWidth?: number): number {
  const width = viewportWidth ?? (typeof window === 'undefined' ? 0 : window.innerWidth);
  const panel = desktopPanelWidthPx(width);
  return panel > 0 ? panel + DESKTOP_PANEL_GUTTER_PX : 0;
}

/** 데스크톱 왼쪽 유리 캡슐 뒤 여백(px) — globals.css 의 --rail-gutter 와 같은 값. /main 은 지도가 캡슐 뒤까지 이어져 이만큼을 비워 중심을 맞춘다. */
export const DESKTOP_RAIL_GUTTER_PX = 100;
