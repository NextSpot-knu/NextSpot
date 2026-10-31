'use client';

// 실시간 데이터 리허설 — 서울 수집 파이프라인을 **있는 그대로** 보여 주는 블록.
//
// 대상지마다 주기·마지막 버킷·나이·채움률(분모 = 그 대상지의 차례였던 버킷)·호출 예산을 한 줄로 두고,
// 정규화 표(zone_crowd_snapshots)와 결정 품질(S4)은 각자의 상태로 말한다. 판정은 서버가 하고(seoul_collection_status.py)
// 문장은 lib/rehearsalStatus.ts 가 만든다 — 이 컴포넌트는 그리기만 한다.

import { Activity, AlertCircle, AlertTriangle, CheckCircle2, Database, Info, Scale } from 'lucide-react';
import { formatKst, type StateNotice, type Tone } from '@/lib/engineValidation';
import {
  describeBudget,
  describeDecisionQuality,
  describeLastRun,
  describePipeline,
  describeZones,
  formatAgeMinutes,
  formatCadence,
  formatFillRate,
  targetBadge,
  type DecisionQuality,
  type RehearsalPipeline,
} from '@/lib/rehearsalStatus';

const TONE_BOX: Record<Tone, string> = {
  ok: 'bg-emerald-500/10 border-emerald-500/30',
  info: 'bg-hanok-card border-hanok-line',
  warn: 'bg-amber-500/10 border-amber-500/30',
  error: 'bg-rose-500/10 border-rose-500/30',
};
const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-700',
  info: 'text-hanok-ink',
  warn: 'text-amber-800',
  error: 'text-rose-700',
};
const TONE_ICON: Record<Tone, typeof Info> = { ok: CheckCircle2, info: Info, warn: AlertTriangle, error: AlertCircle };

function Notice({ notice }: { notice: StateNotice }) {
  const Icon = TONE_ICON[notice.tone];
  return (
    <div className={`flex items-start gap-3 border rounded-xl p-3 ${TONE_BOX[notice.tone]}`}>
      <Icon size={18} className={`${TONE_TEXT[notice.tone]} flex-shrink-0 mt-0.5`} />
      <div className="min-w-0">
        <p className={`font-bold text-sm ${TONE_TEXT[notice.tone]}`}>{notice.title}</p>
        <p className="text-xs text-hanok-muted mt-1 break-words">{notice.detail}</p>
      </div>
    </div>
  );
}

const CELL = 'px-2 py-2 whitespace-nowrap min-w-[3.5rem] text-left align-top';

