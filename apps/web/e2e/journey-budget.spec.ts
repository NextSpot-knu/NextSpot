import { expect, test, type Route } from '@playwright/test';
import { stubFakeKakaoMap } from './support/fakeKakaoMap';
import { stubExternalServices } from './support/stubs';

// 계획 3.2 예산 — 차가운 심사 여정 한 번(랜딩 → /setup → /main → +2시간 후 → 카드 → /waiting → 사장님 콘솔)이 Render(우리 API ·
// /predict)에 보내는 요청 수(리뷰 10-07: 예산을 지키는지 재는 시험이 없었다). 서버는 전부 스텁이다 — 실서버 부하 없음.
//
// 이 시험이 잠그는 것:
//   · 같은 값은 세션에서 한 번만 — 추정 피드(/congestion/estimates)는 /main · /waiting 이 나눠 쓰고, 권역 전망은 시간 줄과
//     /waiting 곡선이 같은 정시를 다시 묻지 않는다(+2시간 후의 정시는 여정 전체에서 한 번).
//   · 사장님 콘솔 데모는 0회(① 은 클라이언트 패턴, 계획 3.2).
//   · 전체 수의 상한(아래 JOURNEY_CEILING) — 계획의 12회는 아직 넘는다(세션 프리페치 5회 · /waiting 보드 4회 · 골든아워 배지
//     섹터마다 1회 등 이전부터의 구조). 그 차이는 HANDOVER 의 PM 확인 항목이다. 이 상한은 크게 늘지 않게(예: 요청 고리) 막는다.
//   ⚠️ e2e 는 next dev(React StrictMode)라 마운트 때 도는 조회가 두 번씩 나간다 — 여기 숫자는 프로덕션보다 크다. 같은 여정을
//     정적 빌드(out/)로 잰 값은 HANDOVER 2026-10-07 에 있다. 실제 숫자와 내역은 첨부(journey-budget.json)와 콘솔에 남긴다.

const JOURNEY_CEILING = 60;

const LAT = 35.8358;
const LNG = 129.2098;
type Row = Record<string, unknown> & { id: string; name: string; type: string };

function place(id: string, name: string, type: string, i: number): Row {
  return {
    id, name, type,
    latitude: LAT + (i % 3) * 0.0006,
    longitude: LNG + Math.floor(i / 3) * 0.0007,
    capacity: 30, features: {}, congestion: null,
    operating_hours: { open: '00:00~23:59', closed: '연중무휴' },
  };
}
const ROWS: Record<string, Row[]> = {
  attraction: [place('att-1', '경주 계림', 'attraction', 0), place('att-2', '경주 향교', 'attraction', 1), place('att-3', '교촌 한옥마을', 'attraction', 2)],
  restaurant: [place('rest-1', '황남 쌈밥', 'restaurant', 3), place('rest-2', '이사부피자', 'restaurant', 4)],
  cafe: [place('cafe-1', '한옥 찻집', 'cafe', 5)],
  culture: [place('cul-1', '국립경주박물관', 'culture', 6)],
};
const FACILITIES = Object.values(ROWS).flat();

function rec(row: Row, rank: number, total: number) {
  return {
    recommendation_id: `rec-${row.id}`, facility: row, spot_score: 0.8 - rank * 0.03, distance_m: 180 + rank * 40,
    rank, total_candidates: total, reason: `${row.name} 추천`, reason_source: 'template',
    congestion_level: null, congestion_source: 'none', congestion_is_current: null, congestion_timestamp: null,
    open_status_at_arrival: 'open_expected', scoring_mode: 'area_stats_rules', prediction_source: 'unavailable',
    breakdown: { preference: 0.82 - rank * 0.04, wait_time: null, travel_time: 2.4 + rank, incentive: 0 },
  };
}

