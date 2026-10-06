import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { stubMain } from './support/mainStubs';
import { expandPeek } from './support/recCard';
import { stubFakeKakaoMap, type KakaoFakeWindow } from './support/fakeKakaoMap';
import { stubExternalServices } from './support/stubs';

// 계획 B2 — 추천 카드와 음성 비서(심사위원이 /main 에서 가장 먼저 보는 것).
//   · 접힌 카드 첫 화면: 가치 문장 · 사진 · 실시간 정보 새로고침 · '상세 정보 펼치기' 가 1536×730 과 1366×650 에서
//     스크롤 없이 보이고 바닥 버튼에 가리지 않는다(라이트·다크).
//   · SPOT 배지는 카드 흐름 안에 설명 상자를 연다(가로로 밀리지 않는다).
//   · 실시간 정보 새로고침: 성공하면 '방금 갱신' · 알림 · 상세가 열리고 새로 받은 줄이 반짝인다. 실패는 조용하다.
//   · 첫 카드: 서버 답을 최대 3.5초 기다리는 스켈레톤, 서버가 0곳·오류면 즉시 계산한 카드를 곧바로.
//   · 음성 '다음' 은 서버 상위 목록을 걷는다(베스트 → 2번째 → 3번째 → 다음 후보 → 처음).
//   · '양식 먹고 싶어' 는 🍕 칩을 누른 것과 같다. 말로 바꾼 조건은 카드 머리 칩으로 남고 ✕ 로 푼다.
//   · 휴대폰 자막은 시계에 가리지 않는다. 술집 태그(camelCase)는 음식점 추천에 오르지 않는다.
//   · 밤의 첫 화면: 처음 열린 칩에 문 연 곳이 없으면 한 번만 관광지로 옮기고 알린다.
//   · 교차 레인 계약: /main?place=<id> → '선택한 장소', ?focus=live|voice|forecast.

// 외부로 나가는 호출을 전부 막는다 — 지도 SDK 와 Supabase 인증(support/stubs.ts).
test.beforeEach(async ({ page }) => stubExternalServices(page));

const LAT = 35.8355;
const LNG = 129.2105;
const TOUR_PHOTO = 'https://tong.visitkorea.or.kr/cms/resource/01/e2e_ok_image2_1.jpg';
const DESKTOPS = [{ width: 1536, height: 730 }, { width: 1366, height: 650 }];
const PHONES = [{ width: 390, height: 844 }, { width: 360, height: 640 }];

type Row = Record<string, unknown> & { id: string; name: string; type: string };

function place(id: string, name: string, type: string, i: number, extra: Record<string, unknown> = {}): Row {
  return {
    id, name, type,
    latitude: LAT + i * 0.0008,
    longitude: LNG + i * 0.0004,
    capacity: 30,
    features: {},
    congestion: null,
    operating_hours: { open: '00:00~23:59', closed: '연중무휴' },
    ...extra,
  };
}

const GYERIM = place('att-gyerim', '경주 계림', 'attraction', 0, {
  image_url: TOUR_PHOTO, contentid: '126207', contenttypeid: 12,
  overview: '첨성대와 월성 사이에 있는 숲이다.', phone: '054-779-6100', homepage: 'https://www.gyeongju.go.kr/tour',
  operating_hours: { open: '상시 개방', closed: '연중무휴' },
});
const ATTRACTIONS = [
  GYERIM,
  place('att-2', '경주 향교', 'attraction', 1),
  place('att-3', '교촌 한옥마을', 'attraction', 2),
  place('att-4', '월정교 산책길', 'attraction', 3),
  place('att-5', '첨성대 꽃밭', 'attraction', 4),
];
const OUTSIDE_LIST = place('att-out', '숨은 고분길', 'attraction', 6);
const DAEREUNGWON = place('anchor-drw', '대릉원', 'attraction', 5, {
  congestion: {
    level: 0.88, current_count: null, timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
    source: 'user_report', is_stale: false, is_current: true,
  },
});
const RESTAURANTS = [
  place('rest-bar', '동주 술집', 'restaurant', 7, { features: { cuisine_tags: ['술집'] } }),
  place('rest-pizza', '이사부피자', 'restaurant', 8, { features: { cuisine_tags: ['양식', '피자'] } }),
  place('rest-korean', '황남 쌈밥', 'restaurant', 9, { features: { cuisine_tags: ['한식'] } }),
];

function rec(row: Row, rank: number, extra: Record<string, unknown> = {}) {
  return {
    recommendation_id: `rec-${row.id}`,
    facility: row,
    spot_score: 0.8 - rank * 0.03,
    distance_m: 200 + rank * 50,
    rank,
    total_candidates: 5,
    reason: `${row.name} 추천: 도보 4분 수준입니다.`,
    reason_source: 'template',
    congestion_level: rank === 1 ? 0.2 : null,
    congestion_source: rank === 1 ? 'measured' : 'none',
    congestion_is_current: rank === 1 ? true : null,
    congestion_timestamp: rank === 1 ? new Date(Date.now() - 4 * 60_000).toISOString() : null,
    open_status_at_arrival: 'open_expected',
    scoring_mode: 'area_stats_rules',
    prediction_source: 'unavailable',
    breakdown: {
      preference: 0.82 - rank * 0.04, wait_time: null, travel_time: 3.4 + rank, incentive: 0,
      area_demand_level: 0.62, area_demand_mode: 'live', area_demand_sources: ['parking', 'tourism'],
      area_demand_parking_evidence: { level: 0.84, mode: 'live', observed_at: new Date().toISOString(), radius_m: 500 },
      area_demand_tourism_evidence: { reference_name: '대릉원', distance_m: 420, forecast_date: '2026-10-07', relative_index: 74 },
    },
    ...extra,
  };
}

