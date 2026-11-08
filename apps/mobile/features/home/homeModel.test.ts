import assert from 'node:assert/strict';

import { groupSameBuilding } from '../map/declutter';
import {
  applyConvenience,
  buildInsteadHref,
  buildPinMarkers,
  calmSpots,
  canSeeInstead,
  estimatesFromFeed,
  festivalFocus,
  freshEstimate,
  isAreaLevelAddress,
  mapInfrastructure,
  mapInfrastructures,
  matchesCuisineChip,
  NO_CONVENIENCE,
  keyboardCoverFor,
  orderForPins,
  pickTripOverlay,
  tripScrollMaxHeight,
  TRIP_CARD_HEIGHT,
  tripOverlayRoom,
  resolveUserLocation,
  selectByCategoryOrSearch,
  shouldAskExternal,
  walkingMinutes,
  CUISINE_CHIPS,
  type HomeFacility,
} from './homeModel';

const now = new Date('2026-11-02T03:00:00Z');
const iso = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();

function fac(partial: Partial<HomeFacility> & { id: string }): HomeFacility {
  return {
    name: partial.id, type: 'restaurant', latitude: 35.8362, longitude: 129.2095, capacity: 10, features: null,
    address: null, phone: null, operatingHours: null, imageUrl: null, galleryImages: null, homepage: null,
    overview: null, barrierFree: null, contentid: null, contenttypeid: null, availabilityEvidence: null,
    congestionLevel: null, currentCount: null, lastUpdated: null, source: null, isStale: false,
    ...partial,
  };
}

// 매핑 — 좌표 없는 항목은 버리고, 혼잡 로그 없으면 null.
assert.equal(mapInfrastructure({ id: 'a', name: 'A', type: 'cafe', latitude: 1, longitude: 2 })?.congestionLevel, null);
assert.equal(mapInfrastructure({ id: 'a', latitude: 'x', longitude: 2 }), null);
assert.equal(mapInfrastructure(null), null);
const mapped = mapInfrastructure({
  id: 'b', name: 'B', type: 'restaurant', latitude: 35.83, longitude: 129.2,
  congestion: { level: 0.2, timestamp: iso(5), source: 'user_report', isStale: false, isCurrent: false },
});
assert.equal(mapped?.congestionLevel, 0.2);
assert.equal(mapped?.congestionIsCurrent, false);
assert.equal(mapInfrastructures([{ id: 'a', latitude: 1, longitude: 2 }, { latitude: 1 }]).length, 1);
assert.throws(() => mapInfrastructures({}));

// 추정 — 60분 넘으면 버린다.
assert.deepEqual(estimatesFromFeed({ available: false, estimates: { a: 1 } }), {});
assert.deepEqual(estimatesFromFeed([]), {});
assert.deepEqual(estimatesFromFeed({ available: true, estimates: { a: 1 } }), { a: 1 });
assert.ok(freshEstimate({ source: 'estimated', level: 0.4, observedAt: iso(30) }, now));
assert.equal(freshEstimate({ source: 'estimated', level: 0.4, observedAt: iso(61) }, now), null);
assert.equal(freshEstimate({ source: 'measured', level: 0.4, observedAt: iso(1) }, now), null);
assert.equal(freshEstimate({ source: 'estimated', level: 1.4, observedAt: iso(1) }, now), null);

// 편의 필터 — AND.
const list = [
  fac({ id: '1', barrierFree: true, features: { stroller: true } }),
  fac({ id: '2', barrierFree: true }),
  fac({ id: '3', features: { parking: '가능', chk_pet: '가능' } }),
];
assert.equal(applyConvenience(list, NO_CONVENIENCE).length, 3);
assert.deepEqual(applyConvenience(list, { ...NO_CONVENIENCE, accessible: true }).map((f) => f.id), ['1', '2']);
assert.deepEqual(applyConvenience(list, { ...NO_CONVENIENCE, accessible: true, stroller: true }).map((f) => f.id), ['1']);
assert.deepEqual(applyConvenience(list, { ...NO_CONVENIENCE, parking: true, pet: true }).map((f) => f.id), ['3']);

// 카테고리 · 검색.
const mixed = [fac({ id: 'r', name: '황남빵', type: 'cafe' }), fac({ id: 'q', name: '국밥집', type: 'restaurant' })];
assert.deepEqual(selectByCategoryOrSearch(mixed, 'cafe', '').map((f) => f.id), ['r']);
assert.deepEqual(selectByCategoryOrSearch(mixed, 'cafe', '국밥').map((f) => f.id), ['q']);

