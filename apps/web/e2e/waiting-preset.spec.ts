import { expect, test, type Page, type Route } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// /waiting 보드 조회(4유형 순차 by-type)와 가정 시각 프리셋.
// - 저장된 프리셋을 읽기 전의 초기값 'now' 로 한 벌을 먼저 보내지 않는다(서버 부하 두 배·늦게 끝나면 배지와 다른 보드).
// - 조회 도중 프리셋이 바뀌면 옛 조회는 남은 유형을 묻지 않고, 늦게 온 결과도 그리지·캐시하지 않는다.
// 응답은 가정 시각에 따라 이름이 다른 장소를 돌려준다 — 화면에 어느 시각의 보드가 그려졌는지 이름으로 본다.

test.beforeEach(async ({ page }) => stubExternalServices(page));

const NOW_PLACE = '지금기준 식당';
const SAT_PLACE = '토요일기준 식당';

function item(name: string, extra: { type?: string; wait?: number } = {}) {
  const facility = {
    id: `f-${name}`, name, type: extra.type ?? 'restaurant', latitude: 35.8363, longitude: 129.2107,
    capacity: 30, congestion: null, image_url: null, gallery_images: null, features: {},
    operating_hours: { open: '00:00~23:59', closed: '연중무휴' },
  };
  return {
    recommendation_id: `rec-${name}`, facility, spot_score: 0.8,
    breakdown: { preference: 0.8, wait_time: extra.wait ?? null, travel_time: 1, incentive: 0 },
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

/**
 * by-type 를 기록하고, 음식점만 가정 시각에 맞는 장소 하나를 돌려준다. holdNow 면 'now'(assumed_at=null) 응답을 붙잡는다.
 * cafePlace 를 주면 카페도 그 이름의 장소 하나를, waitMinutes 를 주면 음식점이 서버 검증 대기(분)를 함께 돌려준다.
 */
async function routeBoard(
  page: Page,
  opts: { holdNow?: Promise<void>; respond?: Respond; cafePlace?: string; waitMinutes?: number } = {},
): Promise<ByTypeCall[]> {
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
    const items =
      call.type === 'restaurant'
        ? [item(call.assumedAt === null ? NOW_PLACE : SAT_PLACE, { wait: opts.waitMinutes })]
        : call.type === 'cafe' && opts.cafePlace
        ? [item(opts.cafePlace, { type: 'cafe' })]
        : [];
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
// 섹션은 도착하는 대로 보인다(I36) — 첫 카드가 보여도 나머지 유형은 아직 묻는 중일 수 있다. 요청 수·캐시를
// 세는 검사는 보드가 다 찬 뒤(aria-busy=false)에 한다.
const boardOf = (page: Page) => page.locator('main [aria-busy]');
const boardComplete = (page: Page) => expect(boardOf(page)).toHaveAttribute('aria-busy', 'false', { timeout: 10_000 });

test('waiting board: a stored far preset never sends a "now" board request first', async ({ page }) => {
  test.setTimeout(90_000); // 첫 /waiting 컴파일(Windows dev server) 여유 — 재시도가 아니라 시간
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
  test.setTimeout(90_000); // 첫 /waiting 컴파일(Windows dev server) 여유 — 재시도가 아니라 시간
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
  test.setTimeout(90_000); // 첫 /waiting 컴파일(Windows dev server) 여유 — 재시도가 아니라 시간
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
  test.setTimeout(90_000); // 첫 /waiting 컴파일(Windows dev server) 여유 — 재시도가 아니라 시간
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

/**
 * 대기 보드의 유예 타이머(두 번째 패스 전 2초 · 전멸 뒤 자동 재시도 2.5초)를 벽시계 대신 시험이 움직인다.
 * 시계를 멈춘 뒤에는 그 타이머가 runFor 로만 돈다 — 느린 머신에서 프리셋 전환이 창을 놓쳐 다른 길을 타는 일이 없다.
 * 페이지가 건 타이머의 지연(ms)을 기록해, 조회가 정말 그 유예에 들어섰는지 확인한 뒤에 프리셋을 바꾼다.
 */
async function controlBoardTimers(page: Page): Promise<{ pause: () => Promise<void>; waitForTimer: (ms: number) => Promise<void> }> {
  await page.clock.install();
  await page.addInitScript(() => {
    const w = window as unknown as { __boardTimers: number[] };
    w.__boardTimers = [];
    const fake = window.setTimeout;
    window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms === 2000 || ms === 2500) w.__boardTimers.push(ms);
      return fake(handler, ms, ...args);
    }) as typeof window.setTimeout;
  });
  let seen = { 2000: 0, 2500: 0 } as Record<number, number>;
  const count = async (ms: number) =>
    page.evaluate((m) => (window as unknown as { __boardTimers: number[] }).__boardTimers.filter((x) => x === m).length, ms);
  return {
    pause: async () => {
      seen = { 2000: await count(2000), 2500: await count(2500) };
      // 설치된 시계는 멈추기 전까지 흐른다 — 부하 걸린 머신에서는 시각을 읽고 pauseAt 이 닿기까지 10ms 넘게 흘러
      // 'Cannot fast-forward to the past' 로 실패했다(전체 e2e 실측). 여유를 두고, 그래도 지나쳤으면 새 시각으로 다시.
      for (let attempt = 0; ; attempt++) {
        const at = (await page.evaluate(() => Date.now())) + 100;
        try {
          await page.clock.pauseAt(at);
          return;
        } catch (error) {
          if (attempt >= 4 || !String(error).includes('fast-forward to the past')) throw error;
        }
      }
    },
    // pause 뒤에 새로 걸린 그 지연의 타이머가 생길 때까지 — 멈춘 시계라 아직 돌지 않았다.
    waitForTimer: async (ms: number) => {
      await expect.poll(() => count(ms), { timeout: 30_000 }).toBeGreaterThan(seen[ms]);
      seen[ms] = await count(ms);
    },
  };
}

test('waiting board: an abandoned run sleeping before its second pass never asks again', async ({ page }) => {
  test.setTimeout(90_000); // 첫 /waiting 컴파일(Windows dev server) 여유 — 재시도가 아니라 시간
  await seedNowWithoutCache(page);
  const timers = await controlBoardTimers(page);
  const aborted = recordAborted(page);
  // 첫 'now' 조회 4유형은 세션 준비 전(401)으로 전부 실패 → 2초 유예 뒤 두 번째 패스가 실패한 유형을 다시 묻는다.
  // 그 유예 동안 토요일로 갔다가(붙잡힘) 'now' 로 돌아온다. 새 'now' 조회도 붙잡아 둔다 —
  // 버려진 run 이 유예에서 깨어나 두 번째 패스를 돌거나 화면을 건드리면 여기서 드러난다.
  let releaseFourth!: () => void;
  const fourthHeld = new Promise<void>((resolve) => { releaseFourth = resolve; });
  let releaseSat!: () => void;
  const satHeld = new Promise<void>((resolve) => { releaseSat = resolve; });
  let releaseNow!: () => void;
  const nowHeld = new Promise<void>((resolve) => { releaseNow = resolve; });
  const calls = await routeBoard(page, {
    respond: async (call, index) => {
      if (call.assumedAt !== null) { await satHeld; return; }
      if (index < 3) return 401;
      if (index === 3) { await fourthHeld; return 401; }
      await nowHeld;
    },
  });

  await page.goto('/waiting');
  await expect.poll(() => nowCalls(calls), { timeout: 60_000 }).toBe(4);
  await timers.pause();
  releaseFourth();
  await timers.waitForTimer(2000); // 첫 패스 전멸 → 두 번째 패스 전 2초 유예에 들어섰다

  await presetSelect(page).selectOption('sat_afternoon');
  await expect.poll(() => satCalls(calls)).toBe(1);
  await presetSelect(page).selectOption('now');
  await expect.poll(() => nowCalls(calls)).toBe(5);
  releaseSat();

  await page.clock.runFor(6000); // 버려진 run 의 2초 유예가 끝난다(새 run 은 서버 응답을 기다리는 중)
  await page.waitForTimeout(500); // 두 번째 패스가 잘못 나간다면 요청이 도착할 틈
  // 새 조회는 아직 기다리는 중 — 로더 그대로, 에러 화면이 끼어들지 않았고, 버려진 run 은 더 묻지 않았다.
  await expect(loader(page)).toBeVisible();
  await expect(page.getByText('잠시 후 다시 불러올게요.')).toHaveCount(0);
  expect(nowCalls(calls)).toBe(5);
  expect(aborted.filter((c) => c.assumedAt === null)).toEqual([]);

  await page.clock.resume();
  releaseNow();
  await expect(page.getByText(NOW_PLACE).first()).toBeVisible({ timeout: 30_000 });
  await boardComplete(page);
  // 'now' 는 버려진 run 의 첫 패스 4건 + 새 run 의 4건뿐.
  expect(nowCalls(calls)).toBe(8);
  expect(satCalls(calls)).toBe(1);
});

// 버려진 run 의 예약된 자동 재시도(2.5초)가 돌 때: 같은 프리셋으로 돌아와 있든(A→B→A) 다른 프리셋에 있든(A→B),
// 그 재시도는 지금 도는 조회를 끊거나 두 번째 조회를 열지 않는다.
for (const back of [true, false]) {
  const route = back ? 'now → sat → now' : 'now → sat';
  test(`waiting board: a pending auto-retry of an abandoned run leaves the live run alone (${route})`, async ({ page }) => {
    test.setTimeout(90_000);
    await seedNowWithoutCache(page);
    const timers = await controlBoardTimers(page);
    const aborted = recordAborted(page);
    // 첫 'now' 조회는 첫 패스 4건 + 두 번째 패스 4건이 전부 401 → 2.5초 뒤 자동 재시도 1회가 예약된다.
    // 그 예약이 걸린 뒤(시계는 멈춤) 프리셋을 바꾸고, 예약 시각을 지나 보낸다. 새 조회의 요청은 붙잡아 둔다.
    let releaseLast!: () => void;
    const lastHeld = new Promise<void>((resolve) => { releaseLast = resolve; });
    let releaseSat!: () => void;
    const satHeld = new Promise<void>((resolve) => { releaseSat = resolve; });
    let releaseNow!: () => void;
    const nowHeld = new Promise<void>((resolve) => { releaseNow = resolve; });
    const calls = await routeBoard(page, {
      respond: async (call, index) => {
        if (call.assumedAt !== null) { await satHeld; return; }
        if (index < 7) return 401;
        if (index === 7) { await lastHeld; return 401; }
        await nowHeld;
      },
    });

    await page.goto('/waiting');
    await expect.poll(() => nowCalls(calls), { timeout: 60_000 }).toBe(8);
    await timers.pause();
    releaseLast();
    await timers.waitForTimer(2500); // 두 번째 패스도 전멸 → 자동 재시도가 예약됐다(아직 돌지 않음)

    await presetSelect(page).selectOption('sat_afternoon');
    await expect.poll(() => satCalls(calls)).toBe(1);
    if (back) {
      await presetSelect(page).selectOption('now');
      await expect.poll(() => nowCalls(calls)).toBe(9);
    }
    await page.clock.runFor(3000); // 예약된 재시도가 돈다
    await page.waitForTimeout(500); // 잘못 열린 조회가 있다면 요청·취소가 도착할 틈

    // 지금 도는 조회는 끊기지 않았고 새 조회도 열리지 않았다 — 로더가 떠 있고 에러 화면은 없다.
    expect(nowCalls(calls)).toBe(back ? 9 : 8);
    expect(satCalls(calls)).toBe(1);
    expect(aborted).toEqual(back ? [expect.objectContaining({ type: 'restaurant', assumedAt: expect.any(String) })] : []);
    await expect(loader(page)).toBeVisible();
    await expect(page.getByText('잠시 후 다시 불러올게요.')).toHaveCount(0);

    await page.clock.resume();
    releaseSat();
    releaseNow();
    const place = back ? NOW_PLACE : SAT_PLACE;
    await expect(page.getByText(place).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(back ? SAT_PLACE : NOW_PLACE)).toHaveCount(0);
    await boardComplete(page);
    expect(await cachedPresetOf(page)).toBe(back ? 'now' : 'sat_afternoon');
    // 'now' 는 버려진 run 의 8건 + (돌아왔다면) 새 run 의 4건뿐.
    expect(nowCalls(calls)).toBe(back ? 12 : 8);
  });
}

test('waiting board: an abandoned run whose last retry was cut off never draws or caches its board', async ({ page }) => {
  test.setTimeout(90_000); // 첫 /waiting 컴파일(Windows dev server) 여유 — 재시도가 아니라 시간
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
  await boardComplete(page);
  expect(await cachedPresetOf(page)).toBe('sat_afternoon');
});

// ── 섹션은 도착하는 대로(I36) ───────────────────────────────────────────────────
// 4유형은 여전히 한 번에 하나씩 묻는다(동시 요청은 0.5CPU 서버가 503). 다만 앞 유형이 모두 도착했으면 그 섹션은
// 마지막 유형을 기다리지 않고 바로 그린다. 로딩 상태·'화면의 프리셋'·캐시는 보드가 다 찼을 때만 바뀐다.
const CAFE_PLACE = '지금기준 카페';
const sectionSkeleton = (page: Page) => page.locator('main [aria-busy] .ns-skel');

test('waiting board: the first section shows while the rest are on their way', async ({ page }) => {
  test.setTimeout(90_000); // 첫 /waiting 컴파일(Windows dev server) 여유 — 재시도가 아니라 시간
  await seedNowWithoutCache(page);
  // 음식점 뒤의 유형(카페·관광지·문화)은 서버에서 붙잡는다.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const calls = await routeBoard(page, { respond: async (call) => { if (call.type !== 'restaurant') await held; } });

  await page.goto('/waiting');
  await expect.poll(() => nowCalls(calls), { timeout: 30_000 }).toBeGreaterThan(1);
  await expect(page.getByText(NOW_PLACE).first()).toBeVisible({ timeout: 10_000 });
  // 로더는 내려가고, 아직 오는 섹션 자리에는 글자 없는 자리표시 한 판. 보드는 아직 '불러오는 중'이고 캐시도 없다.
  await expect(loader(page)).toHaveCount(0);
  await expect(boardOf(page)).toHaveAttribute('aria-busy', 'true');
  await expect(sectionSkeleton(page).first()).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('nextspot_waiting_board_v2'))).toBeNull();

  release();
  await expect(boardOf(page)).toHaveAttribute('aria-busy', 'false', { timeout: 10_000 });
  await expect(page.locator('.ns-skel')).toHaveCount(0);
  expect(await cachedPresetOf(page)).toBe('now');
  // 카드는 보여 줄 수 있는 것만 약속한다 — 도착 시각은 분까지, 근거가 없는 카드에 '수집 중' 머리줄은 없다.
  await expect(page.getByText(/\d{2}:\d{2} 도착 예측/).first()).toBeVisible();
  await expect(page.getByText('대기 정보 수집')).toHaveCount(0);
  await expect(page.getByText('근거가 없는')).toHaveCount(0);
});

