// 대안 추천 · 서울 보정 블록의 순수 판정을 잠근다.
//
// 이 두 블록은 "무엇이 실측이고 무엇이 추정인가" 를 문장으로 구분한다. 문구가 틀리면 화면이
// 거짓말을 한다 — 추정으로 만든 추천을 실측처럼 보이게 하거나, 적용하지도 않은 보정을 적용한
// 것처럼 보이게 한다. 그래서 문장 자체를 테스트가 잠근다(engineValidation.test.ts 와 같은 이유).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  alternativeSentence,
  alternativesPath,
  calibrationCurveRows,
  calibrationPath,
  describeAlternativesState,
  describeCalibrationState,
  describeQualityDelta,
  formatPopulationRange,
  formatQualityNumber,
  formatWalk,
  hourShapeRows,
  parseAlternatives,
  parseCalibration,
  topicParticle,
  type AlternativePlace,
  type AlternativeRecommendation,
  type AlternativesResponse,
  type CalibrationResponse,
} from './engineValidation';

const WEB = process.cwd();

function place(over: Partial<AlternativePlace> = {}): AlternativePlace {
  return {
    area_cd: 'POI073', area_nm: '연남동', latitude: 37.5606, longitude: 126.9256,
    is_origin: false, has_data: true, source: 'measured',
    bucket_at: '2026-09-21T05:00:00+00:00', observed_at: '2026-09-21T04:56:00+00:00',
    age_minutes: 6, stale: false, congest_lvl: '여유', grade: 0, level: 0.125,
    ppltn_min: 11000, ppltn_max: 13000, ppltn_midpoint: 12000, normalized_population: 0.4,
    lookback_max_midpoint: 30000, lookback_max_bucket_at: null, lookback_buckets: 900,
    straight_distance_m: 836.2, walk_distance_m: 986.7, walk_minutes: 14.8, walk_source: 'estimated',
    crowd_wait_minutes: 1.9, cost_minutes: 16.7, rank: 1, reason: null, ...over,
  };
}

function recommendation(over: Partial<AlternativeRecommendation> = {}): AlternativeRecommendation {
  return {
    origin: '홍대 관광특구', origin_congest_lvl: '붐빔', origin_grade: 3, origin_cost_minutes: 13.1,
    origin_stale: false, best: '연남동', best_congest_lvl: '여유', best_grade: 0,
    best_walk_minutes: 14.8, best_cost_minutes: 16.7, better: true, grade_gap: 3,
    beats_origin_cost: true, top_ranked: '연남동',
    ranking_note: '순위 = 걷는 시간(분) + 혼잡 대기(분).', reason: null, ...over,
  };
}

function alternatives(over: Partial<AlternativesResponse> = {}): AlternativesResponse {
  return {
    state: 'ready', generated_at: '2026-09-21T05:06:00+00:00',
    migration: '20260920120000_seoul_citydata_snapshots.sql',
    origin: '홍대 관광특구', default_origin: '홍대 관광특구',
    cluster: [
      { area_cd: 'POI007', area_nm: '홍대 관광특구', latitude: 37.5539, longitude: 126.9213 },
      { area_cd: 'POI073', area_nm: '연남동', latitude: 37.5606, longitude: 126.9256 },
      { area_cd: 'POI053', area_nm: '합정역', latitude: 37.5497, longitude: 126.9137 },
    ],
    source: 'measured', source_note: '서울시 실시간 인구는 …서울시의 추정치다.',
    attribution: '서울특별시 서울 실시간 도시데이터 (공공누리 제1유형)',
    stale_after_minutes: 30, lookback_days: 7,
    grade_labels: ['여유', '보통', '약간 붐빔', '붐빔'],
    grade_levels: { '여유': 0.125, '보통': 0.375, '약간 붐빔': 0.625, '붐빔': 0.875 },
    walking: { method: 'haversine_x_route_factor', speed_m_per_min: 66.67, route_factor: 1.18, note: '직선거리 × 1.18 …' },
    latest_bucket_at: '2026-09-21T05:00:00+00:00', latest_age_minutes: 6,
    places: [place({ area_nm: '홍대 관광특구', is_origin: true, congest_lvl: '붐빔', grade: 3, walk_minutes: 0, rank: null }), place()],
    ranking: ['연남동'], recommendation: recommendation(), ...over,
  };
}

