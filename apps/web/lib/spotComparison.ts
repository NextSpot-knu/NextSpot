export interface SpotComparisonCandidate {
  id: string;
  rank: number;
  spotScore: number;
  preference: number;
  travelMinutes: number;
  rankingWaitMinutes?: number | null;
  areaDemandPenaltyMinutes?: number | null;
  incentive?: number | null;
}

export interface SpotComparison {
  id: string;
  rank: number;
  scorePoints: number;
  preferencePercent: number;
  rankingTimeMinutes: number;
  incentivePercent: number;
  scoreGapPoints: number;
  preferenceDeltaPoints: number;
  rankingTimeDeltaMinutes: number;
  incentiveDeltaPoints: number;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function scorePoints(score: number): number {
  const normalized = score <= 1 ? score * 100 : score;
  return Math.round(Math.max(0, Math.min(100, normalized)));
}

/** SPOT 원점수순 Top 3의 실제 산식 입력과 1위 대비 차이만 계산한다. */
export function buildSpotComparisons(candidates: SpotComparisonCandidate[]): SpotComparison[] {
  const top = candidates.slice(0, 3).map((candidate, index) => ({
    id: candidate.id,
    rank: finite(candidate.rank, index + 1),
    scorePoints: scorePoints(finite(candidate.spotScore)),
    preferencePercent: Math.round(Math.max(0, Math.min(1, finite(candidate.preference))) * 100),
    rankingTimeMinutes: Math.max(0,
      finite(candidate.travelMinutes)
      + finite(candidate.rankingWaitMinutes)
      + finite(candidate.areaDemandPenaltyMinutes),
    ),
    incentivePercent: Math.round(Math.max(0, Math.min(1, finite(candidate.incentive))) * 100),
  }));
  if (top.length === 0) return [];
  const first = top[0];
  return top.map((candidate) => ({
    ...candidate,
    rankingTimeMinutes: Math.round(candidate.rankingTimeMinutes * 10) / 10,
    scoreGapPoints: first.scorePoints - candidate.scorePoints,
    preferenceDeltaPoints: candidate.preferencePercent - first.preferencePercent,
    rankingTimeDeltaMinutes: Math.round((candidate.rankingTimeMinutes - first.rankingTimeMinutes) * 10) / 10,
    incentiveDeltaPoints: candidate.incentivePercent - first.incentivePercent,
  }));
}

export type SpotComparisonTranslator = (key: string, vars?: Record<string, string | number>) => string;

function signedMagnitude(value: number): number {
  return Math.abs(Math.round(value));
}

/** 카드 설명을 실제 SPOT 입력값에서만 만든다. 장점이 없으면 없다고 그대로 표시한다. */
export function formatSpotComparison(t: SpotComparisonTranslator, comparison: SpotComparison): string {
  if (comparison.rank === 1) {
    return t('recommend.spotComparison.first', {
      score: comparison.scorePoints,
      preference: comparison.preferencePercent,
      time: Math.max(1, Math.ceil(comparison.rankingTimeMinutes)),
      incentive: comparison.incentivePercent,
    });
  }

  const parts: string[] = [];
  if (Math.abs(comparison.preferenceDeltaPoints) >= 1) {
    parts.push(t(
      comparison.preferenceDeltaPoints > 0
        ? 'recommend.spotComparison.preferenceHigher'
        : 'recommend.spotComparison.preferenceLower',
      { n: signedMagnitude(comparison.preferenceDeltaPoints) },
    ));
  }
  if (Math.abs(comparison.rankingTimeDeltaMinutes) >= 0.5) {
    parts.push(t(
      comparison.rankingTimeDeltaMinutes < 0
        ? 'recommend.spotComparison.timeShorter'
        : 'recommend.spotComparison.timeLonger',
      { n: Math.abs(Math.round(comparison.rankingTimeDeltaMinutes * 10) / 10) },
    ));
  }
  if (Math.abs(comparison.incentiveDeltaPoints) >= 1) {
    parts.push(t(
      comparison.incentiveDeltaPoints > 0
        ? 'recommend.spotComparison.incentiveHigher'
        : 'recommend.spotComparison.incentiveLower',
      { n: signedMagnitude(comparison.incentiveDeltaPoints) },
    ));
  }
  parts.push(t(
    comparison.scoreGapPoints > 0
      ? 'recommend.spotComparison.scoreLower'
      : 'recommend.spotComparison.scoreTied',
    { n: Math.max(0, comparison.scoreGapPoints) },
  ));
  return parts.join(' · ');
}