test('waiting board: a failed earlier type never lets a later section jump above it', async ({ page }) => {
  test.setTimeout(90_000); // 첫 /waiting 컴파일(Windows dev server) 여유 — 재시도가 아니라 시간
  await seedNowWithoutCache(page);
  // 음식점 첫 요청은 500 → 카페는 바로 답하지만, 2초 뒤 두 번째 패스의 음식점은 붙잡는다.
  let restaurantSeen = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const calls = await routeBoard(page, {
    cafePlace: CAFE_PLACE,
    respond: async (call) => {
      if (call.type !== 'restaurant') return;
      restaurantSeen += 1;
      if (restaurantSeen === 1) return 500;
      await held;
    },
  });

  await page.goto('/waiting');
  await expect.poll(() => restaurantSeen, { timeout: 60_000 }).toBe(2);
  expect(calls.some((c) => c.type === 'cafe')).toBe(true);
  // 카페는 이미 도착했지만 음식점 자리가 비어 있는 동안에는 그리지 않는다 — 뒤에 음식점이 그 위로 끼어들게 된다.
  await expect(loader(page)).toBeVisible();
  await expect(page.getByText(CAFE_PLACE)).toHaveCount(0);

  release();
  await expect(page.getByText(CAFE_PLACE).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(NOW_PLACE).first()).toBeVisible();
  const [restaurantAt, cafeAt] = await page.evaluate(
    ([a, b]) => [document.body.innerText.indexOf(a), document.body.innerText.indexOf(b)],
    [NOW_PLACE, CAFE_PLACE],
  );
  expect(restaurantAt).toBeGreaterThanOrEqual(0);
  expect(restaurantAt, '음식점 섹션이 카페 섹션 위에').toBeLessThan(cafeAt);
});

