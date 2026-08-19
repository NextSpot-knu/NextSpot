import { expect, test, type Page } from '@playwright/test';

async function mockColdRecommendation(page: Page) {
  await page.addInitScript(() => {
    localStorage.removeItem('nextspot_onboarding_done');
    localStorage.removeItem('nextspot_setup_prefs');
    localStorage.setItem('nextspot_locale', 'ko');
  });
  await page.route('**/rest/v1/**', async route => {
    const url = route.request().url();
    if (url.includes('/facilities')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'origin', name: '황리단길', type: 'attraction', features: {}, congestion_logs: [],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { 'content-range': '*/0' },
      contentType: 'application/json',
      body: '[]',
    });
  });
  await page.route('**/api/v1/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '[]',
  }));
}

test('landing only advances through an explicit action', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem('nextspot_setup_prefs');
    localStorage.setItem('nextspot_locale', 'ko');
  });
  await page.goto('/');

  const start = page.getByRole('button', { name: '바로 시작' });
  await expect(start).toBeEnabled();
  await page.keyboard.press('Tab');
  await expect(page).toHaveURL(/\/$/);
  await expect(start).toBeVisible();

  await start.click();
  await expect(page).toHaveURL(/\/setup$/, { timeout: 15_000 });
});

test('setup keeps optional conditions collapsed and persists core choices', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nextspot_locale', 'ko'));
  await page.goto('/setup');

  await expect(page.getByText('지금 쓸 수 있는 시간')).toBeHidden();
  await page.getByRole('button', { name: /상세 조건 더 보기/ }).click();
  await expect(page.getByText('지금 쓸 수 있는 시간')).toBeVisible();

  await page.getByRole('button', { name: '음식점' }).click();
  await page.getByRole('button', { name: '10분' }).first().click();
  await page.getByRole('button', { name: '지도로 보기' }).click();
  await expect(page).toHaveURL(/\/main$/);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('nextspot_setup_prefs') || '{}'));
  expect(stored.categories).toEqual(['restaurant']);
  expect(stored.maxWalkMinutes).toBe(10);
});

test('cold recommendation onboarding accepts one place type', async ({ page }) => {
  await mockColdRecommendation(page);
  await page.goto('/explore/recommend?facilityId=origin&lat=35.838&lng=129.209');

  await expect(page.getByRole('heading', { name: '어떤 곳을 찾고 있나요?' })).toBeVisible();
  await page.getByRole('button', { name: /음식점/ }).click();
  const submit = page.getByRole('button', { name: '선택한 조건으로 보기 (1)' });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole('heading', { name: '어떤 곳을 찾고 있나요?' })).toBeHidden();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('nextspot_onboarding_done'))).toBe('1');
});