// --- 경로 ------------------------------------------------------------------------
{
  // 한글 대상지 이름은 반드시 인코딩된다 — 날것으로 붙이면 요청이 깨지거나 다른 곳이 선택된다.
  assert.equal(alternativesPath('연남동'), '/api/v1/admin/engine-validation/seoul/alternatives?origin=%EC%97%B0%EB%82%A8%EB%8F%99');
  assert.match(alternativesPath('홍대 관광특구'), /origin=%ED%99%8D%EB%8C%80%20%EA%B4%80%EA%B4%91%ED%8A%B9%EA%B5%AC$/);
  assert.match(alternativesPath('  '), /origin=%ED%99%8D%EB%8C%80/, '빈 값은 기본 출발지로');
  assert.equal(calibrationPath(28), '/api/v1/admin/engine-validation/seoul/calibration?days=28');
  assert.equal(calibrationPath(999), '/api/v1/admin/engine-validation/seoul/calibration?days=28');
}

// --- 응답 형태 --------------------------------------------------------------------
{
  assert.equal(parseAlternatives(null), null);
  assert.equal(parseAlternatives({ state: 'weird', places: [], cluster: [] }), null);
  assert.equal(parseAlternatives({ state: 'ready', cluster: [] }), null, 'places 가 없으면 모르는 모양이다');
  const parsed = parseAlternatives({ ...alternatives(), places: [place(), { junk: true }] });
  assert.ok(parsed);
  assert.equal(parsed.places.length, 1, '모양이 아닌 항목은 버린다');
  assert.equal(parsed.recommendation?.best, '연남동');
}

// --- 상태 배너 --------------------------------------------------------------------
{
  assert.match(describeAlternativesState(alternatives({ state: 'not_migrated' })).title, /수집 시작 전/);
  assert.equal(describeAlternativesState(alternatives({ state: 'empty' })).tone, 'info');
  const stale = describeAlternativesState(alternatives({ state: 'stale', latest_age_minutes: 95 }));
  assert.equal(stale.tone, 'warn');
  assert.match(stale.title, /지금 값이 아닙니다/);
  const ready = describeAlternativesState(alternatives());
  assert.equal(ready.tone, 'ok');
  assert.match(ready.detail, /서울시가 잰 값/, '실측만으로 돈다는 사실을 항상 말한다');
  assert.match(ready.detail, /level_est/, '추정치를 쓰지 않는다는 사실도 같이 말한다');
}

// --- 추천 문장 --------------------------------------------------------------------
{
  // 1) 정상: "붐빔 → 걸어서 15분 거리의 연남동은 여유"
  const sentence = alternativeSentence(alternatives());
  assert.match(sentence, /홍대 관광특구는 지금 붐빔/);
  assert.match(sentence, /걸어서 15분 거리의 연남동은 여유입니다/);

  // 2) 걷는 시간이 이득보다 크면 그 사실을 덧붙인다 — 과장하지 않는다.
  const costly = alternativeSentence(alternatives({ recommendation: recommendation({ beats_origin_cost: false }) }));
  assert.match(costly, /머무르는 편이 빠를 수 있습니다/);

  // 3) 이웃이 덜 붐비지 않으면 대안을 지어내지 않는다.
  const noBetter = alternativeSentence(
    alternatives({ recommendation: recommendation({ better: false, best: null, best_congest_lvl: null, grade_gap: 0 }) }),
  );
  assert.match(noBetter, /덜 붐비지 않습니다/);
  assert.doesNotMatch(noBetter, /거리의/, '없는 대안을 문장에 넣지 않는다');

  // 4) 오래된 값은 '지금' 이라고 쓰지 않는다 — 관측 시각으로 말한다.
  const stale = alternativeSentence(alternatives({ state: 'stale' }));
  assert.doesNotMatch(stale, /지금/);
  assert.match(stale, /기준 붐빔/);

  // 5) 표본이 없으면 추천하지 않는다.
  assert.match(alternativeSentence(alternatives({ state: 'empty' })), /계산할 수 없습니다/);
  assert.match(
    alternativeSentence(alternatives({ recommendation: recommendation({ origin_grade: null, origin_congest_lvl: null }) })),
    /실측 등급이 아직 없어/,
  );
}

