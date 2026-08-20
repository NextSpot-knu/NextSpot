'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Database, ShieldCheck } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';

interface TrustResponse {
  model: { trained: boolean; version: string | null; real_data_count: number; mae: number | null };
  registry: { training_started_at: string; training_ended_at: string; source_composition: Record<string, number>; metrics: { baseline_improvement?: number; per_type_mae?: Record<string, number> } } | null;
  funnel: { exposures: number; navigations: number; arrivals: number; positive_ratings: number; verified_visit_success_rate: number };
  top3_evidence: { coverage_rate: number; fresh_rate: number; fresh_trusted_measured_rate: number; operating_hours_rate: number };
  collection: {
    observations: number;
    trusted_observations: number;
    remaining_to_candidate: number;
    active_facilities: number;
    trusted_facility_coverage_rate: number;
    by_source: Record<string, number>;
    by_evidence_tier: Record<string, number>;
    facility_gaps: { id: string; name: string; type: string }[];
  };
  guardrails: { warnings: string[]; walk_limit_violations: number; scoring_modes: Record<string, number> };
}

export function ModelTrustPanel() {
  const [data, setData] = useState<TrustResponse | null>(null);
  useEffect(() => {
    let active = true;
    adminApi.get('/api/v1/admin/model-trust').then((value: TrustResponse) => {
      if (active) setData(value);
    }).catch(() => { /* 헤더 상태 배지가 별도로 장애를 알린다. */ });
    return () => { active = false; };
  }, []);
  if (!data) return null;

  const funnel = data.funnel;
  const warnings = data.guardrails.warnings;
  const cards = [
    ['추천 노출', funnel.exposures], ['길찾기', funnel.navigations], ['방문 확인', funnel.arrivals],
    ['긍정 평가', funnel.positive_ratings],
    ['검증 방문 성공률', `${(funnel.verified_visit_success_rate * 100).toFixed(1)}%`],
    ['Top 3 혼잡 근거율', `${(data.top3_evidence.coverage_rate * 100).toFixed(1)}%`],
    ['Top 3 최신 검증 실측률', `${(data.top3_evidence.fresh_trusted_measured_rate * 100).toFixed(1)}%`],
    ['Top 3 영업시간 근거율', `${(data.top3_evidence.operating_hours_rate * 100).toFixed(1)}%`],
  ] as const;

  return (
    <section className="rounded-2xl border border-hanok-line bg-hanok-panel p-5" aria-label="추천 모델 신뢰도">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-bold text-hanok-ink"><ShieldCheck size={18} className="text-emerald-300" />추천 신뢰도</h3>
          <p className="mt-1 text-xs text-hanok-muted">
            {data.model.trained
              ? `${data.model.version} · 검증 실데이터 ${data.model.real_data_count}건 · MAE ${((data.model.mae ?? 0) * 100).toFixed(1)}%p`
              : '검증 모델 없음 · 취향/이동시간/혜택 규칙 기반 안전 모드'}
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${warnings.length ? 'border-rose-500/30 bg-rose-500/10 text-rose-300' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'}`}>
          {warnings.length ? `경고 ${warnings.length}건` : '가드레일 정상'}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
        {cards.map(([label, value]) => <div key={label} className="rounded-xl border border-hanok-line bg-hanok-card p-3"><p className="text-[10px] text-hanok-muted">{label}</p><p className="mt-1 text-lg font-black text-hanok-ink">{value}</p></div>)}
      </div>
      <div className="mt-4 rounded-xl border border-hanok-line bg-hanok-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs font-bold text-hanok-ink"><Database size={14} className="text-gold" />실데이터 수집 현황</p>
          <p className="text-[11px] text-hanok-muted">후보 생성까지 검증 관측 {data.collection.remaining_to_candidate}건 필요</p>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          <p className="text-xs text-hanok-muted">전체 현장 관측 <strong className="block text-lg text-hanok-ink">{data.collection.observations}</strong></p>
          <p className="text-xs text-hanok-muted">검증·상호확인 <strong className="block text-lg text-hanok-ink">{data.collection.trusted_observations}</strong></p>
          <p className="text-xs text-hanok-muted">시설 커버리지 <strong className="block text-lg text-hanok-ink">{(data.collection.trusted_facility_coverage_rate * 100).toFixed(1)}%</strong></p>
          <p className="text-xs text-hanok-muted">활성 시설 <strong className="block text-lg text-hanok-ink">{data.collection.active_facilities}</strong></p>
        </div>
        <p className="mt-3 text-[11px] text-hanok-muted">출처 · {Object.entries(data.collection.by_source).map(([key, value]) => `${key} ${value}`).join(' · ') || '수집 전'}</p>
        <p className="mt-1 text-[11px] text-hanok-muted">
          채점 모드 · {Object.entries(data.guardrails.scoring_modes).map(([key, value]) => `${key} ${value}`).join(' · ') || '노출 전'}
          {' · '}도보 제한 위반 {data.guardrails.walk_limit_violations}건
        </p>
        {data.collection.facility_gaps.length > 0 && <p className="mt-1 text-[11px] text-amber-200">수집 공백 우선순위 · {data.collection.facility_gaps.slice(0, 6).map((item) => item.name).join(' · ')}</p>}
      </div>
      {data.registry && <div className="mt-3 grid gap-2 text-[11px] text-hanok-muted md:grid-cols-2">
        <p>유형별 MAE · {Object.entries(data.registry.metrics.per_type_mae ?? {}).map(([key, value]) => `${key} ${(value * 100).toFixed(1)}%p`).join(' · ') || '표본 없음'}</p>
        <p>학습 근거 · {Object.entries(data.registry.source_composition).filter(([, value]) => value > 0).map(([key, value]) => `${key} ${value}`).join(' · ') || '없음'}</p>
      </div>}
      {warnings.length > 0 && <p className="mt-3 flex items-center gap-2 text-xs text-rose-300"><AlertTriangle size={14} />{warnings.join(' · ')}</p>}
    </section>
  );
}
