// 대시보드 예측·시나리오 모드 — 결정성, 전환 하한, 실측·추정 칸 보호, 문구.
//
// 잡으려는 결함:
//   · 예측 칸이 실측·추정 칸을 덮어쓴다(관측이 예측으로 바뀌면 그건 값을 지어낸 것이다).
//   · 실측 4건을 실측으로 판다 / 5건을 시나리오로 가린다(하한은 서버 hasLogs 와 같은 5).
//   · 하루 진행 몫이 거꾸로 가거나 곡선 값이 0..1 을 벗어난다 / 렌더마다 값이 달라진다.
//   · 시나리오 비율이 시각에 따라 흔들린다(비율은 고정, 건수만 오른다).
//   · 판정만 만들고 화면(page.tsx)이 부르지 않는다 — 마지막 배선 가드.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ANCHOR_MAX,
  ANCHOR_MIN,
  HEATMAP_PLACE_CAP,
  HEATMAP_TYPES,
  MIN_MEASURED_SAMPLES,
  PREDICTED_BADGE,
  PREDICTED_HOUR_SHAPE,
  PREDICTED_HOUR_SHAPE_DEFAULT,
  PREDICTED_PEAK_BY_TYPE,
  PREDICTED_WEEKDAY_FACTOR,
  SCENARIO_BADGE,
  anchorFromEstimate,
  basisSubline,
  csvBasisLabel,
  cumulativeDayShare,
  facilitySpread,
  fillHeatmapPredicted,
  groupFacilitiesByType,
  kstHourToIso,
  kstParts,
  predictedDay,
  predictedDaySummary,
  predictedLevel,
  predictedPeaks,
  resolveKpiBasis,
  scenarioKpis,
  topFacilities,
  type FacilityLite,
  type HeatmapCellInput,
} from './adminPredictedView';
import {
  PREDICTED_BANNER_CHIP,
  PREDICTED_BANNER_HEADLINE,
  PREDICTED_MIXED_SENTENCE,
  PREDICTED_SWITCH_SENTENCE,
  csvBasisCell,
  dashboardDateBadge,
  dashboardEmptyNotice,
  dashboardPeriodLabel,
  predictedBasisLine,
  resolveDashboardView,
  type DashboardTodayWithEstimate,
} from './adminEstimateView';

const WEB = process.cwd(); // 러너가 cwd 를 apps/web 으로 고정한다

// KST 2026-09-26(토) 14:30 = UTC 05:30. 관광지 곡선 피크(14시) — 예측 값이 0 으로 뭉개지지 않는다.
const SAT_1430 = new Date('2026-09-26T05:30:00Z');
// KST 2026-09-22(화) 03:10 = UTC 2026-09-21 18:10.
const TUE_0310 = new Date('2026-09-21T18:10:00Z');

// ── KST 조각 ──────────────────────────────────────────────────────────────────
{
  const p = kstParts(SAT_1430);
  assert.equal(p.dateKst, '2026-09-26');
  assert.equal(p.hour, 14);
  assert.equal(p.minute, 30);
  assert.equal(p.weekday, 5, '토요일은 파이썬 weekday() 기준 5');
  assert.equal(kstParts(TUE_0310).weekday, 1);
  assert.equal(kstParts(TUE_0310).dateKst, '2026-09-22', 'UTC 날짜가 아니라 KST 날짜');
  assert.equal(kstHourToIso('2026-09-26', 14), '2026-09-26T05:00:00.000Z');
}

