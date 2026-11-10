import assert from 'node:assert/strict';

import type { RecommendationResponse } from '../../lib/core/apiClient';
import type { HomeFacility } from './homeModel';
import {
  buildSelectedCandidate,
  cardFacilityFromHome,
  cardStatus,
  compareAnchorFor,
  comparisonFor,
  spotComparisonsById,
} from './sheetModel';

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

// 추정 피드 최신값이 응답 속 추정을 이긴다(G3-13) — 목록 안 · 목록 밖 모두
const feed = { f1: { level: 0.44, observedAt: '2026-11-10T05:33:00Z' } };
const recWithOld = { ...rec, congestionEstimate: { level: 0.75 } } as unknown as RecommendationResponse;
assert.deepEqual(buildSelectedCandidate(home, 'recommended', [recWithOld], origin, feed).congestionEstimate, feed.f1);
assert.deepEqual(buildSelectedCandidate(home, 'pin', [], origin, feed).congestionEstimate, feed.f1);
assert.deepEqual(buildSelectedCandidate(home, 'recommended', [recWithOld], origin, {}).congestionEstimate, { level: 0.75 });

// 기준 명소 — 관광 근거의 이름 · 거리, 그 명소의 '지금' 등급(피드 추정 60분 안)
const now = new Date('2026-11-10T05:40:00Z');
const anchorFacility = { ...home, id: 'a1', name: '대릉원' } as HomeFacility;
const withTourism = { ...rec, breakdown: { areaDemandTourismEvidence: { referenceName: '대릉원', distanceM: 184 } } } as unknown as RecommendationResponse;
const anchor = compareAnchorFor(withTourism, [anchorFacility], { a1: { level: 0.3, source: 'estimated', observedAt: '2026-11-10T05:30:00Z' } }, now);
assert.equal(anchor?.name, '대릉원');
assert.equal(anchor?.distanceM, 184);
assert.equal(anchor?.level, 0.3);
assert.equal(compareAnchorFor(withTourism, [], {}, now)?.level, null, '명소 시설이 없으면 등급 없음');
assert.equal(compareAnchorFor(rec, [anchorFacility], {}, now), null, '관광 근거가 없으면 기준 명소 없음');
assert.equal(compareAnchorFor(null, [anchorFacility], {}, now), null);

// 추천 이유 — 비교 순위와 카드 순위가 같을 때만, 직접 고른 곳은 없음
const recOf = (id: string, preference: number, travelTime: number) =>
  ({ recommendationId: `r-${id}`, facility: { id, name: id, type: 'cafe', latitude: 0, longitude: 0 }, scoringMode: 'model', breakdown: { preference, travelTime, incentive: 0 } }) as unknown as RecommendationResponse;
const visible = [recOf('a', 0.6, 3), recOf('b', 0.4, 8), recOf('c', 0.5, 5)];
const comparisons = spotComparisonsById(visible);
assert.equal(comparisons.size, 3);
assert.equal(comparisonFor(comparisons, visible[1], visible)?.rank, 2);
assert.equal(comparisonFor(comparisons, { ...visible[1], userPicked: true }, visible), null);
assert.equal(comparisonFor(comparisons, visible[1], [visible[0], visible[2], visible[1]]), null, '순위가 어긋나면 넘기지 않는다');
assert.equal(comparisonFor(comparisons, null, visible), null);

// 카드 자리 상태 — 로딩(G3-25) · 오류(G3-26) · 0곳은 ready(제안 상자 G3-27)
const base = { hasFacilities: true, recsLoaded: false, recsFailed: false, hasSelection: false, searching: false };
assert.equal(cardStatus(base), 'loading');
assert.equal(cardStatus({ ...base, hasSelection: true }), 'ready');
assert.equal(cardStatus({ ...base, searching: true }), 'ready');
assert.equal(cardStatus({ ...base, hasFacilities: false }), 'ready');
assert.equal(cardStatus({ ...base, recsLoaded: true }), 'ready');
assert.equal(cardStatus({ ...base, recsLoaded: true, recsFailed: true }), 'error');
assert.equal(cardStatus({ ...base, recsLoaded: true, recsFailed: true, hasSelection: true }), 'ready');

console.log('sheetModel ok');
