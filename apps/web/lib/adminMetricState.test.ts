import { strict as assert } from 'node:assert';
import {
  chunk,
  changeBadge,
  congestionMetric,
  facilityCongestionFrom,
  facilityStatusKey,
  facilityStatusLabel,
  metricsMetric,
  observedLevel,
  staleObservationLine,
  type CongestionSlice,
  type MetricsSlice,
} from './adminMetricState';

// ── congestionMetric: 로딩 / 실패 / 표본 없음 / 실측 0 이 서로 다른 상태여야 한다 ──
const pickAvg = (s: CongestionSlice) => s.avgCongestion ?? null;
const pickAnomaly = (s: CongestionSlice) => s.anomalyCount ?? null;

assert.deepEqual(congestionMetric(null, pickAvg), { status: 'loading' });
assert.deepEqual(congestionMetric({ failed: true }, pickAvg), { status: 'failed' });
// 서버가 표본 부족으로 내려보내는 shape(hasLogs=false + 전부 null)
assert.deepEqual(
  congestionMetric({ hasLogs: false, avgCongestion: null, anomalyCount: null }, pickAvg),
  { status: 'empty' },
);
assert.deepEqual(
  congestionMetric({ hasLogs: true, avgCongestion: { value: 0.42, changePercent: -3.1 } }, pickAvg),
  { status: 'ok', value: { value: 0.42, changePercent: -3.1 } },
);
// 실측 0 은 '표본 없음' 이 아니라 정상값이다.
assert.deepEqual(
  congestionMetric({ hasLogs: true, anomalyCount: 0 }, pickAnomaly),
  { status: 'ok', value: 0 },
);
// 실패 슬라이스는 hasLogs 가 어떻든 failed 가 우선한다.
assert.deepEqual(congestionMetric({ failed: true, hasLogs: true, anomalyCount: 0 }, pickAnomaly), {
  status: 'failed',
});

// ── metricsMetric: hasLogs 가 없는 슬라이스, null 이면 표본 없음 ──────────────
const pickAccept = (s: MetricsSlice) => s.acceptRate ?? null;
const pickDau = (s: MetricsSlice) => s.activeUsers ?? null;

assert.deepEqual(metricsMetric(null, pickAccept), { status: 'loading' });
assert.deepEqual(metricsMetric({ failed: true }, pickAccept), { status: 'failed' });
assert.deepEqual(metricsMetric({ acceptRate: null, activeUsers: null }, pickAccept), { status: 'empty' });
assert.deepEqual(metricsMetric({ acceptRate: null, activeUsers: null }, pickDau), { status: 'empty' });
assert.deepEqual(
  metricsMetric({ acceptRate: { value: 0.5, total: 8, accepted: 4 }, activeUsers: 0 }, pickAccept),
  { status: 'ok', value: { value: 0.5, total: 8, accepted: 4 } },
);
// DAU 0명은 실측값이다 — '조회 실패' 와 같은 모양이 되면 안 된다.
assert.deepEqual(metricsMetric({ activeUsers: 0 }, pickDau), { status: 'ok', value: 0 });

// ── changeBadge: 0(= 변화 없음 또는 전일 표본 없음)을 감소로 칠하지 않는다 ────
assert.deepEqual(changeBadge(-12.5), { text: '-12.5%', tone: 'decrease' });
assert.deepEqual(changeBadge(3), { text: '+3%', tone: 'increase' });
assert.deepEqual(changeBadge(0), { text: '0%', tone: 'flat' });
assert.deepEqual(changeBadge(Number.NaN), { text: '—', tone: 'flat' });

// ── 시설 혼잡 상태: 미관측/실패가 '한산'(quiet)으로 새지 않는다 ────────────────
// 등급 키는 관광객 지도·관제 히트맵과 같은 congestionKey 다(PM 4.26 — 2026-10-07 리뷰로 장소 관리도 같은 척도).
assert.equal(facilityStatusKey({ kind: 'observed', level: 0.9 }), 'busy');
assert.equal(facilityStatusKey({ kind: 'observed', level: 0.75 }), 'busy');
assert.equal(facilityStatusKey({ kind: 'observed', level: 0.5 }), 'moderate');
assert.equal(facilityStatusKey({ kind: 'observed', level: 0.25 }), 'relaxed');
assert.equal(facilityStatusKey({ kind: 'observed', level: 0 }), 'quiet');
assert.equal(facilityStatusKey({ kind: 'none' }), 'unknown');
assert.equal(facilityStatusKey({ kind: 'unavailable' }), 'unknown');
// 운영자 '혼잡' 경계를 따른다(지도·히트맵과 같은 경계) — 60% 로 내리면 62% 는 '보통' 이 아니라 '혼잡' 이다.
assert.equal(facilityStatusKey({ kind: 'observed', level: 0.62 }), 'moderate');
assert.equal(facilityStatusKey({ kind: 'observed', level: 0.62 }, 0.6), 'busy');
assert.equal(facilityStatusLabel({ kind: 'estimated', level: 0.62 }, 0.6), '혼잡 · 추정');
assert.equal(facilityStatusLabel({ kind: 'observed', level: 0.62 }, 0.6), '혼잡');

