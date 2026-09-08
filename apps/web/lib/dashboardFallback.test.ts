// 대시보드 '실시간 관제' 기준 판정 — 폴백이 오늘로 위장하지 않는지, 빈 화면이 이유를 말하는지.
//
// 잡으려는 결함(실측 2026-09-08): congestion_logs 최신 행이 19일 전이라 오늘 구간이 비었고,
// 평균 혼잡도·이상 혼잡·히트맵이 전부 빈 카드였다. 그 화면은 '고장' 과 '데이터 없음' 을
// 구분해 주지 않았다. 반대 방향의 결함도 같은 크기다 — 폴백을 날짜 없이 그리면 19일 전
// 데이터가 오늘 것으로 읽힌다.
import { strict as assert } from 'node:assert';
import {
  basisDateBadge,
  basisPeriodLabel,
  congestionEmptyNotice,
  fallbackExplanation,
  formatKstDateTime,
  resolveCongestionView,
  shortKstDate,
  type DashboardTodayResponse,
} from './dashboardFallback';

// 실측 프로덕션 값: 최신 혼잡 로그 2026-08-20T17:05Z = KST 2026-08-21 02:05.
const LATEST = '2026-08-20T17:05:00+00:00';

const FALLBACK_DAY = {
  dateKst: '2026-08-21',
  observedAt: LATEST,
  hasLogs: true,
  avgCongestion: { value: 0.5, changePercent: 0, changePercentOrNull: null, prevSampleCount: 0 },
  anomalyCount: 1,
  heatmap: [{ facility: '황리단길', facilityType: 'attraction', hour: 2, value: 1.0 }],
  anomalies: [{ id: 'a' }],
  sampleCount: 6,
};

