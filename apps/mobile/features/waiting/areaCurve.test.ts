import assert from 'node:assert/strict';

import { curveForBase, forecastArrivalTimes, levelFromForecast, mergeAreaCurve, usableCurve } from './areaCurve';
import { BOARD_CACHE_MAX_AGE_MS, parseBoardCache } from './boardCache';

const HOUR = 3600_000;
const kst = (iso: string) => new Date(iso).getTime(); // 입력은 UTC

// 12:45 KST(03:45Z) → 13시는 13:17 로 당겨 묻고(32분 뒤), 14…18 이 이어 6개
{
  const now = kst('2026-11-02T03:45:00Z');
  const pts = forecastArrivalTimes(new Date(now), now);
  assert.deepEqual(pts.map((p) => p.hourKst), [13, 14, 15, 16, 17, 18]);
  assert.equal(pts[0].at.getTime(), now + 32 * 60_000);
  for (const p of pts) {
    assert.ok(p.at.getTime() >= now + 32 * 60_000 && p.at.getTime() <= now + 6 * HOUR - 2 * 60_000);
  }
}
// 12:58 → 13 시는 반올림이 14 가 되므로 건너뛰고 14…19
{
  const now = kst('2026-11-02T03:58:00Z');
  assert.deepEqual(forecastArrivalTimes(new Date(now), now).map((p) => p.hourKst), [14, 15, 16, 17, 18, 19]);
}
// 자정을 넘기면 KST 시가 0 으로 돈다
{
  const now = kst('2026-11-02T13:10:00Z'); // 22:10 KST
  assert.deepEqual(forecastArrivalTimes(new Date(now), now).map((p) => p.hourKst), [23, 0, 1, 2, 3, 4]);
}
// 6시간보다 먼 기준은 없다
{
  const now = kst('2026-11-02T03:00:00Z');
  assert.deepEqual(forecastArrivalTimes(new Date(now + 10 * HOUR), now), []);
}

// 응답 해석: available=true + 숫자만, 0~1 로 자른다
assert.equal(levelFromForecast({ available: true, forecast: { level: 0.42 } }), 0.42);
assert.equal(levelFromForecast({ available: true, forecast: { level: 1.4 } }), 1);
assert.equal(levelFromForecast({ available: false, forecast: { level: 0.4 } }), null);
assert.equal(levelFromForecast({ available: true, forecast: null }), null);
assert.equal(levelFromForecast(undefined), null);
assert.equal(usableCurve({}), null);
assert.deepEqual(usableCurve({ 13: 0.3 }), { 13: 0.3 });

// 보드 캐시: 24시간·모양·프리셋
const sectors = [{ type: 'cafe', rows: [] }];
const now = 1_000_000_000_000;
const good = JSON.stringify({ sectors, savedAt: now - 1000, preset: 'now' });
assert.deepEqual(parseBoardCache(good, now)?.sectors, sectors);
assert.equal(parseBoardCache(JSON.stringify({ sectors, savedAt: now - BOARD_CACHE_MAX_AGE_MS - 1 }), now), null);
assert.equal(parseBoardCache(JSON.stringify({ sectors: [], savedAt: now }), now), null);
assert.equal(parseBoardCache(JSON.stringify({ sectors, savedAt: now, preset: 'sat-14' }), now), null);
// 프리셋이 같을 때만 쓴다(웹과 같다)
assert.deepEqual(parseBoardCache(JSON.stringify({ sectors, savedAt: now, preset: 'sat_afternoon' }), now, 'sat_afternoon')?.sectors, sectors);
assert.equal(parseBoardCache(good, now, 'sat_afternoon'), null);
assert.equal(parseBoardCache('{broken', now), null);

// 기준 시각별 곡선
assert.equal(curveForBase({ now: {} }, 'now'), null);
assert.deepEqual(curveForBase({ now: { 13: 0.3 } }, 'now'), { 13: 0.3 });
assert.equal(curveForBase({}, 'now'), null);
{
  const prev = { now: { 13: 0.3 } };
  assert.equal(mergeAreaCurve(prev, 'now', {}), prev); // 빈 재조회는 좋은 곡선을 지우지 않는다
  assert.deepEqual(mergeAreaCurve(prev, '5', {}), { now: { 13: 0.3 }, '5': {} }); // 처음부터 빈 결과는 기록
  assert.deepEqual(mergeAreaCurve(prev, 'now', { 14: 0.5 }), { now: { 14: 0.5 } });
}
assert.equal(parseBoardCache(null, now), null);

console.log('areaCurve.test.ts ok');
