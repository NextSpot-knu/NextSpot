// 대기 보드 줄 세우기 — 대기가 짧은 순. 사진은 카드가 같은 대기를 보여 줄 때만 앞선다(PM 결정 2026-09-28).
import assert from 'node:assert/strict';
import {
  boardCrowdMembers,
  boardCrowdSpread,
  calmRankOf,
  medianLevel,
  orderByWaitThenPhoto,
  waitHeadlineKey,
  waitHeadlineOf,
  type BoardOrderKey,
  type WaitHeadlineEvidence,
} from './boardOrder';
import type { WaitEstimate } from './waitEstimate';

type Basis = WaitEstimate['basis'];
const est = (minutes: number | null, basis: Basis = minutes === null ? 'default' : 'baseline'): WaitEstimate =>
  ({
    minutes,
    grade: null,
    estimated: minutes !== null,
    calmHour: null,
    arrivalHour: 12,
    basis,
  }) as unknown as WaitEstimate;

interface Row {
  id: string;
  wait: WaitEstimate;
  ev: WaitHeadlineEvidence;
  hasPhoto: boolean;
}
const row = (id: string, wait: WaitEstimate, hasPhoto: boolean, ev: WaitHeadlineEvidence = {}): Row => ({
  id,
  wait,
  ev,
  hasPhoto,
});
const keyOf = (r: Row): BoardOrderKey => ({
  wait: r.wait,
  headlineKey: waitHeadlineKey(waitHeadlineOf(r.wait, r.ev)),
  hasPhoto: r.hasPhoto,
});
const order = (rows: Row[]) => orderByWaitThenPhoto(rows, keyOf).map((r) => r.id);

// --- 카드 한 줄이 말하는 것 -----------------------------------------------------------------
assert.deepEqual(waitHeadlineOf(est(12), {}), { kind: 'minutes', n: 12 });
assert.deepEqual(waitHeadlineOf(est(0, 'server'), {}), { kind: 'noWait' });
assert.deepEqual(waitHeadlineOf(est(0, 'baseline'), {}), { kind: 'relaxed' });
assert.deepEqual(waitHeadlineOf(est(null, 'estimate'), { estimateLevel: 0.1 }), { kind: 'estimate', level: 'quiet' });
assert.deepEqual(waitHeadlineOf(est(null, 'estimate'), { estimateLevel: 0.9 }), { kind: 'estimate', level: 'busy' });
assert.deepEqual(waitHeadlineOf(est(null, 'estimate'), {}), { kind: 'unavailable' }, '추정 근거인데 값이 없으면 수집 중');
assert.deepEqual(waitHeadlineOf(est(null, 'area'), { areaDemandLevel: 0.6 }), { kind: 'area', level: 'moderate' });
assert.deepEqual(waitHeadlineOf(est(null, 'tourism'), { tourismRelativeIndex: 41.6 }), { kind: 'tourism', n: 42 });
assert.deepEqual(waitHeadlineOf(est(null, 'default'), {}), { kind: 'unavailable' });
assert.notEqual(
  waitHeadlineKey({ kind: 'estimate', level: 'quiet' }),
  waitHeadlineKey({ kind: 'area', level: 'quiet' }),
  '같은 등급이라도 근거가 다르면 화면 문구가 다르다',
);

// --- 사진이 더 짧은 대기를 앞지르지 않는다 ------------------------------------------------------
assert.deepEqual(order([row('a', est(5), false), row('b', est(10), true)]), ['a', 'b']);
assert.deepEqual(order([row('b', est(10), true), row('a', est(5), false)]), ['a', 'b']);
assert.deepEqual(order([row('a', est(6), false), row('b', est(7), true)]), ['a', 'b'], '1분 차이도 대기가 먼저');
// 분이 있는 곳은 사진이 없어도 분이 없는 곳(사진 있음)보다 앞.
assert.deepEqual(order([row('b', est(null), true), row('a', est(40), false)]), ['a', 'b']);

// --- 같은 분일 때만 사진 있는 곳이 앞 ----------------------------------------------------------
assert.deepEqual(order([row('a', est(5), false), row('b', est(5), true)]), ['b', 'a']);
assert.deepEqual(order([row('a', est(0), false), row('b', est(0), true)]), ['b', 'a']);
// 같은 0분이라도 '대기 없음'(검증) 과 '여유'(추정) 는 다른 말 — 사진이 가르지 않는다.
assert.deepEqual(order([row('a', est(0, 'server'), false), row('b', est(0, 'baseline'), true)]), ['a', 'b']);

