// 혼잡 등급 경계 — 운영자 설정 주입과 폴백 판정.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_BUSY_THRESHOLD, congestionKey, normalizeBusyThreshold } from './congestionScale';

const WEB = process.cwd();

// --- 기본 경계(설정을 못 받았을 때) ------------------------------------------
assert.equal(DEFAULT_BUSY_THRESHOLD, 0.75);
assert.equal(congestionKey(0.8), 'busy');
assert.equal(congestionKey(0.75), 'busy', '경계값은 포함이다');
assert.equal(congestionKey(0.6), 'moderate');
assert.equal(congestionKey(0.3), 'relaxed');
assert.equal(congestionKey(0.1), 'quiet');
assert.equal(congestionKey(0), 'quiet');

// --- 설정값 주입 --------------------------------------------------------------
// "60%부터 혼잡" 으로 내려 잡으면 62% 는 보통이 아니라 혼잡이어야 한다(혼잡 판정이 먼저다).
assert.equal(congestionKey(0.62, 0.6), 'busy');
assert.equal(congestionKey(0.55, 0.6), 'moderate');
// 경계를 올려 잡으면 그 아래는 보통으로 내려온다.
assert.equal(congestionKey(0.8, 0.9), 'moderate');
assert.equal(congestionKey(0.9, 0.9), 'busy');

// --- 0~100 정수 → 0..1 --------------------------------------------------------
assert.equal(normalizeBusyThreshold(75), 0.75);
assert.equal(normalizeBusyThreshold(60), 0.6);
assert.equal(normalizeBusyThreshold(0), 0, '0 은 범위 안이므로 운영자 의도로 받는다');
assert.equal(normalizeBusyThreshold(100), 1);

// --- 못 받았거나 이상한 값은 기본값 -------------------------------------------
// 조회 실패를 '경계 0'(전부 혼잡)으로 만들면 없는 사실을 그리게 된다.
for (const bad of [undefined, null, '75', NaN, Infinity, -1, 101, {}, []]) {
  assert.equal(
    normalizeBusyThreshold(bad),
    DEFAULT_BUSY_THRESHOLD,
    `이상한 값(${String(bad)})은 기본 경계로 떨어져야 한다`,
  );
}

// --- 화면 배선 가드 ------------------------------------------------------------
// 판정만 맞고 화면이 0.75 리터럴로 남는 사고를 막는다(이 저장소의 다른 가드와 같은 이유).
{
  const page = readFileSync(join(WEB, 'app/course/page.tsx'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.match(page, /useBusyThreshold\(\)/, 'course 화면이 운영자 혼잡 경계를 읽지 않는다');
  assert.doesNotMatch(
    page,
    /level >= 0\.75/,
    'course 화면에 하드코딩된 0.75 혼잡 경계가 남아 있다',
  );
}

// --- 지도 화면: 배지와 마커·히트맵이 같은 경계를 쓴다 -------------------------
// 같은 장소의 배지는 '혼잡' 인데 마커는 주황이면, 화면이 스스로 다른 말을 하는 것이다.
{
  const main = readFileSync(join(WEB, 'app/main/page.tsx'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.match(main, /useBusyThreshold\(\)/, '지도 화면이 운영자 혼잡 경계를 읽지 않는다');
  assert.match(main, /getMarkerSvg\([^)]*busyAt\)/, '마커 색이 운영자 경계를 따르지 않는다');
  assert.match(main, /getHeatGradient\([^)]*busyAt\)/, '히트맵 색이 운영자 경계를 따르지 않는다');
  assert.doesNotMatch(main, /congestionLevel >= 0\.75/, '지도 화면에 하드코딩된 0.75 경계가 남아 있다');

  for (const file of ['lib/map/markerSvg.ts', 'lib/map/heatmap.ts']) {
    const src = readFileSync(join(WEB, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /level >= 0\.75/, `${file} 에 하드코딩된 0.75 혼잡 경계가 남아 있다`);
    assert.match(src, /congestionKey\(level, busyAt\)/, `${file} 이 공용 등급 판정을 쓰지 않는다`);
  }
}

console.log('congestionScale tests passed');
