import { expect, test, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 지도 SDK 뿐 아니라 **Supabase 인증까지** 막는다. 익명 세션이 제때 붙지 않으면
// recommendByType 이 AuthError 를 던지고, 화면이 '조건에 맞는 곳 0건' 을 '장애' 로 바꿔 말한다
// (support/stubs.ts 주석 참조 — 실제로 이 묶음을 불안정하게 만들던 원인이다).
async function mockKakaoSdk(page: Page) {
  await stubExternalServices(page);
}

test.beforeEach(async ({ page }) => stubExternalServices(page));

const recommendations = [
  ['rec-a', '고요한 찻집', 0.91, 120],
  ['rec-b', '박물관 카페', 0.82, 180],
  ['rec-c', '한옥 쉼터', 0.74, 240],
].map(([id, name, score, distance], index) => ({
  recommendation_id: id,
  facility: {
    id: `facility-${index}`, name, type: 'cafe', latitude: 35.838 + index * 0.001,
    longitude: 129.209, capacity: 30, coupon_rate: index === 0 ? 0.1 : 0,
    features: { indoor: true }, operating_hours: { open: '09:00~22:00', closed: '연중무휴' },
  },
  spot_score: score, distance_m: distance, rank: index + 1, total_candidates: 3,
  breakdown: {
    preference: 0.8, wait_time: null, travel_time: 3 + index, incentive: 0.2,
    area_demand_level: 0.68, area_demand_mode: 'live',
    area_demand_sources: ['parking', 'tourism'],
    area_demand_observed_at: '2026-08-20T01:00:00+00:00',
  },
  reason: `${name} 고정 추천 사유`, reason_source: index === 0 ? 'llm' : 'template',
  congestion_level: null, congestion_source: 'none', open_status_at_arrival: 'open_expected',
  scoring_mode: 'area_stats_rules', prediction_source: 'unavailable',
}));

const firstReportCta = {
  // 현장 정보가 없는 곳의 제보 알약 — '수집 중' 빈 상태 대신 관광객에게 묻는다(report.triggerFirst, 계획 A3).
  ko: '지금 붐비나요? 알려 주세요',
  en: 'Busy now? Tell us',
  ja: '今混んでいますか？教えてください',
  zh: '现在拥挤吗？告诉我们',
} as const;

const areaDemandLabel = {
  ko: '주변 수요: 보통',
  en: 'Area demand: Moderate',
  ja: '周辺需要: 普通',
  zh: '周边需求: 一般',
} as const;

/** 카드마다의 '추천 근거 자세히'(card.whyToggle) — 주변 수요 근거는 그 뒤에 있다(계획 B5/P11). */
const whyToggle = {
  ko: '추천 근거 자세히',
  en: 'See why we picked it',
  ja: 'おすすめの根拠を見る',
  zh: '查看推荐依据',
} as const;

const zeroWaitCopy = {
  ko: '예상 대기 0분',
  en: 'estimated 0-minute wait',
  ja: '予想待ち時間は0分',
  zh: '预计等待0分钟',
} as const;

async function mockRecommendationPage(
  page: Page,
  options: {
    locale?: 'ko' | 'en' | 'ja' | 'zh';
    reasonSource?: 'llm' | 'template';
    unknownHours?: boolean;
  } = {},
) {
  await mockKakaoSdk(page);
  const locale = options.locale ?? 'ko';
  const responseItems = recommendations.map(item => ({
    ...item,
    reason_source: options.reasonSource ?? item.reason_source,
    open_status_at_arrival: options.unknownHours ? 'needs_confirmation' : item.open_status_at_arrival,
    facility: options.unknownHours ? {
      ...item.facility,
      operating_hours: null,
      features: { ...item.facility.features, kakao_place_id: '123456' },
    } : item.facility,
  }));
  await page.addInitScript((selectedLocale) => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    localStorage.setItem('nextspot_locale', selectedLocale);
    window.open = ((url?: string | URL) => {
      (window as unknown as { __opened?: string }).__opened = String(url);
      return window;
    }) as typeof window.open;
  }, locale);
  await page.route('**/auth/v1/**', async route => {
    const userId = '11111111-1111-4111-8111-111111111111';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'ci-anonymous-access-token',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: 'ci-anonymous-refresh-token',
        user: {
          id: userId,
          aud: 'authenticated',
          role: 'authenticated',
          email: '',
          is_anonymous: true,
          app_metadata: { provider: 'anonymous', providers: ['anonymous'] },
          user_metadata: {},
          identities: [],
          created_at: '2026-08-25T00:00:00.000Z',
          updated_at: '2026-08-25T00:00:00.000Z',
        },
      }),
    });
  });
  await page.route('**/rest/v1/**', async route => {
    const url = route.request().url();
    if (url.includes('/facilities')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: 'origin', name: '황리단길', type: 'attraction', features: {}, congestion_logs: [],
      }) });
    } else {
      await route.fulfill({ status: 200, headers: { 'content-range': '0-0/1' }, body: '[]' });
    }
  });
  await page.route('**/api/v1/**', async route => {
    const url = route.request().url();
    if (url.endsWith('/api/v1/recommendations')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(responseItems) });
    } else if (url.endsWith('/api/v1/reports/availability')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        success: true, facility_id: 'facility-0', status: 'open', evidence_tier: 'single_report',
        corroborating_count: 1, reported_at: '2026-08-25T12:00:00Z', expires_at: '2026-08-25T12:30:00Z',
      }) });
    } else if (url.includes('/explain')) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"fixture failure"}' });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
  });
}

