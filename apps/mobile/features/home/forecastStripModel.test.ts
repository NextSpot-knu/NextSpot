// 홈 '🔮 혼잡 예측' 띠 규칙 — 웹 apps/web/lib/forecastStrip.test.ts 의 경우를 그대로 옮기고, 앱이 더한 화면 값(배지·범례·핀·트랙)을 본다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resetForecastPointCache, sessionAreaDemandAt } from './forecastPoints';
import {
  areaLevelAt,
  cardAssumedAtIso,
  clampForecastHours,
  forecastHeadlineLevel,
  forecastLevelFor,
  forecastPointAt,
  forecastTargetHourKst,
  predictionsFromBatch,
  relativeAssumedAtIso,
  resolveStripForecast,
  shouldShowForecastStrip,
  stopAtX,
  stopForKey,
  STRIP_NOW,
  stripBadgeFor,
  stripHours,
  stripLegendFor,
  stripReducer,
  type ForecastDeps,
  type StripState,
} from './forecastStripModel';

const at = (iso: string) => new Date(iso).getTime();
const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}${JSON.stringify(vars)}` : key);

async function main() {
  // 1) 상대 가정 시각 — 정확히 N시간 뒤, 지금은 null. 0~3 밖은 자른다.
  {
    const now = at('2026-10-07T03:10:00Z'); // 12:10 KST
    assert.equal(relativeAssumedAtIso(now, 0), null);
    assert.equal(relativeAssumedAtIso(now, 2), '2026-10-07T05:10:00.000Z');
    assert.equal(relativeAssumedAtIso(now, 7), '2026-10-07T06:10:00.000Z', '+3시간까지만');
    assert.equal(clampForecastHours(-1), 0);
    assert.equal(clampForecastHours(Number.NaN), 0);
    assert.equal(clampForecastHours(1.6), 2);
    // 카드 assumedAt — +N 이 프리셋을 이긴다.
    assert.equal(cardAssumedAtIso(now, 2, 'preset-iso'), '2026-10-07T05:10:00.000Z');
    assert.equal(cardAssumedAtIso(now, 0, 'preset-iso'), 'preset-iso');
    assert.equal(cardAssumedAtIso(now, 0, null), null);
  }

  // 2) KST 정시 — 가장 가까운 정시, 자정을 넘기면 다음 날 시.
  {
    const late = at('2026-10-07T14:40:00Z'); // 23:40 KST
    assert.equal(forecastTargetHourKst(late, 1), 1);
    assert.equal(forecastTargetHourKst(late, 2), 2);
    assert.equal(forecastTargetHourKst(at('2026-10-07T14:10:00Z'), 1), 0, '00:10 → 0시');
    assert.equal(forecastTargetHourKst(at('2026-10-07T03:10:00Z'), 2), 14, '12:10 + 2 → 14시');
    assert.equal(areaLevelAt({ 0: 0.2, 1: 0.3, 2: 0.4 }, late, 1), 0.3);
    assert.equal(areaLevelAt({ 0: 0.2, 2: 0.4 }, late, 1), 0.2, '00:40 에 1시가 없으면 더 가까운 0시');
  }

  // 3) 상태 기계 — 받는 중 · 늦게 온 옛 답 버림 · 실패하면 지금으로 · 지금을 누르면 비운다.
  {
    let s: StripState = STRIP_NOW;
    s = stripReducer(s, { type: 'select', hours: 2 });
    assert.equal(s.status, 'loading');
    assert.equal(stripHours(s), 2);
    s = stripReducer(s, { type: 'select', hours: 3 });
    const stale = stripReducer(s, { type: 'resolved', hours: 2, forecast: { hours: 2, basis: 'area', level: 0.3 } });
    assert.equal(stale, s, '기다리지 않는 시각의 답은 버린다');
    s = stripReducer(s, { type: 'resolved', hours: 3, forecast: { hours: 3, basis: 'area', level: 0.3 } });
    assert.equal(s.status, 'forecast');
    assert.equal(stripHours(s), 3);
    assert.equal(stripReducer(s, { type: 'select', hours: 3 }), s, '같은 칸을 다시 누르면 그대로');
    const failed = stripReducer(stripReducer(s, { type: 'select', hours: 1 }), { type: 'resolved', hours: 1, forecast: null });
    assert.deepEqual(failed, { status: 'now', failed: true });
    assert.deepEqual(stripReducer(s, { type: 'select', hours: 0 }), STRIP_NOW);
    assert.deepEqual(stripReducer(s, { type: 'reset' }), STRIP_NOW);
  }

  // 4) 예측 정하기 — 배치 성공 / 503 → 곡선 / 둘 다 실패 / 미학습이면 배치를 부르지 않는다.
  {
    const now = at('2026-10-07T03:10:00Z');
    const calls: string[] = [];
    const deps = (over: Partial<ForecastDeps>): ForecastDeps => ({
      modelTrained: async () => {
        calls.push('info');
        return true;
      },
      batch: async () => {
        calls.push('batch');
        return { a: { level: 0.7, anchored: true }, b: { level: 0.5, anchored: false } };
      },
      areaCurve: async () => {
        calls.push('curve');
        return { 13: 0.2, 14: 0.45, 15: 0.6 };
      },
      ...over,
    });
    const ok = await resolveStripForecast(2, deps({}), now);
    assert.equal(ok?.basis, 'model');
    assert.deepEqual(calls, ['info', 'batch']);
    assert.equal(ok?.basis === 'model' && ok.anchored, false, '앵커 없는 예측이 섞이면 추정');
    assert.equal(forecastHeadlineLevel(ok!), 0.6, '모델 예측의 가운데값');
    assert.equal(forecastHeadlineLevel(ok!, ['a']), 0.7, '고른 분류의 장소만');

    calls.length = 0;
    const fallback = await resolveStripForecast(
      2,
      deps({
        batch: async () => {
          calls.push('batch');
          throw new Error('503');
        },
      }),
      now,
    );
    assert.deepEqual(fallback, { hours: 2, basis: 'area', level: 0.45 });
    assert.deepEqual(calls, ['info', 'batch', 'curve']);

    calls.length = 0;
    const untrained = await resolveStripForecast(
      1,
      deps({
        modelTrained: async () => {
          calls.push('info');
          return false;
        },
      }),
      now,
    );
    assert.deepEqual(untrained, { hours: 1, basis: 'area', level: 0.2 });
    assert.deepEqual(calls, ['info', 'curve'], '미학습이면 배치를 부르지 않는다');

    const none = await resolveStripForecast(
      3,
      deps({
        batch: async () => {
          throw new Error('503');
        },
        areaCurve: async () => {
          throw new Error('down');
        },
      }),
      now,
    );
    assert.equal(none, null);
    assert.equal(await resolveStripForecast(2, deps({ areaCurve: async () => ({}), batch: async () => ({}) }), now), null);
    assert.equal(await resolveStripForecast(0, deps({}), now), null);
  }

  // 5) /predict/batch 응답 → 장소별 예측(camelCase — httpCore 가 바꾼다). 숫자가 아니면 버리고, anchored 가 없으면 true.
  assert.deepEqual(
    predictionsFromBatch({
      predictions: [
        { facilityId: 7, predictedCongestion: 0.4 },
        { facilityId: 'x', predictedCongestion: 0.9, anchored: false },
        { facilityId: 'y', predictedCongestion: null },
      ],
    }),
    { '7': { level: 0.4, anchored: true }, x: { level: 0.9, anchored: false } },
  );
  assert.deepEqual(predictionsFromBatch(null), {});

  // 6) 권역 한 시각 — 서버 창 안으로 당긴다 · 같은 정시는 한 번만 · 표본 부족이면 이웃 · 전송 실패는 담지 않는다.
  {
    const now = at('2026-10-07T03:10:00Z'); // 12:10 KST
    const p1 = forecastPointAt(now, 1);
    assert.equal(p1?.hourKst, 13);
    assert.equal(p1?.at.toISOString(), '2026-10-07T04:00:00.000Z');
    // 12:40 의 지금+0 → 13시, 서버 창 하한(13:12)으로 당겨도 30분 안. 12:10 의 지금+0 → 12시는 42분 밀려 묻지 않는다.
    const p0 = forecastPointAt(at('2026-10-07T03:40:00Z'), 0);
    assert.equal(p0?.hourKst, 13);
    assert.equal(p0?.at.toISOString(), '2026-10-07T04:12:00.000Z');
    assert.equal(forecastPointAt(now, 0), null);

    resetForecastPointCache();
    const asked: string[] = [];
    const fetchPoint = async (when: Date) => {
      asked.push(when.toISOString());
      return when.getUTCHours() === 5 ? null : 0.33; // 14시 KST 는 표본 부족
    };
    assert.deepEqual(await sessionAreaDemandAt(1, now, fetchPoint), { 13: 0.33 });
    assert.deepEqual(await sessionAreaDemandAt(1, now, fetchPoint), { 13: 0.33 });
    assert.equal(asked.length, 1, '같은 정시는 한 번만 묻는다');
    // +2 = 14시 표본 부족 → 12:10+2h=14:10 은 앞쪽(분 < 30)이라 다음 이웃 15시.
    assert.deepEqual(await sessionAreaDemandAt(2, now, fetchPoint), { 15: 0.33 });

    resetForecastPointCache();
    let fail = true;
    const flaky = async () => {
      if (fail) throw new Error('timeout');
      return 0.5;
    };
    await assert.rejects(sessionAreaDemandAt(1, now, flaky));
    fail = false;
    assert.deepEqual(await sessionAreaDemandAt(1, now, flaky), { 13: 0.5 }, '실패는 담아 두지 않는다');
  }

  // 7) 배지 · 범례 · 띠 보임.
  {
    const area = { hours: 2 as const, basis: 'area' as const, level: 0.2 };
    const badge = stripBadgeFor(area, { busyAt: 0.75, t });
    assert.equal(badge?.grade, 'quiet');
    assert.equal(badge?.text, 'forecast.badgeArea{"h":2,"level":"congestion.quiet"}');
    assert.equal(badge?.short, 'forecast.badgeShort{"level":"congestion.quiet"}');
    const model = { hours: 1 as const, basis: 'model' as const, predictions: { a: { level: 0.9, anchored: false } }, anchored: false };
    assert.equal(stripBadgeFor(model, { busyAt: 0.75, t })?.text, 'forecast.badgeModel{"h":1,"level":"congestion.busy"} · map.forecastEstimateTag');
    assert.equal(stripBadgeFor(model, { busyAt: 0.75, t, typeIds: ['zz'] }), null, '고른 분류에 예측이 없으면 배지 없음');
    assert.equal(stripBadgeFor(null, { busyAt: 0.75, t }), null);

    assert.deepEqual(stripLegendFor(area, { gradedPinCount: 0, t }), { title: 'forecast.legendAhead{"h":2}', dashed: true });
    assert.deepEqual(stripLegendFor(null, { gradedPinCount: 3, t }), { title: 'forecast.legendNow', dashed: false });
    assert.equal(stripLegendFor(null, { gradedPinCount: 0, t }), null);

    const base = { parkingTab: false, loadingFacilities: false, facilitiesError: false, facilityCount: 5, cardExpanded: false };
    assert.equal(shouldShowForecastStrip(base), true);
    assert.equal(shouldShowForecastStrip({ ...base, parkingTab: true }), false, '주차장 탭에서는 숨긴다');
    assert.equal(shouldShowForecastStrip({ ...base, cardExpanded: true }), false, '카드를 펼치면 숨긴다');
    assert.equal(shouldShowForecastStrip({ ...base, facilityCount: 0 }), false);
    assert.equal(shouldShowForecastStrip({ ...base, loadingFacilities: true }), false);

    // 핀 예측값 — 모델이면 그 장소, 권역이면 순위 핀에만.
    assert.equal(forecastLevelFor(model, 'a', false), 0.9);
    assert.equal(forecastLevelFor(model, 'b', true), null);
    assert.equal(forecastLevelFor(area, 'b', true), 0.2);
    assert.equal(forecastLevelFor(area, 'b', false), null);
    assert.equal(forecastLevelFor(null, 'a', true), null);
  }

  // 8) 트랙 — 누른 x → 칸, 방향키·접근성 동작.
  {
    assert.equal(stopAtX(0, 200, 0), 0);
    assert.equal(stopAtX(49.9, 200, 0), 0);
    assert.equal(stopAtX(50, 200, 0), 0, '경계는 왼쪽 칸(웹 − 1e-9)');
    assert.equal(stopAtX(51, 200, 0), 1);
    assert.equal(stopAtX(199, 200, 0), 3);
    assert.equal(stopAtX(250, 200, 0), 3, '트랙 밖으로 끌어도 끝 칸');
    assert.equal(stopAtX(-30, 200, 2), 0);
    assert.equal(stopAtX(10, 0, 2), 2, '폭을 모르면 그대로');
    assert.equal(stopForKey('ArrowRight', 1, false), 2);
    assert.equal(stopForKey('increment', 3, false), 3);
    assert.equal(stopForKey('decrement', 0, false), 0);
    assert.equal(stopForKey('ArrowRight', 2, true), 1, '프리셋이 걸려 있으면 지금에서 센다');
    assert.equal(stopForKey('End', 0, false), 3);
    assert.equal(stopForKey('Home', 3, false), 0);
    assert.equal(stopForKey('Enter', 1, false), null);
  }

  // 9) 웹 원본과 어긋남 — 칸·창 상수가 웹 소스와 같은지(웹 파일은 check:shared 때문에 import 하지 않고 글로 읽는다).
  {
    const web = readFileSync(join(process.cwd(), '../web/lib/forecastStrip.ts'), 'utf8');
    assert.match(web, /FORECAST_STOPS = \[0, 1, 2, 3\] as const/);
    assert.match(web, /Math\.floor\(target \/ HOUR_MS\) \* HOUR_MS >= HOUR_MS \/ 2/);
    assert.match(web, /if \(!event\.forecast\) return \{ status: ['"]now['"], failed: true \}/);
    const curve = readFileSync(join(process.cwd(), '../web/lib/areaDemandCurve.ts'), 'utf8');
    assert.match(curve, /WINDOW_MIN_MS = 32 \* MINUTE_MS/);
    assert.match(curve, /WINDOW_MAX_MS = 6 \* HOUR_MS - 2 \* MINUTE_MS/);
  }

  console.log('forecastStripModel ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