// 음식 칩 — 태그 · 상호 · 술집 제외.
const chip = (id: string) => CUISINE_CHIPS.find((c) => c.id === id)!;
assert.ok(matchesCuisineChip(fac({ id: 'g', features: { cuisine_tags: ['국밥'] } }), chip('gukbap')));
assert.ok(matchesCuisineChip(fac({ id: 'g2', name: '윤쉐프의고기집' }), chip('meat')));
assert.ok(!matchesCuisineChip(fac({ id: 'g3', name: '한우국밥' }), chip('meat')));
assert.ok(!matchesCuisineChip(fac({ id: 'g5', name: '치킨호프', features: { cuisine_tags: ['호프'] } }), chip('chicken')));
assert.ok(!matchesCuisineChip(fac({ id: 'c', type: 'cafe', name: '국밥' }), chip('gukbap')));

// 외부 검색 — 두 글자부터, 로컬 결과가 있으면 묻지 않는다.
assert.equal(shouldAskExternal('황', 0), false);
assert.equal(shouldAskExternal(' 황남 ', 0), true);
assert.equal(shouldAskExternal('황남', 2), false);

// 걷는 시간 — 올림, 최소 1분.
assert.equal(walkingMinutes(0), 1);
assert.equal(walkingMinutes(500), Math.ceil((500 * 1.18) / 66.67));
assert.equal(walkingMinutes(Number.NaN), 1);

// 순서 — 순위 먼저, 그다음 가까운 순.
const near = fac({ id: 'near', latitude: 35.8362, longitude: 129.2095 });
const far = fac({ id: 'far', latitude: 35.845, longitude: 129.23 });
const ranked = fac({ id: 'ranked', latitude: 35.848, longitude: 129.235 });
assert.deepEqual(
  orderForPins([far, near, ranked], new Map([['ranked', 1]]), { lat: 35.8362, lng: 129.2095 }).map((f) => f.id),
  ['ranked', 'near', 'far'],
);

// 핀 — 묶음은 가장 붐비는 24시간 안 실측 + 최소 순위, 선택은 묶음 키로.
const a = fac({ id: 'a', address: '경북 경주시 황남동 123-4', congestionLevel: 0.2, lastUpdated: iso(10), source: 'user_report' });
const b = fac({ id: 'b', address: '경북 경주시 황남동 123-4', congestionLevel: 0.9, lastUpdated: iso(10), source: 'user_report' });
const clusters = groupSameBuilding([a, b, far]);
assert.equal(clusters.length, 2);
const group = clusters.find((c) => c.members.length === 2)!;
assert.ok(group, '같은 건물은 한 묶음');
const markers = buildPinMarkers(clusters, {
  rankById: new Map([['b', 2], ['a', 4]]), selectedId: null, activeGroupId: group.key, busyAt: 0.75, now,
  groupName: (n) => `building ${n}`,
});
const groupMarker = markers.find((m) => m.id === group.key)!;
assert.equal(groupMarker.pin.rank, 2);
assert.equal(groupMarker.pin.grade, 'busy');
assert.equal(groupMarker.selected, true);
assert.equal(groupMarker.title, 'building 2');
assert.deepEqual(groupMarker.groupIds?.sort(), ['a', 'b']);
const stale = buildPinMarkers([{ key: 'x', anchor: fac({ id: 'x', congestionLevel: 0.2, lastUpdated: iso(60 * 30) }), members: [fac({ id: 'x' })] }], {
  rankById: new Map(), selectedId: 'x', activeGroupId: null, busyAt: 0.75, now, groupName: String,
});
assert.equal(stale[0].pin.style, 'hollow', '24시간 넘은 관측은 칠하지 않는다');
assert.equal(stale[0].selected, true);

// 지금 한산.
const calm = calmSpots(
  [
    fac({ id: 'q1', congestionLevel: 0.1 }),
    fac({ id: 'q2', congestionLevel: 0.28 }),
    fac({ id: 'q3', congestionLevel: 0.05, congestionIsCurrent: false }),
    fac({ id: 'q4', congestionLevel: 0.5 }),
    fac({ id: 'q5', congestionLevel: null }),
    fac({ id: 'q6', type: 'cafe', congestionLevel: 0.2 }),
  ],
  { lat: 35.8362, lng: 129.2095 },
  ['cafe'],
);
assert.deepEqual(calm.map((c) => c.id), ['q6', 'q1', 'q2']);