// --- 조사 ------------------------------------------------------------------------
// 대상지 이름은 설정값이라 조사를 문장에 박아 둘 수 없다 — '연남동는' 이 화면에 나가면 안 된다.
{
  assert.equal(topicParticle('연남동'), '은');
  assert.equal(topicParticle('홍대 관광특구'), '는');
  assert.equal(topicParticle('합정역'), '은');
  assert.equal(topicParticle('POI007'), '는', '한글이 아니면 무난한 쪽으로');
  assert.equal(topicParticle(''), '는');
}

// --- 값 표기 ----------------------------------------------------------------------
{
  assert.equal(formatWalk(14.8), '15분');
  assert.equal(formatWalk(0), '여기');
  assert.equal(formatWalk(0.4), '1분 미만');
  assert.equal(formatWalk(null), '—');
  assert.equal(formatPopulationRange(11000, 13000), '11,000~13,000명');
  assert.equal(formatPopulationRange(null, 13000), '약 13,000명');
  assert.equal(formatPopulationRange(null, null), '—');
  assert.equal(formatQualityNumber(null), '—', '0 으로 보이면 오차가 없다는 뜻이 된다');
  assert.equal(formatQualityNumber(0.1234), '0.123');
}

// --- 보정: 응답 형태 --------------------------------------------------------------
function calibration(over: Partial<CalibrationResponse> = {}): CalibrationResponse {
  return {
    state: 'ready', applied: false, places: ['명동 관광특구', '동대문 관광특구'], window_days: 28,
    generated_at: '2026-10-05T12:00:00+00:00',
    sample: { paired_buckets: 900, days: 21, first_bucket_at: null, last_bucket_at: null },
    requirement: { min_paired_buckets: 500, min_days: 14, must_beat_identity: true },
    curve: { method: 'isotonic', knots: [{ x: 0, y: 0 }, { x: 0.5, y: 0.62 }, { x: 1, y: 0.9 }], fitted_at: '2026-10-05T11:00:00+00:00' },
    quality: {
      holdout_days: 7, mae_identity: 0.21, mae_calibrated: 0.17,
      spearman_identity: 0.41, spearman_calibrated: 0.53, improved: true,
    },
    hour_shape: {
      seoul: [{ hour: 12, weekday_mean: 0.7, weekend_mean: 0.8, n: 30 }, { hour: 3, weekday_mean: 0.1, weekend_mean: 0.2, n: 0 }],
      gyeongju_parking: [{ hour: 12, weekday_mean: 0.5, weekend_mean: 0.9, n: 20 }],
    },
    gyeongju_effect: { samples: [{ raw: 0.4, calibrated: 0.52 }], median_shift: 0.08 },
    reason: null, ...over,
  };
}

{
  assert.equal(parseCalibration(null), null);
  assert.equal(parseCalibration({ state: 'ready' }), null, 'applied 는 이 블록의 결론이라 없으면 모르는 모양이다');
  assert.equal(parseCalibration({ state: 'fitted', applied: true }), null);
  const parsed = parseCalibration({ ...calibration(), curve: { method: 'isotonic', knots: [{ x: 0, y: 0 }, { junk: 1 }], fitted_at: null } });
  assert.ok(parsed);
  assert.equal(parsed.curve?.knots.length, 1, '모양이 아닌 매듭은 버린다');
  const noCurve = parseCalibration({ ...calibration(), curve: null, quality: null });
  assert.ok(noCurve);
  assert.equal(noCurve.curve, null);
  // 서버가 sample/requirement 를 빠뜨려도 숫자 자리가 undefined 로 새지 않는다.
  const bare = parseCalibration({ state: 'empty', applied: false, hour_shape: {} });
  assert.ok(bare);
  assert.equal(bare.sample.paired_buckets, 0);
  assert.equal(bare.requirement.min_days, 0);
  assert.deepEqual(bare.hour_shape.seoul, []);
}