const ATTRACTION_RECS = () => ATTRACTIONS.map((row, i) => rec(row, i + 1));

interface OpenOptions {
  theme?: 'light' | 'dark';
  /** 온보딩 첫 칩 — 기본 관광지(사진·새로고침이 있는 TourAPI 카드). */
  categories?: string[];
  prefs?: Record<string, unknown>;
  byType?: (type: string) => unknown[];
  url?: string;
  speech?: boolean;
  fakeMap?: boolean;
  locale?: 'ko' | 'en' | 'ja' | 'zh';
  /** 첫 요청보다 먼저 걸어야 하는 라우트(나중에 건 라우트가 stubMain 보다 먼저 받는다). */
  beforeGoto?: (page: Page) => Promise<unknown>;
}

async function openMain(page: Page, options: OpenOptions = {}): Promise<void> {
  await page.route('**://tong.visitkorea.or.kr/**', (route) => route.fulfill({
    status: 200, contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#3e7c6a"/></svg>',
  }));
  await stubMain(page, {
    locale: options.locale,
    facilities: [...ATTRACTIONS, DAEREUNGWON, OUTSIDE_LIST, ...RESTAURANTS],
    byType: options.byType ?? ((type) => (type === 'attraction' ? ATTRACTION_RECS() : [])),
  });
  if (options.fakeMap) await stubFakeKakaoMap(page);
  await page.addInitScript(({ theme, prefs, speech }) => {
    localStorage.setItem('nextspot_theme', theme);
    localStorage.setItem('nextspot_setup_prefs', JSON.stringify(prefs));
    if (!speech) return;
    const w = window as unknown as Record<string, unknown>;
    w.__utterances = [];
    w.__recognitions = [];
    class MockUtterance {
      text: string; lang = ''; rate = 1; pitch = 1; volume = 1; voice = null;
      onend?: () => void; onerror?: () => void;
      constructor(text: string) { this.text = text; }
    }
    class MockRecognition {
      lang = ''; interimResults = false; continuous = false; maxAlternatives = 1;
      onresult?: (event: unknown) => void; onerror?: (event: unknown) => void; onend?: () => void;
      constructor() { (w.__recognitions as unknown[]).push(this); w.__recognition = this; }
      start() { /* the test dispatches a final result */ }
      abort() { this.onend?.(); }
      stop() { this.onend?.(); }
    }
    w.SpeechSynthesisUtterance = MockUtterance;
    w.SpeechRecognition = MockRecognition;
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [], cancel: () => {},
      speak: (u: MockUtterance) => {
        if (u.text.trim()) (w.__utterances as { text: string; lang: string }[]).push({ text: u.text, lang: u.lang });
        setTimeout(() => u.onend?.(), 0);
      },
      onvoiceschanged: null,
    } });
  }, {
    theme: options.theme ?? 'light',
    prefs: options.prefs ?? {
      version: 2, categories: options.categories ?? ['attraction'], requiredAttributes: [],
      excludeVisited: false, visitedFacilityIds: [],
    },
    speech: !!options.speech,
  });
  if (options.beforeGoto) await options.beforeGoto(page);
  await page.goto(options.url ?? '/main');
}

const card = (page: Page) => page.getByTestId('recommendation-card');

/** 요소가 화면 안에 다 들어오고, 가운데 점에서 맨 위에 그려진 것이 그 요소다(바닥 버튼·다른 패널에 가리지 않는다). */
async function expectInFirstView(target: Locator, viewport: { width: number; height: number }): Promise<void> {
  await expect(target).toBeVisible();
  const probe = await target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, onTop: !!hit && (hit === el || el.contains(hit)) };
  });
  expect(probe.top).toBeGreaterThanOrEqual(0);
  expect(probe.bottom).toBeLessThanOrEqual(viewport.height);
  expect(probe.right).toBeLessThanOrEqual(viewport.width);
  expect(probe.onTop, 'covered by another element').toBe(true);
}

// ───────────────────────────────────────────────────────────────────────────
// 접힌 카드 첫 화면(데스크톱) — 라이트 · 다크
// ───────────────────────────────────────────────────────────────────────────

