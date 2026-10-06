import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { stubMain, type E2eLocale } from './support/mainStubs';
import { expandPeek } from './support/recCard';
import { stubFakeKakaoMap, type FakePin, type KakaoFakeWindow } from './support/fakeKakaoMap';
import { stubExternalServices } from './support/stubs';

// 계획 B3 — /main 지도 · 혼잡 예측 줄 · 툴바 · 휴대폰 머리(심사위원이 기능 1 을 찾는 자리).
//   · '🔮 혼잡 예측' 줄: 데스크톱은 스크롤 없이 지도 아래 가운데(카드·Kakao 로고와 겹치지 않는다), 휴대폰은 미리보기 바로 위.
//   · '+2시간 후'(누르기 · 끌기 · 방향키) → 배지에 '예측', 카드에 '+2시간 후 기준', 추천 요청 assumed_at = 지금+2시간.
//     예측 모델이 학습 전이면 /predict/batch 를 부르지 않고 경주 중심 권역 곡선을 쓴다. 곡선도 없으면 알림 한 줄과 '지금'.
//   · 상대 시각은 이 화면 상태로만 — /waiting 의 '가정 시간' 선택지와 저장소에 남지 않는다. 요일은 '다른 시간 ▾'.
//   · 핀: 24시간 안쪽 실측만 칠하고, 46일 전 관측은 빈 핀, 서버 상위 추천은 보통 크기 + 순위.
//   · 툴바는 두 줄(4개 언어), 출처 칩 하나, 휴대폰 머리 ≤ 280px(390×844), 지도 띠 ≥ 180px(360×640), 펼친 카드는 검색창 아래.
//   · 출처(ⓒ한국관광공사)는 /main · /waiting · /course · /explore/recommend 에 보인다. 야간(다크)에서도 같다.

test.beforeEach(async ({ page }) => stubExternalServices(page));

const LAT = 35.8355;
const LNG = 129.2105;
const TOUR_PHOTO = 'https://tong.visitkorea.or.kr/cms/resource/01/e2e_ok_image2_1.jpg';
type Row = Record<string, unknown> & { id: string; name: string; type: string };

function place(id: string, name: string, type: string, i: number, extra: Record<string, unknown> = {}): Row {
  return {
    id, name, type,
    latitude: LAT + (i % 4) * 0.0011 - 0.001,
    longitude: LNG + Math.floor(i / 4) * 0.0014 - 0.0012,
    capacity: 30, features: {}, congestion: null,
    operating_hours: { open: '00:00~23:59', closed: '연중무휴' },
    ...extra,
  };
}
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const ATTRACTIONS = [
  place('att-gyerim', '경주 계림', 'attraction', 0, { image_url: TOUR_PHOTO, contentid: '126207', contenttypeid: 12, operating_hours: { open: '상시 개방', closed: '연중무휴' } }),
  place('att-2', '경주 향교', 'attraction', 1),
  place('att-3', '교촌 한옥마을', 'attraction', 2, {
    congestion: { level: 0.28, current_count: null, timestamp: minutesAgo(6), source: 'traffic_cctv', is_stale: false, is_current: true },
  }),
  place('att-4', '월정교 산책길', 'attraction', 3),
  place('att-5', '첨성대 꽃밭', 'attraction', 4),
  place('att-old', '오래된 관측 고분', 'attraction', 7, {
    congestion: { level: 0.9, current_count: null, timestamp: minutesAgo(46 * 24 * 60), source: 'user_report', is_stale: true, is_current: false },
  }),
];
const DAEREUNGWON = place('anchor-drw', '대릉원', 'attraction', 5, {
  congestion: { level: 0.88, current_count: null, timestamp: minutesAgo(5), source: 'user_report', is_stale: false, is_current: true },
});

function rec(row: Row, rank: number) {
  return {
    recommendation_id: `rec-${row.id}`, facility: row, spot_score: 0.8 - rank * 0.03, distance_m: 200 + rank * 50,
    rank, total_candidates: 5, reason: `${row.name} 추천`, reason_source: 'template',
    congestion_level: rank === 1 ? 0.2 : null, congestion_source: rank === 1 ? 'measured' : 'none',
    congestion_is_current: rank === 1 ? true : null, congestion_timestamp: rank === 1 ? minutesAgo(4) : null,
    open_status_at_arrival: 'open_expected', scoring_mode: 'area_stats_rules', prediction_source: 'unavailable',
    breakdown: {
      preference: 0.82 - rank * 0.04, wait_time: null, travel_time: 3.4 + rank, incentive: 0,
      area_demand_level: 0.62, area_demand_mode: 'live', area_demand_sources: ['parking', 'tourism'],
      area_demand_tourism_evidence: { reference_name: '대릉원', distance_m: 420, forecast_date: '2026-10-07', relative_index: 74 },
    },
  };
}
const ATTRACTION_RECS = () => ATTRACTIONS.slice(0, 5).map((row, i) => rec(row, i + 1));

interface Calls { byType: { assumedAt: string | null; at: number }[]; batch: number; forecast: number; modelInfo: number }

interface OpenOptions {
  theme?: 'light' | 'dark';
  locale?: E2eLocale;
  url?: string;
  prefs?: Record<string, unknown>;
  facilities?: Row[];
  byType?: (type: string) => unknown[];
  /** 추천 요청 본문으로 답을 정한다(♿ · assumed_at 에 따라 다른 목록) — 있으면 byType 대신. */
  byTypeFor?: (body: Record<string, unknown>) => unknown[];
  /** 권역 전망: 'ok'(수요 0.35 = 여유) · 'fail'(503). */
  forecast?: 'ok' | 'fail';
  /** 'ok' 일 때 돌려줄 수요(기본 0.35 = 여유). */
  forecastLevel?: number;
  /** 세션 프리페치(무거운 추천 4 + 코스 1)를 이미 한 것으로 둔다 — 호출 수를 셀 때. */
  skipPrefetch?: boolean;
  modelTrained?: boolean;
  /** /predict/batch 가 이 장소별 예측을 돌려준다(없으면 503). */
  batch?: { facility_id: string; predicted_congestion: number; anchored: boolean }[];
  /** 이번 세션에 고른 칩(있으면 '밤의 첫 화면' 자동 전환을 하지 않는다). */
  activeFilter?: string;
  /** 라이브와 같은 둘째 줄 — 진행 중 축제 한 건 · 근처 화장실 12곳(없으면 두 칩이 스스로 숨는다). */
  liveRow2?: boolean;
}

