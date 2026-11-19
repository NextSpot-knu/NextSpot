import assert from 'node:assert/strict';

import {
  DUE_AFTER_MS,
  clearActiveTrip,
  completeVisit,
  dismissVisitCheck,
  getActiveTrip,
  getDueVisit,
  getPendingVisit,
  getVisitHistory,
  isGuestAccount,
  isVisitCheckDue,
  localReportLevel,
  markTripArrived,
  markTripArrivedIf,
  nextVisitStage,
  ratedOutcomeFields,
  recordActiveTrip,
  tripEvents,
  visitSteps,
  type KeyValueStore,
} from './tripLoop';

function memory(): KeyValueStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}
const fac = { id: 'f1', name: '우직', type: 'restaurant', latitude: 35.8, longitude: 129.2 };

// 30분 경계
assert.equal(isVisitCheckDue(0, 'navigating', DUE_AFTER_MS - 1), false);
assert.equal(isVisitCheckDue(0, 'navigating', DUE_AFTER_MS), true);
assert.equal(isVisitCheckDue(0, 'arrived', 1), true);

// 수락 → 여정 + 대기 방문, 30분 전엔 묻지 않는다
const s = memory();
recordActiveTrip(fac, { recommendationId: 'r1', walkMinutes: 3, navigationMode: 'car' }, 1000, s);
assert.equal(getPendingVisit(s)?.facilityId, 'f1');
assert.equal(getActiveTrip(s)?.navigationMode, 'car');
assert.equal(getActiveTrip(s)?.status, 'navigating');
assert.equal(getDueVisit(1000 + DUE_AFTER_MS - 1, s), null);
assert.equal(getDueVisit(1000 + DUE_AFTER_MS, s)?.recommendationId, 'r1');

// 도착을 누르면 바로 묻는다
markTripArrived(s);
assert.equal(getActiveTrip(s)?.status, 'arrived');
assert.equal(getDueVisit(1001, s)?.facilityId, 'f1');

// 완료 — 이력 적립 + 두 키 정리
completeVisit({ facilityId: 'f1', name: '우직', type: 'restaurant', rating: 'up' }, 5000, s);
assert.deepEqual(getVisitHistory(s).map((h) => [h.facilityId, h.rating, h.visitedAt]), [['f1', 'up', 5000]]);
assert.equal(getPendingVisit(s), null);
assert.equal(getActiveTrip(s), null);

// dismiss 는 두 키를 함께 지운다(한쪽만이면 legacy 이행이 여정을 되살린다)
const d = memory();
recordActiveTrip(fac, {}, 1, d);
clearActiveTrip(d);
assert.equal(getActiveTrip(d)?.facilityId, 'f1', 'pending 만 남으면 옛 값 이행으로 되살아난다');
dismissVisitCheck(d);
assert.equal(getActiveTrip(d), null);
assert.equal(getPendingVisit(d), null);

// 손상된 값은 null
const bad = memory();
bad.setItem('nextspot_pending_visit', '{oops');
bad.setItem('nextspot_active_trip', 'x');
assert.equal(getPendingVisit(bad), null);
assert.equal(getActiveTrip(bad), null);
assert.deepEqual(getVisitHistory(bad), []);

// 방문 확인 단계 기계
assert.deepEqual(visitSteps(true), ['ask', 'congestion', 'feedback']);
assert.deepEqual(visitSteps(false), ['ask', 'feedback']);
assert.equal(nextVisitStage('ask', 'confirm', true), 'congestion');
assert.equal(nextVisitStage('ask', 'confirm', false), 'feedback');
assert.equal(nextVisitStage('congestion', 'pick_congestion', true), 'feedback');
assert.equal(nextVisitStage('congestion', 'skip_congestion', true), 'feedback');
assert.equal(nextVisitStage('feedback', 'rate', true), 'completed');
assert.equal(nextVisitStage('ask', 'rate', true), 'ask', '순서를 건너뛰지 않는다');
assert.equal(nextVisitStage('completed', 'confirm', true), 'completed');

// 결과 보고 필드
assert.deepEqual(ratedOutcomeFields('up', 'quiet', true), { rating: 'up', observedCongestion: 'quiet' });
assert.deepEqual(ratedOutcomeFields('down', null, true), { rating: 'down' });
assert.deepEqual(ratedOutcomeFields('down', 'busy', false), { rating: 'down' });

// 게스트 판정
assert.equal(isGuestAccount(null), true);
assert.equal(isGuestAccount({ isAnonymous: true }), true);
assert.equal(isGuestAccount({ isAnonymous: false }), false);

assert.equal(localReportLevel('한산'), 0.2);
assert.equal(localReportLevel('보통'), 0.5);
assert.equal(localReportLevel('혼잡'), 0.8);

// 30분 뒤 방문 확인으로 끝까지 마친 여정 — 지워졌다고 알리고, 남아 있던 진행 카드의 '도착했어요'는 아무것도 바꾸지 않는다
{
  const st = memory();
  recordActiveTrip(fac, { recommendationId: 'r9' }, 5000, st);
  const shown = getActiveTrip(st)!;
  assert.ok(getDueVisit(5000 + DUE_AFTER_MS, st), '30분 뒤 방문 확인');
  let cleared = 0;
  const off = tripEvents.on('trip-cleared', () => { cleared += 1; });
  completeVisit({ facilityId: 'f1', name: '우직', type: 'restaurant', rating: 'up' }, 5000 + DUE_AFTER_MS + 1, st);
  off();
  assert.equal(cleared, 1, 'completeVisit 은 trip-cleared 를 알린다');
  assert.equal(getActiveTrip(st), null);
  assert.equal(markTripArrivedIf({ facilityId: shown.facilityId, acceptedAt: shown.acceptedAt }, st), null);
  assert.equal(getActiveTrip(st), null, '지워진 여정을 되살리지 않는다');
  // 같은 장소를 다시 수락한 새 여정이면 옛 카드의 도착은 새 여정을 건드리지 않는다
  recordActiveTrip(fac, {}, 9000, st);
  assert.equal(markTripArrivedIf({ facilityId: shown.facilityId, acceptedAt: shown.acceptedAt }, st), null);
  assert.equal(getActiveTrip(st)?.status, 'navigating');
  // 지금 여정이면 도착으로
  assert.equal(markTripArrivedIf({ facilityId: 'f1', acceptedAt: 9000 }, st)?.status, 'arrived');
  assert.equal(markTripArrivedIf({ facilityId: 'f1', acceptedAt: 9000 }, st), null, '이미 도착이면 두 번 바꾸지 않는다');
}

console.log('tripLoop.test OK');
