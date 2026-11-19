// 실시간 데이터 리허설(관리자 '엔진 검증' 화면) — 서울 수집 파이프라인 상태의 순수 판정.
//
// 응답은 GET /api/v1/admin/engine-validation/seoul/summary 의 `pipeline` · `decision_quality` 블록이다
// (admin-api 는 케이스 변환을 하지 않으므로 필드는 서버와 같은 snake_case).
//
// 이 파일이 지키는 것 하나: **행이 없거나 오래된 대상지를 '가동 중' 처럼 보이게 하지 않는다.**
// 표가 없으면(not_migrated) 없다고, 행이 없으면(empty) 없다고, 주기보다 오래됐으면(stale) 늦었다고 말하고,
// 사람이 할 일이 있으면 그 일을 그대로 적는다. 판정은 서버(seoul_collection_status.py)가 하고, 여기는
// 그 판정을 문장으로 옮기기만 한다 — 화면이 서버 판정을 다시 계산해 다른 답을 내지 않게.

import { formatKst, type StateNotice, type Tone } from './engineValidation';

export type TargetState = 'fresh' | 'stale' | 'empty' | 'not_migrated' | 'invalid_config' | 'not_configured';

export interface Coverage {
  expected_buckets: number | null;
  collected_buckets: number;
  off_schedule_buckets: number;
  fill_rate: number | null;
}

export interface TargetLastRun {
  state: string | null;
  checked_at: string | null;
  error_code: string | null;
  upstream_code: string | null;
  last_success_at: string | null;
}

export interface PipelineTarget {
  area_nm: string;
  zone_id: string | null;
  configured: boolean;
  state: TargetState | string;
  every_buckets: number | null;
  offset_buckets: number | null;
  cadence_minutes: number | null;
  stale_after_minutes: number | null;
  latest_bucket_at: string | null;
  latest_age_minutes: number | null;
  first_bucket_in_window_at: string | null;
  /** 채움률 분모를 센 시작 — max(창 시작, 이 대상지의 첫 버킷). 이전 서버는 없다. */
  counted_since_at?: string | null;
  window: Coverage;
  last_24h: Coverage;
  rows_24h: number;
  zone_rows_24h: number | null;
  primary_calls_per_day: number | null;
  retry_calls_per_day_worst: number | null;
  last_run: TargetLastRun | null;
}

export interface CallBudget {
  primary_per_day: number;
  retry_worst_case_per_day: number;
  worst_case_per_day: number;
  limit_per_day: number;
  headroom_per_day: number;
  within_limit: boolean;
  retry_cron: string;
}

export type ZoneTableState = 'not_migrated' | 'empty' | 'no_recent_rows' | 'has_rows' | 'unavailable';
export type ZoneWriteState = 'stored' | 'partial' | 'migration_not_applied' | 'failed' | 'skipped';

export interface ZonesStatus {
  table: string;
  migration: string;
  table_state: ZoneTableState | string;
  rows_24h: number | null;
  latest_bucket_at: string | null;
  latest_age_minutes: number | null;
  last_write: { state: ZoneWriteState | string | null; stored_count: number | null; errors: Record<string, string>; at: string | null } | null;
  human_step: string | null;
}

export interface RehearsalPipeline {
  schedule_state: 'ok' | 'invalid_config' | 'no_targets' | string;
  schedule_error: string | null;
  key_configured: boolean;
  table_state: 'not_migrated' | 'has_rows' | 'no_rows_in_window' | string;
  human_step: string | null;
  stale_rule: { formula: string; base_minutes: number; collection_offset_minutes: number };
  bucket_minutes: number;
  budget: CallBudget | null;
  targets: PipelineTarget[];
  last_run: {
    state: string | null;
    last_run_at: string | null;
    last_success_at: string | null;
    error_code: string | null;
    skipped_targets: string[];
    memory_only: boolean;
  } | null;
  zones: ZonesStatus | null;
}

/** S4 재생 요약 한 권역(`decision_quality_summary/3`) — 서버 검사기(crowd/decision_quality.py)를 통과한 것만 온다. */
export interface DecisionQualityCluster {
  cluster: string;
  zones: string[];
  run_label: 'pilot' | 'confirmatory' | 'exploratory' | string;
  criteria_version: string;
  code_version: string | null;
  period: { first_decision_at: string | null; last_decision_at: string | null; days: number };
  n_decisions: number;
  days: number;
  episodes: number;
  n_disagree: number;
  headroom: number | null;
  opportunity_rate: number | null;
  hit_rate: Record<'engine' | 'nearest' | 'climatology_choice' | 'current_band_greedy' | 'random' | 'oracle', number | null>;
  hit_vs_now: { engine: number | null; stay: number | null };
  harm_rate: { engine: number | null; nearest: number | null };
  verdicts: {
    V3: {
      status: string;
      criterion: string;
      diff: number | null;
      /** 부트스트랩 95% 구간(보여 주는 값). */
      ci_low: number | null;
      ci_high: number | null;
      ci_label: string | null;
      /** 날짜 군집 t 하한. */
      ci_low_t: number | null;
      /** 판정 하한 = 부트스트랩·날짜 군집 t 하한 중 작은 쪽 — 통과는 이것이 0 보다 커야 한다. */
      gate_low: number | null;
      n: number;
      /** 서로 다른 (출발지·버킷) 수 — 최소 표본 판정은 결정 수 n 이 아니라 이것으로 한다. 이전 요약은 없다(null). */
      n_distinct: number | null;
      days: number;
      n_disagree: number;
      /** 엔진≠가장 가까운 곳인 서로 다른 (출발지·버킷) 수. 이전 요약은 없다(null). */
      n_disagree_distinct: number | null;
      headroom: number | null;
      /** null = 모집단이 비어 달성 가능 여부를 모른다(headroom 없음). */
      criterion_attainable: boolean | null;
      reason: string | null;
    };
    V4: {
      status: string;
      recommendation: string;
      lead_bin: number;
      mae_provider: number | null;
      mae_persistence: number | null;
      n: number | null;
      days: number | null;
      reason: string | null;
    };
    V2: { status: string; share_crowd_gt_travel: number | null };
  };
  contrasts: Record<'engine_minus_climatology' | 'engine_minus_greedy', CiBlock>;
  thin_cluster: boolean;
  alternatives_per_origin: number;
  notes: string[];
  limits: string[];
}

