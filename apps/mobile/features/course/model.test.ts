// features/course/model.ts · travelContext.ts 순수 로직 — 실행: tsx features/course/model.test.ts
import assert from 'node:assert/strict';

import {
  arrivalParts,
  buildPinList,
  buildRows,
  ganttLayout,
  hhmm,
  normalizePlan,
  parseCache,
  pinsToggled,
  pinsWithoutDuplicate,
  planSignature,
  rebuildSharedStops,
  requestedSlotIndex,
  sequenceAdded,
  sequenceMoved,
  serializeCache,
  slotKeysOf,
  slotKeysStale,
  slotReasonKey,
  walkMinutesOf,
} from './model';
import type { TravelContext } from '~/lib/core/travelContextTypes';
import { parseTravelContext, widenTimeBudget } from './travelContext';
import { MAX_SEQUENCE, type CourseStop, type SequenceItem, type SlotOutcome } from './types';

const stop = (id: string, order: number, offset = 10): CourseStop => ({
  order,
  facility: { id, name: id, type: 'cafe', latitude: 35.8, longitude: 129.2 },
  arrivalOffsetMin: offset,
  predictedCongestion: 0.3,
  spotScore: 0.5,
  reason: '',
});
const seq = (...types: string[]): SequenceItem[] => types.map((type, i) => ({ uid: `u${i}`, type }));

// 시간 표기 — 기준 시각에 오프셋을 더한 시계(로컬 시간대 기준이라 같은 함수로 기대값을 만든다)
{
  const base = new Date(2026, 0, 1, 12, 30).getTime();
  assert.equal(hhmm(0, base), '12:30');
  assert.equal(hhmm(45, base), '13:15');
  assert.equal(hhmm(30, null, base), '13:00');
  assert.deepEqual(arrivalParts(3), { key: 'course.arrivalNow' });
  assert.deepEqual(arrivalParts(11.6), { key: 'course.arrivalAfter', vars: { min: 12 } });
  assert.equal(walkMinutesOf(4.2), 5);
  assert.equal(walkMinutesOf(0), 1);
  assert.equal(walkMinutesOf(null), null);
}

// 자리 키 — 순서 모드는 uid, 자동 모드는 고정 3칸. 어긋나면 stale
{
  assert.deepEqual(slotKeysOf(seq('cafe', 'restaurant')), ['u0', 'u1']);
  assert.deepEqual(slotKeysOf([]), ['auto-0', 'auto-1', 'auto-2']);
  assert.equal(slotKeysStale(['u0', 'u1'], ['u0', 'u1']), false);
  assert.equal(slotKeysStale(['u0', 'u1'], ['u1', 'u0']), true);
  assert.equal(slotKeysStale(['u0'], ['u0', 'u1']), true);
}

// 고정 — 같은 가게는 한 자리에만, 모르는 키는 요청에서 빠진다
{
  const next = pinsWithoutDuplicate({ a: 'F1', b: 'F2' }, 'b', 'F1');
  assert.deepEqual(next, { b: 'F1' });
  assert.deepEqual(pinsToggled({ a: 'F1' }, 'a', 'F1'), {});
  assert.deepEqual(pinsToggled({}, 'a', 'F1'), { a: 'F1' });
  assert.deepEqual(buildPinList({ u1: 'F1', gone: 'F9' }, ['u0', 'u1']), [{ order: 2, facilityId: 'F1' }]);
}

// 자리 번호 복원 · 행 끼워 넣기 — 2번 자리가 빠지면 3번 자리 정류지는 stop.order 2 지만 자리는 3
{
  const outcomes: SlotOutcome[] = [
    { order: 1, requestedType: 'cafe', status: 'filled', facilityId: 'A', pinned: false },
    { order: 2, requestedType: 'restaurant', status: 'no_candidate_of_type', facilityId: null, pinned: false },
    { order: 3, requestedType: 'culture', status: 'filled', facilityId: 'C', pinned: false },
  ];
  const stops = [stop('A', 1), stop('C', 2)];
  assert.equal(requestedSlotIndex(stops[1], outcomes), 2);
  assert.equal(requestedSlotIndex(stops[1], []), 1); // 구 API — 같다고 본다
  const rows = buildRows(stops, outcomes);
  assert.deepEqual(rows.map((r) => (r.stop ? r.stop.facility.id : `slot${r.slotOrder}`)), ['A', 'slot2', 'C']);
  assert.equal(slotReasonKey(outcomes[1]), 'course.slotNoCandidate');
  assert.equal(slotReasonKey({ ...outcomes[1], requestedType: null }), 'course.slotNoCandidateAny');
  assert.equal(slotReasonKey({ ...outcomes[1], status: 'late_night_unconfirmed' }), 'course.slotLateNight');
}

