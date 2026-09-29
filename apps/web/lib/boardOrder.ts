// 대기 보드 섹터 안의 줄 세우기 — 예상 대기가 짧은 순. 카드가 **같은 대기를 보여 줄 때만** 사진이 있는 곳을 앞에 둔다.
//
// PM 결정(2026-09-28): 사진은 동점일 때만 순서를 가른다. 사진이 있다고 더 짧은 대기보다 앞설 수 없고,
// 어떤 장소가 보드에 오르는지(후보)와 SPOT 순위·점수는 바뀌지 않는다.
//
// '같은 대기' = 카드의 주인공 한 줄(waitHeadlineOf)이 **같은 말**을 한다. 분이 있으면 같은 분,
// 분이 없으면 같은 근거·같은 등급(예: 둘 다 '추정 혼잡도: 여유') 또는 둘 다 '수집 중'.
// 분이 없는 곳끼리를 한 덩어리 동점으로 보면 안 된다 — 프로덕션은 거의 모든 카드가 분이 없어서, 그러면
// '혼잡' 인 사진 카드가 '여유' 인 사진 없는 카드를 앞질렀다(리뷰 지적, 2026-09-29).
//
// 비교 함수(sort comparator)로 만들지 않는다: '같은 말끼리만 사진 우선, 다른 말끼리는 원래 순서' 는 추이적이지
// 않아서(A~B, B~C 인데 A>C) 정렬 결과가 엔진마다 달라질 수 있다. 대신 ① 대기(분)로 안정 정렬한 뒤
// ② **바로 붙어 있는** 같은 말 카드 묶음 안에서만 사진 있는 곳을 앞으로 모은다(안정). 그래서 어떤 카드도
// 다른 말을 하는 카드를 건너뛰지 않는다 — 사진 카드는 자기와 같은 대기를 보여 주는 이웃만 앞지른다.

import { congestionKey, type CongestionKey } from '@/lib/congestionScale';
import { compareWaitMinutes, type WaitEstimate } from '@/lib/waitEstimate';

/** 카드의 주인공 한 줄이 무엇을 말하는지(문구가 아니라 뜻). 화면 문구(page.tsx waitHeadline)와 정렬이 같이 쓴다. */
export type WaitHeadline =
  | { kind: 'minutes'; n: number }
  | { kind: 'noWait' }
  | { kind: 'relaxed' }
  | { kind: 'estimate'; level: CongestionKey }
  | { kind: 'area'; level: CongestionKey }
  | { kind: 'tourism'; n: number }
  | { kind: 'unavailable' };

export interface WaitHeadlineEvidence {
  /** /congestion/estimates 의 시설별 추정(0~1). 없으면 undefined/null. */
  estimateLevel?: number | null;
  /** 권역 주차 수요 등급(0~1). */
  areaDemandLevel?: number | null;
  /** 관광 상대지수. */
  tourismRelativeIndex?: number | null;
}

/**
 * 분으로 말할 근거가 있으면 분을, 없으면 그 근거가 **실제로 아는 것**(시설 추정 혼잡 · 주변 권역 수요 등급 ·
 * 관광 상대지수)을, 그것도 없으면 '수집 중'. 주변 주차·관광 상대지수를 '대기 N분'으로 바꾸지 않는다.
 */
export function waitHeadlineOf(est: WaitEstimate, ev: WaitHeadlineEvidence): WaitHeadline {
  if (est.minutes !== null) {
    if (est.minutes > 0) return { kind: 'minutes', n: est.minutes };
    // '대기 없음'은 검증 예측(server)에만 — 추정으로 0분을 단언하지 않는다.
    return est.basis === 'server' ? { kind: 'noWait' } : { kind: 'relaxed' };
  }
  if (est.basis === 'estimate' && typeof ev.estimateLevel === 'number') {
    return { kind: 'estimate', level: congestionKey(ev.estimateLevel) };
  }
  if (est.basis === 'area' && typeof ev.areaDemandLevel === 'number') {
    return { kind: 'area', level: congestionKey(ev.areaDemandLevel) };
  }
  if (est.basis === 'tourism' && typeof ev.tourismRelativeIndex === 'number') {
    return { kind: 'tourism', n: Math.round(ev.tourismRelativeIndex) };
  }
  return { kind: 'unavailable' };
}

/** 같은 말이면 같은 문자열 — 줄 세우기의 동점 판정에 쓴다. */
export function waitHeadlineKey(h: WaitHeadline): string {
  switch (h.kind) {
    case 'minutes':
    case 'tourism':
      return `${h.kind}:${h.n}`;
    case 'estimate':
    case 'area':
      return `${h.kind}:${h.level}`;
    default:
      return h.kind;
  }
}

export interface BoardOrderKey {
  wait: WaitEstimate;
  /** 카드가 보여 주는 대기 한 줄의 키(waitHeadlineKey). 같은 키끼리만 사진이 순서를 가른다. */
  headlineKey: string;
  /** 띄울 수 있는 사진 후보가 하나라도 있는가(출처 없는 Wikimedia 사진은 후보가 아니다). */
  hasPhoto: boolean;
}

/**
 * 대기 짧은 순(분이 없는 곳은 뒤, 그 안은 원래 순서)으로 세운 뒤, 바로 붙어 있는 같은 대기 한 줄 묶음 안에서만
 * 사진 있는 곳을 앞으로 모은다. 입력 배열은 건드리지 않는다. 같은 입력이면 같은 결과(결정적).
 */
export function orderByWaitThenPhoto<T>(rows: readonly T[], keyOf: (row: T) => BoardOrderKey): T[] {
  const keyed = rows.map((row) => ({ row, key: keyOf(row) }));
  // Array.prototype.sort 는 안정 정렬 — 같은 분·분 없음끼리는 원래 순서.
  keyed.sort((a, b) => compareWaitMinutes(a.key.wait, b.key.wait));
  const out: T[] = [];
  let i = 0;
  while (i < keyed.length) {
    let j = i + 1;
    while (
      j < keyed.length &&
      compareWaitMinutes(keyed[i].key.wait, keyed[j].key.wait) === 0 &&
      keyed[j].key.headlineKey === keyed[i].key.headlineKey
    ) {
      j++;
    }
    const run = keyed.slice(i, j);
    for (const k of run) if (k.key.hasPhoto) out.push(k.row);
    for (const k of run) if (!k.key.hasPhoto) out.push(k.row);
    i = j;
  }
  return out;
}