export interface CiBlock {
  diff: number | null;
  ci_low: number | null;
  ci_high: number | null;
}

export interface DecisionQuality {
  /** not_evaluated(요약 없음) · evaluated(요약 있음) · invalid_summary(요약 파일 오류). 모르는 모양은 not_evaluated 로 읽는다. */
  state: 'not_evaluated' | 'evaluated' | 'invalid_summary';
  stage: string;
  criterion: string;
  /** evaluated 일 때만 채운다(cluster 이름순 — 서버 순서 그대로). */
  clusters: DecisionQualityCluster[];
  /** invalid_summary 일 때 '<파일명>: <문제>'. */
  reason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coverageOf(raw: unknown): Coverage {
  const c = isRecord(raw) ? raw : {};
  return {
    expected_buckets: typeof c.expected_buckets === 'number' ? c.expected_buckets : null,
    collected_buckets: typeof c.collected_buckets === 'number' ? c.collected_buckets : 0,
    off_schedule_buckets: typeof c.off_schedule_buckets === 'number' ? c.off_schedule_buckets : 0,
    fill_rate: typeof c.fill_rate === 'number' ? c.fill_rate : null,
  };
}

/**
 * `pipeline` 블록 → 화면이 아는 모양. 모르는 모양이면 null — 반쯤 그려서 '대상지가 없다' 로 읽히게 두지 않는다.
 * 서버가 아직 이 블록을 모르면(이전 배포) 필드 자체가 없다 — 그때도 null.
 */
export function parsePipeline(raw: unknown): RehearsalPipeline | null {
  if (!isRecord(raw) || !Array.isArray(raw.targets) || typeof raw.schedule_state !== 'string') return null;
  const targets = (raw.targets as unknown[])
    .filter((t): t is Record<string, unknown> => isRecord(t) && typeof t.area_nm === 'string' && typeof t.state === 'string')
    .map((t) => ({
      ...(t as unknown as PipelineTarget),
      window: coverageOf(t.window),
      last_24h: coverageOf(t.last_24h),
      rows_24h: typeof t.rows_24h === 'number' ? t.rows_24h : 0,
      last_run: isRecord(t.last_run) ? (t.last_run as unknown as TargetLastRun) : null,
    }));
  const zones = isRecord(raw.zones) && typeof raw.zones.table_state === 'string'
    ? {
        ...(raw.zones as unknown as ZonesStatus),
        last_write: isRecord(raw.zones.last_write)
          ? {
              ...(raw.zones.last_write as unknown as NonNullable<ZonesStatus['last_write']>),
              errors: isRecord(raw.zones.last_write.errors) ? (raw.zones.last_write.errors as Record<string, string>) : {},
            }
          : null,
      }
    : null;
  const lastRun = isRecord(raw.last_run)
    ? {
        ...(raw.last_run as unknown as NonNullable<RehearsalPipeline['last_run']>),
        skipped_targets: Array.isArray(raw.last_run.skipped_targets) ? (raw.last_run.skipped_targets as string[]) : [],
      }
    : null;
  return {
    ...(raw as unknown as RehearsalPipeline),
    targets,
    zones,
    last_run: lastRun,
    budget: isRecord(raw.budget) ? (raw.budget as unknown as CallBudget) : null,
    stale_rule: isRecord(raw.stale_rule)
      ? (raw.stale_rule as unknown as RehearsalPipeline['stale_rule'])
      : { formula: 'max(30, 2 × 주기 + 8)분', base_minutes: 30, collection_offset_minutes: 8 },
  };
}

const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const numOrNull = (value: unknown): number | null => (isNum(value) ? value : null);
const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const strList = (value: unknown): string[] =>
  Array.isArray(value) ? (value as unknown[]).filter((item): item is string => typeof item === 'string') : [];

function rateBlock<K extends string>(raw: unknown, keys: readonly K[]): Record<K, number | null> {
  const block = isRecord(raw) ? raw : {};
  return Object.fromEntries(keys.map((key) => [key, numOrNull(block[key])])) as Record<K, number | null>;
}

const HIT_POLICIES = ['engine', 'nearest', 'climatology_choice', 'current_band_greedy', 'random', 'oracle'] as const;
const CI_KEYS = ['diff', 'ci_low', 'ci_high'] as const;

/** 요약 한 권역. 판정(V3)·권역 이름·표본 수가 없으면 모르는 모양 — null. */
function parseCluster(raw: unknown): DecisionQualityCluster | null {
  if (!isRecord(raw) || typeof raw.cluster !== 'string' || !isRecord(raw.verdicts)) return null;
  const verdicts = raw.verdicts;
  const v3 = isRecord(verdicts.V3) ? verdicts.V3 : null;
  if (!v3 || typeof v3.status !== 'string' || !isNum(raw.n_decisions) || !isNum(raw.days)) return null;
  const v4 = isRecord(verdicts.V4) ? verdicts.V4 : {};
  const v2 = isRecord(verdicts.V2) ? verdicts.V2 : {};
  const period = isRecord(raw.period) ? raw.period : {};
  const contrasts = isRecord(raw.contrasts) ? raw.contrasts : {};
  return {
    cluster: raw.cluster,
    zones: strList(raw.zones),
    run_label: typeof raw.run_label === 'string' ? raw.run_label : 'exploratory',
    criteria_version: typeof raw.criteria_version === 'string' ? raw.criteria_version : '—',
    code_version: strOrNull(raw.code_version),
    period: {
      first_decision_at: strOrNull(period.first_decision_at),
      last_decision_at: strOrNull(period.last_decision_at),
      days: isNum(period.days) ? period.days : 0,
    },
    n_decisions: raw.n_decisions,
    days: raw.days,
    episodes: isNum(raw.episodes) ? raw.episodes : 0,
    n_disagree: isNum(raw.n_disagree) ? raw.n_disagree : 0,
    headroom: numOrNull(raw.headroom),
    opportunity_rate: numOrNull(raw.opportunity_rate),
    hit_rate: rateBlock(raw.hit_rate, HIT_POLICIES),
    hit_vs_now: rateBlock(raw.hit_vs_now, ['engine', 'stay'] as const),
    harm_rate: rateBlock(raw.harm_rate, ['engine', 'nearest'] as const),
    verdicts: {
      V3: {
        status: v3.status,
        criterion: typeof v3.criterion === 'string' ? v3.criterion : '',
        diff: numOrNull(v3.diff),
        ci_low: numOrNull(v3.ci_low),
        ci_high: numOrNull(v3.ci_high),
        ci_label: strOrNull(v3.ci_label),
        ci_low_t: numOrNull(v3.ci_low_t),
        gate_low: numOrNull(v3.gate_low),
        n: isNum(v3.n) ? v3.n : raw.n_decisions,
        n_distinct: numOrNull(v3.n_distinct),
        days: isNum(v3.days) ? v3.days : raw.days,
        n_disagree: isNum(v3.n_disagree) ? v3.n_disagree : 0,
        n_disagree_distinct: numOrNull(v3.n_disagree_distinct),
        headroom: numOrNull(v3.headroom),
        // 참/거짓이 아니면(null · 빠짐) 모른다 — '달성 가능' 으로도 '구조상 달성 불가' 로도 단정하지 않는다.
        criterion_attainable: typeof v3.criterion_attainable === 'boolean' ? v3.criterion_attainable : null,
        reason: strOrNull(v3.reason),
      },
      V4: {
        status: typeof v4.status === 'string' ? v4.status : 'not_evaluable',
        recommendation: typeof v4.recommendation === 'string' ? v4.recommendation : 'undetermined',
        lead_bin: isNum(v4.lead_bin) ? v4.lead_bin : 30,
        mae_provider: numOrNull(v4.mae_provider),
        mae_persistence: numOrNull(v4.mae_persistence),
        n: numOrNull(v4.n),
        days: numOrNull(v4.days),
        reason: strOrNull(v4.reason),
      },
      V2: { status: typeof v2.status === 'string' ? v2.status : 'report', share_crowd_gt_travel: numOrNull(v2.share_crowd_gt_travel) },
    },
    contrasts: {
      engine_minus_climatology: rateBlock(contrasts.engine_minus_climatology, CI_KEYS),
      engine_minus_greedy: rateBlock(contrasts.engine_minus_greedy, CI_KEYS),
    },
    thin_cluster: raw.thin_cluster === true,
    alternatives_per_origin: isNum(raw.alternatives_per_origin) ? raw.alternatives_per_origin : 0,
    notes: strList(raw.notes),
    limits: strList(raw.limits),
  };
}

export const DECISION_QUALITY_SCHEMA = 'decision_quality_summary/3';

/**
 * `decision_quality` 블록 → 화면이 아는 모양. **모르는 모양(새 스키마·깨진 요약·모르는 상태)은 not_evaluated 로 읽는다** —
 * 반쯤 읽은 숫자를 결과처럼 보이게 하지 않는다. 블록 자체가 없으면(이전 서버) null.
 */
export function parseDecisionQuality(raw: unknown): DecisionQuality | null {
  if (!isRecord(raw) || typeof raw.state !== 'string') return null;
  const base = {
    stage: typeof raw.stage === 'string' ? raw.stage : 'S4',
    criterion: typeof raw.criterion === 'string' ? raw.criterion : '',
    clusters: [] as DecisionQualityCluster[],
    reason: null as string | null,
  };
  if (raw.state === 'invalid_summary') {
    return { ...base, state: 'invalid_summary', reason: typeof raw.reason === 'string' ? raw.reason : null };
  }
  if (
    raw.state === 'evaluated' &&
    isRecord(raw.result) &&
    raw.result.schema_version === DECISION_QUALITY_SCHEMA &&
    Array.isArray(raw.result.clusters)
  ) {
    const parsed = (raw.result.clusters as unknown[]).map(parseCluster);
    const clusters = parsed.filter((cluster): cluster is DecisionQualityCluster => cluster !== null);
    if (clusters.length > 0 && clusters.length === parsed.length) {
      return { ...base, state: 'evaluated', clusters };
    }
  }
  return { ...base, state: 'not_evaluated' };
}

// --- 대상지 한 줄 -------------------------------------------------------------------

export const TARGET_STATE_LABEL: Record<TargetState, string> = {
  fresh: '최신',
  stale: '지연',
  empty: '행 없음',
  not_migrated: '표 없음',
  invalid_config: '설정 오류',
  not_configured: '설정 밖',
};

const TARGET_STATE_TONE: Record<TargetState, Tone> = {
  fresh: 'ok',
  stale: 'warn',
  empty: 'warn',
  not_migrated: 'error',
  invalid_config: 'error',
  not_configured: 'info',
};

/** 대상지 상태 → 배지. 모르는 상태는 그대로 이름을 보이고 '정상' 색을 주지 않는다. */
export function targetBadge(state: string): { label: string; tone: Tone } {
  const known = state as TargetState;
  if (known in TARGET_STATE_LABEL) return { label: TARGET_STATE_LABEL[known], tone: TARGET_STATE_TONE[known] };
  return { label: state, tone: 'warn' };
}

export function formatCadence(minutes: number | null | undefined): string {
  return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? `${minutes}분` : '—';
}

/** 나이(분) → '12분 전' · '3.5시간 전'. 없으면 '—'. */
export function formatAgeMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  if (minutes < 60) return `${Math.round(minutes)}분 전`;
  if (minutes < 60 * 48) return `${Math.round((minutes / 60) * 10) / 10}시간 전`;
  return `${Math.floor(minutes / 1440)}일 전`;
}

