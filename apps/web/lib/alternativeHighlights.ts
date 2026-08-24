export type AlternativeHighlightBasis =
  | 'crowd'
  | 'timing'
  | 'travel'
  | 'preference'
  | 'benefit'
  | 'menu'
  | 'overall'
  | 'balanced';

export interface AlternativeHighlightCandidate {
  id: string;
  rank: number;
  spotScore: number;
  preferencePercent: number;
  travelMinutes: number;
  couponRate?: number | null;
  cuisineLabel?: string | null;
  arrivalAction?: 'go_now' | 'wait_then_go' | 'choose_calmer' | 'no_clear_advantage';
  areaDemandDistinguishable?: boolean;
  areaDemandConfidence?: 'high' | 'medium' | 'low' | 'none';
  areaDemandRank?: number;
  areaDemandComparableCount?: number;
  recommendedDepartureDelayMinutes?: number;
}

export interface AlternativeHighlight {
  id: string;
  basis: AlternativeHighlightBasis;
  isBest?: boolean;
  rank: number;
  spotScore: number;
  preferencePercent: number;
  travelMinutes: number;
  couponRate?: number | null;
  cuisineLabel?: string | null;
  areaDemandRank?: number;
  areaDemandComparableCount?: number;
  recommendedDepartureDelayMinutes?: number;
}

