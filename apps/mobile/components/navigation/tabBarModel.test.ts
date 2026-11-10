// 하단 탭 막대 규칙 — 활성 탭 판정·다시 누름 무시·치수 합(웹 BottomNav.tsx).
import assert from 'node:assert/strict';

import { NAV_BAR_HEIGHT } from '../../lib/theme/tokens';
import {
  TAB_BAR_CONTENT_HEIGHT,
  TAB_ORDER,
  activeTabFor,
  isCompactLabel,
  shouldNavigateOnPress,
} from './tabBarModel';

// 경로 → 활성 탭: 숨은 경로는 홈, 마이 하위는 마이(탭 내비게이터 route 이름 기준).
assert.equal(activeTabFor('index'), 'index');
assert.equal(activeTabFor('saved'), 'saved');
assert.equal(activeTabFor('waiting'), 'waiting');
assert.equal(activeTabFor('course'), 'course');
assert.equal(activeTabFor('mypage'), 'mypage');
assert.equal(activeTabFor('explore/recommend'), 'index');
assert.equal(activeTabFor('explore/map'), 'index');
assert.equal(activeTabFor(undefined), 'index');
assert.equal(activeTabFor('nope'), 'index');

// 활성 탭 다시 누름은 무시(웹 :69)
assert.equal(shouldNavigateOnPress('mypage', 'mypage'), false);
assert.equal(shouldNavigateOnPress('index', 'index'), false);
assert.equal(shouldNavigateOnPress('saved', 'index'), true);

assert.deepEqual([...TAB_ORDER], ['index', 'saved', 'waiting', 'course', 'mypage']);
assert.equal(isCompactLabel('waiting'), true);
assert.equal(isCompactLabel('course'), false);

// 1(위 테두리) + 8 + 32(안내 줄) + 4 + 48(탭 줄) + 8 = 101 = NAV_BAR_HEIGHT
assert.equal(TAB_BAR_CONTENT_HEIGHT, 101);
assert.equal(TAB_BAR_CONTENT_HEIGHT, NAV_BAR_HEIGHT);

console.log('ok tabBarModel');
