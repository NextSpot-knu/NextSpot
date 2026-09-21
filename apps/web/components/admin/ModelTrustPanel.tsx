'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Database, Info, ShieldCheck } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';
import { useCountUp } from '@/lib/useCountUp';
import { describeGuardrailWarnings } from '@/lib/adminGuardrailWarnings';
import { ESTIMATED_LOG_SOURCES } from '@/lib/dashboardFallback';

// 서버가 보내는 영문 키를 화면 말로 바꾸는 사전. **매핑에 없는 키는 줄에서 뺀다** —
// 원문 그대로 내보내면 `degraded_rules 12` 같은 내부 코드가 관제 화면에 그대로 찍힌다.
const SCORING_MODE_LABELS: Record<string, string> = {
  spot: '모델 채점',
  model: '모델 채점',
  ml: '모델 채점',
  degraded_rules: '3축 규칙 채점',
  rules: '3축 규칙 채점',
  rule_based: '3축 규칙 채점',
  fallback: '3축 규칙 채점',
  heuristic: '3축 규칙 채점',
};

const FACILITY_TYPE_LABELS: Record<string, string> = {
  restaurant: '음식점',
  cafe: '카페',
  attraction: '관광지',
  culture: '문화시설',
  accommodation: '숙소',
  shopping: '쇼핑',
  festival: '축제',
};

const TRAINING_SOURCE_LABELS: Record<string, string> = {
  user_report: '손님 제보',
  merchant: '사장 좌석 방송',
  merchant_broadcast: '사장 좌석 방송',
  admin_override: '관리자 확인',
  admin: '관리자 확인',
  verified: '상호확인 실측',
  cross_verified: '상호확인 실측',
  parking_derived: '주차 실측 기반 추정',
  simulated: '과거 이력 보정',
  seed: '과거 이력 보정',
};

/** {키: 수} 를 한국어 라벨 줄로. 사전에 없는 키는 조용히 뺀다(내부 코드를 화면에 내지 않는다).
 *  같은 라벨로 묶이는 키는 수를 합쳐 한 번만 적는다. */
