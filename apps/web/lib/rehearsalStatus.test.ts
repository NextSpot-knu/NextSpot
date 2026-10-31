// 실시간 데이터 리허설 — 대상지별 수집 상태·정규화 표·결정 품질 문구를 잠근다.
// 핵심: 표가 없거나(not_migrated) 행이 없거나(empty) 늦은(stale) 대상지가 '최신·정상' 으로 보이지 않는다.
import assert from 'node:assert/strict';
import {
  calibrationPace,
  chartStepMinutes,
  describeBudget,
  describeDecisionQuality,
  describeLastRun,
  describePipeline,
  describeZones,
  formatAgeMinutes,
  formatCadence,
  formatFillRate,
  parseDecisionQuality,
  parsePipeline,
  sampleSpan,
  targetBadge,
  type PipelineTarget,
  type RehearsalPipeline,
  type ZonesStatus,
} from './rehearsalStatus';

function target(over: Partial<PipelineTarget> = {}): PipelineTarget {
  return {
    area_nm: '명동 관광특구', zone_id: 'seoul:POI003', configured: true, state: 'fresh',
    every_buckets: 3, offset_buckets: 2, cadence_minutes: 30, stale_after_minutes: 65,
    latest_bucket_at: '2026-10-31T03:20:00+00:00', latest_age_minutes: 34, first_bucket_in_window_at: null,
    window: { expected_buckets: 672, collected_buckets: 660, off_schedule_buckets: 0, fill_rate: 0.9821 },
    last_24h: { expected_buckets: 48, collected_buckets: 47, off_schedule_buckets: 0, fill_rate: 0.9792 },
    rows_24h: 47, zone_rows_24h: null, primary_calls_per_day: 48, retry_calls_per_day_worst: 0, last_run: null,
    ...over,
  };
}

function zones(over: Partial<ZonesStatus> = {}): ZonesStatus {
  return {
    table: 'zone_crowd_snapshots', migration: '20261031120000_crowd_zones.sql', table_state: 'has_rows',
    rows_24h: 300, latest_bucket_at: '2026-10-31T03:20:00+00:00', latest_age_minutes: 7,
    last_write: { state: 'stored', stored_count: 3, errors: {}, at: '2026-10-31T03:24:00+00:00' }, human_step: null,
    ...over,
  };
}

function pipeline(over: Partial<RehearsalPipeline> = {}): RehearsalPipeline {
  return {
    schedule_state: 'ok', schedule_error: null, key_configured: true, table_state: 'has_rows', human_step: null,
    stale_rule: { formula: 'max(30, 2 × 주기 + 5)분', base_minutes: 30, collection_offset_minutes: 5 },
    bucket_minutes: 10,
    budget: {
      primary_per_day: 720, retry_worst_case_per_day: 144, worst_case_per_day: 864, limit_per_day: 1000,
      headroom_per_day: 136, within_limit: true, retry_cron: '9,39 * * * *',
    },
    targets: [target(), target({ area_nm: '동대문 관광특구' })],
    last_run: null, zones: zones(), ...over,
  };
}

// --- 응답 형태 --------------------------------------------------------------------
{
  assert.equal(parsePipeline(null), null);
  assert.equal(parsePipeline(undefined), null, '이전 서버(필드 없음)는 null — 반쯤 그리지 않는다');
  assert.equal(parsePipeline({ targets: [] }), null, 'schedule_state 가 없으면 모르는 모양');
  const parsed = parsePipeline({
    ...pipeline(),
    targets: [target(), { junk: true }, { ...target({ area_nm: '경복궁' }), window: null, last_24h: undefined }],
    zones: { ...zones(), last_write: { state: 'partial', stored_count: 1, errors: null, at: null } },
    last_run: { state: 'ok', skipped_targets: null },
  });
  assert.ok(parsed);
  assert.equal(parsed!.targets.length, 2, '모양이 아닌 대상지는 버린다');
  assert.deepEqual(parsed!.targets[1].window, { expected_buckets: null, collected_buckets: 0, off_schedule_buckets: 0, fill_rate: null });
  assert.deepEqual(parsed!.zones!.last_write!.errors, {});
  assert.deepEqual(parsed!.last_run!.skipped_targets, []);

  assert.equal(parseDecisionQuality(null), null);
  assert.equal(parseDecisionQuality({ state: 'not_evaluated', stage: 'S4', criterion: 'V3', result: null })!.state, 'not_evaluated');
}

