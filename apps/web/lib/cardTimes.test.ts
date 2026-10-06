import assert from 'node:assert/strict';

import { cardTimes } from './cardTimes';
import { displayWalkingMinutes } from './recommender';

const DEPART = new Date('2026-10-06T03:14:00Z'); // 12:14 KST

// 캡처된 모순: 2.4분 → 큰 숫자 2분(반올림) vs 칩 '이동 3분'(올림). 이제 큰 숫자는 칩의 합이다.
{
  const t = cardTimes(2.4, undefined, DEPART);
  assert.equal(t.walkMin, 3);
  assert.equal(t.waitMin, null, '보여 줄 대기가 없는데 대기를 만들었다');
  assert.equal(t.totalMin, 3);
  // "12:24 출발 → 12:24 도착 · 이동 1분" — 도착은 출발 + 칩 분이다.
  assert.equal(t.arrival?.getTime(), DEPART.getTime() + 3 * 60_000);
  assert.equal(t.service, null);
}

// 도보 0.1~30분(0.1 간격) × 대기 없음·0~20분: 큰 숫자 ≥ 도보, 큰 숫자 = 도보 칩 + 보이는 대기,
// 도착 − 출발 = 도보 칩 분, 시작 − 도착 = 대기 칩 분.
for (let tenths = 1; tenths <= 300; tenths += 1) {
  const travel = tenths / 10;
  for (const wait of [undefined, 0, 0.4, 1, 2.1, 7.5, 20]) {
    const t = cardTimes(travel, wait, DEPART);
    const walkChip = displayWalkingMinutes(travel);
    assert.equal(t.walkMin, walkChip, `travel ${travel}: 칩과 다른 도보 분`);
    assert.ok(t.totalMin >= t.walkMin, `travel ${travel} wait ${wait}: 큰 숫자가 도보 칩보다 작다`);
    assert.equal(t.totalMin, walkChip + (t.waitMin ?? 0), `travel ${travel} wait ${wait}: 큰 숫자 ≠ 칩의 합`);
    assert.equal((t.arrival!.getTime() - DEPART.getTime()) / 60_000, walkChip);
    if (wait === undefined) {
      assert.equal(t.waitMin, null);
      assert.equal(t.service, null);
    } else {
      assert.equal(t.waitMin, Math.ceil(wait), `wait ${wait}: 대기 칩은 올림`);
      assert.equal((t.service!.getTime() - t.arrival!.getTime()) / 60_000, t.waitMin);
    }
  }
}

// 도보 값이 없거나 0이면 1분(칩과 같은 최소치). 출발 시각을 모르면 시각은 만들지 않는다.
assert.equal(cardTimes(undefined, undefined, DEPART).walkMin, 1);
assert.equal(cardTimes(0, null, DEPART).totalMin, 1);
const noClock = cardTimes(4.2, 3, null);
assert.equal(noClock.totalMin, 8);
assert.equal(noClock.arrival, null);
assert.equal(noClock.service, null);
// NaN 대기는 대기가 아니다.
assert.equal(cardTimes(3, Number.NaN, DEPART).waitMin, null);

console.log('cardTimes tests passed');
