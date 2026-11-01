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
  nextVisitStage,
  ratedOutcomeFields,
  recordActiveTrip,
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

console.log('tripLoop.test OK');
