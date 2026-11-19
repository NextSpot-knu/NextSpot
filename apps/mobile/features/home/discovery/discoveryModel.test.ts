import assert from 'node:assert/strict';

import type { RecommendationResponse } from '../../../lib/core/apiClient';
import type { SheetCandidate } from '../../recommendation-card';
import type { HomeFacility } from '../homeModel';
import {
  activateDiscovery,
  discoveryCompareAnchor,
  discoveryRequestContext,
  discoveryRequestKey,
  discoveryResultItems,
  getDiscoveryTheme,
} from './discoveryModel';

const place = (id: string, name: string, latitude = 35.8389, longitude = 129.2099) => ({
  id, name, type: 'attraction', latitude, longitude, congestionLevel: null, congestionIsCurrent: null, lastUpdated: null,
}) as unknown as HomeFacility;

const silla = getDiscoveryTheme('silla_core');
const hanok = getDiscoveryTheme('hanok_cafe');

// 기준 명소 — 운영 이름 '천마총(대릉원)' 도 찾고, 이름이 같은 곳이 둘이면 고르지 않는다(웹 findDiscoveryAnchor).
const anchor = place('a1', '천마총(대릉원)');
assert.deepEqual(activateDiscovery([place('x', '고도 커피'), anchor], silla), { themeId: 'silla_core', anchorId: 'a1', anchorName: '천마총(대릉원)' });
assert.equal(activateDiscovery([place('x', '고도 커피')], silla), null);
assert.equal(activateDiscovery([place('d1', '대릉원'), place('d2', '대릉원')], silla), null);

// 요청 조건 — 저장된 조건 그대로 + 테마의 후보 종류 하나
const stored = { categories: ['restaurant'], maxWalkMinutes: 20, availableMinutes: 60, requiredAttributes: ['indoor'], excludeVisited: false } as never;
assert.deepEqual(discoveryRequestContext(stored, hanok), {
  categories: ['cafe'], maxWalkMinutes: 20, availableMinutes: 60, requiredAttributes: ['indoor'], excludeVisited: false,
});

// 요청 열쇠 — 테마·기준 명소가 바뀌면 다른 요청
assert.equal(discoveryRequestKey(null), null);
assert.equal(discoveryRequestKey({ themeId: 'silla_core', anchorId: 'a1', anchorName: 'x' }), 'discovery:silla_core:a1');

// 카드 기준 명소 — 테마 명소 이름, 두 좌표 사이 거리, 가정 시각이면 '지금' 등급을 쓰지 않는다
const active = { themeId: 'silla_core' as const, anchorId: 'a1', anchorName: '천마총(대릉원)' };
const live = { ...anchor, congestionLevel: 0.8, congestionIsCurrent: true, lastUpdated: new Date().toISOString() } as unknown as HomeFacility;
const candidate = { facility: { id: 'c1', name: '금관총', type: 'attraction', latitude: 35.8389, longitude: 129.2119 } } as unknown as SheetCandidate;
const ca = discoveryCompareAnchor(active, candidate, [live]);
assert.ok(ca);
assert.equal(ca.name, '천마총(대릉원)');
assert.ok(ca.distanceM !== null && ca.distanceM > 150 && ca.distanceM < 200, String(ca.distanceM));
assert.equal(ca.level, 0.8);
assert.equal(discoveryCompareAnchor(active, candidate, [live], { timeShifted: true })?.level, null);
assert.equal(discoveryCompareAnchor(active, null, [live]), null);
// 기준 명소가 지도 목록에서 빠졌으면 이름만
assert.deepEqual(discoveryCompareAnchor(active, candidate, []), { name: '천마총(대릉원)', distanceM: null, level: null });

// 판의 대안 칸 — 상위 3곳, 테마 근거 키, 도보 분(서버 경로 분 → 없으면 직선거리 추정, 1분 이상 올림)
const rec = (id: string, extra: Record<string, unknown> = {}) => ({
  recommendationId: `r-${id}`, facility: { id, name: `장소 ${id}`, type: 'cafe' }, rank: 1, distanceM: 400,
  breakdown: { preference: 0.5, travelTime: 6.2, incentive: 0, ...extra },
}) as unknown as RecommendationResponse;
const items = discoveryResultItems([
  rec('1', { discoveryThemeMatch: { source: 'tourapi_related', value: 'x' } }),
  rec('2', { discoveryThemeMatch: { source: 'facility_fact', value: 'y' } }),
  rec('3', { travelTime: undefined }),
  rec('4'),
]);
assert.equal(items.length, 3);
assert.deepEqual(items.map((i) => i.rank), [1, 2, 3]);
assert.deepEqual(items.map((i) => i.matchKey), ['discovery.match.related', 'discovery.match.fact', null]);
assert.equal(items[0].walkMinutes, 7);
assert.equal(items[2].walkMinutes, 8); // 400m × 1.18 ÷ 66.67 = 7.08 → 8
assert.equal(items[0].name, '장소 1');

console.log('discoveryModel ok');