// 축제.
assert.equal(isAreaLevelAddress('경상북도 경주시 황남동'), true);
assert.equal(isAreaLevelAddress('경상북도 경주시 첨성로 169'), false);
assert.equal(isAreaLevelAddress('경주시 보문단지 일원'), true);
assert.equal(isAreaLevelAddress(null), false);
const area = festivalFocus({ contentId: '1', title: 'T', latitude: 35.8, longitude: 129.2, address: '경주시 황남동', isOngoing: true }, 'A', 'P')!;
assert.equal(area.circles[0].radiusM, 600);
assert.equal(area.circles[0].dashed, true);
assert.equal(area.markers.length, 1);
const point = festivalFocus({ contentId: '2', title: 'T', latitude: 35.8, longitude: 129.2, address: '경주시 첨성로 169' }, 'A', 'P')!;
assert.equal(point.circles.length, 0);
assert.equal(point.markers.length, 2);
assert.equal(festivalFocus({ contentId: '3', title: 'T' }, 'A', 'P'), null);

// 대신 갈 곳 — 웹 buildRecommendHref(from=pick).
assert.equal(canSeeInstead('parking'), false);
assert.equal(canSeeInstead('cafe'), true);
assert.equal(
  buildInsteadHref({ facilityId: 'f1', type: 'cafe', latitude: 35.1, longitude: 129.1 }, { lat: 35.8, lng: 129.2 }),
  '/explore/recommend?facilityId=f1&lat=35.8&lng=129.2&type=cafe&from=pick',
);
assert.equal(
  buildInsteadHref({ name: 'X 카페', type: 'cafe', latitude: 35.1, longitude: 129.1 }, null),
  '/explore/recommend?name=X+%EC%B9%B4%ED%8E%98&lat=35.1&lng=129.1&type=cafe&from=pick&walk=place',
);
assert.equal(
  buildInsteadHref({ type: 'cafe' }, null),
  '/explore/recommend?lat=35.8362&lng=129.2095&type=cafe&from=pick',
);

// 위치 — 경주 안·밖·부정확.
const inside = resolveUserLocation({ latitude: 35.835, longitude: 129.21, accuracy: 30 });
assert.deepEqual(inside, { location: { lat: 35.835, lng: 129.21 }, known: true, notice: null });
const outside = resolveUserLocation({ latitude: 37.5665, longitude: 126.978, accuracy: 20 });
assert.deepEqual(outside, { location: { lat: 35.8362, lng: 129.2095 }, known: false, notice: 'outOfRegion' });
const coarse = resolveUserLocation({ latitude: 35.835, longitude: 129.21, accuracy: 4000 });
assert.equal(coarse.known, false);
assert.equal(coarse.notice, 'coarse');
assert.equal(coarse.location.lat, 35.8362);
assert.equal(resolveUserLocation({ latitude: Number.NaN, longitude: 1 }).known, false);
assert.equal(resolveUserLocation({ latitude: 35.835, longitude: 129.21 }).known, true, '정확도를 모르면 내 위치로 본다');

console.log('homeModel ok');