export function RehearsalStatusPanel({
  pipeline,
  windowDays,
}: {
  pipeline: RehearsalPipeline | null;
  windowDays: number;
}) {
  if (!pipeline) {
    return (
      <section className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm">
        <h3 className="text-lg font-bold text-hanok-ink flex items-center gap-2">
          <Activity size={18} className="text-gold-deep" /> 수집 상태
        </h3>
        <p className="text-sm text-hanok-muted mt-2">
          서버가 대상지별 수집 상태를 아직 보내지 않습니다(이전 배포). API 배포 뒤 새로고침하면 표시됩니다.
        </p>
      </section>
    );
  }
  const overall = describePipeline(pipeline);
  const lastRun = pipeline.last_run;
  return (
    <section className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm space-y-4" aria-label="수집 상태">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-bold text-hanok-ink flex items-center gap-2">
          <Activity size={18} className="text-gold-deep" /> 수집 상태 — 대상지별
        </h3>
        <span className="text-xs text-hanok-muted">신선도 기준 {pipeline.stale_rule.formula}</span>
      </div>

      <Notice notice={overall} />

      {pipeline.targets.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-hanok-line">
          <table className="w-full text-xs text-hanok-ink">
            <thead className="bg-hanok-card text-hanok-muted">
              <tr>
                <th className={CELL}>대상지</th>
                <th className={CELL}>상태</th>
                <th className={CELL}>주기</th>
                <th className={CELL}>마지막 버킷</th>
                <th className={CELL}>나이 / 기준</th>
                <th className={CELL}>채움률 24시간</th>
                <th className={CELL}>채움률 {windowDays}일</th>
                <th className={CELL}>호출/일</th>
                <th className={CELL}>구역 표 24시간</th>
                <th className={CELL}>마지막 시도</th>
              </tr>
            </thead>
            <tbody>
              {pipeline.targets.map((target) => {
                const badge = targetBadge(target.state);
                const offSchedule = target.window.off_schedule_buckets;
                return (
                  <tr key={target.area_nm} className="border-t border-hanok-line">
                    <td className={`${CELL} font-semibold`}>{target.area_nm}</td>
                    <td className={CELL}>
                      <span className={`inline-block px-2 py-0.5 rounded-md border text-[11px] font-semibold ${TONE_BOX[badge.tone]} ${TONE_TEXT[badge.tone]}`}>
                        {badge.label}
                      </span>
                    </td>
                    <td className={CELL}>{formatCadence(target.cadence_minutes)}</td>
                    <td className={CELL}>{formatKst(target.latest_bucket_at)}</td>
                    <td className={CELL}>
                      {formatAgeMinutes(target.latest_age_minutes)}
                      {target.stale_after_minutes ? ` / ${target.stale_after_minutes}분` : ''}
                    </td>
                    <td className={CELL}>{formatFillRate(target.last_24h)}</td>
                    <td className={CELL}>
                      {formatFillRate(target.window)}
                      {offSchedule > 0 && <span className="block text-[10px] text-hanok-muted">차례 밖 {offSchedule}개 별도</span>}
                      {target.first_bucket_in_window_at && (
                        <span className="block text-[10px] text-hanok-muted">첫 버킷 {formatKst(target.first_bucket_in_window_at)}</span>
                      )}
                    </td>
                    <td className={CELL}>
                      {target.primary_calls_per_day ?? '—'}
                      {target.retry_calls_per_day_worst ? ` + 보충 ≤${target.retry_calls_per_day_worst}` : ''}
                    </td>
                    <td className={CELL}>
                      {target.zone_rows_24h === null ? '—' : `${target.zone_rows_24h} / 원본 ${target.rows_24h}`}
                    </td>
                    <td className={CELL}>{describeLastRun(target.last_run)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs text-hanok-muted">
        <div className="bg-hanok-card border border-hanok-line rounded-xl p-3">
          <p className="font-semibold text-hanok-ink flex items-center gap-1"><Scale size={13} /> 호출 예산(인증키 일 한도)</p>
          <p className={`mt-1 ${pipeline.budget && !pipeline.budget.within_limit ? 'text-rose-700 font-semibold' : ''}`}>
            {describeBudget(pipeline.budget)}
          </p>
          <p className="mt-1">보충 호출({pipeline.budget?.retry_cron ?? '9,39 * * * *'})은 그 버킷에 행이 하나도 없을 때만 :00·:30 버킷의 차례인 대상지를 다시 부릅니다.</p>
        </div>
        <div className="bg-hanok-card border border-hanok-line rounded-xl p-3">
          <p className="font-semibold text-hanok-ink">마지막 수집 실행(이 서버 메모리)</p>
          {lastRun && lastRun.state && lastRun.state !== 'not_run' ? (
            <p className="mt-1">
              {formatKst(lastRun.last_run_at)} · {lastRun.state}
              {lastRun.error_code ? ` · ${lastRun.error_code}` : ''}
              {lastRun.skipped_targets.length > 0 ? ` · 차례 아님 ${lastRun.skipped_targets.length}곳` : ''}
            </p>
          ) : (
            <p className="mt-1">이 서버가 시작된 뒤 아직 수집 실행이 없습니다 — 위 표의 DB 행이 기준입니다.</p>
          )}
          {!pipeline.key_configured && <p className="mt-1 text-rose-700 font-semibold">서울 인증키 없음 — 수집을 부를 수 없습니다.</p>}
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="font-bold text-hanok-ink text-sm flex items-center gap-1">
          <Database size={14} /> 정규화 표(구역 × 10분 버킷)
        </h4>
        <Notice notice={describeZones(pipeline.zones)} />
      </div>
    </section>
  );
}

export function DecisionQualityPanel({ quality }: { quality: DecisionQuality | null }) {
  return (
    <section className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm space-y-3" aria-label="결정 품질">
      <h3 className="text-lg font-bold text-hanok-ink">결정 품질 — 분산 추천이 도착 시점에 덜 붐비는 곳을 골랐나</h3>
      <Notice notice={describeDecisionQuality(quality)} />
    </section>
  );
}