// --- 분이 없는 곳: 같은 말일 때만 사진 우선 (리뷰 지적 2026-09-29) --------------------------------
const quiet = { estimateLevel: 0.1 };
const busy = { estimateLevel: 0.9 };
// 사진 없는 '여유' 가 사진 있는 '혼잡' 보다 먼저 왔다 — 그대로 둔다.
assert.deepEqual(order([row('A', est(null, 'estimate'), false, quiet), row('B', est(null, 'estimate'), true, busy)]), [
  'A',
  'B',
]);
// 프로덕션 모양(모든 카드 분 없음): 여유·여유·혼잡(사진)·수집 중(사진) — 원래 순서 그대로.
assert.deepEqual(
  order([
    row('A', est(null, 'estimate'), false, quiet),
    row('B', est(null, 'estimate'), false, quiet),
    row('C', est(null, 'estimate'), true, busy),
    row('D', est(null, 'default'), true),
  ]),
  ['A', 'B', 'C', 'D'],
);
// 같은 '여유' 끼리는 사진이 앞.
assert.deepEqual(order([row('A', est(null, 'estimate'), false, quiet), row('B', est(null, 'estimate'), true, quiet)]), [
  'B',
  'A',
]);
// 둘 다 '수집 중' 이면 같은 말 — 사진이 앞.
assert.deepEqual(order([row('A', est(null), false), row('B', est(null), true)]), ['B', 'A']);
// 분이 없는 카드는 한산한 등급이 먼저다(PM 결정 2026-10-06 4.20) — 여유·혼잡·여유(사진) 는 여유 두 장이 앞으로
// 모이고, 같은 '여유' 끼리는 사진이 앞. (예전에는 서버 순서 그대로라 혼잡 카드가 여유 카드 사이에 끼었다.)
assert.deepEqual(
  order([
    row('A', est(null, 'estimate'), false, quiet),
    row('B', est(null, 'estimate'), false, busy),
    row('C', est(null, 'estimate'), true, quiet),
  ]),
  ['C', 'A', 'B'],
);
// 서버가 혼잡을 먼저 줘도 한산 → 여유 → 보통 → 혼잡 → 관광 인기도 → 근거 없음.
assert.deepEqual(
  order([
    row('none', est(null), true),
    row('tour', est(null, 'tourism'), false, { tourismRelativeIndex: 20 }),
    row('busy', est(null, 'area'), false, { areaDemandLevel: 0.9 }),
    row('mod', est(null, 'estimate'), false, { estimateLevel: 0.6 }),
    row('rel', est(null, 'area'), false, { areaDemandLevel: 0.3 }),
    row('quiet', est(null, 'estimate'), false, { estimateLevel: 0.1 }),
  ]),
  ['quiet', 'rel', 'mod', 'busy', 'tour', 'none'],
);
// 분이 있는 카드는 여전히 맨 앞, 분 순서 그대로 — 등급 순서는 분이 없는 카드끼리만.
assert.deepEqual(
  order([row('busyNoMin', est(null, 'estimate'), false, busy), row('ten', est(10), false), row('quietNoMin', est(null, 'estimate'), false, quiet)]),
  ['ten', 'quietNoMin', 'busyNoMin'],
);
assert.equal(calmRankOf('estimate:quiet'), 0);
assert.equal(calmRankOf('area:busy'), 3);
assert.ok(calmRankOf('tourism:40') < calmRankOf('unavailable'));
// 관광 상대지수: 같은 반올림 값만 동점.
assert.deepEqual(
  order([row('A', est(null, 'tourism'), false, { tourismRelativeIndex: 40.2 }), row('B', est(null, 'tourism'), true, { tourismRelativeIndex: 39.8 })]),
  ['B', 'A'],
);
assert.deepEqual(
  order([row('A', est(null, 'tourism'), false, { tourismRelativeIndex: 30 }), row('B', est(null, 'tourism'), true, { tourismRelativeIndex: 70 })]),
  ['A', 'B'],
);

