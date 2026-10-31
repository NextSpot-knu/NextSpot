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
  describeRankGate,
  metricDetailRows,
  parseCalibration,
  parseRankGate,
  parseSummary,
  RANK_GATE_TITLE,
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
  // 실시간 데이터 리허설(§6 S6): 표가 없거나 행이 없는 상태를 '가동 중' 으로 말하지 않는다. 관리자 전용 화면이라
  // 사람이 할 일(마이그레이션 파일·인증키·수집 잡)을 그대로 적는다 — 예전 판(심사 기간)은 이를 감췄다.
  const notMigrated = describeState(summary({ state: 'not_migrated', collection: null }), null);
  assert.equal(notMigrated.tone, 'error');
  assert.match(notMigrated.title, /수집 표가 없습니다 — 마이그레이션 미적용/);
  assert.match(notMigrated.detail, /20260920120000_seoul_citydata_snapshots\.sql/);
  assert.match(notMigrated.detail, /사람 작업/);
  assert.doesNotMatch(notMigrated.title + notMigrated.detail, /가동 중|수집하는 중/, '표가 없는데 돌고 있다고 말하지 않는다');

  const empty = describeState(summary({ state: 'empty' }), null);
  assert.equal(empty.tone, 'warn');
  assert.match(empty.title, /수집된 행이 없습니다/);
  assert.match(empty.detail, /SEOUL_OPENDATA_KEY/);
  assert.doesNotMatch(empty.title + empty.detail, /가동 중/);

  const stalled = describeState(summary({ state: 'stalled', collection: { ...summary().collection!, latest_age_minutes: 60 * 24 * 20 } }), null);
  assert.equal(stalled.tone, 'error');
  assert.match(stalled.title, /수집 멈춤/);
  assert.match(stalled.detail, /20일/);
  assert.doesNotMatch(stalled.detail, /자동으로 재시도/, '멈춘 수집을 곧 풀릴 것처럼 말하지 않는다');

  const collecting = describeState(summary(), place());
  assert.match(collecting.title, /실측 대조 1\.8시간째 · 집계 중/);
  assert.match(collecting.detail, /버킷 12개 수집 · 판정 기준 36개/);
  assert.doesNotMatch(collecting.detail, /10분마다/, '주기를 모르면 10분이라고 지어내지 않는다');
  const thirty = describeState(summary(), place({ cadence_minutes: 30 }));
  assert.match(thirty.detail, /이 대상지는 30분마다 수집합니다/);

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

  // S4 보강 필드 — 있으면 조건을 함께 쓰고, 없으면(이전 서버) 위 문장 그대로다.
  assert.equal(
    formatThreshold(metric({ key: 'spearman', unit: 'rho', threshold: 0.5, anomaly_threshold: 0.1, anomaly_rho: 0.2 })),
    '≥ 0.50 · 시간대 평균을 뺀 ρ ≥ 0.10',
  );
  assert.equal(formatThreshold(metric({ cohen_kappa: 0.31, kappa_threshold: 0.2 })), '≥ 50% · κ ≥ 0.20');
  assert.equal(
    formatThreshold(metric({ key: 'grade_within_one', threshold: 0.8, weighted_kappa_linear: 0.4, kappa_threshold: 0.2 })),
    '≥ 80% · 선형 가중 κ ≥ 0.20',
  );
  assert.equal(
    formatThreshold(metric({
      key: 'forecast_mae_30m', unit: 'mae', direction: 'lte', threshold: 0.19, baseline_mae: 0.2,
      baseline_label: '시간대 평균(학습 날짜)', margin: 0.95,
    })),
    '시간대 평균(학습 날짜)(0.200)의 0.95배 이하',
  );
  assert.equal(
    formatThreshold(metric({ unit: 'mae', direction: 'lte', threshold: null, baseline_mae: null, baseline_label: '시간대 평균(학습 날짜)', margin: 0.95 })),
    '시간대 평균(학습 날짜)의 0.95배 이하',
  );

  // 덧붙임 줄 — 이전 서버 응답이면 하나도 없다(타일이 예전 그대로).
  assert.deepEqual(metricDetailRows(metric({})), []);
  assert.deepEqual(
    metricDetailRows(metric({ key: 'spearman', unit: 'rho', anomaly_rho: 0.1234, anomaly_n: 120, anomaly_dates: 6, climatology_rho: null })),
    [
      { label: '시간대 평균을 뺀 ρ', value: '0.12 (n=120 · 6일)' },
      { label: '시간대 평균만의 ρ(비교)', value: '—' },
    ],
  );
  assert.deepEqual(
    metricDetailRows(metric({ key: 'spearman', unit: 'rho', anomaly_rho: 0.16, anomaly_rho_ci_low: -0.067 })),
    [
      { label: '시간대 평균을 뺀 ρ', value: '0.16' },
      { label: '시간대 평균을 뺀 ρ의 95% 하한(날짜 잭나이프)', value: '-0.07' },
    ],
  );
  assert.deepEqual(
    metricDetailRows(metric({
      key: 'forecast_mae_30m', unit: 'mae', direction: 'lte', holdout_n: 40, holdout_dates: 3, raw_mae: 0.2111, raw_n: 120,
      oracle_reference_label: '실측 지속 — 참고: 추정기는 쓸 수 없는 정보', oracle_reference_mae: 0.08,
    })),
    [
      { label: '홀드아웃', value: 'n=40 · 3일' },
      { label: '보정 전 전체 표본 MAE(보고용)', value: '0.211 (n=120)' },
      { label: '실측 지속 — 참고: 추정기는 쓸 수 없는 정보', value: '0.080' },
    ],
  );
  assert.deepEqual(
    metricDetailRows(metric({
      chance_agreement: 0.5, cohen_kappa: 0.25, rank_mapped_value: 0.55, rank_mapped_chance: 0.4, rank_mapped_n: 50,
      rank_mapped_holdout_days: 3,
    })),
    [
      { label: '우연 일치', value: '50.0%' },
      { label: 'Cohen κ', value: '0.25' },
      { label: '분위 경계 등급 일치(보고용)', value: '55.0% · 우연 40.0% (홀드아웃 n=50 · 3일)' },
    ],
  );
  assert.deepEqual(
    metricDetailRows(metric({ key: 'grade_within_one', chance_within_one: 0.81, weighted_kappa_linear: null, rank_mapped_value: null })),
    [
      { label: '우연히 ±1 이내', value: '81.0%' },
      { label: '선형 가중 κ', value: '—' },
      { label: '분위 경계 등급 일치(보고용)', value: '—' },
    ],
  );

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

  // 30분 주기 대상지: 10분 간격으로 보면 모든 점 사이가 '끊김' 이 되어 선이 하나도 이어지지 않는다.
  const thirty = [
    point('2026-09-21T00:10:00+00:00', 0.1),
    point('2026-09-21T00:40:00+00:00', 0.2),
    point('2026-09-21T01:10:00+00:00', 0.3),
  ];
  assert.equal(chartRows(thirty).length, 5, '10분 간격으로 보면 끊김 2개가 끼어든다');
  assert.equal(chartRows(thirty, 30).length, 3, '실제 간격(30분)으로 보면 이어진다');
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

