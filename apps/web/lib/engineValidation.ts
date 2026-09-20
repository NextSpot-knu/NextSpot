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

// =====================================================================================
// 실시간 인구로 돌린 대안 추천 (§5.4 A2)
// =====================================================================================
//
// GET /api/v1/admin/engine-validation/seoul/alternatives?origin=…
//
// 이 블록이 summary 와 섞이면 안 되는 이유: summary 는 "우리 추정이 실측을 맞히나" 이고, 여기는
// "실시간 인구가 있으면 SPOT 이 어떻게 도나" 다. 값의 출처가 통째로 다르다(여기는 100% 서울 실측).
// 문구가 그 차이를 흐리면 심사에서 "추정으로 만든 추천을 실측처럼 보여 줬다" 가 된다.

export const ALTERNATIVES_PATH = '/api/v1/admin/engine-validation/seoul/alternatives';
export const DEFAULT_ORIGIN = '홍대 관광특구';

export type AlternativesState = 'not_migrated' | 'empty' | 'stale' | 'ready';

export interface ClusterPlace {
  area_cd: string;
  area_nm: string;
  latitude: number;
  longitude: number;
}

export interface AlternativePlace extends ClusterPlace {
  is_origin: boolean;
  has_data: boolean;
  source: string;
  bucket_at: string | null;
  observed_at: string | null;
  age_minutes: number | null;
  stale: boolean;
  congest_lvl: string | null;
  grade: number | null;
  level: number | null;
  ppltn_min: number | null;
  ppltn_max: number | null;
  ppltn_midpoint: number | null;
  normalized_population: number | null;
  lookback_max_midpoint: number | null;
  lookback_max_bucket_at: string | null;
  lookback_buckets: number;
  straight_distance_m: number;
  walk_distance_m: number;
  walk_minutes: number;
  walk_source: string;
  crowd_wait_minutes: number | null;
  cost_minutes: number | null;
  rank: number | null;
  reason: string | null;
}

export interface AlternativeRecommendation {
  origin: string;
  origin_congest_lvl: string | null;
  origin_grade: number | null;
  origin_cost_minutes: number | null;
  origin_stale: boolean;
  best: string | null;
  best_congest_lvl: string | null;
  best_grade: number | null;
  best_walk_minutes: number | null;
  best_cost_minutes: number | null;
  better: boolean;
  grade_gap: number;
  beats_origin_cost: boolean;
  top_ranked: string | null;
  ranking_note: string;
  reason: string | null;
}

export interface AlternativesResponse {
  state: AlternativesState;
  generated_at: string;
  migration: string;
  origin: string;
  default_origin: string;
  cluster: ClusterPlace[];
  source: string;
  source_note: string;
  attribution: string;
  stale_after_minutes: number;
  lookback_days: number;
  grade_labels: string[];
  grade_levels: Record<string, number>;
  walking: { method: string; speed_m_per_min: number; route_factor: number; note: string };
  latest_bucket_at: string | null;
  latest_age_minutes: number | null;
  places: AlternativePlace[];
  ranking: string[];
  recommendation: AlternativeRecommendation | null;
}

const ALTERNATIVE_STATES: readonly AlternativesState[] = ['not_migrated', 'empty', 'stale', 'ready'];

/** 출발지를 쿼리에 싣는다. 대상지 이름은 한글·공백이라 반드시 인코딩한다. */
export function alternativesPath(origin: string): string {
  const name = (origin ?? '').trim() || DEFAULT_ORIGIN;
  return `${ALTERNATIVES_PATH}?origin=${encodeURIComponent(name)}`;
}

/** 모르는 모양이면 null — 부분만 그려서 '대안이 없다' 로 읽히게 두지 않는다(parseSummary 와 같은 규칙). */
export function parseAlternatives(raw: unknown): AlternativesResponse | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.state !== 'string' || !ALTERNATIVE_STATES.includes(raw.state as AlternativesState)) return null;
  if (!Array.isArray(raw.places) || !Array.isArray(raw.cluster)) return null;
  const places = (raw.places as unknown[]).filter(
    (place): place is AlternativePlace => isRecord(place) && typeof place.area_nm === 'string',
  );
  return {
    ...(raw as unknown as AlternativesResponse),
    places,
    cluster: (raw.cluster as unknown[]).filter((p): p is ClusterPlace => isRecord(p) && typeof p.area_nm === 'string'),
    ranking: Array.isArray(raw.ranking) ? (raw.ranking as string[]) : [],
    recommendation: isRecord(raw.recommendation) ? (raw.recommendation as unknown as AlternativeRecommendation) : null,
  };
}

