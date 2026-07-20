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

async function mockRecommendationPage(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    localStorage.setItem('nextspot_locale', 'ko');
    window.open = ((url?: string | URL) => {
      (window as unknown as { __opened?: string }).__opened = String(url);
      return window;
    }) as typeof window.open;
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
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(recommendations) });
    } else if (url.includes('/explain')) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"fixture failure"}' });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
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
  await page.addInitScript(() => {
    const trip = { version: 1, facilityId: 'fixture-cafe', name: 'Fixture Cafe', type: 'cafe',
      lat: 35.838, lng: 129.209, acceptedAt: Date.now(), status: 'arrived' };
    localStorage.setItem('nextspot_active_trip', JSON.stringify(trip));
    localStorage.setItem('nextspot_pending_visit', JSON.stringify(trip));
  });
  await page.route('**/api/v1/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('/main');
  await page.evaluate(() => window.dispatchEvent(new Event('nextspot:trip-arrived')));
  await page.getByRole('button', { name: '네, 다녀왔어요' }).click();
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
