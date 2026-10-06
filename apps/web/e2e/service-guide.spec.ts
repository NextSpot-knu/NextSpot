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
  { code: 'ko', heading: '줄 서는 대신', guide: 'NextSpot 알아보기', answer: '관광객의 문제와 NextSpot의 해결', problem: '사람이 몰린 한 곳에서 여행 시간이 멈춥니다', solution: '도착할 때 덜 붐비는 주변 장소로 바로 전환' },
  { code: 'en', heading: 'Skip the queue.', guide: 'Discover NextSpot', answer: 'The traveler’s problem and NextSpot’s solution', problem: 'Your trip stalls where everyone gathers', solution: 'Switch to a less crowded nearby place before you arrive' },
  { code: 'ja', heading: '並ぶ代わりに', guide: 'NextSpotを知る', answer: '旅行者の問題とNextSpotの解決策', problem: '人が集中する一か所で、旅の時間が止まります', solution: '到着時により空いている周辺の場所へ切り替える' },
  { code: 'zh', heading: '少排一次队', guide: '了解 NextSpot', answer: '游客的问题与 NextSpot 的解决方案', problem: '所有人挤在一处，旅行时间就停在那里', solution: '在抵达前切换到周边更少拥挤的地点' },
] as const;

for (const locale of locales) {
  test(`${locale.code} guide renders offline, fits mobile and exposes real routes`, async ({ page }) => {
    await page.addInitScript(code => {
      localStorage.setItem('nextspot_locale', code);
      localStorage.setItem('nextspot_theme', 'light');
    }, locale.code);
    await page.goto('/guide');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(locale.heading);
    const answer = page.getByRole('group', { name: locale.answer });
    await expect(answer).toBeVisible();
    await expect(answer.getByRole('heading', { name: locale.problem })).toBeVisible();
    await expect(answer.getByRole('heading', { name: locale.solution })).toBeVisible();
    await expect(answer.locator('li')).toHaveCount(6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator('a[href="/setup"]')).toHaveCount(1);
    // 옛 챕터 기계는 계속 금지하되, 맨 아래 접힘 두 개는 의도된 예외다 — '계획'(<details data-plan-fold>,
    // 2026-09-21 PM 지시: 실행 계획을 기본 접힘으로 최하단 배치)과 '데이터'(<details data-data-fold>,
    // 공사 API 를 어디에 썼는지 한 표로 — 홈 푸터의 출처 줄이 펼친 채로 연다). 둘 다 기본 접힘을 잠근다.
    await expect(page.locator('[data-chapter], details:not([data-plan-fold]):not([data-data-fold])')).toHaveCount(0);
    await expect(page.locator('details[data-plan-fold]')).toHaveCount(1);
    await expect(page.locator('details[data-plan-fold]')).not.toHaveAttribute('open', '');
    await expect(page.locator('details[data-data-fold]')).toHaveCount(1);
    await expect(page.locator('details[data-data-fold]')).not.toHaveAttribute('open', '');
    await expect(page.locator('body')).not.toContainText(/취향을 따라가면|SPOT 계산|심사위원용|For judges|guide\.(hero|problem|solution)/);
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
  await dialog.locator('a[href="/setup"]').first().click();
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

// 데이터 절의 표는 제출한 기능설명서·코드와 같은 말을 해야 한다(2026-10-06 감사 I43):
// 장소 상세는 일 1회 적재 + 요청 시 실시간, 축제·키워드 검색은 요청 시 조회, 공영주차 수집은 10분,
// 꺼져 있는 연관 관광지(areaBasedList1)는 적지 않는다. 신선도 조회가 실패하면(여기서는 503) 폴백 문장이 보인다.
for (const locale of [
  { code: 'ko', parking: '10분', detail: '일 1회 (04:00 KST) + 요청 시 실시간', fallback: '장소 상세·축제·키워드 검색은 요청할 때 불러옵니다', banned: /연관 관광지|areaBasedList1|24시간 캐시/ },
  { code: 'en', parking: '10 minutes', detail: 'Daily (04:00 KST) + live per request', fallback: 'place details, festivals and keyword search are fetched on request', banned: /related attractions|areaBasedList1|24-hour cache|KTO/ },
] as const) {
  test(`${locale.code} guide data table matches the live data paths`, async ({ page }) => {
    await page.addInitScript(code => localStorage.setItem('nextspot_locale', code), locale.code);
    await page.goto('/guide');
    const fold = page.locator('details[data-data-fold]');
    await fold.locator('summary').click();
    await expect(fold).toHaveAttribute('open', '');
    const table = fold.getByRole('table');
    await expect(table).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(11); // 헤더 1 + 출처 10(키워드 검색 행 추가)
    await expect(table.getByText('searchKeyword2')).toBeVisible();
    await expect(table.getByText(locale.parking, { exact: true })).toBeVisible();
    await expect(table.getByText(locale.detail, { exact: true })).toBeVisible();
    await expect(fold).toContainText(locale.fallback);
    await expect(fold).not.toContainText(locale.banned);
  });
}

test('guide console links: merchant sign-in goes straight to the login form, the Seoul card is gone', async ({ page }) => {
  await page.goto('/guide');
  await expect(page.getByRole('link', { name: '사장님 콘솔 로그인' })).toHaveAttribute('href', '/login?next=/merchant');
  await expect(page.getByRole('link', { name: '사장님 콘솔 데모 보기' })).toHaveAttribute('href', '/merchant?demo=1');
  await page.locator('details[data-plan-fold] summary').click();
  await expect(page.locator('details[data-plan-fold]')).toHaveAttribute('open', '');
  await expect(page.locator('body')).not.toContainText(/서울 실측|서울 실시간/);
});
