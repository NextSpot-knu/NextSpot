import { displayWalkingMinutes, type ScoringMode } from './recommender';

export interface SpotComparisonCandidate {
  id: string;
  rank: number;
  preference: number;
  /** 보행 이동 분(보행망 경로 또는 직선거리 추정) — 카드가 '도보 N분' 으로 보여주는 바로 그 값. */
  travelMinutes: number;
  /**
   * 이 순위를 만든 근거의 종류(서버 scoring_mode 그대로). 줄·붐빔 비교를 **말해도 되는지** 가
   * 여기에 달려 있다 — 근거가 없는 후보(degraded_rules)는 대기·주변 수요가 '0' 으로 들어와서
   * 숫자만 보면 늘 한산해 보인다. 모르면(undefined) 비교하지 않는다.
   */
  scoringMode?: ScoringMode | null;
  /** 도착시점 혼잡(실측·예측)에서 나온 대기 분(순위에 실제로 쓴 값). 사용자에게 분 단위로 말하지 않는다. */
  rankingWaitMinutes?: number | null;
  /** 주변 수요(주차·관광 통계)를 분 환산한 순위 가중. 실제 걸리는 시간이 아니다. */
  areaDemandPenaltyMinutes?: number | null;
  /** 제휴 할인율(0.10 = 10%). 시설에 걸린 실제 쿠폰일 때만 문구로 말한다. */
  couponRate?: number | null;
}

/**
 * 줄·붐빔 비교에 쓸 수 있는 근거의 종류.
 *  - venue: 그 장소 자체의 도착시점 혼잡(실측 measured_rules · 예측 model)에서 나온 대기 전망 → '줄·붐빔'.
 *  - area:  그 장소 **주변**의 수요(공영주차·관광 통계·행사)뿐(area_stats_rules) → '주변 붐빔'.
 * 근거가 없거나(degraded_rules) 모르면 null — 줄·붐빔을 말하지 않는다.
 * 종류가 다른 두 곳은 서로 비교하지 않는다 — 한쪽 숫자가 '근거 없음 = 0' 이거나 다른 대상을 잰 값이다.
 */
export type SpotCrowdEvidence = 'venue' | 'area';