// --- 보정 순위 관문(보고 전용) -----------------------------------------------------------
// 제목이 '적용 기준 아님' 을 말한다 — 미달이어도 경주 적용 판정은 바뀌지 않는다. 이전 서버는 필드가 없다(null).
{
  const base = {
    state: 'ready', applied: false, places: [], window_days: 28, generated_at: '', hour_shape: {},
    sample: { paired_buckets: 0, days: 0 }, requirement: {}, curve: null, quality: null, gyeongju_effect: null, reason: null,
  };
  assert.equal(parseCalibration(base)!.rank_gate, null, '이전 서버 응답에는 관문 줄이 없다');
  assert.equal(parseCalibration({ ...base, rank_gate: null })!.rank_gate, null);
  assert.equal(parseRankGate({ enforced: false }), null, '상태가 없으면 모르는 모양');

  const raw = {
    status: 'fail', enforced: false, holdout_spearman: 0.21, anomaly_rho: 0.05, min_holdout_spearman: 0.3,
    mae_constant: 0.18, mae_calibrated: 0.19, beats_constant: false, holdout_samples: 120, holdout_days: 6,
    min_holdout_samples: 36, min_holdout_days: 5, definition: '홀드아웃 순위 상관과 상수 대비 MAE', reason: '홀드아웃 ρ 0.2100 < 0.30',
  };
  const gate = parseCalibration({ ...base, rank_gate: raw })!.rank_gate!;
  assert.equal(gate.status, 'fail');
  const view = describeRankGate(gate);
  assert.equal(view.title, RANK_GATE_TITLE);
  assert.equal(view.title, '순위 관문(참고 — 적용 기준 아님)');
  assert.deepEqual(view.badge, { label: '미달', tone: 'warn' });
  assert.deepEqual(view.lines, [
    '홀드아웃 순위 상관 ρ(대상지 안) 0.21 / 기준 ≥ 0.30',
    '홀드아웃 MAE — 보정 곡선 0.190 vs 대상지별 학습 평균 상수 0.180 (상수보다 낮지 않음)',
    '홀드아웃 120점 · 6일 / 최소 36점 · 5일',
    '시간대 평균을 뺀 ρ(참고) 0.05',
  ]);
  // 대상지 안 ρ 와 섞은 ρ 를 함께 보내는 서버(S4 검토) — 섞은 ρ 는 참고 줄이다.
  const withSites = describeRankGate(parseRankGate({ ...raw, pooled_spearman: 0.74, holdout_sites: 2 })!);
  assert.equal(withSites.lines[0], '홀드아웃 순위 상관 ρ(대상지 안 · 2곳) 0.21 / 기준 ≥ 0.30');
  assert.ok(withSites.lines.includes('대상지를 섞은 ρ(참고) 0.74'));
  assert.equal(view.reason, '홀드아웃 ρ 0.2100 < 0.30');

  const thin = describeRankGate(parseRankGate({ status: 'insufficient', enforced: false, holdout_samples: 3, holdout_days: 1 })!);
  assert.deepEqual(thin.badge, { label: '표본 부족', tone: 'info' });
  assert.equal(thin.lines[0], '홀드아웃 순위 상관 ρ(대상지 안) —');
  assert.equal(thin.lines.length, 3, '참고 ρ 가 없으면 그 줄을 쓰지 않는다');
  assert.notEqual(describeRankGate({ ...gate, enforced: true }).title, RANK_GATE_TITLE, '적용 기준이 되면 제목이 달라진다');

  // 이상치 ρ 가 판정 조건인 서버(S4 검토 2차) — 하루 모양만 따라 그리면 이상치 ρ 가 없다('—', 0 이 아니다).
  const clockOnly = describeRankGate(parseRankGate({
    ...raw, holdout_spearman: 0.62, beats_constant: true, anomaly_rho: null, min_anomaly_rho: 0.1, anomaly_slot_minutes: 10,
  })!);
  assert.ok(clockOnly.lines.includes('시간대 평균(10분 칸 학습 날짜)을 뺀 ρ — / 기준 ≥ 0.10'));
  assert.ok(!clockOnly.lines.some((line) => line.includes('(참고) —')));
  const tracked = describeRankGate(parseRankGate({ ...raw, anomaly_rho: 0.34, min_anomaly_rho: 0.1, anomaly_slot_minutes: 10 })!);
  assert.equal(tracked.lines[tracked.lines.length - 1], '시간대 평균(10분 칸 학습 날짜)을 뺀 ρ 0.34 / 기준 ≥ 0.10');
  assert.equal(parseRankGate(raw)!.anomaly_rho_ci_low, null, '하한이 없는 이전 서버는 null — 줄이 그대로다');

  // 날짜 잭나이프 95% 하한 > 0 도 판정 조건인 서버(S4 검토 3차) — 같은 줄에 하한을 싣는다.
  const withCi = describeRankGate(parseRankGate({
    ...raw, anomaly_rho: 0.15, min_anomaly_rho: 0.1, anomaly_slot_minutes: 10, anomaly_rho_ci_low: -0.19,
  })!);
  assert.equal(
    withCi.lines[withCi.lines.length - 1],
    '시간대 평균(10분 칸 학습 날짜)을 뺀 ρ 0.15 / 기준 ≥ 0.10 · 95% 하한(날짜 잭나이프) -0.19 > 0',
  );
  const ciNull = describeRankGate(parseRankGate({
    ...raw, anomaly_rho: 0.34, min_anomaly_rho: 0.1, anomaly_slot_minutes: 10, anomaly_rho_ci_low: null,
  })!);
  assert.equal(ciNull.lines[ciNull.lines.length - 1], '시간대 평균(10분 칸 학습 날짜)을 뺀 ρ 0.34 / 기준 ≥ 0.10');
}

