import { expect, test, type Page, type Route } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// /waiting 보드 조회(4유형 순차 by-type)와 가정 시각 프리셋.
// - 저장된 프리셋을 읽기 전의 초기값 'now' 로 한 벌을 먼저 보내지 않는다(서버 부하 두 배·늦게 끝나면 배지와 다른 보드).
// - 조회 도중 프리셋이 바뀌면 옛 조회는 남은 유형을 묻지 않고, 늦게 온 결과도 그리지·캐시하지 않는다.
// 응답은 가정 시각에 따라 이름이 다른 장소를 돌려준다 — 화면에 어느 시각의 보드가 그려졌는지 이름으로 본다.

test.beforeEach(async ({ page }) => stubExternalServices(page));

const NOW_PLACE = '지금기준 식당';
const SAT_PLACE = '토요일기준 식당';

function item(name: string) {
  const facility = {
    id: `f-${name}`, name, type: 'restaurant', latitude: 35.8363, longitude: 129.2107,
    capacity: 30, congestion: null, image_url: null, gallery_images: null, features: {},
    operating_hours: { open: '00:00~23:59', closed: '연중무휴' },
  };
  return {
    recommendation_id: `rec-${name}`, facility, spot_score: 0.8,
    breakdown: { preference: 0.8, wait_time: null, travel_time: 1, incentive: 0 },
    distance_m: 90, reason: '테스트 추천', reason_source: 'template',
    congestion_level: null, congestion_source: 'none', congestion_log_source: null,
    congestion_is_stale: null, congestion_timestamp: null, rank: 1, total_candidates: 1,
    open_status_at_arrival: 'open_expected', information_confidence: 'verified', eligibility_tier: 'verified_open_route',
    place_data_source: 'test', data_updated_at: null,
    scoring_mode: 'degraded_rules', model_version: null, prediction_source: 'unavailable',
  };
}

type ByTypeCall = { type: string; assumedAt: string | null };

/** by-type 를 기록하고, 음식점만 가정 시각에 맞는 장소 하나를 돌려준다. holdNow 면 'now'(assumed_at=null) 응답을 붙잡는다. */
async function routeBoard(page: Page, opts: { holdNow?: Promise<void> } = {}): Promise<ByTypeCall[]> {
  const calls: ByTypeCall[] = [];
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/recommendations/by-type', async (route: Route) => {
    const body = route.request().postDataJSON() as { facility_type?: string; assumed_at?: string | null };
    const call = { type: String(body.facility_type ?? ''), assumedAt: body.assumed_at ?? null };
    calls.push(call);
    if (call.assumedAt === null && opts.holdNow) await opts.holdNow;
    const items = call.type === 'restaurant' ? [item(call.assumedAt === null ? NOW_PLACE : SAT_PLACE)] : [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) }).catch(() => {});
  });
  return calls;
}

test('waiting board: a stored far preset never sends a "now" board request first', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    localStorage.setItem('nextspot_assumed_at', 'sat_afternoon');
  });
  const calls = await routeBoard(page);
  await page.goto('/waiting');
  await expect(page.getByText(SAT_PLACE).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500); // 뒤늦은 한 벌이 있으면 여기까지 나간다
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.filter((c) => c.assumedAt === null)).toEqual([]);
  await expect(page.getByText(NOW_PLACE)).toHaveCount(0);
});

test('waiting board: switching the preset mid-load drops the old board and stops its requests', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    if (!sessionStorage.getItem('e2e_seeded')) {
      sessionStorage.setItem('e2e_seeded', '1');
      localStorage.setItem('nextspot_assumed_at', 'now');
      localStorage.removeItem('nextspot_waiting_board_v2');
    }
  });
  let release!: () => void;
  const holdNow = new Promise<void>((resolve) => { release = resolve; });
  const calls = await routeBoard(page, { holdNow });

  await page.goto('/waiting');
  // 'now' 조회의 첫 유형이 서버에서 붙잡혀 있는 동안 토 14:00 으로 바꾼다.
  await expect.poll(() => calls.filter((c) => c.assumedAt === null).length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.getByRole('combobox', { name: '가정 시간' }).selectOption('sat_afternoon');
  await expect(page.getByText(SAT_PLACE).first()).toBeVisible({ timeout: 30_000 });
  const nowCallsAtSwitch = calls.filter((c) => c.assumedAt === null).length;

  release();
  await page.waitForTimeout(2000);
  // 옛 조회는 남은 유형(카페·관광지·문화)을 묻지 않았고, 늦게 온 결과가 토요일 보드를 덮지 않았다.
  expect(calls.filter((c) => c.assumedAt === null).length).toBe(nowCallsAtSwitch);
  await expect(page.getByText(SAT_PLACE).first()).toBeVisible();
  await expect(page.getByText(NOW_PLACE)).toHaveCount(0);
  const cachedPreset = await page.evaluate(() => {
    try { return (JSON.parse(localStorage.getItem('nextspot_waiting_board_v2') ?? '{}') as { preset?: string }).preset ?? null; }
    catch { return null; }
  });
  expect(cachedPreset).toBe('sat_afternoon');
});