test('cold judge journey: every Render call is counted, shared values are asked once, the console demo adds none', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await stubExternalServices(page);
  await stubFakeKakaoMap(page);

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/rest/v1/**', (route) => json(route, []));
  await page.route('**/api/v1/**', (route) => json(route, {}));
  await page.route('**/api/v1/infrastructures**', (route) => json(route, FACILITIES));
  await page.route('**/api/v1/recommendations/by-type', (route) => {
    const body = route.request().postDataJSON() as { facility_type?: string };
    const rows = ROWS[String(body.facility_type ?? '')] ?? [];
    return json(route, rows.map((row, i) => rec(row, i + 1, rows.length)));
  });
  await page.route('**/api/v1/area-demand/forecast**', (route) => json(route, { available: true, forecast: { level: 0.35 } }));
  await page.route('**/api/v1/congestion/estimates', (route) => {
    const observedAt = new Date().toISOString();
    return json(route, {
      available: true,
      estimates: Object.fromEntries(FACILITIES.map((f) => [f.id, { source: 'estimated', level: 0.55, observed_at: observedAt }])),
    });
  });
  await page.route('**/predict/model-info', (route) => json(route, { trained: false, fallback_state: 'degraded_rules' }));
  await page.route('**/predict/batch', (route) => json(route, { detail: 'untrained' }, 503));
  // /predict/* 는 위 /api/v1 묶음 밖이다 — 닫지 않으면 연결 실패로 전송 계층이 한 번 더 보내 숫자가 부푼다.
  await page.route('**/predict/golden-hour**', (route) => json(route, { available: false }));
  await page.route('**/api/v1/freshness**', (route) => json(route, { last_tourapi_sync: new Date(Date.now() - 2 * 3600_000).toISOString() }));
  await page.addInitScript(() => {
    localStorage.setItem('nextspot_theme', 'light');
    localStorage.setItem('nextspot_locale', 'ko');
  });

  const render: { step: string; call: string }[] = [];
  let step = 'landing';
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/^\/(api\/v1|predict)\//.test(url.pathname)) render.push({ step, call: `${request.method()} ${url.pathname}` });
  });

  // ① 랜딩 → '바로 시작' → /setup → '시작하기'
  await page.goto('/');
  await page.getByRole('button', { name: '바로 시작' }).click({ timeout: 60_000 });
  step = 'setup';
  await expect(page).toHaveURL(/\/setup/, { timeout: 30_000 });
  await page.getByRole('button', { name: '관광지', exact: true }).click();
  await page.getByRole('button', { name: '시작하기' }).click();

  // ② /main — 카드가 서고, 세션 프리페치(마운트 4초 뒤 + 한가할 때)까지 끝난다.
  step = 'main';
  await expect(page).toHaveURL(/\/main/, { timeout: 30_000 });
  const card = page.getByTestId('recommendation-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(9_000);

  // ③ 하단 시간 줄 '+2시간 후'
  step = '+2h';
  await page.getByTestId('forecast-track').getByText('+2시간 후', { exact: true }).click();
  await expect(page.getByTestId('forecast-badge')).toContainText('예측', { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  // ④ 카드 — 상세 정보 펼치기
  step = 'card';
  await card.getByRole('button', { name: '상세 정보 펼치기' }).click();
  await page.waitForTimeout(2_000);

  // ⑤ 레일 '지금 출발하면?' → 대기 보드가 다 찬다
  step = 'waiting';
  await page.getByRole('button', { name: '지금 출발하면?' }).click();
  await expect(page).toHaveURL(/\/waiting/, { timeout: 30_000 });
  await expect(page.locator('main [aria-busy]')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await page.waitForTimeout(3_000);

  // ⑥ 레일 '사장님 콘솔'(게스트 → 데모)
  step = 'merchant';
  await page.locator('[data-console-entry="merchant"]').first().click();
  await expect(page).toHaveURL(/\/merchant/, { timeout: 30_000 });
  await expect(page.locator('section', { hasText: '① 예상 혼잡' })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_000);

  const byStep = render.reduce<Record<string, string[]>>((acc, r) => {
    (acc[r.step] ??= []).push(r.call);
    return acc;
  }, {});
  const count = (re: RegExp) => render.filter((r) => re.test(r.call)).length;
  await testInfo.attach('journey-budget.json', {
    body: JSON.stringify({ total: render.length, plannedBudget: 12, ceiling: JOURNEY_CEILING, byStep }, null, 2),
    contentType: 'application/json',
  });
  console.log(`[journey-budget] total=${render.length} ${Object.entries(byStep).map(([k, v]) => `${k}=${v.length}`).join(' ')}`);
  for (const [k, v] of Object.entries(byStep)) console.log(`[journey-budget] ${k}: ${v.join(', ')}`);

  // 같은 값은 세션에서 한 번.
  expect(count(/GET \/api\/v1\/congestion\/estimates$/), 'the estimates feed is fetched once and shared by /main and /waiting').toBe(1);
  expect(count(/GET \/api\/v1\/area-demand\/forecast$/), 'the strip and the /waiting curve ask each hour once (6 hours at most)').toBeLessThanOrEqual(6);
  expect(count(/POST \/api\/v1\/courses\/plan$/), 'the session prefetch plans the course once').toBeLessThanOrEqual(1);
  // 사장님 콘솔 데모는 Render 를 부르지 않는다 — 콘솔 조회(/merchant/*)도 ① 예측(/predict/*)도 없다.
  expect((byStep.merchant ?? []).filter((c) => /\/api\/v1\/merchant\/|\/predict\//.test(c)), (byStep.merchant ?? []).join(', ')).toEqual([]);
  expect(render.length, JSON.stringify(byStep)).toBeLessThanOrEqual(JOURNEY_CEILING);
});
