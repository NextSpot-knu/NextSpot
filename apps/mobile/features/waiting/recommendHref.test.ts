import assert from 'node:assert/strict';

import { REGION } from '@/lib/region';

import { buildRecommendRoute } from './recommendHref';
import { activeIndexFromOffset, positionLabel } from './presentation';

// 좌표를 알면 그 장소에서(from=waiting), 시설 id 가 있으면 name 은 싣지 않는다
assert.deepEqual(buildRecommendRoute({ facilityId: 'f1', name: '첨성대', type: 'attraction', latitude: 35.83, longitude: 129.21 }), {
  pathname: '/explore/recommend',
  params: { facilityId: 'f1', lat: '35.83', lng: '129.21', type: 'attraction', from: 'waiting' },
});
// 옛 캐시 행(좌표 없음) → 지역 중심, from 없음(그 장소에서 걷는다고 말하지 않는다)
assert.deepEqual(buildRecommendRoute({ facilityId: 'f2', type: 'cafe' }).params, {
  facilityId: 'f2', lat: String(REGION.center.lat), lng: String(REGION.center.lng), type: 'cafe',
});
// id 가 없으면 이름으로
assert.equal(buildRecommendRoute({ name: '카페', type: 'cafe', latitude: 1, longitude: 2 }).params.name, '카페');
// 좌표 한 쪽만 숫자면 모르는 것으로
assert.equal(buildRecommendRoute({ facilityId: 'f', type: 'cafe', latitude: 35, longitude: null }).params.from, undefined);
assert.equal(buildRecommendRoute({ facilityId: 'f', type: 'cafe', latitude: NaN, longitude: 129 }).params.lat, String(REGION.center.lat));

// 캐러셀 위치: 스냅 간격으로 나눠 반올림, 양끝 고정
assert.equal(activeIndexFromOffset(0, 200, 3), 0);
assert.equal(activeIndexFromOffset(110, 200, 3), 1);
assert.equal(activeIndexFromOffset(9999, 200, 3), 2);
assert.equal(activeIndexFromOffset(-50, 200, 3), 0);
assert.equal(activeIndexFromOffset(100, 0, 3), 0);
assert.equal(positionLabel(1, 3), '2 / 3');

console.log('recommendHref.test.ts ok');
