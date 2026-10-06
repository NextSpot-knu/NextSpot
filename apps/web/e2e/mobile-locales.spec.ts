import { expect, test } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 외부로 나가는 호출을 전부 막는다 — 지도 SDK 와 Supabase 인증(support/stubs.ts).
test.beforeEach(async ({ page }) => stubExternalServices(page));

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

// 하단 탭 '분산 코스'(띄어 쓴 한 글자 더 긴 이름)가 가장 좁은 폰에서도 제 칸 안에 한 줄로 들어간다.
test('ko bottom-nav label 분산 코스 fits its tab at 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.addInitScript(() => localStorage.setItem('nextspot_onboarding_done', '1'));
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('/saved');
  // 데스크톱 레일도 같은 이름의 nav 라 DOM 에 둘이다 — 보이는(접근성 트리에 있는) 휴대폰 탭만 잡는다.
  const tab = page.getByRole('button', { name: '분산 코스', exact: true });
  await expect(tab).toBeVisible({ timeout: 30_000 });
  const fit = await tab.evaluate((button) => {
    const label = button.querySelector('span') as HTMLElement;
    const b = button.getBoundingClientRect();
    const l = label.getBoundingClientRect();
    return { inside: l.left >= b.left - 0.5 && l.right <= b.right + 0.5, lines: label.getClientRects().length };
  });
  expect(fit.inside).toBe(true);
  expect(fit.lines).toBe(1);
});

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

test('manual dark theme is restored before the tourist screen renders', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nextspot_theme', 'dark'));
  await page.goto('/mypage/settings');
  await expect(page.locator('html')).toHaveClass(/nextspot-dark/);
  await expect(page.getByRole('radio', { name: '다크' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('body')).toHaveCSS('color-scheme', 'dark');
});

// 대기 보드 하단 ⓒ TourAPI 줄은 폰에서 두 줄 안 — 길어지면 출처 각주가 아니라 본문처럼 읽힌다.
for (const locale of locales) {
  for (const width of [360, 390]) {
    test(`${locale} waiting board data credit fits in two lines at ${width}px`, async ({ page }) => {
      test.setTimeout(90_000); // 첫 /waiting 컴파일(Windows dev server) 여유 — 재시도가 아니라 시간
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((value) => {
        localStorage.setItem('nextspot_onboarding_done', '1');
        localStorage.setItem('nextspot_locale', value);
      }, locale);
      await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
      await page.goto('/waiting');
      const credit = page.locator('main p', { hasText: 'TourAPI' }).last();
      await expect(credit).toBeVisible({ timeout: 60_000 });
      // 언어가 적용되고 웹 글꼴이 도착해 줄바꿈이 끝난 뒤에 잰다.
      if (locale !== 'ko') await expect(credit).not.toContainText('장소 정보');
      await page.evaluate(() => document.fonts.ready);
      const lines = await credit.evaluate((el) => {
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        const content = box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
          - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
        return content / parseFloat(style.lineHeight);
      });
      expect(lines, `${locale} ${width}px: 하단 출처 줄 수`).toBeLessThanOrEqual(2.05);
      // 줄이 바뀐다면 괄호 앞에서만 — 덧붙임 '(출처를 따로 적은 것 제외)' 가 두 줄로 갈라지지 않는다.
      const note = credit.locator('span.whitespace-nowrap');
      await expect(note).toHaveCount(1);
      expect(await note.evaluate((el) => el.getClientRects().length), `${locale} ${width}px: 괄호 덧붙임 한 줄`).toBe(1);
    });
  }
}
