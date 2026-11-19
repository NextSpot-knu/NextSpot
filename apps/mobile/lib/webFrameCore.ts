// 넓은 화면(데스크톱 브라우저)에서 앱을 폰 폭 기둥으로 그리는 규칙 — 순수 값·함수(테스트: webFrameCore.test.ts).
// CSS(미디어 쿼리)와 JS(창 크기 보정)가 같은 숫자를 쓴다 — 둘 다 lib/webSetup.web.ts 가 싣는다.
// 네이티브는 이 규칙을 쓰지 않는다.

/** 기둥 폭 — 큰 안드로이드 폰(412)·아이폰 Pro Max(430) 쯤. */
export const PHONE_FRAME_WIDTH = 430;

/** 창이 이 폭 이상이면 기둥으로 그린다. 그보다 좁으면(폰 브라우저) 창 전체를 쓴다. */
export const FRAME_MIN_VIEWPORT = 600;

export interface WindowSize {
  width: number;
  height: number;
  scale: number;
  fontScale: number;
}

/** 기둥으로 그리는 창인가. */
export function isFramedViewport(viewportWidth: number): boolean {
  return viewportWidth >= FRAME_MIN_VIEWPORT;
}

/** 화면 코드가 보는 창 크기 — 기둥이면 폭만 기둥 폭으로 바꾼다(높이는 창 그대로). */
export function framedWindow<T extends WindowSize>(window: T): T {
  return isFramedViewport(window.width) ? { ...window, width: PHONE_FRAME_WIDTH } : window;
}

/** lib/webSetup.web.ts 가 <head> 에 싣는 CSS. 기둥 바깥은 한지보다 조금 진한 바탕. */
export function webFrameCss(colors: { page: string; outside: string }): string {
  return `
html, body { background-color: ${colors.page}; }
@media (min-width: ${FRAME_MIN_VIEWPORT}px) {
  html { background-color: ${colors.outside}; }
  /* html > body — react-native-web 가 뒤에 싣는 body{margin:0} 보다 우선하게. */
  html > body {
    width: ${PHONE_FRAME_WIDTH}px;
    margin: 0 auto;
    /* position:fixed 로 body 에 붙는 층(모달 포털)도 기둥 안에 가둔다. */
    transform: translateZ(0);
    box-shadow: 0 0 0 1px rgba(43, 36, 30, 0.08), 0 16px 48px rgba(43, 36, 30, 0.16);
  }
}`;
}