/** 채움률 '97.9% (47/48)'. 분모가 없거나 0이면 '—' — 0% 로 보이면 '전부 빠졌다' 로 읽힌다. */
export function formatFillRate(coverage: Coverage): string {
  const { expected_buckets: expected, collected_buckets: collected, fill_rate: rate } = coverage;
  if (expected === null || expected <= 0 || rate === null) return '—';
  return `${(Math.round(rate * 1000) / 10).toFixed(1)}% (${collected}/${expected})`;
}

/** 마지막 시도(프로세스 메모리). 실패면 오류 코드를 그대로 — 관리자가 원인을 찾는 단서다. */
export function describeLastRun(run: TargetLastRun | null): string {
  if (!run || !run.state) return '이 서버 시작 뒤 시도 없음';
  const when = run.checked_at ? formatKst(run.checked_at) : '—';
  if (run.state === 'stored') return `${when} 저장`;
  const code = [run.error_code, run.upstream_code].filter(Boolean).join(' · ');
  return `${when} 실패${code ? ` (${code})` : ''}`;
}

// --- 파이프라인 전체 ---------------------------------------------------------------

/**
 * 맨 위 배너. **전부 최신이고 마지막 시도도 실패가 없을 때만** ok 다 — 9곳 중 1곳이라도 지연·행 없음이면
 * 그 사실이 제목에 선다. 표가 없거나 설정이 틀리면 대상지 숫자보다 그 사실과 할 일을 먼저 말한다.
 *
 * 마지막 시도(서버 메모리)를 함께 보는 이유: 인증키가 막히거나(seoul_key_invalid) 일 한도를 넘으면
 * (seoul_quota_exceeded) 그 순간부터 모든 시도가 실패하지만, DB 의 마지막 행은 신선도 기준(30~68분) 동안
 * 여전히 '최신' 이다. 행만 보면 그동안 배너가 초록으로 남는다.
 */