for (const viewport of DESKTOPS) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${viewport.width}x${viewport.height} ${theme}: value line, photo, live refresh and 상세 정보 펼치기 are in the first view`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize(viewport);
      await openMain(page, { theme });
      await expect(card(page).getByRole('heading', { name: '경주 계림' })).toBeVisible({ timeout: 25_000 });
      if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/nextspot-dark/);

      // 가치 문장(화살표 — 대릉원은 지금 혼잡, 계림은 실측 한산) · 사진 · 새로고침 · 상세 펼치기.
      const valueLine = card(page).getByText(/대릉원 혼잡 → 경주 계림 한산 · 도보 \d+분/);
      await expectInFirstView(valueLine, viewport);
      await expectInFirstView(card(page).getByTestId('card-photo'), viewport);
      await expectInFirstView(card(page).getByRole('button', { name: '실시간 정보 새로고침' }), viewport);
      await expect(card(page).getByText('출처: ⓒ한국관광공사 TourAPI', { exact: true })).toBeVisible();
      const details = card(page).getByRole('button', { name: '상세 정보 펼치기' });
      await expectInFirstView(details, viewport);
      // 바닥 버튼보다 위에서 끝난다(타일이 바닥 버튼에 반쯤 가리던 화면 — 10-06 실측).
      const [detailsBox, rejectBox] = await Promise.all([
        details.boundingBox(),
        card(page).getByRole('button', { name: '이 추천에 관심 없음, 다른 장소 추천받기' }).boundingBox(),
      ]);
      expect(detailsBox!.y + detailsBox!.height).toBeLessThanOrEqual(rejectBox!.y);
      // 순위 타일·근거 원자료는 얼굴에 없다(추천 근거 자세히 안).
      await expect(card(page).getByText('도보 시간', { exact: true })).toHaveCount(0);
      expect(await card(page).innerText()).not.toMatch(/상대지수|후보와|관광 인기도|공영주차 실측 수요/);
      // 음성 비서 알약 — 카드 바로 위 칸.
      const pill = page.getByRole('button', { name: 'AI 음성 추천 듣기' });
      await expectInFirstView(pill, viewport);
      await expect(pill).toContainText('AI 음성 비서');
      const [pillBox, cardBox] = await Promise.all([pill.boundingBox(), card(page).boundingBox()]);
      expect(pillBox!.y + pillBox!.height).toBeLessThanOrEqual(cardBox!.y);
      // 패널 폭: 1536 → 460, 1366 → 420(lib/mainPanelLayout).
      expect(Math.round(cardBox!.width)).toBe(viewport.width >= 1536 ? 460 : 420);
    });
  }
}

test('the SPOT badge opens an in-flow box with the weights in tourist words, without shifting the card', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page);
  const heading = card(page).getByRole('heading', { name: '경주 계림' });
  await expect(heading).toBeVisible({ timeout: 25_000 });
  const before = (await heading.boundingBox())!;
  const badge = card(page).getByRole('button', { name: 'SPOT 점수 설명 보기' });
  await expect(badge).toContainText('SPOT 점수');
  const badgeBox = (await badge.boundingBox())!;
  expect(badgeBox.width).toBeGreaterThanOrEqual(60);
  expect(badgeBox.height).toBeGreaterThanOrEqual(60);
  await badge.click();
  const box = card(page).getByTestId('spot-info');
  await expect(box).toBeVisible();
  await expect(box).toContainText('내 취향(40%)');
  await expect(box).toContainText('혜택(20%)');
  await expect(box).toContainText('내 취향 · 78% 일치');
  await expect(box).toContainText(/걷는 시간 · 도보 \d+분/);
  await expect(badge).toHaveAttribute('aria-expanded', 'true');
  const after = (await heading.boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.5);
  const overflow = await card(page).evaluate((el) => {
    const scroller = el.querySelector('.rec-scroll') as HTMLElement;
    return { cardX: scroller.scrollWidth - scroller.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(overflow.cardX).toBeLessThanOrEqual(0);
  expect(overflow.page).toBeLessThanOrEqual(1);
  expect(await box.innerText()).not.toMatch(/검증된|제한적으로|순위 시간비용/);
});

test('추천 근거 자세히 stays closed until asked and holds the tiles and the raw evidence', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page);
  await expect(card(page).getByRole('heading', { name: '경주 계림' })).toBeVisible({ timeout: 25_000 });
  await card(page).getByRole('button', { name: '상세 정보 펼치기' }).click();
  const why = card(page).getByTestId('why-toggle');
  await expect(why).toHaveText('추천 근거 자세히');
  await expect(why).toHaveAttribute('aria-expanded', 'false');
  await expect(card(page).getByText('공영주차 실측 수요', { exact: false })).toHaveCount(0);
  await why.click();
  const panel = card(page).getByTestId('why-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('도보 시간', { exact: true })).toBeVisible();
  await expect(panel).toContainText('공영주차 실측 수요');
  await expect(panel).toContainText('관광 인기도');
});

// ───────────────────────────────────────────────────────────────────────────
// 실시간 정보 새로고침
// ───────────────────────────────────────────────────────────────────────────

for (const viewport of DESKTOPS) {
test(`${viewport.width}x${viewport.height} live refresh: success shows the time chip and a toast, opens details and flashes the refreshed rows on screen`, async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize(viewport);
  let calls = 0;
  await openMain(page);
  await page.route('**/api/v1/infrastructures/live-detail/**', (route) => {
    calls += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      source: 'tourapi-live',
      operating_hours: { open: '상시 개방', closed: '연중무휴' },
      overview: '첨성대와 월성 사이의 숲 — 방금 받은 소개.',
      phone: '054-779-6100',
      homepage: 'https://www.gyeongju.go.kr/tour',
      image_url: TOUR_PHOTO,
    }) });
  });
  const refresh = card(page).getByRole('button', { name: '실시간 정보 새로고침' });
  await expect(refresh).toBeVisible({ timeout: 25_000 });
  await refresh.click();
  await expect(card(page).getByTestId('live-refreshed')).toContainText(/방금 갱신 · \d{2}:\d{2}/);
  await expect(page.getByText('관광정보를 최신으로 불러왔어요')).toBeVisible();
  await expect(card(page).getByRole('button', { name: '상세 정보 접기' })).toBeVisible();
  await expect(card(page).getByText('첨성대와 월성 사이의 숲 — 방금 받은 소개.')).toBeVisible();
  expect(await card(page).locator('[data-refreshed="true"]').count()).toBeGreaterThanOrEqual(4);
  await expect(refresh).toBeDisabled();
  expect(calls).toBe(1);
  // 새로 받은 상세 줄(첫 줄 = 운영시간)이 카드 스크롤의 보이는 곳으로 온다 — 키 낮은 노트북에서도 사진만 반짝이지 않게(리뷰 10-07).
  await expect.poll(() => card(page).evaluate((el) => {
    const scroller = (el.querySelector('.rec-scroll') as HTMLElement).getBoundingClientRect();
    const bar = el.querySelector('[data-testid="details-name-bar"]')?.getBoundingClientRect();
    const row = (el.querySelector('[data-testid="detail-hours"]') as HTMLElement).getBoundingClientRect();
    return row.top >= Math.max(scroller.top, bar?.bottom ?? 0) - 1 && row.bottom <= scroller.bottom + 1;
  })).toBe(true);
});
}

test('live refresh: a failure stays silent and the button comes back', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page);
  await page.route('**/api/v1/infrastructures/live-detail/**', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"boom"}' }));
  const refresh = card(page).getByRole('button', { name: '실시간 정보 새로고침' });
  await expect(refresh).toBeVisible({ timeout: 25_000 });
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(card(page).getByTestId('live-refreshed')).toHaveCount(0);
  await expect(page.getByText(/실패|failed/i)).toHaveCount(0);
});

// ───────────────────────────────────────────────────────────────────────────
// 첫 카드 — 스켈레톤 먼저, 서버가 0곳·오류면 즉시 카드
// ───────────────────────────────────────────────────────────────────────────

test('first pick: a skeleton, then the server #1 that does not swap afterwards', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page, { beforeGoto: (p) => p.route('**/api/v1/recommendations/by-type', async (route: Route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const recs = ATTRACTION_RECS();
    // 서버 1위(가장 높은 SPOT)를 즉시 계산 1위(가장 가까운 곳)와 다르게 둔다 — 바뀌어 뜨면 실패.
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { ...recs[2], rank: 1, spot_score: 0.95 }, { ...recs[0], rank: 2 }, { ...recs[1], rank: 3 },
    ]) });
  }) });
  await expect(page.getByText('지금 덜 붐비는 가까운 곳을 고르고 있어요…')).toBeVisible({ timeout: 25_000 });
  await expect(card(page)).toHaveCount(0);
  await expect(card(page).getByRole('heading', { name: '교촌 한옥마을' })).toBeVisible({ timeout: 10_000 });
  await expect(card(page).getByTestId('card-rank')).toHaveText('베스트 추천');
  await page.waitForTimeout(3000);
  await expect(card(page).getByRole('heading', { name: '교촌 한옥마을' })).toBeVisible();
});

// 서버가 3.5초 넘게 늦으면 즉시 카드가 먼저 뜬다 — 서버 목록에 그곳이 있으면 그대로 두고(값 · 순위만 서버 것), 서버가 그곳을
// 뺐을 때만 서버 1위로 바꾼다(리뷰 10-07: 늦게 다시 일어나던 I34 의 바뀌는 카드).
const SERVER_ORDER = [2, 0, 1, 3, 4];
for (const listed of [true, false]) {
  test(`first pick: a 5 s server ${listed ? 'keeps the instant card it lists' : 'replaces the instant card it left out'}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1536, height: 730 });
    let shown: string | null = null;
    let answered = false;
    await openMain(page, { beforeGoto: (p) => p.route('**/api/v1/recommendations/by-type', async (route: Route) => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const recs = ATTRACTION_RECS();
      const order = SERVER_ORDER.map((i) => recs[i]).filter((r) => listed || r.facility.name !== shown);
      answered = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
        order.map((r, i) => ({ ...r, rank: i + 1, spot_score: 0.95 - i * 0.05 })),
      ) });
    }) });
    const heading = card(page).locator('h3').first();
    await expect(heading).toBeVisible({ timeout: 25_000 });
    expect(answered, 'the instant card came before the server').toBe(false);
    shown = await heading.innerText();
    await expect.poll(() => answered, { timeout: 15_000 }).toBe(true);
    await page.waitForTimeout(1200);
    const serverNames = SERVER_ORDER.map((i) => ATTRACTIONS[i].name).filter((name) => listed || name !== shown);
    if (listed) {
      await expect(heading).toHaveText(shown);
      const position = serverNames.indexOf(shown) + 1;
      await expect(card(page).getByTestId('card-rank')).toHaveText(position === 1 ? '베스트 추천' : `${position}번째 추천`);
    } else {
      await expect(heading).toHaveText(serverNames[0]);
      await expect(card(page).getByTestId('card-rank')).toHaveText('베스트 추천');
    }
  });
}

