import assert from 'node:assert/strict';

import { appFeatureShortcuts, FEATURE_SHORTCUT_KEYS } from './featureShortcutRows';

// 웹과 같은 순서·키(apps/web/lib/featureShortcuts.ts)
assert.deepEqual([...FEATURE_SHORTCUT_KEYS], ['forecast', 'card', 'live', 'voice', 'console']);
// 앱에 없는 기능(예측 지도·음성 비서)은 숨기고 순서는 웹 그대로
assert.deepEqual(appFeatureShortcuts(true), ['card', 'live', 'console']);
// 콘솔 입구를 끄면(D7 ②) 콘솔 줄도 빠진다
assert.deepEqual(appFeatureShortcuts(false), ['card', 'live']);

console.log('featureShortcutRows.test OK');
