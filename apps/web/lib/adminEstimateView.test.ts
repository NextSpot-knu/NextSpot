// 대시보드 추정 모드 판정 — 순서(실측 → 추정 → 폴백), 형 가드, 근거 문장.
//
// 잡으려는 결함:
//   · 오늘 추정이 있는데도 두 달 전 시드(폴백)를 그린다 — 관리자가 '지금' 을 판단할 수 없다.
//   · 추정치가 근거 없이(라벨·주차장 수·관측 시각 없이) 그려진다 — 실측으로 읽힌다.
//   · 옛 서버/모양이 어긋난 응답에서 화면 전체가 에러 경계로 떨어진다.
import { strict as assert } from 'node:assert';
import {
  DASHBOARD_INGEST_PATHS,
  csvBasisCell,
  dashboardDateBadge,
  dashboardEmptyNotice,
  dashboardFallbackExplanation,
  dashboardPeriodLabel,
  estimateBasisLine,
  estimateMethodNote,
  estimateUnavailableNote,
  pendingFromHour,
  readEstimatedDay,
  resolveDashboardView,
  type DashboardTodayWithEstimate,
} from './adminEstimateView';

const ESTIMATED = {
  dateKst: '2026-09-20',
  hasLogs: true,
  avgCongestion: { value: 0.66, changePercent: 3.1, changePercentOrNull: 3.1, prevSampleCount: 1440 },
  anomalyCount: 151,
  heatmap: [
    { facility: '월정교', facilityType: 'attraction', hour: 14, value: 0.93 },
    { facility: '월정교', facilityType: 'attraction', hour: 15, value: null },
    { facility: 42, facilityType: 'attraction', hour: 1, value: 0.1 }, // 불량 행 — 걸러진다
  ],
  anomalies: [
    { id: 'a', facilityName: '월정교', timestamp: '2026-09-20T05:00:00+00:00', congestionLevel: 0.95, durationMinutes: 10 },
    { id: 'b', facilityName: null, timestamp: 'x', congestionLevel: 0.95 }, // 불량 행
  ],
  sampleCount: 1440,
  sourceComposition: { estimated: 1440 },
  basis: {
    method: 'parking_its+tourism_concentration',
    weights: { parking: 0.7, tourism: 0.3 },
    radiusM: 2000,
    snapshotCount: 144,
    lotCountMax: 4,
    placeCount: 10,
    estimatedFacilityCount: 846,
    facilityCount: 1669,
    latestObservedAt: '2026-09-20T05:50:00+00:00', // KST 14:50
  },
};

const FALLBACK = {
  dateKst: '2026-07-09',
  observedAt: '2026-07-09T05:00:00+00:00',
  hasLogs: true,
  avgCongestion: { value: 0.5, changePercent: 0 },
  anomalyCount: 1,
  heatmap: [],
  anomalies: [],
  sampleCount: 1653,
};

const emptyToday = (extra: Partial<DashboardTodayWithEstimate>): DashboardTodayWithEstimate => ({
  hasLogs: false,
  avgCongestion: null,
  anomalyCount: null,
  heatmap: null,
  anomalies: null,
  sampleCount: 0,
  latestObservedAt: '2026-07-09T05:00:00+00:00',
  fallback: FALLBACK,
  ...extra,
});