for (const answer of ['empty', 'error'] as const) {
  test(`first pick: by-type ${answer === 'empty' ? '200 []' : '500'} shows the instant card at once`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1536, height: 730 });
    let answeredAt = 0;
    await openMain(page, { beforeGoto: (p) => p.route('**/api/v1/recommendations/by-type', (route: Route) => {
      answeredAt = Date.now();
      return answer === 'empty'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
        : route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"down"}' });
    }) });
    await expect(card(page)).toBeVisible({ timeout: 25_000 });
    expect(answeredAt).toBeGreaterThan(0);
    expect(Date.now() - answeredAt).toBeLessThan(1500);
    await expect(page.getByTestId('category-suggestion')).toHaveCount(0);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 음성 비서
// ───────────────────────────────────────────────────────────────────────────

async function startVoiceAndSay(page: Page, utterance: string): Promise<void> {
  const before = await page.evaluate(() => ((window as unknown as { __recognitions: unknown[] }).__recognitions ?? []).length);
  const pill = page.getByRole('button', { name: 'AI 음성 추천 듣기' });
  if (await pill.count()) await pill.click();
  await expect.poll(() => page.evaluate(() => ((window as unknown as { __recognitions: unknown[] }).__recognitions ?? []).length)).toBeGreaterThan(before);
  await page.evaluate((text) => {
    const recognition = (window as unknown as { __recognition: { onresult?: (e: unknown) => void } }).__recognition;
    const result = Object.assign([{ transcript: text }], { isFinal: true });
    recognition.onresult?.({ resultIndex: 0, results: [result] });
  }, utterance);
}

