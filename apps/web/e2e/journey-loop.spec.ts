import { expect, test, type Page } from '@playwright/test';

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
  breakdown: { preference: 0.8, wait_time: 5, travel_time: 3 + index, incentive: 0.2 },
  reason: `${name} 고정 추천 사유`, reason_source: index === 0 ? 'llm' : 'template',
  congestion_level: null, congestion_source: 'none', open_status_at_arrival: 'open_expected',
}));

async function mockRecommendationPage(
  page: Page,
  options: { locale?: 'ko' | 'en' | 'ja' | 'zh'; reasonSource?: 'llm' | 'template' } = {},
) {
  const locale = options.locale ?? 'ko';
  const responseItems = recommendations.map(item => ({
    ...item,
    reason_source: options.reasonSource ?? item.reason_source,
  }));
  await page.addInitScript((selectedLocale) => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    localStorage.setItem('nextspot_locale', selectedLocale);
    window.open = ((url?: string | URL) => {
      (window as unknown as { __opened?: string }).__opened = String(url);
      return window;
    }) as typeof window.open;
  }, locale);
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
    } else if (url.includes('/explain')) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"fixture failure"}' });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
  });
}

test('SOLAR on, timeout, and disabled keep identical visible SPOT order', async ({ browser }) => {
  const rankings: string[][] = [];
  for (const state of [
    { name: 'on', reasonSource: 'llm' as const },
    { name: 'timeout', reasonSource: 'template' as const },
    { name: 'disabled', reasonSource: 'template' as const },
  ]) {
    const page = await browser.newPage();
    await mockRecommendationPage(page, { reasonSource: state.reasonSource });
    await page.goto(`/explore/recommend?facilityId=origin&lat=35.838&lng=129.209&solar=${state.name}`);
    await expect(page.locator('section.space-y-4 h4')).toHaveCount(3);
    const names = await page.locator('section.space-y-4 h4').allTextContents();
    expect(names).toEqual(['고요한 찻집', '박물관 카페', '한옥 쉼터']);
    rankings.push(names);
    await page.close();
  }
  expect(rankings[0]).toEqual(rankings[1]);
  expect(rankings[1]).toEqual(rankings[2]);
});

for (const locale of ['ko', 'en', 'ja', 'zh'] as const) {
  test(`${locale} recommendation cards keep rank and fit 390px`, async ({ page }) => {
    await mockRecommendationPage(page, { locale });
    await page.goto('/explore/recommend?facilityId=origin&lat=35.838&lng=129.209');
    await expect(page.locator('section.space-y-4 h4')).toHaveCount(3);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
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
  await expect(page.getByText('91점')).toBeVisible();

  await page.getByRole('button', { name: '상위 추천 비교하기' }).click();
  await page.getByRole('button', { name: /왜 1위인가요/ }).click();
  await expect(page.getByText(/설명을 불러오지 못했어요/)).toBeVisible();

  await page.getByRole('button', { name: '도보 길안내' }).first().click();
  const active = await page.evaluate(() => JSON.parse(localStorage.getItem('nextspot_active_trip') ?? 'null'));
  expect(active.facilityId).toBe('facility-0');
  expect(active.status).toBe('navigating');
});

test('arrival feedback keeps completion visible and links to coupons', async ({ page }) => {
  let congestionPayload: Record<string, unknown> | null = null;
  await page.addInitScript(() => {
    const trip = { version: 1, facilityId: 'fixture-cafe', name: 'Fixture Cafe', type: 'cafe',
      lat: 35.838, lng: 129.209, acceptedAt: Date.now(), status: 'arrived' };
    localStorage.setItem('nextspot_active_trip', JSON.stringify(trip));
    localStorage.setItem('nextspot_pending_visit', JSON.stringify(trip));
  });
  await page.route('**/api/v1/**', route => {
    if (route.request().url().endsWith('/api/v1/reports/congestion')) {
      congestionPayload = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('/main');
  await page.evaluate(() => window.dispatchEvent(new Event('nextspot:trip-arrived')));
  await page.getByRole('button', { name: '네, 다녀왔어요' }).click();
  await page.getByRole('button', { name: /Fixture Cafe 혼잡도 제보하기/ }).click();
  await page.getByRole('radio', { name: /한산/ }).click();
  await page.getByRole('button', { name: '제보하기', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(congestionPayload).toEqual({ facility_id: 'fixture-cafe', level: '한산' });
  await page.getByRole('button', { name: /좋았어요/ }).click();
  const completed = page.getByTestId('visit-completed');
  await expect(completed).toBeVisible();
  await expect(completed.getByRole('link', { name: '내 쿠폰함' })).toHaveAttribute('href', '/mypage/coupons');
  expect(await page.evaluate(() => localStorage.getItem('nextspot_active_trip'))).toBeNull();
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