function main() {
  // ── 로딩/실패는 '표본 없음' 과 섞이지 않는다 ────────────────────────────────
  assert.equal(resolveCongestionView(null).basis.kind, 'loading');
  assert.equal(resolveCongestionView(null).day, null);
  const failedView = resolveCongestionView({ failed: true });
  assert.equal(failedView.basis.kind, 'failed');
  // 실패 표식이 살아 있어야 congestionMetric() 이 '조회 실패' 와 '표본 없음' 을 가른다.
  assert.equal(failedView.day?.failed, true);

  // ── 오늘 관측이 있으면 그대로 오늘이다 ──────────────────────────────────────
  const todayRes: DashboardTodayResponse = {
    hasLogs: true,
    avgCongestion: { value: 0.4, changePercent: 0 },
    anomalyCount: 0,
    heatmap: [],
    anomalies: [],
    sampleCount: 12,
    latestObservedAt: LATEST,
    fallback: null,
  };
  const today = resolveCongestionView(todayRes);
  assert.equal(today.basis.kind, 'today');
  assert.equal(today.day, todayRes);
  assert.equal(basisDateBadge(today.basis), null, '오늘 기준이면 날짜 배지를 내지 않는다');
  assert.equal(basisPeriodLabel(today.basis), '오늘');
  assert.equal(congestionEmptyNotice(today.basis), null);

  // ── 오늘이 비면 폴백으로 물러나되, 날짜를 반드시 들고 다닌다 ────────────────
  const emptyToday: DashboardTodayResponse = {
    hasLogs: false,
    avgCongestion: null,
    anomalyCount: null,
    heatmap: null,
    anomalies: null,
    sampleCount: 0,
    latestObservedAt: LATEST,
    fallback: FALLBACK_DAY,
  };
  const fb = resolveCongestionView(emptyToday);
  assert.equal(fb.basis.kind, 'fallback');
  assert.equal(fb.day, FALLBACK_DAY, '폴백일의 집계를 그려야 한다(빈 카드가 아니다)');
  assert.equal(fb.day?.anomalyCount, 1);

  const badge = basisDateBadge(fb.basis);
  assert.ok(badge, '폴백인데 기준일 배지가 없으면 오늘 것으로 읽힌다');
  assert.match(badge!, /2026-08-21/, '배지가 기준 날짜를 명시해야 한다');
  assert.match(badge!, /KST/, 'UTC 8\/20 과 KST 8\/21 이 하루 어긋나므로 시간대를 밝힌다');
  // 타일 제목이 '오늘' 로 남으면 타일 전체가 거짓이 된다.
  assert.equal(basisPeriodLabel(fb.basis), '8/21');
  assert.notEqual(basisPeriodLabel(fb.basis), '오늘');
  // 폴백 상태는 '비었다' 가 아니다 — 빈 안내 문구를 띄우면 안 된다.
  assert.equal(congestionEmptyNotice(fb.basis), null);

  const why = fallbackExplanation(fb.basis);
  assert.ok(why);
  assert.match(why!, /2026-08-21 02:05 \(KST\)/, '마지막 관측 시각을 KST 로 말해야 한다');

  // ── 기준일보다 최신인 관측이 남아 있으면 '왜 하필 그 날인지' 까지 말한다 ────
  // 실측 상태: 8/21 에 관측 1건이 있는데 집계 가능한 날은 7/09 다. 그 사이를 설명하지
  // 않으면 화면이 최신 관측을 감춘 것처럼 보인다.
  const skipped = resolveCongestionView({
    ...emptyToday,
    latestObservedAt: LATEST, // KST 2026-08-21
    fallback: { ...FALLBACK_DAY, dateKst: '2026-07-09', observedAt: '2026-07-09T05:00:00+00:00' },
  });
  assert.equal(skipped.basis.kind, 'fallback');
  assert.equal(basisPeriodLabel(skipped.basis), '7/9');
  const skippedWhy = fallbackExplanation(skipped.basis)!;
  assert.match(skippedWhy, /2026-08-21 02:05 \(KST\)/, '건너뛴 최신 관측을 감추면 안 된다');
  assert.match(skippedWhy, /5건/, '왜 그 관측으로는 집계하지 못했는지 기준을 밝혀야 한다');

  // ── 폴백일마저 표본 부족이면 폴백하지 않는다 ────────────────────────────────
  const thinFallback = resolveCongestionView({
    ...emptyToday,
    fallback: { ...FALLBACK_DAY, hasLogs: false, avgCongestion: null, heatmap: null, sampleCount: 2 },
  });
  assert.equal(thinFallback.basis.kind, 'none', '표본 부족한 날을 기준일로 내세우면 안 된다');

  // ── 폴백조차 없으면: 왜 비었는지 + 무엇을 하면 채워지는지 ───────────────────
  const none = resolveCongestionView({ ...emptyToday, fallback: null });
  assert.equal(none.basis.kind, 'none');
  const notice = congestionEmptyNotice(none.basis)!;
  assert.ok(notice);
  assert.match(notice.detail, /2026-08-21 02:05 \(KST\)/, '마지막 관측 시각을 실제로 보여줘야 한다');
  assert.ok(notice.remedy, '무엇을 하면 채워지는지 말해야 한다');
  assert.match(notice.remedy!, /피크타임 모의 발생/, '이 저장소에 실재하는 조치를 가리켜야 한다');
  assert.match(notice.remedy!, /주차/, '주차 실측이 이 표를 채우지 않는다는 사실을 밝혀야 한다');

  // ── 표가 통째로 비었을 때와 '오늘만' 비었을 때는 다른 문장이다 ──────────────
  const never = congestionEmptyNotice(
    resolveCongestionView({ hasLogs: false, sampleCount: 0, latestObservedAt: null, fallback: null }).basis,
  )!;
  assert.notEqual(never.headline, notice.headline);
  assert.doesNotMatch(never.detail, /2026/, '없는 마지막 관측 시각을 지어내면 안 된다');

  // ── 옛 서버(신규 키 없음)는 '모른다' 고 말한다 ──────────────────────────────
  const legacy = resolveCongestionView({ hasLogs: false, avgCongestion: null, anomalyCount: null });
  assert.equal(legacy.basis.kind, 'none');
  assert.equal((legacy.basis as { latestKnown: boolean }).latestKnown, false);
  const legacyNotice = congestionEmptyNotice(legacy.basis)!;
  assert.match(legacyNotice.detail, /알려주지 않습니다/, '모르는 것을 아는 척하지 않는다');
  assert.doesNotMatch(legacyNotice.detail, /한 건도 없/, "'키가 없다' 를 '기록이 없다' 로 뭉개면 안 된다");

  // ── 조회 실패 문구는 '데이터 없음' 을 주장하지도, 부정하지도 않는다 ─────────
  const failedNotice = congestionEmptyNotice({ kind: 'failed' })!;
  assert.match(failedNotice.detail, /실패/);
  assert.match(failedNotice.detail, /알 수 없습니다/, '실패 화면이 데이터 유무를 단정하면 안 된다');
  assert.equal(failedNotice.remedy, null, '실패일 때는 데이터 적재 안내가 답이 아니다');

  // ── KST 환산 ────────────────────────────────────────────────────────────────
  // UTC 로는 8/20 이지만 KST 로는 8/21 — 이 한 칸이 배지의 날짜를 하루 어긋나게 한다.
  assert.equal(formatKstDateTime(LATEST), '2026-08-21 02:05 (KST)');
  assert.equal(formatKstDateTime('2026-08-20T14:59:59Z'), '2026-08-20 23:59 (KST)');
  assert.equal(formatKstDateTime('2026-08-20T15:00:00Z'), '2026-08-21 00:00 (KST)');
  assert.equal(formatKstDateTime(null), null);
  assert.equal(formatKstDateTime(''), null);
  assert.equal(formatKstDateTime('not-a-date'), null, '파싱 실패를 임의 시각으로 채우지 않는다');

  assert.equal(shortKstDate('2026-08-21'), '8/21');
  assert.equal(shortKstDate('2026-12-05'), '12/5');
  assert.equal(shortKstDate('bogus'), 'bogus', '형식이 다르면 잘라서 다른 날짜를 만들지 않는다');

  console.log('dashboardFallback.test.ts OK');
}

main();