test('SOLAR on, timeout, and disabled keep identical visible SPOT order', async ({ browser }) => {
  test.setTimeout(60_000); // 세 개의 독립 페이지를 순차 로드하므로 Windows dev server의 첫 컴파일 여유를 둔다.
  const expectedNames = ['고요한 찻집', '박물관 카페', '한옥 쉼터'];
  for (const state of [
    { name: 'on', reasonSource: 'llm' as const },
    { name: 'timeout', reasonSource: 'template' as const },
    { name: 'disabled', reasonSource: 'template' as const },
  ]) {
    const page = await browser.newPage();
    await mockRecommendationPage(page, { reasonSource: state.reasonSource });
    await page.goto(`/explore/recommend?facilityId=origin&lat=35.838&lng=129.209&solar=${state.name}`);
    const cards = page.locator('section.space-y-4 h4');
    // 카드 수 확인 직후 React가 재렌더링될 수 있으므로 텍스트까지 한 번에 기다린다.
    await expect(cards).toHaveText(expectedNames);
    await page.close();
  }
});

for (const locale of ['ko', 'en', 'ja', 'zh'] as const) {
  test(`${locale} recommendation cards keep rank and fit 390px`, async ({ page }) => {
    await mockRecommendationPage(page, { locale });
    await page.goto('/explore/recommend?facilityId=origin&lat=35.838&lng=129.209');
    await expect(page.locator('section.space-y-4 h4')).toHaveCount(3);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('button').filter({ hasText: firstReportCta[locale] })).toHaveCount(3);
    // 주변 수요 근거는 카드 앞면이 아니라 '추천 근거 자세히' 뒤에 있다 — 펼치기 전에는 없고, 펼치면 카드마다 하나.
    await expect(page.getByText(areaDemandLabel[locale], { exact: true })).toHaveCount(0);
    const toggles = page.getByRole('button', { name: whyToggle[locale] });
    await expect(toggles).toHaveCount(3);
    for (let i = 0; i < 3; i++) await toggles.nth(i).click();
    await expect(page.getByText(areaDemandLabel[locale], { exact: true })).toHaveCount(3);
    await expect(page.getByText(zeroWaitCopy[locale], { exact: false })).toHaveCount(0);
    if (locale !== 'ko') {
      await expect(page.getByText(/고정 추천 사유/)).toHaveCount(0);
    }
    await expect.poll(
      () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(1);
  });
}

test('SPOT order is stable, comparison falls back, and navigation persists', async ({ page }) => {
  await mockRecommendationPage(page);
  await page.goto('/explore/recommend?facilityId=origin&lat=35.838&lng=129.209');
  const names = page.locator('section.space-y-4 h4');
  await expect(names).toHaveText(['고요한 찻집', '박물관 카페', '한옥 쉼터']);
  // SPOT 산식 설명에도 "SPOT 91점"이 함께 나타나므로, 점수 배지 자체를 정확 일치로 확인한다.
  await expect(page.getByText('91점', { exact: true })).toBeVisible();

  // Top 3 비교는 목록 아래 '순서 자세히' 뒤에 있다(계획 B5/P11).
  await expect(page.getByRole('button', { name: '상위 추천 비교하기' })).toHaveCount(0);
  await page.getByRole('button', { name: '순서 자세히' }).click();
  await page.getByRole('button', { name: '상위 추천 비교하기' }).click();
  await page.getByRole('button', { name: /왜 1위인가요/ }).click();
  await expect(page.getByText('설명을 다시 불러올게요 — 위의 수치는 그대로 보실 수 있어요.')).toBeVisible();

  await page.getByRole('button', { name: '도보 길안내' }).first().click();
  const active = await page.evaluate(() => JSON.parse(localStorage.getItem('nextspot_active_trip') ?? 'null'));
  expect(active.facilityId).toBe('facility-0');
  expect(active.status).toBe('navigating');
});

