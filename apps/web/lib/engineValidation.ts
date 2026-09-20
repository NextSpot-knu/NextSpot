// 엔진 검증(서울 실시간 도시데이터 대비) 화면의 순수 판정 — docs/CONGESTION_ENGINE_PLAN.md §5.3·§5.4 A·§6.
//
// 응답은 GET /api/v1/admin/engine-validation/seoul/summary 이고 lib/admin-api.ts 를 거친다.
// admin-api 는 케이스 변환을 하지 않으므로 **필드는 서버와 같은 snake_case** 다.
//
// 이 파일이 따로 있는 이유: 이 화면은 처음 몇 주 동안 '데이터 없음' 상태로 살아야 한다(서울 API 는
// 이력을 주지 않아 수집을 시작한 날부터 표본이 쌓인다). 그 기간의 문구가 틀리면 — 예컨대 수집 전을
// '엔진이 틀렸다' 로, 멈춘 수집을 '아직 모인 중' 으로 읽히면 — 화면이 거짓말을 한다. 판정을 순수 함수로
// 빼서 테스트가 잠근다(engineValidation.test.ts).

import { describeAdminFailure, type AdminFailureKind, type AdminFailureNotice } from './adminApiFailure';

export const ENGINE_VALIDATION_PATH = '/api/v1/admin/engine-validation/seoul/summary';
export const WINDOW_OPTIONS = [7, 14, 28] as const;
export const DEFAULT_WINDOW_DAYS = 14;
export const SEOUL_ATTRIBUTION = '출처: 서울특별시 서울 실시간 도시데이터 (공공누리 제1유형)';
export const GRADE_LABELS = ['여유', '보통', '약간 붐빔', '붐빔'] as const;

export type ValidationState = 'not_migrated' | 'empty' | 'stalled' | 'collecting' | 'ready';
export type MetricStatus = 'pass' | 'fail' | 'insufficient' | 'report';
export type MetricUnit = 'ratio' | 'rho' | 'mae';
export type MetricDirection = 'gte' | 'lte' | 'report';

export interface ValidationMetric {
  key: string;
  label: string;
  value: number | null;
  n: number;
  min_n: number;
  threshold: number | null;
  direction: MetricDirection;
  unit: MetricUnit;
  status: MetricStatus;
  definition: string;
  reason: string | null;
  baseline_label?: string;
  baseline_mae?: number | null;
  missed?: number;
  covered?: number;
  ours_mae_same_sample?: number | null;
}

export interface OmittedMetric {
  key: string;
  label: string;
  reason: string;
}

export interface SeriesPoint {
  bucket_at: string;
  normalized_actual: number | null;
  level_est: number | null;
  actual_grade: number | null;
  estimated_grade: number | null;
  congest_lvl: string | null;
  ppltn_min: number | null;
  ppltn_max: number | null;
  parking_level: number | null;
  tourism_level: number | null;
}

export interface PlaceSummary {
  area_cd: string | null;
  area_nm: string | null;
  row_count: number;
  bucket_count: number;
  first_bucket_at: string | null;
  last_bucket_at: string | null;
  first_observed_at: string | null;
  last_observed_at: string | null;
  hours_covered: number;
  days_covered: number;
  kst_dates: string[];
  estimator_version: string | null;
  estimator_versions_in_window: string[];
  excluded_other_version_rows: number;
  latest_live_lot_count: number | null;
  zero_live_lot_buckets: number;
  sufficient: boolean;
  normalization: { method: string; max_midpoint: number | null; max_midpoint_bucket_at: string | null };
  metrics: ValidationMetric[];
  omitted_metrics: OmittedMetric[];
  confusion: { labels: string[]; matrix: number[][]; total: number };
  series: SeriesPoint[];
}

export interface CollectionStatus {
  row_count: number;
  first_bucket_at: string | null;
  last_bucket_at: string | null;
  first_observed_at: string | null;
  last_observed_at: string | null;
  hours_collected: number;
  latest_bucket_at: string | null;
  latest_age_minutes: number | null;
  stale: boolean;
  stale_after_minutes: number;
}