// ── 이식한 상수가 서버(industry_baseline.py)와 같은 모양 ───────────────────
{
  for (const type of HEATMAP_TYPES) {
    assert.equal(PREDICTED_HOUR_SHAPE[type].length, 24, `${type} 곡선은 24칸`);
    assert.ok(Math.max(...PREDICTED_HOUR_SHAPE[type]) === 1, `${type} 곡선의 피크는 정확히 1.0`);
    assert.ok(type in PREDICTED_PEAK_BY_TYPE);
  }
  assert.equal(PREDICTED_HOUR_SHAPE_DEFAULT.length, 24);
  assert.equal(PREDICTED_WEEKDAY_FACTOR.length, 7);
  assert.equal(PREDICTED_PEAK_BY_TYPE.restaurant, 0.85);
  assert.equal(PREDICTED_HOUR_SHAPE.restaurant[12], 1.0);
  assert.equal(PREDICTED_WEEKDAY_FACTOR[5], 1.0);
  // 서버 get_predicted_baseline_congestion 과 같은 값: 토 14시 관광지 = 0.80 × 1.00 × 1.00
  assert.equal(predictedLevel({ facilityType: 'attraction', kstHour: 14, weekday: 5 }), 0.8);
  // 화 12시 식당 = 0.85 × 1.00 × 0.70 = 0.595
  assert.equal(predictedLevel({ facilityType: 'restaurant', kstHour: 12, weekday: 1 }), 0.595);
  // 한국어 업종명도 같은 곡선(normalize_facility_type 이식).
  assert.equal(predictedLevel({ facilityType: '관광지', kstHour: 14, weekday: 5 }), 0.8);
  // 모르는 업종은 기본 곡선 × 기본 피크.
  assert.equal(predictedLevel({ facilityType: 'shopping', kstHour: 13, weekday: 5 }), Math.round(0.68 * 0.82 * 1000) / 1000);
}

// ── 곡선 값은 언제나 0..1, 그리고 결정적 ──────────────────────────────────────
{
  for (const type of [...HEATMAP_TYPES, 'unknown']) {
    for (let wd = 0; wd < 7; wd += 1) {
      for (let h = 0; h < 24; h += 1) {
        for (const anchor of [ANCHOR_MIN, 1, ANCHOR_MAX]) {
          const v = predictedLevel({ facilityType: type, kstHour: h, weekday: wd, anchor });
          assert.ok(v >= 0 && v <= 1, `${type} ${wd} ${h}시 앵커 ${anchor}: ${v}`);
          assert.equal(v, predictedLevel({ facilityType: type, kstHour: h, weekday: wd, anchor }), '같은 입력에 다른 값');
        }
      }
    }
  }
  assert.equal(facilitySpread('첨성대'), facilitySpread('첨성대'));
  assert.ok(facilitySpread('첨성대') >= 0.9 && facilitySpread('첨성대') <= 1.1);
  assert.notEqual(facilitySpread('첨성대'), facilitySpread('대릉원'), '시설별 폭이 이름을 구분하지 못한다');
}

// ── 앵커: 추정 ÷ 곡선, [0.5, 1.5] 클램프, 추정 없으면 undefined ───────────────
{
  const est = (hour: number, value: number | null): HeatmapCellInput => ({ facility: '첨성대', facilityType: 'attraction', hour, value });
  // 토 12·13·14시 곡선 = 0.8 × (0.92, 0.96, 1.00) → 평균 0.768. 추정이 같으면 앵커 1.
  assert.equal(anchorFromEstimate([est(12, 0.736), est(13, 0.768), est(14, 0.8)], SAT_1430), 1);
  assert.equal(anchorFromEstimate([est(12, 0.2), est(13, 0.2)], SAT_1430), ANCHOR_MIN, '아래로 클램프');
  // 토 8시 관광지 곡선 = 0.8 × 0.35 = 0.28 → 추정 0.9 면 비율 3.2 → 1.5 로 클램프.
  assert.equal(anchorFromEstimate([est(8, 0.9)], SAT_1430), ANCHOR_MAX, '위로 클램프');
  assert.equal(anchorFromEstimate([est(12, 1), est(13, 1), est(14, 1)], SAT_1430), 1.302, '클램프 범위 안이면 비율 그대로(1 ÷ 0.768)');
  assert.equal(anchorFromEstimate([], SAT_1430), undefined);
  assert.equal(anchorFromEstimate([est(12, null)], SAT_1430), undefined, 'null 칸만으로 앵커를 만들지 않는다');
  assert.equal(anchorFromEstimate([est(20, 0.9)], SAT_1430), undefined, '아직 오지 않은 시간의 값은 앵커에 넣지 않는다');
}