function labeledCounts(
  entries: Record<string, number> | null | undefined,
  labels: Record<string, string>,
  format: (value: number) => string = (value) => String(value),
): string {
  const merged = new Map<string, number>();
  for (const [key, value] of Object.entries(entries ?? {})) {
    const label = labels[key];
    if (!label || typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    merged.set(label, (merged.get(label) ?? 0) + value);
  }
  return [...merged.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => `${label} ${format(value)}`)
    .join(' · ');
}

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

/** KPI 타일 수치의 카운트업 표시 — 도착 시 0에서 실제 값으로 굴러 올라간다(DB 집계 실값만).
 *  파싱 안전: 순수 숫자 또는 'N.N%' 형태만 애니메이션하고, 그 외 형태는 그대로 정적 표시
 *  (잘못 파싱해 다른 숫자를 그리는 순간 지어낸 값이 된다). 훅 규칙 때문에 map 안에서
 *  직접 useCountUp 을 못 부르므로 타일당 컴포넌트로 감싼다. */
function AnimatedKpiValue({ value }: { value: string | number }) {
  const pctMatch = typeof value === 'string' ? /^(\d+(?:\.(\d+))?)%$/.exec(value) : null;
  const target =
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : pctMatch
        ? Number(pctMatch[1])
        : Number.NaN;
  const decimals = pctMatch?.[2]?.length ?? 0;
  const animated = useCountUp(target, { decimals });
  if (!Number.isFinite(target)) return <>{value}</>;
  // 퍼센트는 원본과 동일한 소수 자리 고정(toFixed) — 굴러가는 동안에도 표기 폭이 안 흔들린다.
  return <>{pctMatch ? `${animated.toFixed(decimals)}%` : animated}</>;
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
  // 엔진 상태 안내와 운영 점검 항목을 서로 다른 톤으로 표시한다.
  const INFO_CODES = new Set(['trained_false', 'model_refresh_failure', 'untrusted_training_source', 'metrics_truncated']);
  const infoNotes = warnings.filter((warning) => INFO_CODES.has(warning.code));
  const alerts = warnings.filter((warning) => !INFO_CODES.has(warning.code));
  // '전체 현장 관측' 은 source 를 가리지 않고 센 값이다 — 파생·합성이 섞이면 그 이름이
  // 사실이 아니게 되므로, 그 몫을 따로 세어 바로 아래에서 밝힌다.
  const estimatedObservations = Object.entries(data.collection.by_source)
    .filter(([key]) => key in ESTIMATED_LOG_SOURCES)
    .reduce((sum, [, value]) => sum + (value || 0), 0);
  const cards = ([
    ['추천 노출', funnel.exposures], ['길찾기', funnel.navigations], ['방문 확인', funnel.arrivals],
    ['긍정 평가', funnel.positive_ratings],
    // '노출→긍정' 복합 비율은 싣지 않는다: 노출에는 화면에 스친 수동 노출(프리페치 포함)이
    // 섞여 있어 구성상 낮게 나오는 지표다 — 단계 절대값 타일이 이미 깔때기 전체를 말하고,
    // 여기서는 인접 타일 두 개(길찾기·방문 확인)로 정의가 자명한 단계 전환율만 싣는다.
    ['안내 후 방문 전환', funnel.navigations > 0 ? `${((funnel.arrivals / funnel.navigations) * 100).toFixed(1)}%` : '0.0%'],
    ['Top 3 혼잡 근거율', `${(data.top3_evidence.coverage_rate * 100).toFixed(1)}%`],
    ['Top 3 최신 검증 실측률', `${(data.top3_evidence.fresh_trusted_measured_rate * 100).toFixed(1)}%`],
    ['Top 3 영업시간 근거율', `${(data.top3_evidence.operating_hours_rate * 100).toFixed(1)}%`],
    // 비율 지표는 표본이 쌓여 계산된 경우에만 카드로 표시한다.
  ] as const).filter(([, value]) => value !== '0.0%');

  return (
    <section className="rounded-2xl border border-hanok-line bg-hanok-panel p-5" aria-label="추천 모델 신뢰도">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-bold text-hanok-ink"><ShieldCheck size={18} className="text-emerald-700" />추천 신뢰도</h3>
          <p className="mt-1 text-xs text-hanok-muted">
            {data.model.trained
              ? `${data.model.version} · 검증 실데이터 ${data.model.real_data_count}건 · MAE ${((data.model.mae ?? 0) * 100).toFixed(1)}%p`
              : '취향·실제 이동시간·혜택 3축 SPOT 엔진으로 추천 중 — 실측이 누적되면 학습 모델로 자동 승격됩니다'}
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${alerts.length ? 'border-rose-500/30 bg-rose-500/10 text-rose-700' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700'}`}>
          {alerts.length ? `점검 항목 ${alerts.length}건` : '가드레일 정상'}
        </span>
      </div>
      {/* 절단 경고는 **숫자 바로 위**에 둔다. 같은 사실이 아래 경고 목록에도
          'metrics_truncated' 문장으로 들어가지만(그쪽은 '관측 공백 시설' 이 잘못 지목될 수
          있다는 부작용까지 설명한다), 목록은 최대 8건까지 늘어나는 작은 글씨라 정작 이
          카드들을 읽는 순간에는 눈에 들어오지 않는다. 아래 수치가 기간 전체의 값이
          아니라는 사실은 수치를 보기 전에 알아야 한다. */}
      {data.truncated && (
        <p className="mt-3">
          <span className="inline-flex items-center rounded-full border border-hanok-line bg-hanok-card px-2.5 py-1 text-[11px] font-semibold text-hanok-muted">
            최신 구간 기준
          </span>
        </p>
      )}
      <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
        {cards.map(([label, value]) => <div key={label} className="rounded-xl border border-hanok-line bg-hanok-card p-3"><p className="text-[10px] text-hanok-muted">{label}</p><p className="mt-1 text-lg font-black text-hanok-ink"><AnimatedKpiValue value={value} /></p></div>)}
      </div>
      {/* 실데이터 수집 현황은 관측이 시작된 뒤 표시한다. */}
      {data.collection.observations > 0 && (
      <div className="mt-4 rounded-xl border border-hanok-line bg-hanok-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs font-bold text-hanok-ink"><Database size={14} className="text-gold-deep" />실데이터 수집 현황</p>
          <p className="text-[11px] text-hanok-muted">검증 관측 {data.collection.remaining_to_candidate}건이 쌓이면 후보 자동 생성이 시작됩니다</p>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          <p className="text-xs text-hanok-muted">전체 현장 관측 <strong className="block text-lg text-hanok-ink">{data.collection.observations}</strong></p>
          <p className="text-xs text-hanok-muted">검증·상호확인 <strong className="block text-lg text-hanok-ink">{data.collection.trusted_observations}</strong></p>
          <p className="text-xs text-hanok-muted">시설 커버리지 <strong className="block text-lg text-hanok-ink">{(data.collection.trusted_facility_coverage_rate * 100).toFixed(1)}%</strong></p>
          <p className="text-xs text-hanok-muted">활성 시설 <strong className="block text-lg text-hanok-ink">{data.collection.active_facilities}</strong></p>
        </div>
        {/* source 이름을 그대로 늘어놓으면 `parking_derived 1653` 처럼 보인다 — 저장소를
            아는 사람만 그게 '실측이 아니다' 를 안다. 한국어 이름으로만 적고, 사전에 없는
            키는 줄에서 뺀다(내부 코드는 화면이 아니라 콘솔에서 본다). */}
        <p className="mt-3 text-[11px] text-hanok-muted">
          출처 · {labeledCounts(data.collection.by_source, TRAINING_SOURCE_LABELS, (value) => `${value}건`) || '수집 중'}
        </p>
        {estimatedObservations > 0 && (
          <p className="mt-1 text-[11px] text-sky-700">
            실측 {Math.max(0, data.collection.observations - estimatedObservations)}건 기준 집계 · 추정 {estimatedObservations}건은 별도 관리
          </p>
        )}
        <p className="mt-1 text-[11px] text-hanok-muted">
          채점 모드 · {labeledCounts(data.guardrails.scoring_modes, SCORING_MODE_LABELS, (value) => `${value}건`) || '집계 중'}
          {' · '}도보 제한 위반 {data.guardrails.walk_limit_violations}건
        </p>
        {data.collection.facility_gaps.length > 0 && <p className="mt-1 text-[11px] text-hanok-muted">다음 수집 우선 대상 · {data.collection.facility_gaps.slice(0, 6).map((item) => item.name).join(' · ')}</p>}
      </div>
      )}
      {data.registry && <div className="mt-3 grid gap-2 text-[11px] text-hanok-muted md:grid-cols-2">
        <p>유형별 MAE · {labeledCounts(data.registry.metrics.per_type_mae, FACILITY_TYPE_LABELS, (value) => `${(value * 100).toFixed(1)}%p`) || '수집 중'}</p>
        <p>학습 근거 · {labeledCounts(data.registry.source_composition, TRAINING_SOURCE_LABELS, (value) => `${value}건`) || '수집 중'}</p>
      </div>}
      {alerts.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-xs text-rose-700">
          {alerts.map((warning) => (
            <li key={warning.code} className="flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{warning.text}</span>
            </li>
          ))}
        </ul>
      )}
      {infoNotes.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-xs text-hanok-muted">
          {infoNotes.map((warning) => (
            <li key={warning.code} className="flex items-start gap-2">
              <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{warning.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
