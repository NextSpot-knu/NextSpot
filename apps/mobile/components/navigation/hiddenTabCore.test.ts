// 숨은 탭 경로를 떠날 때 탭 기록에서 빠지는지(뒤로 키가 홈 ↔ 숨은 경로 사이에 갇히지 않게).
import assert from 'node:assert/strict';

import { tabStateLeaving, type TabStateLike } from './hiddenTabCore';

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

console.log('ok hiddenTabCore');