test('voice "다음" walks the server list: 베스트 → 2번째 → 3번째 → 다음 후보 → back to the top', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page, { speech: true });
  await page.route('**/api/v1/voice/turn', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ action: 'next', target_facility_id: null, match_ids: [], spoken: null, suggestion_id: null, command: null }),
  }));
  const rank = card(page).getByTestId('card-rank');
  await expect(rank).toHaveText('베스트 추천', { timeout: 25_000 });
  const expected = ['2번째 추천', '3번째 추천', '다음 후보', '다음 후보', '베스트 추천'];
  const names = ['경주 향교', '교촌 한옥마을', '월정교 산책길', '첨성대 꽃밭', '경주 계림'];
  for (let i = 0; i < expected.length; i += 1) {
    await startVoiceAndSay(page, '다음');
    await expect(card(page).getByRole('heading', { name: names[i] })).toBeVisible();
    await expect(rank).toHaveText(expected[i]);
  }
  // 이름은 한 번, '수준입니다' 없이 걸어서 N분.
  const utterances = await page.evaluate(() => (window as unknown as { __utterances: { text: string }[] }).__utterances.map((u) => u.text));
  const first = utterances.find((text) => text.includes('경주 계림'))!;
  expect(first.split('경주 계림').length - 1).toBe(1);
  expect(first).toMatch(/걸어서 \d+분/);
  expect(utterances.join(' ')).not.toContain('수준입니다');
});

test('en: the assistant speaks and listens in English and understands "next" without the server', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  let turnCalls = 0;
  await openMain(page, { speech: true, locale: 'en' });
  await page.route('**/api/v1/voice/turn', (route) => {
    turnCalls += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ action: 'unknown', spoken: null }) });
  });
  const rank = card(page).getByTestId('card-rank');
  await expect(rank).toHaveText('Top pick', { timeout: 25_000 });
  const before = await page.evaluate(() => ((window as unknown as { __recognitions: unknown[] }).__recognitions ?? []).length);
  await page.getByRole('button', { name: 'Listen to AI voice picks' }).click();
  await expect.poll(() => page.evaluate(() => ((window as unknown as { __recognitions: unknown[] }).__recognitions ?? []).length)).toBeGreaterThan(before);
  const langs = await page.evaluate(() => {
    const w = window as unknown as { __utterances: { lang: string }[]; __recognition: { lang: string } };
    return { speak: w.__utterances.map((u) => u.lang), listen: w.__recognition.lang };
  });
  expect(langs.speak.length).toBeGreaterThan(0);
  expect([...new Set(langs.speak)]).toEqual(['en-US']);
  expect(langs.listen).toBe('en-US');
  await page.evaluate(() => {
    const recognition = (window as unknown as { __recognition: { onresult?: (e: unknown) => void } }).__recognition;
    recognition.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'next' }], { isFinal: true })] });
  });
  await expect(rank).toHaveText('Pick #2');
  expect(turnCalls).toBe(0);
  // Place-type / indoor / walk words become app commands on the device — the server classifier only knows Korean (review 10-07).
  const listening = await page.evaluate(() => ((window as unknown as { __recognitions: unknown[] }).__recognitions ?? []).length);
  await expect.poll(() => page.evaluate(() => ((window as unknown as { __recognitions: unknown[] }).__recognitions ?? []).length)).toBeGreaterThan(listening);
  await page.evaluate(() => {
    const recognition = (window as unknown as { __recognition: { onresult?: (e: unknown) => void } }).__recognition;
    recognition.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'within 10 minutes walk' }], { isFinal: true })] });
  });
  await expect(card(page).getByTestId('card-conditions')).toContainText('🚶 Within a 10-min walk', { timeout: 15_000 });
  expect(turnCalls).toBe(0);
  // English sentences, not Korean ones.
  const spoken = await page.evaluate(() => (window as unknown as { __utterances: { text: string }[] }).__utterances.map((u) => u.text).join(' '));
  expect(spoken).toContain('Shall I guide you here?');
  expect(spoken).not.toMatch(/안내할까요|추천이에요/);
});