async function openMain(page: Page, options: OpenOptions = {}): Promise<Calls> {
  const calls: Calls = { byType: [], batch: 0, forecast: 0, modelInfo: 0 };
  await page.route('**://tong.visitkorea.or.kr/**', (route) => route.fulfill({
    status: 200, contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#3e7c6a"/></svg>',
  }));
  await stubMain(page, {
    locale: options.locale,
    facilities: options.facilities ?? [...ATTRACTIONS, DAEREUNGWON],
    byType: options.byType ?? ((type) => (type === 'attraction' ? ATTRACTION_RECS() : [])),
  });
  await stubFakeKakaoMap(page);
  await page.route('**/api/v1/recommendations/by-type', async (route: Route) => {
    const body = route.request().postDataJSON() as { facility_type?: string; assumed_at?: string | null };
    calls.byType.push({ assumedAt: body.assumed_at ?? null, at: Date.now() });
    const items = options.byTypeFor
      ? options.byTypeFor(body as Record<string, unknown>)
      : (options.byType ?? ((type: string) => (type === 'attraction' ? ATTRACTION_RECS() : [])))(String(body.facility_type ?? ''));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) });
  });
  await page.route('**/api/v1/area-demand/forecast**', (route) => {
    calls.forecast += 1;
    return options.forecast === 'fail'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"e2e"}' })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true, forecast: { level: options.forecastLevel ?? 0.35 } }) });
  });
  await page.route('**/predict/model-info', (route) => {
    calls.modelInfo += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trained: !!options.modelTrained, fallback_state: 'degraded_rules' }) });
  });
  await page.route('**/predict/batch', (route) => {
    calls.batch += 1;
    return options.batch
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ predictions: options.batch }) })
      : route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"untrained"}' });
  });
  await page.route('**/api/v1/freshness**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ last_tourapi_sync: new Date(Date.now() - 2 * 3600_000).toISOString() }),
  }));
  if (options.liveRow2) {
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    await page.route('**/api/v1/events**', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ source: 'tourapi', events: [{
        contentId: 'fest-1', title: '2026 경주 국가유산 야행 · 신라문화제', startDate: day(-3), endDate: day(17),
        address: '경상북도 경주시 첨성로 140', eventPlace: '첨성대 일원', latitude: LAT, longitude: LNG, tel: null, isOngoing: true, imageUrl: null,
      }] }),
    }));
    await page.route('**/api/v1/restrooms**', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ restrooms: Array.from({ length: 12 }, (_, i) => ({
        id: `wc-${i}`, name: `공중화장실 ${i + 1}`, address: '경북 경주시', latitude: LAT, longitude: LNG, distance_m: 120 + i * 40, place_url: '',
      })) }),
    }));
  }
  await page.addInitScript(({ theme, prefs, activeFilter, skipPrefetch }) => {
    if (skipPrefetch) sessionStorage.setItem('nextspot_prefetch_done_v1', '1');
    localStorage.setItem('nextspot_theme', theme);
    localStorage.setItem('nextspot_setup_prefs', JSON.stringify(prefs));
    if (!sessionStorage.getItem('e2e_seeded')) {
      sessionStorage.setItem('e2e_seeded', '1');
      localStorage.setItem('nextspot_assumed_at', 'now');
    }
    if (activeFilter) sessionStorage.setItem('nextspot_active_filter', activeFilter);
  }, {
    activeFilter: options.activeFilter ?? null,
    skipPrefetch: !!options.skipPrefetch,
    theme: options.theme ?? 'light',
    prefs: options.prefs ?? { version: 2, categories: ['attraction'], requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [] },
  });
  await page.goto(options.url ?? '/main');
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  return calls;
}

const card = (page: Page) => page.getByTestId('recommendation-card');
const strip = (page: Page) => page.getByTestId('forecast-strip');
const track = (page: Page) => page.getByTestId('forecast-track');
const box = async (target: Locator) => (await target.boundingBox())!;
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** 요소가 화면 안에 다 들어오고 가운데 점에서 맨 위에 그려졌다(다른 판에 가리지 않는다). */
async function expectOnTop(target: Locator, viewport: { width: number; height: number }) {
  await expect(target).toBeVisible();
  const probe = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, onTop: !!hit && (hit === el || el.contains(hit)) };
  });
  expect(probe.top).toBeGreaterThanOrEqual(0);
  expect(probe.bottom).toBeLessThanOrEqual(viewport.height);
  expect(probe.left).toBeGreaterThanOrEqual(0);
  expect(probe.right).toBeLessThanOrEqual(viewport.width);
  expect(probe.onTop, 'covered by another element').toBe(true);
}

/** 상대 가정 시각이 지금 + h 시간(2분 안쪽)인가. */
function expectHoursAhead(assumedAt: string | null | undefined, sentAt: number, hours: number) {
  expect(assumedAt).toBeTruthy();
  const diff = new Date(assumedAt!).getTime() - sentAt;
  expect(Math.abs(diff - hours * 3600_000)).toBeLessThan(2 * 60_000);
}

// ───────────────────────────────────────────────────────────────────────────
// 1) 데스크톱 — 줄이 첫 화면에, 카드·Kakao 로고와 겹치지 않는다(라이트·다크)
// ───────────────────────────────────────────────────────────────────────────

