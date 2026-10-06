import { expect, test, type Locator, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 첫 화면(랜딩) — 2026-10-06 감사 계획 B1(I35 · PE06 · PH07 · I80).
//
// 심사위원은 대개 노트북·PC 로 라이브 주소를 처음 연다. 예전 데스크톱 첫 화면은 1.7초 뒤 저절로 열리는 소개 모달과
// 그 뒤의 420px 폰 세로 줄이었고, 어디에도 '무엇을 눌러 볼지'(핵심 기능 1~5)가 없었다. 여기서 지키는 것:
//   · 1024px 이상: 두 칸 히어로가 곧 첫 화면 — 오른쪽 '이렇게 써 보세요' 다섯 줄이 스크롤 없이 보이고, 모달은 저절로 열리지 않는다
//   · 다섯 줄의 목적지(1~4번은 /main?focus 계약, 5번은 역할별 콘솔) · 빈 곳 클릭은 첫 화면에 머문다
//   · 데이터 띠(무엇으로 고르는지 + 출처 + 출처 표)
//   · 폰: 소개 모달은 첫 방문에 한 번만, 화면 탭으로 시작은 그대로, 콘솔 링크 한 줄
//   · 진행 중인 축제가 있을 때만 '지금 경주 축제' 배너, 없으면 자리째 숨김 · 요청은 화면당 한 번
//   · 다크 테마에서도 읽힌다
// 실계정·외부 네트워크는 쓰지 않는다(support/stubs.ts). 우리 API 는 전부 스텁이다.

type AccountStub = { role: string; is_anonymous: boolean } | 'unauthorized';

const ANON: AccountStub = { role: 'tourist', is_anonymous: true };

// TourAPI searchFestival2 → GET /api/v1/events 응답 모양(snake_case — api-client 가 camelCase 로 바꾼다).
const ONGOING = {
  content_id: 'ev-ongoing',
  title: 'EX펌킨나잇：화니&워니x십이지신',
  start_date: '2026-09-24',
  end_date: '2026-10-24',
  address: '경상북도 경주시 경감로 614',
  event_place: '경주엑스포대공원',
  latitude: 35.8336,
  longitude: 129.2869,
  tel: null,
  is_ongoing: true,
  image_url: null,
};
const UPCOMING = { ...ONGOING, content_id: 'ev-upcoming', title: '국화 축제', start_date: '2026-11-01', end_date: '2026-11-03', is_ongoing: false };

interface Stubbed {
  /** GET /api/v1/events 가 몇 번 나갔는가(분석용 /events/track 은 세지 않는다). */
  eventsCalls: () => number;
}

async function stubLanding(
  page: Page,
  { events = [] as unknown[], account = ANON as AccountStub } = {},
): Promise<Stubbed> {
  let eventsCalls = 0;
  await stubExternalServices(page);
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/events') {
      eventsCalls += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ source: 'tourapi', events }) });
    }
    if (path === '/api/v1/account/me') {
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
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  return { eventsCalls: () => eventsCalls };
}

async function seed(page: Page, values: Record<string, string>) {
  await page.addInitScript((entries) => {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, values);
}

const SHORTCUT_KEYS = ['forecast', 'card', 'live', 'voice', 'console'] as const;
const KO_LABELS = ['혼잡 예측 지도', '대안 추천 카드', '실시간 관광정보', 'AI 음성 비서', '가게 타임세일 · 지역 관제'];

const shortcut = (page: Page, key: string): Locator => page.locator(`[data-shortcut="${key}"]:visible`);

async function expectInViewport(page: Page, locator: Locator, label: string) {
  await expect(locator, `${label} 이 보이지 않는다`).toBeVisible({ timeout: 30_000 });
  const box = await locator.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box, `${label}: 상자가 없다`).not.toBeNull();
  expect(box!.y, `${label}: 창 위로 넘친다`).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `${label}: 첫 화면(${viewport.width}×${viewport.height}) 아래로 밀렸다`).toBeLessThanOrEqual(viewport.height);
}

const horizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// ── 데스크톱: 다섯 줄이 첫 화면에, 모달은 저절로 열리지 않는다 ──────────────────────────────

