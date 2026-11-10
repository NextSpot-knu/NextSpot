import assert from 'node:assert/strict';

import type { RecommendationResponse } from '../../lib/core/apiClient';
import type { HomeFacility } from './homeModel';
import { buildSelectedCandidate, cardFacilityFromHome, mapBottomInset, sheetCoverHeight, sheetStatus } from './sheetModel';

const home = {
  id: 'f1', name: '카페', type: 'cafe', latitude: 35.8, longitude: 129.2, capacity: null, features: null,
  address: '경주', phone: null, operatingHours: null, imageUrl: null, galleryImages: null, homepage: null,
  overview: null, barrierFree: null, contentid: null, contenttypeid: null, availabilityEvidence: null,
  congestionLevel: null, currentCount: null, lastUpdated: null, source: null, isStale: false,
} as unknown as HomeFacility;

const origin = { lat: 35.8, lng: 129.2 };
const rec = { recommendationId: 'r1', facility: { id: 'f1', name: '카페', type: 'cafe', latitude: 35.8, longitude: 129.2, capacity: 10 }, spotScore: 80 } as unknown as RecommendationResponse;

// null 은 undefined 로
const card = cardFacilityFromHome(home);
assert.equal(card.capacity, undefined);
assert.equal(card.congestionLevel, undefined);
assert.equal(card.name, '카페');

// 추천 목록에 있고 직접 고르지 않았으면 서버 응답 그대로 → 순위 배지
assert.equal(buildSelectedCandidate(home, 'recommended', [rec], origin), rec);
assert.equal(buildSelectedCandidate(home, 'pin', [rec], origin), rec);
// 검색으로 골랐으면 '선택한 장소' 지만 서버 항목은 유지
const searched = buildSelectedCandidate(home, 'search', [rec], origin);
assert.equal(searched.userPicked, true);
assert.equal(searched.recommendationId, 'r1');
// 목록 밖이면 장소만
const outside = buildSelectedCandidate(home, 'pin', [], origin);
assert.equal(outside.userPicked, true);
assert.equal(outside.recommendationId, undefined);
// 목록 밖이면 기준점에서 직선거리가 채워진다 — 위도 0.009° ≈ 1km
const far = buildSelectedCandidate(home, 'pin', [], { lat: 35.791, lng: 129.2 });
assert.ok(typeof far.distanceM === 'number' && far.distanceM > 950 && far.distanceM < 1050);
assert.equal(outside.distanceM, 0);

// 로딩 판
assert.equal(sheetStatus({ hasFacilities: true, recsLoaded: false, hasSelection: false, searching: false }), 'loading');
assert.equal(sheetStatus({ hasFacilities: true, recsLoaded: false, hasSelection: true, searching: false }), 'ready');
assert.equal(sheetStatus({ hasFacilities: true, recsLoaded: false, hasSelection: false, searching: true }), 'ready');
assert.equal(sheetStatus({ hasFacilities: false, recsLoaded: false, hasSelection: false, searching: false }), 'ready');

// 지도 가려진 띠 — 시트 없으면 idle, 펼침은 기본 높이까지만
assert.equal(mapBottomInset(null, 800, 150), 16);
assert.equal(mapBottomInset('minimized', 800, 150), Math.round(800 * 0.27) + 16);
assert.equal(mapBottomInset('expanded', 800, 150), mapBottomInset('normal', 800, 150));
assert.equal(mapBottomInset('normal', 0, 150), 150);
// 가장 낮은 높이는 시트가 잰 px 가 있으면 그것(비율 대신) — 지도 띠 · 여정 카드 자리가 같은 값을 쓴다
assert.equal(mapBottomInset('minimized', 800, 150, 16, 190), 190 + 16);
assert.equal(sheetCoverHeight('minimized', 800, 190), 190);
assert.equal(sheetCoverHeight('minimized', 800, null), Math.round(800 * 0.27));
assert.equal(sheetCoverHeight('normal', 800, 190), Math.round(800 * 0.52));
assert.equal(sheetCoverHeight('minimized', 800, 2000), Math.round(800 * 0.52), '기본 높이를 넘지 않는다');
assert.equal(sheetCoverHeight('expanded', 0, 190), 0);

console.log('sheetModel ok');
