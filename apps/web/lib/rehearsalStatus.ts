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

export interface DecisionQuality {
  state: 'not_evaluated' | string;
  stage: string;
  criterion: string;
  result: unknown;
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

export function parseDecisionQuality(raw: unknown): DecisionQuality | null {
  if (!isRecord(raw) || typeof raw.state !== 'string') return null;
  return {
    state: raw.state,
    stage: typeof raw.stage === 'string' ? raw.stage : 'S4',
    criterion: typeof raw.criterion === 'string' ? raw.criterion : '',
    result: raw.result ?? null,
  };
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

/** 결정 품질은 S4 재생 평가가 만든다. 그 전에는 숫자 자리를 만들지 않고 '아직 없음' 만 말한다. */
export function describeDecisionQuality(quality: DecisionQuality | null): StateNotice {
  if (!quality || quality.state === 'not_evaluated' || quality.result === null || quality.result === undefined) {
    return {
      tone: 'info',
      title: `${quality?.stage ?? 'S4'} 재생 평가 전 — 아직 없음`,
      detail: `분산 결정 재생 평가가 아직 돌지 않았습니다. 결과가 생기기 전에는 수치를 표시하지 않습니다.${quality?.criterion ? ` 합격 기준: ${quality.criterion}.` : ''}`,
    };
  }
  return { tone: 'info', title: `${quality.stage} 결과 수신`, detail: '결과 표시는 S4 와 함께 추가됩니다.' };
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