for (const viewport of [{ width: 1536, height: 730 }, { width: 1366, height: 650 }]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${viewport.width}x${viewport.height} ${theme}: the forecast strip is in the first view, clear of the card and the Kakao logo`, async ({ page }, testInfo) => {
      test.setTimeout(90_000);
      await page.setViewportSize(viewport);
      await openMain(page, { theme });
      await expect(card(page)).toBeVisible({ timeout: 25_000 });
      await expectOnTop(strip(page), viewport);
      await expect(strip(page)).toContainText('🔮');
      for (const stop of ['지금', '+1시간 후', '+2시간 후', '+3시간 후']) await expect(track(page).getByText(stop, { exact: true })).toBeVisible();
      await expect(strip(page).getByRole('button', { name: '다른 시간' })).toBeVisible();
      const [stripBox, cardBox, logoBox, panelBox] = await Promise.all([
        box(strip(page)), box(card(page)), box(page.getByTestId('kakao-logo')), box(page.getByTestId('rec-panel')),
      ]);
      expect(overlaps(stripBox, cardBox), 'strip overlaps the card').toBe(false);
      expect(overlaps(stripBox, panelBox), 'strip overlaps the card panel').toBe(false);
      expect(overlaps(stripBox, logoBox), 'strip covers the Kakao logo').toBe(false);
      // 범례 — 지금 잰 핀(교촌 한옥마을 · 대릉원)이 칠해져 있으니 보인다(회색 '수집 중' 항목은 없다).
      const legend = strip(page).getByTestId('forecast-legend');
      await expect(legend).toContainText('지금 혼잡');
      await expect(legend).not.toContainText('수집 중');
      // 상세 정보 펼치기는 여전히 첫 화면(계획 B2) — 툴바가 두 줄이 되어도 카드가 밀리지 않는다.
      await expectOnTop(card(page).getByRole('button', { name: '상세 정보 펼치기' }), viewport);
      await testInfo.attach(`strip-${viewport.width}-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 2) +2시간 후 — 누르기 · 끌기 · 방향키, 배지 · 카드 기준 · 요청 시각, 지금으로 돌아가기
// ───────────────────────────────────────────────────────────────────────────

test('+2시간 후 (click): badge says 예측, the card re-ranks for now+2h, and 지금 clears everything', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const calls = await openMain(page);
  await expect(card(page)).toBeVisible({ timeout: 25_000 });
  const before = calls.byType.length;

  await track(page).getByText('+2시간 후', { exact: true }).click();
  const badge = strip(page).getByTestId('forecast-badge');
  await expect(badge).toContainText('예측', { timeout: 20_000 });
  await expect(badge).toContainText('+2시간 후 예측 · 이 일대 여유 · 추정');
  await expect(track(page)).toHaveAttribute('aria-valuenow', '2');
  await expect(card(page).getByTestId('value-box')).toContainText('+2시간 후 기준', { timeout: 20_000 });
  await expect(strip(page).getByTestId('forecast-legend')).toContainText('+2시간 후 혼잡 · 추정');
  // 범례의 '추천' 은 예측 중의 순위 핀 모양(번호 원 + 점선)이다 — 지금 모드의 금색 고리가 아니다(리뷰 10-07).
  await expect(strip(page).getByTestId('forecast-legend-pick').locator('[data-swatch="rank-dashed"]')).toHaveCount(1);
  await expect.poll(() => calls.byType.length).toBeGreaterThan(before);
  const last = calls.byType.at(-1)!;
  expectHoursAhead(last.assumedAt, last.at, 2);
  // 예측 모델이 학습 전이면 배치 예측을 부르지 않는다(언제나 503 이다) — 경주 중심 곡선만.
  expect(calls.batch).toBe(0);
  expect(calls.forecast).toBeGreaterThan(0);

  // 예측 모드의 순위 핀은 흰 점선 고리(이 일대 예측 등급)로 다시 칠해진다.
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as KakaoFakeWindow).__kakaoFake.pins()))
    .filter((pin) => decodeURIComponent(pin.src).includes('data-pin="filled-dashed"')).length).toBeGreaterThan(0);

  // 지금 — 배지 · 카드의 기준 알약이 사라지고, 다음 요청은 서버 현재 시각(assumed_at 없음).
  const count = calls.byType.length;
  await track(page).getByText('지금', { exact: true }).click();
  await expect(badge).toHaveCount(0);
  await expect(card(page).getByText('+2시간 후 기준')).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(() => calls.byType.length).toBeGreaterThan(count);
  expect(calls.byType.at(-1)!.assumedAt).toBeNull();
});

test('+2시간 후 (drag) and arrow keys move the same track', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1366, height: 650 });
  const calls = await openMain(page);
  await expect(card(page)).toBeVisible({ timeout: 25_000 });
  const from = await box(track(page).getByText('지금', { exact: true }));
  const to = await box(track(page).getByText('+2시간 후', { exact: true }));
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(from.x + from.width / 2 + ((to.x + to.width / 2) - (from.x + from.width / 2)) * (step / 10), from.y + from.height / 2);
  }
  await page.mouse.up();
  await expect(strip(page).getByTestId('forecast-badge')).toContainText('예측', { timeout: 20_000 });
  await expect(track(page)).toHaveAttribute('aria-valuenow', '2');
  await expect(card(page).getByTestId('value-box')).toContainText('+2시간 후 기준', { timeout: 20_000 });
  expectHoursAhead(calls.byType.at(-1)?.assumedAt, calls.byType.at(-1)!.at, 2);

  // 방향키 — 오른쪽은 +3, 왼쪽 두 번은 +1.
  await track(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect(track(page)).toHaveAttribute('aria-valuenow', '3');
  await expect(strip(page).getByTestId('forecast-badge')).toContainText('+3시간 후 예측', { timeout: 20_000 });
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(track(page)).toHaveAttribute('aria-valuenow', '1');
  await expect(card(page).getByTestId('value-box')).toContainText('+1시간 후 기준', { timeout: 20_000 });
});

test('no forecast at all: one toast and the strip snaps back to 지금', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const calls = await openMain(page, { forecast: 'fail' });
  await expect(card(page)).toBeVisible({ timeout: 25_000 });
  await track(page).getByText('+1시간 후', { exact: true }).click();
  await expect(page.getByText('지금(실측) 기준으로 계속 보여드릴게요.')).toBeVisible({ timeout: 25_000 });
  await expect(track(page)).toHaveAttribute('aria-valuenow', '0');
  await expect(strip(page).getByTestId('forecast-badge')).toHaveCount(0);
  await expect(card(page).getByText('+1시간 후 기준')).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(() => calls.byType.at(-1)?.assumedAt ?? null).toBeNull();
});

test('a trained model answers from /predict/batch before the area curve', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const calls = await openMain(page, {
    modelTrained: true,
    batch: ATTRACTIONS.map((row) => ({ facility_id: row.id, predicted_congestion: 0.8, anchored: true })),
  });
  await expect(card(page)).toBeVisible({ timeout: 25_000 });
  const curveBefore = calls.forecast;
  await track(page).getByText('+2시간 후', { exact: true }).click();
  const badge = strip(page).getByTestId('forecast-badge');
  await expect(badge).toContainText('+2시간 후 예측 · 혼잡', { timeout: 20_000 });
  await expect(badge).not.toContainText('이 일대');
  expect(calls.forecast).toBe(curveBefore);
});