// --- 대기도 사진 여부도 같으면 원래 순서 ----------------------------------------------------------
assert.deepEqual(order([row('a', est(5), true), row('b', est(5), true)]), ['a', 'b']);
assert.deepEqual(order([row('a', est(null), false), row('b', est(null), false)]), ['a', 'b']);
// 입력 배열은 건드리지 않는다.
const input = [row('b', est(9), false), row('a', est(1), false)];
orderByWaitThenPhoto(input, keyOf);
assert.deepEqual(input.map((r) => r.id), ['b', 'a']);

// --- 무작위 목록: 정렬 뒤 성질 ------------------------------------------------------------
let seed = 42;
const rand = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 2 ** 32;
};
const rank = (m: number | null) => (m === null ? Infinity : m);
const BASES: Basis[] = ['estimate', 'area', 'tourism', 'default'];
for (let trial = 0; trial < 800; trial++) {
  const n = 1 + Math.floor(rand() * 8);
  const rows = Array.from({ length: n }, (_, i) => {
    const hasMinutes = rand() < 0.4;
    const w = hasMinutes ? est(Math.floor(rand() * 3) * 5, rand() < 0.3 ? 'server' : 'baseline') : est(null, BASES[Math.floor(rand() * 4)]);
    const lvl = [0.1, 0.9][Math.floor(rand() * 2)];
    return row(String(i), w, rand() < 0.4, { estimateLevel: lvl, areaDemandLevel: lvl, tourismRelativeIndex: lvl * 100 });
  });
  const sorted = orderByWaitThenPhoto(rows, keyOf);
  // 사진 없이 세운 기준 줄: 분 짧은 순, 분이 없으면 한산한 등급 순(그 안은 원래 순서).
  const calm = (r: Row) => (r.wait.minutes === null ? calmRankOf(keyOf(r).headlineKey) : 0);
  const waitOnly = rows.slice().sort((a, b) => rank(a.wait.minutes) - rank(b.wait.minutes) || calm(a) - calm(b));
  // 1) 분의 줄은 대기만으로 세운 것과 같다 — 사진 때문에 더 긴 대기가 앞서지 않는다. 보드에 오르는 곳도 그대로.
  assert.deepEqual(sorted.map((r) => rank(r.wait.minutes)), waitOnly.map((r) => rank(r.wait.minutes)), `trial ${trial}`);
  assert.deepEqual(sorted.map((r) => r.id).sort(), rows.map((r) => r.id).sort());
  // 2) 대기만으로 세운 줄에서 X 가 Y 보다 앞이었는데 결과에서 Y 가 앞이면: 둘은 같은 말을 하고, Y 는 사진이 있고
  //    X 는 없으며, 그 사이의 카드도 전부 같은 말이다(다른 말을 하는 카드를 건너뛰지 않는다).
  const pos = new Map(sorted.map((r, i) => [r.id, i]));
  for (let x = 0; x < waitOnly.length; x++) {
    for (let y = x + 1; y < waitOnly.length; y++) {
      const X = waitOnly[x];
      const Y = waitOnly[y];
      if (pos.get(Y.id)! < pos.get(X.id)!) {
        const hk = keyOf(X).headlineKey;
        assert.equal(keyOf(Y).headlineKey, hk, `trial ${trial}: 다른 말을 하는 카드를 앞질렀다`);
        assert.ok(Y.hasPhoto && !X.hasPhoto, `trial ${trial}: 사진 때문이 아닌 역전`);
        for (let z = x; z <= y; z++) assert.equal(keyOf(waitOnly[z]).headlineKey, hk, `trial ${trial}: 다른 말을 건너뛰었다`);
      }
    }
  }
}

