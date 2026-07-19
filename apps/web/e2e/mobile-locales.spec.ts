import { expect, test } from '@playwright/test';

const locales = ['ko', 'en', 'ja', 'zh'] as const;

for (const locale of locales) {
  test(`${locale} core screen has no horizontal overflow at 390px`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('nextspot_locale', value), locale);
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

test('external Kakao navigation is fixed and does not leave the test page', async ({ page }) => {
  await page.addInitScript(() => {
    const trip = {
      version: 1, facilityId: 'fixture-cafe', name: 'Fixture Cafe', type: 'cafe',
      lat: 35.838, lng: 129.209, acceptedAt: Date.now(), status: 'navigating',
      walkMinutes: 5, navigationMode: 'walk',
    };
    localStorage.setItem('nextspot_active_trip', JSON.stringify(trip));
    localStorage.setItem('nextspot_pending_visit', JSON.stringify(trip));
    window.open = ((url?: string | URL) => {
      (window as unknown as { __opened?: string }).__opened = String(url);
      return window;
    }) as typeof window.open;
  });
  await page.route('**/api/v1/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('/main');
  const resume = page.getByRole('button', { name: /길안내|directions|案内|导航/i }).last();
  await expect(resume).toBeVisible({ timeout: 20_000 });
  await resume.click();
  const opened = await page.evaluate(() => (window as unknown as { __opened?: string }).__opened);
  expect(opened).toContain('map.kakao.com');
});
