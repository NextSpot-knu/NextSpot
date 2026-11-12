import assert from 'node:assert/strict';

// 방문 여정 · 방문 결과 큐의 지역(S3).
//
// 실제로 났던 일: 내부 지역에서 수락한 추천의 대기 방문·진행 중 여정·방문 결과가 지역 없이 저장됐다. 경주로 바꾸면
// 그 여정이 경주 화면에 떴고, 답(도착·평가)은 **보내는 순간의 지역**으로 나가 서버가 그 지역에서 추천 행을 못 찾아
// 404 → 큐가 영구 실패로 버렸다. 첫 로드의 SessionBootstrap 은 RegionProvider 밖이라 지역을 정하기 전(경주)에 큐를
// 비워 내부 지역 기록이 같은 식으로 버려졌다.
//
// 잠그는 것:
//   · 수락한 때의 지역을 저장한다(경주는 저장 모양이 오늘과 같다 — region 필드 없음).
//   · 이 변경 전에 저장된 값(region 없음)은 경주다.
//   · 대기 방문은 지금 지역과 같을 때만 묻는다.
//   · 큐 항목은 쌓을 때의 지역(또는 여정이 준 지역)을 저장하고, 전송은 지금 지역이 아니라 그 지역으로 한다.

function installBrowser(): void {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
  (globalThis as Record<string, unknown>).localStorage = localStorage;
  (globalThis as Record<string, unknown>).window = { localStorage };
}

installBrowser();

const QUEUE_KEY = 'nextspot_recommendation_outcome_queue';
const REC_A = '44444444-4444-4444-8444-444444444444';
const REC_B = '55555555-5555-4555-8555-555555555555';
const REC_LEGACY = '66666666-6666-4666-8666-666666666666';

