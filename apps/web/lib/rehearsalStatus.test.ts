// 실시간 데이터 리허설 — 대상지별 수집 상태·정규화 표·결정 품질 문구를 잠근다.
// 핵심: 표가 없거나(not_migrated) 행이 없거나(empty) 늦은(stale) 대상지가 '최신·정상' 으로 보이지 않는다.
import assert from 'node:assert/strict';
import {
  calibrationPace,
  chartStepMinutes,
  clusterLabel,
  countedSinceLabel,
  decisionQualityCards,
  describeBudget,
  describeDecisionQuality,
  describeLastRun,
  describeV3Reason,
  describePipeline,
  describeZones,
  formatAgeMinutes,
  formatCadence,
  formatFillRate,
  formatPointCi,
  formatPointDiff,
  parseDecisionQuality,
  parsePipeline,
  runLabelBadge,
  sampleSpan,
  targetBadge,
  verdictBadge,
  type PipelineTarget,
  type RehearsalPipeline,
  type ZonesStatus,
} from './rehearsalStatus';

function target(over: Partial<PipelineTarget> = {}): PipelineTarget {
  return {
    area_nm: '명동 관광특구', zone_id: 'seoul:POI003', configured: true, state: 'fresh',
    every_buckets: 3, offset_buckets: 2, cadence_minutes: 30, stale_after_minutes: 68,
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
    stale_rule: { formula: 'max(30, 2 × 주기 + 8)분', base_minutes: 30, collection_offset_minutes: 8 },
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

// --- 채움률 분모 시작 ---------------------------------------------------------------
{
  const start = '2026-10-17T03:00:00+00:00';
  assert.equal(countedSinceLabel({ counted_since_at: start }, start), null, '창 시작부터 셌으면 표시 없음');
  assert.equal(countedSinceLabel({ counted_since_at: '2026-10-29T01:10:00+00:00' }, start), '10.29 10:10 수집 시작부터');
  assert.equal(countedSinceLabel({}, start), null, '이전 서버(필드 없음)');
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

  // 인증키 회수·한도 초과 직후: DB 행은 아직 기준 안('최신')이지만 모든 시도가 실패한다 — 초록으로 남지 않는다(검토 M2).
  const failedRun = { state: 'failed', checked_at: '2026-10-31T03:24:00+00:00', error_code: 'seoul_key_invalid', upstream_code: 'INFO-100', last_success_at: null };
  const keyRevoked = describePipeline(pipeline({ targets: [target({ last_run: failedRun }), target({ area_nm: '동대문 관광특구', last_run: failedRun })] }));
  assert.equal(keyRevoked.tone, 'warn');
  assert.match(keyRevoked.title, /2곳 중 2곳 최신 · 2곳 마지막 시도 실패/);
  assert.match(keyRevoked.detail, /seoul_key_invalid/);

  const oneQuota = describePipeline(pipeline({
    targets: [target(), target({ area_nm: '동대문 관광특구', last_run: { ...failedRun, error_code: 'seoul_quota_exceeded', upstream_code: 'ERROR-337' } })],
  }));
  assert.equal(oneQuota.tone, 'warn');
  assert.match(oneQuota.title, /1곳 마지막 시도 실패/);

  const storedRun = { ...failedRun, state: 'stored', error_code: null, upstream_code: null };
  assert.equal(describePipeline(pipeline({ targets: [target({ last_run: storedRun })] })).tone, 'ok', '성공한 시도는 배너를 바꾸지 않는다');

  const wholeRunFailed = describePipeline(pipeline({
    last_run: { state: 'failed', last_run_at: null, last_success_at: null, error_code: 'seoul_key_missing', skipped_targets: [], memory_only: true },
  }));
  assert.equal(wholeRunFailed.tone, 'warn');
  assert.match(wholeRunFailed.title, /마지막 수집 실패\(seoul_key_missing\)/);

  for (const notice of [allFresh, mixed, none, notMigrated, invalid, noKey, keyRevoked, oneQuota, wholeRunFailed]) {
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
  const pending = describeDecisionQuality(parseDecisionQuality({ state: 'not_evaluated', stage: 'S4', criterion: 'V3 — 기준', result: null }));
  assert.match(pending.title, /S4 재생 평가 전 — 아직 없음/);
  assert.doesNotMatch(pending.title + pending.detail, /\d+(\.\d+)?%/, '수치처럼 보이는 자리를 만들지 않는다');
  assert.match(pending.detail, /합격 기준: V3 — 기준/);
  assert.match(describeDecisionQuality(null).title, /아직 없음/);
  assert.deepEqual(decisionQualityCards(null), []);
}

// 서버(crowd/decision_quality.py)가 검사해 보낸 decision_quality_summary/3 한 권역. 홍대 예비 실행 모양.
function dqCluster(over: Record<string, unknown> = {}, v3: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'decision_quality_summary/3', cluster: 'hongdae', zones: ['홍대 관광특구', '연남동', '합정역'],
    run_label: 'pilot', criteria_version: '0139e2f69f47', code_version: 'abc1234',
    period: { first_decision_at: '2026-09-20', last_decision_at: '2026-10-31', days: 42 },
    inputs_sha256: '0'.repeat(64), population: 'crowded_origin_choice_feasible', n_decisions: 812, days: 38, episodes: 91,
    n_disagree: 140, headroom: 0.31, opportunity_rate: 0.42,
    hit_rate: { engine: 0.36, nearest: 0.29, climatology_choice: 0.33, current_band_greedy: 0.35, random: 0.27, oracle: 0.6 },
    hit_vs_now: { engine: 0.4, stay: 0.12 }, harm_rate: { engine: 0.08, nearest: 0.1 },
    verdicts: {
      V3: {
        status: 'fail', criterion: '엔진 − 가장 가까운 곳 적중률 ≥ 0.10 그리고 차의 95% CI 하한 > 0', diff: 0.07,
        ci_low: 0.02, ci_high: 0.12, ci_label: 'percentile_day_block', ci_low_t: 0.015, gate_low: 0.015,
        n: 812, n_distinct: 271, days: 38, n_disagree: 140, n_disagree_distinct: 52, headroom: 0.31,
        criterion_attainable: true, reason: 'diff<0.10', ...v3,
      },
      V4: { status: 'pass', recommendation: 'provider_forecast', lead_bin: 30, mae_provider: 0.412, mae_persistence: 0.48, n: 3000, days: 38, reason: null },
      V2: { status: 'report', share_crowd_gt_travel: 0.22 },
    },
    contrasts: {
      engine_minus_climatology: { diff: 0.03, ci_low: -0.01, ci_high: 0.07 },
      engine_minus_greedy: { diff: 0.01, ci_low: -0.02, ci_high: 0.04 },
    },
    thin_cluster: true, alternatives_per_origin: 2,
    notes: ['실시간 혼잡이 시간대 평균보다 나은 선택을 만들었다는 근거는 없다'],
    limits: [
      "서울에는 NextSpot 사용자가 없다 — '한 사람이 옮겨도 혼잡은 변하지 않는다'는 가정 아래 고른 곳이 도착 때 덜 붐볐는지만 쟀다.",
      '정답은 서울시 4등급이다 — 등급 차이·MAE 는 등간격을 가정한 값이다.',
    ],
    ...over,
  };
}

function evaluated(...clusters: Record<string, unknown>[]) {
  return {
    state: 'evaluated', stage: 'S4', criterion: 'V3 — 기준',
    result: { schema_version: 'decision_quality_summary/3', clusters },
  };
}

// 생성 문장 규칙(계획 generated_text_rule · AGENTS.md): 결론을 앞질러 쓰는 말과 스스로를 평가하는 말이 없다.
const FORBIDDEN = /분산 효과|혼잡 감소|솔직|투명|확실|믿을 수 있/;
function cardText(card: ReturnType<typeof decisionQualityCards>[number]): string {
  return [
    card.title, card.zones, card.runBadge.label, card.v3Badge.label, card.unattainable, card.v3Reason, card.sampleLine,
    card.hitLine, ...card.contrastLines, card.nowLine, card.v4Badge.label, card.v4Line, card.thinNote, ...card.notes,
    card.firstLimit, ...card.moreLimits, card.criteriaLine,
  ].filter(Boolean).join('\n');
}

// 예비(pilot) 홍대 — 미달 · 정식 구간 · 작은 권역
{
  const quality = parseDecisionQuality(evaluated(dqCluster()));
  assert.equal(quality!.state, 'evaluated');
  const notice = describeDecisionQuality(quality);
  assert.match(notice.title, /S4 분산 결정 재생 결과 — 홍대 권역/);
  const [card] = decisionQualityCards(quality);
  assert.equal(card.title, '홍대 권역');
  assert.deepEqual(card.runBadge, { label: '예비 — 기준 확정 전', tone: 'warn' });
  assert.deepEqual(card.v3Badge, { status: 'fail', label: '미달', tone: 'error' });
  assert.equal(card.unattainable, null);
  assert.equal(card.sampleLine, 'n=812(서로 다른 출발지·버킷 271) · 38일 · 불일치 140(서로 다른 출발지·버킷 52) · 여유 31.0%');
  assert.equal(card.hitLine, '엔진 적중 36.0% vs 가장 가까운 곳 29.0% (차 +7.0%p, 95% CI [+2.0, +12.0] · 판정 하한 +1.5%p)');
  assert.equal(card.v3Reason, '차가 기준 +10%p 미만');
  assert.equal(card.contrastLines[0], '시간대 평균 선택 대비 차 +3.0%p (95% CI [−1.0, +7.0])');
  assert.equal(card.contrastLines[1], '현재 등급 탐욕 대비 차 +1.0%p (95% CI [−2.0, +4.0])');
  assert.match(card.v4Line, /^V4 리드 30분 — 권장 서울시 예측 · MAE 서울시 예측 0\.412 vs 지속 0\.480 \(n=3000 · 38일\)$/);
  assert.deepEqual(card.v4Badge, { status: 'pass', label: '통과', tone: 'ok' });
  assert.match(card.thinNote!, /2곳뿐인 작은 권역/);
  assert.match(card.firstLimit!, /^서울에는 NextSpot 사용자가 없다/, '한계 첫 줄은 언제나 사용자 없음');
  assert.equal(card.moreLimits.length, 1);
  assert.match(card.criteriaLine, /기준 0139e2f69f47 · 코드 abc1234 · 2026-09-20~2026-10-31/);
  // '지금보다 덜 붐빔' 은 머물기와 함께만, 머리줄이 아니다.
  assert.equal(card.nowLine, '참고 — 도착 때 출발 시점보다 덜 붐빔: 엔진 40.0% · 머물기 12.0%');
  assert.doesNotMatch(card.hitLine, /머물기|출발 시점/);
  assert.doesNotMatch(cardText(card), FORBIDDEN);
  assert.doesNotMatch(notice.title + notice.detail, FORBIDDEN);
}

// 확인(confirmatory) 종로 — 통과 · 작은 권역 아님 · 두 권역은 서버 순서(이름순) 그대로
{
  const jongno = dqCluster(
    { cluster: 'jongno', run_label: 'confirmatory', thin_cluster: false, alternatives_per_origin: 3 },
    { status: 'pass', diff: 0.14, ci_low: 0.05 },
  );
  const quality = parseDecisionQuality(evaluated(dqCluster(), jongno));
  const cards = decisionQualityCards(quality);
  assert.deepEqual(cards.map((c) => c.cluster), ['hongdae', 'jongno']);
  assert.deepEqual(cards[1].runBadge, { label: '확인', tone: 'info' });
  assert.deepEqual(cards[1].v3Badge, { status: 'pass', label: '통과', tone: 'ok' });
  assert.equal(cards[1].thinNote, null);
  assert.match(describeDecisionQuality(quality).title, /홍대 권역 · 종로 유산 권역/);
  assert.equal(runLabelBadge('exploratory').label, '탐색');
}

// 구조상 달성 불가 · 근사 구간 · 표본 부족 사유
{
  const cluster = dqCluster({}, {
    status: 'insufficient', criterion_attainable: false, headroom: 0.06, ci_label: 'approximate (blocks < 20)',
    reason: 'insufficient: crowded_days<10, n_distinct<100, n_disagree_distinct<30; unattainable_by_construction',
    ci_low_t: null, gate_low: null,
  });
  const [card] = decisionQualityCards(parseDecisionQuality(evaluated(cluster)));
  assert.deepEqual(card.v3Badge, { status: 'insufficient', label: '표본 부족', tone: 'info' });
  assert.match(card.unattainable!, /^구조상 달성 불가 — .*6\.0%/);
  assert.equal(
    card.v3Reason,
    '붐빈 날 10일 미만 · 붐비는 출발지의 서로 다른 (출발지·버킷) 100개 미만 · '
      + '엔진≠가장 가까운 곳인 서로 다른 (출발지·버킷) 30개 미만 · 구조상 달성 불가',
  );
  assert.match(card.hitLine, /, 근사\)$/);
  assert.ok(card.contrastLines.every((line) => line.endsWith(', 근사)')));
  assert.doesNotMatch(cardText(card), FORBIDDEN);
  assert.equal(describeV3Reason(null), null);
  // 모집단이 비어 headroom 이 없으면 달성 가능 여부를 모른다 — '구조상 달성 불가' 를 세우지 않는다.
  const empty = dqCluster({}, {
    status: 'insufficient', criterion_attainable: null, headroom: null, diff: null, n: 0, n_distinct: 0,
    n_disagree: 0, n_disagree_distinct: 0, reason: 'insufficient: n_distinct<100, no_estimate',
  });
  const [emptyCard] = decisionQualityCards(parseDecisionQuality(evaluated(empty)));
  assert.equal(emptyCard.unattainable, null);
  assert.doesNotMatch(cardText(emptyCard), /구조상 달성 불가/);
  // 이전 요약(서로 다른 수 없음)은 표본 줄에 아무것도 붙이지 않는다.
  const old = dqCluster({}, { n_distinct: undefined, n_disagree_distinct: undefined });
  assert.equal(decisionQualityCards(parseDecisionQuality(evaluated(old)))[0].sampleLine, 'n=812 · 38일 · 불일치 140 · 여유 31.0%');
  assert.equal(describeV3Reason('something_new'), 'something_new', '모르는 사유 코드는 그대로');
}

// 미달인데 부트스트랩 95% CI 가 0 을 넘는 경우 — 판정 하한(날짜 군집 t)이 막았다는 사실이 카드에 선다(S4 검토 2차).
{
  const cluster = dqCluster({}, {
    status: 'fail', diff: 0.15, ci_low: 0.02, ci_high: 0.3, ci_label: 'approximate (blocks < 20)', ci_low_t: -0.01,
    gate_low: -0.01, reason: 'gate_low<=0(day_cluster_t)',
  });
  const [card] = decisionQualityCards(parseDecisionQuality(evaluated(cluster)));
  assert.deepEqual(card.v3Badge, { status: 'fail', label: '미달', tone: 'error' });
  assert.equal(card.hitLine, '엔진 적중 36.0% vs 가장 가까운 곳 29.0% (차 +15.0%p, 95% CI [+2.0, +30.0], 근사 · 판정 하한 −1.0%p)');
  assert.equal(card.v3Reason, '판정 하한 ≤ 0 (날짜 군집 t 하한이 부트스트랩 하한보다 낮음)');
  assert.equal(describeV3Reason('diff<0.10; gate_low<=0(bootstrap)'), '차가 기준 +10%p 미만 · 판정 하한 ≤ 0 (부트스트랩 하한)');
  const v4fail = dqCluster({ verdicts: { ...(dqCluster().verdicts as Record<string, unknown>), V4: {
    status: 'fail', recommendation: 'persistence', lead_bin: 30, mae_provider: 0.5, mae_persistence: 0.45, n: 300, days: 12,
    reason: 'mae_provider>=mae_persistence',
  } } });
  const [v4card] = decisionQualityCards(parseDecisionQuality(evaluated(v4fail)));
  assert.match(v4card.v4Line, / · 사유: 서울시 예측 MAE 가 지속보다 낮지 않음$/);
  assert.doesNotMatch(cardText(card) + cardText(v4card), FORBIDDEN);
}

// 값이 없으면 '—' — 0% 로 보이지 않는다. 머물기 값이 없으면 '지금보다' 줄 자체를 쓰지 않는다.
{
  const cluster = dqCluster(
    { hit_rate: { engine: null, nearest: null }, hit_vs_now: { engine: 0.4, stay: null } },
    { diff: null, ci_low: null, ci_high: null, ci_label: null, ci_low_t: null, gate_low: null },
  );
  const [card] = decisionQualityCards(parseDecisionQuality(evaluated(cluster)));
  assert.equal(card.hitLine, '엔진 적중 — vs 가장 가까운 곳 — (차 —, 95% CI [—])');
  assert.equal(card.nowLine, null);
  assert.equal(formatPointDiff(0), '0.0%p');
  assert.equal(formatPointDiff(-0.034), '−3.4%p');
  assert.equal(formatPointCi(0.02, null), '[—]');
}

// 요약 파일 오류 — 숫자 없이 이유만
{
  const quality = parseDecisionQuality({
    state: 'invalid_summary', stage: 'S4', criterion: 'V3', result: null,
    reason: 'hongdae.json: hit_rate.engine 는 0~1 사이 비율이어야 한다',
  });
  assert.equal(quality!.state, 'invalid_summary');
  const notice = describeDecisionQuality(quality);
  assert.equal(notice.tone, 'warn');
  assert.match(notice.title, /요약 파일 오류/);
  assert.match(notice.detail, /^hongdae\.json: hit_rate\.engine/);
  assert.deepEqual(decisionQualityCards(quality), []);
}

// 모르는 모양은 '아직 없음' 문구로 — 반쯤 읽은 숫자를 결과처럼 보이지 않는다.
{
  const garbage: unknown[] = [
    { state: 'evaluated', stage: 'S4', criterion: 'V3', result: null },
    { state: 'evaluated', stage: 'S4', criterion: 'V3', result: { schema_version: 'decision_quality_summary/4', clusters: [dqCluster()] } },
    { state: 'evaluated', stage: 'S4', criterion: 'V3', result: { schema_version: 'decision_quality_summary/3', clusters: [] } },
    evaluated(dqCluster(), { cluster: 'jongno' }),
    evaluated({ ...dqCluster(), verdicts: { V3: { status: 7 } } }),
    { state: 'something_new', stage: 'S5', criterion: '', result: { anything: true } },
  ];
  for (const raw of garbage) {
    const quality = parseDecisionQuality(raw);
    assert.equal(quality!.state, 'not_evaluated', JSON.stringify(raw).slice(0, 80));
    assert.match(describeDecisionQuality(quality).title, /재생 평가 전 — 아직 없음/);
    assert.deepEqual(decisionQualityCards(quality), []);
  }
  assert.equal(parseDecisionQuality('evaluated'), null);
  assert.deepEqual(verdictBadge('weird'), { status: 'unknown', label: 'weird', tone: 'warn' });
  assert.equal(verdictBadge('toString').status, 'unknown', '프로토타입 이름을 판정으로 읽지 않는다');
  assert.equal(clusterLabel('gangnam'), 'gangnam');
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