/** 걷는 시간 — 분 단위. 1분 미만은 '1분 미만'(0분이라고 쓰면 같은 자리라는 뜻이 된다). */
export function formatWalk(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  if (minutes <= 0) return '여기';
  if (minutes < 1) return '1분 미만';
  return `${Math.round(minutes)}분`;
}

/** 인구 범위. 서울시가 범위로 주므로 한 숫자로 줄이지 않는다 — 중앙값은 가늠자일 뿐이다. */
export function formatPopulationRange(min: number | null, max: number | null): string {
  const n = (value: number) => Math.round(value).toLocaleString('ko-KR');
  if (min !== null && max !== null && Number.isFinite(min) && Number.isFinite(max)) {
    return `${n(min)}~${n(max)}명`;
  }
  const only = [min, max].find((value) => value !== null && Number.isFinite(value));
  return only !== undefined && only !== null ? `약 ${n(only)}명` : '—';
}

/** 상태 배너. summary 와 같은 어법이되 이 블록이 답해야 하는 네 가지만 다룬다. */
export function describeAlternativesState(data: AlternativesResponse): StateNotice {
  switch (data.state) {
    case 'not_migrated':
      return {
        tone: 'warn',
        title: '수집 시작 전 — 검증 표가 아직 없습니다',
        detail: `마이그레이션 ${data.migration || '20260920120000_seoul_citydata_snapshots.sql'} 이 적용되면 10분마다 세 곳의 실측 인구가 쌓이고, 이 블록이 그 값으로 돕니다.`,
      };
    case 'empty':
      return {
        tone: 'info',
        title: '수집 시작 전 — 실측 인구 0건',
        detail: '표는 준비됐지만 시연 권역(홍대·연남동·합정역) 행이 아직 없습니다. 서울 API 는 과거 데이터를 주지 않아 수집을 시작한 시각부터만 값이 생깁니다.',
      };
    case 'stale':
      return {
        tone: 'warn',
        title: `지금 값이 아닙니다 — 마지막 실측 ${formatAge(data.latest_age_minutes)}`,
        detail: `수집 주기는 10분이고 ${data.stale_after_minutes}분이 넘으면 '지금'이라고 말하지 않습니다. 아래 값은 마지막으로 받은 관측이며, 그 시각과 함께 읽어 주세요.`,
      };
    default:
      return {
        tone: 'ok',
        title: `서울시 실측 인구 · ${formatAge(data.latest_age_minutes)} 관측`,
        detail: '아래 등급·인구·순위는 전부 서울시가 잰 값으로 만들었습니다. 우리 추정치(level_est)는 한 번도 쓰지 않습니다.',
      };
  }
}

/**
 * 주제 조사 '은/는'. 앞 글자에 받침이 있으면 '은'.
 *
 * 대상지 이름은 설정값이라(늘릴 수 있다) 문장에 조사를 박아 둘 수 없다 — 그러면 '연남동는' 같은
 * 문장이 관리자 화면에 그대로 나간다. 한글 음절은 0xAC00 부터 종성 28개 주기로 배열돼 있어
 * 나머지로 판별한다. 한글이 아닌 글자로 끝나면 '는'(가장 무난한 쪽)으로 둔다.
 */
export function topicParticle(word: string): string {
  const last = (word ?? '').trim().slice(-1);
  if (!last) return '는';
  const code = last.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return '는';
  return code % 28 === 0 ? '는' : '은';
}

/**
 * 추천 한 줄. **말할 수 있는 것만 말한다** — 이 함수가 이 블록의 정직성을 결정한다.
 *
 *  · 표본이 없으면 추천하지 않는다.
 *  · 실측이 30분보다 오래됐으면 '지금' 이라고 쓰지 않고 관측 시각을 쓴다.
 *  · 이웃이 덜 붐비지 않으면 "옮길 이유가 없다" 고 말한다(대안을 지어내지 않는다).
 *  · 덜 붐비지만 걷는 시간이 그 이득보다 크면 그 사실을 덧붙인다(비용 축은 SPOT 과 같다).
 */