// ───────────────────────────────────────────────────────────────────────────
// 3) 요일 프리셋은 '다른 시간 ▾' — /waiting 과 나누고, 상대 시각은 어디에도 남지 않는다
// ───────────────────────────────────────────────────────────────────────────

test('다른 시간 ▾ holds the weekday presets; +N never reaches /waiting or storage', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const calls = await openMain(page);
  await expect(card(page)).toBeVisible({ timeout: 25_000 });

  await strip(page).getByRole('button', { name: '다른 시간' }).click();
  await page.getByRole('menuitemradio', { name: '평일 12:00' }).click();
  await expect(card(page).getByTestId('value-box')).toContainText('평일 12:00 기준', { timeout: 20_000 });
  expect(await page.evaluate(() => localStorage.getItem('nextspot_assumed_at'))).toBe('weekday_noon');
  await expect(track(page)).toHaveAttribute('aria-valuetext', '평일 12:00');

  // +2시간 후 — 요일 프리셋은 풀리고(공유 값 'now'), 상대 시각은 저장되지 않는다.
  await track(page).getByText('+2시간 후', { exact: true }).click();
  await expect(card(page).getByTestId('value-box')).toContainText('+2시간 후 기준', { timeout: 20_000 });
  expect(await page.evaluate(() => localStorage.getItem('nextspot_assumed_at'))).toBe('now');
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toMatch(/\+2|hours_?ahead|relative/i);
  expectHoursAhead(calls.byType.at(-1)?.assumedAt, calls.byType.at(-1)!.at, 2);

  // /waiting 의 '가정 시간' 은 예전 다섯 개 그대로.
  await page.goto('/waiting');
  const preset = page.getByRole('combobox', { name: '가정 시간' });
  await expect(preset).toBeVisible({ timeout: 30_000 });
  const options = await preset.locator('option').allTextContents();
  expect(options).toEqual(['지금(실시간)', '평일 12:00', '금 18:00', '토 14:00', '일 11:00']);
  await expect(preset).toHaveValue('now');
});

// ───────────────────────────────────────────────────────────────────────────
// 4) 핀 — 24시간 안쪽 실측만 칠하고, 46일 전 관측은 빈 핀, 추천 1~5위는 보통 크기 + 순위
// ───────────────────────────────────────────────────────────────────────────

test('pins: measured ≤24h filled, a 46-day-old reading hollow, ranked picks normal size with a number', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page);
  await expect(card(page)).toBeVisible({ timeout: 25_000 });
  const pins = async (): Promise<FakePin[]> => page.evaluate(() => (window as unknown as KakaoFakeWindow).__kakaoFake.pins());
  await expect.poll(async () => (await pins()).length).toBeGreaterThan(3);
  const byTitle = new Map((await pins()).map((pin) => [pin.title, pin]));
  const svg = (title: string) => decodeURIComponent(byTitle.get(title)?.src ?? '');
  // 순위 핀(1~5위) — 근거가 없어도 보통 크기(40×50), 금색 고리 + 숫자.
  for (const title of ['경주 향교', '월정교 산책길']) {
    expect(byTitle.get(title)?.width, title).toBe(40);
    expect(svg(title)).toContain('#c19a3e');
  }
  // 지금 잰 곳(순위 밖 · 24시간 안)은 등급색으로 꽉 찬 핀.
  expect(svg('대릉원')).toContain('data-pin="filled"');
  // 46일 전 관측은 칠하지 않는다 — 작은 빈 핀.
  if (byTitle.has('오래된 관측 고분')) {
    expect(svg('오래된 관측 고분')).toContain('data-pin="hollow"');
    expect(byTitle.get('오래된 관측 고분')?.width).toBe(26);
  }
  for (const pin of await pins()) expect(decodeURIComponent(pin.src)).not.toMatch(/#4b5563|#000(?![0-9a-f])/i);
});

// ───────────────────────────────────────────────────────────────────────────
// 5) 데스크톱 툴바 — 두 줄 · 출처 칩 하나 · 정체성 한 줄(4개 언어)
// ───────────────────────────────────────────────────────────────────────────

const CREDIT: Record<E2eLocale, RegExp> = {
  ko: /출처: ⓒ한국관광공사 TourAPI · 2시간 전 동기화/,
  en: /Source: ⓒ Korea Tourism Organization TourAPI · synced 2 hr ago/,
  ja: /出典: ⓒ韓国観光公社 TourAPI · 2時間前同期/,
  zh: /来源：ⓒ韩国旅游发展局 TourAPI · 2小时前同步/,
};
const TAGLINE: Record<E2eLocale, string> = {
  ko: '줄 서는 대신, 경주를 한 곳 더.',
  en: 'Skip the queue, see one more side of Gyeongju.',
  ja: '並ぶ代わりに、慶州をもう一か所。',
  zh: '少排一次队，多看一处庆州。',
};