test('voice "양식 먹고 싶어" lights the 🍕 chip and opens the chip\'s #1', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  let turnCalls = 0;
  await openMain(page, {
    speech: true,
    categories: ['restaurant'],
    byType: (type) => (type === 'restaurant' ? [rec(RESTAURANTS[2], 1)] : type === 'attraction' ? ATTRACTION_RECS() : []),
  });
  await page.route('**/api/v1/voice/turn', (route) => {
    turnCalls += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ action: 'unknown', spoken: null }) });
  });
  await expect(card(page).getByRole('heading', { name: '황남 쌈밥' })).toBeVisible({ timeout: 25_000 });
  await startVoiceAndSay(page, '양식 먹고 싶어');
  // 데스크톱의 음식 종류는 계획 B3 부터 '🍽 메뉴 ▾' 하나다 — 칩을 누른 것과 같이 그 메뉴가 고른 값이 된다.
  await expect(page.getByRole('combobox', { name: '메뉴 고르기' })).toHaveValue('western');
  await expect(card(page).getByRole('heading', { name: '이사부피자' })).toBeVisible();
  expect(turnCalls).toBe(0);
});

test('a walk-limit condition shows as a card chip and ✕ re-ranks without it', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const bodies: { context?: { max_walk_minutes?: number | null } }[] = [];
  await openMain(page, {
    prefs: { version: 2, categories: ['attraction'], maxWalkMinutes: 10, requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [] },
    beforeGoto: (p) => p.route('**/api/v1/recommendations/by-type', (route: Route) => {
      bodies.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ATTRACTION_RECS()) });
    }),
  });
  const chip = card(page).getByRole('button', { name: '도보 10분 이내 조건 해제' });
  await expect(chip).toBeVisible({ timeout: 25_000 });
  await expect(chip).toContainText('🚶 도보 10분 이내');
  expect(bodies.at(-1)?.context?.max_walk_minutes).toBe(10);
  const count = bodies.length;
  await chip.click();
  await expect(chip).toHaveCount(0);
  await expect.poll(() => bodies.length).toBeGreaterThan(count);
  expect(bodies.at(-1)?.context?.max_walk_minutes ?? null).toBeNull();
});

test('a 5-minute walk limit no place meets on foot is not shown as a card chip once the ranking relaxed it', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const bodies: { context?: { max_walk_minutes?: number | null } }[] = [];
  await openMain(page, {
    prefs: { version: 2, categories: ['attraction'], maxWalkMinutes: 5, requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [] },
    // 서버는 실제 걷는 길로 잰다 — 5분 안에는 0곳, 제한을 풀면 목록.
    beforeGoto: (p) => p.route('**/api/v1/recommendations/by-type', (route: Route) => {
      const body = route.request().postDataJSON();
      bodies.push(body);
      const strict = body?.context?.max_walk_minutes === 5;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(strict ? [] : ATTRACTION_RECS()) });
    }),
  });
  await expect(card(page).getByRole('heading', { name: '경주 계림' })).toBeVisible({ timeout: 25_000 });
  await expect.poll(() => bodies.length).toBeGreaterThanOrEqual(2);
  expect(bodies[0]?.context?.max_walk_minutes).toBe(5);
  expect(bodies.at(-1)?.context?.max_walk_minutes ?? null).toBeNull();
  await page.waitForTimeout(600);
  await expect(card(page).getByRole('button', { name: '도보 5분 이내 조건 해제' })).toHaveCount(0);
  await expect(card(page).getByText('🚶 도보 5분 이내')).toHaveCount(0);
});

