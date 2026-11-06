// 여행 임팩트 응답 읽기(P0-5 b) — 근거 없는 0 을 지어내지 않고, 셀 수 없는 값은 화면에 올리지 않는다.
import assert from 'node:assert/strict';
import { readImpactSummary } from './impactSummary';

// 실제 기록 — 숫자는 정수로, 도착 확인은 서버가 센 그대로.
const real = readImpactSummary({
  accepted: 3, arrivalsConfirmed: 1, congestionAvoided: 1, couponsIssued: 2, couponsUsed: 1, waitSavedMinutes: 12.6,
});
assert.deepEqual(real, {
  accepted: 3, arrivalsConfirmed: 1, congestionAvoided: 1, couponsIssued: 2, couponsUsed: 1, waitSavedMinutes: 13, hasRecord: true,
});

// 도착 확인을 서버가 세지 못했으면(null) · 구 서버라 키가 없으면 null — 0 으로 말하지 않는다.
assert.equal(readImpactSummary({ accepted: 2, arrivalsConfirmed: null }).arrivalsConfirmed, null);
assert.equal(readImpactSummary({ accepted: 2 }).arrivalsConfirmed, null);
// 실제로 센 0 은 0 이다.
assert.equal(readImpactSummary({ accepted: 2, arrivalsConfirmed: 0 }).arrivalsConfirmed, 0);

// 신규 사용자(전부 0)·빈 응답·이상한 모양은 기록이 없다 — 시작 상태.
assert.equal(readImpactSummary({ accepted: 0, arrivalsConfirmed: 0, couponsIssued: 0, waitSavedMinutes: 0 }).hasRecord, false);
assert.equal(readImpactSummary(null).hasRecord, false);
assert.equal(readImpactSummary('oops').hasRecord, false);
const weird = readImpactSummary({ accepted: -4, waitSavedMinutes: 'NaN', couponsIssued: Number.POSITIVE_INFINITY });
assert.equal(weird.accepted, 0);
assert.equal(weird.waitSavedMinutes, 0);
assert.equal(weird.couponsIssued, 0);
assert.equal(weird.hasRecord, false);

// 출발 없이 도착만 있어도(예전 /main 경로 — 도착은 노출 행에, 수락은 새 행에 붙었다) 기록이다.
assert.equal(readImpactSummary({ accepted: 0, arrivalsConfirmed: 1 }).hasRecord, true);

console.log('impactSummary tests passed');