for (const viewport of [{ width: 1366, height: 650 }, { width: 1536, height: 730 }]) {
  for (const locale of ['ko', 'en', 'ja', 'zh'] as const) {
    test(`${viewport.width}x${viewport.height} ${locale}: the toolbar is two opaque rows with one credit chip`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize(viewport);
      // 라이브 둘째 줄(리뷰 10-07) — 축제 · 화장실 칩까지 선 상태로 잰다. 예전 스텁은 /api/v1/** 를 '{}' 로 닫아 두 칩이 숨은 채였다.
      await openMain(page, { locale, liveRow2: true, prefs: { version: 2, categories: ['restaurant'], cuisine: '한식', requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [] } });
      const toolbar = page.getByTestId('map-toolbar');
      await expect(toolbar).toBeVisible({ timeout: 25_000 });
      await expect(page.getByTestId('toolbar-row-2').locator('button', { hasText: '🏮' }).first()).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('toolbar-row-2').locator('button', { hasText: /12/ }).first()).toBeVisible();
      const rows = await toolbar.evaluate((el) => {
        // 칩 · 셀렉트 · 출처 칩의 세로 가운데를 모아 12px 넘게 떨어지면 다른 줄로 센다(높이가 조금 다른 칩도 같은 줄).
        const centers: number[] = [];
        for (const child of Array.from(el.querySelectorAll('button, select, [data-testid="source-credit"]'))) {
          const r = child.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) centers.push(r.top + r.height / 2);
        }
        centers.sort((x, y) => x - y);
        let lines = centers.length ? 1 : 0;
        for (let i = 1; i < centers.length; i += 1) if (centers[i] - centers[i - 1] > 12) lines += 1;
        return { distinctRows: lines, height: el.getBoundingClientRect().height, background: getComputedStyle(el).backgroundColor };
      });
      expect(rows.distinctRows, 'toolbar wrapped into a third row').toBeLessThanOrEqual(2);
      expect(rows.height).toBeLessThanOrEqual(84);
      expect(rows.background, 'toolbar must be opaque').toMatch(/^rgb\(/);
      // 카테고리 칩과 🍽 메뉴는 첫 줄 안에 다 보이고(가로로 잘리지 않는다), 언어·시계 밑에 깔리지 않는다.
      const cluster = await page.locator('[aria-label$="KST"]').boundingBox();
      const language = await page.getByRole('combobox').first().boundingBox();
      const clipped = await page.getByTestId('toolbar-row-1').evaluate((row) => {
        const rb = row.getBoundingClientRect();
        return Array.from(row.querySelectorAll('button, label'))
          .map((el) => ({ text: (el.textContent ?? '').trim(), r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && r.height > 0)
          .filter(({ r }) => r.right > rb.right + 1 || r.left < rb.left - 1)
          .map(({ text }) => text);
      });
      expect(clipped, 'chips clipped in row 1').toEqual([]);
      const row1Items = await page.getByTestId('toolbar-row-1').evaluate((row) => Array.from(row.querySelectorAll('button, label'))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })));
      for (const item of row1Items) {
        if (cluster) expect(overlaps(item, cluster), 'a chip sits under the clock').toBe(false);
        if (language) expect(overlaps(item, language), 'a chip sits under the language picker').toBe(false);
      }
      // 둘째 줄은 가로로 넘치면 숨은 스크롤이 된다 — 끝의 칩(🚻 화장실 · 지금 한산)이 잘려 보이지 않으면 안 된다.
      const row2 = await page.getByTestId('toolbar-row-2').evaluate((row) => {
        const scroller = row.firstElementChild as HTMLElement;
        const sb = scroller.getBoundingClientRect();
        return {
          overflow: scroller.scrollWidth - scroller.clientWidth,
          clipped: Array.from(scroller.children)
            .map((el) => ({ text: (el.textContent ?? '').trim(), r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && (r.right > sb.right + 1 || r.left < sb.left - 1))
            .map(({ text }) => text),
        };
      });
      expect(row2.clipped, 'chips clipped in row 2').toEqual([]);
      expect(row2.overflow, 'row 2 scrolls sideways').toBeLessThanOrEqual(1);
      // 출처 칩 하나 — 동기화 시각과 함께, 언어·시계와 겹치지 않는다. 예전 두 번째 출처 알약은 없다.
      const credits = page.getByTestId('source-credit').locator('visible=true');
      await expect(credits).toHaveCount(1);
      await expect(credits).toHaveText(CREDIT[locale]);
      if (cluster) expect(overlaps(await box(credits), cluster), 'credit under the clock').toBe(false);
      await expect(page.getByTestId('identity-line')).toContainText(TAGLINE[locale]);
    });
  }
}

test('desktop 🍽 메뉴 ▾ replaces the cuisine chip row and shows the setup taste until a menu is picked', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const RESTAURANTS = [
    place('rest-pizza', '이사부피자', 'restaurant', 8, { features: { cuisine_tags: ['양식', '피자'] } }),
    place('rest-korean', '황남 쌈밥', 'restaurant', 9, { features: { cuisine_tags: ['한식'] } }),
  ];
  await openMain(page, {
    facilities: [...RESTAURANTS, DAEREUNGWON],
    byType: (type) => (type === 'restaurant' ? [rec(RESTAURANTS[1], 1), rec(RESTAURANTS[0], 2)] : []),
    prefs: { version: 2, categories: ['restaurant'], cuisine: '한식', requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [] },
  });
  await expect(card(page).getByRole('heading', { name: '황남 쌈밥' })).toBeVisible({ timeout: 25_000 });
  const menu = page.getByRole('combobox', { name: '메뉴 고르기' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('option').first()).toHaveText('🍽 메뉴: 한식 (처음 고른 취향)');
  await expect(page.getByRole('button', { name: /피자·양식/ })).toHaveCount(0);
  await menu.selectOption('western');
  await expect(card(page).getByRole('heading', { name: '이사부피자' })).toBeVisible();
  await expect(menu.locator('option').first()).toHaveText('🍽 메뉴 전체');
});

// ───────────────────────────────────────────────────────────────────────────
// 6) 휴대폰 — 머리 ≤ 280px · 지도 띠 ≥ 180px · 줄은 미리보기 위 · 펼친 카드는 검색창 아래
// ───────────────────────────────────────────────────────────────────────────

