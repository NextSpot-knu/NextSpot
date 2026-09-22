// /waiting 보드의 세 숫자 — **무엇을 분(minutes)으로 말해도 되는가**가 이 파일의 주제다.
// docs/CONGESTION_DATA.md §2 원칙 3·4·6: 주변 주차 수요나 관광 상대지수를 '대기 N분'으로
// 바꾸지 않고, 근거가 없으면 0분을 만들지 않는다. 그 계약이 깨지면 여기서 먼저 빨개진다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareWaitMinutes, estimateWait, heroWaitCandidate, showsCalmLine, type WaitEstimate } from './waitEstimate';

const WEB = process.cwd();

// KST 12:00 고정 — 시간대 곡선의 피크 근처라 '분이 나오는' 경로가 0으로 뭉개지지 않는다.
const BASE_AT = new Date('2026-09-21T03:00:00Z');
const base = { facilityType: 'restaurant', baseAt: BASE_AT, travelMinutes: 0 };

// --- 분으로 말해도 되는 근거 ---------------------------------------------------
{
  // ① 검증 모델의 대기 — 그대로 쓰고 '추정' 라벨을 붙이지 않는다.
  const est = estimateWait({ ...base, serverWaitMinutes: 12, measuredLevel: 0.9 });
  assert.equal(est.minutes, 12);
  assert.equal(est.basis, 'server');
  assert.equal(est.estimated, false);
  assert.notEqual(est.grade, null, '분이 있으면 대기 등급도 말할 수 있다');
}
{
  // ② 엔진이 순위에 실제로 쓴 대기 — 분은 나오되 '추정' 이다.
  const est = estimateWait({ ...base, serverWaitMinutes: null, rankingWaitMinutes: 21 });
  assert.equal(est.minutes, 21);
  assert.equal(est.basis, 'ranking');
  assert.equal(est.estimated, true);
}
{
  // ③ 업종 기준선 대기 — 서버가 이미 '분'으로 내려준 값이라 분으로 쓰되 '추정'.
  const est = estimateWait({ ...base, rankingWaitMinutes: null, baselineWaitMinutes: 8 });
  assert.equal(est.minutes, 8);
  assert.equal(est.basis, 'baseline');
  assert.equal(est.estimated, true);
}
{
  // ④ 이 장소를 실제로 관측·예측한 혼잡 — 백엔드가 대기를 만들 때 쓰는 것과 같은 입력이다.
  const est = estimateWait({ ...base, measuredLevel: 0.9 });
  assert.equal(est.basis, 'measured');
  assert.equal(typeof est.minutes, 'number');
  assert.ok((est.minutes ?? 0) > 0, '피크 시각의 실측 0.9 는 분이 나와야 한다');
  assert.equal(est.estimated, true);
}

// --- 분으로 바꾸면 안 되는 근거 -------------------------------------------------
// 셋 다 '이 장소 안의 줄'이 아니다. 분이 아니라 등급·지수로만 말해야 한다(§2 원칙 3·4).
for (const [label, input] of [
  ['공영주차+관광 통계 추정', { estimateLevel: 0.82 }],
  ['주변 권역 수요', { areaDemandLevel: 0.82 }],
  ['관광 상대지수', { tourismRelativeIndex: 82 }],
] as const) {
  const est = estimateWait({ ...base, ...input });
  assert.equal(est.minutes, null, `${label} 를 대기(분)로 바꿨다`);
  assert.equal(est.grade, null, `${label} 에 대기 등급이 붙었다`);
  assert.equal(est.estimated, false, '추정한 분이 없으면 추정 라벨도 없다');
}
assert.equal(estimateWait({ ...base, estimateLevel: 0.82 }).basis, 'estimate');
assert.equal(estimateWait({ ...base, areaDemandLevel: 0.82 }).basis, 'area');
assert.equal(estimateWait({ ...base, tourismRelativeIndex: 82 }).basis, 'tourism');

// 우선순위: 실측이 있으면 실측이 이긴다(분이 나온다).
assert.equal(
  estimateWait({ ...base, measuredLevel: 0.9, estimateLevel: 0.82, areaDemandLevel: 0.82 }).basis,
  'measured',
);

// --- 근거가 하나도 없을 때 ------------------------------------------------------
{
  // 0분도, '지금이 가장 한산'도 만들지 않는다 — 화면은 '대기 정보 수집 중'으로 둔다(§2 원칙 6).
  const est = estimateWait({ ...base });
  assert.equal(est.minutes, null);
  assert.equal(est.grade, null);
  assert.equal(est.basis, 'default');
  assert.equal(est.calmHour, null, '내장 시간대 곡선만으로 한산한 시각을 말하지 않는다');
}

// --- 분은 절대 음수가 되지 않는다 -----------------------------------------------
{
  // 서버가 음수를 내려보내도 그 값을 화면에 쓰지 않는다 — 다음 근거로 떨어진다.
  const est = estimateWait({ ...base, serverWaitMinutes: -5, rankingWaitMinutes: 7 });
  assert.equal(est.minutes, 7);
  assert.equal(est.basis, 'ranking');
}
for (const input of [
  { serverWaitMinutes: -5 },
  { rankingWaitMinutes: -1, measuredLevel: 0 },
  { measuredLevel: -0.4 },
  { areaDemandLevel: -1 },
  { tourismRelativeIndex: -20 },
  { serverWaitMinutes: 0 },
]) {
  const est = estimateWait({ ...base, ...input });
  assert.ok(est.minutes === null || est.minutes >= 0, `음수 대기가 나왔다: ${String(est.minutes)}`);
}

