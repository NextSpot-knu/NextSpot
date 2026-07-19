'use client';

import { useState } from 'react';
import { BarChart3, Sparkles, X } from 'lucide-react';
import { explainRecommendation, type RecommendationQuestion, type RecommendationResponse } from '@/lib/api-client';
import { track } from '@/lib/analytics';
import { useT } from '@/lib/i18n/I18nProvider';

export default function RecommendationComparison({ recommendations }: { recommendations: RecommendationResponse[] }) {
  const t = useT();
  const top = recommendations.slice(0, 3);
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<{ text: string; labels: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  if (top.length < 2 || top.some((item) => item.recommendationId.startsWith('mock-'))) return null;

  const ask = async (question: RecommendationQuestion) => {
    setBusy(true);
    try {
      const comparisonIds = question === 'difference' ? [top[1].recommendationId] : [];
      const result = await explainRecommendation(top[0].recommendationId, question, comparisonIds);
      setAnswer({ text: result.answer, labels: result.sourceLabels });
      track('recommendation_explained', { question, llm_status: result.llmStatus });
    } catch {
      setAnswer({ text: t('compare.explainFailed'), labels: [] });
    } finally { setBusy(false); }
  };

  if (!open) return (
    <button type="button" onClick={() => { setOpen(true); track('recommendation_compared', { count: top.length }); }} className="w-full mb-3 rounded-xl border border-gold/30 bg-gold/10 py-3 text-sm font-bold text-gold-deep flex items-center justify-center gap-2"><BarChart3 size={16} />{t('compare.open')}</button>
  );
  return (
    <section className="mb-4 rounded-2xl border border-line bg-white p-4 overflow-hidden">
      <div className="flex items-center justify-between mb-3"><h3 className="font-bold text-muk">{t('compare.title')}</h3><button type="button" onClick={() => setOpen(false)} aria-label={t('common.close')}><X size={17} /></button></div>
      <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-xs text-center"><thead><tr><th className="text-left py-2">{t('compare.metric')}</th>{top.map((item) => <th key={item.recommendationId} className="px-2">{item.rank}. {item.facility.name}</th>)}</tr></thead><tbody className="divide-y divide-line">
        <Row label={t('compare.spot')} values={top.map((r) => `${Math.round(r.spotScore * 100)}`)} />
        <Row label={t('compare.preference')} values={top.map((r) => `${Math.round((r.breakdown.preference ?? 0) * 100)}%`)} />
        <Row label={t('compare.walkWait')} values={top.map((r) => `${Math.round(r.breakdown.travelTime)}m · ${Math.round(r.breakdown.waitTime)}m`)} />
        <Row label={t('compare.congestion')} values={top.map((r) => r.congestionLevel == null ? t('card.noData') : `${Math.round(r.congestionLevel * 100)}%`)} />
        <Row label={t('compare.openStatus')} values={top.map((r) => r.openStatusAtArrival ? t(`card.arrivalStatus.${r.openStatusAtArrival}`) : t('card.noData'))} />
        <Row label={t('compare.coupon')} values={top.map((r) => r.facility.couponRate ? `${Math.round(r.facility.couponRate * 100)}%` : '—')} />
      </tbody></table></div>
      <div className="flex flex-wrap gap-2 mt-4">{(['why_first', 'difference', 'family_check'] as const).map((q) => <button key={q} type="button" disabled={busy} onClick={() => void ask(q)} className="rounded-full border border-jade/30 bg-jade/10 px-3 py-1.5 text-xs font-bold text-jade"><Sparkles size={12} className="inline mr-1" />{t(`compare.question.${q}`)}</button>)}</div>
      {answer && <div className="mt-3 rounded-xl bg-hanji-deep p-3"><p className="text-xs leading-relaxed text-muk">{answer.text}</p><div className="mt-2 flex flex-wrap gap-1">{answer.labels.map((label) => <span key={label} className="rounded bg-white px-1.5 py-0.5 text-[9px] text-muk-soft">{label}</span>)}</div></div>}
    </section>
  );
}

function Row({ label, values }: { label: string; values: string[] }) { return <tr><th className="text-left py-2 font-semibold text-muk-soft">{label}</th>{values.map((value, index) => <td key={`${label}-${index}`} className="px-2 py-2 font-semibold text-muk">{value}</td>)}</tr>; }