/** 휴대폰 머리의 바닥 — 언어·시계 · 검색 줄 · 칩 줄 가운데 가장 낮은 곳. */
async function headerBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const parts = [
      document.querySelector('[data-testid="toolbar-row-1"]'),
      document.querySelector('input[type="text"]')?.closest('div'),
      document.querySelector('[aria-label$="KST"]'),
    ];
    return Math.max(...parts.map((el) => el?.getBoundingClientRect().bottom ?? 0));
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`390x844 ${theme}: header ≤ 280px, 필터·편의 first, the strip sits right above the peek`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await openMain(page, { theme });
    const peek = page.getByTestId('rec-card-peek');
    await expect(peek).toBeVisible({ timeout: 25_000 });
    expect(await headerBottom(page)).toBeLessThanOrEqual(280);
    const first = page.getByTestId('toolbar-row-1').getByRole('button').first();
    await expect(first).toHaveText(/필터·편의/);
    // 미리보기: 가치 문장 · 이름 + SPOT · 도보 길안내. 줄은 그 바로 위.
    await expect(peek.getByTestId('peek-value')).toContainText('→ 경주 계림');
    await expect(peek.getByTestId('peek-spot')).toHaveText(/SPOT \d+점/);
    // 카드는 아래에서 올라오며 나타난다(등장 애니메이션) — 자리를 잡은 뒤의 간격을 잰다.
    const gap = async () => {
      const [stripBox, cardBox] = await Promise.all([box(strip(page)), box(card(page))]);
      return cardBox.y - (stripBox.y + stripBox.height);
    };
    await expect.poll(gap).toBeGreaterThanOrEqual(0);
    await expect.poll(gap).toBeLessThanOrEqual(16);
    expect((await box(card(page))).height).toBeLessThanOrEqual(190);
    await expectOnTop(strip(page), { width: 390, height: 844 });
    await testInfo.attach(`phone-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });

    // 펼친 카드는 검색창을 덮지 않는다(위쪽 160px 이상) — 그동안 시간 줄은 비킨다.
    await expandPeek(page);
    await expect.poll(async () => (await box(card(page))).y).toBeGreaterThanOrEqual(160);
    await expect(strip(page)).toHaveCount(0);
    await expectOnTop(page.getByPlaceholder('경주 장소·메뉴·분위기 검색'), { width: 390, height: 844 });
  });
}

test('360x640: the clear map band between the header and the strip is at least 180px with the peek open', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 640 });
  await openMain(page);
  await expect(page.getByTestId('rec-card-peek')).toBeVisible({ timeout: 25_000 });
  await expectOnTop(strip(page), { width: 360, height: 640 });
  const band = (await box(strip(page))).y - await headerBottom(page);
  expect(band, `clear map band ${band}px`).toBeGreaterThanOrEqual(180);
  // 기능 1 의 시연 상태(+2시간 후)에서도 띠가 남는다 — 배지는 줄 안의 짧은 배지, 범례 줄은 키 낮은 화면에서 감춘다(리뷰 10-07).
  await track(page).getByText('+2시간 후', { exact: true }).click();
  await expect(strip(page).getByTestId('forecast-badge-short')).toBeVisible({ timeout: 20_000 });
  await expect(strip(page).getByTestId('forecast-badge-short')).toContainText('🔮 여유 예측');
  await expect(strip(page).getByTestId('forecast-badge')).toBeHidden();
  await expect(strip(page).getByTestId('forecast-legend')).toBeHidden();
  await page.waitForTimeout(600);
  const forecastBand = (await box(strip(page))).y - await headerBottom(page);
  expect(forecastBand, `clear map band in forecast mode ${forecastBand}px`).toBeGreaterThanOrEqual(180);
  const cells = await track(page).evaluate((el) => (Array.from(el.querySelectorAll('[data-stop]')) as HTMLElement[])
    .map((cell) => cell.scrollWidth - cell.getBoundingClientRect().width));
  expect(Math.max(...cells), 'track labels fit their cells').toBeLessThanOrEqual(1);
  // 첫 방문(✨)은 키 낮은 화면에서도 누를 수 있다(검색 줄 옆 아이콘).
  await expectOnTop(page.getByRole('button', { name: /경주가 처음이라면/ }), { width: 360, height: 640 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

// ───────────────────────────────────────────────────────────────────────────
// 7) 출처는 네 관광객 화면에 보인다 · ♿ 저장 상태 하이드레이션 · ♿ 서버 0곳이면 지도 맞춤 · 제안 카드는 출처를 덮지 않는다
// ───────────────────────────────────────────────────────────────────────────

test('the ⓒ한국관광공사 credit is visible on /main, /waiting, /course and /explore/recommend', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page);
  await expect(page.getByTestId('source-credit').locator('visible=true')).toBeVisible({ timeout: 25_000 });
  for (const url of ['/waiting', '/course', `/explore/recommend?facilityId=${ATTRACTIONS[0].id}&lat=${LAT}&lng=${LNG}&type=attraction&name=${encodeURIComponent('경주 계림')}`]) {
    await page.goto(url);
    await expect(page.getByText(/ⓒ\s?한국관광공사/).first(), url).toBeVisible({ timeout: 30_000 });
  }
});

test('♿ saved in storage renders without a hydration mismatch', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const errors: string[] = [];
  page.on('console', (message) => { if (/hydrat/i.test(message.text())) errors.push(message.text()); });
  page.on('pageerror', (error) => { if (/hydrat/i.test(error.message)) errors.push(error.message); });
  await openMain(page, {
    facilities: [...ATTRACTIONS.map((row) => ({ ...row, barrier_free: true })), DAEREUNGWON],
    prefs: { version: 2, categories: ['attraction'], requiredAttributes: ['accessible'], excludeVisited: false, visitedFacilityIds: [] },
  });
  await expect(card(page)).toBeVisible({ timeout: 25_000 });
  await expect(page.getByRole('button', { name: /무장애/ }).first()).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('♿ with a server answer of 0 places fits the map to the barrier-free pins instead of a blank map', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  // 영업시간을 모르는 음식점 — 즉시 계산 카드에는 오르지 않지만(영업 확인 전), 클라이언트는 무장애 후보로 센다.
  const accessible = [
    place('rest-bf-1', '무장애 국밥', 'restaurant', 1, { barrier_free: true, operating_hours: null }),
    place('rest-bf-2', '무장애 칼국수', 'restaurant', 2, { barrier_free: true, operating_hours: null }),
  ];
  await openMain(page, {
    facilities: accessible,
    byType: () => [],
    prefs: { version: 2, categories: ['restaurant'], requiredAttributes: ['accessible'], excludeVisited: false, visitedFacilityIds: [] },
  });
  await expect(page.getByTestId('category-suggestion')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('category-suggestion')).toContainText('2');
  await expect.poll(() => page.evaluate(() => (window as unknown as KakaoFakeWindow).__kakaoFake.lastBounds())).toBe(2);
});

for (const viewport of [{ width: 1536, height: 730 }, { width: 1366, height: 650 }]) {
  test(`${viewport.width}x${viewport.height}: the suggestion card never covers the credit chip`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    // 음식점은 영업시간을 몰라 즉시 카드가 없고 서버도 0곳 — 제안 카드('카페 1곳 보기')가 카드 자리에 선다.
    await openMain(page, {
      byType: () => [],
      facilities: [...ATTRACTIONS.map((row) => ({ ...row, operating_hours: null, type: 'restaurant' })), place('cafe-1', '한옥 카페', 'cafe', 3)],
      prefs: { version: 2, categories: ['restaurant'], requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [] },
      activeFilter: '음식점',
    });
    const suggestion = page.getByTestId('category-suggestion');
    await expect(suggestion).toBeVisible({ timeout: 25_000 });
    const credit = page.getByTestId('source-credit').locator('visible=true');
    expect(overlaps(await box(suggestion), await box(credit))).toBe(false);
    await expectOnTop(credit, viewport);
  });
}

test('contract: ?focus=forecast turns the heatmap on and rings the forecast strip', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page, { url: '/main?focus=forecast' });
  await expect(strip(page)).toHaveClass(/ring-gold/, { timeout: 25_000 });
  await expect(page.getByRole('button', { name: /히트맵/ }).first()).toHaveAttribute('aria-pressed', 'true');
  await expect(strip(page).getByTestId('forecast-legend')).toBeVisible();
});

// ───────────────────────────────────────────────────────────────────────────
// 8) 리뷰 10-07 — 직접 고른 카드도 다시 매기기에는 비킨다 · 예측 시각의 카드 = 지도 핀 · 호출 예산 · 좁은 창 · 휴대폰 날씨
// ───────────────────────────────────────────────────────────────────────────

const BARRIER_FREE = new Set(['att-gyerim', 'att-3', 'att-4']);

test('a tapped pin gives way to ♿: the card re-ranks to a barrier-free place and never says 같은 추천', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const facilities = [...ATTRACTIONS.map((row) => ({ ...row, barrier_free: BARRIER_FREE.has(row.id) })), DAEREUNGWON];
  await openMain(page, {
    facilities,
    byTypeFor: (body) => {
      const accessible = JSON.stringify(body).includes('accessible');
      const rows = facilities.filter((row) => row.type === 'attraction' && row.id !== 'anchor-drw' && row.id !== 'att-old'
        && (!accessible || BARRIER_FREE.has(row.id)));
      return rows.map((row, i) => rec(row as Row, i + 1));
    },
  });
  await expect(card(page).getByRole('heading', { name: '경주 계림' })).toBeVisible({ timeout: 25_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as KakaoFakeWindow).__kakaoFake.markers())).toContain('경주 향교');
  await page.evaluate(() => (window as unknown as KakaoFakeWindow).__kakaoFake.click('경주 향교'));
  await expect(card(page).getByRole('heading', { name: '경주 향교' })).toBeVisible();

  await page.getByTestId('toolbar-row-2').getByRole('button', { name: /♿/ }).click();
  await expect(card(page).getByRole('heading', { name: '경주 계림' })).toBeVisible({ timeout: 20_000 });
  await expect(card(page).getByTestId('card-conditions')).toContainText('♿ 무장애');
  await expect(card(page).getByTestId('card-rank')).toHaveText('베스트 추천');
  await page.waitForTimeout(800);
  await expect(page.getByText('이 시간대에도 같은 추천이 유효해요')).toHaveCount(0);
});

test('a tapped pin gives way to +2시간 후: the card shows that time\'s best pick, not 같은 추천', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page, {
    byTypeFor: (body) => (body.assumed_at
      // +2시간 후의 1위는 지금과 다른 곳이다.
      ? [{ ...rec(ATTRACTIONS[4], 1), spot_score: 0.95 }, rec(ATTRACTIONS[0], 2), rec(ATTRACTIONS[1], 3)]
      : ATTRACTION_RECS()),
  });
  await expect(card(page).getByRole('heading', { name: '경주 계림' })).toBeVisible({ timeout: 25_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as KakaoFakeWindow).__kakaoFake.markers())).toContain('경주 향교');
  await page.evaluate(() => (window as unknown as KakaoFakeWindow).__kakaoFake.click('경주 향교'));
  await expect(card(page).getByRole('heading', { name: '경주 향교' })).toBeVisible();

  await track(page).getByText('+2시간 후', { exact: true }).click();
  await expect(card(page).getByRole('heading', { name: '첨성대 꽃밭' })).toBeVisible({ timeout: 20_000 });
  await expect(card(page).getByTestId('card-rank')).toHaveText('베스트 추천');
  await expect(card(page).getByTestId('value-box')).toContainText('+2시간 후 기준');
  await page.waitForTimeout(800);
  await expect(page.getByText('이 시간대에도 같은 추천이 유효해요')).toHaveCount(0);
});

test('+2시간 후: the card says the same grade as its ranked pin and no current-clock arrival time', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  // 기준 명소 쪽에 주차 근거(혼잡)가 있어 첫 줄이 화살표다 — 후보 쪽 등급 단어가 첫 줄에 나온다.
  const withParking = (row: Row, rank: number) => {
    const base = rec(row, rank);
    return { ...base, breakdown: { ...base.breakdown, area_demand_parking_evidence: { level: 0.9, mode: 'live', observed_at: new Date().toISOString(), radius_m: 500 } } };
  };
  await openMain(page, { byType: (type) => (type === 'attraction' ? ATTRACTIONS.slice(0, 5).map((row, i) => withParking(row, i + 1)) : []) });
  const value = card(page).getByTestId('value-box');
  // 지금: 경주 계림의 지금 잰 값(0.2 = 한산).
  await expect(value).toContainText('대릉원 혼잡 → 경주 계림 한산', { timeout: 25_000 });
  await expect(card(page).getByTestId('arrival-line')).toBeVisible();

  await track(page).getByText('+2시간 후', { exact: true }).click();
  await expect(strip(page).getByTestId('forecast-badge')).toContainText('이 일대 여유', { timeout: 20_000 });
  // +2시간 후: 카드도 순위 핀과 같은 이 일대 예측(0.35 = 여유) — 지금의 '한산' 을 그 시각의 값처럼 말하지 않는다.
  await expect(value).toContainText('대릉원 혼잡 → 경주 계림 여유');
  await expect(value).not.toContainText('한산');
  await expect(value).toContainText('+2시간 후 기준');
  const pin = await page.evaluate(() => (window as unknown as KakaoFakeWindow).__kakaoFake.pins().find((p: FakePin) => p.title === '경주 계림')!);
  const svg = decodeURIComponent(pin.src);
  expect(svg).toContain('data-pin="filled-dashed"');
  expect(svg, 'the pin is painted 여유 (emerald)').toMatch(/#047857|#059669/);
  // 출발 → 도착은 지금 시각으로 센 값이라 '+2시간 후 기준' 카드에는 두지 않는다.
  await expect(card(page).getByTestId('arrival-line')).toHaveCount(0);
});

test('en: the +N pill reads "Forecast for +2 hr"', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page, { locale: 'en' });
  await expect(card(page)).toBeVisible({ timeout: 25_000 });
  await track(page).getByText('+2 hr', { exact: true }).click();
  await expect(card(page).getByTestId('value-box')).toContainText('Forecast for +2 hr', { timeout: 20_000 });
  await expect(card(page).getByTestId('value-box')).not.toContainText('Based on +2');
});

test('call budget: +2시간 후 costs at most 3 Render calls with one area forecast GET, and each hour is asked once', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const render: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/^\/(api\/v1|predict)\//.test(url.pathname)) render.push(`${request.method()} ${url.pathname}`);
  });
  const calls = await openMain(page, { skipPrefetch: true, forecastLevel: 0.1 });
  await expect(card(page)).toBeVisible({ timeout: 25_000 });
  await page.waitForTimeout(2500);
  const atLoad = render.length;

  await track(page).getByText('+2시간 후', { exact: true }).click();
  const badge = strip(page).getByTestId('forecast-badge');
  await expect(badge).toContainText('+2시간 후 예측 · 이 일대 한산', { timeout: 20_000 });
  await page.waitForTimeout(1500);
  const plusTwo = render.slice(atLoad);
  expect(plusTwo.length, plusTwo.join(', ')).toBeLessThanOrEqual(3);
  expect(calls.forecast).toBe(1);
  // 한산 = 핀 · 범례와 같은 파랑(옥색은 범례에서 '여유' 로 읽힌다).
  await expect(badge).toHaveClass(/benefit-quiet/);

  const before = render.length;
  await track(page).getByText('+3시간 후', { exact: true }).click();
  await expect(badge).toContainText('+3시간 후 예측', { timeout: 20_000 });
  await page.waitForTimeout(1500);
  expect(calls.forecast).toBe(2);
  expect(render.slice(before).length, render.slice(before).join(', ')).toBeLessThanOrEqual(2);

  await track(page).getByText('+2시간 후', { exact: true }).click();
  await expect(badge).toContainText('+2시간 후 예측', { timeout: 20_000 });
  await page.waitForTimeout(1200);
  expect(calls.forecast, 'the same hour is not asked again in this session').toBe(2);
});

test('1024x768: toolbar chips never slide under the language picker and clock', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1024, height: 768 });
  await openMain(page, { activeFilter: '음식점' });
  await expect(page.getByTestId('toolbar-row-1')).toBeVisible({ timeout: 25_000 });
  await page.waitForTimeout(800);
  const cluster = await box(page.locator('[aria-label$="KST"]'));
  const lang = await box(page.getByRole('combobox').first());
  const chips = await page.getByTestId('toolbar-row-1').evaluate((row) => (Array.from(row.querySelectorAll('button, label')) as HTMLElement[])
    .map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0)
    .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })));
  expect(chips.length).toBeGreaterThan(4);
  for (const chip of chips) {
    expect(overlaps(chip, cluster), `chip at x=${chip.x} under the clock`).toBe(false);
    expect(overlaps(chip, lang), `chip at x=${chip.x} under the language picker`).toBe(false);
  }
});

// 리뷰 10-07(ja · zh D2 화면): 휴대폰 +2시간 후에서 짧은 배지 옆 칸이 좁아 '+1時間後+2時間後' 가 칸을 넘쳐 겹쳤다.
for (const locale of ['ja', 'zh'] as const) {
  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 640 }]) {
    test(`${locale} ${viewport.width}x${viewport.height}: in forecast mode the track labels still fit their cells`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize(viewport);
      await openMain(page, { locale });
      await expect(page.getByTestId('rec-card-peek')).toBeVisible({ timeout: 25_000 });
      await track(page).locator('[data-stop="2"]').click();
      await expect(strip(page).getByTestId('forecast-badge-short')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(400);
      const cells = await track(page).evaluate((el) => (Array.from(el.querySelectorAll('[data-stop]')) as HTMLElement[])
        .map((cell) => cell.scrollWidth - cell.getBoundingClientRect().width));
      expect(Math.max(...cells), 'track labels overflow their cells').toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    });
  }
}

test('820x1180: the time strip labels fit their cells', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 820, height: 1180 });
  await openMain(page);
  await expect(card(page)).toBeVisible({ timeout: 25_000 });
  for (const stop of ['지금', '+1시간 후', '+2시간 후', '+3시간 후']) await expect(track(page).getByText(stop, { exact: true })).toBeVisible();
  const cells = await track(page).evaluate((el) => (Array.from(el.querySelectorAll('[data-stop]')) as HTMLElement[])
    .map((cell) => cell.scrollWidth - cell.getBoundingClientRect().width));
  expect(Math.max(...cells), 'labels overflow their cells').toBeLessThanOrEqual(1);
});

test('360x640: the weather forecast opens fully on screen', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 640 });
  const at = new Date().toISOString();
  const hour = { at, temperatureC: 18, sky: 1, precipitationType: 0, precipitationProbability: 10, windSpeedMps: 1 };
  await openMain(page);
  // stubMain 의 /api/v1/** 빈 답보다 나중에 건다(나중에 건 라우트가 이긴다) — 그리고 날씨를 다시 받게 새로 연다.
  await page.route('**/api/v1/weather**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ source: 'kma', current: hour, forecasts: [0, 1, 2, 3, 4, 5].map((h) => ({ ...hour, at: new Date(Date.now() + h * 3600_000).toISOString() })), indoor_recommended: false }),
  }));
  await page.reload();
  await expect(page.getByTestId('rec-card-peek')).toBeVisible({ timeout: 25_000 });
  const pill = page.getByRole('button', { name: /지금 경주/ });
  await expect(pill).toBeVisible({ timeout: 15_000 });
  await pill.click();
  const forecast = page.getByLabel('향후 6시간 예보');
  await expect(forecast).toBeVisible();
  const panel = forecast.locator('xpath=..');
  const panelBox = await box(panel);
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(360);
});

test('en: a desktop with no location says so in English', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page, { locale: 'en' });
  await expect(page.getByText('Couldn’t determine your location, so we’re guiding from central Gyeongju.')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText('위치를 확인할 수 없어 경주 중심을 기준으로 안내해요.')).toHaveCount(0);
});