for (const viewport of [{ width: 1536, height: 730 }, { width: 1366, height: 650 }, { width: 1920, height: 1080 }]) {
  test(`desktop landing shows the five shortcuts and the data band at ${viewport.width}x${viewport.height}, with no auto dialog`, async ({ page }) => {
    test.setTimeout(90_000);
    await stubLanding(page);
    await page.setViewportSize(viewport);
    await page.goto('/');

    for (const [index, key] of SHORTCUT_KEYS.entries()) {
      const row = shortcut(page, key);
      await expectInViewport(page, row, KO_LABELS[index]);
      await expect(row).toContainText(KO_LABELS[index]);
    }
    await expect(page.getByRole('heading', { level: 2, name: '이렇게 써 보세요' })).toBeVisible();
    // 데이터 띠 — 무엇으로 고르는지, 출처, 출처 표 버튼.
    await expect(page.getByText('경주 관광지·음식점 1,600여 곳, 공영주차 실시간, 날씨 예보로 골라 드려요')).toBeVisible();
    await expect(page.getByText('데이터 출처: ⓒ한국관광공사 · 경상북도 경주시 · 기상청').locator('visible=true')).toBeVisible();
    await expectInViewport(page, page.getByRole('button', { name: '데이터 출처 자세히' }), '데이터 출처 자세히');
    // 첫 방문인데도 4초 동안 소개 모달이 열리지 않는다(폰은 연다 — 아래).
    await page.waitForTimeout(4_000);
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });
}

const LOCALE_LABELS = {
  en: ['Crowd forecast map', 'Alternative pick', 'Live tourist info', 'AI voice assistant', 'Store time sales · Area operations'],
  ja: ['混雑予測マップ', '代わりのおすすめ', 'リアルタイム観光情報', 'AI音声アシスタント', 'お店のタイムセール · 地域の運営'],
  zh: ['拥挤预测地图', '替代推荐', '实时旅游信息', 'AI语音助手', '商家限时优惠 · 区域运营'],
} as const;

for (const [code, labels] of Object.entries(LOCALE_LABELS)) {
  test(`${code} desktop landing keeps all five shortcuts in the first viewport at 1366x650 and 1536x730`, async ({ page }) => {
    test.setTimeout(90_000);
    await stubLanding(page);
    await seed(page, { nextspot_locale: code });
    for (const viewport of [{ width: 1366, height: 650 }, { width: 1536, height: 730 }]) {
      await page.setViewportSize(viewport);
      await page.goto('/');
      for (const [index, key] of SHORTCUT_KEYS.entries()) {
        const row = shortcut(page, key);
        await expectInViewport(page, row, `${code} ${labels[index]}`);
        await expect(row).toContainText(labels[index]);
      }
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    }
  });
}

// ── 목적지: 1~4번은 /main?focus 계약, 5번은 역할별 콘솔 ─────────────────────────────────────

const MAIN_TARGETS = {
  forecast: '/main?focus=forecast',
  card: '/main',
  live: '/main?focus=live',
  voice: '/main?focus=voice',
} as const;

for (const scenario of [
  { name: 'guest', account: 'unauthorized' as AccountStub, merchant: '/merchant?demo=1', admin: '/admin/dashboard?demo=1' },
  { name: 'anonymous tourist', account: ANON, merchant: '/merchant?demo=1', admin: '/admin/dashboard?demo=1' },
  { name: 'merchant', account: { role: 'merchant', is_anonymous: false }, merchant: '/merchant', admin: '/admin/dashboard?demo=1' },
  { name: 'admin', account: { role: 'admin', is_anonymous: false }, merchant: '/merchant?demo=1', admin: '/admin/dashboard' },
]) {
  test(`shortcut targets for a ${scenario.name}`, async ({ page }) => {
    test.setTimeout(90_000);
    await stubLanding(page, { account: scenario.account });
    await page.setViewportSize({ width: 1536, height: 730 });
    await page.goto('/');

    for (const [key, href] of Object.entries(MAIN_TARGETS)) {
      await expect(shortcut(page, key)).toHaveAttribute('href', href, { timeout: 30_000 });
    }
    const consoles = shortcut(page, 'console');
    await expect(consoles.getByRole('link', { name: '사장님 콘솔' })).toHaveAttribute('href', scenario.merchant, { timeout: 30_000 });
    await expect(consoles.getByRole('link', { name: '관제 대시보드' })).toHaveAttribute('href', scenario.admin);

    // 폰의 콘솔 링크 한 줄도 같은 규칙.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('link', { name: '사장님 콘솔', exact: true })).toHaveAttribute('href', scenario.merchant);
    await expect(page.getByRole('link', { name: '관제 대시보드', exact: true })).toHaveAttribute('href', scenario.admin);
  });
}

