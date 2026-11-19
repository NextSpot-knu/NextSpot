import assert from 'node:assert/strict';

import { GOOGLE_MAPS_CONFIGURED_EXTRA, isMapAvailable } from './mapAvailability';

// iOS·웹은 키 없이도 지도를 연다(애플 지도).
assert.equal(isMapAvailable('ios', undefined), true);
assert.equal(isMapAvailable('ios', { googleMapsConfigured: false }), true);
assert.equal(isMapAvailable('web', null), true);

// 안드로이드 — 빌드가 키를 넣었다고 표시했을 때만.
assert.equal(isMapAvailable('android', { [GOOGLE_MAPS_CONFIGURED_EXTRA]: true }), true);
assert.equal(isMapAvailable('android', { googleMapsConfigured: true, eas: { projectId: 'x' } }), true);

// 키 없는 빌드는 MapView 를 열지 않는다(열면 앱이 죽는다).
assert.equal(isMapAvailable('android', undefined), false);
assert.equal(isMapAvailable('android', null), false);
assert.equal(isMapAvailable('android', {}), false);
assert.equal(isMapAvailable('android', { googleMapsConfigured: false }), false);
// 참 같은 값이 아니라 정확히 true 만 — 실수로 키 문자열이 들어와도 판정에 기대지 않는다.
assert.equal(isMapAvailable('android', { googleMapsConfigured: 'true' }), false);
assert.equal(isMapAvailable('android', { googleMapsConfigured: 1 }), false);
assert.equal(isMapAvailable('android', 'googleMapsConfigured'), false);

console.log('OK mapAvailability');
