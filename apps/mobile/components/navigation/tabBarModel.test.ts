// 하단 탭 막대 규칙 — 활성 탭 판정·다시 누름 무시·치수 합(웹 BottomNav.tsx).
import assert from 'node:assert/strict';

import { NAV_BAR_HEIGHT } from '../../lib/theme/tokens';
import {
  TAB_BAR_CONTENT_HEIGHT,
  TAB_ORDER,
  activeTabFor,
  isCompactLabel,
  shouldNavigateOnPress,
  tabPressParams,
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

// 그 탭 자리에서 다시 누름은 무시(웹 :69) — 마이 하위(포커스 route 'mypage')에서 '마이'도 무시
assert.equal(shouldNavigateOnPress('mypage', 'mypage'), false);
assert.equal(shouldNavigateOnPress('index', 'index'), false);
assert.equal(shouldNavigateOnPress('saved', 'index'), true);
// 숨은 경로에서 '홈'(활성으로 그려짐)은 홈으로 간다(B6 검토 M5)
assert.equal(shouldNavigateOnPress('index', 'explore/recommend'), true);
assert.equal(shouldNavigateOnPress('index', 'explore/map'), true);
assert.equal(shouldNavigateOnPress('saved', undefined), true);

// 마이는 중첩 Stack 의 첫 화면으로 되돌아간다(pop) — 다른 탭은 params 없음
assert.deepEqual(tabPressParams('mypage'), { screen: 'index', pop: true });
assert.equal(tabPressParams('index'), undefined);
assert.equal(tabPressParams('saved'), undefined);

assert.deepEqual([...TAB_ORDER], ['index', 'saved', 'waiting', 'course', 'mypage']);
assert.equal(isCompactLabel('waiting'), true);
assert.equal(isCompactLabel('course'), false);

// 1(위 테두리) + 8 + 32(안내 줄) + 4 + 48(탭 줄) + 8 = 101 = NAV_BAR_HEIGHT
assert.equal(TAB_BAR_CONTENT_HEIGHT, 101);
assert.equal(TAB_BAR_CONTENT_HEIGHT, NAV_BAR_HEIGHT);

console.log('ok tabBarModel');
