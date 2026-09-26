import { displayWalkingMinutes } from './recommender';

export interface SpotComparisonCandidate {
  id: string;
  rank: number;
  preference: number;
  /** 보행 이동 분(보행망 경로 또는 직선거리 추정) — 카드가 '도보 N분' 으로 보여주는 바로 그 값. */
  travelMinutes: number;
  /** 도착시점 혼잡에서 나온 대기 분(순위에 실제로 쓴 값). 사용자에게 분 단위로 말하지 않는다. */
  rankingWaitMinutes?: number | null;
  /** 주변 수요(주차·관광 통계)를 분 환산한 순위 가중. 실제 걸리는 시간이 아니다. */
  areaDemandPenaltyMinutes?: number | null;
  /** 제휴 할인율(0.10 = 10%). 시설에 걸린 실제 쿠폰일 때만 문구로 말한다. */
  couponRate?: number | null;
}

export interface SpotComparison {
  id: string;
  rank: number;
  preferencePercent: number;
  /** 카드의 '도보 N분' 과 같은 규칙(1분 이상 올림)으로 만든 정수 분. */
  walkMinutes: number;
  /** 대기 + 주변 수요 가중(분 환산). 줄·붐빔 비교에만 쓰고 숫자로는 말하지 않는다. */
  crowdCostMinutes: number;
  couponPercent: number;
  preferenceDeltaPoints: number;
  walkDeltaMinutes: number;
  crowdCostDeltaMinutes: number;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 순위순 Top 3의 관광객이 체감하는 차이(취향·도보·줄과 붐빔·할인)만 1위 대비로 계산한다. */
export function buildSpotComparisons(candidates: SpotComparisonCandidate[]): SpotComparison[] {
  const top = candidates.slice(0, 3).map((candidate, index) => ({
    id: candidate.id,
    rank: finite(candidate.rank, index + 1),
    preferencePercent: Math.round(Math.max(0, Math.min(1, finite(candidate.preference))) * 100),
    walkMinutes: displayWalkingMinutes(finite(candidate.travelMinutes)),
    crowdCostMinutes: Math.max(0,
      finite(candidate.rankingWaitMinutes) + finite(candidate.areaDemandPenaltyMinutes),
    ),
    couponPercent: Math.round(Math.max(0, Math.min(1, finite(candidate.couponRate))) * 100),
  }));
  if (top.length === 0) return [];
  const first = top[0];
  return top.map((candidate) => ({
    ...candidate,
    crowdCostMinutes: Math.round(candidate.crowdCostMinutes * 10) / 10,
    preferenceDeltaPoints: candidate.preferencePercent - first.preferencePercent,
    walkDeltaMinutes: candidate.walkMinutes - first.walkMinutes,
    crowdCostDeltaMinutes: Math.round((candidate.crowdCostMinutes - first.crowdCostMinutes) * 10) / 10,
  }));
}

export type SpotComparisonTranslator = (key: string, vars?: Record<string, string | number>) => string;

/** 줄·붐빔 차이를 말할 최소 폭(분 환산). 이보다 작으면 체감 차이로 말하지 않는다. */
const CROWD_DELTA_MIN = 1;

/**
 * 카드·비교 블록의 '추천 이유' 한 줄. 관광객이 체감하는 사실만 말한다(PM 2026-09-26):
 *  - 1위: 취향 일치 % · 도보 N분 · (실제 쿠폰이 있을 때만) 할인 쿠폰.
 *  - 2·3위: 1위 대비 체감 차이 — 취향 일치 %p, 도보 분, 줄·붐빔 전망, 쿠폰. 장점을 먼저, 단점도 그대로.
 * 내부 산식 용어(점수 차·가중치·순위 시간비용)는 쓰지 않는다. 주변 수요 가중은 실제로 걸리는
 * 시간이 아니므로 '분' 으로 말하지 않고 '줄·붐빔' 전망으로만 말한다.
 */
export function formatSpotComparison(t: SpotComparisonTranslator, comparison: SpotComparison): string {
  if (comparison.rank === 1) {
    const parts = [
      t('recommend.spotComparison.taste', { n: comparison.preferencePercent }),
      t('recommend.spotComparison.walk', { n: comparison.walkMinutes }),
    ];
    if (comparison.couponPercent >= 1) {
      parts.push(t('recommend.spotComparison.coupon', { n: comparison.couponPercent }));
    }
    return parts.join(' · ');
  }

  const pros: string[] = [];
  const cons: string[] = [];
  if (comparison.walkDeltaMinutes < 0) {
    pros.push(t('recommend.spotComparison.walkShorter', { n: Math.abs(comparison.walkDeltaMinutes) }));
  } else if (comparison.walkDeltaMinutes > 0) {
    cons.push(t('recommend.spotComparison.walkLonger', { n: comparison.walkDeltaMinutes }));
  }
  if (comparison.crowdCostDeltaMinutes <= -CROWD_DELTA_MIN) {
    pros.push(t('recommend.spotComparison.calmer'));
  } else if (comparison.crowdCostDeltaMinutes >= CROWD_DELTA_MIN) {
    cons.push(t('recommend.spotComparison.busier'));
  }
  if (comparison.preferenceDeltaPoints >= 1) {
    pros.push(t('recommend.spotComparison.preferenceHigher', { n: comparison.preferenceDeltaPoints }));
  } else if (comparison.preferenceDeltaPoints <= -1) {
    cons.push(t('recommend.spotComparison.preferenceLower', { n: Math.abs(comparison.preferenceDeltaPoints) }));
  }
  if (comparison.couponPercent >= 1) {
    pros.push(t('recommend.spotComparison.coupon', { n: comparison.couponPercent }));
  }
  const details = [...pros, ...cons];
  if (details.length === 0) return t('recommend.spotComparison.similar');
  return t('recommend.spotComparison.vsTop', { details: details.join(' · ') });
}
