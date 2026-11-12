// 대시보드 예측·시나리오 모드 — 결정성, 전환 하한, 실측·추정 칸 보호, 문구.
//
// 잡으려는 결함:
//   · 예측 칸이 실측·추정 칸을 덮어쓴다(관측이 예측으로 바뀌면 그건 값을 지어낸 것이다).
//   · 실측 4건을 실측으로 판다 / 5건을 시나리오로 가린다(하한은 서버 hasLogs 와 같은 5).
//   · 하루 진행 몫이 거꾸로 가거나 곡선 값이 0..1 을 벗어난다 / 렌더마다 값이 달라진다.
//   · 시나리오 비율이 시각에 따라 흔들린다(비율은 고정, 건수만 오른다).
//   · 앵커가 밤·새벽 칸 때문에 늘 상한에 붙어 예측 칸이 100% 로 몰린다 / 예측이 '만석' 으로 읽힌다.
//   · 추천 고리 패널이 따로 전환해 실측 '0건 수락' 옆에 시나리오 '179건 재배치' 가 선다.
//   · 예측 단독 문구가 쓰지도 않은 입력(관광공사 집중률)을 근거로 적는다.
//   · 이식한 곡선 상수가 서버(industry_baseline.py)와 조용히 갈라진다.
//   · 판정만 만들고 화면(page.tsx)이 부르지 않는다 — 마지막 배선 가드.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ANCHOR_HOUR_MIN_SHAPE,
  ANCHOR_MAX,
  ANCHOR_MIN,
  HEATMAP_PLACE_CAP,
  HEATMAP_TYPES,
  MIN_MEASURED_SAMPLES,
  PREDICTED_BADGE,
  PREDICTED_HOUR_SHAPE,
  PREDICTED_HOUR_SHAPE_DEFAULT,
  PREDICTED_LEVEL_MAX,
  PREDICTED_PEAK_BY_TYPE,
  PREDICTED_PEAK_DEFAULT,
  PREDICTED_WEEKDAY_FACTOR,
  SCENARIO_BADGE,
  anchorFromEstimate,
  basisSubline,
  csvBasisLabel,
  cumulativeDayShare,
  fillHeatmapPredicted,
  groupFacilitiesByType,
  kstHourToIso,
  kstParts,
  peakLabel,
  predictedDay,
  predictedDaySummary,
  predictedLevel,
  predictedPeaks,
  resolveKpiBasis,
  resolveLoopBasis,
  scenarioKpis,
  topFacilities,
  type FacilityLite,
  type HeatmapCellInput,
} from './adminPredictedView';
import {
  PREDICTED_BANNER_CHIP,
  PREDICTED_BANNER_HEADLINE,
  PREDICTED_MIXED_SENTENCE,
  PREDICTED_MIXED_SENTENCE_MEASURED,
  PREDICTED_SWITCH_SENTENCE,
  csvBasisCell,
  dashboardDateBadge,
  dashboardEmptyNotice,
  dashboardPeriodLabel,
  predictedBannerHeadline,
  predictedBasisLine,
  predictedMethodNote,
  resolveDashboardView,
  todayFieldSampleNote,
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

// ── 곡선 값은 언제나 0..PREDICTED_LEVEL_MAX(< 1), 그리고 결정적 ────────────────
{
  assert.ok(PREDICTED_LEVEL_MAX < 1, '예측이 100%(만석)로 읽힐 수 있다');
  for (const type of [...HEATMAP_TYPES, 'unknown']) {
    for (let wd = 0; wd < 7; wd += 1) {
      for (let h = 0; h < 24; h += 1) {
        for (const anchor of [ANCHOR_MIN, 1, ANCHOR_MAX, 3]) {
          const v = predictedLevel({ facilityType: type, kstHour: h, weekday: wd, anchor });
          assert.ok(v >= 0 && v <= PREDICTED_LEVEL_MAX, `${type} ${wd} ${h}시 앵커 ${anchor}: ${v}`);
          assert.equal(v, predictedLevel({ facilityType: type, kstHour: h, weekday: wd, anchor }), '같은 입력에 다른 값');
        }
        // 앵커가 없으면 상한이 걸리지 않는다 — 서버 get_predicted_baseline_congestion 과 같은 식 그대로.
        const peak = PREDICTED_PEAK_BY_TYPE[type] ?? PREDICTED_PEAK_DEFAULT;
        const shape = PREDICTED_HOUR_SHAPE[type] ?? PREDICTED_HOUR_SHAPE_DEFAULT;
        assert.equal(
          predictedLevel({ facilityType: type, kstHour: h, weekday: wd }),
          Math.round(Math.max(0, Math.min(1, peak * shape[h] * PREDICTED_WEEKDAY_FACTOR[wd])) * 1000) / 1000,
          `${type} ${wd} ${h}시 — 앵커 없는 예측이 서버 식과 다르다`,
        );
      }
    }
  }
}

// ── 앵커: 곡선이 의미 있는 낮 시간만, 추정 ÷ 곡선, [0.5, 1.2] 클램프, 없으면 undefined ──
{
  assert.equal(ANCHOR_MAX, 1.2);
  const est = (hour: number, value: number | null): HeatmapCellInput => ({ facility: '첨성대', facilityType: 'attraction', hour, value });
  // 토 12·13·14시 곡선 = 0.8 × (0.92, 0.96, 1.00) → 평균 0.768. 추정이 같으면 앵커 1.
  assert.equal(anchorFromEstimate([est(12, 0.736), est(13, 0.768), est(14, 0.8)], SAT_1430), 1);
  assert.equal(anchorFromEstimate([est(12, 0.2), est(13, 0.2)], SAT_1430), ANCHOR_MIN, '아래로 클램프');
  assert.equal(anchorFromEstimate([est(14, 1)], SAT_1430), ANCHOR_MAX, '위로 클램프(1 ÷ 0.8 = 1.25 → 1.2)');
  assert.equal(anchorFromEstimate([est(12, 0.85), est(13, 0.85), est(14, 0.85)], SAT_1430), 1.107, '클램프 범위 안이면 비율 그대로(0.85 ÷ 0.768)');
  // 곡선이 피크의 70% 미만인 시간(관광지 8시 = 0.35)은 앵커에 넣지 않는다 — 밤·아침의 바닥값이 비를 부풀린다.
  assert.ok(PREDICTED_HOUR_SHAPE.attraction[8] < ANCHOR_HOUR_MIN_SHAPE);
  assert.equal(anchorFromEstimate([est(8, 0.9)], SAT_1430), undefined, '곡선이 낮은 시간의 값으로 앵커를 만들었다');
  assert.equal(anchorFromEstimate([est(3, 0.2), est(14, 0.8)], SAT_1430), 1, '새벽 칸이 앵커에 섞였다');
  assert.equal(anchorFromEstimate([], SAT_1430), undefined);
  assert.equal(anchorFromEstimate([est(12, null)], SAT_1430), undefined, 'null 칸만으로 앵커를 만들지 않는다');
  assert.equal(anchorFromEstimate([est(20, 0.9)], SAT_1430), undefined, '아직 오지 않은 시간의 값은 앵커에 넣지 않는다');
}

// ── 현실적인 하루 추정(10분 스냅샷 × 대표 관광지 10곳)은 앵커를 상한에 붙이지 않는다 ────────
// 서버 추정 = 0.7 × 주차 점유율 + 0.3 × 관광공사 집중률 — 주차 점유율에는 밤에도 바닥값이 있다. 예전 식(0시부터
// 평균, 상한 1.5)은 이 바닥값 때문에 앵커가 늘 1.44~1.5 에 붙었고, 예측 피크 목록이 '100%' 여섯 줄이 됐다.
{
  const ATTR = PREDICTED_HOUR_SHAPE.attraction;
  const PLACES: [string, number][] = [
    ['첨성대', 1.0], ['대릉원', 0.97], ['월정교', 0.95], ['동궁과 월지', 0.92], ['황리단길', 1.02],
    ['경주 교촌마을', 0.85], ['분황사', 0.7], ['오릉', 0.6], ['포석정', 0.58], ['양동마을', 0.8],
  ];
  const estimateDay = (now: Date): HeatmapCellInput[] => {
    const nowHour = kstParts(now).hour;
    return PLACES.flatMap(([facility, k]) =>
      Array.from({ length: 24 }, (_, hour) => ({
        facility,
        facilityType: 'attraction',
        hour,
        value: hour <= nowHour ? Math.round(Math.min(0.99, 0.18 + 0.78 * ATTR[hour] * k) * 100) / 100 : null,
      })),
    );
  };
  const rows = estimateDay(SAT_1430);
  const anchor = anchorFromEstimate(rows, SAT_1430);
  assert.ok(anchor !== undefined && anchor > ANCHOR_MIN && anchor < ANCHOR_MAX, `현실적 추정인데 앵커가 경계에 붙었다: ${anchor}`);
  // 오전 9시대(관광지 곡선이 아직 피크의 70% 미만)에는 앵커를 만들지 않는다 — 곡선 그대로.
  assert.equal(anchorFromEstimate(estimateDay(new Date('2026-09-26T00:10:00Z')), new Date('2026-09-26T00:10:00Z')), undefined);
  // 자정 직후도 마찬가지.
  assert.equal(anchorFromEstimate(estimateDay(new Date('2026-09-26T15:20:00Z')), new Date('2026-09-26T15:20:00Z')), undefined);
  // 평평한 추정(test_admin_dashboard_estimate.py 모양, 0.66)도 경계에 붙지 않는다.
  const flat = rows.map((r) => ({ ...r, value: r.value === null ? null : 0.66 }));
  const flatAnchor = anchorFromEstimate(flat, SAT_1430);
  assert.ok(flatAnchor !== undefined && flatAnchor > ANCHOR_MIN && flatAnchor < ANCHOR_MAX, `평평한 추정의 앵커 ${flatAnchor}`);

  const fac = groupFacilitiesByType(
    ['restaurant', 'cafe', 'culture'].flatMap((type) =>
      Array.from({ length: 12 }, (_, i) => ({ name: `${type}-${i}`, type, capacity: 100 - i })),
    ),
  );
  const filled = fillHeatmapPredicted({ rows, facilitiesByType: fac, now: SAT_1430, anchor, rowsBasis: 'estimate' });
  const predicted = filled.filter((c) => c.basis === 'predicted');
  assert.ok(predicted.length > 0);
  assert.ok(predicted.every((c) => c.value !== null && c.value < PREDICTED_LEVEL_MAX), '현실적 추정에서 예측 칸이 상한에 붙었다');
  // 경계 연속성: 한산한 곳(오릉)의 다음 시간 예측이 그 시설의 추정 흐름을 잇는다(전체 앵커로 튀지 않는다).
  const at = (facility: string, hour: number) => filled.find((c) => c.facility === facility && c.hour === hour);
  const orung14 = at('오릉', 14)!;
  const orung15 = at('오릉', 15)!;
  assert.equal(orung14.basis, 'estimate');
  assert.equal(orung15.basis, 'predicted');
  assert.ok(Math.abs((orung15.value ?? 0) - (orung14.value ?? 0)) < 0.1, `오릉 14시 추정 ${orung14.value} → 15시 예측 ${orung15.value}`);
  // 같은 업종·같은 시각이면 시설 이름과 무관하게 같은 값(이름 해시로 순위를 지어내지 않는다).
  const r19 = predicted.filter((c) => c.facilityType === 'restaurant' && c.hour === 19).map((c) => c.value);
  assert.equal(r19.length, 12);
  assert.equal(new Set(r19).size, 1, '같은 업종·시각인데 시설마다 값이 다르다');
  // 예측 피크는 같은 업종·시각·값을 한 줄로 묶는다.
  const peaks = predictedPeaks({ rows: filled, fromHour: 15 });
  const restaurantPeak = peaks.find((p) => p.facilityType === 'restaurant');
  if (restaurantPeak) {
    assert.equal(restaurantPeak.placeCount, 12);
    assert.equal(peakLabel(restaurantPeak), '음식점 12곳');
  }
  assert.ok(peaks.every((p) => p.value < PREDICTED_LEVEL_MAX));
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
  // 추정 행이 있는 시설의 미래 칸은 그 시설의 추정에서 뽑은 앵커를 쓴다(12·14시 평균 0.82 ÷ 곡선 0.768).
  assert.equal(cell('첨성대', 16)?.value, predictedLevel({ facilityType: 'attraction', kstHour: 16, weekday: 5, anchor: 1.068 }));
  // 오늘 실측 행이면 그 칸의 근거는 measured.
  const measured = fillHeatmapPredicted({ rows, facilitiesByType: byType, now: SAT_1430, rowsBasis: 'measured' });
  assert.equal(measured.find((c) => c.facility === '첨성대' && c.hour === 12)?.basis, 'measured');
  // 실측 격자에서는 행이 없는 업종도 **아직 오지 않은 시간만** 예측 — 지나간 시간의 관측 옆에 모델값을 세우지 않는다.
  const measuredRestaurant = measured.filter((c) => c.facilityType === 'restaurant');
  assert.equal(measuredRestaurant.length, 3 * 9, '실측 격자의 지나간 시간을 예측으로 채웠다');
  assert.ok(measuredRestaurant.every((c) => c.hour >= 15 && c.basis === 'predicted'));
  // 실측 격자에는 추정 앵커를 붙이지 않는다(실측에서 앵커를 지어내지 않는다).
  assert.equal(
    measured.find((c) => c.facility === '첨성대' && c.hour === 16)?.value,
    predictedLevel({ facilityType: 'attraction', kstHour: 16, weekday: 5 }),
  );
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
  assert.ok(peaks.every((p) => p.value >= 0.9 && p.value <= PREDICTED_LEVEL_MAX));
  assert.equal(new Set(peaks.map((p) => p.facility)).size, peaks.length, '시설당 한 건');
  // 같은 업종·시각·값은 한 줄 — 음식점 3곳이 같은 값이면 '음식점 3곳' 한 줄이다(이름만 바꾼 여러 줄 금지).
  const keys = peaks.map((p) => `${p.facilityType}|${p.hour}|${p.value}`);
  assert.equal(new Set(keys).size, keys.length, '같은 업종·시각·값이 여러 줄로 나왔다');
  const restaurantGroup = peaks.find((p) => p.facilityType === 'restaurant');
  assert.ok(restaurantGroup && restaurantGroup.placeCount === 3, '음식점 세 곳이 한 줄로 묶이지 않았다');
  assert.equal(peakLabel(restaurantGroup), '음식점 3곳');
  assert.equal(peakLabel({ facility: '첨성대', facilityType: 'attraction', placeCount: 1 }), '첨성대');
  assert.equal(peakLabel({ facility: 'x', facilityType: 'shopping', placeCount: 2 }), '시설 2곳');
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
  // 예측 단독(앵커 없음)은 서버 곡선 그대로라 90% 에 닿지 않는다(곡선 최댓값 0.85) — 예측 이상 혼잡 0구간.
  const plain = predictedDay({ rows: alone, now: SAT_1430 })!;
  assert.equal(plain.anomalyCount, 0);
  assert.equal(plain.anomalies.length, 0);
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
    // 예측 단독(앵커 없음)은 관광공사 집중률·주차 실측을 쓰지 않는다 — 쓰지 않은 입력을 근거로 적지 않는다.
    assert.equal(v.basis.info.anchor, undefined);
    assert.match(csvBasisCell(v.basis), /업종 시간대 패턴 기반 예측/);
    assert.doesNotMatch(csvBasisCell(v.basis), /관광공사|주차/, 'CSV 근거가 쓰지 않은 입력을 적었다');
    assert.doesNotMatch(predictedBannerHeadline(v.basis.info), /관광공사|주차/, '배너 제목이 쓰지 않은 입력을 적었다');
    assert.equal(predictedBannerHeadline(v.basis.info), PREDICTED_BANNER_HEADLINE);
    // 앵커가 실제로 곱해졌을 때만 추정(주차 + 관광공사)을 입력으로 적는다.
    assert.match(predictedBannerHeadline({ anchor: 1.08 }), /앵커/);
    assert.match(csvBasisCell({ ...v.basis, info: { ...v.basis.info, anchor: 1.08 } }), /오늘 추정 앵커/);
    assert.equal(predictedBasisLine(v.basis.info), `업종 시간대 패턴 × 요일 계수(토) · 시설 ${pday.info.placeCount}곳`);
    assert.equal(predictedBasisLine({ ...v.basis.info, anchor: 1.08 }), `업종 시간대 패턴 × 요일 계수(토) · 시설 ${pday.info.placeCount}곳 · 오늘 추정 앵커 ×1.08`);
    // 평균 구간은 0시~현재 시(14:30 → 0~14시). 시설 선정 규칙(정원 순 상위 N곳)은 화면 문구에 적지 않는다.
    const method = predictedMethodNote(v.basis.info);
    assert.match(method, /0~14시 평균/);
    assert.doesNotMatch(method, /15시|정원|상위/, `산식 문구: ${method}`);
    assert.doesNotMatch(method, /앵커/);
  }
  assert.equal(PREDICTED_BANNER_HEADLINE, '아래 시설 혼잡 지표는 업종 시간대 패턴 기반 예측치입니다');
  assert.equal(PREDICTED_BANNER_CHIP, '예측 · 오늘 (KST)');
  assert.equal(PREDICTED_SWITCH_SENTENCE, '공영주차 실측이 쌓이면 추정으로, 현장 관측이 들어오면 실측으로 자동 전환됩니다');
  assert.equal(PREDICTED_MIXED_SENTENCE, '아직 오지 않은 시간과 추정 대상이 아닌 업종은 업종 패턴 기반 예측으로 채웠습니다(빗금 표시).');
  // 실측 격자의 혼합 문장에는 주차장 반경 같은 추정 개념이 없다.
  assert.equal(PREDICTED_MIXED_SENTENCE_MEASURED, '아직 오지 않은 시간은 업종 패턴 기반 예측으로 채웠습니다(빗금 표시).');
  assert.doesNotMatch(PREDICTED_MIXED_SENTENCE_MEASURED, /주차|반경|추정/);
}

