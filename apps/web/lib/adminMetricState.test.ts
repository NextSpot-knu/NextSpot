import { strict as assert } from 'node:assert';
import {
  chunk,
  changeBadge,
  congestionMetric,
  facilityStatusKey,
  facilityStatusLabel,
  metricsMetric,
  observedLevel,
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

// ── 시설 혼잡 상태: 미관측/실패가 '한산'(blue)으로 새지 않는다 ────────────────
assert.equal(facilityStatusKey({ kind: 'observed', level: 0.9 }), 'orange');
assert.equal(facilityStatusKey({ kind: 'observed', level: 0.75 }), 'orange');
assert.equal(facilityStatusKey({ kind: 'observed', level: 0.5 }), 'yellow');
assert.equal(facilityStatusKey({ kind: 'observed', level: 0.25 }), 'green');
assert.equal(facilityStatusKey({ kind: 'observed', level: 0 }), 'blue');
assert.equal(facilityStatusKey({ kind: 'none' }), 'unknown');
assert.equal(facilityStatusKey({ kind: 'unavailable' }), 'unknown');

assert.equal(facilityStatusLabel({ kind: 'observed', level: 0 }), '한산');
assert.equal(facilityStatusLabel({ kind: 'none' }), '관측 대기');
assert.equal(facilityStatusLabel({ kind: 'unavailable' }), '혼잡도 조회 실패');

assert.equal(observedLevel({ kind: 'observed', level: 0 }), 0);
assert.equal(observedLevel({ kind: 'none' }), null);
assert.equal(observedLevel({ kind: 'unavailable' }), null);

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