void (async () => {
  const { setActiveRegion, PUBLIC_REGION_ID } = await import('./regionRuntime');
  const visits = await import('./visits');
  const { apiClient } = await import('./api-client');
  const { flushRecommendationOutcomes, queueRecommendationOutcome } = await import('./recommendationOutcomes');

  const fac = { id: 'fac-1', name: '시험 장소', type: 'cafe', latitude: 36.5, longitude: 127.5 };
  const longAgo = () => Date.now() - visits.DUE_AFTER_MS - 1_000;

  // ── 경주 — 저장 모양이 오늘과 같다 ─────────────────────────────────────────
  setActiveRegion(PUBLIC_REGION_ID);
  visits.recordActiveTrip(fac, { recommendationId: REC_A });
  const gyeongjuPending = JSON.parse(localStorage.getItem('nextspot_pending_visit')!);
  const gyeongjuTrip = JSON.parse(localStorage.getItem('nextspot_active_trip')!);
  assert.equal('region' in gyeongjuPending, false, '경주 대기 방문에 지역 필드가 생겼다');
  assert.equal('region' in gyeongjuTrip, false, '경주 여정에 지역 필드가 생겼다');
  assert.equal(visits.visitRegion(gyeongjuTrip), PUBLIC_REGION_ID);
  visits.dismissVisitCheck();

  // ── 내부 지역에서 수락 — 지역을 적고, 그 지역에서만 묻는다 ───────────────
  setActiveRegion('testbed');
  visits.recordActiveTrip(fac, { recommendationId: REC_A });
  const trip = visits.getActiveTrip()!;
  assert.equal(trip.region, 'testbed', '내부 지역 여정에 지역이 저장되지 않았다');
  assert.equal(visits.getPendingVisit()!.region, 'testbed');
  // 30분이 지났다고 치자.
  localStorage.setItem('nextspot_pending_visit', JSON.stringify({ ...visits.getPendingVisit()!, acceptedAt: longAgo() }));
  assert.equal(visits.getDueVisit(PUBLIC_REGION_ID), null, '내부 지역 방문을 경주 화면에서 물었다');
  const due = visits.getDueVisit('testbed');
  assert.ok(due, '내부 지역 방문을 그 지역에서 묻지 않았다');
  assert.equal(due!.recommendationId, REC_A);
  assert.equal(visits.visitRegion(due), 'testbed');
  // 다른 지역 화면에서 숨기기만 하고 지우지 않는다(돌아오면 다시 묻는다).
  assert.ok(visits.getPendingVisit(), '다른 지역에서 대기 방문을 지웠다');
  assert.equal(visits.visitMatchesRegion(trip, 'testbed'), true);
  assert.equal(visits.visitMatchesRegion(trip, PUBLIC_REGION_ID), false);
  visits.dismissVisitCheck();

  // ── 이 변경 전에 저장된 값(region 없음) = 경주 ───────────────────────────
  localStorage.setItem('nextspot_pending_visit', JSON.stringify({
    facilityId: 'old', name: '옛 장소', type: 'cafe', lat: null, lng: null, acceptedAt: longAgo(),
  }));
  assert.ok(visits.getDueVisit(PUBLIC_REGION_ID), '옛 대기 방문이 경주에서 사라졌다');
  assert.equal(visits.getDueVisit('testbed'), null, '옛 대기 방문(경주)을 내부 지역에서 물었다');
  assert.equal(visits.visitMatchesRegion(visits.getActiveTrip(), PUBLIC_REGION_ID), true, '옛 여정 이주가 경주가 아니다');
  // 지역 인자를 안 주면 예전처럼 지역을 보지 않는다.
  assert.ok(visits.getDueVisit());
  visits.dismissVisitCheck();

  // ── 내부 지역을 더는 볼 수 없을 때 — 내부 지역 여정만 지운다 ─────────────
  // (RegionProvider 의 흔적 지우기가 부른다. 그 기록에는 내부 지역 장소 이름 · 좌표가 들어 있다.)
  setActiveRegion('testbed');
  visits.recordActiveTrip(fac, { recommendationId: REC_A });
  setActiveRegion(PUBLIC_REGION_ID);
  assert.equal(visits.clearInternalRegionVisits(), true);
  assert.equal(localStorage.getItem('nextspot_pending_visit'), null, '내부 지역 대기 방문이 남았다');
  assert.equal(localStorage.getItem('nextspot_active_trip'), null, '내부 지역 여정이 남았다');
  // 경주 여정은 그대로 둔다.
  visits.recordActiveTrip(fac, { recommendationId: REC_B });
  assert.equal(visits.clearInternalRegionVisits(), false);
  assert.ok(visits.getActiveTrip(), '경주 여정을 지웠다');
  assert.ok(visits.getPendingVisit());
  visits.dismissVisitCheck();
  // 여정 키만 내부 지역이어도 둘 다 지운다(두 키는 함께 산다 — dismissVisitCheck 주석).
  localStorage.setItem('nextspot_active_trip', JSON.stringify({ facilityId: 'x', name: 'x', type: 'cafe', lat: null, lng: null, acceptedAt: 1, version: 1, status: 'navigating', region: 'testbed' }));
  assert.equal(visits.clearInternalRegionVisits(), true);
  assert.equal(localStorage.getItem('nextspot_active_trip'), null);

  // ── 방문 결과 큐 — 쌓을 때의 지역으로 보낸다 ─────────────────────────────
  const sent: { path: string; region: string | undefined }[] = [];
  (apiClient as unknown as { patch: (p: string, b?: unknown, o?: { region?: string }) => Promise<unknown> }).patch =
    async (path: string, _body?: unknown, options?: { region?: string }) => {
      sent.push({ path, region: options?.region });
      return {};
    };

  // 내부 지역에서 쌓고(지금 지역), 여정이 지역을 직접 주고, 경주에서도 쌓는다.
  localStorage.removeItem(QUEUE_KEY);
  setActiveRegion('testbed');
  queueRecommendationOutcome(REC_A, 'navigation_started');
  await flushRecommendationOutcomes();
  setActiveRegion(PUBLIC_REGION_ID);
  queueRecommendationOutcome(REC_B, 'navigation_started');
  await flushRecommendationOutcomes();
  queueRecommendationOutcome(REC_A, 'arrival_confirmed', { region: 'testbed' });
  await flushRecommendationOutcomes();
  assert.deepEqual(
    sent.map((s) => [s.path.split('/')[4], s.region]),
    [[REC_A, 'testbed'], [REC_B, PUBLIC_REGION_ID], [REC_A, 'testbed']],
    '방문 결과가 기록한 때의 지역으로 가지 않았다',
  );

  // 저장 모양 — 경주 항목에는 지역 필드가 없다(오늘과 같다), 내부 항목에는 있다.
  sent.length = 0;
  (apiClient as unknown as { patch: (p: string, b?: unknown, o?: { region?: string }) => Promise<unknown> }).patch =
    async () => { throw new Error('Failed to fetch'); };
  setActiveRegion('testbed');
  queueRecommendationOutcome(REC_A, 'rated', { rating: 'up' });
  setActiveRegion(PUBLIC_REGION_ID);
  queueRecommendationOutcome(REC_B, 'rated', { rating: 'up' });
  await flushRecommendationOutcomes();
  const stored = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as Array<Record<string, unknown>>;
  const byId = Object.fromEntries(stored.map((item) => [item.recommendationId as string, item]));
  assert.equal(byId[REC_A]?.region, 'testbed');
  assert.equal(REC_B in byId && 'region' in byId[REC_B], false, '경주 큐 항목에 지역 필드가 생겼다');

  // 이 변경 전에 쌓인 항목(region 없음)은 경주로 보낸다 — 지금 내부 지역을 보고 있어도.
  localStorage.setItem(QUEUE_KEY, JSON.stringify([
    { recommendationId: REC_LEGACY, stage: 'navigation_started', queuedAt: Date.now() - 60_000 },
  ]));
  (apiClient as unknown as { patch: (p: string, b?: unknown, o?: { region?: string }) => Promise<unknown> }).patch =
    async (path: string, _body?: unknown, options?: { region?: string }) => {
      sent.push({ path, region: options?.region });
      return {};
    };
  setActiveRegion('testbed');
  await flushRecommendationOutcomes();
  setActiveRegion(PUBLIC_REGION_ID);
  assert.deepEqual(sent.map((s) => s.region), [PUBLIC_REGION_ID], '옛 큐 항목이 지금 지역(내부)으로 갔다');

  console.log('visitsRegion tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
