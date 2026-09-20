// lib/adminEstimatedSeries.ts — 리포트 화면의 일별 **추정** 추이 판정.
//
// 왜 이 테스트가 필요한가: 이 저장소에는 React 렌더 테스트 러너가 없다. 그런데 여기서 한 칸만
// 틀리면 **추정치가 라벨 없이 실측처럼** 그려지거나, 모양이 어긋난 응답 하나가 리포트 화면
// 전체를 에러 경계로 떨어뜨린다. 판정을 렌더에서 떼어 node:assert 로 고정한다.
import { strict as assert } from 'node:assert';
import {
  ESTIMATE_NO_HEADCOUNT_NOTE,
  categoryEstimateRows,
  estimatedSeriesBasisLine,
  estimatedSeriesMethodNote,
  estimatedSeriesSummary,
  estimatedSeriesUnavailableNote,
  estimatedTrendRows,
  readEstimatedSeries,
  shortChartLabel,
  weekdayEstimateRows,
  weekdayKo,
  type EstimatedDayPoint,
} from './adminEstimatedSeries';

const TYPE_KO = { restaurant: '음식점', cafe: '카페', attraction: '관광지', culture: '문화시설' } as const;

function day(date: string, avg: number | null, byType: Record<string, [number, number]> = {}): unknown {
  return {
    date,
    avgCongestion: avg,
    sampleCount: avg === null ? 0 : 1000,
    snapshotCount: avg === null ? 0 : 144,
    anomalyCount: avg === null ? null : 7,
    byType: Object.fromEntries(
      Object.entries(byType).map(([k, [v, n]]) => [k, { avgCongestion: v, sampleCount: n, anomalyCount: 0 }]),
    ),
  };
}

function response(daily: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    days: daily.length,
    available: true,
    reason: null,
    startDateKst: '2026-09-14',
    endDateKst: '2026-09-20',
    samplingMinutes: 10,
    daily,
    basis: {
      weights: { parking: 0.7, tourism: 0.3 },
      radiusM: 2000,
      samplingMinutes: 10,
      snapshotCount: 944,
      lotCountMax: 4,
      facilityCount: 1669,
      estimatedFacilityCount: 846,
      firstObservedAt: '2026-09-13T15:03:02+00:00',
      latestObservedAt: '2026-09-20T04:13:02+00:00',
    },
    ...extra,
  };
}