// --- 보정: 상태 문구 --------------------------------------------------------------
{
  // 404 = 아직 배포 전. 오류 배너가 아니라 조용한 안내여야 한다.
  const notDeployed = describeCalibrationState('not_deployed', null);
  assert.equal(notDeployed.tone, 'info');
  assert.match(notDeployed.title, /아직 배포되지 않았습니다/);

  const insufficient = describeCalibrationState('insufficient', calibration({ state: 'insufficient', sample: { paired_buckets: 120, days: 3, first_bucket_at: null, last_bucket_at: null } }));
  assert.match(insufficient.title, /120개 \/ 최소 500개/);
  assert.match(insufficient.detail, /3일치 \/ 최소 14일/);

  // 곡선이 있어도 적용 전이면 '적용하지 않았다' 가 먼저다.
  const fittedNotApplied = describeCalibrationState('ready', calibration({ applied: false }));
  assert.equal(fittedNotApplied.tone, 'warn');
  assert.match(fittedNotApplied.title, /적용하지 않았습니다/);
  assert.match(fittedNotApplied.detail, /항등 유지/);

  const applied = describeCalibrationState('ready', calibration({ applied: true }));
  assert.equal(applied.tone, 'ok');
  assert.match(applied.title, /적용 중/);

  // 모양이 다르면 반쯤 그리지 않고 형식 불일치라고 말한다.
  assert.match(describeCalibrationState('ready', null).title, /형식이 이 화면과 맞지 않습니다/);
}

// --- 보정: 차트 행 ----------------------------------------------------------------
{
  assert.deepEqual(calibrationCurveRows(null), []);
  const rows = calibrationCurveRows({ method: 'isotonic', knots: [{ x: 1, y: 0.9 }, { x: 0, y: 0 }], fitted_at: null });
  assert.deepEqual(rows.map((row) => row.x), [0, 1], 'x 순으로 정렬한다');
  assert.deepEqual(rows.map((row) => row.identity), [0, 1], '항등 대각선을 같은 행에 넣는다');
  assert.equal(rows[1].calibrated, 0.9);

  const shape = hourShapeRows(calibration().hour_shape);
  assert.deepEqual(shape.map((row) => row.hour), [3, 12], '시각 순으로 세운다');
  assert.equal(shape[0].seoul_weekday, null, '표본 0인 시각은 값을 만들지 않는다 — 0 으로 채우면 없는 모양이 생긴다');
  assert.equal(shape[1].seoul_weekday, 0.7);
  assert.equal(shape[1].parking_weekend, 0.9);
  assert.equal(shape[0].parking_weekday, null, '한쪽에만 있는 시각은 다른 쪽이 null 이다');
  assert.equal(shape[1].label, '12시');
  assert.deepEqual(hourShapeRows(null), []);
}

// --- 품질 비교 --------------------------------------------------------------------
{
  assert.equal(describeQualityDelta(0.21, 0.17, true), '항등보다 0.040 좋음');
  assert.equal(describeQualityDelta(0.21, 0.28, true), '항등보다 0.070 나쁨');
  assert.equal(describeQualityDelta(0.41, 0.53, false), '항등보다 0.120 좋음');
  assert.equal(describeQualityDelta(0.4, 0.4, false), '항등과 같음');
  assert.equal(describeQualityDelta(null, 0.3, true), '비교 불가');
}

// --- 화면 배선 --------------------------------------------------------------------
// 두 블록이 실제로 페이지에 붙어 있어야 하고, '무엇이 실측이고 무엇이 대용인가' 문구가 살아 있어야 한다.
{
  const page = readFileSync(join(WEB, 'app/admin/engine-validation/page.tsx'), 'utf8');
  assert.match(page, /<SeoulAlternativesPanel \/>/);
  assert.match(page, /<SeoulCalibrationPanel \/>/);
  assert.match(page, /주차는 경주의 임시 대용이다/);
  assert.match(page, /실시간 유동인구/);

  const panel = readFileSync(join(WEB, 'components/admin/engine-validation/SeoulAlternativesPanel.tsx'), 'utf8');
  assert.match(panel, /실시간 인구로 돌린 대안 추천/);
  assert.match(panel, /alternativeSentence/);
  assert.match(panel, /level_est/, '추정치를 쓰지 않는다는 사실을 화면에 적는다');

  const calibrationPanel = readFileSync(join(WEB, 'components/admin/engine-validation/SeoulCalibrationPanel.tsx'), 'utf8');
  assert.match(calibrationPanel, /서울 실측으로 보정/);
  assert.match(calibrationPanel, /adminApiStatus\(err\) === 404/, '404 는 조용한 미배포 상태로 가른다');
  assert.match(calibrationPanel, /항등/);
}

console.log('engineValidationAlternatives.test.ts OK');