export interface ValidationSummary {
  state: ValidationState;
  window_days: number;
  window_start: string;
  generated_at: string;
  migration: string;
  grade_labels: string[];
  estimate_grade_edges: number[];
  min_samples: number;
  min_danger_samples: number;
  omitted_metrics: OmittedMetric[];
  collection: CollectionStatus | null;
  places: PlaceSummary[];
}

const STATES: readonly ValidationState[] = ['not_migrated', 'empty', 'stalled', 'collecting', 'ready'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 응답이 이 화면이 아는 모양인지 확인한다. 모르는 모양이면 null — 부분만 그려서
 * '지표가 비어 있다' 로 오해하게 두지 않고, 호출부가 형식 오류로 말하게 한다.
 */
export function parseSummary(raw: unknown): ValidationSummary | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.state !== 'string' || !STATES.includes(raw.state as ValidationState)) return null;
  if (!Array.isArray(raw.places)) return null;
  const places = (raw.places as unknown[]).filter(
    (place): place is PlaceSummary =>
      isRecord(place) && Array.isArray(place.metrics) && Array.isArray(place.series),
  );
  return {
    ...(raw as unknown as ValidationSummary),
    places,
    omitted_metrics: Array.isArray(raw.omitted_metrics) ? (raw.omitted_metrics as OmittedMetric[]) : [],
    collection: isRecord(raw.collection) ? (raw.collection as unknown as CollectionStatus) : null,
    min_samples: typeof raw.min_samples === 'number' ? raw.min_samples : 36,
  };
}

// --- 조회 실패 -------------------------------------------------------------------

export interface FetchFailureInput {
  kind?: AdminFailureKind | null;
  status?: number | null;
  message?: string | null;
}

/**
 * 조회 실패 → 관리자 문장. 두 경우만 이 화면 고유로 다루고 나머지는 공용 판정(adminApiFailure)에 맡긴다.
 *
 *  · 404 — 웹이 API 보다 먼저 배포된 상태(배포 순서 차이). 서버 장애가 아니다.
 *  · 503 engine_validation_unavailable — 표는 있는데 읽기에 실패했다(스키마 불일치 포함).
 */
export function describeFetchFailure(input: FetchFailureInput): AdminFailureNotice {
  const status = typeof input.status === 'number' ? input.status : null;
  const message = input.message?.trim() || null;
  if (status === 404) {
    return {
      title: 'API 서버에 아직 이 화면의 엔드포인트가 없어요',
      action: '웹이 API 보다 먼저 배포된 상태입니다. API 배포(엔진 검증 라우터 등록)가 끝나면 다시 열어 주세요.',
      href: null,
      retryable: true,
      detail: message ? `HTTP 404 · ${message}` : 'HTTP 404',
    };
  }
  if (status === 503 && message === 'engine_validation_unavailable') {
    return {
      title: '검증 표본을 읽지 못했어요',
      action: '서버가 seoul_citydata_snapshots 조회에 실패했습니다. 다시 시도해 보고, 계속되면 API 로그의 engine_validation_summary_failed 를 확인해 주세요.',
      href: null,
      retryable: true,
      detail: `HTTP 503 · ${message}`,
    };
  }
  return describeAdminFailure({ kind: input.kind ?? null, status, message });
}

// --- 상태 배너 --------------------------------------------------------------------

export type Tone = 'ok' | 'info' | 'warn' | 'error';

export interface StateNotice {
  tone: Tone;
  title: string;
  detail: string;
}

