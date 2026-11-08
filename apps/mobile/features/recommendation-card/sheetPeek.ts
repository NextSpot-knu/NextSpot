// 추천 시트의 가장 낮은 높이(px) — 머리 + 첫 행동 줄(바로 갈래요) 묶음을 재서 정한다. 네이티브 의존 없는 순수 함수(sheetPeek.test.ts).
//
// 27% 비율로는 경고 칩이 두 줄이 되거나 글자를 키우면 바로 갈래요가 잘렸다(411x833dp 에서 머리 묶음 약 186dp > 27% 내용 칸 약 160dp).

/** 행동 줄 아래 숨 쉴 여백(pt) — 버튼 그림자와 시트 바닥 테두리를 빼고 10dp 안팎이 남는다(411x833dp 에뮬레이터 실측). */
export const PEEK_BOTTOM_GAP = 18;
/** 가장 낮은 높이의 하한(pt) — 잰 값이 이상해도 손잡이와 한 줄은 보이게. */
export const PEEK_MIN = 120;
/**
 * 상한 — 기본 높이(시트 컨테이너의 52%)에서 이만큼(pt) 아래. 이보다 높으면 스냅 순서가 깨지고, 홈(기본 높이에서 자른다)과
 * 시트가 서로 다른 높이를 쓰게 된다. 컨테이너 높이를 아직 모르면 창 높이의 40%.
 */
export const PEEK_NORMAL_RATIO = 0.52;
export const PEEK_BELOW_NORMAL = 24;
export const PEEK_FALLBACK_WINDOW_RATIO = 0.4;
/** 이만큼(pt) 넘게 바뀔 때만 스냅을 바꾼다 — 1~2dp 레이아웃 흔들림으로 시트가 들썩이지 않게. */
export const PEEK_CHANGE_THRESHOLD = 4;

/** 가장 낮은 높이의 상한(pt) — 시트 컨테이너 높이 기준, 모르면 창 높이 기준. 0 이면 아직 모름. */
export function peekMaxHeight(containerHeight: number, windowHeight: number): number {
  if (containerHeight > 0) return Math.round(containerHeight * PEEK_NORMAL_RATIO - PEEK_BELOW_NORMAL);
  if (windowHeight > 0) return Math.round(windowHeight * PEEK_FALLBACK_WINDOW_RATIO);
  return 0;
}

/** 묶음 높이 → 가장 낮은 높이(px). 잴 수 없으면 null(27% 그대로). 상한이 하한보다 낮으면(아주 짧은 창) 상한을 따른다. */
export function peekSnapHeight(blockHeight: number, handleHeight: number, maxHeight: number): number | null {
  if (!(blockHeight > 0) || !(maxHeight > 0)) return null;
  const wanted = Math.max(PEEK_MIN, Math.round(handleHeight + blockHeight + PEEK_BOTTOM_GAP));
  return Math.min(Math.round(maxHeight), wanted);
}

/**
 * 새로 계산한 값을 쓸지 — 처음이거나, 문턱보다 크게 바뀌었거나, 이전 값이 지금 상한(max)을 넘을 때. 아니면 이전 값을 그대로
 * 돌려준다(상태를 바꾸지 않게).
 */
export function nextPeekHeight(prev: number | null, next: number | null, max?: number): number | null {
  if (next === null) return prev;
  if (prev === null) return next;
  if (max !== undefined && max > 0 && prev > max) return next;
  return Math.abs(next - prev) > PEEK_CHANGE_THRESHOLD ? next : prev;
}
