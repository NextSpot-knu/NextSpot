// 대기 보드 섹터 안의 줄 세우기 — 예상 대기가 짧은 순. 대기가 **같을 때만** 사진이 있는 곳을 앞에 둔다.
//
// PM 결정(2026-09-28): 사진은 동점일 때만 순서를 가른다. 사진이 있다고 더 짧은 대기보다 앞설 수 없고,
// 어떤 장소가 보드에 오르는지(후보)와 SPOT 순위·점수는 바뀌지 않는다. 동점이고 사진 여부도 같으면 0 을
// 돌려 원래 순서를 지킨다(Array.prototype.sort 는 안정 정렬).
//
// '같은 대기' = 보드가 비교하는 값이 같다(compareWaitMinutes === 0): 같은 분(정수, 화면의 'N분')이거나
// 둘 다 분으로 말할 근거가 없는 경우. 분이 없는 곳은 여전히 분이 있는 곳 뒤다.

import { compareWaitMinutes, type WaitEstimate } from '@/lib/waitEstimate';

export interface BoardOrderKey {
  wait: WaitEstimate;
  /** 띄울 수 있는 사진 후보가 하나라도 있는가(출처 없는 Wikimedia 사진은 후보가 아니다). */
  hasPhoto: boolean;
}

export function compareWaitThenPhoto(a: BoardOrderKey, b: BoardOrderKey): number {
  const byWait = compareWaitMinutes(a.wait, b.wait);
  if (byWait !== 0) return byWait;
  if (a.hasPhoto === b.hasPhoto) return 0;
  return a.hasPhoto ? -1 : 1;
}