export function alternativeSentence(data: AlternativesResponse): string {
  const r = data.recommendation;
  if (data.state === 'not_migrated' || data.state === 'empty' || !r) {
    return '실측 인구가 아직 들어오지 않아 대안을 계산할 수 없습니다.';
  }
  if (r.origin_grade === null || !r.origin_congest_lvl) {
    return `${r.origin}의 실측 등급이 아직 없어 비교할 수 없습니다.`;
  }
  const when = data.state === 'stale' ? `${formatKst(data.latest_bucket_at)} 기준` : '지금';
  const head = `${r.origin}${topicParticle(r.origin)} ${when} ${r.origin_congest_lvl}`;
  if (!r.better || !r.best || !r.best_congest_lvl) {
    return `${head} — 걸어서 갈 수 있는 이웃 대상지도 덜 붐비지 않습니다. 옮길 이유가 없습니다.`;
  }
  const sentence = `${head} — 걸어서 ${formatWalk(r.best_walk_minutes)} 거리의 ${r.best}${topicParticle(r.best)} ${r.best_congest_lvl}입니다.`;
  return r.beats_origin_cost
    ? sentence
    : `${sentence} 다만 걷는 시간까지 더하면 머무르는 편이 빠를 수 있습니다.`;
}

// =====================================================================================
// 서울 실측으로 보정 (§5.3-5·§5.3-6, 결정 D5)
// =====================================================================================
//
// GET /api/v1/admin/engine-validation/seoul/calibration?days=28 — 다른 에이전트가 만드는
// 엔드포인트라 **계약을 여기 적어 두고 형태만 확인**한다. 필드가 다르면 parse 가 null 을 돌려주고
// 화면이 '형식 불일치' 라고 말한다(반쯤 그려서 0 으로 보이게 두지 않는다).
//
// 배포 순서 때문에 한동안 404 가 난다. 그건 장애가 아니라 **아직 배포 전**이다 — 빨간 배너로
// 띄우면 관리자가 매번 없는 고장을 쫓게 된다. 그래서 404 만 조용한 상태('not_deployed')로 가른다.

export const CALIBRATION_PATH = '/api/v1/admin/engine-validation/seoul/calibration';
export const CALIBRATION_WINDOW_DAYS = 28;

export type CalibrationState = 'not_migrated' | 'empty' | 'insufficient' | 'ready';
/** 화면에서만 쓰는 상태 — 서버가 아직 이 엔드포인트를 모른다(404). */
export type CalibrationView = CalibrationState | 'not_deployed';

export interface CalibrationKnot { x: number; y: number }
export interface CalibrationCurve { method: string; knots: CalibrationKnot[]; fitted_at: string | null }

export interface CalibrationQuality {
  holdout_days: number;
  mae_identity: number | null;
  mae_calibrated: number | null;
  spearman_identity: number | null;
  spearman_calibrated: number | null;
  improved: boolean;
}

export interface HourShapePoint {
  hour: number;
  weekday_mean: number | null;
  weekend_mean: number | null;
  n: number;
}

export interface CalibrationResponse {
  state: CalibrationState;
  applied: boolean;
  places: string[];
  window_days: number;
  generated_at: string;
  sample: { paired_buckets: number; days: number; first_bucket_at: string | null; last_bucket_at: string | null };
  requirement: { min_paired_buckets: number; min_days: number; must_beat_identity: boolean };
  curve: CalibrationCurve | null;
  quality: CalibrationQuality | null;
  hour_shape: { seoul: HourShapePoint[]; gyeongju_parking: HourShapePoint[] };
  gyeongju_effect: { samples: { raw: number; calibrated: number }[]; median_shift: number | null } | null;
  reason: string | null;
}

const CALIBRATION_STATES: readonly CalibrationState[] = ['not_migrated', 'empty', 'insufficient', 'ready'];

export function calibrationPath(days: number = CALIBRATION_WINDOW_DAYS): string {
  const safe = Number.isInteger(days) && days >= 1 && days <= 28 ? days : CALIBRATION_WINDOW_DAYS;
  return `${CALIBRATION_PATH}?days=${safe}`;
}

function hourShapeList(raw: unknown): HourShapePoint[] {
  return Array.isArray(raw)
    ? (raw as unknown[]).filter((p): p is HourShapePoint => isRecord(p) && typeof p.hour === 'number')
    : [];
}

