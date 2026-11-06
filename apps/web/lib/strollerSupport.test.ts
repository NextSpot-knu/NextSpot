// 유모차 조건의 배포 시차 가드(P1-6) — 옛 API 가 'stroller' 를 422 로 거절해도 추천·코스가 끊기지 않고,
// 켠 조건은 화면이 같은 판정으로 지킨다.
import assert from 'node:assert/strict';
import {
  asksForStroller,
  keepStrollerFriendly,
  keepStrollerFriendlyCourse,
  markServerSkipsStroller,
  resetStrollerSupportForTest,
  serverSkipsStroller,
  withoutStrollerAttribute,
  withoutStrollerContext,
} from './strollerSupport';

// ── 조건 읽기·빼기 ─────────────────────────────────────────────────────────
const context = { categories: [], requiredAttributes: ['indoor', 'stroller'], excludeVisited: false };
assert.equal(asksForStroller(context), true);
assert.equal(asksForStroller({ requiredAttributes: ['indoor'] }), false);
assert.equal(asksForStroller(undefined), false);
assert.equal(asksForStroller({ requiredAttributes: 'stroller' }), false, '배열이 아니면 요구가 아니다');

const body = { userId: 'u', context };
const stripped = withoutStrollerContext(body);
assert.deepEqual((stripped.context as { requiredAttributes: string[] }).requiredAttributes, ['indoor']);
assert.deepEqual(context.requiredAttributes, ['indoor', 'stroller'], '원본 조건을 바꾸지 않는다');
assert.equal(withoutStrollerContext({ userId: 'u', context: { requiredAttributes: ['indoor'] } }).context.requiredAttributes.length, 1);
const noContext = { userId: 'u' } as { userId: string; context?: unknown };
assert.equal(withoutStrollerContext(noContext), noContext, '조건이 없으면 그대로');
assert.deepEqual(withoutStrollerAttribute(['accessible', 'stroller']), ['accessible']);
assert.equal(withoutStrollerAttribute(null), null);

// ── 세션 표시 — 한 번 확인하면 이 세션은 처음부터 뺀다 ──────────────────────
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
};
resetStrollerSupportForTest();
assert.equal(serverSkipsStroller(), false);
markServerSkipsStroller();
assert.equal(serverSkipsStroller(), true);
resetStrollerSupportForTest();
assert.equal(serverSkipsStroller(), true, '새로 읽어도 sessionStorage 의 표시가 남는다');

// ── 카드 거르기 — 서버 미러 판정(isStrollerFriendly) ─────────────────────────
const card = (id: string, features: Record<string, unknown> | null) => ({ recommendationId: id, facility: { id, features } });
assert.deepEqual(
  keepStrollerFriendly([card('a', { chk_babycarriage: '가능' }), card('b', { chk_babycarriage: '불가' }), card('c', {}), card('d', { chkBabycarriage: '있음' }), card('e', null)])
    .map((item) => item.recommendationId),
  ['a', 'd'],
);

// ── 코스 — 빠진 정류지는 '못 채운 자리' 로 남기고 순서를 다시 매긴다 ───────────
const stop = (order: number, id: string, ok: boolean, alternatives: Array<{ id: string; ok: boolean }> = []) => ({
  order,
  facility: { id, features: ok ? { chk_babycarriage: '가능' } : { chk_babycarriage: '불가' } },
  alternatives: alternatives.map((alt) => ({ facility: { id: alt.id, features: alt.ok ? { stroller: true } : {} } })),
});
const outcome = (order: number, facilityId: string | null, status = 'filled') => ({ order, status, facilityId, pinned: false, requestedType: 'cafe' });
const course = keepStrollerFriendlyCourse(
  [stop(1, 's1', true, [{ id: 'x', ok: false }, { id: 'y', ok: true }]), stop(2, 's2', false), stop(3, 's3', true)],
  [outcome(1, 's1'), outcome(2, 's2'), outcome(3, 's3'), outcome(4, null, 'closed_at_arrival')],
);
assert.deepEqual(course.stops.map((s) => [s.order, s.facility.id]), [[1, 's1'], [2, 's3']], '남은 정류지는 1..n 으로 다시 매긴다');
assert.deepEqual(course.stops[0].alternatives?.map((a) => a.facility.id), ['y'], '갈아끼울 후보도 같은 조건');
assert.deepEqual(
  course.outcomes.map((o) => [o.order, o.status, o.facilityId]),
  [[1, 'filled', 's1'], [2, 'no_candidate_of_type', null], [3, 'filled', 's3'], [4, 'closed_at_arrival', null]],
  '빠진 정류지의 자리는 이유와 함께 남는다',
);

console.log('strollerSupport tests passed');
