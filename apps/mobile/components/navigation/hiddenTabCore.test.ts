// 숨은 탭 경로를 떠날 때 탭 기록에서 빠지는지(뒤로 키가 홈 ↔ 숨은 경로 사이에 갇히지 않게).
import assert from 'node:assert/strict';

import { homeFirstTabRouter, tabStateLeaving, withHomeFirstInHistory, type TabStateLike } from './hiddenTabCore';

const routes = [
  { key: 'index-1', name: 'index' },
  { key: 'saved-1', name: 'saved' },
  { key: 'map-1', name: 'explore/map' },
];

// 딥링크로 바로 /explore/map: 기록 [map] → [index]
const deep = tabStateLeaving({ index: 2, routes, history: [{ type: 'route', key: 'map-1' }] }, 'map-1', 'index');
assert.ok(deep);
assert.equal(deep.index, 0);
assert.deepEqual(deep.history, [{ type: 'route', key: 'index-1' }]);

// 저장 → 홈 → /explore/map: 기록 [saved, index, map] → [saved, index](홈이 맨 끝, 중복 없음)
const via = tabStateLeaving(
  {
    index: 2,
    routes,
    history: [
      { type: 'route', key: 'saved-1' },
      { type: 'route', key: 'index-1' },
      { type: 'route', key: 'map-1' },
    ],
  },
  'map-1',
  'index',
);
assert.ok(via);
assert.deepEqual(via.history, [{ type: 'route', key: 'saved-1' }, { type: 'route', key: 'index-1' }]);

// 기록이 없는 상태·모르는 탭
const bare: TabStateLike = { index: 2, routes };
assert.deepEqual(tabStateLeaving(bare, 'map-1', 'index')?.history, [{ type: 'route', key: 'index-1' }]);
assert.equal(tabStateLeaving({ index: 2, routes }, 'map-1', 'nope'), null);

// 콜드 딥링크(/saved): 기록 [saved] → [index, saved] — 뒤로 = 홈
const cold: TabStateLike = { index: 1, routes, history: [{ type: 'route', key: 'saved-1' }] };
assert.deepEqual(withHomeFirstInHistory(cold).history, [
  { type: 'route', key: 'index-1' },
  { type: 'route', key: 'saved-1' },
]);
// 기록이 비어 있어도 홈을 깐다
assert.deepEqual(withHomeFirstInHistory(bare).history, [{ type: 'route', key: 'index-1' }]);
// 홈에서 시작했으면 그대로(같은 객체)
const atHome: TabStateLike = { index: 0, routes, history: [{ type: 'route', key: 'index-1' }] };
assert.equal(withHomeFirstInHistory(atHome), atHome);
// 앱 안에서 오간 기록(둘 이상)은 손대지 않는다
const used: TabStateLike = {
  index: 2,
  routes,
  history: [{ type: 'route', key: 'saved-1' }, { type: 'route', key: 'map-1' }],
};
assert.equal(withHomeFirstInHistory(used), used);
// 홈 탭이 없는 상태는 그대로
assert.equal(withHomeFirstInHistory(cold, 'nope'), cold);
// 콜드 딥링크 /explore/map → 홈 기록이 깔린 뒤 떠나도 홈 하나만 남는다
const coldMap = withHomeFirstInHistory({ index: 2, routes, history: [{ type: 'route', key: 'map-1' }] });
assert.deepEqual(tabStateLeaving(coldMap, 'map-1', 'index')?.history, [{ type: 'route', key: 'index-1' }]);

// UNSTABLE_router 덮개 — 첫 상태·딥링크 재수화에만 홈을 깐다
const fakeTabRouter = {
  getInitialState: (_options: { routeNames: string[] }) => ({ ...atHome }),
  getRehydratedState: (_partial: unknown, _options: { routeNames: string[] }) => ({ ...cold }),
  getStateForAction: () => null,
};
const wrapped = { ...fakeTabRouter, ...homeFirstTabRouter(fakeTabRouter) };
assert.deepEqual(wrapped.getInitialState({ routeNames: [] }).history, atHome.history);
assert.deepEqual(wrapped.getRehydratedState({}, { routeNames: [] }).history?.map((h) => h.key), ['index-1', 'saved-1']);
assert.equal(wrapped.getStateForAction, fakeTabRouter.getStateForAction);

console.log('ok hiddenTabCore');
