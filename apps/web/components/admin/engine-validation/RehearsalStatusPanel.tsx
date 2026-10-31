'use client';

// 실시간 데이터 리허설 — 서울 수집 파이프라인을 **있는 그대로** 보여 주는 블록.
//
// 대상지마다 주기·마지막 버킷·나이·채움률(분모 = 그 대상지의 차례였던 버킷)·호출 예산을 한 줄로 두고,
// 정규화 표(zone_crowd_snapshots)와 결정 품질(S4)은 각자의 상태로 말한다. 결정 품질은 커밋된 재생 요약이 있으면
// 권역마다 카드 하나(판정 배지 · 표본 · 적중률과 신뢰구간 · 한계 첫 줄)를 그린다. 판정은 서버가 하고(seoul_collection_status.py)
// 문장은 lib/rehearsalStatus.ts 가 만든다 — 이 컴포넌트는 그리기만 한다.

import { Activity, AlertCircle, AlertTriangle, CheckCircle2, Database, Hourglass, Info, MinusCircle, Scale, XCircle } from 'lucide-react';
import { formatKst, type StateNotice, type Tone } from '@/lib/engineValidation';
import {
  countedSinceLabel,
  decisionQualityCards,
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
  type DecisionQualityCard,
  type RehearsalPipeline,
  type VerdictBadge,
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
        <p className={`font-bold text-sm break-words ${TONE_TEXT[notice.tone]}`}>{notice.title}</p>
        <p className="text-xs text-hanok-muted mt-1 break-words">{notice.detail}</p>
      </div>
    </div>
  );
}

const CELL = 'px-2 py-2 whitespace-nowrap min-w-[3.5rem] text-left align-top';

export function RehearsalStatusPanel({
  pipeline,
  windowDays,
  windowStart,
}: {
  pipeline: RehearsalPipeline | null;
  windowDays: number;
  windowStart?: string | null;
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
                      {countedSinceLabel(target, windowStart) ? (
                        <span className="block text-[10px] text-hanok-muted">{countedSinceLabel(target, windowStart)}</span>
                      ) : target.first_bucket_in_window_at ? (
                        <span className="block text-[10px] text-hanok-muted">첫 버킷 {formatKst(target.first_bucket_in_window_at)}</span>
                      ) : null}
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

const VERDICT_ICON: Record<VerdictBadge['status'], typeof Info> = {
  pass: CheckCircle2,
  fail: XCircle,
  insufficient: Hourglass,
  not_evaluable: MinusCircle,
  unknown: AlertTriangle,
};

function Badge({ label, tone, Icon }: { label: string; tone: Tone; Icon?: typeof Info }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-semibold ${TONE_BOX[tone]} ${TONE_TEXT[tone]}`}>
      {Icon && <Icon size={12} />}
      {label}
    </span>
  );
}

/** 권역 하나의 재생 결과. 숫자와 정의만 쓴다 — 결론 문장은 판정 배지가 대신한다. */
function DecisionQualityClusterCard({ card }: { card: DecisionQualityCard }) {
  return (
    <article
      className="bg-hanok-card border border-hanok-line rounded-xl p-3 space-y-2 min-w-0"
      aria-label={`결정 품질 — ${card.title}`}
      data-testid={`decision-quality-${card.cluster}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-bold text-hanok-ink text-sm">{card.title}</h4>
        <Badge label={card.runBadge.label} tone={card.runBadge.tone} />
        <Badge label={`V3 ${card.v3Badge.label}`} tone={card.v3Badge.tone} Icon={VERDICT_ICON[card.v3Badge.status]} />
      </div>
      {card.zones && <p className="text-[11px] text-hanok-muted break-words">{card.zones}</p>}
      {card.unattainable && <p className="text-xs font-semibold text-amber-800 break-words">{card.unattainable}</p>}
      {card.v3Reason && <p className="text-[11px] text-hanok-muted break-words">사유: {card.v3Reason}</p>}
      <p className="text-xs text-hanok-ink tabular-nums break-words">{card.sampleLine}</p>
      <p className="text-sm font-semibold text-hanok-ink tabular-nums break-words">{card.hitLine}</p>
      <ul className="text-xs text-hanok-muted space-y-0.5 tabular-nums">
        {card.contrastLines.map((line) => (
          <li key={line} className="break-words">{line}</li>
        ))}
        {card.nowLine && <li className="break-words">{card.nowLine}</li>}
      </ul>
      <p className="text-xs text-hanok-ink tabular-nums break-words flex flex-wrap items-center gap-2">
        <Badge label={`V4 ${card.v4Badge.label}`} tone={card.v4Badge.tone} Icon={VERDICT_ICON[card.v4Badge.status]} />
        <span className="min-w-0 break-words">{card.v4Line}</span>
      </p>
      {card.thinNote && <p className="text-xs text-amber-800 break-words">{card.thinNote}</p>}
      {card.notes.length > 0 && (
        <ul className="text-[11px] text-hanok-muted list-disc pl-4 space-y-0.5">
          {card.notes.map((note) => (
            <li key={note} className="break-words">{note}</li>
          ))}
        </ul>
      )}
      {card.firstLimit && <p className="text-[11px] text-hanok-ink break-words">한계: {card.firstLimit}</p>}
      {card.moreLimits.length > 0 && (
        <details className="text-[11px] text-hanok-muted">
          <summary className="cursor-pointer">한계 {card.moreLimits.length}개 더 보기</summary>
          <ul className="list-disc pl-4 mt-1 space-y-0.5">
            {card.moreLimits.map((limit) => (
              <li key={limit} className="break-words">{limit}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-[10px] text-hanok-muted break-all">{card.criteriaLine}</p>
    </article>
  );
}

export function DecisionQualityPanel({ quality }: { quality: DecisionQuality | null }) {
  const cards = decisionQualityCards(quality);
  return (
    <section className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm space-y-3" aria-label="결정 품질">
      <h3 className="text-lg font-bold text-hanok-ink">결정 품질 — 분산 추천이 도착 시점에 덜 붐비는 곳을 골랐나</h3>
      <Notice notice={describeDecisionQuality(quality)} />
      {cards.length > 0 && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {cards.map((card) => (
            <DecisionQualityClusterCard key={card.cluster} card={card} />
          ))}
        </div>
      )}
    </section>
  );
}