export interface SpotComparison {
  id: string;
  rank: number;
  preferencePercent: number;
  /** 카드의 '도보 N분' 과 같은 규칙(1분 이상 올림)으로 만든 정수 분. */
  walkMinutes: number;
  /** 줄·붐빔 비교의 근거 종류. null 이면 이 장소는 줄·붐빔을 비교하지 않는다. */
  crowdEvidence: SpotCrowdEvidence | null;
  /** 근거 종류에 맞는 순위 입력(분 환산). 비교 방향에만 쓰고 숫자로는 말하지 않는다. */
  crowdCostMinutes: number | null;
  couponPercent: number;
  preferenceDeltaPoints: number;
  walkDeltaMinutes: number;
  /** 1위와 근거 종류가 같을 때만 값이 있다. 다르면 null — 줄·붐빔 문구를 만들지 않는다. */
  crowdCostDeltaMinutes: number | null;
  /** 1위 쿠폰 대비 %p. 양수면 이 장소 쿠폰이 더 크다. */
  couponDeltaPercent: number;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function crowdEvidenceOf(candidate: SpotComparisonCandidate): {
  kind: SpotCrowdEvidence | null;
  minutes: number | null;
} {
  const mode = candidate.scoringMode;
  if ((mode === 'model' || mode === 'measured_rules') && isFiniteNumber(candidate.rankingWaitMinutes)) {
    // model 의 주차 가중은 섞지 않는다 — 여기서는 그 장소 자체의 줄·붐빔 전망만 비교한다.
    return { kind: 'venue', minutes: Math.max(0, candidate.rankingWaitMinutes) };
  }
  if (mode === 'area_stats_rules' && isFiniteNumber(candidate.areaDemandPenaltyMinutes)) {
    return { kind: 'area', minutes: Math.max(0, candidate.areaDemandPenaltyMinutes) };
  }
  return { kind: null, minutes: null };
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** 순위순 Top 3의 관광객이 체감하는 차이(취향·도보·줄과 붐빔·할인)만 1위 대비로 계산한다. */
export function buildSpotComparisons(candidates: SpotComparisonCandidate[]): SpotComparison[] {
  const top = candidates.slice(0, 3).map((candidate, index) => {
    const crowd = crowdEvidenceOf(candidate);
    return {
      id: candidate.id,
      rank: finite(candidate.rank, index + 1),
      preferencePercent: Math.round(Math.max(0, Math.min(1, finite(candidate.preference))) * 100),
      walkMinutes: displayWalkingMinutes(finite(candidate.travelMinutes)),
      crowdEvidence: crowd.kind,
      crowdCostMinutes: crowd.minutes,
      couponPercent: Math.round(Math.max(0, Math.min(1, finite(candidate.couponRate))) * 100),
    };
  });
  if (top.length === 0) return [];
  const first = top[0];
  return top.map((candidate) => {
    const sameEvidence = candidate.crowdEvidence !== null && candidate.crowdEvidence === first.crowdEvidence;
    return {
      ...candidate,
      crowdCostMinutes: candidate.crowdCostMinutes === null ? null : round1(candidate.crowdCostMinutes),
      preferenceDeltaPoints: candidate.preferencePercent - first.preferencePercent,
      walkDeltaMinutes: candidate.walkMinutes - first.walkMinutes,
      crowdCostDeltaMinutes: sameEvidence && candidate.crowdCostMinutes !== null && first.crowdCostMinutes !== null
        ? round1(candidate.crowdCostMinutes - first.crowdCostMinutes)
        : null,
      couponDeltaPercent: candidate.couponPercent - first.couponPercent,
    };
  });
}

export type SpotComparisonTranslator = (key: string, vars?: Record<string, string | number>) => string;

/** 줄·붐빔 차이를 말할 최소 폭(분 환산). 이보다 작으면 체감 차이로 말하지 않는다. */
const CROWD_DELTA_MIN = 1;

/**
 * 카드·비교 블록의 '추천 이유' 한 줄. 관광객이 체감하는 사실만 말한다(PM 2026-09-26):
 *  - 1위: 취향 일치 % · 도보 N분 · (실제 쿠폰이 있을 때만) 할인 쿠폰.
 *  - 2·3위: 1위 대비 체감 차이 — 취향 일치 %p, 도보 분, 줄·붐빔 전망, 할인. 장점을 먼저, 단점도 그대로.
 * 내부 산식 용어(점수 차·가중치·순위 시간비용)는 쓰지 않는다.
 *
 * 줄·붐빔은 **1위와 같은 종류의 근거가 있을 때만** 말한다(crowdCostDeltaMinutes 가 null 이 아닐 때).
 * 그 장소 자체의 혼잡 전망이면 '줄·붐빔', 주변 수요만 있으면 '주변 붐빔' 이라고 말한다 — 주변 수요는
 * 매장 앞 줄을 잰 값이 아니다. 근거가 없는 곳은 숫자가 0 이어도 '덜 붐빈다' 고 하지 않는다.
 *
 * 쿠폰은 1위보다 클 때만 '베스트 추천 대비' 장점이다. 1위보다 크지 않은 쿠폰은 그 문장 **앞에**
 * 이 장소의 사실로만 적고, 1위보다 작으면 단점(할인 혜택 적음)으로도 적는다.
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
  const crowdDelta = comparison.crowdCostDeltaMinutes;
  if (crowdDelta !== null) {
    const nearby = comparison.crowdEvidence === 'area';
    if (crowdDelta <= -CROWD_DELTA_MIN) {
      pros.push(t(nearby ? 'recommend.spotComparison.calmerNearby' : 'recommend.spotComparison.calmer'));
    } else if (crowdDelta >= CROWD_DELTA_MIN) {
      cons.push(t(nearby ? 'recommend.spotComparison.busierNearby' : 'recommend.spotComparison.busier'));
    }
  }
  if (comparison.preferenceDeltaPoints >= 1) {
    pros.push(t('recommend.spotComparison.preferenceHigher', { n: comparison.preferenceDeltaPoints }));
  } else if (comparison.preferenceDeltaPoints <= -1) {
    cons.push(t('recommend.spotComparison.preferenceLower', { n: Math.abs(comparison.preferenceDeltaPoints) }));
  }
  const couponIsAdvantage = comparison.couponPercent >= 1 && comparison.couponDeltaPercent >= 1;
  if (couponIsAdvantage) {
    pros.push(t('recommend.spotComparison.coupon', { n: comparison.couponPercent }));
  } else if (comparison.couponDeltaPercent <= -1) {
    cons.push(t('recommend.spotComparison.couponLower'));
  }
  const details = [...pros, ...cons];
  const versusTop = details.length === 0
    ? t('recommend.spotComparison.similar')
    : t('recommend.spotComparison.vsTop', { details: details.join(' · ') });
  // 1위보다 크지 않은 쿠폰도 이 장소의 사실이다 — 다만 '베스트 추천 대비' 장점처럼 읽히지 않게 앞에 둔다.
  if (!couponIsAdvantage && comparison.couponPercent >= 1) {
    return `${t('recommend.spotComparison.coupon', { n: comparison.couponPercent })} · ${versusTop}`;
  }
  return versusTop;
}
