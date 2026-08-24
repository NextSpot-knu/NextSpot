'use client';

import { useState } from 'react';
import { BarChart3, Sparkles, X } from 'lucide-react';
import { explainRecommendation, type RecommendationQuestion, type RecommendationResponse } from '@/lib/api-client';
import { track } from '@/lib/analytics';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { displayWalkingMinutes } from '@/lib/recommender';
import {
  buildAlternativeHighlights,
  extractAlternativeCuisineLabel,
  formatAlternativeHighlight,
} from '@/lib/alternativeHighlights';

export default function RecommendationComparison({ recommendations }: { recommendations: RecommendationResponse[] }) {
  const { t, locale } = useI18n();
  const top = recommendations.slice(0, 3);
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<{ text: string; labels: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  if (top.length < 2) return null;

  const highlights = buildAlternativeHighlights(top.map((item, index) => ({
    id: item.recommendationId,
    rank: item.rank ?? index + 1,
    spotScore: item.spotScore <= 1 ? item.spotScore * 100 : item.spotScore,
    preferencePercent: (item.breakdown.preference ?? 0) * 100,
    travelMinutes: displayWalkingMinutes(item.breakdown.travelTime, item.distanceM),
    couponRate: Math.max(item.facility.couponRate ?? 0, item.facility.timesaleRate ?? 0),
    cuisineLabel: extractAlternativeCuisineLabel(item.facility.features),
    arrivalAction: item.breakdown.arrivalAction,
    areaDemandDistinguishable: item.breakdown.areaDemandDistinguishable,
    areaDemandConfidence: item.breakdown.areaDemandConfidence,
    areaDemandRank: item.breakdown.areaDemandRank ?? undefined,
    areaDemandComparableCount: item.breakdown.areaDemandComparableCount,
    recommendedDepartureDelayMinutes: item.breakdown.recommendedDepartureDelayMinutes ?? undefined,
  })));
  const highlightById = new Map(highlights.map((highlight) => [highlight.id, highlight]));
  const canExplain = top.every((item) => !item.recommendationId.startsWith('mock-'));

  const ask = async (question: RecommendationQuestion) => {
    setBusy(true);
    try {
      const comparisonIds = question === 'difference' ? [top[1].recommendationId] : [];
      const result = await explainRecommendation(top[0].recommendationId, question, comparisonIds, locale);
      setAnswer({ text: result.answer, labels: result.sourceLabels });
      track('recommendation_explained', { question, llm_status: result.llmStatus });
    } catch {
      setAnswer({ text: t('compare.explainFailed'), labels: [] });
      track('recommendation_explained', { question, llm_status: 'llm_failed' });
    } finally { setBusy(false); }
  };

  const highlightCards = (
    <div className="space-y-2">
      {top.map((item, index) => {
        const highlight = highlightById.get(item.recommendationId);
        if (!highlight) return null;
        return (
          <div key={item.recommendationId} className="flex items-start gap-3 rounded-xl border border-jade/15 bg-white/80 px-3 py-2.5">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-jade text-[11px] font-extrabold text-white">
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-extrabold text-muk">{item.facility.name}</p>
              <p className="mt-0.5 text-[11px] leading-snug text-muk-soft">
                {formatAlternativeHighlight(t, highlight)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );

  if (!open) return (
    <section className="mb-4 rounded-2xl border border-jade/25 bg-jade/5 p-4">
      <div className="mb-3 flex items-center gap-2">
        <BarChart3 size={16} className="text-jade" />
        <h3 className="text-sm font-extrabold text-muk">{t('recommend.highlight.title')}</h3>
      </div>
      {highlightCards}
      <p className="mt-2 text-[10px] leading-relaxed text-muk-soft">{t('recommend.highlight.honesty')}</p>
      <button type="button" onClick={() => { setOpen(true); track('recommendation_compared', { count: top.length }); }} className="toss-pressable mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-gold/30 bg-gold/10 py-2.5 text-xs font-bold text-gold-deep">
        <BarChart3 size={14} />{t('compare.open')}
      </button>
    </section>
  );
  return (
    <section className="mb-4 rounded-2xl border border-line bg-white p-4 overflow-hidden">
      <div className="flex items-center justify-between mb-3"><h3 className="font-bold text-muk">{t('compare.title')}</h3><button type="button" onClick={() => setOpen(false)} aria-label={t('common.close')}><X size={17} /></button></div>
      <div className="mb-4 rounded-xl bg-jade/5 p-3">
        <p className="mb-2 text-xs font-extrabold text-muk">{t('recommend.highlight.title')}</p>
        {highlightCards}
        <p className="mt-2 text-[10px] leading-relaxed text-muk-soft">{t('recommend.highlight.honesty')}</p>
      </div>
      <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-xs text-center"><thead><tr><th className="text-left py-2">{t('compare.metric')}</th>{top.map((item) => <th key={item.recommendationId} className="px-2">{item.rank}. {item.facility.name}</th>)}</tr></thead><tbody className="divide-y divide-line">
        <Row label={t('compare.spot')} values={top.map((r) => `${Math.round(r.spotScore * 100)}`)} />
        <Row label={t('compare.preference')} values={top.map((r) => `${Math.round((r.breakdown.preference ?? 0) * 100)}%`)} />
        <Row label={t('compare.walkWait')} values={top.map((r) =>
          r.breakdown.waitTime == null
            ? `${displayWalkingMinutes(r.breakdown.travelTime, r.distanceM)}m · ${t('card.noData')}`
            : `${displayWalkingMinutes(r.breakdown.travelTime, r.distanceM)}m · ${Math.round(r.breakdown.waitTime)}m`
        )} />
        <Row label={t('compare.congestion')} values={top.map((r) => r.congestionLevel == null ? t('card.noData') : `${Math.round(r.congestionLevel * 100)}%`)} />
        <Row label={t('compare.openStatus')} values={top.map((r) => r.openStatusAtArrival ? t(`card.arrivalStatus.${r.openStatusAtArrival}`) : t('card.noData'))} />
        <Row label={t('compare.coupon')} values={top.map((r) => r.facility.couponRate ? `${Math.round(r.facility.couponRate * 100)}%` : '—')} />
      </tbody></table></div>
      {canExplain && <div className="flex flex-wrap gap-2 mt-4">{(['why_first', 'difference', 'family_check'] as const).map((q) => <button key={q} type="button" disabled={busy} onClick={() => void ask(q)} className="rounded-full border border-jade/30 bg-jade/10 px-3 py-1.5 text-xs font-bold text-jade"><Sparkles size={12} className="inline mr-1" />{t(`compare.question.${q}`)}</button>)}</div>}
      {answer && <div className="mt-3 rounded-xl bg-hanji-deep p-3"><p className="text-xs leading-relaxed text-muk">{answer.text}</p><div className="mt-2 flex flex-wrap gap-1">{answer.labels.map((label) => <span key={label} className="rounded bg-white px-1.5 py-0.5 text-[9px] text-muk-soft">{label}</span>)}</div></div>}
    </section>
  );
}

function Row({ label, values }: { label: string; values: string[] }) { return <tr><th className="text-left py-2 font-semibold text-muk-soft">{label}</th>{values.map((value, index) => <td key={`${label}-${index}`} className="px-2 py-2 font-semibold text-muk">{value}</td>)}</tr>; }