// ── 히트맵 채우기: 실측·추정 칸은 절대 덮어쓰지 않는다 ─────────────────────
const FACILITIES: FacilityLite[] = [
  { name: '황남동 쌈밥거리', type: 'restaurant', capacity: 120 },
  { name: '첨성대 앞 국수', type: 'restaurant', capacity: 60 },
  { name: '교촌마을 한정식', type: '음식점', capacity: 60 },
  ...Array.from({ length: 15 }, (_, i) => ({ name: `카페 ${String(i).padStart(2, '0')}`, type: 'cafe', capacity: 40 + i })),
  { name: '경주국립박물관', type: 'culture', capacity: 800 },
  { name: '첨성대', type: 'attraction', capacity: 500 },
  { name: '대릉원', type: 'attraction', capacity: 900 },
];
const byType = groupFacilitiesByType(FACILITIES);
{
  assert.deepEqual(Object.keys(byType).sort(), ['attraction', 'cafe', 'culture', 'restaurant']);
  assert.equal(byType.restaurant.length, 3, '한국어 업종명이 정규화되어 같은 묶음에 든다');
  // 정원 내림차순 → 이름 오름차순, 상한 12.
  assert.deepEqual(topFacilities(byType.restaurant).map((f) => f.name), ['황남동 쌈밥거리', '교촌마을 한정식', '첨성대 앞 국수']);
  assert.equal(topFacilities(byType.cafe).length, HEATMAP_PLACE_CAP);
  assert.equal(topFacilities(byType.cafe)[0].name, '카페 14', '정원이 큰 순');
}
{
  // 서버 추정: 첨성대(관광지) 12~15시. 14:30 기준이라 15시는 '아직 오지 않은 시간' 이지만 값이 있다 → 유지.
  const rows: HeatmapCellInput[] = [
    { facility: '첨성대', facilityType: 'attraction', hour: 12, value: 0.71 },
    { facility: '첨성대', facilityType: 'attraction', hour: 13, value: null }, // 지나간 시간의 빈 칸 → 그대로(수집 중)
    { facility: '첨성대', facilityType: 'attraction', hour: 14, value: 0.93 },
    { facility: '첨성대', facilityType: 'attraction', hour: 15, value: 0.9 },
    { facility: '첨성대', facilityType: 'attraction', hour: 16, value: null }, // 미래의 빈 칸 → 예측
  ];
  const filled = fillHeatmapPredicted({ rows, facilitiesByType: byType, now: SAT_1430, anchor: 1.1 });
  const cell = (facility: string, hour: number) => filled.find((c) => c.facility === facility && c.hour === hour);
  assert.deepEqual(cell('첨성대', 12), { ...rows[0], basis: 'estimate' }, '추정 칸이 바뀌었다');
  assert.deepEqual(cell('첨성대', 14), { ...rows[2], basis: 'estimate' });
  assert.deepEqual(cell('첨성대', 15), { ...rows[3], basis: 'estimate' }, '값이 있는 미래 칸을 예측으로 덮어썼다');
  assert.equal(cell('첨성대', 13)?.value, null, '지나간 시간의 빈 칸을 예측으로 메웠다');
  assert.equal(cell('첨성대', 13)?.basis, 'estimate');
  assert.equal(cell('첨성대', 16)?.basis, 'predicted');
  assert.ok((cell('첨성대', 16)?.value ?? 0) > 0);
  assert.equal(cell('첨성대', 23)?.basis, 'predicted', '서버가 싣지 않은 미래 시간도 예측으로 만든다');
  assert.equal(cell('첨성대', 11), undefined, '서버가 싣지 않은 지나간 시간을 지어내지 않는다');
  // 관광지는 서버 행에 있는 업종이라 대릉원을 추가하지 않는다. 다른 세 업종은 하루 전부 예측.
  assert.equal(cell('대릉원', 14), undefined, '서버 행에 있는 업종에 시설을 더 붙였다');
  assert.equal(filled.filter((c) => c.facilityType === 'restaurant').length, 3 * 24);
  assert.equal(filled.filter((c) => c.facilityType === 'cafe').length, HEATMAP_PLACE_CAP * 24, '업종당 상한이 안 걸린다');
  assert.ok(filled.filter((c) => c.facilityType !== 'attraction').every((c) => c.basis === 'predicted'));
  for (const c of filled) if (c.value !== null) assert.ok(c.value >= 0 && c.value <= 1);
  // 결정성: 같은 입력 → 같은 출력.
  assert.deepEqual(filled, fillHeatmapPredicted({ rows, facilitiesByType: byType, now: SAT_1430, anchor: 1.1 }));
  // 오늘 실측 행이면 그 칸의 근거는 measured.
  const measured = fillHeatmapPredicted({ rows, facilitiesByType: byType, now: SAT_1430, rowsBasis: 'measured' });
  assert.equal(measured.find((c) => c.facility === '첨성대' && c.hour === 12)?.basis, 'measured');
  // 예측 단독 모드(서버 행 없음): 네 업종 전부, 시설 × 24.
  const alone = fillHeatmapPredicted({ rows: [], facilitiesByType: byType, now: SAT_1430 });
  assert.equal(alone.length, (3 + HEATMAP_PLACE_CAP + 1 + 2) * 24);
  assert.ok(alone.every((c) => c.basis === 'predicted'));
}