// 순서 피커 — 상한, 이동(끌기·버튼 공통)
{
  assert.equal(sequenceAdded(seq('a', 'b', 'c'), { uid: 'x', type: 'cafe' }).length, MAX_SEQUENCE);
  assert.deepEqual(sequenceMoved(seq('a', 'b', 'c'), 0, 2).map((s) => s.type), ['b', 'c', 'a']);
  assert.deepEqual(sequenceMoved(seq('a', 'b', 'c'), 2, 1).map((s) => s.type), ['a', 'c', 'b']);
  assert.deepEqual(sequenceMoved(seq('a', 'b'), 0, -1).map((s) => s.type), ['a', 'b']);
  assert.deepEqual(sequenceMoved(seq('a', 'b'), 1, 5).map((s) => s.type), ['a', 'b']);
}

// 계획 정리 · 캐시
{
  assert.deepEqual(normalizePlan(null), { stops: [], slotOutcomes: [], planId: '' });
  assert.equal(normalizePlan({ stops: 'x', planId: 3 }).stops.length, 0);
  const sig = planSignature({ a: 1 }, [], [], []);
  const entry = { stops: [stop('A', 1)], slotOutcomes: [], renderedSlotKeys: ['auto-0'], planId: 'p', savedAt: 1000, contextSignature: sig };
  const raw = serializeCache(entry);
  assert.equal(parseCache(raw, sig, 2000)?.planId, 'p');
  assert.equal(parseCache(raw, planSignature({ a: 2 }, [], [], []), 2000), null); // 다른 조건
  assert.equal(parseCache(raw, sig, 1000 + 25 * 3600 * 1000), null); // 낡음
  assert.equal(parseCache(serializeCache({ ...entry, stops: [] }), sig, 2000), null); // 빈 계획
  assert.equal(parseCache('{broken', sig), null);
  assert.equal(parseCache(null, sig), null);
  // 가정 시각 — 다른 프리셋의 계획은 되살리지 않는다(없던 필드 = 'now')
  assert.equal(parseCache(raw, sig, 2000, 'sat_afternoon'), null);
  const satRaw = serializeCache({ ...entry, preset: 'sat_afternoon' });
  assert.equal(parseCache(satRaw, sig, 2000, 'sat_afternoon')?.preset, 'sat_afternoon');
  assert.equal(parseCache(satRaw, sig, 2000), null);
}

// 공유 복원 — 경과 보정·못 찾은 시설 제외·번호 재부여
{
  const rows = [{ id: 'A', name: 'a', type: 'cafe', latitude: 1, longitude: 2 }, { id: 'C', name: 'c', type: 'culture', latitude: 3, longitude: 4 }];
  const stops = rebuildSharedStops(
    [{ id: 'A', offsetMin: 20, congestion: 0.4 }, { id: 'B', offsetMin: 30, congestion: null }, { id: 'C', offsetMin: 50, congestion: null }],
    rows,
    30,
  );
  assert.deepEqual(stops.map((s) => [s.facility.id, s.order, s.arrivalOffsetMin]), [['A', 1, 0], ['C', 2, 20]]);
  assert.equal(stops[1].predictedCongestion, null);
}

// 간트 — 마지막 체류 45분, 최소 10분 폭, 전체 30분 이상
{
  const { segments, totalMin } = ganttLayout([stop('A', 1, 0), stop('B', 2, 30)]);
  assert.equal(totalMin, 75);
  assert.equal(segments[0].startPct, 0);
  assert.equal(Math.round(segments[0].widthPct), 40);
  assert.equal(Math.round(segments[1].startPct), 40);
  assert.equal(ganttLayout([stop('A', 1, 0)]).totalMin, 45);
}

// 여행 조건 — 시간 넓히기 사다리, 저장값 읽기
{
  const base: TravelContext = { categories: [], requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [] };
  assert.equal(widenTimeBudget({ ...base }), null);
  assert.equal(widenTimeBudget({ ...base, availableMinutes: 30 })?.availableMinutes, 60);
  assert.equal(widenTimeBudget({ ...base, availableMinutes: 60 })?.availableMinutes, 120);
  assert.equal('availableMinutes' in (widenTimeBudget({ ...base, availableMinutes: 120 }) ?? { availableMinutes: 1 }), false);
  assert.deepEqual(parseTravelContext(null).categories, []);
  assert.deepEqual(parseTravelContext('{oops').categories, []);
  const saved = parseTravelContext(JSON.stringify({ version: 2, categories: ['cafe'], requiredAttributes: [], excludeVisited: true, visitedFacilityIds: ['x'], maxWalkMinutes: 10 }));
  assert.deepEqual(saved.categories, ['cafe']);
  assert.equal(saved.maxWalkMinutes, 10);
  assert.deepEqual(saved.visitedFacilityIds, []);
}

console.log('features/course/model.test.ts OK');
