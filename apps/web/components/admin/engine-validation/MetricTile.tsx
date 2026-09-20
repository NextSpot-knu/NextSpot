'use client';

import { CheckCircle2, XCircle, Hourglass, FileText, MinusCircle } from 'lucide-react';
import {
  formatMetricValue, formatSample, formatThreshold, statusLabel,
  type MetricStatus, type OmittedMetric, type ValidationMetric,
} from '@/lib/engineValidation';

// 판정은 색만으로 말하지 않는다 — 아이콘 + 글자 + 색을 함께 쓴다.
const STATUS_STYLE: Record<MetricStatus, { badge: string; Icon: typeof CheckCircle2 }> = {
  pass: { badge: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', Icon: CheckCircle2 },
  fail: { badge: 'bg-rose-500/10 text-rose-300 border-rose-500/30', Icon: XCircle },
  insufficient: { badge: 'bg-hanok-card text-hanok-muted border-hanok-line', Icon: Hourglass },
  report: { badge: 'bg-sky-500/10 text-sky-300 border-sky-500/30', Icon: FileText },
};

export function MetricTile({ metric }: { metric: ValidationMetric }) {
  const style = STATUS_STYLE[metric.status] ?? STATUS_STYLE.insufficient;
  const { Icon } = style;
  const muted = metric.status === 'insufficient';
  return (
    <div className="bg-hanok-panel p-5 rounded-2xl border border-hanok-line shadow-sm flex flex-col gap-3 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-bold text-hanok-ink leading-snug">{metric.label}</h4>
        <span className={`flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold border ${style.badge}`}>
          <Icon size={12} />
          {statusLabel(metric.status)}
        </span>
      </div>
      <p className={`text-3xl font-black tabular-nums ${muted ? 'text-hanok-muted' : 'text-hanok-ink'}`}>
        {formatMetricValue(metric)}
      </p>
      <dl className="text-xs text-hanok-muted space-y-1">
        <div className="flex justify-between gap-2">
          <dt>기준</dt>
          <dd className="text-hanok-ink font-semibold text-right">{formatThreshold(metric)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>표본</dt>
          <dd className="text-hanok-ink font-semibold tabular-nums text-right">{formatSample(metric)}</dd>
        </div>
        {metric.key === 'seoul_forecast_mae_30m' && typeof metric.ours_mae_same_sample === 'number' && (
          <div className="flex justify-between gap-2">
            <dt>같은 표본의 우리 MAE</dt>
            <dd className="text-hanok-ink font-semibold tabular-nums">{metric.ours_mae_same_sample.toFixed(3)}</dd>
          </div>
        )}
      </dl>
      {metric.reason && <p className="text-xs text-hanok-muted/90 leading-relaxed">{metric.reason}</p>}
      <p className="text-[11px] text-hanok-muted/70 leading-relaxed mt-auto">{metric.definition}</p>
    </div>
  );
}

/** 계산할 수 없어 뺀 지표 — 0 이나 빈칸이 아니라 '왜 없는지' 를 보여 준다. */
export function OmittedMetricTile({ item }: { item: OmittedMetric }) {
  return (
    <div className="bg-hanok-panel/60 p-5 rounded-2xl border border-dashed border-hanok-line flex flex-col gap-3 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-bold text-hanok-muted leading-snug">{item.label}</h4>
        <span className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold border bg-hanok-card text-hanok-muted border-hanok-line">
          <MinusCircle size={12} />
          계산 불가
        </span>
      </div>
      <p className="text-3xl font-black text-hanok-muted">—</p>
      <p className="text-xs text-hanok-muted leading-relaxed">{item.reason}</p>
    </div>
  );
}