export function parseCalibration(raw: unknown): CalibrationResponse | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.state !== 'string' || !CALIBRATION_STATES.includes(raw.state as CalibrationState)) return null;
  if (typeof raw.applied !== 'boolean') return null;
  const shape = isRecord(raw.hour_shape) ? raw.hour_shape : {};
  const rawCurve = isRecord(raw.curve) ? raw.curve : null;
  const curve: CalibrationCurve | null = rawCurve && Array.isArray(rawCurve.knots)
    ? {
        method: String(rawCurve.method ?? 'unknown'),
        knots: (rawCurve.knots as unknown[]).filter(
          (k): k is CalibrationKnot => isRecord(k) && typeof k.x === 'number' && typeof k.y === 'number',
        ),
        fitted_at: typeof rawCurve.fitted_at === 'string' ? rawCurve.fitted_at : null,
      }
    : null;
  const sample = isRecord(raw.sample) ? raw.sample : {};
  const requirement = isRecord(raw.requirement) ? raw.requirement : {};
  return {
    ...(raw as unknown as CalibrationResponse),
    curve,
    quality: isRecord(raw.quality) ? (raw.quality as unknown as CalibrationQuality) : null,
    hour_shape: { seoul: hourShapeList(shape.seoul), gyeongju_parking: hourShapeList(shape.gyeongju_parking) },
    places: Array.isArray(raw.places) ? (raw.places as string[]) : [],
    sample: {
      paired_buckets: typeof sample.paired_buckets === 'number' ? sample.paired_buckets : 0,
      days: typeof sample.days === 'number' ? sample.days : 0,
      first_bucket_at: typeof sample.first_bucket_at === 'string' ? sample.first_bucket_at : null,
      last_bucket_at: typeof sample.last_bucket_at === 'string' ? sample.last_bucket_at : null,
    },
    requirement: {
      min_paired_buckets: typeof requirement.min_paired_buckets === 'number' ? requirement.min_paired_buckets : 0,
      min_days: typeof requirement.min_days === 'number' ? requirement.min_days : 0,
      must_beat_identity: requirement.must_beat_identity !== false,
    },
  };
}

/**
 * 보정 상태 → 문장. 이 블록의 핵심 사실은 "**경주 추정에 적용됐는가**" 하나다 —
 * 곡선이 그려져 있어도 적용 전이면 화면은 그렇게 말해야 한다(§4 반영 5: 기본은 항등 유지).
 */
export function describeCalibrationState(
  view: CalibrationView,
  data: CalibrationResponse | null,
): StateNotice {
  if (view === 'not_deployed') {
    return {
      tone: 'info',
      title: '보정 계산이 아직 배포되지 않았습니다',
      detail: 'API 에 이 엔드포인트가 아직 없습니다(배포 순서 차이). 배포되면 서울 실측으로 적합한 보정 곡선과 항등 대비 성적이 여기에 나옵니다.',
    };
  }
  if (!data) {
    return {
      tone: 'warn',
      title: '보정 응답 형식이 이 화면과 맞지 않습니다',
      detail: 'API 와 웹의 배포 버전이 다를 수 있습니다. 두 쪽을 같은 커밋으로 맞춘 뒤 다시 열어 주세요.',
    };
  }
  const need = data.requirement;
  switch (data.state) {
    case 'not_migrated':
      return {
        tone: 'warn',
        title: '수집 시작 전 — 보정할 표본이 없습니다',
        detail: '검증 표가 아직 없습니다. 마이그레이션 적용 후 수집이 시작되면 주차 점유율과 실측 인구가 같은 버킷에 쌓입니다.',
      };
    case 'empty':
      return {
        tone: 'info',
        title: '수집 시작 전 — 짝지은 표본 0건',
        detail: '같은 버킷에 주차 점유율과 서울시 실측 인구가 함께 있는 행이 아직 없습니다. 보정은 그 쌍에서만 적합할 수 있습니다.',
      };
    case 'insufficient':
      return {
        tone: 'info',
        title: `표본 부족 — 짝지은 버킷 ${data.sample.paired_buckets}개 / 최소 ${need.min_paired_buckets}개`,
        detail: `${data.sample.days}일치 / 최소 ${need.min_days}일. ${data.reason ?? '표본이 찰 때까지 곡선을 적용하지 않습니다 — 한 곳·짧은 기간에서 맞춘 곡선은 과적합 위험이 큽니다(§4 반영 5).'}`,
      };
    default:
      return data.applied
        ? {
            tone: 'ok',
            title: '경주 추정에 적용 중',
            detail: `서울 실측으로 적합한 보정 곡선이 경주 추정치에 걸려 있습니다. 홀드아웃 ${data.quality?.holdout_days ?? 0}일에서 항등(보정 없음)보다 나았습니다.`,
          }
        : {
            tone: 'warn',
            title: '곡선은 적합했지만 경주에는 적용하지 않았습니다',
            detail: data.reason ?? '기본은 항등 유지입니다(§4 반영 5 · 결정 D5). 홀드아웃에서 항등을 이기지 못했거나, 서울 한 권역에서 맞춘 곡선의 전이 위험이 커 참고로만 병기합니다.',
          };
  }
}