// 실측 0(전혀 붐비지 않음)은 0분이 맞다 — 다만 '검증 예측'이 아니라 추정이다.
{
  const est = estimateWait({ ...base, measuredLevel: 0 });
  assert.equal(est.minutes, 0);
  assert.equal(est.estimated, true);
  assert.notEqual(est.basis, 'server', "'대기 없음' 문구는 server 근거에만 허용된다");
}

// --- 한산해지는 시각: 분이 없는 카드는 권역 수요 곡선이 있을 때만 -------------------
{
  for (const input of [{ estimateLevel: 0.82 }, { areaDemandLevel: 0.82 }, { tourismRelativeIndex: 82 }]) {
    const est = estimateWait({ ...base, ...input });
    assert.equal(est.calmHour, null, '곡선 없는 등급 카드가 내장 시간대 곡선만으로 한산한 시각을 말했다');
    assert.equal(showsCalmLine(est), false, '분도 시각도 없는 카드에 한산 줄이 그려진다');
  }
  const shaped = (minutes: number | null, calmHour: number | null, basis: WaitEstimate['basis']): WaitEstimate =>
    ({ minutes, grade: null, estimated: minutes !== null, calmHour, arrivalHour: 12, basis });
  // 분이 있는 카드는 calmHour 가 null 이어도(이미 한산) 그 줄을 쓴다.
  assert.equal(showsCalmLine(shaped(2, null, 'measured')), true);
  // 분이 없어도 곡선에서 실제로 찾은 시각이 있으면 쓴다.
  assert.equal(showsCalmLine(shaped(null, 16, 'area')), true);
  assert.equal(showsCalmLine(shaped(null, null, 'default')), false);

  // 히어로 최단 대기: 추정 0분은 후보가 아니다(카드는 '여유'라고만 말한다). server 0분은 '대기 없음'이라 된다.
  assert.equal(heroWaitCandidate(shaped(0, null, 'ranking')), false);
  assert.equal(heroWaitCandidate(shaped(0, null, 'measured')), false);
  assert.equal(heroWaitCandidate(shaped(0, null, 'server')), true);
  assert.equal(heroWaitCandidate(shaped(4, null, 'ranking')), true);
  assert.equal(heroWaitCandidate(shaped(null, 16, 'area')), false);
  // 실측 0.3(한산)은 모델상 0분으로 떨어진다 — 그 값이 히어로 '0분'으로 올라오면 안 된다.
  assert.equal(heroWaitCandidate(estimateWait({ ...base, measuredLevel: 0.3 })), false);
}

// --- 정렬: 분이 없는 카드는 0분이 아니라 맨 뒤 ----------------------------------
{
  const withMinutes = (minutes: number | null): WaitEstimate => ({
    minutes,
    grade: null,
    estimated: true,
    calmHour: null,
    arrivalHour: 12,
    basis: 'ranking',
  });
  const rows = [withMinutes(null), withMinutes(30), withMinutes(0), withMinutes(null), withMinutes(5)];
  const sorted = rows.slice().sort(compareWaitMinutes).map((e) => e.minutes);
  assert.deepEqual(sorted, [0, 5, 30, null, null], '분 없는 카드가 0분처럼 앞으로 올라왔다');
}

// --- 화면 배선 가드 --------------------------------------------------------------
// 판정만 고치고 화면이 옛 렌더를 유지하는 사고를 막는다(이 저장소의 다른 가드와 같은 이유).
{
  const page = readFileSync(join(WEB, 'app/waiting/page.tsx'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.match(page, /compareWaitMinutes\(/, '보드가 null 안전 정렬을 쓰지 않는다');
  assert.doesNotMatch(
    page,
    /waitOf\(a\)\.minutes\s*-\s*waitOf\(b\)\.minutes/,
    '분 없는 카드를 0분으로 빼는 정렬이 남아 있다',
  );
  assert.doesNotMatch(
    page,
    /minutes\s*<=\s*0\s*\?\s*t\("wait\.noWait"\)/,
    "'대기 없음'을 추정 카드에도 찍는 렌더가 남아 있다",
  );
  assert.match(page, /basis === "server" \? t\("wait\.noWait"\)/, "'대기 없음'이 server 근거로 제한되지 않았다");
  assert.match(page, /bestWait\.estimated && \(/, '히어로 최단 대기에 추정 라벨이 빠졌다');
  assert.match(page, /!heroWaitCandidate\(est\)/, '히어로 후보 선별이 heroWaitCandidate 를 거치지 않는다');
  assert.equal((page.match(/showsCalmLine\(est\) && \(/g) ?? []).length, 2, "'한산해지는 시각' 두 렌더가 showsCalmLine 을 거치지 않는다");
}

console.log('waitEstimate tests passed');