async function main() {
  // ── 1. 모양을 믿지 않는다 ──────────────────────────────────────────────────
  // Vercel(웹)과 Render(API)는 배포 시점이 다르고 스테이징이 없다. 옛 서버·깨진 응답이 실제로 온다.
  assert.equal(readEstimatedSeries(undefined), null, '옛 서버(응답 없음)는 추정 없음이다');
  assert.equal(readEstimatedSeries(null), null);
  assert.equal(readEstimatedSeries('{}'), null);
  assert.equal(readEstimatedSeries({ available: true }), null, 'daily 가 없으면 그릴 것이 없다');
  assert.equal(
    readEstimatedSeries({ ...(response([day('2026-09-20', 0.5)]) as object), available: false }),
    null,
    "서버가 '못 냈다' 고 말한 것을 억지로 그리지 않는다",
  );
  assert.equal(
    readEstimatedSeries(response([])),
    null,
    'daily 가 빈 배열이면 축만 남은 차트가 되므로 그리지 않는다',
  );

  // 깨진 날짜는 **그 날만** 버린다 — 하루가 깨졌다고 30일을 잃을 이유가 없다.
  const partial = readEstimatedSeries(
    response([day('2026-09-18', 0.5), { date: '9/19', avgCongestion: 0.6 }, day('2026-09-20', 0.7)]),
  );
  assert.ok(partial);
  assert.deepEqual(partial.daily.map((d) => d.date), ['2026-09-18', '2026-09-20']);

  // avgCongestion 이 없는 날은 null 로 남는다. **0 이 아니다** — 0 은 '한산했다' 라는 관측이다.
  const withGap = readEstimatedSeries(response([day('2026-09-19', null), day('2026-09-20', 0.61)]));
  assert.ok(withGap);
  assert.equal(withGap.daily[0].avgCongestion, null);
  assert.equal(withGap.daily[0].anomalyCount, null, '건수도 0 이 아니라 null 이어야 한다');
  assert.deepEqual(withGap.daily[0].byType, {}, '평균이 없는 날은 유형별 값도 없다');
  assert.equal(withGap.observedDays, 1);

  // 유형별 평균이 숫자가 아니면 그 유형은 없는 것이다(0 으로 채우지 않는다).
  const oddTypes = readEstimatedSeries(
    response([{ ...(day('2026-09-20', 0.5) as object), byType: { cafe: { avgCongestion: null }, restaurant: { avgCongestion: 0.4, sampleCount: 10 } } }]),
  );
  assert.ok(oddTypes);
  assert.deepEqual(Object.keys(oddTypes.daily[0].byType), ['restaurant']);

  // ── 2. 왜 추정이 없는지 ────────────────────────────────────────────────────
  assert.equal(estimatedSeriesUnavailableNote(undefined), null, '옛 서버의 고장은 없다');
  assert.equal(estimatedSeriesUnavailableNote(response([day('2026-09-20', 0.5)])), null);
  assert.match(
    estimatedSeriesUnavailableNote({ available: false, reason: 'timeout' }) ?? '',
    /새로고침/,
    '시간 초과는 다시 누르면 풀리는 실패다 — 그 사실을 말해야 한다',
  );
  assert.match(estimatedSeriesUnavailableNote({ available: false, reason: 'compute_failed' }) ?? '', /주차 원본/);
  assert.ok(estimatedSeriesUnavailableNote({ available: false, reason: 'who-knows' }));

  // ── 3. 근거 문장 ───────────────────────────────────────────────────────────
  const series = readEstimatedSeries(response([day('2026-09-19', 0.64), day('2026-09-20', 0.57)]));
  assert.ok(series);
  const basisLine = estimatedSeriesBasisLine(series);
  // 관측 시각은 **KST 로** 읽어야 한다 — UTC 9/13 15:03 은 이미 KST 9/14 다.
  for (const fragment of ['주차 실측', 'ITS 공영주차 4곳', '관광공사 집중률', '9.14~9.20 관측', '10분 간격', '반경 2km']) {
    assert.ok(basisLine.includes(fragment), `근거에 '${fragment}' 가 빠졌다: ${basisLine}`);
  }
  assert.match(estimatedSeriesMethodNote(series), /0\.7 × 주변 공영주차 점유율 \+ 0\.3 × 관광공사 집중률/);
  assert.match(estimatedSeriesMethodNote(series), /1,669곳 중 846곳/);
  assert.match(estimatedSeriesMethodNote(series), /시설 × 구간/, '표본 단위가 로그 1행이 아님을 말해야 한다');

  // 서버가 근거를 못 실었으면 **모르는 칸은 뺀다**(숫자를 지어내지 않는다).
  const bare = readEstimatedSeries(response([day('2026-09-20', 0.5)], { basis: {} }));
  assert.ok(bare);
  const bareLine = estimatedSeriesBasisLine(bare);
  assert.ok(!/\d+곳/.test(bareLine), `없는 주차장 수를 지어냈다: ${bareLine}`);
  assert.ok(!/반경/.test(bareLine), `없는 반경을 지어냈다: ${bareLine}`);
  assert.ok(bareLine.includes('주차 실측'), '그래도 출처는 말한다');

  // ── 4. 차트 행 ─────────────────────────────────────────────────────────────
  assert.equal(shortChartLabel('2026-09-05'), '9/5', '실측 계열과 같은 라벨 형식이어야 축이 안 흔들린다');
  assert.deepEqual(estimatedTrendRows(series), [
    { date: '9/19', avgCongestion: 0.64 },
    { date: '9/20', avgCongestion: 0.57 },
  ]);
  assert.equal(
    estimatedTrendRows(withGap!)[0].avgCongestion,
    null,
    '미관측 날은 null 로 넘겨야 선이 끊긴다(0 으로 이으면 없는 관측을 그린다)',
  );

  // ── 5. 요일 × 업종 ─────────────────────────────────────────────────────────
  // KST 달력 날짜의 요일은 실행 환경 시간대와 무관해야 한다.
  assert.equal(weekdayKo('2026-09-20'), '일');
  assert.equal(weekdayKo('2026-09-21'), '월');
  assert.equal(weekdayKo('9/21'), null);

  const weekdaySeries = readEstimatedSeries(response([
    day('2026-09-14', 0.5, { restaurant: [0.5, 100], cafe: [0.4, 100] }),  // 월
    day('2026-09-15', 0.7, { restaurant: [0.7, 300], cafe: [0.6, 100] }),  // 화
    day('2026-09-21', 0.9, { restaurant: [0.9, 100] }),                     // 월 (같은 요일)
    day('2026-09-16', null),                                                // 수 — 관측 없음
  ]));
  assert.ok(weekdaySeries);
  const rows = weekdayEstimateRows(weekdaySeries.daily, TYPE_KO);
  assert.deepEqual(rows.map((r) => r.day), ['월', '화', '수', '목', '금', '토', '일'], '요일 순서는 고정이다');
  const monday = rows[0];
  // 표본 가중 평균: (0.5×100 + 0.9×100) / 200 = 0.7
  assert.equal(monday['음식점'], 0.7);
  assert.equal(monday['카페'], 0.4, '카페는 9/14 하루뿐이다');
  assert.equal(monday.dayCount, 2);
  const wednesday = rows[2];
  assert.equal(wednesday['음식점'], null, '관측 없는 요일은 0 이 아니라 null — 0 은 한산했다는 뜻이다');
  assert.equal(wednesday.dayCount, 0);
  assert.equal(rows[1]['음식점'], 0.7, '화요일');

  // ── 6. 카테고리 요약표 ─────────────────────────────────────────────────────
  const fortnight: EstimatedDayPoint[] = [];
  for (let i = 0; i < 14; i++) {
    const date = `2026-09-${String(7 + i).padStart(2, '0')}`;
    // 앞 7일 0.40, 뒤 7일 0.55 — 전주 대비 +15.0%p 여야 한다.
    const value = i < 7 ? 0.4 : 0.55;
    fortnight.push(readEstimatedSeries(response([day(date, value, { cafe: [value, 100] })]))!.daily[0]);
  }
  const summary = categoryEstimateRows(fortnight, TYPE_KO, { windowDays: 7 });
  const cafe = summary.find((r) => r.type === 'cafe')!;
  assert.equal(cafe.avgCongestion, 0.55);
  assert.equal(cafe.prevAvgCongestion, 0.4);
  assert.equal(cafe.changePoints, 15, '비율의 변화는 %p 다 — +37.5% 같은 증감률이 아니다');
  assert.equal(cafe.dayCount, 7);
  assert.equal(cafe.status, '보통', '0.55 는 기본 경계(0.75/0.5/0.25)에서 보통이다');

  // 직전 창에 표본이 없으면 **비교를 만들지 않는다**(없는 비교를 '+100%' 로 지어내지 않는다).
  const onlyRecent = categoryEstimateRows(fortnight.slice(7), TYPE_KO, { windowDays: 7 });
  const cafeOnly = onlyRecent.find((r) => r.type === 'cafe')!;
  assert.equal(cafeOnly.avgCongestion, 0.55);
  assert.equal(cafeOnly.prevAvgCongestion, null);
  assert.equal(cafeOnly.changePoints, null);

  // 관측이 전혀 없는 유형도 행 자체는 남는다(표에서 사라지면 '그 업종은 없다' 로 읽힌다).
  const attraction = summary.find((r) => r.type === 'attraction')!;
  assert.equal(attraction.avgCongestion, null);
  assert.equal(attraction.status, null);
  assert.equal(attraction.changePoints, null);
  assert.equal(summary.length, 4);

  // ── 7. 기간 요약 ───────────────────────────────────────────────────────────
  const sum = estimatedSeriesSummary(withGap!);
  assert.equal(sum.avgCongestion, 0.61);
  assert.equal(sum.maxCongestion, 0.61);
  assert.equal(sum.maxDate, '2026-09-20');
  assert.equal(sum.observedDays, 1);
  assert.equal(sum.totalDays, 2, '미관측 날도 분모에 남는다 — 기간을 줄여 말하지 않는다');

  // ── 8. 인원 수를 만들지 않는다 ─────────────────────────────────────────────
  // 이 모듈 어디에서도 '명' 을 만들어 내지 않는다는 사실을 문구로 고정한다.
  assert.match(ESTIMATE_NO_HEADCOUNT_NOTE, /인원 수/);
  assert.match(ESTIMATE_NO_HEADCOUNT_NOTE, /0 이 아니라/);
  assert.ok(
    Object.keys(series.daily[0]).every((key) => !/count$/i.test(key) || /sampleCount|snapshotCount|anomalyCount/.test(key)),
    '추정 일자에 인원 수 비슷한 칸이 생기면 화면이 그것을 사람 수로 읽는다',
  );

  console.log('adminEstimatedSeries.test.ts: OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
