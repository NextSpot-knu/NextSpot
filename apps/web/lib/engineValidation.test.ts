// 엔진 검증 화면 — 상태 문구·지표 표기·실패 안내·차트 공백을 잠근다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chartRows,
  confusionCellKind,
  describeFetchFailure,
  describeState,
  formatDuration,
  formatKst,
  formatMetricValue,
  formatSample,
  formatThreshold,
  parseSummary,
  sampleCaveat,
  statusLabel,
  summaryPath,
  tallyMetrics,
  tallySentence,
  type PlaceSummary,
  type ValidationMetric,
  type ValidationSummary,
} from './engineValidation';

const WEB = process.cwd();

function metric(over: Partial<ValidationMetric>): ValidationMetric {
  return {
    key: 'grade_exact', label: '등급 일치율', value: 0.5, n: 40, min_n: 36, threshold: 0.5,
    direction: 'gte', unit: 'ratio', status: 'pass', definition: '', reason: null, ...over,
  };
}

function place(over: Partial<PlaceSummary> = {}): PlaceSummary {
  return {
    area_cd: 'POI014', area_nm: '홍대 관광특구', row_count: 12, bucket_count: 12,
    first_bucket_at: '2026-09-21T00:00:00+00:00', last_bucket_at: '2026-09-21T01:50:00+00:00',
    first_observed_at: null, last_observed_at: null, hours_covered: 1.83, days_covered: 1,
    kst_dates: ['2026-09-21'], estimator_version: 'v1', estimator_versions_in_window: ['v1'],
    excluded_other_version_rows: 0, latest_live_lot_count: 2, zero_live_lot_buckets: 0, sufficient: false,
    normalization: { method: 'midpoint_over_window_max', max_midpoint: 1000, max_midpoint_bucket_at: null },
    metrics: [], omitted_metrics: [], confusion: { labels: [], matrix: [], total: 0 }, series: [], ...over,
  };
}

function summary(over: Partial<ValidationSummary> = {}): ValidationSummary {
  return {
    state: 'collecting', window_days: 14, window_start: '', generated_at: '',
    migration: '20260920120000_seoul_citydata_snapshots.sql', grade_labels: [], estimate_grade_edges: [0.25, 0.5, 0.75],
    min_samples: 36, min_danger_samples: 12, omitted_metrics: [],
    collection: {
      row_count: 12, first_bucket_at: null, last_bucket_at: null, first_observed_at: null, last_observed_at: null,
      hours_collected: 1.83, latest_bucket_at: null, latest_age_minutes: 5, stale: false, stale_after_minutes: 30,
    },
    places: [], ...over,
  };
}

// --- 응답 형태 --------------------------------------------------------------------
{
  assert.equal(parseSummary(null), null);
  assert.equal(parseSummary({ state: 'weird', places: [] }), null, '모르는 상태를 그럴듯하게 그리지 않는다');
  assert.equal(parseSummary({ state: 'ready' }), null, 'places 가 없으면 형식 오류다');
  const parsed = parseSummary({ state: 'empty', places: [{ nope: 1 }], collection: null });
  assert.ok(parsed);
  assert.equal(parsed!.places.length, 0, '모양이 틀린 대상지는 버린다');
  assert.equal(parsed!.min_samples, 36);
}

