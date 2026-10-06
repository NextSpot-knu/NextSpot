import { expect, test } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 한국어 줄바꿈(2026-10-06 감사 I61)과 로그인 화면 언어 칩 겹침(I65).
//
// 한국어는 낱말 단위로만 줄을 바꾼다(html:lang(ko) body { word-break: keep-all; overflow-wrap: break-word }).
// keep-all 은 낱말이 칸보다 길면 칸을 밀어낼 수 있어, 좁은 폰(360)에서 가로 스크롤이 생기지 않는지 화면마다 본다.
// anywhere 를 쓰지 않은 이유(이메일·'TourAPI'·'1,240분' 이 글자 단위로 쪼개진다)는 이메일 한 줄 검사로 잠근다.

test.beforeEach(async ({ page }) => {
  await stubExternalServices(page);
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
});

const PAGES_360 = ['/', '/setup', '/login', '/saved', '/mypage', '/mypage/coupons', '/mypage/impact', '/mypage/privacy', '/merchant', '/guide'];

test('Korean screens have no horizontal scroll at 360px and wrap at word boundaries', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.addInitScript(() => localStorage.setItem('nextspot_onboarding_done', '1'));
  for (const path of PAGES_360) {
    await page.goto(path);
    await expect(page.locator('body')).toBeVisible();
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path}: 360px 에서 가로 스크롤`).toBeLessThanOrEqual(1);
  }
  await expect(page.locator('body')).toHaveCSS('word-break', 'keep-all');
  await expect(page.locator('body')).toHaveCSS('overflow-wrap', 'break-word');
});

test('only Korean switches to word-boundary wrapping', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nextspot_locale', 'ja'));
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('body')).toHaveCSS('word-break', 'normal');
});

test('judge account emails stay on one line on /login at 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/login');
  const hint = page.getByRole('region', { name: '공모전 심사용 계정' });
  await expect(hint).toBeVisible({ timeout: 30_000 });
  for (const email of ['openapi@naver.com', 'openapi@gmail.com']) {
    const node = hint.getByText(email, { exact: true });
    await expect(node).toBeVisible();
    expect(await node.evaluate((el) => el.getClientRects().length), `${email} 이 두 줄로 갈라졌다`).toBe(1);
  }
});

for (const locale of ['ko', 'en', 'ja', 'zh'] as const) {
  for (const width of [360, 390]) {
    test(`${locale} /login language pill never touches the heading at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((code) => localStorage.setItem('nextspot_locale', code), locale);
      await page.goto('/login');
      const heading = page.getByRole('heading', { level: 1, name: 'NextSpot' });
      await expect(heading).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      const pill = page.locator('label').filter({ has: page.locator('select') }).first();
      const h = (await heading.boundingBox())!;
      const p = (await pill.boundingBox())!;
      // 칩은 제목보다 위에서 끝난다 — 가로로 겹치지 않아도 세로로 붙어 있으면 실패로 본다.
      expect(p.y + p.height, `${locale} ${width}px: 언어 칩이 제목을 덮는다`).toBeLessThanOrEqual(h.y);
    });
  }
}
