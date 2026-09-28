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
/** 몇 번째 by-type 요청인지(0부터)와 그 요청을 보고, 응답 전에 기다리거나 다른 상태 코드를 고른다. */
type Respond = (call: ByTypeCall, index: number) => Promise<number | void> | number | void;

/** by-type 를 기록하고, 음식점만 가정 시각에 맞는 장소 하나를 돌려준다. holdNow 면 'now'(assumed_at=null) 응답을 붙잡는다. */
async function routeBoard(page: Page, opts: { holdNow?: Promise<void>; respond?: Respond } = {}): Promise<ByTypeCall[]> {
  const calls: ByTypeCall[] = [];
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/recommendations/by-type', async (route: Route) => {
    const body = route.request().postDataJSON() as { facility_type?: string; assumed_at?: string | null };
    const call = { type: String(body.facility_type ?? ''), assumedAt: body.assumed_at ?? null };
    const index = calls.push(call) - 1;
    if (call.assumedAt === null && opts.holdNow) await opts.holdNow;
    const status = (await opts.respond?.(call, index)) ?? 200;
    if (status !== 200) {
      await route.fulfill({ status, contentType: 'application/json', body: '{"detail":"e2e"}' }).catch(() => {});
      return;
    }
    const items = call.type === 'restaurant' ? [item(call.assumedAt === null ? NOW_PLACE : SAT_PLACE)] : [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) }).catch(() => {});
  });
  return calls;
}

/** 브라우저가 중간에 끊은(취소한) by-type 요청. */
function recordAborted(page: Page): ByTypeCall[] {
  const aborted: ByTypeCall[] = [];
  page.on('requestfailed', (request) => {
    if (!request.url().includes('/api/v1/recommendations/by-type')) return;
    const body = request.postDataJSON() as { facility_type?: string; assumed_at?: string | null };
    aborted.push({ type: String(body.facility_type ?? ''), assumedAt: body.assumed_at ?? null });
  });
  return aborted;
}

/** 'now' 로 시작하고 보드 캐시는 비운 채 연다(새로고침에는 다시 비우지 않는다). */
async function seedNowWithoutCache(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    if (!sessionStorage.getItem('e2e_seeded')) {
      sessionStorage.setItem('e2e_seeded', '1');
      localStorage.setItem('nextspot_assumed_at', 'now');
      localStorage.removeItem('nextspot_waiting_board_v2');
    }
  });
}

const presetSelect = (page: Page) => page.getByRole('combobox', { name: '가정 시간' });
const loader = (page: Page) => page.locator('.ns-progress');
const nowCalls = (calls: ByTypeCall[]) => calls.filter((c) => c.assumedAt === null).length;
const satCalls = (calls: ByTypeCall[]) => calls.filter((c) => c.assumedAt !== null).length;
const cachedPresetOf = (page: Page) => page.evaluate(() => {
  try { return (JSON.parse(localStorage.getItem('nextspot_waiting_board_v2') ?? '{}') as { preset?: string }).preset ?? null; }
  catch { return null; }
});

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

test('waiting board: switching back to the preset already on screen hides the loader at once', async ({ page }) => {
  await seedNowWithoutCache(page);
  // 첫 'now' 보드는 그대로 끝낸다. 그 뒤로는 토요일 조회와 'now' 조용한 새로고침을 서버에서 붙잡는다.
  let holding = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const calls = await routeBoard(page, { respond: async () => { if (holding) await held; } });

  await page.goto('/waiting');
  await expect(page.getByText(NOW_PLACE).first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => nowCalls(calls), { timeout: 10_000 }).toBe(4);
  holding = true;

  await presetSelect(page).selectOption('sat_afternoon');
  await expect(loader(page)).toBeVisible();
  await expect.poll(() => satCalls(calls)).toBeGreaterThan(0);

  // 토요일이 아직 오는 중에 원래 보던 'now' 로 돌아간다 — 그 보드가 곧바로 다시 보인다(서버는 아직 답하지 않았다).
  await presetSelect(page).selectOption('now');
  await expect(loader(page)).toHaveCount(0, { timeout: 2_000 });
  await expect(page.getByText(NOW_PLACE).first()).toBeVisible();
  await expect(page.getByText(SAT_PLACE)).toHaveCount(0);

  release();
  await page.waitForTimeout(1000);
  await expect(page.getByText(NOW_PLACE).first()).toBeVisible();
  await expect(page.getByText(SAT_PLACE)).toHaveCount(0);
});

