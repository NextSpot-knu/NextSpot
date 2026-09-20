import { expect, test } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await stubExternalServices(page);
  // The guide must stay readable when product data is unavailable. No production writes.
  await page.route('**/api/v1/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.route('**/rest/v1/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
});

const locales = [
  { code: 'ko', heading: '가고 싶은 경주.', guide: 'NextSpot 알아보기' },
  { code: 'en', heading: 'The Gyeongju you love.', guide: 'Discover NextSpot' },
  { code: 'ja', heading: '行きたい慶州。', guide: 'NextSpotを知る' },
  { code: 'zh', heading: '想去的庆州。', guide: '了解 NextSpot' },
] as const;

for (const locale of locales) {
  test(`${locale.code} guide renders offline, fits mobile and exposes real routes`, async ({ page }) => {
    await page.addInitScript(code => {
      localStorage.setItem('nextspot_locale', code);
      localStorage.setItem('nextspot_theme', 'light');
    }, locale.code);
    await page.goto('/guide');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(locale.heading);
    await expect(page.locator('[data-chapter]')).toHaveCount(6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator('a[href="/setup"]')).toHaveCount(1);
    await expect(page.locator('a[href="/merchant"]')).toHaveCount(1);
    await expect(page.locator('a[href="/admin/dashboard"]')).toHaveCount(1);
    await page.locator('[data-chapter="features"] summary').first().click();
    await expect(page.locator('[data-chapter="features"] details').first()).toHaveAttribute('open', '');
    await expect(page.locator('body')).not.toContainText(/guide\.(hero|step|source|feature|story|pilot|business|team|resident|plan|weeks|future)/);
  });
}

test('landing guide is keyboard accessible, traps focus and Escape restores its trigger', async ({ page }) => {
  await page.goto('/');
  const launcher = page.getByRole('button', { name: 'NextSpot 알아보기' });
  await launcher.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'NextSpot 알아보기' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog')))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(launcher).toBeFocused();
  await expect(page).toHaveURL(/\/$/);
});

test('opening guide preserves theme and current page; CTA closes before navigation', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nextspot_theme', 'dark'));
  await page.goto('/mypage/settings');
  const navHeight = await page.locator('nav:visible').evaluate(el => el.getBoundingClientRect().height);
  const contentPadding = await page.locator('main').evaluate(el => Number.parseFloat(getComputedStyle(el).paddingBottom));
  expect(contentPadding).toBeGreaterThan(navHeight);
  const launcher = page.getByRole('button', { name: 'NextSpot 알아보기' });
  await launcher.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/nextspot-dark/);
  await dialog.getByRole('button', { name: '소개 닫기' }).click();
  await expect(launcher).toBeFocused();
  await expect(page).toHaveURL(/\/mypage\/settings/);
  await expect(page.getByRole('radio', { name: '다크' })).toHaveAttribute('aria-checked', 'true');
  await launcher.click();
  await dialog.locator('a[href="/setup"]').click();
  await expect(page).toHaveURL(/\/setup/);
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
});

test('desktop and small mobile guide remain readable in both themes', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const scenario of [
    { width: 1440, height: 1000, theme: 'light' },
    { width: 390, height: 844, theme: 'dark' },
    { width: 320, height: 740, theme: 'light' },
  ]) {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.addInitScript(theme => localStorage.setItem('nextspot_theme', theme), scenario.theme);
    await page.goto('/guide');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`guide-${scenario.width}-${scenario.theme}.png`), fullPage: scenario.width === 390 });
  }
});
