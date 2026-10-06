// /main 첫 화면에서 처음 열린 칩에 지금 추천할 곳이 없을 때 대신 열 칩(밤의 첫 화면, 계획 B2 잔여 항목).
//
// 왜 필요한가: 밤에 /main 을 처음 열면 기본 칩(음식점)은 문 연 곳이 없어 카드 대신 '근처의 다른 곳을 바로
// 보여드릴게요' 제안 카드만 떴다. 심사위원이 아무것도 누르지 않은 첫 화면이 빈 카드다. 이제 **처음 한 번만**
// 지금 추천할 수 있는 곳이 가장 많은 칩을 자동으로 열고 짧게 알린다. 사용자가 칩을 직접 누른 뒤에는 이렇게 하지
// 않는다 — 그때는 종전대로 제안 카드가 고를 칩을 보여 준다.

import type { PlaceCategory } from './travelContext';

/** 칩 순서 — 같은 수면 앞의 칩. /main 의 CATEGORY_FILTERS 와 같다. */
export const FIRST_VIEW_ORDER: readonly PlaceCategory[] = ['restaurant', 'cafe', 'attraction', 'culture'];

/**
 * counts: 칩마다 '지금 카드에 올릴 수 있는' 장소 수(조건·영업 확인을 통과한 수).
 * current: 지금 열려 있는 칩. 그 칩을 뺀 나머지 중 가장 많은 칩, 모두 0 이면 null(옮기지 않는다).
 */
export function pickFirstViewCategory(
  counts: Partial<Record<PlaceCategory, number>>,
  current: PlaceCategory | null,
): PlaceCategory | null {
  let best: { type: PlaceCategory; count: number } | null = null;
  for (const type of FIRST_VIEW_ORDER) {
    if (type === current) continue;
    const count = counts[type] ?? 0;
    if (count > 0 && (!best || count > best.count)) best = { type, count };
  }
  return best?.type ?? null;
}
