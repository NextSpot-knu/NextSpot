// 추천 카드 머리 배지 — 이 카드가 지금 보이는 추천 목록에서 몇 번째인가(계획 B2 · I23).
//
// 왜 필요한가: 순위가 없는 카드(지도 핀을 직접 누른 곳, 음성 '다음' 으로 넘어간 곳)는 렌더할 때마다 클라이언트
// 점수로 순위를 다시 매겼다. 서버 목록은 5곳인데 '추천 14순위 · 대안 428개 중' 이 붙고, 손대지 않아도 26순위로
// 바뀌었다. 이제 배지는 관광객이 본 목록에서만 순위를 말한다:
//   · 1위 '베스트 추천', 2~3위 'N번째 추천', 4위부터 '다음 후보'(숫자 없음)
//   · 목록에 없는 곳(핀 · 검색 · 링크로 직접 고른 곳)은 '선택한 장소'(숫자 없음)

export type CardRankLabel =
  | { kind: 'top' }
  | { kind: 'rank'; rank: number }
  | { kind: 'next' }
  | { kind: 'selected' };

/** 숫자로 말하는 마지막 순위. 그 뒤는 '다음 후보' 다. */
export const LAST_NUMBERED_RANK = 3;

/**
 * listRank: 이 장소가 보이는 추천 목록에서 몇 번째인지(1부터). 목록에 없으면 null.
 * 숫자가 아니거나 1보다 작으면 목록에 없는 것으로 본다(지어낸 순위를 말하지 않는다).
 */
export function cardRankLabel(listRank: number | null | undefined): CardRankLabel {
  if (typeof listRank !== 'number' || !Number.isInteger(listRank) || listRank < 1) return { kind: 'selected' };
  if (listRank === 1) return { kind: 'top' };
  if (listRank <= LAST_NUMBERED_RANK) return { kind: 'rank', rank: listRank };
  return { kind: 'next' };
}

/** 배지 문구의 i18n 키와 변수. */
export function cardRankText(label: CardRankLabel): { key: string; vars?: Record<string, number> } {
  switch (label.kind) {
    case 'top': return { key: 'card.rankBadgeTop' };
    case 'rank': return { key: 'card.rankBadge', vars: { rank: label.rank } };
    case 'next': return { key: 'card.nextCandidate' };
    default: return { key: 'card.selectedPlace' };
  }
}