test('the AI 음성 비서 shortcut opens the map with the voice focus', async ({ page }) => {
  test.setTimeout(90_000);
  await stubLanding(page);
  await page.setViewportSize({ width: 1536, height: 730 });
  await page.goto('/');
  await shortcut(page, 'voice').click();
  // 음성 비서 강조(링)는 /main 이 ?focus=voice 를 마운트 때 읽어 켠다(지도 화면 레인의 계약).
  await expect(page).toHaveURL(/\/main\?focus=voice$/, { timeout: 30_000 });
});

// ── 클릭: 데스크톱은 빈 곳을 눌러도 머문다, 폰은 화면 탭으로 시작 ─────────────────────────────

test('desktop: clicking empty space or the headline stays on the landing; 바로 시작 still starts', async ({ page }) => {
  test.setTimeout(90_000);
  await stubLanding(page);
  await page.setViewportSize({ width: 1536, height: 730 });
  await page.goto('/');
  await expect(shortcut(page, 'forecast')).toBeVisible({ timeout: 30_000 });

  await page.mouse.click(60, 400); // 왼쪽 여백
  await page.mouse.click(768, 715); // 아래 능선
  await page.getByRole('heading', { level: 1 }).click();
  await page.waitForTimeout(1_500);
  await expect(page).toHaveURL(/\/$/);

  await page.getByRole('button', { name: '바로 시작' }).click();
  await expect(page).toHaveURL(/\/setup$/, { timeout: 30_000 });
});

test('phone: tapping empty space still starts the app', async ({ page }) => {
  test.setTimeout(90_000);
  await stubLanding(page);
  await seed(page, { nextspot_intro_seen: '1' });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '바로 시작' })).toBeVisible({ timeout: 30_000 });
  await page.mouse.click(30, 300);
  await expect(page).toHaveURL(/\/setup$/, { timeout: 30_000 });
});

// ── 폰: 소개 모달은 첫 방문에 한 번만 — 모달 첫 칸에도 같은 다섯 줄 ───────────────────────────

test('phone: the intro dialog opens once on the first visit and carries the five shortcuts', async ({ page }) => {
  test.setTimeout(90_000);
  await stubLanding(page);
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'NextSpot 알아보기' });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByRole('heading', { level: 2, name: '이렇게 써 보세요' })).toBeVisible();
  await expect(dialog.locator('[data-shortcut]')).toHaveCount(5);
  await expect(dialog.locator('[data-shortcut="forecast"]')).toHaveAttribute('href', '/main?focus=forecast');
  await dialog.getByRole('button', { name: '소개 닫기' }).click();
  await expect(dialog).not.toBeVisible();

  // 콘솔 링크 한 줄과 키운 출처 줄.
  await expect(page.getByRole('link', { name: '사장님 콘솔', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '관제 대시보드', exact: true })).toBeVisible();
  const credit = page.getByRole('button', { name: /데이터 출처/ });
  await expect(credit).toBeVisible();
  expect(await credit.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(13);

  await page.reload();
  await expect(page.getByRole('button', { name: '바로 시작' })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(4_000);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});

// ── 데이터 띠의 '데이터 출처 자세히' → 소개의 '데이터' 절이 펼쳐진 채로 ────────────────────────