export interface CurveRow { x: number; calibrated: number; identity: number }

/**
 * 보정 곡선 차트 행. **항등 대각선을 같은 행에 넣는다** — 곡선만 그리면 얼마나 휘었는지 눈으로
 * 알 수 없고, 휘지 않은 것(= 항등, 지금의 기본값)이 기준이라는 사실도 사라진다.
 */
export function calibrationCurveRows(curve: CalibrationCurve | null): CurveRow[] {
  if (!curve) return [];
  return curve.knots
    .filter((knot) => Number.isFinite(knot.x) && Number.isFinite(knot.y))
    .slice()
    .sort((a, b) => a.x - b.x)
    .map((knot) => ({ x: knot.x, calibrated: knot.y, identity: knot.x }));
}

export interface HourShapeRow {
  hour: number;
  label: string;
  seoul_weekday: number | null;
  seoul_weekend: number | null;
  parking_weekday: number | null;
  parking_weekend: number | null;
  seoul_n: number;
  parking_n: number;
}

/**
 * 시간대 모양 비교 행(0~23시). 표본이 0인 시각은 값을 null 로 둔다 — 0.0 으로 채우면
 * "그 시간에는 한산하다"는 없는 모양이 생긴다(chartRows 의 공백 규칙과 같은 이유).
 */
export function hourShapeRows(
  shape: { seoul: HourShapePoint[]; gyeongju_parking: HourShapePoint[] } | null | undefined,
): HourShapeRow[] {
  const index = (list: HourShapePoint[]) => new Map(list.map((point) => [point.hour, point]));
  const seoul = index(shape?.seoul ?? []);
  const parking = index(shape?.gyeongju_parking ?? []);
  const hours = Array.from(new Set([...seoul.keys(), ...parking.keys()]))
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)
    .sort((a, b) => a - b);
  const value = (point: HourShapePoint | undefined, key: 'weekday_mean' | 'weekend_mean') =>
    point && point.n > 0 && typeof point[key] === 'number' && Number.isFinite(point[key] as number)
      ? (point[key] as number)
      : null;
  return hours.map((hour) => {
    const s = seoul.get(hour);
    const p = parking.get(hour);
    return {
      hour,
      label: `${String(hour).padStart(2, '0')}시`,
      seoul_weekday: value(s, 'weekday_mean'),
      seoul_weekend: value(s, 'weekend_mean'),
      parking_weekday: value(p, 'weekday_mean'),
      parking_weekend: value(p, 'weekend_mean'),
      seoul_n: s?.n ?? 0,
      parking_n: p?.n ?? 0,
    };
  });
}

/** 품질 숫자 한 개(MAE·ρ). 없으면 '—' — 0 으로 보이면 '오차가 없다' 로 읽힌다. */
export function formatQualityNumber(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

/** 항등 대비 개선폭. 낮을수록 좋은 MAE 는 '줄었다', 높을수록 좋은 ρ 는 '올랐다'. */
export function describeQualityDelta(
  identity: number | null | undefined,
  calibrated: number | null | undefined,
  lowerIsBetter: boolean,
): string {
  if (
    identity === null || identity === undefined || !Number.isFinite(identity) ||
    calibrated === null || calibrated === undefined || !Number.isFinite(calibrated)
  ) {
    return '비교 불가';
  }
  const delta = calibrated - identity;
  if (Math.abs(delta) < 1e-9) return '항등과 같음';
  const better = lowerIsBetter ? delta < 0 : delta > 0;
  const size = Math.abs(delta).toFixed(3);
  return better ? `항등보다 ${size} 좋음` : `항등보다 ${size} 나쁨`;
}