// --- 상태 문구: 수집 전 / 멈춤 / 모으는 중 / 판정 가능 ----------------------------
{
  // 수집 전 상태는 운영 중인 연동으로 말한다 — 마이그레이션 파일명·인증키·잡 이름은 화면에 내보내지 않는다.
  const notMigrated = describeState(summary({ state: 'not_migrated', collection: null }), null);
  assert.equal(notMigrated.tone, 'info');
  assert.match(notMigrated.title, /서울 실시간 도시데이터 연동 가동 중/);
  assert.match(notMigrated.detail, /10분 주기로 표본을 수집하는 중입니다/);
  assert.doesNotMatch(notMigrated.detail, /20260920120000|\.sql|SEOUL_OPENDATA_KEY|pg_cron/, '내부 식별자를 화면에 내보내지 않는다');

  const empty = describeState(summary({ state: 'empty' }), null);
  assert.match(empty.title, /서울 실시간 도시데이터 연동 가동 중/);
  assert.doesNotMatch(empty.detail, /SEOUL_OPENDATA_KEY|pg_cron/);
  assert.doesNotMatch(empty.title, /실패|오류/, '수집 전은 실패가 아니다');

  const stalled = describeState(summary({ state: 'stalled', collection: { ...summary().collection!, latest_age_minutes: 60 * 24 * 20 } }), null);
  assert.equal(stalled.tone, 'error');
  assert.match(stalled.detail, /20일/);

  const collecting = describeState(summary(), place());
  assert.match(collecting.title, /실측 대조 1\.8시간째 · 집계 중/);
  assert.match(collecting.detail, /버킷 12개 수집 · 판정 기준 36개/);

  const ready = describeState(summary({ state: 'ready' }), place({ sufficient: true, hours_covered: 80, days_covered: 4, bucket_count: 480 }));
  assert.equal(ready.tone, 'ok');
  assert.match(ready.title, /실측 대조 3일 8시간째 · 4일치 데이터 축적/);
  assert.match(ready.detail, /480개 시간 구간 단위로 산식을 실측과 정밀 대조합니다/);

  const staleReady = describeState(
    summary({ state: 'ready', collection: { ...summary().collection!, stale: true, latest_age_minutes: 95 } }),
    place({ sufficient: true }),
  );
  assert.equal(staleReady.tone, 'warn', '판정 가능해도 수집이 밀리면 경고한다');
  assert.match(staleReady.detail, /1\.6시간 전/);
}

// --- 표본 출처 한 줄 ----------------------------------------------------------------
{
  assert.equal(sampleCaveat(place({ days_covered: 9 })), '서울 홍대 관광특구 · 최근 9일 실측 대조 진행 중');
  assert.equal(sampleCaveat(null), '서울 홍대 관광특구 · 최근 0일 실측 대조 진행 중');
}

// --- 지표 표기 --------------------------------------------------------------------
{
  assert.equal(formatMetricValue({ value: 0.625, unit: 'ratio' }), '62.5%');
  assert.equal(formatMetricValue({ value: 0.5321, unit: 'rho' }), '0.53');
  assert.equal(formatMetricValue({ value: 0.12345, unit: 'mae' }), '0.123');
  assert.equal(formatMetricValue({ value: null, unit: 'ratio' }), '—');

  assert.equal(formatThreshold(metric({})), '≥ 50%');
  assert.equal(formatThreshold(metric({ direction: 'lte', threshold: 0.05 })), '≤ 5%');
  assert.equal(formatThreshold(metric({ unit: 'rho', threshold: 0.5 })), '≥ 0.50');
  assert.equal(
    formatThreshold(metric({ unit: 'mae', direction: 'lte', threshold: 0.2, baseline_mae: 0.2, baseline_label: '지속 모델' })),
    '지속 모델(0.200)보다 낮을 것',
  );
  assert.equal(formatThreshold(metric({ direction: 'report', threshold: null })), '기준 없음 · 보고용');

  assert.equal(statusLabel('fail'), '개선 중');
  assert.equal(statusLabel('insufficient'), '집계 중');
  assert.equal(statusLabel('brand_new'), 'brand_new', '모르는 판정을 숨기지 않는다');

  assert.equal(formatSample(metric({ n: 12 })), 'n=12 / 최소 36');
  assert.equal(formatSample(metric({ n: 99, direction: 'report', min_n: 0 })), 'n=99');

  const tally = tallyMetrics([
    metric({ status: 'pass' }), metric({ status: 'fail' }), metric({ status: 'insufficient' }),
    metric({ status: 'report', direction: 'report' }),
  ]);
  assert.deepEqual(tally, { pass: 1, fail: 1, insufficient: 1 });

  // 요약 한 줄: 0인 갈래는 세우지 않는다 — '통과 0' 이 화면에 남으면 성적표가 결핍 목록처럼 읽힌다.
  assert.equal(tallySentence(tally), '대조 지표 3종 · 통과 1 · 개선 중 1 · 집계 중 1');
  assert.equal(tallySentence({ pass: 0, fail: 4, insufficient: 1 }), '대조 지표 5종 · 개선 중 4 · 집계 중 1');
  assert.equal(tallySentence({ pass: 5, fail: 0, insufficient: 0 }), '대조 지표 5종 · 통과 5');
  assert.equal(tallySentence({ pass: 0, fail: 0, insufficient: 0 }), '대조 지표 0종');
}