// --- 대상지 배지: 행이 없거나 늦으면 '최신' 이 아니다 ---------------------------------------
{
  assert.deepEqual(targetBadge('fresh'), { label: '최신', tone: 'ok' });
  for (const state of ['stale', 'empty', 'not_migrated', 'invalid_config']) {
    const badge = targetBadge(state);
    assert.notEqual(badge.tone, 'ok', `${state} 가 정상 색으로 보인다`);
    assert.notEqual(badge.label, '최신');
  }
  assert.equal(targetBadge('not_migrated').tone, 'error');
  assert.equal(targetBadge('invalid_config').tone, 'error');
  assert.deepEqual(targetBadge('brand_new'), { label: 'brand_new', tone: 'warn' }, '모르는 상태를 정상으로 보이지 않는다');
}

// --- 숫자 표기 --------------------------------------------------------------------
{
  assert.equal(formatCadence(30), '30분');
  assert.equal(formatCadence(null), '—');
  assert.equal(formatAgeMinutes(34.2), '34분 전');
  assert.equal(formatAgeMinutes(95), '1.6시간 전');
  assert.equal(formatAgeMinutes(60 * 24 * 20), '20일 전');
  assert.equal(formatAgeMinutes(null), '—');
  assert.equal(formatFillRate(target().last_24h), '97.9% (47/48)');
  assert.equal(formatFillRate({ expected_buckets: 0, collected_buckets: 0, off_schedule_buckets: 0, fill_rate: null }), '—', '분모 0 을 0% 로 보이지 않는다');
  assert.equal(formatFillRate({ expected_buckets: null, collected_buckets: 3, off_schedule_buckets: 0, fill_rate: null }), '—');
  assert.equal(describeLastRun(null), '이 서버 시작 뒤 시도 없음');
  assert.match(
    describeLastRun({ state: 'failed', checked_at: '2026-10-31T03:24:00+00:00', error_code: 'seoul_timeout', upstream_code: null, last_success_at: null }),
    /10\.31 12:24 실패 \(seoul_timeout\)/,
  );
}

// --- 전체 배너 --------------------------------------------------------------------
{
  const allFresh = describePipeline(pipeline());
  assert.equal(allFresh.tone, 'ok');
  assert.match(allFresh.title, /2곳 중 2곳 최신/);

  const mixed = describePipeline(pipeline({ targets: [target(), target({ area_nm: '경복궁', state: 'stale' }), target({ area_nm: '인사동', state: 'empty' })] }));
  assert.equal(mixed.tone, 'warn');
  assert.match(mixed.title, /3곳 중 1곳 최신 · 1곳 지연 · 1곳 행 없음/);

  const none = describePipeline(pipeline({ targets: [target({ state: 'empty' })] }));
  assert.equal(none.tone, 'error', '최신이 하나도 없으면 오류');

  const notMigrated = describePipeline(pipeline({ table_state: 'not_migrated', human_step: 'SQL Editor 에서 … 적용(사람 작업)' }));
  assert.equal(notMigrated.tone, 'error');
  assert.match(notMigrated.title, /마이그레이션 미적용/);
  assert.match(notMigrated.detail, /사람 작업/);

  const invalid = describePipeline(pipeline({ schedule_state: 'invalid_config', schedule_error: 'seoul_targets_invalid' }));
  assert.equal(invalid.tone, 'error');
  assert.match(invalid.title, /설정 오류/);

  const noKey = describePipeline(pipeline({ key_configured: false }));
  assert.notEqual(noKey.tone, 'ok', '인증키가 없으면 전부 최신이어도 정상이 아니다');
  assert.match(noKey.detail, /SEOUL_OPENDATA_KEY/);

  for (const notice of [allFresh, mixed, none, notMigrated, invalid, noKey]) {
    assert.doesNotMatch(notice.title + notice.detail, /가동 중/, '상태를 고정 문구로 단정하지 않는다');
  }
}