// ── 피크: 정렬·상한·예측 칸만 ────────────────────────────────────────────────
{
  const alone = fillHeatmapPredicted({ rows: [], facilitiesByType: byType, now: SAT_1430, anchor: 1.3 });
  const peaks = predictedPeaks({ rows: alone, fromHour: 0, threshold: 0.9, limit: 6 });
  assert.ok(peaks.length > 0 && peaks.length <= 6, `피크 ${peaks.length}건 — 상한 6`);
  for (let i = 1; i < peaks.length; i += 1) {
    assert.ok(peaks[i - 1].value >= peaks[i].value, '값 내림차순이 아니다');
  }
  assert.ok(peaks.every((p) => p.value >= 0.9));
  assert.equal(new Set(peaks.map((p) => p.facility)).size, peaks.length, '시설당 한 건');
  assert.deepEqual(peaks, predictedPeaks({ rows: alone, fromHour: 0, threshold: 0.9, limit: 6 }), '피크가 결정적이지 않다');
  assert.equal(predictedPeaks({ rows: alone, fromHour: 0, threshold: 0.9, limit: 2 }).length, 2);
  // 추정·실측 칸은 피크 후보가 아니다(서버 알림과 이중 계상 금지).
  const est = [{ facility: '첨성대', facilityType: 'attraction', hour: 14, value: 0.99, basis: 'estimate' as const }];
  assert.equal(predictedPeaks({ rows: est, fromHour: 0 }).length, 0);
  assert.ok(predictedPeaks({ rows: alone, fromHour: 20 }).every((p) => p.hour >= 20));
}

// ── 요약: 지나간 시간만 평균, 빈 입력은 null(0 이 아니다) ────────────────────
{
  const alone = fillHeatmapPredicted({ rows: [], facilitiesByType: byType, now: SAT_1430 });
  const s = predictedDaySummary({ rows: alone, now: SAT_1430 });
  assert.equal(s.elapsedHours, 15);
  assert.equal(s.placeCount, 3 + HEATMAP_PLACE_CAP + 1 + 2);
  assert.ok(s.avgCongestion !== null && s.avgCongestion > 0 && s.avgCongestion < 1);
  const past = alone.filter((c) => c.hour <= 14 && c.value !== null);
  const expected = Math.round((past.reduce((a, c) => a + (c.value ?? 0), 0) / past.length) * 1000) / 1000;
  assert.equal(s.avgCongestion, expected, '지나간 시간의 평균이 아니다');
  assert.equal(predictedDaySummary({ rows: [], now: SAT_1430 }).avgCongestion, null, '빈 입력에 0 평균을 만들었다');
  assert.equal(predictedDay({ rows: [], now: SAT_1430 }), null);

  const day = predictedDay({ rows: alone, now: SAT_1430, anchor: 1.08 });
  assert.ok(day);
  assert.equal(day.hasLogs, true);
  assert.equal(day.dateKst, '2026-09-26');
  assert.equal(day.avgCongestion?.value, s.avgCongestion);
  assert.equal(day.avgCongestion?.changePercentOrNull, null, '예측끼리의 전일 비교를 변화율로 팔지 않는다');
  assert.equal(day.sourceComposition, null);
  assert.equal(day.info.anchor, 1.08);
  assert.equal(day.info.weekday, 5);
  assert.ok(day.anomalies.every((a) => typeof a.timestamp === 'string' && !Number.isNaN(Date.parse(a.timestamp))));
}

// ── 하루 진행 몫: 0..1, 단조 증가, 자정 0 ────────────────────────────────────
{
  const day = '2026-09-26';
  const atKst = (h: number, m: number) => new Date(kstHourToIso(day, h)).getTime() + m * 60_000;
  assert.equal(cumulativeDayShare(atKst(0, 0)), 0);
  let prev = -1;
  for (let h = 0; h < 24; h += 1) {
    for (const m of [0, 15, 30, 45]) {
      const v = cumulativeDayShare(atKst(h, m));
      assert.ok(v >= 0 && v <= 1);
      assert.ok(v >= prev, `${h}:${m} 에서 진행 몫이 뒤로 갔다`);
      prev = v;
    }
  }
  assert.ok(cumulativeDayShare(atKst(23, 59)) > 0.99);
  assert.ok(cumulativeDayShare(atKst(12, 0)) > 0.3 && cumulativeDayShare(atKst(12, 0)) < 0.6, '정오는 하루의 중간 어디쯤');
}