// ── 오늘 현장 실측 1~4건: 추정·예측 배너와 평균 혼잡도 타일에 그 수를 적는다 ─────────────
{
  const thin = (sampleCount: number, sourceComposition?: Record<string, number>): DashboardTodayWithEstimate => ({
    hasLogs: false, avgCongestion: null, anomalyCount: null, heatmap: null, anomalies: null, sampleCount,
    ...(sourceComposition ? { sourceComposition } : {}),
  });
  assert.equal(todayFieldSampleNote(thin(3, { user_report: 3 })), '현장 실측 3건 수집 중 · 5건부터 실측 전환');
  assert.equal(todayFieldSampleNote(thin(4)), '현장 실측 4건 수집 중 · 5건부터 실측 전환', '옛 서버(구성 없음)도 건수는 적는다');
  assert.equal(todayFieldSampleNote(thin(0, {})), null, '0건을 적었다');
  assert.equal(todayFieldSampleNote(thin(3, { parking_derived: 3 })), null, '주차 파생 추정을 현장 실측으로 셌다');
  assert.equal(todayFieldSampleNote(thin(4, { user_report: 2, parking_derived: 2 })), '현장 실측 2건 수집 중 · 5건부터 실측 전환');
  assert.equal(todayFieldSampleNote({ ...thin(7), hasLogs: true }), null, '실측 모드에는 붙이지 않는다');
  assert.equal(todayFieldSampleNote({ failed: true }), null, '실패를 표본 수로 말했다');
  assert.equal(todayFieldSampleNote(null), null);
}