for (const theme of ['light', 'dark'] as const) {
  test(`390px ${theme}: the voice pill sits on the card and the caption is not covered by the clock`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await openMain(page, { speech: true, theme });
    const peek = page.getByTestId('rec-card-peek');
    await expect(peek).toBeVisible({ timeout: 25_000 });
    const pill = card(page).getByRole('button', { name: 'AI 음성 추천 듣기' });
    await expect(pill).toBeVisible();
    await pill.click();
    const caption = page.getByTestId('voice-caption');
    await expect(caption).toBeVisible();
    await expect(caption).toContainText(/말하는 중|듣는 중|이해하는 중/);
    await expect(caption.getByRole('button', { name: '그만' })).toBeVisible();
    const [captionBox, clockBox] = await Promise.all([
      caption.boundingBox(),
      page.locator('[aria-label$="KST"]').boundingBox(),
    ]);
    expect(captionBox!.y).toBeGreaterThanOrEqual(120);
    expect(captionBox!.y).toBeGreaterThanOrEqual(clockBox!.y + clockBox!.height);
    const onTop = await caption.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + 12);
      return !!hit && el.contains(hit);
    });
    expect(onTop).toBe(true);
    // 켜진 동안 다시 누르면 멈춘다(I84) — 알약 이름이 '음성 안내 정지' 다.
    await card(page).getByRole('button', { name: '음성 안내 정지' }).click();
    await expect(caption).toHaveCount(0);
  });
}

test('1536x730: the voice caption sits beside the card and never covers the value line it reads out', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page, { speech: true });
  await expect(card(page).getByTestId('value-box')).toBeVisible({ timeout: 25_000 });
  await page.getByTestId('voice-slot').getByRole('button', { name: 'AI 음성 추천 듣기' }).click();
  const caption = page.getByTestId('voice-caption');
  await expect(caption).toBeVisible();
  // 리뷰 10-07: 자막이 열 맨 위에 겹쳐 지금 읽어 주는 가치 문장(카드 맨 위)을 덮고 '일치' 한 낱말만 남았다.
  const [c, v, pill] = await Promise.all([
    caption.boundingBox(),
    card(page).getByTestId('value-box').boundingBox(),
    page.getByTestId('voice-slot').boundingBox(),
  ]);
  const apart = (a: typeof c, b: typeof c) => !!a && !!b && (a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  expect(apart(c, v), 'caption covers the value box').toBe(true);
  expect(apart(c, pill), 'caption covers the voice pill').toBe(true);
  expect(c!.x).toBeGreaterThanOrEqual(76); // 왼쪽 레일 밖, 지도 위
  expect(c!.y + c!.height).toBeLessThanOrEqual(730);
  const onTop = await caption.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.x + b.width / 2, b.y + 12);
    return !!hit && el.contains(hit);
  });
  expect(onTop).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// 휴대폰 — 카드 안 알약, 가로 넘침 없음(라이트·다크)
// ───────────────────────────────────────────────────────────────────────────

