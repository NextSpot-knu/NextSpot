'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Database, ShieldCheck } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';
import { describeGuardrailWarnings } from '@/lib/adminGuardrailWarnings';
import { ESTIMATED_LOG_SOURCES } from '@/lib/dashboardFallback';

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
  /** 조회가 서버 상한(_TRUST_*_CAP)에 닿았는가. 아래 수치가 기간 전체의 값이 아니라는 뜻. */
  truncated?: boolean;
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
  // `!data` 만 보면 부족하다. **응답이 오긴 왔는데 모양이 다른 경우**가 이 가드를 그대로
  // 통과해 아래 `data.guardrails.warnings` 에서 터졌고, 그러면 이 패널 하나가 아니라
  // **관리자 대시보드 전체가 에러 바운더리로 떨어졌다**(브라우저에서 재현: 화면에 남는 것은
  // "문제가 발생했어요" 한 줄뿐이라, KPI·히트맵·주차 카드까지 통째로 사라진다).
  //
  // 그런 응답은 가상의 상황이 아니다: 배포 시차로 옛 서버가 새 키를 아직 안 싣거나,
  // 프록시가 `{}` 를 돌려주거나, 응답 계약이 바뀌는 중일 때 실제로 온다. 이 패널은 **부가
  // 정보**이므로 그때는 조용히 빠지는 것이 맞다 — 장애 자체는 헤더 상태 배지가 알린다.
  //
  // 필드를 하나씩 방어적으로 읽지 않고 여기서 한 번에 끊는 이유: 아래 계산이 서로 얽혀 있어
  // 부분적으로 그리면 '일부는 최신, 일부는 빈 값' 인 화면이 되고, 그건 숫자를 잘못 읽게 만든다.
  if (!data?.funnel || !data?.guardrails || !data?.collection || !data?.top3_evidence) return null;

  const funnel = data.funnel;
  // 코드가 아니라 문장으로 보여준다. 예전에는 `trained_false · metrics_truncated` 처럼
  // 원문이 그대로 나가서, 이 저장소를 아는 사람만 읽을 수 있었다.
  const warnings = describeGuardrailWarnings(data.guardrails.warnings);
  // '전체 현장 관측' 은 source 를 가리지 않고 센 값이다 — 파생·합성이 섞이면 그 이름이
  // 사실이 아니게 되므로, 그 몫을 따로 세어 바로 아래에서 밝힌다.
  const estimatedObservations = Object.entries(data.collection.by_source)
    .filter(([key]) => key in ESTIMATED_LOG_SOURCES)
    .reduce((sum, [, value]) => sum + (value || 0), 0);
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
      {/* 절단 경고는 **숫자 바로 위**에 둔다. 같은 사실이 아래 경고 목록에도
          'metrics_truncated' 문장으로 들어가지만(그쪽은 '관측 공백 시설' 이 잘못 지목될 수
          있다는 부작용까지 설명한다), 목록은 최대 8건까지 늘어나는 작은 글씨라 정작 이
          카드들을 읽는 순간에는 눈에 들어오지 않는다. 아래 수치가 기간 전체의 값이
          아니라는 사실은 수치를 보기 전에 알아야 한다. */}
      {data.truncated && (
        <p className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            표본이 상한에서 잘렸어요 — <strong className="font-bold">아래 수치는 기간 전체가 아닙니다.</strong>
          </span>
        </p>
      )}
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
        {/* source 이름을 그대로 늘어놓으면 `parking_derived 1653` 처럼 보인다 — 저장소를
            아는 사람만 그게 '실측이 아니다' 를 안다. 파생·합성 출처는 한국어 이름과 함께
            '(추정)' 을 붙여, 이 줄만 보고도 어떤 몫이 측정이 아닌지 알 수 있게 한다.
            모르는 코드는 원문 그대로 둔다(adminGuardrailWarnings 와 같은 규칙 — 매핑에
            없다고 숨기면 새 출처가 조용히 실측처럼 읽힌다). */}
        <p className="mt-3 text-[11px] text-hanok-muted">출처 · {Object.entries(data.collection.by_source).map(([key, value]) => {
          const label = ESTIMATED_LOG_SOURCES[key];
          return label ? `${key} ${value} — ${label}(추정)` : `${key} ${value}`;
        }).join(' · ') || '수집 전'}</p>
        {estimatedObservations > 0 && (
          <p className="mt-1 text-[11px] text-sky-200">
            위 &lsquo;전체 현장 관측 {data.collection.observations}&rsquo; 중 {estimatedObservations}건은 현장 관측이 아니라 추정·합성 데이터입니다. 검증·상호확인 수치와 시설 커버리지는 이 몫을 이미 제외한 값입니다.
          </p>
        )}
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
      {warnings.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-xs text-rose-300">
          {warnings.map((warning) => (
            <li key={warning.code} className="flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{warning.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
