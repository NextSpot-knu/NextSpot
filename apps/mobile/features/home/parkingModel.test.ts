// 홈 주차장 탭 규칙 — 응답 매핑 · 선택 유지 · 잔여면 상자 조건 · 거리 글 · 핀 칠하기(웹 page.tsx 주차장 탭과 같은 규칙).
import assert from 'node:assert/strict';

import {
  keepParkingSelection,
  liveSpacesOf,
  mapParkingLots,
  parkingDistanceText,
  parkingPinMarkers,
  type ParkingLot,
} from './parkingModel';

const now = new Date('2026-11-11T05:00:00Z');
const lots = mapParkingLots({
  available: true,
  lots: [
    { id: 'p1', name: '황남 공영', latitude: '35.835', longitude: 129.21, distanceM: 312.2, totalSpaces: 120, availableSpaces: 30, occupancy: 0.75, live: true, observedAt: '2026-11-11T04:50:00Z', source: 'gyeongju_its' },
    { id: 'p2', name: '대릉원 공영', latitude: 35.836, longitude: 129.211, distanceM: 1234, totalSpaces: 80, availableSpaces: null, occupancy: null, live: false, observedAt: null, source: null },
    { id: '', name: '이름만', latitude: 1, longitude: 2 },
    { id: 'p3', name: '좌표 없음', latitude: 'x', longitude: 2 },
    null,
  ],
});

// 1) 매핑 — id·이름·좌표가 있는 것만, 숫자 문자열 좌표는 숫자로.
assert.deepEqual(lots.map((l) => l.id), ['p1', 'p2']);
assert.equal(lots[0].latitude, 35.835);
assert.equal(lots[1].availableSpaces, null);
assert.deepEqual(mapParkingLots(null), []);
assert.deepEqual(mapParkingLots({ lots: 'x' }), []);

// 2) 선택 — 같은 id 를 이어 가고, 없으면 첫 주차장, 빈 목록이면 null.
assert.equal(keepParkingSelection(null, lots)?.id, 'p1');
assert.equal(keepParkingSelection(lots[1], lots)?.id, 'p2');
assert.equal(keepParkingSelection({ ...lots[1], id: 'gone' }, lots)?.id, 'p1');
assert.equal(keepParkingSelection(lots[0], []), null);

// 3) 잔여면 상자 — 실시간이고 두 값이 다 있을 때만.
assert.deepEqual(liveSpacesOf(lots[0]), { available: 30, total: 120 });
assert.equal(liveSpacesOf(lots[1]), null);
assert.equal(liveSpacesOf({ ...lots[0], live: false }), null);

// 4) 거리 — 올림 + 천 단위 쉼표(웹 Math.ceil(...).toLocaleString() 의 ko·en 모양).
assert.equal(parkingDistanceText(312.2), '313');
assert.equal(parkingDistanceText(1234), '1,234');
assert.equal(parkingDistanceText(12345678.1), '12,345,679');
assert.equal(parkingDistanceText(Number.NaN), '0');

// 5) 핀 — 실시간 점유율만 칠하고(0.75 → 붐빔 기준 0.75 면 busy), 아니면 빈 핀. 선택은 크게 · 맨 위.
const clusters = lots.map((lot: ParkingLot) => ({ key: lot.id, anchor: lot, members: [lot] }));
const pins = parkingPinMarkers(clusters, { selectedId: 'p2', busyAt: 0.75, now });
assert.equal(pins[0].id, 'parking:p1');
assert.equal(pins[0].placeType, 'parking');
assert.equal(pins[0].pin.style, 'filled');
assert.equal(pins[0].pin.grade, 'busy');
assert.equal(pins[1].pin.style, 'hollow');
assert.equal(pins[1].selected, true);
assert.equal(pins[1].zIndex, 100);
const stale = parkingPinMarkers(clusters, { selectedId: null, busyAt: 0.75, now: new Date('2026-11-13T05:00:00Z') });
assert.equal(stale[0].pin.style, 'hollow', '24시간 넘은 실측은 칠하지 않는다');
const forecasting = parkingPinMarkers(clusters, { selectedId: null, busyAt: 0.75, now, forecastMode: true });
assert.equal(forecasting[0].pin.style, 'hollow', '예측 중에는 주차장 핀에 예측 값이 없다(웹과 같다)');

console.log('parkingModel ok');
