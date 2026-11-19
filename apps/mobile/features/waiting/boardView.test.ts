import assert from 'node:assert/strict';

import type { WaitEstimate } from '@/lib/waitEstimate';

import type { BoardRow, Sector } from './boardData';
import { computeBoardView, splitSector } from './boardView';
import { arrivalLine, basisKey, headlineText, headlineTone, PLAIN_DISPLAY, type TFn } from './presentation';

const row = (id: string, over: Partial<BoardRow> = {}): BoardRow => ({
  facilityId: id, name: id, type: 'cafe', imageUrls: [], summary: null, congestionLevel: null, areaDemandLevel: null,
  areaDemandParkingEvidence: null, areaDemandTourismEvidence: null, arrivalAction: null, recommendedDepartureDelayMinutes: null,
  expectedWait: null, rankingWait: null, baselineWait: null, capacity: null, expectedTravel: 3, closedToday: false, menus: [], ...over,
});
const est = (over: Partial<WaitEstimate>): WaitEstimate => ({
  minutes: null, grade: null, estimated: false, calmHour: null, calmAt: null, arrivalHour: 12.5, basis: 'default', ...over,
});
const t: TFn = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);

// 대표 3장: 대기 짧은 순, 분이 없으면 뒤, 같은 대기에서만 사진이 앞, 휴무 확정은 대표에서 빠져 행 맨 뒤
const waits: Record<string, WaitEstimate> = {
  a: est({ minutes: 20, grade: 'busy', basis: 'server' }),
  b: est({ minutes: 5, grade: 'relaxed', basis: 'server' }),
  c: est({ minutes: 5, grade: 'relaxed', basis: 'server' }),
  d: est({ minutes: null }),
  e: est({ minutes: 1, grade: 'relaxed', basis: 'server' }),
};
const waitOf = (r: BoardRow) => waits[r.facilityId] ?? est({});
const sector: Sector = {
  type: 'cafe',
  rows: [row('a'), row('b'), row('c', { imageUrls: ['https://x/y.jpg'] }), row('d'), row('e', { closedToday: true })],
};
const { topRows, restRows } = splitSector(sector, waitOf, {}, 0.75);
assert.deepEqual(topRows.map((r) => r.facilityId), ['c', 'b', 'a']); // c 는 b 와 같은 5분이라 사진 있는 쪽이 앞
assert.deepEqual(restRows.map((r) => r.facilityId), ['d', 'e']); // 분 없음 → 휴무 확정 순

// 히어로 최단 대기: 휴무 확정 제외, 추정 0분은 후보가 아니다
const view = computeBoardView([sector], [sector], waitOf, {}, 0.75);
assert.deepEqual(view.bestWait, { minutes: 5, estimated: false });
const zeroEst: Sector = { type: 'cafe', rows: [row('z')] };
assert.equal(computeBoardView([zeroEst], [zeroEst], () => est({ minutes: 0, estimated: true, basis: 'baseline' }), {}, 0.75).bestWait, null);
assert.equal(computeBoardView(null, null, waitOf, {}, 0.75).bestWait, null);
assert.equal(computeBoardView([sector], [sector], waitOf, {}, 0.75).displayOf(row('a')).walk, false);

// 보드가 한 등급(추정 혼잡이 전부 같음) → 카드는 걷는 시간, 등급은 위 한 줄
const rows = ['p', 'q', 'r', 's'].map((id) => row(id));
const uniform: Sector = { type: 'cafe', rows };
const levels = { p: 0.8, q: 0.82, r: 0.81, s: 0.8 };
const uv = computeBoardView([uniform], [uniform], () => est({ basis: 'estimate' }), levels, 0.75);
assert.equal(uv.crowd.spread.uniform, true);
assert.equal(uv.crowd.spread.grade, 'busy');
assert.equal(uv.displayOf(rows[0]).walk, true);
// 도착 중인 섹터(committed 아님)로는 한 등급을 판정하지 않는다
assert.equal(computeBoardView([uniform], null, () => est({ basis: 'estimate' }), levels, 0.75).crowd.spread.uniform, false);

// 문구: 분 없이 근거 없으면 null(0분을 만들지 않는다)
assert.equal(headlineText({ kind: 'unavailable' }, t), null);
assert.equal(headlineText({ kind: 'minutes', n: 7 }, t), 'wait.minutes:{"n":7}');
assert.equal(headlineText({ kind: 'noWait' }, t), 'wait.noWait');
assert.equal(headlineText({ kind: 'estimate', level: 'busy' }, t), 'card.estimateLevel:{"label":"congestion.busy"}');
assert.equal(headlineText({ kind: 'tourism', n: 61.4 as number }, t), 'recommend.tourismEvidenceIndex:{"n":61.4}');
// 색: 추정 분은 점선, 서버 분은 실선, 등급은 jade/gold/terracotta
assert.equal(headlineTone({ kind: 'minutes', n: 5 }, est({ minutes: 5, grade: 'busy', estimated: true })).dashed, true);
assert.equal(headlineTone({ kind: 'minutes', n: 5 }, est({ minutes: 5, grade: 'busy', estimated: false })).dashed, false);
assert.equal(headlineTone({ kind: 'relaxed' }, est({})).text, 'text-jade');
assert.equal(headlineTone({ kind: 'estimate', level: 'busy' }, est({})).text, 'text-terracotta');
// 근거 줄: 근거 없는 카드·걷는 시간 카드는 예측을 약속하지 않는다
assert.equal(arrivalLine(est({ basis: 'default' }), PLAIN_DISPLAY, '12:30', t), 'wait.arrivalOnly:{"time":"12:30"}');
assert.equal(arrivalLine(est({ basis: 'server' }), { walk: true, hideCalm: false }, '12:30', t), 'wait.arrivalOnly:{"time":"12:30"}');
assert.equal(arrivalLine(est({ basis: 'server' }), PLAIN_DISPLAY, '12:30', t), 'wait.arrivalBasis:{"time":"12:30"} · wait.basisServer');
assert.equal(basisKey('tourism'), 'wait.basisTourism');

console.log('boardView.test.ts ok');
