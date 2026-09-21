'use client';

import { confusionCellKind, GRADE_LABELS } from '@/lib/engineValidation';

const CELL_STYLE = {
  match: 'bg-emerald-500/15 text-emerald-200 font-bold',
  near: 'text-hanok-ink',
  far: 'text-hanok-muted',
  danger: 'bg-rose-500/15 text-rose-200 font-bold',
} as const;

/** 행 = 서울 실측 등급, 열 = NextSpot 추정 등급. 대각선 = 일치, 붐빔→여유·보통 = 위험 오분류. */
export function ConfusionTable({ matrix, total }: { matrix: number[][]; total: number }) {
  const labels = GRADE_LABELS;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <caption className="text-left text-xs text-hanok-muted pb-3">
          행 = 서울 실측 등급 · 열 = NextSpot 추정 등급 · 표본 {total}개 버킷. 초록 = 일치, 빨강 = 위험 오분류(실측 붐빔을 여유·보통으로 표시).
        </caption>
        <thead>
          <tr className="text-hanok-muted text-xs">
            <th className="p-2 text-left font-semibold">실측 \ 추정</th>
            {labels.map((label) => (
              <th key={label} className="p-2 text-right font-semibold">{label}</th>
            ))}
            <th className="p-2 text-right font-semibold">합계</th>
          </tr>
        </thead>
        <tbody>
          {labels.map((rowLabel, actual) => {
            const row = matrix[actual] ?? [0, 0, 0, 0];
            const rowTotal = row.reduce((sum, n) => sum + n, 0);
            return (
              <tr key={rowLabel} className="border-t border-hanok-line">
                <th scope="row" className="p-2 text-left font-semibold text-hanok-ink">{rowLabel}</th>
                {labels.map((colLabel, estimate) => {
                  const count = row[estimate] ?? 0;
                  const kind = confusionCellKind(actual, estimate);
                  return (
                    <td
                      key={colLabel}
                      className={`p-2 text-right tabular-nums rounded ${count > 0 || kind === 'match' ? CELL_STYLE[kind] : 'text-hanok-muted/60'}`}
                    >
                      {count}
                    </td>
                  );
                })}
                <td className="p-2 text-right tabular-nums text-hanok-muted">{rowTotal}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
