// 관리자 리포트 이용량 집계 — 두 가지 거짓말을 잠근다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { foldObservations, describeGrowth, OBSERVATION_BUCKET_MS } from './adminUsageIndex';

const WEB = process.cwd();
const T = (iso: string) => iso;

// --- (1) 로그 빈도 편향이 사라지는가 ----------------------------------------
// 같은 30분 안에 A 가 5번 제보하고 B 가 1번 제보하면, 예전 합산은 A 를 5배로 셌다.
{
  const rows = [
    ...Array.from({ length: 5 }, () => ({ facilityId: 'A', timestamp: T('2026-09-01T10:00:00Z'), currentCount: 10 })),
    { facilityId: 'B', timestamp: T('2026-09-01T10:10:00Z'), currentCount: 10 },
  ];
  const folded = foldObservations(rows);
  assert.equal(folded.length, 2, `조각 수가 시설 수와 달라졌다: ${JSON.stringify(folded)}`);
  const total = folded.reduce((s, f) => s + f.level, 0);
  assert.equal(total, 20, '제보를 많이 한 시설이 여전히 더 크게 반영된다');
}

// --- 중앙값을 쓴다 — 튀는 제보 하나가 조각을 끌고 가지 않게 -----------------
{
  const rows = [
    { facilityId: 'A', timestamp: T('2026-09-01T10:00:00Z'), currentCount: 10 },
    { facilityId: 'A', timestamp: T('2026-09-01T10:05:00Z'), currentCount: 12 },
    { facilityId: 'A', timestamp: T('2026-09-01T10:10:00Z'), currentCount: 900 },
  ];
  const [only] = foldObservations(rows);
  assert.equal(only.level, 12, `이상치가 조각을 끌고 갔다: ${only.level}`);
}

// --- 30분 경계에서 조각이 갈린다 --------------------------------------------
{
  const base = Date.parse('2026-09-01T10:00:00Z');
  const rows = [
    { facilityId: 'A', timestamp: new Date(base).toISOString(), currentCount: 4 },
    { facilityId: 'A', timestamp: new Date(base + OBSERVATION_BUCKET_MS).toISOString(), currentCount: 6 },
  ];
  assert.equal(foldObservations(rows).length, 2, '30분을 넘겼는데 같은 조각으로 묶였다');
}

// --- 없는 관측을 만들지 않는다 -----------------------------------------------
{
  const rows = [
    { facilityId: null, timestamp: T('2026-09-01T10:00:00Z'), currentCount: 5 },
    { facilityId: 'A', timestamp: T('2026-09-01T10:00:00Z'), currentCount: null },
    { facilityId: 'A', timestamp: 'not-a-date', currentCount: 5 },
  ];
  assert.deepEqual(foldObservations(rows), [], '버려야 할 행을 0 으로 채워 관측을 만들어 냈다');
}

// --- (2) 전주 표본이 없으면 비교하지 않는다 ----------------------------------
// 예전에는 `+100%` + '급증' 배지를 지어냈다. 그 상황이 드물지도 않다 —
// 조회가 상한에서 잘리면 최신순이라 잘리는 쪽이 언제나 전주 구간이다.
{
  const v = describeGrowth(120, 0, 0);
  assert.equal(v.percent, null, '전주 표본이 없는데 증감률을 만들어 냈다');
  assert.equal(v.status, null, '전주 표본이 없는데 배지를 붙였다');
  assert.equal(v.reason, 'no_previous_observation');
}
{
  // 버킷은 있는데 합이 0 인 경우도 분모가 없다.
  assert.equal(describeGrowth(50, 0, 3).percent, null);
}

// --- 비교할 수 있으면 예전과 같은 등급을 준다 --------------------------------
assert.deepEqual(describeGrowth(120, 100, 4), { percent: 20, status: '급증', reason: null });
assert.deepEqual(describeGrowth(110, 100, 4), { percent: 10, status: '활발', reason: null });
assert.deepEqual(describeGrowth(100, 100, 4), { percent: 0, status: '보통', reason: null });
assert.deepEqual(describeGrowth(50, 100, 4), { percent: -50, status: '둔화', reason: null });

// --- 화면 배선 가드 ----------------------------------------------------------
// 판정만 맞고 화면이 옛 계산으로 남는 사고를 막는다.
{
  const page = readFileSync(join(WEB, 'app/admin/reports/page.tsx'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.match(page, /foldObservations/, '리포트 화면이 관측을 접지 않는다 — 로그 빈도 편향이 그대로다');
  assert.match(page, /describeGrowth/, '리포트 화면이 증감 판정을 쓰지 않는다');
  assert.doesNotMatch(page, /cur > 0 \? 100 : 0/, "지어낸 '+100%' 계산이 아직 남아 있다");
  assert.match(page, /facility_id/, 'facility_id 를 조회하지 않으면 시설별로 접을 수 없다');
  assert.doesNotMatch(page, /총 이용량 \(최근 7일\)/, "'총 이용량' 라벨이 남아 있다 — 이 값은 사람 수가 아니다");
}

console.log('adminUsageIndex tests passed');