/** 시간 길이를 사람이 읽는 말로. 48시간 미만은 시간, 그 이상은 일·시간. */
export function formatDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '0시간';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}분`;
  if (hours < 48) return `${Math.round(hours * 10) / 10}시간`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours - days * 24);
  return rest > 0 ? `${days}일 ${rest}시간` : `${days}일`;
}

function formatAge(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '알 수 없음';
  if (minutes < 60) return `${Math.round(minutes)}분 전`;
  return `${formatDuration(minutes / 60)} 전`;
}

/** 수집·판정 상태를 한 줄 제목 + 설명으로. place 는 선택된 대상지(없으면 전체 기준). */
export function describeState(summary: ValidationSummary, place: PlaceSummary | null): StateNotice {
  const collection = summary.collection;
  switch (summary.state) {
    case 'not_migrated':
      return {
        tone: 'warn',
        title: '수집 시작 전 — 검증 표가 아직 없습니다',
        detail: `마이그레이션 ${summary.migration || '20260920120000_seoul_citydata_snapshots.sql'} 이 적용되지 않았습니다. 적용 후 서울 인증키(SEOUL_OPENDATA_KEY)와 수집 잡이 켜지면 10분마다 표본이 쌓입니다.`,
      };
    case 'empty':
      return {
        tone: 'info',
        title: '수집 시작 전 — 표본 0개',
        detail: '검증 표는 준비됐지만 아직 한 줄도 쌓이지 않았습니다. 서울 인증키(SEOUL_OPENDATA_KEY)와 pg_cron 수집 잡 등록을 확인하세요. 서울 API 는 과거 데이터를 주지 않아 수집을 시작한 날부터만 표본이 생깁니다.',
      };
    case 'stalled':
      return {
        tone: 'error',
        title: '수집이 멈췄습니다',
        detail: `최근 ${summary.window_days}일 창 안에 표본이 없습니다. 마지막 버킷은 ${formatAge(collection?.latest_age_minutes ?? null)}입니다. 인증키 만료·호출 한도·수집 잡을 확인하세요.`,
      };
    default:
      break;
  }
  const hours = place?.hours_covered ?? collection?.hours_collected ?? 0;
  const buckets = place?.bucket_count ?? collection?.row_count ?? 0;
  const staleSuffix = collection?.stale
    ? ` 단, 최근 버킷이 ${formatAge(collection.latest_age_minutes)}이라 수집이 밀리거나 멈췄을 수 있습니다.`
    : '';
  const sufficient = place ? place.sufficient : summary.state === 'ready';
  if (!sufficient) {
    return {
      tone: collection?.stale ? 'warn' : 'info',
      title: `수집 ${formatDuration(hours)}째 — 표본 부족`,
      detail: `버킷 ${buckets}개 / 판정 최소 ${summary.min_samples}개(${formatDuration((summary.min_samples * 10) / 60)}). 값은 보이지만 통과·미달 판정은 표본이 찰 때까지 보류합니다.${staleSuffix}`,
    };
  }
  return {
    tone: collection?.stale ? 'warn' : 'ok',
    title: `수집 ${formatDuration(hours)}째 · ${place?.days_covered ?? 0}일치 표본`,
    detail: `버킷 ${buckets}개로 판정했습니다. 통과하지 못한 지표도 그대로 표시합니다.${staleSuffix}`,
  };
}

/** 표본 기간 주의 문구 — 한 곳·짧은 기간이라는 사실을 결과 옆에 항상 붙인다(§4 반영 4). */
export function sampleCaveat(place: PlaceSummary | null, placeCount: number): string {
  const days = place?.days_covered ?? 0;
  const where = placeCount <= 1 ? '서울 1곳' : `서울 ${placeCount}곳 중 1곳`;
  return `${where}, ${days}일 — 여러 장소에서 검증한 것이 아니다. 주말·축제·우천이 표본에 몇 번 들어갔는지에 따라 값이 크게 흔들린다.`;
}

// --- 지표 표시 --------------------------------------------------------------------

function percent(value: number): string {
  return `${(Math.round(value * 1000) / 10).toFixed(1)}%`;
}

export function formatMetricValue(metric: Pick<ValidationMetric, 'value' | 'unit'>): string {
  const { value, unit } = metric;
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (unit === 'ratio') return percent(value);
  if (unit === 'rho') return value.toFixed(2);
  return value.toFixed(3);
}

/** 통과 기준을 문장으로. MAE 는 기준값이 '지속 모델 MAE' 라 숫자만 쓰면 뜻이 없다. */
export function formatThreshold(metric: ValidationMetric): string {
  if (metric.direction === 'report') return '기준 없음 · 보고용';
  if (metric.unit === 'mae') {
    const base = metric.baseline_mae;
    const label = metric.baseline_label ?? '지속 모델';
    return typeof base === 'number' ? `${label}(${base.toFixed(3)})보다 낮을 것` : `${label}보다 낮을 것`;
  }
  if (metric.threshold === null) return '—';
  const sign = metric.direction === 'gte' ? '≥' : '≤';
  const value = metric.unit === 'ratio' ? `${Math.round(metric.threshold * 100)}%` : metric.threshold.toFixed(2);
  return `${sign} ${value}`;
}

export const STATUS_LABEL: Record<MetricStatus, string> = {
  pass: '통과',
  fail: '미달',
  insufficient: '표본 부족',
  report: '보고용',
};

export function statusLabel(status: string): string {
  return (STATUS_LABEL as Record<string, string>)[status] ?? status;
}

/** 표본 표기 — 판정 지표는 최소치와 함께, 보고 지표는 n 만. */
export function formatSample(metric: ValidationMetric): string {
  if (metric.direction === 'report' || metric.min_n <= 0) return `n=${metric.n}`;
  return `n=${metric.n} / 최소 ${metric.min_n}`;
}

/** 판정 지표 중 통과·미달·부족 개수(보고용 제외). */
export function tallyMetrics(metrics: ValidationMetric[]): { pass: number; fail: number; insufficient: number } {
  const judged = metrics.filter((metric) => metric.direction !== 'report');
  return {
    pass: judged.filter((metric) => metric.status === 'pass').length,
    fail: judged.filter((metric) => metric.status === 'fail').length,
    insufficient: judged.filter((metric) => metric.status === 'insufficient').length,
  };
}

// --- 시계열 ----------------------------------------------------------------------

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** ISO → 'MM.DD HH:mm'(KST). 브라우저 시간대와 무관하게 KST 로 고정한다. */
export function formatKst(iso: string | null | undefined): string {
  if (!iso) return '—';
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '—';
  const d = new Date(time + KST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export interface ChartRow {
  t: number;
  label: string;
  actual: number | null;
  estimate: number | null;
  actualGrade: string | null;
  estimateGrade: string | null;
}

function gradeName(index: number | null): string | null {
  return index === null || index === undefined ? null : (GRADE_LABELS[index] ?? null);
}

/**
 * 차트 행. 10분 간격이 끊긴 자리(수집 누락)는 null 행을 끼워 선이 그 구간을 **잇지 않게** 한다 —
 * 이어 그리면 관측이 없던 시간이 '완만한 추세' 로 보인다(adminSeriesGaps 와 같은 원칙).
 */
export function chartRows(series: SeriesPoint[], stepMinutes = 10): ChartRow[] {
  const rows: ChartRow[] = [];
  let previous: number | null = null;
  const stepMs = stepMinutes * 60 * 1000;
  for (const point of series) {
    const t = Date.parse(point.bucket_at);
    if (!Number.isFinite(t)) continue;
    if (previous !== null && t - previous > stepMs * 1.5) {
      const gapAt = previous + stepMs;
      rows.push({ t: gapAt, label: formatKst(new Date(gapAt).toISOString()), actual: null, estimate: null, actualGrade: null, estimateGrade: null });
    }
    rows.push({
      t,
      label: formatKst(point.bucket_at),
      actual: point.normalized_actual,
      estimate: point.level_est,
      actualGrade: gradeName(point.actual_grade) ?? point.congest_lvl,
      estimateGrade: gradeName(point.estimated_grade),
    });
    previous = t;
  }
  return rows;
}

/** 혼동표 칸의 성격. 대각 = 일치, 실측 붐빔인데 여유·보통 = 위험 오분류. */
export function confusionCellKind(actual: number, estimate: number): 'match' | 'danger' | 'near' | 'far' {
  if (actual === estimate) return 'match';
  if (actual === 3 && estimate <= 1) return 'danger';
  return Math.abs(actual - estimate) <= 1 ? 'near' : 'far';
}

/** 날짜 선택에 쓰는 쿼리 경로. 범위 밖 값은 기본 14일로 되돌린다(서버도 1~28만 받는다). */
export function summaryPath(days: number): string {
  const safe = Number.isInteger(days) && days >= 1 && days <= 28 ? days : DEFAULT_WINDOW_DAYS;
  return `${ENGINE_VALIDATION_PATH}?days=${safe}`;
}