function main() {
  // ── 순서: 오늘 실측 → 오늘 추정 → 과거 실측 ────────────────────────────────
  const measured: DashboardTodayWithEstimate = {
    hasLogs: true,
    avgCongestion: { value: 0.4, changePercent: 0 },
    anomalyCount: 0,
    heatmap: [],
    anomalies: [],
    sampleCount: 12,
    fallback: null,
    estimated: ESTIMATED,
  };
  assert.equal(resolveDashboardView(measured).basis.kind, 'today', '실측이 있으면 추정이 있어도 실측이다');
  assert.equal(resolveDashboardView(measured).day, measured);

  const estimateView = resolveDashboardView(emptyToday({ estimated: ESTIMATED }));
  assert.equal(estimateView.basis.kind, 'estimate', '오늘 추정이 두 달 전 실측(폴백)보다 앞선다');
  assert.equal(estimateView.day?.hasLogs, true);
  assert.equal(estimateView.day?.anomalyCount, 151);
  assert.equal(estimateView.day?.heatmap?.length, 2, '히트맵 불량 행만 걸러낸다');
  assert.equal(estimateView.day?.anomalies?.length, 1, '알림 불량 행만 걸러낸다');
  if (estimateView.basis.kind === 'estimate') {
    assert.equal(estimateView.basis.dateKst, '2026-09-20');
    assert.equal(estimateView.basis.info.lotCount, 4);
  }

  // 추정이 없거나(null) 옛 서버(키 없음)거나 표본 부족이면 기존 폴백 그대로.
  for (const estimated of [null, undefined, { ...ESTIMATED, hasLogs: false, sampleCount: 3 }]) {
    const v = resolveDashboardView(emptyToday({ estimated }));
    assert.equal(v.basis.kind, 'fallback');
    assert.equal(v.day, FALLBACK);
  }
  // 로딩/실패는 추정으로 가리지 않는다.
  assert.equal(resolveDashboardView(null).basis.kind, 'loading');
  assert.equal(resolveDashboardView({ failed: true, estimated: ESTIMATED }).basis.kind, 'failed');

  // ── 형 가드 — 모양이 어긋나면 추정 전체를 포기(부분 렌더 금지) ──────────────
  assert.equal(readEstimatedDay(ESTIMATED)?.dateKst, '2026-09-20');
  assert.equal(readEstimatedDay('oops'), null);
  assert.equal(readEstimatedDay([ESTIMATED]), null);
  assert.equal(readEstimatedDay({ ...ESTIMATED, dateKst: undefined }), null);
  assert.equal(readEstimatedDay({ ...ESTIMATED, avgCongestion: { value: '0.66' } }), null);
  assert.equal(readEstimatedDay({ ...ESTIMATED, anomalyCount: null }), null);
  assert.equal(readEstimatedDay({ ...ESTIMATED, heatmap: {} }), null);
  // 근거(basis)가 없어도 값은 그리되, 모르는 칸은 null 로 둔다(지어내지 않는다).
  const noBasis = readEstimatedDay({ ...ESTIMATED, basis: undefined });
  assert.ok(noBasis);
  assert.equal(noBasis.basis.lotCount, null);
  assert.equal(estimateBasisLine(noBasis.basis, '2026-09-20'), '주차 실측(ITS 공영주차) + 관광공사 집중률 기반 추정');
  // changePercentOrNull: null 은 '비교 불가' 로 살아 있어야 한다(undefined 로 뭉개면 구 키 0% 배지가 뜬다).
  const noPrev = readEstimatedDay({ ...ESTIMATED, avgCongestion: { value: 0.5, changePercent: 0, changePercentOrNull: null } });
  assert.equal(noPrev?.avgCongestion?.changePercentOrNull, null);

  // ── 근거 문장 ──────────────────────────────────────────────────────────────
  const info = readEstimatedDay(ESTIMATED)!.basis;
  assert.equal(
    estimateBasisLine(info, '2026-09-20'),
    '주차 실측(ITS 공영주차 4곳) + 관광공사 집중률 기반 추정 · 14:50 관측 · 반경 2km',
  );
  // 관측이 그 날이 아니면 날짜까지 — 어제 밤 관측을 오늘 것으로 읽히게 하지 않는다.
  assert.match(
    estimateBasisLine({ ...info, latestObservedAt: '2026-09-19T14:50:00+00:00' }, '2026-09-20'),
    /9\/19 23:50 관측/,
  );
  const method = estimateMethodNote(info);
  assert.match(method, /0\.7 × 주변 공영주차 점유율 \+ 0\.3 × 관광공사 집중률/);
  assert.match(method, /대표 관광지 10곳 × 10분 구간/);
  assert.match(method, /1,669곳 중 846곳/);

  // ── 기존 판정의 '추정' 갈래 ─────────────────────────────────────────────────
  const eb = estimateView.basis;
  assert.equal(dashboardPeriodLabel(eb), '오늘');
  assert.equal(dashboardDateBadge(eb), null, '추정은 오늘이다 — 과거 기준일 배지를 달지 않는다');
  assert.equal(dashboardFallbackExplanation(eb), null);
  assert.equal(dashboardEmptyNotice(eb), null);
  assert.match(csvBasisCell(eb), /공영주차 실측 \+ 관광 통계 기반 추정/);
  const fb = resolveDashboardView(emptyToday({ estimated: null })).basis;
  assert.equal(dashboardPeriodLabel(fb), '7/9');
  assert.equal(dashboardDateBadge(fb), '2026-07-09 (KST) 기준');
  assert.equal(csvBasisCell(fb), '2026-07-09 (KST) — 현장 관측 집계 기준일');

  // 빈 안내의 '무엇을 하면 채워지는가' 가 걷어낸 버튼(모의 발생·수동 적재)을 가리키지 않는다.
  const none = resolveDashboardView(emptyToday({ fallback: null, estimated: null })).basis;
  assert.equal(none.kind, 'none');
  const notice = dashboardEmptyNotice(none);
  assert.equal(notice?.remedy, DASHBOARD_INGEST_PATHS);
  assert.doesNotMatch(DASHBOARD_INGEST_PATHS, /모의 발생|수동/);

  // ── 왜 추정이 아닌가 ─────────────────────────────────────────────────────────
  assert.match(estimateUnavailableNote(emptyToday({ estimated: null }), fb) ?? '', /갱신하는 중입니다/);
  assert.match(
    estimateUnavailableNote(emptyToday({ estimated: { ...ESTIMATED, hasLogs: false, sampleCount: 3 } }), fb) ?? '',
    /표본을 수집하는 중입니다\(3개 구간\)/,
  );
  assert.equal(estimateUnavailableNote(emptyToday({}), fb), null, '옛 서버(키 없음)면 말하지 않는다');
  assert.equal(estimateUnavailableNote(emptyToday({ estimated: ESTIMATED }), eb), null);
  assert.equal(estimateUnavailableNote(measured, { kind: 'today' }), null);

  // ── '아직 오지 않은 시간' ────────────────────────────────────────────────────
  const at = (iso: string) => new Date(iso).getTime();
  // KST 2026-09-20 03:10 → 4시부터 미래
  assert.equal(pendingFromHour('2026-09-20', at('2026-09-19T18:10:00Z')), 4);
  // KST 23:30 → 미래 없음
  assert.equal(pendingFromHour('2026-09-20', at('2026-09-20T14:30:00Z')), null);
  // 과거 날짜의 빈 칸은 '미래' 가 아니다
  assert.equal(pendingFromHour('2026-09-19', at('2026-09-19T18:10:00Z')), null);
  assert.equal(pendingFromHour('2026-09-21', at('2026-09-19T18:10:00Z')), 0);
  assert.equal(pendingFromHour(null, at('2026-09-19T18:10:00Z')), null);

  console.log('adminEstimateView.test.ts OK');
}

main();
