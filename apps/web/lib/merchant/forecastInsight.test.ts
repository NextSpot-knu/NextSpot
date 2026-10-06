// 사장님 콘솔 ① '가장 한가한 시간' 콜아웃 판정 테스트.
//
// 규약은 api.test.ts 와 같다: node:assert 로 스스로 판정하는 독립 스크립트(scripts/run-web-tests.mjs 가 돌린다).
// 콜아웃은 '이 시간에 타임세일을 열어 보세요' 라는 행동 제안이라, 영업 시간대(10~21시) 밖이나 곡선이
// 평평해서 고를 이유가 없을 때는 아예 띄우지 않는다 — 그 경계를 여기서 잠근다.

import assert from 'node:assert/strict';
import { bestQuietHour, quietHourCopy, QUIET_HOUR_MIN_SPREAD } from './forecastInsight';
import type { HourlyCongestionPoint } from './api';
import { DEMO_MERCHANT_FORECAST } from '../demoFixtures';

function curve(startHour: number, values: number[]): HourlyCongestionPoint[] {
  return values.map((congestion, hoursAhead) => ({
    hoursAhead,
    hour: (startHour + hoursAhead) % 24,
    congestion,
    anchored: false,
  }));
}

// 영업 시간대 안에서 가장 낮은 점을 고른다 — 새벽 3시가 더 낮아도 그 시간은 고르지 않는다.
{
  const points = curve(22, [0.5, 0.3, 0.1, 0.05, 0.02, 0.01, 0.01]); // 22,23,0,1,2,3,4시
  assert.equal(bestQuietHour(points), null, '영업 시간대(10~21시) 점이 하나뿐이면 고를 수 없다');

  const mixed: HourlyCongestionPoint[] = [
    { hoursAhead: 0, hour: 20, congestion: 0.7, anchored: false },
    { hoursAhead: 1, hour: 21, congestion: 0.4, anchored: false },
    { hoursAhead: 2, hour: 3, congestion: 0.02, anchored: false },
  ];
  const best = bestQuietHour(mixed);
  assert.ok(best, '20·21시만으로도 차이가 충분하면 콜아웃이 나와야 한다');
  assert.equal(best.hour, 21, '03시(영업 시간 밖)를 골랐다');
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

// 데모 곡선(13~19시, 19시 0.41)은 '19시' 를 고른다 — 데모 화면이 보여 줄 문장.
{
  const best = bestQuietHour(DEMO_MERCHANT_FORECAST);
  assert.ok(best);
  assert.equal(best.hour, 19);
  assert.equal(quietHourCopy(best).title, '19시가 가장 한가할 것 같아요');
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