interface Option {
  basis: AlternativeHighlightBasis;
  score: number;
  isBest?: boolean;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizedLabel(value: string | null | undefined): string {
  return String(value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, '');
}

/**
 * Top 3에 서로 다른 대표 역할을 하나씩 배정한다.
 *
 * 혼잡 우위는 백엔드가 비교 가능·신뢰도 조건을 통과해 choose_calmer를 준 경우에만 후보가 된다.
 * 나머지는 응답에 이미 존재하는 도보·취향·혜택·메뉴 사실만 사용한다. 같은 근거를 세 카드에
 * 반복하지 않도록 작은 완전탐색으로 서로 다른 basis 조합 중 정보 가치가 가장 높은 조합을 고른다.
 */
export function buildAlternativeHighlights(
  candidates: AlternativeHighlightCandidate[],
): AlternativeHighlight[] {
  const top = candidates.slice(0, 3).map((candidate, index) => ({
    ...candidate,
    rank: finite(candidate.rank, index + 1),
    spotScore: finite(candidate.spotScore),
    preferencePercent: finite(candidate.preferencePercent),
    travelMinutes: Math.max(1, finite(candidate.travelMinutes, 1)),
    couponRate: finite(candidate.couponRate),
  }));
  if (top.length === 0) return [];

  const travels = top.map((candidate) => candidate.travelMinutes);
  const preferences = top.map((candidate) => candidate.preferencePercent);
  const coupons = top.map((candidate) => finite(candidate.couponRate));
  const minTravel = Math.min(...travels);
  const maxTravel = Math.max(...travels);
  const maxPreference = Math.max(...preferences);
  const minPreference = Math.min(...preferences);
  const maxCoupon = Math.max(...coupons);
  const labels = top.map((candidate) => normalizedLabel(candidate.cuisineLabel));

  const options = top.map((candidate, index): Option[] => {
    const result: Option[] = [];
    const confidence = candidate.areaDemandConfidence;
    if (
      candidate.arrivalAction === 'choose_calmer'
      && candidate.areaDemandDistinguishable === true
      && (confidence === 'high' || confidence === 'medium')
      && typeof candidate.areaDemandRank === 'number'
      && typeof candidate.areaDemandComparableCount === 'number'
    ) {
      result.push({ basis: 'crowd', score: 110, isBest: true });
    }
    if (
      candidate.arrivalAction === 'wait_then_go'
      && finite(candidate.recommendedDepartureDelayMinutes) > 0
      && (confidence === 'high' || confidence === 'medium')
    ) {
      result.push({ basis: 'timing', score: 105, isBest: true });
    }
    const isFastest = candidate.travelMinutes === minTravel;
    result.push({
      basis: 'travel',
      score: isFastest && maxTravel - minTravel >= 1 ? 90 : 42,
      isBest: isFastest && maxTravel - minTravel >= 1,
    });
    const isPreferenceBest = candidate.preferencePercent === maxPreference;
    result.push({
      basis: 'preference',
      score: isPreferenceBest && maxPreference - minPreference >= 5 ? 84 : 38,
      isBest: isPreferenceBest && maxPreference - minPreference >= 5,
    });
    const coupon = coupons[index];
    if (coupon > 0) {
      result.push({
        basis: 'benefit',
        score: coupon === maxCoupon ? 80 : 34,
        isBest: coupon === maxCoupon,
      });
    }
    if (labels[index] && labels.filter((label) => label === labels[index]).length === 1) {
      result.push({ basis: 'menu', score: 64, isBest: true });
    }
    if (candidate.rank === 1) result.push({ basis: 'overall', score: 60, isBest: true });
    result.push({ basis: 'balanced', score: 5 });
    return result;
  });

  let best: Option[] | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  const search = (index: number, selected: Option[], used: Set<AlternativeHighlightBasis>, score: number) => {
    if (index === top.length) {
      if (score > bestScore) {
        bestScore = score;
        best = [...selected];
      }
      return;
    }
    for (const option of options[index]) {
      if (used.has(option.basis)) continue;
      used.add(option.basis);
      selected.push(option);
      search(index + 1, selected, used, score + option.score);
      selected.pop();
      used.delete(option.basis);
    }
  };
  search(0, [], new Set(), 0);

  const selectedOptions: Option[] = best ?? top.map(() => ({ basis: 'balanced', score: 0 }));
  return top.map((candidate, index) => ({
    id: candidate.id,
    basis: selectedOptions[index].basis,
    isBest: selectedOptions[index].isBest,
    rank: candidate.rank,
    spotScore: candidate.spotScore,
    preferencePercent: candidate.preferencePercent,
    travelMinutes: candidate.travelMinutes,
    couponRate: candidate.couponRate,
    cuisineLabel: candidate.cuisineLabel,
    areaDemandRank: candidate.areaDemandRank,
    areaDemandComparableCount: candidate.areaDemandComparableCount,
    recommendedDepartureDelayMinutes: candidate.recommendedDepartureDelayMinutes,
  }));
}

export type HighlightTranslator = (key: string, vars?: Record<string, string | number>) => string;

export function formatAlternativeHighlight(
  t: HighlightTranslator,
  highlight: AlternativeHighlight,
): string {
  switch (highlight.basis) {
    case 'crowd':
      return t('recommend.highlight.crowd', {
        rank: highlight.areaDemandRank ?? '-',
        total: highlight.areaDemandComparableCount ?? '-',
      });
    case 'timing':
      return t('recommend.highlight.timing', {
        n: highlight.recommendedDepartureDelayMinutes ?? 0,
      });
    case 'travel':
      return t(highlight.isBest ? 'recommend.highlight.travelBest' : 'recommend.highlight.travel', {
        n: Math.max(1, Math.ceil(highlight.travelMinutes)),
      });
    case 'preference':
      return t(highlight.isBest ? 'recommend.highlight.preferenceBest' : 'recommend.highlight.preference', {
        n: Math.round(highlight.preferencePercent),
      });
    case 'benefit':
      return t(highlight.isBest ? 'recommend.highlight.benefitBest' : 'recommend.highlight.benefit', {
        n: Math.round(finite(highlight.couponRate) * 100),
      });
    case 'menu':
      return t('recommend.highlight.menu', { menu: highlight.cuisineLabel ?? t('recommend.highlight.menuUnknown') });
    case 'overall':
      return t('recommend.highlight.overall', { n: Math.round(highlight.spotScore) });
    default:
      return t('recommend.highlight.balanced', {
        preference: Math.round(highlight.preferencePercent),
        travel: Math.max(1, Math.ceil(highlight.travelMinutes)),
      });
  }
}

export function extractAlternativeCuisineLabel(features?: Record<string, unknown> | null): string | null {
  if (!features) return null;
  const raw = features.firstMenu ?? features.first_menu ?? features.cuisineTags
    ?? features.cuisine_tags ?? features.cuisine ?? features.category;
  const values = Array.isArray(raw) ? raw : [raw];
  for (const value of values) {
    const token = String(value ?? '').split(/[,/·>]/)[0]?.trim();
    if (token && !['카페', '음식점', '식당', '관광지', '문화시설'].includes(token)) return token;
  }
  return null;
}
