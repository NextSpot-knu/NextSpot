// 대기 보드 섹터 안의 줄 세우기 — 예상 대기가 짧은 순(분이 없는 카드끼리는 한산한 등급 순, PM 결정 2026-10-06 4.20).
// 카드가 **같은 대기를 보여 줄 때만** 사진이 있는 곳을 앞에 둔다.
//
// PM 결정(2026-09-28): 사진은 동점일 때만 순서를 가른다. 사진이 있다고 더 짧은 대기보다 앞설 수 없고,
// 어떤 장소가 보드에 오르는지(후보)와 SPOT 순위·점수는 바뀌지 않는다.
//
// '같은 대기' = 카드의 주인공 한 줄(waitHeadlineOf)이 **같은 말**을 한다. 분이 있으면 같은 분,
// 분이 없으면 같은 근거·같은 등급(예: 둘 다 '추정 혼잡도: 여유') 또는 둘 다 근거 없음(머리줄 없는 카드).
// 분이 없는 곳끼리를 한 덩어리 동점으로 보면 안 된다 — 프로덕션은 거의 모든 카드가 분이 없어서, 그러면
// '혼잡' 인 사진 카드가 '여유' 인 사진 없는 카드를 앞질렀다(리뷰 지적, 2026-09-29).
//
// 비교 함수(sort comparator)로 만들지 않는다: '같은 말끼리만 사진 우선, 다른 말끼리는 원래 순서' 는 추이적이지
// 않아서(A~B, B~C 인데 A>C) 정렬 결과가 엔진마다 달라질 수 있다. 대신 ① 대기(분)로 안정 정렬한 뒤
// ② **바로 붙어 있는** 같은 말 카드 묶음 안에서만 사진 있는 곳을 앞으로 모은다(안정). 그래서 어떤 카드도
// 다른 말을 하는 카드를 건너뛰지 않는다 — 사진 카드는 자기와 같은 대기를 보여 주는 이웃만 앞지른다.

import { congestionKey, DEFAULT_BUSY_THRESHOLD, type CongestionKey } from '@/lib/congestionScale';
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
 * 관광 상대지수)을, 그것도 없으면 'unavailable'(화면은 머리줄을 세우지 않는다). 주변 주차·관광 상대지수를 '대기 N분'으로 바꾸지 않는다.
 * busyAt: 운영자 '혼잡' 경계(useBusyThreshold) — 지도·대안·코스와 같은 눈금으로 등급을 매긴다.
 */