test('desktop: 데이터 출처 자세히 opens the guide with the data table expanded', async ({ page }) => {
  test.setTimeout(90_000);
  await stubLanding(page);
  await page.setViewportSize({ width: 1536, height: 730 });
  await page.goto('/');
  await page.getByRole('button', { name: '데이터 출처 자세히' }).click();
  const dialog = page.getByRole('dialog', { name: 'NextSpot 알아보기' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('details[data-data-fold]')).toHaveAttribute('open', '');
  await expect(dialog.locator('details[data-data-fold]').getByRole('table')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

// ── 축제 배너: 진행 중일 때만, 'CTA 아래', 누르면 패널(첫 화면에 머문다), 요청은 한 번 ─────────────

for (const viewport of [{ width: 1536, height: 730 }, { width: 390, height: 844 }]) {
  test(`festival banner sits under the start button and opens the panel at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(90_000);
    const stub = await stubLanding(page, { events: [ONGOING, UPCOMING] });
    await seed(page, { nextspot_intro_seen: '1' });
    await page.setViewportSize(viewport);
    await page.goto('/');

    const banner = page.getByRole('button', { name: /진행 중인 경주 축제/ }).locator('visible=true');
    await expect(banner).toHaveCount(1, { timeout: 30_000 });
    await expect(banner).toContainText('지금 경주 축제');
    await expect(banner).toContainText('10.24까지');
    await expect(banner).toContainText(ONGOING.title);
    await expect(banner).toContainText('출처: ⓒ한국관광공사');
    // 예정 축제는 배너에 세지 않는다('외 N건' 없음).
    await expect(banner).not.toContainText('외 ');

    const start = await page.getByRole('button', { name: '바로 시작' }).boundingBox();
    const bannerBox = await banner.boundingBox();
    expect(bannerBox!.y, '배너가 바로 시작 아래에 있지 않다').toBeGreaterThanOrEqual(start!.y + start!.height);

    await banner.click();
    const panel = page.getByRole('dialog', { name: '경주 축제·행사' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('국화 축제')).toBeVisible(); // 패널은 예정 축제까지 보여 준다
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    // 폰의 화면 탭(시작)으로 새지 않는다 — 첫 화면에 머문다.
    await page.waitForTimeout(1_000);
    await expect(page).toHaveURL(/\/$/);
    // 랜딩의 폰·데스크톱 두 배치가 모두 배너를 갖고 있어도 요청은 한 번.
    expect(stub.eventsCalls()).toBe(1);
  });
}

for (const scenario of [
  { name: 'no festival', events: [] as unknown[] },
  { name: 'only upcoming festivals', events: [UPCOMING] },
]) {
  test(`festival banner is hidden with ${scenario.name}`, async ({ page }) => {
    test.setTimeout(90_000);
    const stub = await stubLanding(page, { events: scenario.events });
    await seed(page, { nextspot_intro_seen: '1' });
    for (const viewport of [{ width: 1536, height: 730 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto('/');
      await expect(page.getByRole('button', { name: '바로 시작' })).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => stub.eventsCalls()).toBeGreaterThan(0);
      await page.waitForTimeout(800);
      await expect(page.getByRole('button', { name: /축제/ })).toHaveCount(0);
      await expect(page.getByText('지금 경주 축제')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('행사가 없어요');
    }
  });
}

// ── 다크 테마 ───────────────────────────────────────────────────────────────

function luminance(rgb: string): number {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

for (const viewport of [{ width: 1536, height: 730 }, { width: 390, height: 844 }]) {
  test(`dark theme landing stays readable at ${viewport.width}px`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: 'dark' });
    await stubLanding(page, { events: [ONGOING] });
    await seed(page, { nextspot_theme: 'dark', nextspot_intro_seen: '1' });
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/nextspot-dark/, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: /진행 중인 경주 축제/ }).locator('visible=true')).toBeVisible({ timeout: 30_000 });

    // 데스크톱은 기능 줄, 폰은 출처 줄 — 어두운 바탕 위 밝은 글자.
    const sample = viewport.width >= 1024 ? shortcut(page, 'forecast') : page.getByRole('button', { name: /데이터 출처/ });
    await expect(sample).toBeVisible();
    const colors = await sample.evaluate((el) => {
      let node: HTMLElement | null = el as HTMLElement;
      let bg = 'rgba(0, 0, 0, 0)';
      while (node && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) {
        bg = getComputedStyle(node).backgroundColor;
        node = node.parentElement;
      }
      if (/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) bg = getComputedStyle(document.body).backgroundColor;
      return { fg: getComputedStyle(el).color, bg };
    });
    expect(luminance(colors.fg), `글자 ${colors.fg}`).toBeGreaterThan(0.5);
    expect(luminance(colors.bg), `바탕 ${colors.bg}`).toBeLessThan(0.1);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`landing-dark-${viewport.width}.png`) });
  });
}
