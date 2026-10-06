// 사장님 콘솔 ① '가장 한가한 시간' 콜아웃 판정 테스트.
//
// 규약은 api.test.ts 와 같다: node:assert 로 스스로 판정하는 독립 스크립트(scripts/run-web-tests.mjs 가 돌린다).
// 콜아웃은 '이 시간에 타임세일을 열어 보세요' 라는 행동 제안이라, 영업 시간대(10~21시) 밖이나 곡선이
// 평평해서 고를 이유가 없을 때는 아예 띄우지 않는다 — 그 경계를 여기서 잠근다.

import assert from 'node:assert/strict';
import { bestQuietHour, quietHourCopy, QUIET_HOUR_MIN_SPREAD } from './forecastInsight';
import type { HourlyCongestionPoint } from './api';
import { demoMerchantForecast } from '../demoFixtures';

function curve(startHour: number, values: number[]): HourlyCongestionPoint[] {
  return values.map((congestion, hoursAhead) => ({
    hoursAhead,
    hour: (startHour + hoursAhead) % 24,
    congestion,
    anchored: false,
  }));
}

// 새벽 3시를 '그때 타임세일' 로 고르지 않는다 — 그리고 차트의 최저점이 새벽이면 영업 시간대의 다른 점을 '가장 한가한
// 시간' 이라 부르지도 않는다(리뷰 10-07: 콜아웃이 바로 아래 차트와 어긋났다). 그때는 콜아웃이 없다.
{
  const points = curve(22, [0.5, 0.3, 0.1, 0.05, 0.02, 0.01, 0.01]); // 22,23,0,1,2,3,4시
  assert.equal(bestQuietHour(points), null, '영업 시간대(10~21시) 점이 하나뿐이면 고를 수 없다');

  const mixed: HourlyCongestionPoint[] = [
    { hoursAhead: 0, hour: 20, congestion: 0.7, anchored: false },
    { hoursAhead: 1, hour: 21, congestion: 0.4, anchored: false },
    { hoursAhead: 2, hour: 3, congestion: 0.02, anchored: false },
  ];
  assert.equal(bestQuietHour(mixed), null, '차트의 최저(03시)는 영업 시간 밖 — 21시를 가장 한가하다고 부르면 차트와 어긋난다');

  // 리뷰 10-07 화면: 06:50 의 오르기만 하는 아침 곡선(지금 6% → 10시 33% → 12시 55%). 예전에는 '10시가 가장 한가할 것 같아요'.
  const morning = curve(6, [0.06, 0.1, 0.16, 0.24, 0.33, 0.44, 0.55]); // 6..12시
  assert.equal(bestQuietHour(morning), null, '오르는 아침 곡선에서 10시를 가장 한가하다고 했다');

  // 영업 시간대 안의 최저가 차트 전체의 최저이면 그대로 고른다.
  const lateMorning = curve(8, [0.5, 0.45, 0.2, 0.3, 0.5, 0.7, 0.8]); // 8..14시, 최저 10시
  const best = bestQuietHour(lateMorning);
  assert.ok(best);
  assert.equal(best.hour, 10);
  assert.equal(best.isNow, false);
}

// 낮 시간 곡선: 최솟값 시각을 고른다.
{
  const points = curve(14, [0.55, 0.42, 0.45, 0.65, 0.95, 1.0, 0.88]); // 14..20시
  const best = bestQuietHour(points);
  assert.ok(best);
  assert.equal(best.hour, 15);
  assert.equal(best.hoursAhead, 1);
  assert.equal(best.isNow, false);
}

// 곡선이 평평하면(최대 − 최소 < 0.15) 콜아웃을 띄우지 않는다.
{
  const flat = curve(12, [0.5, 0.52, 0.48, 0.55, 0.5, 0.45, 0.59]);
  assert.ok(0.59 - 0.45 < QUIET_HOUR_MIN_SPREAD);
  assert.equal(bestQuietHour(flat), null, '평평한 곡선에서 한가한 시간을 지어냈다');

  // 경계: 정확히 0.15 차이면 띄운다.
  const edge = curve(12, [0.6, 0.45, 0.5]);
  assert.ok(bestQuietHour(edge), '차이 0.15 는 콜아웃 조건(≥0.15)을 만족한다');
}

// 지금이 가장 한가하면 isNow.
{
  const points = curve(10, [0.2, 0.5, 0.7, 0.8, 0.6, 0.5, 0.4]);
  const best = bestQuietHour(points);
  assert.ok(best);
  assert.equal(best.hoursAhead, 0);
  assert.equal(best.isNow, true);
}

// 빈 곡선.
assert.equal(bestQuietHour([]), null);

// 데모 곡선은 지금 KST 시각부터 6시간이다 — 고정 13~19시를 그리면 15시에 연 화면의 X축이
// '지금 → 14시' 로 실제 시계와 어긋났다. 13시에 열면 예전 화면 그대로(19시 0.41 → '19시').
const KST_13 = Date.UTC(2026, 9, 6, 4, 0, 0); // 2026-10-06 13:00 KST
{
  const at13 = demoMerchantForecast(KST_13);
  assert.deepEqual(
    at13.map((p) => [p.hour, p.congestion]),
    [[13, 0.62], [14, 0.74], [15, 0.86], [16, 0.91], [17, 0.78], [18, 0.55], [19, 0.41]],
    '13시 데모 곡선이 브리핑 문구(15~16시 91%)와 다르다',
  );
  const best = bestQuietHour(at13);
  assert.ok(best);
  assert.equal(best.hour, 19);
  assert.equal(quietHourCopy(best).title, '19시가 가장 한가할 것 같아요');

  const at1530 = demoMerchantForecast(KST_13 + 2.5 * 3600_000);
  assert.deepEqual(at1530.map((p) => p.hour), [15, 16, 17, 18, 19, 20, 21], '데모 X축이 실제 시계를 따르지 않는다');
  assert.equal(bestQuietHour(at1530)?.hour, 21);

  // 자정을 넘기면 0시로 돈다(심야엔 영업 시간대 점이 모자라 콜아웃이 없다).
  const at22 = demoMerchantForecast(KST_13 + 9 * 3600_000);
  assert.deepEqual(at22.map((p) => p.hour), [22, 23, 0, 1, 2, 3, 4]);
  assert.ok(at22.every((p) => Number.isFinite(p.congestion)));
  assert.equal(bestQuietHour(at22), null);
}

// 문구 — 사장님이 바로 행동할 수 있는 말만 쓴다.
{
  const later = quietHourCopy({ hour: 15, hoursAhead: 1, congestion: 0.3, isNow: false });
  assert.equal(later.title, '15시가 가장 한가할 것 같아요');
  assert.equal(later.body, '이 시간에 타임세일을 열면 손님을 더 모을 수 있어요.');

  const now = quietHourCopy({ hour: 10, hoursAhead: 0, congestion: 0.2, isNow: true });
  assert.equal(now.title, '지금이 가장 한가한 시간이에요');
  assert.equal(now.body, '지금 타임세일을 열어 손님을 모아 보세요.');
}

console.log('lib/merchant/forecastInsight.test.ts ok');