// ── 여정 카드: 한 번에 하나, 방문 확인이 먼저, 자리가 없으면 감추기만(떼지 않는다) ──
{
  const roomy = { searching: false, room: 400 };
  assert.deepEqual(pickTripOverlay({ visitActive: true, journeyActive: true, ...roomy }), { card: 'visit', hidden: false });
  assert.deepEqual(pickTripOverlay({ visitActive: false, journeyActive: true, ...roomy }), { card: 'journey', hidden: false });
  assert.deepEqual(pickTripOverlay({ visitActive: true, journeyActive: false, ...roomy }), { card: 'visit', hidden: false });
  assert.deepEqual(pickTripOverlay({ visitActive: false, journeyActive: false, ...roomy }), { card: null, hidden: true });
  // 검색 판이 위를 쓰는 동안은 감춘다 — 고른 카드는 그대로(붙여 둔 채)
  assert.deepEqual(pickTripOverlay({ visitActive: true, journeyActive: true, searching: true, room: 400 }), { card: 'visit', hidden: true });
  // 접은 판이 없다 — 남은 높이가 줄어도 판은 같고(스크롤), 이름 + 첫 행동 줄이 들어갈 자리가 없을 때만 감춘다
  assert.equal(pickTripOverlay({ visitActive: true, journeyActive: false, searching: false, room: TRIP_CARD_HEIGHT.visit }).hidden, false);
  assert.equal(pickTripOverlay({ visitActive: true, journeyActive: false, searching: false, room: TRIP_CARD_HEIGHT.visit - 1 }).hidden, true);
  assert.equal(pickTripOverlay({ visitActive: false, journeyActive: true, searching: false, room: TRIP_CARD_HEIGHT.journey }).hidden, false);
  assert.equal(pickTripOverlay({ visitActive: false, journeyActive: true, searching: false, room: TRIP_CARD_HEIGHT.journey - 1 }).hidden, true);
  assert.equal(pickTripOverlay({ visitActive: false, journeyActive: true, searching: false, room: Number.NaN }).hidden, true);
  assert.ok(!('compact' in pickTripOverlay({ visitActive: true, journeyActive: false, ...roomy })), '판 모양을 고르지 않는다');
  // 짧은 화면(360x780dp, 시트 기본 높이에서 남은 자리 약 83dp)에서도 사라지지 않게 최소 높이를 크게 잡지 않는다
  assert.ok(TRIP_CARD_HEIGHT.journey <= 82 && TRIP_CARD_HEIGHT.visit <= 82);
  const typing = { visitActive: false, journeyActive: true, searching: false, typing: true } as const;
  // 상황 변경 입력에 쓰는 동안은 키보드 가림만 무시한다(감춤 → 키보드 닫힘 고리 방지)
  assert.equal(pickTripOverlay({ ...typing, room: 10, roomWithoutKeyboard: 200 }).hidden, false);
  // 시트를 펼침으로 올려 시트가 가리면 쓰는 중이어도 감춘다(보이지 않는 칸에 쓰지 않게)
  assert.equal(pickTripOverlay({ ...typing, room: 10, roomWithoutKeyboard: 20 }).hidden, true);
  // 쓰는 중이 아니면 키보드 포함 자리로 판단, 검색 판은 늘 감춘다
  assert.equal(pickTripOverlay({ ...typing, typing: false, room: 10, roomWithoutKeyboard: 200 }).hidden, true);
  assert.equal(pickTripOverlay({ ...typing, searching: true, room: 400, roomWithoutKeyboard: 400 }).hidden, true);
  // 스크롤 높이: 쓰는 중이면 최소 높이만큼 남기되 시트가 가린 선은 넘지 않는다
  assert.equal(tripScrollMaxHeight(10, 200, 'journey', true), TRIP_CARD_HEIGHT.journey);
  assert.equal(tripScrollMaxHeight(10, 60, 'journey', true), 60);
  assert.equal(tripScrollMaxHeight(10, 200, 'journey', false), 10);
  assert.equal(tripScrollMaxHeight(300, 300, 'journey', true), 300);
  assert.equal(tripScrollMaxHeight(Number.NaN, Number.NaN, 'visit', false), 0);
  // 남은 높이: 컨테이너 − 위 − 아래 − 8
  assert.equal(tripOverlayRoom(800, 200, 300), 292);
  assert.equal(tripOverlayRoom(800, 500, 400), 0);
  assert.equal(tripOverlayRoom(0, 100, 100), 0);
}

// 키보드가 가린 두께 — 안드로이드 15 edge-to-edge(창 = 화면) · 14 이하(창 = 화면 − 막대) 가 같은 값, 분할 창은 창 기준
{
  // 화면 915 · 막대 48 · 키보드 300(막대 뺀 값) → 키보드 위쪽 = 915 − 300 − 48 = 567. 루트 0..833 → 266
  const base = { rootY: 0, rootH: 833, screenH: 915, keyboardH: 300, navBar: 48 };
  assert.equal(keyboardCoverFor({ ...base, windowH: 915 }), 266);
  assert.equal(keyboardCoverFor({ ...base, windowH: 867 }), 266);
  // 폴드 분할 화면 — 창 450, 루트 0..400, 키보드 200 → 창 기준 250 위쪽 → 150
  assert.equal(keyboardCoverFor({ rootY: 0, rootH: 400, windowH: 450, screenH: 915, keyboardH: 200, navBar: 48 }), 150);
  // 루트 높이를 넘지 않고, 음수가 없다
  assert.equal(keyboardCoverFor({ rootY: 0, rootH: 100, windowH: 450, screenH: 915, keyboardH: 460, navBar: 0 }), 100);
  assert.equal(keyboardCoverFor({ ...base, windowH: 915, rootH: 300 }), 0);
  assert.equal(keyboardCoverFor({ ...base, windowH: 915, keyboardH: 0 }), 0);
  // iOS — 막대 0, 창 = 화면
  assert.equal(keyboardCoverFor({ rootY: 0, rootH: 760, windowH: 844, screenH: 844, keyboardH: 336, navBar: 0 }), 252);
}