export function describePipeline(pipeline: RehearsalPipeline): StateNotice {
  if (pipeline.table_state === 'not_migrated') {
    return {
      tone: 'error',
      title: '수집 표가 없습니다 — 마이그레이션 미적용',
      detail: pipeline.human_step ?? '원본 표(seoul_citydata_snapshots) 마이그레이션을 SQL Editor 에서 적용해야 합니다(사람 작업).',
    };
  }
  if (pipeline.schedule_state === 'invalid_config') {
    return {
      tone: 'error',
      title: '대상지 설정 오류 — 수집이 멈춰 있습니다',
      detail: 'SEOUL_CITYDATA_TARGETS 의 주기 표기(이름@N+P)가 틀려 수집기가 호출 한도를 지키려고 멈췄습니다. Render 환경변수를 고쳐야 합니다(사람 작업).',
    };
  }
  if (pipeline.schedule_state === 'no_targets') {
    return { tone: 'error', title: '수집 대상지가 없습니다', detail: 'SEOUL_CITYDATA_TARGETS 가 비어 있습니다(사람 작업).' };
  }
  const configured = pipeline.targets.filter((t) => t.configured);
  const count = (state: TargetState) => configured.filter((t) => t.state === state).length;
  const fresh = count('fresh');
  const stale = count('stale');
  const empty = count('empty');
  const parts = [
    `${configured.length}곳 중 ${fresh}곳 최신`,
    stale > 0 ? `${stale}곳 지연` : null,
    empty > 0 ? `${empty}곳 행 없음` : null,
  ].filter((part): part is string => part !== null);
  const failedTargets = configured.filter((t) => t.last_run?.state === 'failed');
  const runFailed = pipeline.last_run?.state === 'failed';
  if (failedTargets.length > 0) {
    parts.push(`${failedTargets.length}곳 마지막 시도 실패`);
  } else if (runFailed) {
    // 대상지를 하나도 부르지 못한 실패(키 없음·설정 오류·표 없음) — 대상지별 기록이 없다.
    parts.push(`마지막 수집 실패${pipeline.last_run?.error_code ? `(${pipeline.last_run.error_code})` : ''}`);
  }
  const codes = Array.from(new Set(failedTargets.map((t) => t.last_run?.error_code).filter((c): c is string => Boolean(c))));
  const failureNote = failedTargets.length > 0 || runFailed
    ? ` 마지막 시도가 실패했습니다${codes.length > 0 ? `(${codes.join(', ')})` : ''} — DB 의 마지막 행이 아직 기준 안이어도 다음 행이 들어오지 않을 수 있습니다.`
    : '';
  const keyNote = pipeline.key_configured ? '' : ' 이 서버에는 서울 인증키(SEOUL_OPENDATA_KEY)가 없습니다 — 수집을 부를 수 없습니다.';
  const allFresh = fresh === configured.length && configured.length > 0;
  const tone: Tone = fresh === 0
    ? 'error'
    : allFresh && pipeline.key_configured && !failureNote ? 'ok' : 'warn';
  return {
    tone,
    title: parts.join(' · '),
    detail: `'최신' = 마지막 버킷이 그 대상지의 기준(${pipeline.stale_rule.formula}) 안에 있다는 뜻입니다.${failureNote}${keyNote}`,
  };
}

