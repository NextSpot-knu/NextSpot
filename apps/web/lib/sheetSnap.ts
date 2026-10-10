// 추천 카드(시트)를 끌었다 놓을 때 어느 높이로 걸릴지 정한다.
//
// 손가락이 멈춘 자리가 아니라 **놓은 속도로 계속 갔다면 닿았을 자리**(투영)로 정한다 — Apple WWDC18
// "Designing Fluid Interfaces" 의 방식. 예전 규칙(이동 50px 초과 '또는' 속도 200px/s 초과)은 아래로 80px 끌다가
// 위로 되튕겨 놓아도 접혔다(이동만 보고 마지막 방향을 무시했다). 투영 시간 0.25초는 예전 두 기준을 그대로 잇는다:
// 손가락이 거의 안 움직였으면 200px/s 초과 튕김에서, 손가락이 멈췄으면 50px 초과 이동에서 바뀐다.

export type SheetState = 'minimized' | 'normal' | 'expanded';

export const SHEET_SNAP_PX = 50;
export const SHEET_PROJECTION_S = 0.25;

/** 놓은 자리(offset, px — 아래가 +)와 속도(px/s)로, 그 속도가 이어졌다면 닿았을 위치. */
export function projectedOffset(offset: number, velocity: number): number {
  const o = Number.isFinite(offset) ? offset : 0;
  const v = Number.isFinite(velocity) ? velocity : 0;
  return o + v * SHEET_PROJECTION_S;
}

/** 놓았을 때 걸릴 높이. 한 번에 한 칸만 움직인다(펼침 ↔ 기본 ↔ 미리보기). */
export function nextSheetState(state: SheetState, offset: number, velocity: number): SheetState {
  const p = projectedOffset(offset, velocity);
  const down = p > SHEET_SNAP_PX;
  const up = p < -SHEET_SNAP_PX;
  if (state === 'expanded') return down ? 'normal' : state;
  if (state === 'minimized') return up ? 'normal' : state;
  if (down) return 'minimized';
  if (up) return 'expanded';
  return state;
}

/**
 * 끄는 동안 손가락을 얼마나 따라갈지(framer `dragElastic`, 0 = 꿈쩍 않음 · 1 = 손가락 그대로).
 * 놓으면 높이가 바뀌는 방향은 잘 따라오고, 더 갈 곳이 없는 방향은 단단히 버틴다 — 끄는 동안 이미 '이쪽으로는
 * 더 없다' 를 손에 알려 준다(iOS 시트의 끝 저항과 같은 뜻). 카드 전체가 떠 있는 판이라 1:1 로 옮기지는 않는다
 * (위로 1:1 이면 카드 아래가 탭 막대에서 떨어져 지도가 비친다).
 */
export function sheetElastic(state: SheetState): { top: number; bottom: number } {
  const open = 0.3;
  const end = 0.08;
  return {
    top: state === 'expanded' ? end : open,
    bottom: state === 'minimized' ? end : open,
  };
}
