// 이 일대 '지금' 붐빔(리뷰 10-07) — /main 칩이 경주 전역 가운데값으로 '여유' 를, /explore · /waiting 이 시내 중심 장소로
// '보통' 을 말하던 어긋남을 잠근다. node:assert 독립 스크립트(scripts/run-web-tests.mjs 가 돌린다).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AREA_NOW_RADIUS_M, areaNowLevel } from './areaNow';
import { congestionKey } from './congestionScale';
import { REGION } from './region';

const near = (i: number, level: number) => ({ latitude: REGION.center.lat + i * 0.001, longitude: REGION.center.lng, level });
// 위도 0.05° ≈ 5.5km — 보문·불국사 쪽 외곽.
const far = (i: number, level: number) => ({ latitude: REGION.center.lat - 0.05 - i * 0.001, longitude: REGION.center.lng + 0.05, level });

// 시내 중심은 '보통' 인데 외곽의 한산한 장소가 더 많다 — 전역 가운데값은 '여유' 지만 이 일대는 '보통'.
{
  const places = [
    ...Array.from({ length: 6 }, (_, i) => near(i, 0.55 + (i % 3) * 0.05)),
    ...Array.from({ length: 12 }, (_, i) => far(i, 0.3)),
  ];
  const level = areaNowLevel(places);
  assert.ok(level !== null);
  assert.equal(congestionKey(level!), 'moderate', '외곽이 시내 중심의 등급을 끌어내렸다');
}

// 반경 경계 · 3곳 미만은 말하지 않는다 · 숫자가 아닌 값은 뺀다.
{
  assert.equal(areaNowLevel([near(0, 0.6), near(1, 0.6)]), null, '두 곳으로는 이 일대를 말하지 않는다');
  assert.equal(areaNowLevel([...Array.from({ length: 5 }, (_, i) => far(i, 0.2))]), null, '반경 밖만 있으면 말하지 않는다');
  assert.equal(areaNowLevel([near(0, 0.6), near(1, Number.NaN), near(2, 0.62), near(3, 0.64)]), 0.62);
  assert.equal(areaNowLevel([]), null);
  assert.ok(AREA_NOW_RADIUS_M >= 1000 && AREA_NOW_RADIUS_M <= 2000);
}

// 배선 — 세 화면이 같은 피드 스냅숏을 쓰고, /main 칩은 이 규칙(시내 중심 가운데값)을 쓴다.
{
  const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
  const main = read('app', 'main', 'page.tsx');
  assert.match(main, /areaNowLevelOf\(/, '/main 칩이 시내 중심 규칙을 쓰지 않는다');
  for (const page of [main, read('app', 'waiting', 'page.tsx'), read('app', 'explore', 'recommend', 'page.tsx')]) {
    assert.match(page, /loadSharedCongestionEstimates\(/, '화면이 공용 추정 피드를 쓰지 않는다');
    assert.doesNotMatch(page, /getCongestionEstimates\(/, '화면이 추정 피드를 따로 받는다(다른 시각의 값을 말할 수 있다)');
  }
}

console.log('areaNow: ok');