/** 호출 예산 한 줄 — 주 호출 + 보충 최악값 vs 일 한도. */
export function describeBudget(budget: CallBudget | null): string {
  if (!budget) return '설정이 틀려 호출 수를 셀 수 없습니다';
  const n = (value: number) => value.toLocaleString('ko-KR');
  const verdict = budget.within_limit ? `여유 ${n(budget.headroom_per_day)}회` : `한도 초과 ${n(-budget.headroom_per_day)}회`;
  return `주 호출 ${n(budget.primary_per_day)} + 보충 최악 ${n(budget.retry_worst_case_per_day)} = ${n(budget.worst_case_per_day)}회/일 · 한도 ${n(budget.limit_per_day)} · ${verdict}`;
}

/**
 * 채움률을 창 시작보다 늦게부터 셌으면 그 시각을 돌려준다(창 안에서 수집을 시작한 대상지). 아니면 null.
 * 이 표시가 없으면 '14일 채움률 100%' 가 '14일 내내 찼다' 로 읽힌다.
 */
export function countedSinceLabel(target: Pick<PipelineTarget, 'counted_since_at'>, windowStart: string | null | undefined): string | null {
  const since = target.counted_since_at;
  if (!since || !windowStart) return null;
  const sinceMs = Date.parse(since);
  const startMs = Date.parse(windowStart);
  if (!Number.isFinite(sinceMs) || !Number.isFinite(startMs) || sinceMs <= startMs) return null;
  return `${formatKst(since)} 수집 시작부터`;
}

// --- 정규화 표(zone_crowd_snapshots) ----------------------------------------------

const ZONE_WRITE_TEXT: Record<ZoneWriteState, string> = {
  stored: '마지막 수집의 정규화 관측을 전부 저장했습니다',
  partial: '마지막 수집에서 일부만 저장했습니다',
  migration_not_applied: '마지막 수집 때 정규화 표가 없어 저장하지 못했습니다',
  failed: '마지막 수집에서 정규화 관측을 하나도 저장하지 못했습니다',
  skipped: '마지막 수집에는 저장할 관측이 없었습니다(차례인 대상지가 없거나 원본 저장이 전부 실패)',
};

export function describeZones(zones: ZonesStatus | null): StateNotice {
  if (!zones) {
    return { tone: 'info', title: '정규화 표 상태를 받지 못했습니다', detail: '서버가 아직 이 항목을 보내지 않습니다(배포 전).' };
  }
  const write = zones.last_write?.state ?? null;
  const writeText = write
    ? `${(ZONE_WRITE_TEXT as Record<string, string>)[write] ?? write}${zones.last_write?.at ? ` (${formatKst(zones.last_write.at)})` : ''}.`
    : '이 서버가 시작된 뒤 아직 수집이 없어 마지막 저장 결과를 모릅니다.';
  const errors = Object.entries(zones.last_write?.errors ?? {});
  const errorText = errors.length > 0 ? ` 오류: ${errors.map(([zone, code]) => `${zone} ${code}`).join(', ')}.` : '';
  const step = zones.human_step ? ` 할 일: ${zones.human_step}` : '';
  switch (zones.table_state) {
    case 'not_migrated':
      return { tone: 'error', title: `정규화 표 미적용 — ${zones.migration}`, detail: `${writeText}${errorText}${step}` };
    case 'unavailable':
      return { tone: 'warn', title: '정규화 표를 읽지 못했습니다', detail: `${writeText}${errorText}${step}` };
    case 'empty':
      return { tone: 'warn', title: '정규화 표는 있지만 행이 없습니다', detail: `${writeText}${errorText}${step}` };
    case 'no_recent_rows':
      return {
        tone: 'warn',
        title: `정규화 표 — 최근 24시간 행 없음 (마지막 ${formatKst(zones.latest_bucket_at)})`,
        detail: `${writeText}${errorText}${step}`,
      };
    default: {
      const tone: Tone = write === 'stored' ? 'ok' : write === null ? 'info' : 'warn';
      return {
        tone,
        title: `정규화 표 저장 중 — 최근 24시간 ${zones.rows_24h ?? 0}행 · 마지막 ${formatAgeMinutes(zones.latest_age_minutes)}`,
        detail: `${writeText}${errorText}${step}`,
      };
    }
  }
}