// ── 시나리오 KPI: 비율 고정, 건수 단조 증가, 출처는 demoFixtures ────────────
{
  const day = '2026-09-26';
  const atKst = (h: number) => new Date(kstHourToIso(day, h)).getTime();
  const morning = scenarioKpis(atKst(9));
  const noon = scenarioKpis(atKst(13));
  const night = scenarioKpis(atKst(21));
  assert.equal(morning.acceptanceRate, noon.acceptanceRate);
  assert.equal(noon.acceptanceRate, night.acceptanceRate);
  assert.equal(morning.acceptanceRate, 0.379, 'DEMO_ADMIN_ALTERNATIVES moved 합 ÷ offered 합');
  for (const key of ['dau', 'relocations', 'savedWaitMinutes'] as const) {
    assert.ok(morning[key] <= noon[key] && noon[key] <= night[key], `${key} 가 하루 동안 오르지 않는다`);
    assert.ok(Number.isInteger(night[key]));
  }
  for (const key of ['offered', 'navigated', 'arrived', 'positive'] as const) {
    assert.ok(morning.funnel[key] <= noon.funnel[key] && noon.funnel[key] <= night.funnel[key]);
  }
  assert.ok(night.funnel.offered >= night.funnel.navigated && night.funnel.navigated >= night.funnel.arrived && night.funnel.arrived >= night.funnel.positive, '깔때기 순서가 뒤집혔다');
  assert.equal(scenarioKpis(atKst(0)).dau, 0);
  // 하루가 끝나면 총량 그대로(demoFixtures 값).
  const end = scenarioKpis(atKst(23) + 59 * 60_000 + 59_000);
  assert.equal(end.relocations, 312);
  assert.equal(end.savedWaitMinutes, 1240);
  assert.equal(end.dau, 468);
  assert.equal(end.funnel.offered, 1013);
  assert.equal(end.funnel.navigated, 384);
  assert.deepEqual(scenarioKpis(atKst(13)), noon, '같은 시각에 다른 값');
}

// ── 전환 하한: 4 → 시나리오(건수 표기), 5 → 실측 ─────────────────────────────
{
  assert.equal(MIN_MEASURED_SAMPLES, 5);
  assert.equal(resolveKpiBasis(4), 'scenario');
  assert.equal(resolveKpiBasis(5), 'measured');
  assert.equal(resolveKpiBasis(0), 'scenario');
  assert.equal(resolveKpiBasis(null), 'scenario');
  assert.equal(resolveKpiBasis(undefined), 'scenario');
  assert.equal(basisSubline({ basis: 'scenario', measuredCount: 3 }), '시나리오 · 도입 목표 패턴 × 시각 진행률 · 실측 3건 수집 중');
  assert.equal(basisSubline({ basis: 'scenario', measuredCount: 4, unit: '명' }), '시나리오 · 도입 목표 패턴 × 시각 진행률 · 실측 4명 수집 중');
  assert.equal(basisSubline({ basis: 'scenario', measuredCount: 0 }), '시나리오 · 도입 목표 패턴 × 시각 진행률 · 실측 5건부터 자동 전환');
  assert.doesNotMatch(basisSubline({ basis: 'scenario', measuredCount: 0 }) ?? '', /0건/, '측정하지 않은 0건을 적었다');
  assert.equal(basisSubline({ basis: 'measured', measuredCount: 12 }), null);
  assert.match(basisSubline({ basis: 'predicted' }) ?? '', /^예측 · 업종 시간대 패턴/);
  assert.match(basisSubline({ basis: 'estimate' }) ?? '', /^추정 · 공영주차 실측/);
  assert.equal(csvBasisLabel('measured'), '실측');
  assert.equal(csvBasisLabel('estimate'), '추정');
  assert.equal(csvBasisLabel('predicted'), PREDICTED_BADGE);
  assert.equal(csvBasisLabel('scenario'), SCENARIO_BADGE);
  assert.equal(PREDICTED_BADGE, '예측');
  assert.equal(SCENARIO_BADGE, '시나리오');
}