for (const viewport of PHONES) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${viewport.width}x${viewport.height} ${theme}: peek and full card keep the new face without horizontal overflow`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize(viewport);
      await openMain(page, { theme, speech: true });
      await expect(page.getByTestId('rec-card-peek')).toBeVisible({ timeout: 25_000 });
      await expect(card(page).getByRole('button', { name: 'AI 음성 추천 듣기' })).toBeVisible();
      // 미리보기는 '도보 N분' 을 한 번만 말한다(가치 문장이 이미 말하면 칩으로 되풀이하지 않는다 — 리뷰 10-07).
      const peekText = await page.getByTestId('rec-card-peek').innerText();
      expect(peekText.match(/도보 \d+분/g)?.length ?? 0, peekText).toBe(1);
      await expandPeek(page);
      await expect(card(page).getByText(/대릉원 혼잡 → 경주 계림 한산/)).toBeVisible();
      await expect(card(page).getByTestId('card-photo')).toBeVisible();
      const details = card(page).getByRole('button', { name: '상세 정보 펼치기' });
      await details.scrollIntoViewIfNeeded();
      await expect(details).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 술집 태그(camelCase) · 밤의 첫 화면 · 직접 고른 카드 · 계약
// ───────────────────────────────────────────────────────────────────────────

test('the default 음식점 tab never recommends a bar tagged in camelCase', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page, {
    categories: ['restaurant'],
    // 서버가 술집을 1위로 줘도(데이터 한계) 화면은 음식점 후보에서 뺀다.
    byType: (type) => (type === 'restaurant' ? [rec(RESTAURANTS[0], 1), rec(RESTAURANTS[2], 2)] : []),
  });
  await expect(card(page).getByRole('heading', { name: '황남 쌈밥' })).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText('동주 술집')).toHaveCount(0);
});

test('night first view: with no open restaurant the first screen opens 관광지 once and says so', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const closed = RESTAURANTS.map((row) => ({ ...row, operating_hours: { open: '11:00~11:01', closed: '연중무휴' } }));
  await page.route('**://tong.visitkorea.or.kr/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }));
  await stubMain(page, {
    facilities: [...ATTRACTIONS, DAEREUNGWON, ...closed],
    byType: (type) => (type === 'attraction' ? ATTRACTION_RECS() : []),
  });
  await page.goto('/main');
  await expect(page.getByText('지금 문 연 곳이 많은 관광지부터 보여드려요')).toBeVisible({ timeout: 25_000 });
  await expect(card(page).getByRole('heading', { name: '경주 계림' })).toBeVisible();
  // 사용자가 직접 음식점을 누르면 종전대로 제안 카드(A5)가 고를 칩을 보여 준다 — 다시 옮기지 않는다.
  await page.getByRole('button', { name: '음식점', exact: true }).click();
  await expect(page.getByTestId('category-suggestion')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByRole('button', { name: '관광지', exact: true })).toBeVisible();
});

test('a pin outside the list opens as 선택한 장소, a search hit too, and a list pin keeps its rank', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page, { fakeMap: true });
  await expect(card(page).getByTestId('card-rank')).toHaveText('베스트 추천', { timeout: 25_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as KakaoFakeWindow).__kakaoFake.markers())).toContain('숨은 고분길');
  await page.evaluate(() => (window as unknown as KakaoFakeWindow).__kakaoFake.click('숨은 고분길'));
  await expect(card(page).getByRole('heading', { name: '숨은 고분길' })).toBeVisible();
  await expect(card(page).getByTestId('card-rank')).toHaveText('선택한 장소');
  for (let i = 0; i < 3; i += 1) {
    await page.waitForTimeout(300);
    await expect(card(page).getByTestId('card-rank')).toHaveText('선택한 장소');
  }
  await page.evaluate(() => (window as unknown as KakaoFakeWindow).__kakaoFake.click('경주 향교'));
  await expect(card(page).getByRole('heading', { name: '경주 향교' })).toBeVisible();
  await expect(card(page).getByTestId('card-rank')).toHaveText('2번째 추천');
  // 검색으로 찾은 우리 DB 장소는 Enter 로 카드가 된다(I84) — 글자마다 카드를 바꾸지 않는다(리뷰 10-07).
  const search = page.getByPlaceholder('경주 장소·메뉴·분위기 검색');
  await search.fill('월정교');
  await page.waitForTimeout(800);
  await expect(card(page).getByRole('heading', { name: '경주 향교' })).toBeVisible();
  await search.press('Enter');
  await expect(card(page).getByRole('heading', { name: '월정교 산책길' })).toBeVisible();
  await expect(card(page).getByTestId('card-rank')).toHaveText('선택한 장소');
  // 다른 종류의 이름이면 그 종류의 칩으로 옮겨 연다 — 관광지 칩에 음식점 카드가 뜨지 않는다.
  await search.fill('황남 쌈밥');
  await search.press('Enter');
  await expect(card(page).getByRole('heading', { name: '황남 쌈밥' })).toBeVisible();
  await expect(page.getByRole('button', { name: '음식점', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(card(page).getByTestId('card-rank')).toHaveText('선택한 장소');
});

test('관심 없어요 tells once that the taste profile was updated, with a link to My page', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page);
  await expect(card(page).getByRole('heading', { name: '경주 계림' })).toBeVisible({ timeout: 25_000 });
  await card(page).getByRole('button', { name: '이 추천에 관심 없음, 다른 장소 추천받기' }).click();
  await expect(page.getByText('취향 프로필에 반영했어요')).toBeVisible();
  await expect(page.getByRole('button', { name: '보기', exact: true })).toBeVisible();
  await expect(card(page).getByRole('heading', { name: '경주 향교' })).toBeVisible();
});

test('contract: /main?place=<id> opens that place as 선택한 장소 in its own category', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page, { categories: ['restaurant'], url: `/main?place=${String(ATTRACTIONS[3].id)}`,
    byType: (type) => (type === 'attraction' ? ATTRACTION_RECS() : type === 'restaurant' ? [rec(RESTAURANTS[2], 1)] : []) });
  await expect(card(page).getByRole('heading', { name: '월정교 산책길' })).toBeVisible({ timeout: 25_000 });
  await expect(card(page).getByTestId('card-rank')).toHaveText('선택한 장소');
  await page.waitForTimeout(2000);
  await expect(card(page).getByRole('heading', { name: '월정교 산책길' })).toBeVisible();
  await expect(page.getByRole('button', { name: '관광지', exact: true })).toBeVisible();
});

test('contract: ?focus=live opens 관광지, ?focus=voice rings the pill, ?focus=forecast turns the heatmap on', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page, { categories: ['restaurant'], url: '/main?focus=live',
    byType: (type) => (type === 'attraction' ? ATTRACTION_RECS() : type === 'restaurant' ? [rec(RESTAURANTS[2], 1)] : []) });
  await expect(card(page).getByRole('heading', { name: '경주 계림' })).toBeVisible({ timeout: 25_000 });
  await expect(card(page).getByRole('button', { name: '실시간 정보 새로고침' })).toBeVisible();

  await page.goto('/main?focus=voice');
  const pill = page.getByRole('button', { name: 'AI 음성 추천 듣기' });
  await expect(pill).toBeVisible({ timeout: 25_000 });
  await expect(pill).toHaveClass(/ring-gold/);

  await page.goto('/main?focus=forecast');
  await expect(page.getByRole('button', { name: /히트맵/ }).first()).toHaveAttribute('aria-pressed', 'true', { timeout: 25_000 });
  await expect(page.locator('[data-focus-target="forecast"]')).toHaveClass(/ring-gold/);
});