// --- 결정 품질(S4) -------------------------------------------------------------------

/**
 * 블록 맨 위 알림. 결과가 없으면 숫자 자리를 만들지 않고 '아직 없음' 만 말한다. 요약 파일이 틀렸으면 숫자 없이
 * 어느 파일의 무엇이 틀렸는지만 — 일부 권역만 보여 '그 권역만 평가됐다' 로 읽히게 두지 않는다(서버도 같은 규칙).
 */
export function describeDecisionQuality(quality: DecisionQuality | null): StateNotice {
  const stage = quality?.stage ?? 'S4';
  if (quality?.state === 'invalid_summary') {
    return {
      tone: 'warn',
      title: `${stage} 결정 품질 요약 파일 오류 — 수치를 표시하지 않습니다`,
      detail: `${quality.reason ?? '요약 파일을 읽지 못했습니다'}. 재생 산출물(out/decision_quality/<권역>.json)을 이름·내용 그대로 다시 커밋해야 합니다.`,
    };
  }
  if (!quality || quality.state !== 'evaluated' || quality.clusters.length === 0) {
    return {
      tone: 'info',
      title: `${stage} 재생 평가 전 — 아직 없음`,
      detail: `분산 결정 재생 평가가 아직 돌지 않았습니다. 결과가 생기기 전에는 수치를 표시하지 않습니다.${quality?.criterion ? ` 합격 기준: ${quality.criterion}.` : ''}`,
    };
  }
  const names = quality.clusters.map((cluster) => clusterLabel(cluster.cluster)).join(' · ');
  return {
    tone: 'info',
    title: `${stage} 분산 결정 재생 결과 — ${names}`,
    detail: `과거 실측으로 '붐비는 출발지에서 고른 대안이 도착 때 덜 붐볐나' 를 다시 돌린 결과입니다.${quality.criterion ? ` 합격 기준: ${quality.criterion}.` : ''}`,
  };
}

const CLUSTER_LABEL: Record<string, string> = {
  hongdae: '홍대 권역',
  jongno: '종로 유산 권역',
  validation: '검증 대상지',
};

export function clusterLabel(cluster: string): string {
  return CLUSTER_LABEL[cluster] ?? cluster;
}

const RUN_LABEL: Record<string, { label: string; tone: Tone }> = {
  pilot: { label: '예비 — 기준 확정 전', tone: 'warn' },
  confirmatory: { label: '확인', tone: 'info' },
  exploratory: { label: '탐색', tone: 'info' },
};

/** 실행 성격 배지. 예비(pilot)는 기준을 확정하기 전 결과라 눈에 띄게 둔다. */
export function runLabelBadge(runLabel: string): { label: string; tone: Tone } {
  return RUN_LABEL[runLabel] ?? { label: runLabel, tone: 'warn' };
}

export type VerdictStatus = 'pass' | 'fail' | 'insufficient' | 'not_evaluable';

const VERDICT_LABEL: Record<VerdictStatus, string> = {
  pass: '통과',
  fail: '미달',
  insufficient: '표본 부족',
  not_evaluable: '평가 불가',
};
const VERDICT_TONE: Record<VerdictStatus, Tone> = { pass: 'ok', fail: 'error', insufficient: 'info', not_evaluable: 'info' };

export interface VerdictBadge {
  status: VerdictStatus | 'unknown';
  label: string;
  tone: Tone;
}

/** 판정 배지(아이콘·글자·색을 함께 쓴다 — 색만으로 말하지 않는다). 모르는 상태는 이름 그대로, 통과 색 없이. */
export function verdictBadge(status: string): VerdictBadge {
  if (Object.prototype.hasOwnProperty.call(VERDICT_LABEL, status)) {
    const known = status as VerdictStatus;
    return { status: known, label: VERDICT_LABEL[known], tone: VERDICT_TONE[known] };
  }
  return { status: 'unknown', label: status, tone: 'warn' };
}

const V4_RECOMMENDATION: Record<string, string> = {
  provider_forecast: '서울시 예측',
  persistence: '지속(지금 값 유지)',
  undetermined: '미정',
};

const REASON_TOKEN: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^n_distinct<(\d+)$/, (m) => `붐비는 출발지의 서로 다른 (출발지·버킷) ${m[1]}개 미만`],
  [/^crowded_days<(\d+)$/, (m) => `붐빈 날 ${m[1]}일 미만`],
  [/^episodes<(\d+)$/, (m) => `에피소드 ${m[1]}개 미만`],
  [/^n_disagree_distinct<(\d+)$/, (m) => `엔진≠가장 가까운 곳인 서로 다른 (출발지·버킷) ${m[1]}개 미만`],
  [/^disagree_days<(\d+)$/, (m) => `불일치가 있는 날 ${m[1]}일 미만`],
  [/^forecasts_disabled$/, () => '예측 반출 없음'],
  [/^empty_replicates>1%$/, () => '빈 재표본 1% 초과'],
  [/^no_estimate$/, () => '차를 계산할 수 없음'],
  [/^no_day_cluster_interval$/, () => '날짜 군집 t 구간을 계산할 수 없음'],
  [/^diff<([\d.]+)$/, (m) => `차가 기준 +${(Number(m[1]) * 100).toFixed(0)}%p 미만`],
  [/^gate_low<=0\(day_cluster_t\)$/, () => '판정 하한 ≤ 0 (날짜 군집 t 하한이 부트스트랩 하한보다 낮음)'],
  [/^gate_low<=0\(bootstrap\)$/, () => '판정 하한 ≤ 0 (부트스트랩 하한)'],
  [/^mae_provider>=mae_persistence$/, () => '서울시 예측 MAE 가 지속보다 낮지 않음'],
  [/^exact_provider<exact_persistence$/, () => '서울시 예측 정확 일치율이 지속보다 낮음'],
  [/^unattainable_by_construction$/, () => '구조상 달성 불가'],
];