// ── resolveDashboardView 의 다섯 번째 갈래: 실측 > 추정 > 예측 > 폴백 ──────────
{
  const alone = fillHeatmapPredicted({ rows: [], facilitiesByType: byType, now: SAT_1430 });
  const pday = predictedDay({ rows: alone, now: SAT_1430 })!;
  const FALLBACK = { dateKst: '2026-07-09', hasLogs: true, avgCongestion: { value: 0.5, changePercent: 0 }, anomalyCount: 1, heatmap: [], anomalies: [] };
  const emptyToday: DashboardTodayWithEstimate = {
    hasLogs: false, avgCongestion: null, anomalyCount: null, heatmap: null, anomalies: null, sampleCount: 2,
    latestObservedAt: '2026-07-09T05:00:00+00:00', fallback: FALLBACK, estimated: null,
  };
  const v = resolveDashboardView(emptyToday, pday);
  assert.equal(v.basis.kind, 'predicted', '예측이 두 달 전 시드 폴백보다 앞선다');
  assert.equal(v.day, pday);
  assert.equal(resolveDashboardView(emptyToday, null).basis.kind, 'fallback', '예측이 없으면 기존 폴백 그대로');
  assert.equal(resolveDashboardView(emptyToday).basis.kind, 'fallback', '두 번째 인자 없이도 기존 동작');
  assert.equal(resolveDashboardView({ failed: true }, pday).basis.kind, 'failed', '서버 실패를 예측으로 가리면 안 된다(갱신 중)');
  assert.equal(resolveDashboardView(null, pday).basis.kind, 'loading');
  assert.equal(resolveDashboardView({ hasLogs: true, avgCongestion: { value: 0.4, changePercent: 0 }, anomalyCount: 0, heatmap: [], anomalies: [] }, pday).basis.kind, 'today', '실측이 있으면 실측');
  if (v.basis.kind === 'predicted') {
    assert.equal(dashboardPeriodLabel(v.basis), '오늘');
    assert.equal(dashboardDateBadge(v.basis), null);
    assert.equal(dashboardEmptyNotice(v.basis), null);
    assert.match(csvBasisCell(v.basis), /업종 시간대 패턴 \+ 관광공사 집중률 기반 예측/);
    assert.equal(predictedBasisLine(v.basis.info), `업종 시간대 패턴 × 요일 계수(토) · 시설 ${pday.info.placeCount}곳`);
    assert.equal(predictedBasisLine({ ...v.basis.info, anchor: 1.08 }), `업종 시간대 패턴 × 요일 계수(토) · 시설 ${pday.info.placeCount}곳 · 오늘 추정 앵커 ×1.08`);
  }
  assert.equal(PREDICTED_BANNER_HEADLINE, '아래 시설 혼잡 지표는 업종 시간대 패턴 + 관광공사 집중률 기반 예측치입니다');
  assert.equal(PREDICTED_BANNER_CHIP, '예측 · 오늘 (KST)');
  assert.equal(PREDICTED_SWITCH_SENTENCE, '공영주차 실측이 쌓이면 추정으로, 현장 관측이 들어오면 실측으로 자동 전환됩니다');
  assert.equal(PREDICTED_MIXED_SENTENCE, '아직 오지 않은 시간과 주차장 반경 밖 시설은 업종 패턴 기반 예측으로 채웠습니다(빗금 표시).');
}

// ── 화면 배선 가드 ────────────────────────────────────────────────────────────
// 판정만 만들고 화면이 부르지 않으면 아무것도 깨지지 않고 기능만 조용히 없다(adminDashboardWiring.test.ts 와 같은 이유).
// 페이지 배선 에이전트가 app/admin/dashboard/page.tsx 에 import 를 넣기 전까지는 이 단언 하나만 빨갛다.
{
  const page = readFileSync(join(WEB, 'app/admin/dashboard/page.tsx'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  // assert.match 는 실패 시 페이지 전문(40KB)을 덤프한다 — 메시지만 남기려고 assert.ok 로 쓴다.
  assert.ok(
    /from '@\/lib\/adminPredictedView'/.test(page),
    "[배선 대기] app/admin/dashboard/page.tsx 가 '@/lib/adminPredictedView' 를 import 하지 않는다 — 예측·시나리오 모드가 화면에 도달하지 못한다(.predicted-mode-brief.md 참조)",
  );
}

console.log('adminPredictedView tests passed');
