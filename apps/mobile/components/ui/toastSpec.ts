// AppToaster 의 웹 값과 계산 — react-native 를 import 하지 않는 순수 모듈(toastSpec.test.ts 가 잠근다).
// 기준: 웹 components/shell/ThemeToaster.tsx(sonner 2.0.7, node_modules/sonner/dist/styles.css) — docs/MOBILE_WEB_PARITY.md §4.2 F9,
// findings-G3 G3-34, 결정 D17(b 앱은 Freesentation · c 탭 화면 = 막대 위 8, 그 밖 = 16 + 아래 안전 영역 — navMetrics.toastBottom).

/** sonner [data-styled] 토스트 상자: padding 16 · radius 8 · 그림자 0 4px 12px rgba(0,0,0,.1) · 13px · gap 6. */
export const TOAST_BOX = {
  padding: 16,
  borderRadius: 8,
  /** 요청: tokens shadows.toast 로 옮긴다(B3 보고). */
  shadow: '0px 4px 12px rgba(0, 0, 0, 0.1)',
  gap: 6,
} as const;

/** 제목 13px · 500 · 줄 높이 1.5, 설명 13px · 400 · 줄 높이 1.4 · 제목과 2 간격(sonner [data-content] gap 2). */
export const TOAST_TEXT = {
  titleSize: 13,
  titleLineHeight: 19.5,
  descriptionSize: 13,
  descriptionLineHeight: 18.2,
  contentGap: 2,
} as const;

/**
 * 행동·취소 버튼(sonner [data-button]): 높이 24 · 좌우 8 · 모서리 4 · 12px 500 · 왼쪽 여백 auto(둘 다 — 남는 폭을 나눠 가진다).
 * 행동 = 바탕 --normal-text(#171717) · 글자 --normal-bg(#fff), 취소 = 바탕 rgba(0,0,0,.08) · 글자 #171717. 순서는 취소 → 행동.
 */
export const TOAST_BUTTON = {
  height: 24,
  paddingX: 8,
  borderRadius: 4,
  fontSize: 12,
  /** 요청: tokens 에 이름 붙은 색으로(예: 'toast-ink'). */
  ink: '#171717',
  paper: '#ffffff',
  cancelBg: 'rgba(0, 0, 0, 0.08)',
} as const;

/** 아이콘(sonner [data-icon]): 상자 16 · 왼쪽 −3 · 오른쪽 4, 안의 svg 20 · 왼쪽 −1. 색은 글자색(muk)을 따른다. */
export const TOAST_ICON = { box: 16, marginStart: -3, marginEnd: 4, svg: 20, svgMarginStart: -1 } as const;

/** 접힌 쌓임 간격(sonner GAP 14) · 지속 4000(같음) · 보이는 개수 3. */
export const TOAST_STACK = { gap: 14, duration: 4000, visible: 3 } as const;

/** sonner 휴대폰 기준(≤600px): 좌우 16 띄운 폭 가득. 더 넓으면 폭 356 을 가운데에. */
const MOBILE_MAX = 600;
const DESKTOP_WIDTH = 356;
const MOBILE_SIDE = 16;

/** 토스트 좌우 여백(pt) — 폰은 16, 펼친 폴드·태블릿(>600)은 폭 356 이 되게 가운데. */
export function toastSideMargin(windowWidth: number): number {
  if (windowWidth > MOBILE_MAX) return Math.round((windowWidth - DESKTOP_WIDTH) / 2);
  return MOBILE_SIDE;
}

/** 혼잡 제보 결과 토스트 채널(G3-22) — 화면 아래 96 + 아래 안전 영역, 한 개, 3.2초. */
export const REPORT_TOASTER_ID = 'report';
export const REPORT_TOAST = {
  /** 웹 fixed bottom-24. */
  bottom: 96,
  duration: 3200,
  /** 웹 max-w-sm(384) 바깥 + px-4 → 알약 최대 352. */
  maxWidth: 384,
  sideInset: 16,
  /** 웹 rounded-2xl px-4 py-3 text-sm font-bold text-white text-center. */
  radius: 16,
  paddingX: 16,
  paddingY: 12,
  fontSize: 14,
  lineHeight: 20,
  shadow: '0px 8px 30px rgba(43, 35, 32, 0.18)',
  /** 새 제보 결과는 앞 것을 바꾼다(웹은 상태 하나). */
  id: 'congestion-report-result',
} as const;

export function reportToastBottom(bottomInset: number): number {
  return REPORT_TOAST.bottom + bottomInset;
}

/**
 * 읽기 화면 알림 문구 — 제목과 설명을 한 번에 읽는다. 제목이 문장 부호로 끝나지 않으면 마침표로 쉬게 한다.
 * 빈 값은 빈 문자열(알리지 않는다).
 */
export function announcementText(title: string, description?: string): string {
  const head = title.trim();
  const tail = description?.trim() ?? '';
  if (!tail) return head;
  if (!head) return tail;
  return /[.!?。！？…]$/.test(head) ? `${head} ${tail}` : `${head}. ${tail}`;
}

/** sonner-native ToastAction 판별(isToastAction 과 같은 규칙 — 라이브러리 함수는 공개되지 않았다). */
export function isActionButton(value: unknown): value is { label: string; onClick: () => void } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { label?: unknown }).label === 'string' &&
    typeof (value as { onClick?: unknown }).onClick === 'function'
  );
}