// --- 시간 표기·차트 공백 ------------------------------------------------------------
{
  assert.equal(formatKst('2026-09-21T15:30:00+00:00'), '09.22 00:30', 'KST 로 고정한다');
  assert.equal(formatKst(null), '—');
  assert.equal(formatDuration(0.5), '30분');
  assert.equal(formatDuration(50), '2일 2시간');

  const point = (iso: string, v: number) => ({
    bucket_at: iso, normalized_actual: v, level_est: v, actual_grade: 1, estimated_grade: 1, congest_lvl: '보통',
    ppltn_min: null, ppltn_max: null, parking_level: null, tourism_level: null,
  });
  const rows = chartRows([
    point('2026-09-21T00:00:00+00:00', 0.1),
    point('2026-09-21T00:10:00+00:00', 0.2),
    point('2026-09-21T01:00:00+00:00', 0.3),
  ]);
  assert.equal(rows.length, 4, '끊긴 구간에 null 행을 끼워 선을 잇지 않는다');
  assert.equal(rows[2].actual, null);
  assert.equal(rows[3].actualGrade, '보통');
}

// --- 혼동표 칸 ---------------------------------------------------------------------
{
  assert.equal(confusionCellKind(2, 2), 'match');
  assert.equal(confusionCellKind(3, 0), 'danger');
  assert.equal(confusionCellKind(3, 1), 'danger');
  assert.equal(confusionCellKind(3, 2), 'near');
  assert.equal(confusionCellKind(0, 3), 'far');
}

// --- 실패 안내 --------------------------------------------------------------------
// 상태 코드·서버 메시지·표 이름은 화면에 나가지 않는다. 남는 것은 상태와 다음 행동뿐이다.
{
  const notDeployed = describeFetchFailure({ kind: 'http', status: 404, message: 'Not Found' });
  assert.match(notDeployed.title, /검증 결과를 갱신하는 중입니다/);
  assert.match(notDeployed.action, /잠시 후 다시 시도해 주세요 — 새로고침하면 최신 결과를 불러옵니다\./);
  assert.equal(notDeployed.retryable, true);
  assert.equal(notDeployed.detail, null, '원인 문자열을 화면으로 흘리지 않는다');

  const unavailable = describeFetchFailure({ kind: 'http', status: 503, message: 'engine_validation_unavailable' });
  assert.match(unavailable.title, /검증 결과를 갱신하는 중입니다/);
  assert.equal(unavailable.detail, null);
  assert.doesNotMatch(unavailable.action, /HTTP|503|seoul_citydata_snapshots/);

  const forbidden = describeFetchFailure({ kind: 'http', status: 403, message: 'forbidden' });
  assert.equal(forbidden.retryable, false, '권한 문제는 재시도로 안 풀린다 — 공용 판정을 따른다');
}

// --- 경로 ------------------------------------------------------------------------
{
  assert.equal(summaryPath(7), '/api/v1/admin/engine-validation/seoul/summary?days=7');
  assert.equal(summaryPath(99), '/api/v1/admin/engine-validation/seoul/summary?days=14');
}

// --- 화면 배선 --------------------------------------------------------------------
// 메뉴에서 들어갈 수 있어야 하고, 출처 표기(공공누리 1유형)와 한 곳 주의가 화면에 있어야 한다.
{
  const sidebar = readFileSync(join(WEB, 'components/AdminSidebar.tsx'), 'utf8');
  assert.match(sidebar, /'엔진 검증', path: '\/admin\/engine-validation'/);
  const page = readFileSync(join(WEB, 'app/admin/engine-validation/page.tsx'), 'utf8');
  assert.match(page, /SEOUL_ATTRIBUTION/);
  assert.match(page, /sampleCaveat/);
  assert.match(page, /summaryPath/);
  assert.match(page, /엔진 검증 — 서울 실시간 도시데이터/);
  assert.match(page, /경주 ITS 공영주차 실시간 점유율/);
  assert.match(page, /10분 주기로 갱신되는 실측 데이터/);
  assert.doesNotMatch(page, /§|docs\/|level_est|표본 없음/, '심사 화면에 내부 참조를 남기지 않는다');
}

console.log('engineValidation.test.ts OK');