// --- 호출 예산 --------------------------------------------------------------------
{
  assert.equal(describeBudget(pipeline().budget), '주 호출 720 + 보충 최악 144 = 864회/일 · 한도 1,000 · 여유 136회');
  assert.match(
    describeBudget({ ...pipeline().budget!, worst_case_per_day: 1100, headroom_per_day: -100, within_limit: false }),
    /한도 초과 100회/,
  );
  assert.match(describeBudget(null), /셀 수 없습니다/);
}

// --- 정규화 표 --------------------------------------------------------------------
{
  const ok = describeZones(zones());
  assert.equal(ok.tone, 'ok');
  assert.match(ok.title, /최근 24시간 300행/);

  const missing = describeZones(zones({
    table_state: 'not_migrated', rows_24h: null,
    last_write: { state: 'migration_not_applied', stored_count: 0, errors: { 'seoul:POI007': 'migration_not_applied' }, at: null },
    human_step: "Supabase SQL Editor 에서 supabase/migrations/20261031120000_crowd_zones.sql 을 실행하고 NOTIFY pgrst, 'reload schema'; (사람 작업).",
  }));
  assert.equal(missing.tone, 'error');
  assert.match(missing.title, /정규화 표 미적용 — 20261031120000_crowd_zones\.sql/);
  assert.match(missing.detail, /할 일: Supabase SQL Editor/);
  assert.match(missing.detail, /저장하지 못했습니다/);

  const partial = describeZones(zones({ last_write: { state: 'partial', stored_count: 2, errors: { 'seoul:POI100': 'zone_not_defined' }, at: null } }));
  assert.equal(partial.tone, 'warn', '일부 저장은 정상 색이 아니다');
  assert.match(partial.detail, /seoul:POI100 zone_not_defined/);

  const unknown = describeZones(zones({ last_write: null }));
  assert.equal(unknown.tone, 'info');
  assert.match(unknown.detail, /아직 수집이 없어/);

  assert.equal(describeZones(zones({ table_state: 'empty', rows_24h: 0 })).tone, 'warn');
  assert.equal(describeZones(null).tone, 'info');
}

// --- 결정 품질(S4) ------------------------------------------------------------------
{
  const pending = describeDecisionQuality({ state: 'not_evaluated', stage: 'S4', criterion: 'V3 — 기준', result: null });
  assert.match(pending.title, /S4 재생 평가 전 — 아직 없음/);
  assert.doesNotMatch(pending.title + pending.detail, /\d+(\.\d+)?%/, '수치처럼 보이는 자리를 만들지 않는다');
  assert.match(describeDecisionQuality(null).title, /아직 없음/);
}

// --- 지표 표본 기간 · 차트 간격 ----------------------------------------------------------
{
  assert.equal(sampleSpan(36, 10), '버킷 36개 ≈ 6시간(간격 10분)');
  assert.equal(sampleSpan(36, 30), '버킷 36개 ≈ 18시간(간격 30분)', '30분 주기면 6시간이 아니다');
  assert.equal(sampleSpan(36, null), '버킷 36개');
  assert.equal(chartStepMinutes(30, 10), 30, '실제 간격이 먼저');
  assert.equal(chartStepMinutes(null, 30), 30);
  assert.equal(chartStepMinutes(undefined, undefined), 10);
}

// --- 보정 관문 속도 -----------------------------------------------------------------
{
  const targets = [target(), target({ area_nm: '동대문 관광특구' })];
  const pace = calibrationPace(['명동 관광특구', '동대문 관광특구'], targets, 100, 300);
  assert.match(pace!, /수집 주기 30분 — 하루 최대 96쌍/);
  assert.match(pace!, /200쌍 남음 — 빨라도 약 3일/);
  assert.match(calibrationPace(['명동 관광특구'], targets, 400, 300)!, /채웠습니다/);
  assert.equal(calibrationPace(['명동 관광특구'], [], 0, 300), null, '주기를 모르면 지어내지 않는다');
}

console.log('rehearsalStatus.test.ts OK');
