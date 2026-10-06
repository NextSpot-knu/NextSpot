import { expect, test, type Locator, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 기능 5(사장님 콘솔 · 관제 대시보드)의 입구 — 2026-10-06 감사 I14.
//
// 심사위원은 대개 데스크톱에서 관광객 화면부터 연다. 예전에는 왼쪽 레일에 콘솔 입구가 없었고, 로그인 없이
// /merchant 를 열면 '사업자 계정이 아니에요' 가 떠 콘솔이 없는 것처럼 읽혔다. 여기서 지키는 것:
//   · 레일의 두 입구가 노트북 창(1366×650 · 1536×730)에서 스크롤 없이 보이고 서비스 소개와 겹치지 않는다
//   · 폰(360×640)은 하단 바 위 안내 줄에 두 입구가 한 줄로 들어간다(4 로케일)
//   · 목적지는 역할로 갈린다 — 역할이 없으면 데모, 맞으면 실제 콘솔(lib/consoleLinks.ts)
//   · 게스트가 /merchant 를 열면 '사장님 계정으로 로그인' 카드에 로그인·데모가 나란히 있다
// 실계정·외부 네트워크는 쓰지 않는다(support/stubs.ts). 우리 API 는 전부 스텁이다.

type AccountStub = { role: string; is_anonymous: boolean } | 'unauthorized';

const ANON: AccountStub = { role: 'tourist', is_anonymous: true };

async function stubApis(page: Page, account: AccountStub = ANON): Promise<void> {
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/v1/**', (route) => {
    if (route.request().url().includes('/account/me')) {
      if (account === 'unauthorized') {
        return route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"unauthorized"}' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: '00000000-0000-4000-8000-000000000001',
          nickname: null,
          owned_facilities: [],
          pending_verification: false,
          ...account,
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

const tabNav = (page: Page) => page.locator('nav[aria-label="주요 내비게이션"]:visible');

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, 'element has no box').not.toBeNull();
  return b!;
}

test.beforeEach(async ({ page }) => stubExternalServices(page));

// ── 데스크톱 레일 ───────────────────────────────────────────────────────────

for (const viewport of [{ width: 1366, height: 650 }, { width: 1536, height: 730 }]) {
  test(`rail shows both console entries without scrolling at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    test.setTimeout(90_000);
    await stubApis(page);
    await page.setViewportSize(viewport);
    await page.goto('/saved');

    const rail = tabNav(page);
    const merchant = rail.getByRole('link', { name: '사장님 콘솔' });
    const admin = rail.getByRole('link', { name: '관제 대시보드' });
    const guide = rail.getByRole('button', { name: 'NextSpot 알아보기' });
    await expect(merchant).toBeVisible({ timeout: 30_000 });
    await expect(admin).toBeVisible();
    await expect(guide).toBeVisible();

    // 셋 다 창 안에 온전히 — 레일은 sticky h-screen 이라 넘치면 아래로 잘려 나간다.
    for (const entry of [merchant, admin, guide]) {
      const b = await box(entry);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.height, `${viewport.width}x${viewport.height}: 레일 항목이 창 아래로 밀렸다`).toBeLessThanOrEqual(viewport.height);
    }
    const merchantBox = await box(merchant);
    const adminBox = await box(admin);
    const guideBox = await box(guide);
    expect(merchantBox.y + merchantBox.height).toBeLessThanOrEqual(adminBox.y + 0.5);
    expect(adminBox.y + adminBox.height, '관제 대시보드가 서비스 소개와 겹친다').toBeLessThanOrEqual(guideBox.y + 0.5);
    // 마지막 탭(마이)과도 겹치지 않는다.
    const myTab = await box(rail.getByRole('button', { name: '마이' }));
    expect(myTab.y + myTab.height).toBeLessThanOrEqual(merchantBox.y);

    // 게스트 → 둘 다 데모.
    await expect(merchant).toHaveAttribute('href', '/merchant?demo=1');
    await expect(admin).toHaveAttribute('href', '/admin/dashboard?demo=1');
  });
}

test('rail entries follow the account role and open the console', async ({ page }) => {
  test.setTimeout(90_000);
  await stubApis(page, { role: 'merchant', is_anonymous: false });
  await page.setViewportSize({ width: 1536, height: 730 });
  await page.goto('/saved');

  const rail = tabNav(page);
  // 사장님은 자기 콘솔은 실제로, 관제는 데모로(두 콘솔은 분리 — lib/accountRoles.ts).
  await expect(rail.getByRole('link', { name: '사장님 콘솔' })).toHaveAttribute('href', '/merchant', { timeout: 30_000 });
  await expect(rail.getByRole('link', { name: '관제 대시보드' })).toHaveAttribute('href', '/admin/dashboard?demo=1');

  await rail.getByRole('link', { name: '관제 대시보드' }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard\?demo=1$/, { timeout: 30_000 });
});

// 레일 라벨은 낱말 사이에서만 두 줄로 접힌다. 일본어는 띄어쓰기가 없어 'オーナーコ / ンソール'·'運営ダッ / シュボード'
// 처럼 낱말 한가운데서 꺾였다(2026-10-06 리뷰) — 낱말마다 모든 글자가 한 줄에 있고, 글자가 레일 밖으로 나가지 않는지 본다.
const railLabels = [
  { code: 'ko', merchant: '사장님 콘솔', admin: '관제 대시보드' },
  { code: 'en', merchant: 'Merchant console', admin: 'Operations dashboard' },
  { code: 'ja', merchant: 'オーナーコンソール', admin: '運営ダッシュボード' },
  { code: 'zh', merchant: '商家控制台', admin: '运营仪表盘' },
] as const;

for (const locale of railLabels) {
  for (const viewport of [{ width: 1536, height: 730 }, { width: 1366, height: 650 }]) {
    test(`${locale.code} rail console labels break only between words at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      test.setTimeout(90_000);
      await stubApis(page);
      await page.setViewportSize(viewport);
      await page.addInitScript((code) => localStorage.setItem('nextspot_locale', code), locale.code);
      await page.goto('/saved');
      await expect(page.locator('html')).toHaveAttribute('lang', locale.code, { timeout: 30_000 });

      const rail = tabNav(page);
      const railBox = await box(rail);
      for (const id of ['merchant', 'admin'] as const) {
        const entry = rail.locator(`a[data-console-entry="${id}"]`);
        // 보이는 글자는 용어집 그대로(낱말 경계 표시인 폭 없는 공백은 빼고 비교한다).
        await expect.poll(() => entry.innerText().then((s) => s.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim())).toBe(locale[id]);
        const report = await entry.locator('span').evaluate((span) => {
          const node = span.firstChild;
          if (!node || node.nodeType !== Node.TEXT_NODE) return { textNode: false, words: [], left: 0, right: 0 };
          const text = node.textContent ?? '';
          // 낱말 = 공백·폭 없는 공백으로 나뉜 덩어리(원문 기준 — 줄 끝 공백은 폭이 0 이라 글자 상자로는 못 나눈다).
          // 낱말마다 모든 글자가 같은 줄에 있어야 한다.
          const words: { word: string; tops: number[] }[] = [];
          const lefts: number[] = [];
          const rights: number[] = [];
          let current: { word: string; tops: number[] } | null = null;
          for (let i = 0; i < text.length; i++) {
            if (/[\s\u200b]/.test(text[i])) { current = null; continue; }
            if (!current) { current = { word: '', tops: [] }; words.push(current); }
            current.word += text[i];
            const range = document.createRange();
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            const rect = range.getClientRects()[0];
            if (!rect || rect.width === 0) continue;
            current.tops.push(Math.round(rect.top));
            lefts.push(rect.left);
            rights.push(rect.right);
          }
          return {
            textNode: true,
            words: words.map((w) => ({ word: w.word, lines: new Set(w.tops).size })),
            left: Math.min(...lefts),
            right: Math.max(...rights),
          };
        });
        expect(report.textNode, `${locale.code} ${id}: 라벨이 글자 하나짜리 텍스트 노드가 아니다`).toBe(true);
        for (const w of report.words) {
          expect(w.lines, `${locale.code}: '${w.word}' 이 낱말 한가운데서 줄을 바꿨다`).toBe(1);
        }
        expect(report.left, `${locale.code} ${id}: 라벨 글자가 레일 왼쪽 밖으로 나갔다`).toBeGreaterThanOrEqual(railBox.x - 0.5);
        expect(report.right, `${locale.code} ${id}: 라벨 글자가 레일 오른쪽 밖으로 나갔다`).toBeLessThanOrEqual(railBox.x + railBox.width + 0.5);
      }
    });
  }
}

// ── 폰 안내 줄 ──────────────────────────────────────────────────────────────

const phoneLabels = [
  { code: 'ko', merchant: '사장님 콘솔', admin: '관제 대시보드' },
  { code: 'en', merchant: 'Merchant', admin: 'Dashboard' },
  { code: 'ja', merchant: 'オーナー', admin: '運営' },
  { code: 'zh', merchant: '商家', admin: '运营' },
] as const;

for (const locale of phoneLabels) {
  test(`${locale.code} phone nav row fits both console entries at 360x640`, async ({ page }) => {
    test.setTimeout(90_000);
    await stubApis(page);
    await page.setViewportSize({ width: 360, height: 640 });
    await page.addInitScript((code) => localStorage.setItem('nextspot_locale', code), locale.code);
    await page.goto('/saved');

    const nav = tabNav(page);
    const merchant = nav.getByRole('link', { name: locale.merchant, exact: true });
    const admin = nav.getByRole('link', { name: locale.admin, exact: true });
    await expect(merchant).toBeVisible({ timeout: 30_000 });
    await expect(admin).toBeVisible();

    const guideBox = await box(nav.locator('button[aria-haspopup="dialog"]'));
    const merchantBox = await box(merchant);
    const adminBox = await box(admin);
    // 한 줄, 창 안, 서로·서비스 소개와 겹치지 않는다.
    expect(guideBox.x + guideBox.width).toBeLessThanOrEqual(merchantBox.x + 0.5);
    expect(merchantBox.x + merchantBox.width).toBeLessThanOrEqual(adminBox.x + 0.5);
    expect(adminBox.x + adminBox.width).toBeLessThanOrEqual(360);
    expect(adminBox.y + adminBox.height).toBeLessThanOrEqual(640);
    expect(Math.abs(merchantBox.y - adminBox.y)).toBeLessThan(1);
    await expect(merchant).toHaveCSS('font-size', '12px');
    for (const entry of [merchant, admin]) {
      expect(await entry.evaluate((el) => el.getClientRects().length), '라벨이 두 줄로 갈라졌다').toBe(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    if (locale.code === 'ko') {
      await admin.click();
      await expect(page).toHaveURL(/\/admin\/dashboard\?demo=1$/, { timeout: 30_000 });
    }
  });
}

// ── 게스트가 연 /merchant ───────────────────────────────────────────────────

for (const account of [ANON, 'unauthorized'] as const) {
  const label = account === 'unauthorized' ? 'without a session' : 'as an anonymous guest';
  test(`/merchant ${label} offers store sign-in and the demo side by side`, async ({ page }) => {
    test.setTimeout(90_000);
    await stubApis(page, account);
    await page.goto('/merchant');

    await expect(page.getByText('사장님 계정으로 로그인', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('가게 성과·타임세일·좌석 상태를 바로 관리해요. 계정 없이 먼저 둘러봐도 좋아요.')).toBeVisible();
    await expect(page.getByText('사업자 계정이 아니에요')).toHaveCount(0);

    const login = page.getByRole('button', { name: '로그인', exact: true });
    const demo = page.getByRole('button', { name: '데모로 둘러보기' });
    await expect(login).toBeVisible();
    await expect(demo).toBeVisible();
    const loginBox = await box(login);
    const demoBox = await box(demo);
    expect(Math.abs(loginBox.y - demoBox.y), '로그인·데모가 나란히 있지 않다').toBeLessThan(1);
    expect(loginBox.x + loginBox.width).toBeLessThanOrEqual(demoBox.x);

    const hint = page.getByRole('region', { name: '공모전 심사용 계정' });
    await expect(hint).toContainText('openapi@naver.com');
    await expect(hint).not.toContainText('openapi@gmail.com');

    await login.click();
    await expect(page).toHaveURL(/\/login\?next=%2Fmerchant|\/login\?next=\/merchant/, { timeout: 30_000 });
    await expect(page.getByPlaceholder('이메일')).toHaveValue('openapi@naver.com');
  });
}
