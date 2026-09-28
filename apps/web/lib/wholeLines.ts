// 고정 높이 카드 안의 글 블록(이름 → 메뉴 → 소개)에 **온전한 줄만** 싣는다.
// overflow-hidden 으로 남는 픽셀에서 자르면 줄이 가로로 반쯤 잘려 보인다 — 대신 블록마다 들어갈 줄 수를
// 정해 line-clamp 로 줄 단위로 자르고, 한 줄도 못 들어가는 블록은 통째로 숨긴다.

export interface LineBlock {
  /** 한 줄 높이(px) — getComputedStyle(el).lineHeight */
  lineHeight: number;
  /** 자르지 않았을 때(자체 최대 줄 수 안에서) 차지하는 줄 수 */
  lines: number;
  /** 블록 위 여백(px, margin-top) — 첫 블록에는 쓰지 않는다 */
  gapBefore: number;
}

// 소수 픽셀 반올림 여유 — 33.0px 에 16.5px 두 줄이 32.999 로 재여 한 줄로 떨어지지 않게.
const EPSILON = 0.01;

/**
 * available(px) 높이에 순서대로 온전히 들어가는 줄 수. 한 블록이 줄어들면(잘리면) 그 뒤 블록은 0 —
 * 말줄임(…) 아래에 다음 글이 이어 붙으면 어디까지가 한 덩어리인지 흐려진다.
 */
export function fitWholeLines(available: number, blocks: readonly LineBlock[]): number[] {
  const shown: number[] = [];
  let remaining = available;
  let cut = false;
  blocks.forEach((block, i) => {
    if (cut || block.lines <= 0 || !(block.lineHeight > 0)) {
      shown.push(0);
      return;
    }
    const room = remaining - (i > 0 ? block.gapBefore : 0);
    const fits = Math.max(0, Math.min(block.lines, Math.floor((room + EPSILON) / block.lineHeight)));
    shown.push(fits);
    if (fits > 0) remaining = room - fits * block.lineHeight;
    if (fits < block.lines) cut = true;
  });
  return shown;
}
