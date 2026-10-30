// 추천 고리 지표 읽기 — 새 서버 키 우선 · 옛 서버 폴백 · 표본 하한(P0-3 · P1-1).
//
// 잡으려는 결함:
//   · 옛 서버의 relocations(= 수락 행 수)를 '재배치' 로 그린다.
//   · 옛 원본 행으로 센 수락률을 '결정 기준' 처럼 적는다.
//   · 결정 0건에서 0% 를, 결정 1~2건으로 하루 0%·100% 를 그린다.
import assert from 'node:assert/strict';
import {
  MIN_RATE_SAMPLES,
  acceptanceSampleLine,
  dailyAcceptShare,
  hasEnoughSamples,
  insufficientSampleLabel,
  periodAcceptance,
  readAcceptance,
  readActiveUsers,
  readImpact,
  waitDiffBasisLine,
} from './adminLoopMetrics';

const WINDOW = { start: '2026-10-25T15:00:00.000Z', end: '2026-10-31T14:59:59.999Z' };

// ── 표본 하한 ─────────────────────────────────────────────────────────────────
assert.equal(MIN_RATE_SAMPLES, 5);
assert.equal(hasEnoughSamples(4), false);
assert.equal(hasEnoughSamples(5), true);
assert.equal(hasEnoughSamples(null), false);
assert.equal(hasEnoughSamples(Number.NaN), false);
assert.equal(insufficientSampleLabel(3), '표본 부족 · 3건 / 필요 5건');
assert.equal(insufficientSampleLabel(0, 3, '일'), '표본 부족 · 0일 / 필요 3일');

// ── 수락률: 새 키 ─────────────────────────────────────────────────────────────
{
  const v = readAcceptance({ acceptance: { accepted: 3, rejected: 9, decisions: 12, rate: 0.25 } }, WINDOW);
  assert.deepEqual(v, { accepted: 3, rejected: 9, total: 12, rate: 0.25, basis: 'decisions' });
  assert.equal(acceptanceSampleLine(v!), '결정 12건 중 3건 수락(거절 9건)');
  const none = readAcceptance({ acceptance: { accepted: 0, rejected: 0, decisions: 0, rate: null } }, WINDOW);
  assert.equal(none!.rate, null, '결정 0건에서 0% 를 지어냈다');
  // 새 키가 있으면 옛 행은 보지 않는다(두 기준을 섞지 않는다).
  const mixed = readAcceptance({
    acceptance: { accepted: 1, rejected: 1, decisions: 2 },
    recommendations: [{ accepted: true, created_at: '2026-10-30T00:00:00Z' }],
  }, WINDOW);
  assert.equal(mixed!.basis, 'decisions');
  assert.equal(mixed!.total, 2);
}

// ── 수락률: 옛 서버 폴백 — 창으로 자르고 '추천 n건' 기준이라고 말한다 ───────────────
{
  const v = readAcceptance({
    recommendations: [
      { accepted: true, created_at: '2026-10-30T01:00:00+00:00' },
      { accepted: false, created_at: '2026-10-30T02:00:00+00:00' },
      { accepted: true, created_at: '2026-10-20T02:00:00+00:00' }, // 창 밖
      null,
    ],
  }, WINDOW);
  assert.deepEqual(v, { accepted: 1, rejected: null, total: 2, rate: 0.5, basis: 'shown' });
  assert.equal(acceptanceSampleLine(v!), '추천 2건 중 1건 수락');
  assert.equal(readAcceptance({}, WINDOW), null, '모양이 다른 응답을 0건으로 읽었다');
  assert.equal(readAcceptance(null, WINDOW), null);
}

// ── 오늘 이용자 ────────────────────────────────────────────────────────────────
{
  assert.deepEqual(readActiveUsers({ active_users: { users: 2, events: 7 } }, WINDOW), { users: 2, events: 7, basis: 'server' });
  const legacy = readActiveUsers({
    feedback: [
      { user_id: 'u1', timestamp: '2026-10-31T01:00:00Z' },
      { user_id: 'u1', timestamp: '2026-10-31T02:00:00Z' },
      { user_id: 'u2', timestamp: '2026-10-31T03:00:00Z' },
      { user_id: 'u3', timestamp: '2026-10-01T03:00:00Z' }, // 창 밖
    ],
  }, WINDOW);
  assert.deepEqual(legacy, { users: 2, events: 3, basis: 'rows' });
  assert.equal(readActiveUsers({ nope: 1 }, WINDOW), null);
}

// ── 추천 수락 결과: 새 키만 재배치로 읽는다 ─────────────────────────────────────
{
  const res = {
    relocations: 2, saved_wait_minutes: 21, measured: 1, estimated: 1, truncated: false,
    accepted_total: 9, accepted_moves_unconfirmed: 4, accepted_same_facility: 3, accepted_missing_facility: 0,
    expected_wait_diff_minutes: 21, expected_wait_diff_basis: { wait_model: 1, congestion_gap: 1, unavailable: 0 },
    excluded_internal: 2,
  };
  const v = readImpact(res)!;
  assert.equal(v.relocations, 2);
  assert.equal(v.acceptedTotal, 9);
  assert.equal(v.movesUnconfirmed, 4);
  assert.equal(v.sameFacility, 3);
  assert.equal(v.waitDiffMinutes, 21);
  assert.equal(waitDiffBasisLine(v), '대기 예측식 1건 · 혼잡 차이×15분 근사 1건');
  // 옛 서버: relocations 는 수락 행 수였다 — 재배치로 그리지 않는다.
  assert.equal(readImpact({ relocations: 179, saved_wait_minutes: 900, measured: 0, estimated: 179 }), null);
  assert.equal(readImpact({}), null);
  assert.equal(readImpact({ ...res, accepted_total: 'x' }), null);
}

// ── 30일 추이: 하루 수락률은 결정 5건부터 ────────────────────────────────────────
{
  assert.equal(dailyAcceptShare({ decisions: 4, accepted: 4, rejected: 0 }), null, '결정 4건으로 100% 를 그렸다');
  assert.equal(dailyAcceptShare({ decisions: 5, accepted: 2, rejected: 3 }), 0.4);
  // 옛 서버(새 키 없음) — 노출 행 기준, 같은 하한.
  assert.equal(dailyAcceptShare({ rec_total: 10, rec_accepted: 1 }), 0.1);
  assert.equal(dailyAcceptShare({ rec_total: 2, rec_accepted: 1 }), null);
  assert.equal(dailyAcceptShare({}), null);

  const period = periodAcceptance([
    { rec_total: 30, rec_accepted: 2, decisions: 6, accepted: 2, rejected: 4 },
    { rec_total: 10, rec_accepted: 1, decisions: 2, accepted: 1, rejected: 1 },
  ]);
  assert.deepEqual(period, { accepted: 3, rejected: 5, total: 8, rate: 3 / 8, basis: 'decisions' });
  // 하루라도 새 키가 없으면(옛 서버) 통째로 옛 기준 — 두 기준을 한 합계에 섞지 않는다.
  const legacy = periodAcceptance([{ rec_total: 30, rec_accepted: 2 }, { rec_total: 10, rec_accepted: 1, decisions: 2, accepted: 1, rejected: 1 }]);
  assert.equal(legacy.basis, 'shown');
  assert.equal(legacy.total, 40);
  assert.equal(periodAcceptance([]).rate, null);
}

console.log('adminLoopMetrics tests passed');