// --- 화면 배선 --------------------------------------------------------------------
// 메뉴에서 들어갈 수 있어야 하고, 출처 표기(공공누리 1유형)와 한 곳 주의가 화면에 있어야 한다.
{
  const sidebar = readFileSync(join(WEB, 'components/AdminSidebar.tsx'), 'utf8');
  assert.match(sidebar, /'실시간 데이터 리허설', path: '\/admin\/engine-validation'/);
  const page = readFileSync(join(WEB, 'app/admin/engine-validation/page.tsx'), 'utf8');
  assert.match(page, /SEOUL_ATTRIBUTION/);
  assert.match(page, /sampleCaveat/);
  assert.match(page, /summaryPath/);
  assert.match(page, /실시간 데이터 리허설 — 서울 실시간 도시데이터/);
  assert.match(page, /RehearsalStatusPanel/);
  assert.match(page, /DecisionQualityPanel/);
  assert.doesNotMatch(page, /가동 중/, '수집 상태를 고정 문구로 단정하지 않는다');
  assert.match(page, /경주 ITS 공영주차 실시간 점유율/);
  assert.match(page, /10분 주기로 갱신되는 실측 데이터/);
  assert.doesNotMatch(page, /§|docs\/|level_est|표본 없음/, '심사 화면에 내부 참조를 남기지 않는다');
}