// ── 추천 고리 공동 판정: 한 패널이라도 실측 5건 이상이면 넷 다 실측 ───────────────────
// [수락률(7일 추천), DAU(오늘 피드백), 분산 효과(오늘 수락), 깔때기(30일 노출)]
{
  // 운영과 같은 모양: 추천 5,000건(수락 0) · 피드백 0 · 수락 0 · 노출 10,000 → 전부 실측(시나리오 179건을 세우지 않는다).
  assert.equal(resolveLoopBasis({ samples: [5000, 0, 0, 10000] }), 'measured');
  // 다 얇으면 시나리오.
  assert.equal(resolveLoopBasis({ samples: [3, 2, 2, 4] }), 'scenario');
  assert.equal(resolveLoopBasis({ samples: [4, 4, 4, 4] }), 'scenario');
  assert.equal(resolveLoopBasis({ samples: [5, 5, 5, 5] }), 'measured');
  // 하나만 5건 이상이어도 전부 실측(패널마다 따로 바꾸면 한 화면에서 서로 모순된다).
  assert.equal(resolveLoopBasis({ samples: [0, 0, 0, 5] }), 'measured');
  assert.equal(resolveLoopBasis({ samples: [0, 7, 0, 0] }), 'measured');
  // 브리핑(오늘 실측 사실 문장)이 떠 있으면 실측.
  assert.equal(resolveLoopBasis({ samples: [3, 2, 2, 4], measuredElsewhere: true }), 'measured');
  // 로딩 중인 패널이 있으면 판정 보류 — 단, 이미 5건 이상인 패널이 있으면 실측으로 확정.
  assert.equal(resolveLoopBasis({ samples: [3, 'loading', 2, 4] }), null);
  assert.equal(resolveLoopBasis({ samples: [5000, 'loading', 'loading', 'loading'] }), 'measured');
  // 실패한 패널은 뺀다('갱신 중' 자리에는 실측 숫자가 없다). 전부 실패면 시나리오를 그릴 자리가 없다.
  assert.equal(resolveLoopBasis({ samples: ['failed', 'failed', 2, 3] }), 'scenario');
  assert.equal(resolveLoopBasis({ samples: ['failed', 'failed', 'failed', 'failed'] }), 'measured');
  assert.equal(resolveLoopBasis({ samples: [Number.NaN, 2, 2, 2] }), 'scenario', 'NaN 을 표본으로 셌다');
}

