// /waiting 보드의 세 숫자 — **무엇을 분(minutes)으로 말해도 되는가**가 이 파일의 주제다.
// docs/CONGESTION_DATA.md §2 원칙 3·4·6: 주변 주차 수요나 관광 상대지수를 '대기 N분'으로
// 바꾸지 않고, 근거가 없으면 0분을 만들지 않는다. 그 계약이 깨지면 여기서 먼저 빨개진다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  arrivalHourOf,
  boardWaitBaseMs,
  calmAfterClose,
  compareWaitMinutes,
  displayArrivalTime,
  estimateWait,
  heroWaitCandidate,
  showsCalmLine,
  type WaitEstimate,
} from './waitEstimate';

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
  // 0분도, '지금이 가장 한산'도 만들지 않는다 — 화면은 대기 머리줄을 비워 둔다(§2 원칙 6).
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
    ({ minutes, grade: null, estimated: minutes !== null, calmHour, calmAt: null, arrivalHour: 12, basis });
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
    calmAt: null,
    arrivalHour: 12,
    basis: 'ranking',
  });
  const rows = [withMinutes(null), withMinutes(30), withMinutes(0), withMinutes(null), withMinutes(5)];
  const sorted = rows.slice().sort(compareWaitMinutes).map((e) => e.minutes);
  assert.deepEqual(sorted, [0, 5, 30, null, null], '분 없는 카드가 0분처럼 앞으로 올라왔다');
}

// --- 도착 시각은 분까지(옆의 '현재 12:14 기준'과 어긋나는 '도착 12시'를 만들지 않는다) -----------
{
  // 규칙: 가장 가까운 분으로 반올림한다(12시 19.8분 → 12:20). 60분이 되면 다음 시로 넘긴다.
  assert.equal(displayArrivalTime(12.33), '12:20');
  assert.equal(displayArrivalTime(9.5), '09:30');
  assert.equal(displayArrivalTime(12.999), '13:00');
  assert.equal(displayArrivalTime(23.995), '00:00');
  // 카드가 쓰는 값 그대로 — KST 12:14 출발 + 도보 6분 = 12:20 도착.
  const est = estimateWait({ ...base, baseAt: new Date('2026-09-21T03:14:00Z'), travelMinutes: 6 });
  assert.equal(displayArrivalTime(est.arrivalHour), '12:20');
}

// --- '한산해지는 시각'은 그 시각에 문을 닫은 곳에는 쓰지 않는다 ---------------------------
{
  // KST 12:00 식당·실측 0.9 → 15시에 절반 이하로 내려간다. calmAt 은 그 정시의 실제 시각(같은 날 15:00 KST).
  const est = estimateWait({ ...base, measuredLevel: 0.9 });
  assert.equal(est.calmHour, 15);
  assert.equal(est.calmAt?.toISOString(), '2026-09-21T06:00:00.000Z');
  // 밤 22시 도착 → 자정에 한산 — calmAt 은 **다음 날** 00:00 KST(요일·휴무일 판정이 그날을 본다).
  const night = estimateWait({
    ...base,
    measuredLevel: 0.9,
    baseAt: new Date('2026-09-21T13:00:00Z'),
    areaCurve: { 22: 1, 23: 1, 0: 0 },
  });
  assert.equal(night.calmHour, 0);
  assert.equal(night.calmAt?.toISOString(), '2026-09-21T15:00:00.000Z');
  // 한산한 시각을 못 찾았으면 calmAt 도 없다.
  assert.equal(estimateWait({ ...base }).calmAt, null);

  assert.equal(calmAfterClose(est, { open: '09:30~14:30' }), true, '14:30 에 닫는 곳에 15시 이후 한산이 붙는다');
  assert.equal(calmAfterClose(est, { open: '09:00~21:00' }), false);
  // 못 읽는 영업시간·영업시간 없음(옛 캐시 행)은 줄을 지우지 않는다 — 닫았다고 확정할 때만.
  assert.equal(calmAfterClose(est, { open: '상시 개방' }), false);
  assert.equal(calmAfterClose(est, null), false);
  assert.equal(calmAfterClose(est, undefined), false);
  // 라이브 실측 사례(경주 최부자댁 09:30~17:30)에 '20시 이후 한산'이 붙어 있었다.
  const evening: WaitEstimate = {
    minutes: null, grade: null, estimated: false, calmHour: 20,
    calmAt: new Date('2026-09-21T11:00:00Z'), arrivalHour: 12, basis: 'area',
  };
  assert.equal(calmAfterClose(evening, { open: '09:30~17:30' }), true);
  // '지금이 가장 한산'(calmHour 없음)은 이 판정과 무관하다.
  assert.equal(calmAfterClose({ ...evening, minutes: 2, calmHour: null, calmAt: null }, { open: '09:30~10:00' }), false);
}