// --- developer 전용(2026-10-31 사용자 결정 1) ------------------------------------------
// 서울 데이터 화면이다 — admin(외부 기관 관제 · 공용 심사 계정)에게는 메뉴·대시보드 링크가 서지 않고, URL 로 직접 열어도
// 아무것도 불러오지 않는다(서버는 같은 API 를 admin 에게 403 — tests/routers/test_engine_validation_developer_only.py).
{
  const sidebar = readFileSync(join(WEB, 'components/AdminSidebar.tsx'), 'utf8');
  assert.match(sidebar, /INTERNAL_REGION_ONLY = new Set<string>\(\['\/admin\/engine-validation'\]\)/);
  assert.match(sidebar, /!INTERNAL_REGION_ONLY\.has\(item\.path\) \|\| canSeeInternalRegions\(account\)/);
  const dashboard = readFileSync(join(WEB, 'app/admin/dashboard/page.tsx'), 'utf8');
  assert.match(dashboard, /const showRehearsalLink = canSeeInternalRegions\(account\)/);
  assert.match(dashboard, /\{showRehearsalLink && \(\s*<Link\s+href="\/admin\/engine-validation"/, '대시보드 링크가 developer 판정 밖에 있다');
  const page = readFileSync(join(WEB, 'app/admin/engine-validation/page.tsx'), 'utf8');
  assert.match(page, /const allowed = canSeeInternalRegions\(account\)/);
  assert.match(page, /useEffect\(\(\) => \{\s*if \(!allowed\) return;/, '권한 없는 계정도 요약을 불러온다');
  const gate = page.indexOf('if (!allowed) {\n    return (');
  assert.ok(gate > 0 && gate < page.indexOf('실시간 데이터 리허설 — 서울 실시간 도시데이터'), '서울 머리글보다 먼저 막지 않는다');
}

console.log('engineValidation.test.ts OK');