// ── 이식한 상수 = 서버 industry_baseline.py(숫자 하나까지) ──────────────────────────
// 두 화면(관광객 카드의 'AI 예측' 과 관제 예측)이 다른 곡선을 쓰면 같은 시각에 다른 예측을 말한다.
{
  const py = readFileSync(join(WEB, '../api/app/services/spot/industry_baseline.py'), 'utf8');
  const nums = (s: string) => [...s.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const block = (name: string, open: string, close: string) => {
    const start = py.indexOf(`${name} = ${open}`);
    assert.ok(start >= 0, `industry_baseline.py 에서 ${name} 을 찾지 못했다 — 이름이 바뀌었으면 이 테스트와 이식본을 함께 고칠 것`);
    const end = py.indexOf(close, start + name.length + 3 + open.length);
    return py.slice(start + name.length + 3 + open.length, end);
  };
  const peakBlock = block('_PREDICTED_PEAK_BY_TYPE', '{', '\n}');
  const pyPeak = Object.fromEntries([...peakBlock.matchAll(/"(\w+)":\s*([\d.]+)/g)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(pyPeak, PREDICTED_PEAK_BY_TYPE, '업종 피크값이 서버와 다르다');
  assert.equal(nums(block('_PREDICTED_PEAK_DEFAULT', '', '\n'))[0], PREDICTED_PEAK_DEFAULT);
  const shapeBlock = block('_PREDICTED_HOUR_SHAPE', '{', '\n}');
  const pyShape = Object.fromEntries([...shapeBlock.matchAll(/"(\w+)":\s*\(([^)]*)\)/g)].map((m) => [m[1], nums(m[2])]));
  assert.deepEqual(pyShape, Object.fromEntries(Object.entries(PREDICTED_HOUR_SHAPE).map(([k, v]) => [k, [...v]])), '시간대 곡선이 서버와 다르다');
  assert.deepEqual(nums(block('_PREDICTED_HOUR_SHAPE_DEFAULT', '(', ')')), [...PREDICTED_HOUR_SHAPE_DEFAULT], '기본 곡선이 서버와 다르다');
  assert.deepEqual(nums(block('_PREDICTED_WEEKDAY_FACTOR', '(', ')')), [...PREDICTED_WEEKDAY_FACTOR], '요일 계수가 서버와 다르다');
}

// ── 화면 배선 가드 ────────────────────────────────────────────────────────────
// 판정만 만들고 화면이 부르지 않으면 아무것도 깨지지 않고 기능만 조용히 없다(adminDashboardWiring.test.ts 와 같은 이유).
{
  // 주석(// · /* */ · JSX {/* */})을 걷어 낸 코드 — 화면 문구 검사는 주석이 아니라 코드에만 한다.
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const page = strip(readFileSync(join(WEB, 'app/admin/dashboard/page.tsx'), 'utf8'));
  const impact = strip(readFileSync(join(WEB, 'components/admin/ImpactWidget.tsx'), 'utf8'));
  const trust = strip(readFileSync(join(WEB, 'components/admin/ModelTrustPanel.tsx'), 'utf8'));
  // assert.match 는 실패 시 페이지 전문(40KB)을 덤프한다 — 메시지만 남기려고 assert.ok 로 쓴다.
  assert.ok(
    /from '@\/lib\/adminPredictedView'/.test(page),
    "app/admin/dashboard/page.tsx 가 '@/lib/adminPredictedView' 를 import 하지 않는다 — 예측·시나리오 모드가 화면에 도달하지 못한다",
  );
  // 예측 행 시설은 활성 시설만 — 비활성 미검증 시드(정원이 커서 정원순 상위를 차지한다)가 예측 목록에 오르지 않게.
  const fetchFacilities = page.slice(page.indexOf('async function fetchPredictionFacilities'), page.indexOf('async function fetchPredictionFacilities') + 1500);
  assert.ok(fetchFacilities.length > 0 && /\.eq\('is_active', true\)/.test(fetchFacilities), "fetchPredictionFacilities 가 is_active=true 로 거르지 않는다");
  // 추천 고리 두 위젯이 공동 판정을 받는다(각자 5건 하한으로 따로 바꾸지 않는다).
  assert.ok(/<ImpactWidget[^>]*loopBasis=\{loopBasis\}/.test(page), 'ImpactWidget 에 공동 판정(loopBasis)을 넘기지 않는다');
  assert.ok(/<ModelTrustPanel[^>]*loopBasis=\{loopBasis\}/.test(page), 'ModelTrustPanel 에 공동 판정(loopBasis)을 넘기지 않는다');
  assert.ok(!/resolveKpiBasis\(/.test(impact) && !/resolveKpiBasis\(/.test(trust), '위젯이 공동 판정 대신 자기 하한으로 전환한다');
  // 화면 문구에 코드 경로·파일 이름을 적지 않는다(import 줄은 제외하고 본다).
  for (const [name, src] of [['page.tsx', page], ['ImpactWidget.tsx', impact], ['ModelTrustPanel.tsx', trust]] as const) {
    const body = src.replace(/^import[\s\S]*?from '[^']+';$/gm, '');
    assert.ok(!/demoFixtures|lib\//.test(body), `${name} 의 화면 문구에 코드 경로가 있다`);
  }
}

console.log('adminPredictedView tests passed');