/** V3 사유 코드('insufficient: n_distinct<100, …; unattainable_by_construction') → 한국어. 모르는 토큰은 그대로 둔다. */
export function describeV3Reason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const tokens = reason
    .split(/[;,]/)
    .map((part) => part.replace(/^\s*insufficient:\s*/, '').trim())
    .filter(Boolean);
  const words = tokens.map((token) => {
    for (const [pattern, render] of REASON_TOKEN) {
      const match = token.match(pattern);
      if (match) return render(match);
    }
    return token;
  });
  return words.length > 0 ? Array.from(new Set(words)).join(' · ') : null;
}

function pct(value: number | null | undefined): string {
  return isNum(value) ? `${(Math.round(value * 1000) / 10).toFixed(1)}%` : '—';
}

function signedPoints(value: number): string {
  const rounded = Math.round(value * 1000) / 10;
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '';
  return `${sign}${Math.abs(rounded).toFixed(1)}`;
}

/** 비율의 차 → '+7.0%p'. 없으면 '—'. */
export function formatPointDiff(value: number | null | undefined): string {
  return isNum(value) ? `${signedPoints(value)}%p` : '—';
}

/** 95% CI → '[+2.0, +12.0]'(%p). 한쪽이라도 없으면 '[—]'. */
export function formatPointCi(low: number | null | undefined, high: number | null | undefined): string {
  return isNum(low) && isNum(high) ? `[${signedPoints(low)}, ${signedPoints(high)}]` : '[—]';
}

const APPROXIMATE_CI = 'approximate (blocks < 20)';

export interface DecisionQualityCard {
  cluster: string;
  title: string;
  zones: string;
  runBadge: { label: string; tone: Tone };
  v3Badge: VerdictBadge;
  /** criterion_attainable=false 일 때만 — 통과가 구조적으로 불가능하다는 사실(미달·표본 부족과 다른 말이다). */
  unattainable: string | null;
  v3Reason: string | null;
  sampleLine: string;
  hitLine: string;
  contrastLines: string[];
  /** '지금보다 덜 붐빔' 은 머물기 기준값과 함께만 — 머물러도 시간이 지나면 덜 붐빌 수 있어서 홀로 세우지 않는다. */
  nowLine: string | null;
  v4Badge: VerdictBadge;
  v4Line: string;
  thinNote: string | null;
  notes: string[];
  /** 한계 첫 줄(서울에는 사용자가 없다) — 카드에 항상 보인다. */
  firstLimit: string | null;
  moreLimits: string[];
  criteriaLine: string;
}

/** 서로 다른 (출발지·버킷) 수 — 최소 표본 판정의 단위. 이전 요약(값 없음)은 아무것도 붙이지 않는다. */
function distinct(value: number | null): string {
  return isNum(value) ? `(서로 다른 출발지·버킷 ${value})` : '';
}

function mae(value: number | null): string {
  return isNum(value) ? value.toFixed(3) : '—';
}