test('arrival feedback keeps completion visible and links to coupons', async ({ page }) => {
  const recommendationId = '22222222-2222-4222-8222-222222222222';
  const storedStages = new Set<string>();
  let ratedPayload: { rating?: string; observed_congestion?: string } | null = null;
  let firstArrivalFailed = false;
  await page.addInitScript(() => {
    const trip = { version: 1, facilityId: 'fixture-cafe', name: 'Fixture Cafe', type: 'cafe',
      lat: 35.838, lng: 129.209, acceptedAt: Date.now(), status: 'arrived',
      recommendationId: '22222222-2222-4222-8222-222222222222' };
    localStorage.setItem('nextspot_active_trip', JSON.stringify(trip));
    localStorage.setItem('nextspot_pending_visit', JSON.stringify(trip));
  });
  await page.route('**/api/v1/**', route => {
    if (route.request().url().endsWith(`/recommendations/${recommendationId}/outcome`)) {
      const payload = route.request().postDataJSON() as { stage: string; rating?: string; observed_congestion?: string };
      if (payload.stage === 'arrival_confirmed' && !firstArrivalFailed) {
        firstArrivalFailed = true;
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"retry"}' });
      }
      if (payload.stage === 'rated') ratedPayload = payload;
      storedStages.add(payload.stage);
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('/main');
  await page.evaluate(() => window.dispatchEvent(new Event('nextspot:trip-arrived')));
  await page.getByRole('button', { name: '네, 다녀왔어요' }).click();
  await page.getByRole('button', { name: /한산/ }).click();
  await page.getByRole('button', { name: /좋았어요/ }).click();
  const completed = page.getByTestId('visit-completed');
  await expect(completed).toBeVisible();
  await expect(completed.getByRole('link', { name: '내 쿠폰함' })).toHaveAttribute('href', '/mypage/coupons');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('nextspot_recommendation_outcome_queue'))).toBe('[]');
  expect([...storedStages]).toEqual(['arrival_confirmed', 'rated']);
  expect(ratedPayload).toMatchObject({ rating: 'up', observed_congestion: 'quiet' });
  expect(await page.evaluate(() => localStorage.getItem('nextspot_active_trip'))).toBeNull();
});

test('unknown hours require Kakao confirmation before navigation', async ({ page }) => {
  await mockRecommendationPage(page, { unknownHours: true });
  await page.goto('/explore/recommend?facilityId=origin&lat=35.838&lng=129.209');

  await page.getByRole('button', { name: '도보 길안내' }).first().click();
  await expect(page.getByText('카카오맵에서 지금 영업 중인지 확인하셨나요?')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __opened?: string }).__opened))
    .toBe('https://place.map.kakao.com/123456');
  expect(await page.evaluate(() => localStorage.getItem('nextspot_active_trip'))).toBeNull();

  await page.getByRole('button', { name: '영업 중' }).click();
  const active = await page.evaluate(() => JSON.parse(localStorage.getItem('nextspot_active_trip') ?? 'null'));
  expect(active.facilityId).toBe('facility-0');
  expect(active.status).toBe('navigating');
});

test('empty replan preserves the current journey and shows guidance', async ({ page }) => {
  await page.addInitScript(() => {
    const trip = { version: 1, facilityId: 'fixture-cafe', name: 'Fixture Cafe', type: 'cafe',
      lat: 35.838, lng: 129.209, acceptedAt: Date.now(), status: 'navigating', navigationMode: 'walk' };
    localStorage.setItem('nextspot_active_trip', JSON.stringify(trip));
    localStorage.setItem('nextspot_pending_visit', JSON.stringify(trip));
  });
  await page.route('**/api/v1/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('/main');
  await page.getByRole('button', { name: '상황 변경' }).click();
  await page.getByRole('button', { name: '이 조건으로 재추천' }).first().click();
  await expect(page.getByRole('status')).toContainText('다른 카테고리');
  const active = await page.evaluate(() => JSON.parse(localStorage.getItem('nextspot_active_trip') ?? 'null'));
  expect(active.facilityId).toBe('fixture-cafe');
  expect(active.status).toBe('navigating');
});

test('rate-limited condition parse is sent once and leads to manual condition chips', async ({ page }) => {
  await page.addInitScript(() => {
    const trip = { version: 1, facilityId: 'fixture-cafe', name: 'Fixture Cafe', type: 'cafe',
      lat: 35.838, lng: 129.209, acceptedAt: Date.now(), status: 'navigating', navigationMode: 'walk' };
    localStorage.setItem('nextspot_active_trip', JSON.stringify(trip));
    localStorage.setItem('nextspot_pending_visit', JSON.stringify(trip));
  });
  let parseCalls = 0;
  await page.route('**/api/v1/**', async route => {
    if (route.request().url().includes('/api/v1/travel-context/parse')) {
      parseCalls += 1;
      await route.fulfill({ status: 429, contentType: 'application/json', headers: { 'Retry-After': '30' },
        body: JSON.stringify({ detail: 'rate limited' }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('/main');
  await page.getByRole('button', { name: '상황 변경' }).click();
  await page.locator('#trip-change').fill('그냥 좀 다른 데');
  await page.getByRole('button', { name: '조건 확인', exact: true }).click();
  // 429 를 '표현을 바꿔 보세요' 로 안내하지 않고, 칩으로 바로 고르게 한다(재시도 없음 — B4).
  await expect(page.getByText('아래에서 조건을 직접 골라 주세요.')).toBeVisible();
  await expect(page.getByText('조건을 찾지 못했어요')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '이 조건으로 재추천' }).first()).toBeEnabled();
  expect(parseCalls).toBe(1);
});
