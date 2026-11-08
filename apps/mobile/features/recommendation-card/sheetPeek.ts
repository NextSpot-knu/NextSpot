// 추천 시트의 가장 낮은 높이(px) — 머리 + 첫 행동 줄(바로 갈래요) 묶음을 재서 정한다. 네이티브 의존 없는 순수 함수(sheetPeek.test.ts).
//
// 27% 비율로는 경고 칩이 두 줄이 되거나 글자를 키우면 바로 갈래요가 잘렸다(411x833dp 에서 머리 묶음 약 186dp > 27% 내용 칸 약 160dp).

/** 행동 줄 아래 숨 쉴 여백(pt) — 버튼 그림자와 시트 바닥 테두리를 빼고 10dp 안팎이 남는다(411x833dp 에뮬레이터 실측). */
export const PEEK_BOTTOM_GAP = 18;
/** 가장 낮은 높이의 하한(pt) — 잰 값이 이상해도 손잡이와 한 줄은 보이게. */
export const PEEK_MIN = 120;
/** 상한 — 창 높이의 이 비율. 기본 높이(컨테이너 52%)보다 낮아야 스냅 순서가 지켜진다(컨테이너는 창의 85% 안팎). */
export const PEEK_MAX_RATIO = 0.4;
/** 이만큼(pt) 넘게 바뀔 때만 스냅을 바꾼다 — 1~2dp 레이아웃 흔들림으로 시트가 들썩이지 않게. */
export const PEEK_CHANGE_THRESHOLD = 4;

/** 묶음 높이 → 가장 낮은 높이(px). 잴 수 없으면 null(27% 그대로). */
export function peekSnapHeight(blockHeight: number, windowHeight: number, handleHeight: number): number | null {
  if (!(blockHeight > 0) || !(windowHeight > 0)) return null;
  const max = Math.round(windowHeight * PEEK_MAX_RATIO);
  return Math.max(PEEK_MIN, Math.min(max, Math.round(handleHeight + blockHeight + PEEK_BOTTOM_GAP)));
}

/** 새로 잰 값을 쓸지 — 처음이거나 문턱보다 크게 바뀌었을 때만. 아니면 이전 값을 그대로 돌려준다(상태를 바꾸지 않게). */
export function nextPeekHeight(prev: number | null, next: number | null): number | null {
  if (next === null) return prev;
  if (prev === null) return next;
  return Math.abs(next - prev) > PEEK_CHANGE_THRESHOLD ? next : prev;
}