/** 요약 한 권역 → 카드 문장. 문장은 숫자와 정의만 말한다(스스로를 평가하는 말 · 결론을 앞질러 쓰는 말을 쓰지 않는다). */
export function decisionQualityCard(cluster: DecisionQualityCluster): DecisionQualityCard {
  const v3 = cluster.verdicts.V3;
  const v4 = cluster.verdicts.V4;
  const approx = v3.ci_label === APPROXIMATE_CI ? ', 근사' : '';
  const hit = cluster.hit_rate;
  const contrast = (label: string, block: CiBlock) =>
    `${label} 대비 차 ${formatPointDiff(block.diff)} (95% CI ${formatPointCi(block.ci_low, block.ci_high)}${approx})`;
  const now = cluster.hit_vs_now;
  const v4Sample = isNum(v4.n) ? ` (n=${v4.n}${isNum(v4.days) ? ` · ${v4.days}일` : ''})` : '';
  const [firstLimit, ...moreLimits] = cluster.limits;
  const { first_decision_at: first, last_decision_at: last } = cluster.period;
  const period = first && last ? `${first}~${last}` : '기간 —';
  return {
    cluster: cluster.cluster,
    title: clusterLabel(cluster.cluster),
    zones: cluster.zones.join(' · '),
    runBadge: runLabelBadge(cluster.run_label),
    v3Badge: verdictBadge(v3.status),
    unattainable: v3.criterion_attainable !== false
      ? null
      : `구조상 달성 불가 — 오라클(도착 때 정답을 아는 선택)과 가장 가까운 곳의 적중률 차(여유) ${pct(v3.headroom)}가 기준 +10%p 에 못 미칩니다`,
    v3Reason: describeV3Reason(v3.reason),
    sampleLine: `n=${v3.n}${distinct(v3.n_distinct)} · ${v3.days}일 · 불일치 ${v3.n_disagree}${distinct(v3.n_disagree_distinct)} · 여유 ${pct(v3.headroom)}`,
    hitLine: `엔진 적중 ${pct(hit.engine)} vs 가장 가까운 곳 ${pct(hit.nearest)} (차 ${formatPointDiff(v3.diff)}, 95% CI ${formatPointCi(v3.ci_low, v3.ci_high)}${approx}${
      isNum(v3.gate_low) ? ` · 판정 하한 ${formatPointDiff(v3.gate_low)}` : ''
    })`,
    contrastLines: [
      contrast('시간대 평균 선택', cluster.contrasts.engine_minus_climatology),
      contrast('현재 등급 탐욕', cluster.contrasts.engine_minus_greedy),
    ],
    nowLine:
      isNum(now.engine) && isNum(now.stay)
        ? `참고 — 도착 때 출발 시점보다 덜 붐빔: 엔진 ${pct(now.engine)} · 머물기 ${pct(now.stay)}`
        : null,
    v4Badge: verdictBadge(v4.status),
    v4Line: `V4 리드 ${v4.lead_bin}분 — 권장 ${V4_RECOMMENDATION[v4.recommendation] ?? v4.recommendation} · MAE 서울시 예측 ${mae(v4.mae_provider)} vs 지속 ${mae(v4.mae_persistence)}${v4Sample}${
      v4.status === 'fail' && v4.reason ? ` · 사유: ${describeV3Reason(v4.reason)}` : ''
    }`,
    thinNote: cluster.thin_cluster
      ? `대안이 출발지마다 ${cluster.alternatives_per_origin}곳뿐인 작은 권역입니다 — 엔진과 가장 가까운 곳이 갈리는 경우가 적어 참고 결과로 읽습니다.`
      : null,
    notes: cluster.notes,
    firstLimit: firstLimit ?? null,
    moreLimits,
    criteriaLine: `기준 ${cluster.criteria_version}${cluster.code_version ? ` · 코드 ${cluster.code_version}` : ''} · ${period} · 붐비는 출발지 결정만`,
  };
}

/** evaluated 일 때만 카드(권역 이름순 — 서버 순서 그대로). 그 밖에는 빈 목록. */
export function decisionQualityCards(quality: DecisionQuality | null): DecisionQualityCard[] {
  if (!quality || quality.state !== 'evaluated') return [];
  return quality.clusters.map(decisionQualityCard);
}

// --- 지표 표본 기간 ------------------------------------------------------------------

/**
 * 최소 표본(버킷 개수)이 덮는 시간. 버킷 36개는 10분 주기면 6시간, 30분 주기면 18시간이다 —
 * '36개 = 6시간' 을 고정 문구로 두면 30분 대상지에서 틀린 말이 된다.
 */
export function sampleSpan(minSamples: number, gapMinutes: number | null | undefined): string {
  if (typeof gapMinutes !== 'number' || !Number.isFinite(gapMinutes) || gapMinutes <= 0) return `버킷 ${minSamples}개`;
  const hours = (minSamples * gapMinutes) / 60;
  const text = hours >= 48 ? `${Math.round((hours / 24) * 10) / 10}일` : `${Math.round(hours * 10) / 10}시간`;
  return `버킷 ${minSamples}개 ≈ ${text}(간격 ${Math.round(gapMinutes)}분)`;
}

/** 시계열 차트의 '끊김' 판정 간격 — 실제 버킷 간격(없으면 설정 주기, 그것도 없으면 10분). */
export function chartStepMinutes(gapMinutes: number | null | undefined, cadenceMinutes: number | null | undefined): number {
  if (typeof gapMinutes === 'number' && Number.isFinite(gapMinutes) && gapMinutes > 0) return gapMinutes;
  if (typeof cadenceMinutes === 'number' && Number.isFinite(cadenceMinutes) && cadenceMinutes > 0) return cadenceMinutes;
  return 10;
}

// --- 보정 표본 속도 ------------------------------------------------------------------

/**
 * 보정 관문(짝지은 버킷 N개)이 지금 주기로 얼마나 걸리나. 보정 대상지(명동·동대문)가 30분 주기면 하루
 * 최대 48쌍/곳 — 10분 시절보다 3배 느리다. 과거 행으로 이미 넘었더라도 창이 밀리면 다시 그 속도로 채운다.
 */
export function calibrationPace(
  places: string[],
  targets: PipelineTarget[],
  paired: number,
  minPaired: number,
): string | null {
  const cadences = places
    .map((name) => targets.find((t) => t.area_nm === name)?.cadence_minutes ?? null)
    .filter((c): c is number => typeof c === 'number' && c > 0);
  if (cadences.length === 0) return null;
  const perDay = cadences.reduce((sum, cadence) => sum + Math.floor(1440 / cadence), 0);
  const unique = Array.from(new Set(cadences)).map((c) => `${c}분`).join('·');
  const head = `보정 대상지 수집 주기 ${unique} — 하루 최대 ${perDay}쌍(전부 수집되고 주차 신호가 있을 때)`;
  if (paired >= minPaired) return `${head}. 최소 ${minPaired}쌍은 채웠습니다.`;
  const days = Math.ceil((minPaired - paired) / perDay);
  return `${head}. 최소 ${minPaired}쌍까지 ${minPaired - paired}쌍 남음 — 빨라도 약 ${days}일.`;
}