test('waiting board: A→B→A runs one chain for A and cancels the abandoned requests', async ({ page }) => {
  await seedNowWithoutCache(page);
  const aborted = recordAborted(page);
  // 첫 'now' 조회의 음식점 요청과 첫 토요일 요청을 붙잡는다 — 둘 다 버려진 조회의 '가는 중' 요청이 된다.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const calls = await routeBoard(page, { respond: async (_call, index) => { if (index < 2) await held; } });

  await page.goto('/waiting');
  await expect.poll(() => nowCalls(calls), { timeout: 30_000 }).toBe(1);
  await presetSelect(page).selectOption('sat_afternoon');
  await expect.poll(() => satCalls(calls)).toBe(1);
  await presetSelect(page).selectOption('now');
  await expect(page.getByText(NOW_PLACE).first()).toBeVisible({ timeout: 30_000 });

  // 버려진 두 요청은 브라우저가 끊었다 — 새 조회의 첫 요청과 겹쳐 서버에 두 벌이 걸리지 않는다.
  await expect.poll(() => aborted.length).toBe(2);
  expect(aborted).toEqual([{ type: 'restaurant', assumedAt: null }, expect.objectContaining({ type: 'restaurant' })]);

  release();
  await page.waitForTimeout(2000);
  // 'now' 는 버려진 1건 + 새 조회 4유형뿐 — 처음 조회가 되살아나 카페·관광지·문화를 따로 묻지 않는다.
  expect(nowCalls(calls)).toBe(5);
  expect(satCalls(calls)).toBe(1);
});

test('waiting board: a pending auto-retry of an abandoned run never starts a second chain', async ({ page }) => {
  await seedNowWithoutCache(page);
  // 첫 'now' 조회 4유형은 세션 준비 전(401)으로 전부 실패 → 2.5초 뒤 자동 재시도 1회가 예약된다.
  // 토요일은 붙잡아 두고, 그 사이에 'now' 로 돌아간다. 새 'now' 조회도 예약된 재시도가 돌고(2.5초)
  // 두 번째 패스(2초)까지 끝낼 만큼 붙잡아 둔다 — 버려진 run 이 그동안 화면을 건드리면 여기서 드러난다.
  let releaseSat!: () => void;
  const satHeld = new Promise<void>((resolve) => { releaseSat = resolve; });
  let releaseNow!: () => void;
  const nowHeld = new Promise<void>((resolve) => { releaseNow = resolve; });
  const calls = await routeBoard(page, {
    respond: async (call, index) => {
      if (call.assumedAt !== null) { await satHeld; return; }
      if (index < 4) return 401;
      await nowHeld;
    },
  });

  await page.goto('/waiting');
  await expect.poll(() => nowCalls(calls), { timeout: 30_000 }).toBe(4);
  await presetSelect(page).selectOption('sat_afternoon');
  await expect.poll(() => satCalls(calls)).toBe(1);
  await presetSelect(page).selectOption('now');
  await expect.poll(() => nowCalls(calls)).toBe(5);
  releaseSat();

  await page.waitForTimeout(6000);
  // 새 조회는 아직 기다리는 중 — 로더 그대로, 에러 화면이 끼어들지 않았다.
  await expect(loader(page)).toBeVisible();
  await expect(page.getByText('잠시 후 다시 불러올게요.')).toHaveCount(0);
  releaseNow();
  await expect(page.getByText(NOW_PLACE).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  await expect(page.getByText(NOW_PLACE).first()).toBeVisible();
  // 'now' 는 버려진 run 의 4건 + 새 run 의 4건뿐.
  expect(nowCalls(calls)).toBe(8);
  expect(satCalls(calls)).toBe(1);
});

test('waiting board: an abandoned run whose last retry was cut off never draws or caches its board', async ({ page }) => {
  await seedNowWithoutCache(page);
  // 'now' 첫 패스의 마지막 유형(문화)이 500 → 2초 뒤 두 번째 패스가 문화를 다시 묻는다. 그 요청을 붙잡은 채
  // 토요일로 바꾼다. 토요일도 붙잡아 두어, 버려진 'now' 조회가 끝까지 가도 가려 줄 새 보드가 없다 —
  // 마지막 확인(루프 밖)만이 옛 보드를 막는다.
  let releaseSat!: () => void;
  const satHeld = new Promise<void>((resolve) => { releaseSat = resolve; });
  let nowCultureSeen = 0;
  const calls = await routeBoard(page, {
    respond: async (call) => {
      if (call.assumedAt !== null) { await satHeld; return; }
      if (call.type !== 'culture') return;
      nowCultureSeen += 1;
      if (nowCultureSeen === 1) return 500;
      await new Promise<void>(() => {}); // 두 번째 패스의 문화 요청 — 끊기기 전까지 답하지 않는다
    },
  });

  await page.goto('/waiting');
  await expect.poll(() => nowCultureSeen, { timeout: 30_000 }).toBe(2);
  await presetSelect(page).selectOption('sat_afternoon');
  await expect.poll(() => satCalls(calls)).toBe(1);

  await page.waitForTimeout(1500);
  await expect(page.getByText(NOW_PLACE)).toHaveCount(0);
  await expect(loader(page)).toBeVisible();
  expect(await cachedPresetOf(page)).toBeNull();

  releaseSat();
  await expect(page.getByText(SAT_PLACE).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(NOW_PLACE)).toHaveCount(0);
  expect(await cachedPresetOf(page)).toBe('sat_afternoon');
});