// --- 보드 전체가 한 등급인가(2026-10-06 감사 I03) -----------------------------------------------
// 주변 주차 1곳으로 만든 추정이라 보드의 카드가 거의 다 같은 등급이다 — 그때는 등급을 한 번만 말한다.
assert.deepEqual(boardCrowdSpread(Array.from({ length: 23 }, (_, i) => 0.76 + (i % 5) * 0.04)), { uniform: true, grade: 'busy' });
assert.deepEqual(boardCrowdSpread([0.1, 0.9, 0.5]), { uniform: false, grade: null }, '카드끼리 다르면 등급을 카드마다');
assert.deepEqual(boardCrowdSpread([0.74, 0.76, 0.75]), { uniform: true, grade: 'busy' }, '경계를 걸친 0.08 미만 차이는 한 등급');
assert.deepEqual(boardCrowdSpread([0.26, 0.4, 0.49]), { uniform: true, grade: 'relaxed' }, '모두 같은 등급');
assert.deepEqual(boardCrowdSpread([0.9, 0.9]), { uniform: false, grade: null }, '3곳 미만은 판단하지 않는다');
assert.deepEqual(boardCrowdSpread([]), { uniform: false, grade: null });
assert.deepEqual(boardCrowdSpread([0.5, Number.NaN, 0.52, 0.55]), { uniform: true, grade: 'moderate' }, '숫자가 아닌 값은 뺀다');
// 운영자 '혼잡' 경계(busyAt)를 따른다 — 0.65 부터 혼잡이면 0.7 보드는 '혼잡' 한 줄(기본 0.75 눈금이면 '보통').
assert.deepEqual(boardCrowdSpread([0.7, 0.7, 0.71]), { uniform: true, grade: 'moderate' });
assert.deepEqual(boardCrowdSpread([0.7, 0.7, 0.71], 0.65), { uniform: true, grade: 'busy' }, '한 줄이 운영자 경계를 무시한다');
// 카드 머리줄도 같은 경계 — 한 줄과 카드, 대안 화면이 같은 등급을 말한다.
assert.deepEqual(waitHeadlineOf(est(null, 'estimate'), { estimateLevel: 0.7 }), { kind: 'estimate', level: 'moderate' });
assert.deepEqual(waitHeadlineOf(est(null, 'estimate'), { estimateLevel: 0.7 }, 0.65), { kind: 'estimate', level: 'busy' });
assert.deepEqual(waitHeadlineOf(est(null, 'area'), { areaDemandLevel: 0.7 }, 0.65), { kind: 'area', level: 'busy' });

// 다수결(리뷰 10-07) — 새벽 보드 24장 중 23장이 '보통' 이고 한 곳만 '여유' 면 한 줄로 '보통' 을 말한다.
// 예전 규칙(모두 같은 등급)은 한 장 때문에 '추정 혼잡: 보통' 을 23번 되풀이했다.
{
  const night = [...Array.from({ length: 23 }, (_, i) => 0.5 + (i % 4) * 0.05), 0.3];
  assert.deepEqual(boardCrowdSpread(night), { uniform: true, grade: 'moderate' }, '23장 보통 + 1장 여유 = 한 줄 보통');
  const members = boardCrowdMembers(night);
  assert.equal(members.filter(Boolean).length, 23, '보통 카드는 한 줄을 따른다(걷는 시간)');
  assert.equal(members[23], false, '여유 카드는 자기 등급을 카드에 남긴다 — 그것이 덜 붐비는 곳이라는 신호');
}
// 80% 문턱 — 5장 중 4장(80%)은 한 줄, 10장 중 7장(70%)은 카드마다.
assert.deepEqual(boardCrowdSpread([0.5, 0.55, 0.6, 0.52, 0.1]), { uniform: true, grade: 'moderate' });
assert.deepEqual(
  boardCrowdSpread([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.9, 0.1, 0.2]),
  { uniform: false, grade: null },
  '70% 는 다수결이 아니다',
);
// 차이가 아주 작은 보드(경계를 걸친 같은 붐빔)는 모든 카드가 한 줄을 따른다.
assert.deepEqual(boardCrowdMembers([0.74, 0.76, 0.75]), [true, true, true]);
assert.deepEqual(boardCrowdMembers([0.1, 0.9, 0.5]), [false, false, false], '한 등급 보드가 아니면 아무도 따르지 않는다');
assert.deepEqual(boardCrowdMembers([0.5, Number.NaN, 0.52, 0.55]), [true, false, true, true], '숫자가 아닌 값은 따르지 않는다');
// 가운데값 — 이 일대 등급을 말하는 화면들이 같은 규칙을 쓴다.
assert.equal(medianLevel([0.3, 0.1, 0.2]), 0.2);
assert.equal(medianLevel([0.1, 0.4, 0.2, 0.3]), 0.25);
assert.equal(medianLevel([]), null);
assert.equal(medianLevel([Number.NaN]), null);

console.log('boardOrder: ok');