// --- 화면 배선 가드 --------------------------------------------------------------
// 판정만 고치고 화면이 옛 렌더를 유지하는 사고를 막는다(이 저장소의 다른 가드와 같은 이유).
{
  const page = readFileSync(join(WEB, 'app/waiting/page.tsx'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  // 보드는 orderByWaitThenPhoto(같은 대기를 보여 줄 때만 사진 우선)로 세운다 — 먼저 null 안전 정렬로 분을 세운다.
  const boardOrder = readFileSync(join(WEB, 'lib/boardOrder.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.match(page, /orderByWaitThenPhoto\(/, '보드가 대기 우선 줄 세우기를 쓰지 않는다');
  assert.match(boardOrder, /keyed\.sort\(\(a, b\) => compareWaitMinutes\(a\.key\.wait, b\.key\.wait\)\);/, '보드가 null 안전 정렬을 쓰지 않는다');
  // 카드 한 줄의 문구와 동점 판정이 같은 판정(waitHeadlineOf)을 쓴다.
  assert.match(page, /waitHeadlineKey\(headlineOf\(/, '동점 판정이 카드 문구와 다른 값을 본다');
  assert.match(page, /const h = headlineOf\(est, row, estimateLevel\);/, '카드 문구가 waitHeadlineOf 를 거치지 않는다');
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
  assert.match(boardOrder, /basis === 'server' \? \{ kind: 'noWait' \}/, "'대기 없음'이 server 근거로 제한되지 않았다");
  assert.match(page, /case "noWait":\s*return t\("wait\.noWait"\);/, "'대기 없음' 문구가 noWait 판정에만 붙지 않는다");
  assert.match(page, /bestWait\.estimated && \(/, '히어로 최단 대기에 추정 라벨이 빠졌다');
  assert.match(page, /!heroWaitCandidate\(est\)/, '히어로 후보 선별이 heroWaitCandidate 를 거치지 않는다');
  assert.equal((page.match(/showsCalmLine\(est\) && \(/g) ?? []).length, 2, "'한산해지는 시각' 두 렌더가 showsCalmLine 을 거치지 않는다");
  assert.equal(
    (page.match(/!calmAfterClose\(est, row\.operatingHours\) && showsCalmLine\(est\) && \(/g) ?? []).length,
    2,
    "'한산해지는 시각' 두 렌더가 문 닫은 뒤의 한산을 거르지 않는다",
  );
  assert.match(page, /operatingHours: rec\.facility\.operatingHours \?\? null/, '보드 행이 영업시간을 싣지 않는다');
  // 도착 시각은 분까지 — 정수 시('도착 12시 기준')로 뭉개지 않는다.
  assert.match(page, /t\("wait\.arrivalBasis", \{ time: displayArrivalTime\(est\.arrivalHour\) \}\)/, '도착 시각이 분 단위가 아니다');
  assert.doesNotMatch(page, /displayHour\(/, '정수 시 도착 표기가 남아 있다');
  // 근거가 하나도 없는 카드(basis 'default')는 머리줄·등급·한산 줄이 모두 없다 — 주석만 남는데 그것이
  // '도착 예측'(zh '按12:20到达预测')이면 보여 주지 않는 예측을 약속한다. 그 카드는 도착 시각만 말한다.
  assert.match(
    page,
    /est\.basis === "default"\s*\?\s*t\("wait\.arrivalOnly", \{ time: displayArrivalTime\(est\.arrivalHour\) \}\)/,
    '근거 없는 카드의 주석이 도착 시각만 말하지 않는다',
  );
  for (const locale of ['ko', 'en', 'ja', 'zh'] as const) {
    const wait = (JSON.parse(readFileSync(join(WEB, `lib/i18n/messages/${locale}.json`), 'utf8')) as {
      wait: Record<string, string>;
    }).wait;
    assert.ok(wait.arrivalOnly?.includes('{time}'), `${locale}: wait.arrivalOnly 에 도착 시각이 없다`);
    assert.doesNotMatch(wait.arrivalOnly, /예측|predict|forecast|予測|预测|預測/i, `${locale}: 근거 없는 카드가 예측을 약속한다`);
  }
  // 골든타임 배지는 뜨자마자 GET /predict/golden-hour 를 보낸다 — 다 찬 보드에서만 달아야 순차 by-type 조회와 겹치지 않는다.
  assert.match(page, /\{!loading && topRows\[0\] && \(\s*<div className="mt-2">\s*<GoldenHourBadge /, '골든타임 조회가 부분 섹션에서 by-type 조회와 겹친다');
  // 근거가 하나도 없는 카드에 '대기 정보 수집 중' 머리줄을 세우지 않는다.
  assert.doesNotMatch(page, /waiting\.waitUnavailable/, "'대기 정보 수집 중' 머리줄이 남아 있다");

  // 섹션은 도착하는 대로(I36) — 그러나 '이 프리셋의 보드'(캐시)는 다 찼을 때 한 번만 남긴다.
  const cacheWrites = page.match(/localStorage\.setItem\(\s*BOARD_CACHE_KEY/g) ?? [];
  assert.equal(cacheWrites.length, 1, '보드 캐시를 쓰는 자리가 하나가 아니다');
  const finalCommit = page.indexOf('setSectors(nextSectors)');
  assert.ok(finalCommit >= 0 && finalCommit < page.search(/localStorage\.setItem\(\s*BOARD_CACHE_KEY/), '캐시가 마지막 커밋 전에 쓰인다');
  // 앞 유형이 하나라도 실패했으면 뒤 섹션은 마지막 커밋까지 기다린다(먼저 보인 섹션 위로 끼어들지 않게).
  assert.match(page, /!silentRefresh && !stale\(\) && results\.every\(\(r\) => r\.status === "fulfilled"\)/, '부분 섹션의 앞부분 규칙이 없다');
  // 히어로 최단 대기는 화면에 보이는 섹션에서만 — 로더 뒤의 옛 프리셋 보드에서 뽑지 않는다.
  assert.match(page, /const bestWait = [\s\S]*?for \(const sector of shownSectors\)/, '히어로 최단 대기가 보이는 섹션을 보지 않는다');

  // 대기·순서는 5분 박자의 기준 시각으로, 도착 시각 글자만 30초 시계로 — 30초마다 카드가 자리를 바꾸지 않게(10-06 리뷰).
  assert.match(page, /const waitBaseMs = baseAtMs \?\? \(nowMs === null \? null : boardWaitBaseMs\(nowMs\)\);/, '대기 기준 시각이 5분 박자가 아니다');
  assert.match(page, /baseAt: new Date\(waitBaseMs \?\? Date\.now\(\)\)/, 'estimateWait 가 30초 시계로 대기를 다시 센다');
  assert.match(page, /arrivalHour: arrivalHourOf\(new Date\(effectiveBaseMs \?\? Date\.now\(\)\), row\.expectedTravel\)/, '도착 시각 글자가 30초 시계를 따르지 않는다');
  // 머리글의 '언제 한산해지는지' 약속은 보이는 카드에 한산 줄이 있을 때만.
  assert.match(page, /showsAnyCalmLine \? t\("waiting\.subtitle"\) : t\("waiting\.subtitleArrival"\)/, "머리글이 카드에 없는 '한산해지는 시각'을 약속한다");
  assert.match(page, /showsAnyCalmLine \? t\("wait\.legend"\) : t\("wait\.legendArrival"\)/, "범례가 카드에 없는 '한산해지는 시각'을 약속한다");
  for (const locale of ['ko', 'en', 'ja', 'zh'] as const) {
    const m = JSON.parse(readFileSync(join(WEB, `lib/i18n/messages/${locale}.json`), 'utf8')) as {
      waiting: Record<string, string>; wait: Record<string, string>;
    };
    for (const text of [m.waiting.subtitleArrival, m.wait.legendArrival]) {
      assert.doesNotMatch(text, /한산|calm|空い|すいて|清静|空闲/i, `${locale}: 한산 시각 없는 머리글이 한산을 말한다 — ${text}`);
    }
  }
}

// --- 5분 박자 기준 시각 · 도착 시각 -------------------------------------------------------
{
  const at = (iso: string) => new Date(iso).getTime();
  // 같은 5분 칸 안에서는 기준 시각이 움직이지 않는다 — 그 사이 대기·순서가 그대로다.
  assert.equal(boardWaitBaseMs(at('2026-09-21T03:00:00Z')), at('2026-09-21T03:00:00Z'));
  assert.equal(boardWaitBaseMs(at('2026-09-21T03:04:59Z')), at('2026-09-21T03:00:00Z'));
  assert.equal(boardWaitBaseMs(at('2026-09-21T03:05:00Z')), at('2026-09-21T03:05:00Z'));
  const tick = (iso: string) => estimateWait({ ...base, travelMinutes: 7, capacity: 40, baseAt: new Date(boardWaitBaseMs(at(iso))) });
  assert.deepEqual(tick('2026-09-21T03:00:10Z'), tick('2026-09-21T03:04:40Z'), '같은 5분 칸에서 대기가 바뀐다');
  // 도착 시각은 estimateWait 와 같은 식(기준 + 이동 분, 24시 넘으면 다음 날 시각).
  for (const [iso, travel] of [['2026-09-21T03:00:30Z', 7], ['2026-09-21T14:55:00Z', 12], ['2026-09-21T03:00:00Z', null]] as const) {
    const baseAt = new Date(iso);
    assert.equal(arrivalHourOf(baseAt, travel), estimateWait({ ...base, baseAt, travelMinutes: travel }).arrivalHour, `${iso} +${travel}`);
  }
  assert.equal(displayArrivalTime(arrivalHourOf(new Date('2026-09-21T14:55:00Z'), 12)), '00:07');
}

console.log('waitEstimate tests passed');