export function waitHeadlineOf(
  est: WaitEstimate,
  ev: WaitHeadlineEvidence,
  busyAt: number = DEFAULT_BUSY_THRESHOLD,
): WaitHeadline {
  if (est.minutes !== null) {
    if (est.minutes > 0) return { kind: 'minutes', n: est.minutes };
    // '대기 없음'은 검증 예측(server)에만 — 추정으로 0분을 단언하지 않는다.
    return est.basis === 'server' ? { kind: 'noWait' } : { kind: 'relaxed' };
  }
  if (est.basis === 'estimate' && typeof ev.estimateLevel === 'number') {
    return { kind: 'estimate', level: congestionKey(ev.estimateLevel, busyAt) };
  }
  if (est.basis === 'area' && typeof ev.areaDemandLevel === 'number') {
    return { kind: 'area', level: congestionKey(ev.areaDemandLevel, busyAt) };
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

const CALM_RANK: Record<CongestionKey, number> = { quiet: 0, relaxed: 1, moderate: 2, busy: 3 };

/**
 * 분이 없는 카드의 차례(작을수록 앞) — 한산 → 여유 → 보통 → 혼잡 → 관광 인기도 → 근거 없음.
 * PM 결정(2026-10-06 4.20): 예전에는 분이 없는 카드끼리 서버 순서 그대로라 '혼잡' 카드가 '여유' 카드보다
 * 대표 3장에 먼저 올랐다. 관광 인기도는 장소마다 자기 최고치 기준이라 등급과 견줄 수 없어 등급 뒤에 둔다.
 */
export function calmRankOf(headlineKey: string): number {
  const [kind, value] = headlineKey.split(':');
  if ((kind === 'estimate' || kind === 'area') && value in CALM_RANK) return CALM_RANK[value as CongestionKey];
  if (kind === 'tourism') return 4;
  return 5;
}

/** 분 짧은 순, 둘 다 분이 없으면 한산한 등급 순. 그 밖의 동점은 0(원래 순서). */
function compareBoardKeys(a: BoardOrderKey, b: BoardOrderKey): number {
  const byWait = compareWaitMinutes(a.wait, b.wait);
  if (byWait !== 0) return byWait;
  if (a.wait.minutes === null && b.wait.minutes === null) return calmRankOf(a.headlineKey) - calmRankOf(b.headlineKey);
  return 0;
}

/**
 * 대기 짧은 순(분이 없는 곳은 뒤, 그 안은 한산한 등급 순, 같은 등급은 원래 순서)으로 세운 뒤, 바로 붙어 있는
 * 같은 대기 한 줄 묶음 안에서만 사진 있는 곳을 앞으로 모은다. 입력 배열은 건드리지 않는다. 같은 입력이면 같은 결과(결정적).
 */
export function orderByWaitThenPhoto<T>(rows: readonly T[], keyOf: (row: T) => BoardOrderKey): T[] {
  const keyed = rows.map((row) => ({ row, key: keyOf(row) }));
  // Array.prototype.sort 는 안정 정렬 — 같은 분·같은 등급끼리는 원래 순서.
  keyed.sort((a, b) => compareBoardKeys(a.key, b.key));
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

/** 카드끼리 이보다 덜 차이 나면 같은 붐빔으로 본다 — 백엔드 area_demand_decision_service._DISTINGUISHABLE_SPREAD 와 같은 값. */
export const UNIFORM_CROWD_SPREAD = 0.08;

/**
 * 이만큼(80%) 넘는 카드가 같은 등급이면 보드를 한 등급으로 본다(리뷰 10-07). 예전에는 '모두 같은 등급' 일 때만이라
 * 새벽 보드 24장 중 23장이 '추정 혼잡: 보통' 이고 한 곳만 '여유' 여도 한 장 때문에 23번을 그대로 되풀이했다.
 */
export const UNIFORM_CROWD_MAJORITY = 0.8;

export interface BoardCrowdSpread {
  /** 분이 없는 카드들이 사실상 같은 붐빔을 말하는가. */
  uniform: boolean;
  /** uniform 일 때 그 한 등급(가운데값의 등급). 아니면 null. */
  grade: CongestionKey | null;
}

/** 가운데값(중앙값). 빈 배열은 null. 이 일대 '지금' 등급을 말하는 모든 화면이 같은 규칙을 쓴다(lib/areaNow.ts). */
export function medianLevel(levels: readonly number[]): number | null {
  const known = levels.filter((l) => Number.isFinite(l)).slice().sort((a, b) => a - b);
  if (known.length === 0) return null;
  const mid = Math.floor(known.length / 2);
  return known.length % 2 ? known[mid] : (known[mid - 1] + known[mid]) / 2;
}

/**
 * 보드가 한 등급인가(2026-10-06 감사 I03). 추정·주변 수요는 공영주차 몇 곳으로 만든 권역 값이라 낮에는 보드 전체가
 * '혼잡', 밤에는 '보통' 한 가지가 되기 쉽다 — 그때 카드마다 '추정 혼잡: 혼잡' 을 23번 쓰지 않고 이 일대 등급을 한 번만
 * 말한다. 3곳 이상이고, 다음 중 하나일 때:
 *   · 카드의 80% 이상이 같은 등급(그 등급이 한 줄 — 나머지는 자기 등급을 카드에 남긴다, boardCrowdMembers),
 *   · 가장 큰 값과 작은 값의 차이가 UNIFORM_CROWD_SPREAD 미만(경계를 걸친 같은 붐빔 — 모든 카드가 한 줄을 따른다).
 * 한 줄의 등급은 가운데값의 등급이다 — 과반이 한 등급 안에 있으면 가운데값도 그 안에 있어서 다수 등급과 같다.
 * 보드 순서와 무관하다(화면 문구만 바뀐다). 다 찬 보드에만 쓴다 — 도착 중인 섹션으로 판정하면 섹션이 올 때마다 뒤집힌다.
 * busyAt: 운영자 '혼잡' 경계 — 카드 머리줄(waitHeadlineOf)·대안 화면의 알약·칩과 같은 눈금이어야 한 줄과 카드가 같은 말을 한다.
 */
export function boardCrowdSpread(
  levels: readonly number[],
  busyAt: number = DEFAULT_BUSY_THRESHOLD,
): BoardCrowdSpread {
  const known = levels.filter((l) => Number.isFinite(l));
  if (known.length < 3) return { uniform: false, grade: null };
  const min = Math.min(...known);
  const max = Math.max(...known);
  const counts = new Map<CongestionKey, number>();
  for (const l of known) {
    const key = congestionKey(l, busyAt);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = Math.max(...counts.values());
  const majority = top / known.length >= UNIFORM_CROWD_MAJORITY;
  if (!majority && max - min >= UNIFORM_CROWD_SPREAD) return { uniform: false, grade: null };
  return { uniform: true, grade: congestionKey(medianLevel(known) as number, busyAt) };
}

/**
 * 한 줄이 대신 말해 주는 카드인가 — levels 와 같은 순서의 참/거짓. 한 등급 보드가 아니면 모두 거짓.
 * 차이가 아주 작은 보드(UNIFORM_CROWD_SPREAD 미만)는 모든 카드가, 다수결 보드는 그 등급의 카드만 한 줄을 따른다 —
 * 다른 등급의 카드(예: 23장 '보통' 사이의 '여유' 한 장)는 자기 등급을 그대로 보여 준다. 그 칩이 곧 '여기는 덜 붐벼요' 다.
 */
export function boardCrowdMembers(
  levels: readonly number[],
  busyAt: number = DEFAULT_BUSY_THRESHOLD,
): boolean[] {
  const spread = boardCrowdSpread(levels, busyAt);
  if (!spread.uniform) return levels.map(() => false);
  const known = levels.filter((l) => Number.isFinite(l));
  const tight = Math.max(...known) - Math.min(...known) < UNIFORM_CROWD_SPREAD;
  return levels.map((l) => Number.isFinite(l) && (tight || congestionKey(l, busyAt) === spread.grade));
}