assert.equal(facilityStatusLabel({ kind: 'observed', level: 0 }), '한산');
// 2026-10-07(I72): 관측도 추정도 없으면 라벨을 달지 않는다('관측 대기' 가 목록 전체를 덮었다). 조회 실패만 말한다.
assert.equal(facilityStatusLabel({ kind: 'none' }), '');
assert.equal(facilityStatusLabel({ kind: 'unavailable' }), '혼잡도 갱신 중');

assert.equal(observedLevel({ kind: 'observed', level: 0 }), 0);
assert.equal(observedLevel({ kind: 'none' }), null);
assert.equal(observedLevel({ kind: 'unavailable' }), null);

// ── 장소 관리: 관광객 지도와 같은 '추정' · 24시간 지난 관측은 현재 상태가 아니다(I72) ─────────
{
  const NOW = Date.parse('2026-10-07T05:00:00Z'); // KST 14:00
  const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();
  // 24시간 안의 관측은 그대로 현재 상태.
  const fresh = facilityCongestionFrom({ failed: false, observedLevel: 0.82, observedAt: hoursAgo(2), estimateLevel: 0.4, now: NOW });
  assert.deepEqual(fresh, { kind: 'observed', level: 0.82 });
  assert.equal(facilityStatusLabel(fresh), '혼잡');
  // 열흘 전 관측 + 추정 → 추정이 현재 상태, 지난 관측은 날짜와 함께 따로.
  const old = facilityCongestionFrom({ failed: false, observedLevel: 0.82, observedAt: '2026-09-27T05:05:00Z', estimateLevel: 0.6, now: NOW });
  assert.equal(old.kind, 'estimated');
  assert.equal(facilityStatusLabel(old), '보통 · 추정');
  assert.equal(facilityStatusKey(old), 'moderate');
  assert.equal(observedLevel(old), null, '추정은 관측값이 아니다(이상 알림·수동 입력 초기값에 쓰지 않는다)');
  assert.equal(staleObservationLine(old), '9/27 14:05 관측 혼잡 82%');
  // 오래된 관측만 있으면 현재 상태 없음 — 라벨·등급 없이 지난 관측 한 줄만.
  const staleOnly = facilityCongestionFrom({ failed: false, observedLevel: 0.3, observedAt: hoursAgo(30), estimateLevel: null, now: NOW });
  assert.equal(staleOnly.kind, 'stale');
  assert.equal(facilityStatusLabel(staleOnly), '');
  assert.equal(facilityStatusKey(staleOnly), 'unknown');
  assert.match(staleObservationLine(staleOnly) ?? '', /관측 여유 30%$/);
  // 24시간 경계 — 정확히 24시간은 아직 현재.
  assert.equal(facilityCongestionFrom({ failed: false, observedLevel: 0.5, observedAt: hoursAgo(24), estimateLevel: null, now: NOW }).kind, 'observed');
  // 관측이 없고 추정만 있으면 추정(지난 관측 줄 없음).
  const estOnly = facilityCongestionFrom({ failed: false, observedLevel: null, observedAt: null, estimateLevel: 0.1, now: NOW });
  assert.deepEqual(estOnly, { kind: 'estimated', level: 0.1, previous: null });
  assert.equal(facilityStatusLabel(estOnly), '한산 · 추정');
  assert.equal(staleObservationLine(estOnly), null);
  // 둘 다 없으면 none(라벨 없음). 조회 실패는 추정이 있어도 덮지 않는다.
  assert.deepEqual(facilityCongestionFrom({ failed: false, observedLevel: null, observedAt: null, estimateLevel: null, now: NOW }), { kind: 'none' });
  assert.deepEqual(facilityCongestionFrom({ failed: true, observedLevel: 0.5, observedAt: hoursAgo(1), estimateLevel: 0.5, now: NOW }), { kind: 'unavailable' });
}

// ── chunk: PostgREST 1000행 캡을 넘지 않도록 자른다 ───────────────────────────
assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
assert.deepEqual(chunk([], 500), []);
assert.deepEqual(chunk([1, 2], 5), [[1, 2]]);
assert.equal(chunk(Array.from({ length: 1664 }, (_, i) => i), 500).length, 4);
assert.equal(
  chunk(Array.from({ length: 1664 }, (_, i) => i), 500).reduce((n, c) => n + c.length, 0),
  1664,
);
assert.throws(() => chunk([1], 0), /chunk size/);

console.log('admin metric state tests passed');