test('waiting board: a partial board of another preset never shows under the one on screen', async ({ page }) => {
  test.setTimeout(90_000); // 첫 /waiting 컴파일(Windows dev server) 여유 — 재시도가 아니라 시간
  await seedNowWithoutCache(page);
  // 첫 'now' 보드는 그대로 끝낸다. 그 뒤로는 카페 요청을 붙잡는다 — 토요일 보드는 음식점까지만 온다.
  let holding = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const calls = await routeBoard(page, { respond: async (call) => { if (holding && call.type === 'cafe') await held; } });

  await page.goto('/waiting');
  await expect(page.getByText(NOW_PLACE).first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => nowCalls(calls), { timeout: 10_000 }).toBe(4);
  await expect.poll(() => cachedPresetOf(page)).toBe('now');
  holding = true;

  await presetSelect(page).selectOption('sat_afternoon');
  await expect(page.getByText(SAT_PLACE).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(NOW_PLACE)).toHaveCount(0);

  // 토요일이 반쯤 온 채로 원래 보던 'now' 로 돌아간다 — 'now' 의 다 찬 보드가 보이고, 토요일 조각은 섞이지 않는다.
  await presetSelect(page).selectOption('now');
  await expect(page.getByText(NOW_PLACE).first()).toBeVisible({ timeout: 2_000 });
  await expect(page.getByText(SAT_PLACE)).toHaveCount(0);

  release();
  await page.waitForTimeout(1000);
  await expect(page.getByText(SAT_PLACE)).toHaveCount(0);
  expect(await cachedPresetOf(page)).toBe('now');
});

test('waiting board: no stale shortest-wait chip while a new preset is loading', async ({ page }) => {
  test.setTimeout(90_000); // 첫 /waiting 컴파일(Windows dev server) 여유 — 재시도가 아니라 시간
  await seedNowWithoutCache(page);
  let holding = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  // 음식점이 서버 검증 대기 12분을 돌려준다 — 히어로 '도착 시 최단 대기' 칩이 뜬다.
  const calls = await routeBoard(page, { waitMinutes: 12, respond: async () => { if (holding) await held; } });
  const chip = page.getByText(/도착 시 최단 대기/);

  await page.goto('/waiting');
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => cachedPresetOf(page), { timeout: 10_000 }).toBe('now');
  holding = true;

  // 토요일 조회가 전부 붙잡힌 동안(로더) 'now' 보드의 최단 대기가 토요일 배지 옆에 남지 않는다.
  await presetSelect(page).selectOption('sat_afternoon');
  await expect.poll(() => satCalls(calls)).toBeGreaterThan(0);
  await expect(loader(page)).toBeVisible();
  await expect(chip).toHaveCount(0);

  release();
  await expect(page.getByText(SAT_PLACE).first()).toBeVisible({ timeout: 30_000 });
});
