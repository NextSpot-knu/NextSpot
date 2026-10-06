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
//   · 배너가 늦게 와도 '바로 시작'이 움직이지 않는다 · 축제가 서도 폰 첫 화면에 출처 줄이 남는다(390×844 4로케일)
//   · 이미 /main 위에서 연 소개 모달의 바로가기는 이동 대신 'nextspot:main-focus' 이벤트를 쏜다
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
  { events = [] as unknown[], account = ANON as AccountStub, eventsDelayMs = 0 } = {},
): Promise<Stubbed> {
  let eventsCalls = 0;
  await stubExternalServices(page);
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/events') {
      eventsCalls += 1;
      // 백엔드 캐시가 비었을 때처럼 축제 응답이 첫 그림보다 늦게 오는 경우.
      if (eventsDelayMs) return new Promise<void>((resolve) => {
        setTimeout(() => {
          void route
            .fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ source: 'tourapi', events }) })
            .catch(() => undefined)
            .finally(resolve);
        }, eventsDelayMs);
      });
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
/** 데이터 띠의 '데이터 출처 자세히' — 4로케일. */
const DATA_MORE = { ko: '데이터 출처 자세히', en: 'Data sources in detail', ja: 'データ出典の詳細', zh: '数据来源详情' } as const;
/** 폰 첫 화면의 출처 줄(landing.dataAttribution 앞부분) — 4로케일. */
const PHONE_CREDIT = {
  ko: '데이터 출처: ⓒ한국관광공사',
  en: 'Data: ⓒ Korea Tourism Organization',
  ja: 'データ出典: ⓒ韓国観光公社',
  zh: '数据来源: ⓒ韩国旅游发展局',
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
      const more = DATA_MORE[code as keyof typeof DATA_MORE];
      await expectInViewport(page, page.getByRole('button', { name: more, exact: true }), `${code} ${more}`);
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

for (const viewport of [{ width: 1536, height: 730 }, { width: 390, height: 844 }, { width: 360, height: 640 }]) {
  test(`festival banner sits under the start button and opens the panel at ${viewport.width}x${viewport.height}`, async ({ page }) => {
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
    // 가장 낮은 폰 창(360×640)에서도 '바로 시작'과 배너는 첫 화면 안이다.
    await expectInViewport(page, page.getByRole('button', { name: '바로 시작' }), '바로 시작');
    await expectInViewport(page, banner, '축제 배너');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

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

// ── 축제가 서도 폰 첫 화면에 출처 줄이 남는다 ─────────────────────────────────────────────
// 축제 배너와 콘솔 줄이 더해지자 맨 아래 출처 줄이 390×844 첫 화면 밖(ko y=867, en y=983)으로 밀렸다
// (2026-10-07 리뷰). 데이터 활용이 심사 항목이라 출처는 '바로 시작'·축제 배너 바로 아래에 둔다.

for (const code of ['ko', 'en', 'ja', 'zh'] as const) {
  test(`${code} phone landing keeps the data credit in the first viewport at 390x844 with a festival on`, async ({ page }) => {
    test.setTimeout(90_000);
    await stubLanding(page, { events: [ONGOING] });
    await seed(page, { nextspot_intro_seen: '1', nextspot_locale: code });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const banner = page.locator('button[aria-haspopup="dialog"].rounded-2xl').locator('visible=true');
    await expect(banner).toHaveCount(1, { timeout: 30_000 });
    await expectInViewport(page, banner, `${code} 축제 배너`);
    await expectInViewport(page, page.getByRole('button', { name: PHONE_CREDIT[code] }), `${code} 출처 줄`);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });
}

test('phone landing at 360x640 with a festival: start and banner in view, credit and console links one scroll away, no sideways scroll', async ({ page }) => {
  test.setTimeout(90_000);
  await stubLanding(page, { events: [ONGOING] });
  await seed(page, { nextspot_intro_seen: '1' });
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/');
  const banner = page.getByRole('button', { name: /진행 중인 경주 축제/ }).locator('visible=true');
  await expect(banner).toHaveCount(1, { timeout: 30_000 });
  await expectInViewport(page, page.getByRole('button', { name: '바로 시작' }), '바로 시작');
  await expectInViewport(page, banner, '축제 배너');
  // 출처 줄은 배너 바로 아래 — 한 번 내려 닿는다.
  const credit = page.getByRole('button', { name: PHONE_CREDIT.ko });
  await credit.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expectInViewport(page, credit, '출처 줄');
  const merchant = page.getByRole('link', { name: '사장님 콘솔', exact: true });
  const admin = page.getByRole('link', { name: '관제 대시보드', exact: true });
  await merchant.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expect(merchant).toBeVisible();
  await expect(admin).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  await admin.click();
  await expect(page).toHaveURL(/\/admin\/dashboard\?demo=1$/, { timeout: 30_000 });
});

// ── 축제 배너가 늦게 와도 '바로 시작'이 움직이지 않는다 ───────────────────────────────────
// 예전 데스크톱 히어로는 세로 가운데 맞춤이라, GET /events 가 첫 그림보다 늦게 오면 왼쪽 칸이 40px 남짓 위로 뛰고
// '바로 시작'이 있던 자리에 배너가 들어섰다 — 그 순간 누른 심사위원은 앱 대신 축제 패널을 연다(2026-10-07 리뷰).

for (const viewport of [{ width: 1536, height: 730 }, { width: 1366, height: 650 }]) {
  test(`a late festival banner does not move 바로 시작 at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    test.setTimeout(90_000);
    await stubLanding(page, { events: [ONGOING], eventsDelayMs: 2_500 });
    await seed(page, { nextspot_intro_seen: '1' });
    await page.setViewportSize(viewport);
    await page.goto('/');
    const start = page.getByRole('button', { name: '바로 시작' });
    await expect(start).toBeVisible({ timeout: 30_000 });
    const banner = page.getByRole('button', { name: /진행 중인 경주 축제/ }).locator('visible=true');
    await expect(banner).toHaveCount(0); // 아직 응답 전
    await page.waitForTimeout(400); // 첫 그림의 300ms 페이드가 끝난 뒤
    const before = await start.boundingBox();

    await expect(banner).toHaveCount(1, { timeout: 30_000 });
    await page.waitForTimeout(300);
    const after = await start.boundingBox();
    expect(Math.abs(after!.y - before!.y), "배너가 들어오며 '바로 시작'이 움직였다").toBeLessThanOrEqual(1);
    const bannerBox = await banner.boundingBox();
    expect(bannerBox!.y, "배너가 '바로 시작' 자리를 덮었다").toBeGreaterThanOrEqual(after!.y + after!.height);
    // 다섯 줄과 데이터 띠는 배너가 들어온 뒤에도 첫 화면 안.
    await expectInViewport(page, shortcut(page, 'console'), '5번 줄');
    await expectInViewport(page, page.getByRole('button', { name: '데이터 출처 자세히' }), '데이터 출처 자세히');
  });
}

// ── 이미 /main 위에서 연 소개 모달 — 바로가기는 이동 대신 이벤트 ──────────────────────────────
// 지도 화면 레일의 '서비스 소개'로 연 모달에서 1~4번을 누르면 /main → /main?focus=… 소프트 이동이라 지도 화면이
// 다시 마운트되지 않는다. 주소를 바꾸지 않고 모달을 닫은 뒤 'nextspot:main-focus' 를 쏘고, 지도 화면이 그 이벤트로
// ?focus 와 같은 갈래를 돈다(lib/featureShortcuts.ts — onMainFocus).

test('a shortcut clicked in the intro opened on /main closes it and fires nextspot:main-focus without navigating', async ({ page }) => {
  test.setTimeout(120_000);
  await stubExternalServices(page);
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await seed(page, { nextspot_intro_seen: '1' });
  await page.addInitScript(() => {
    const w = window as unknown as { __mainFocus: unknown[] };
    w.__mainFocus = [];
    window.addEventListener('nextspot:main-focus', (event) => w.__mainFocus.push((event as CustomEvent).detail));
  });
  await page.setViewportSize({ width: 1536, height: 730 });
  await page.goto('/main');
  const launcher = page.getByRole('button', { name: 'NextSpot 알아보기' }).locator('visible=true').first();
  await expect(launcher).toBeVisible({ timeout: 30_000 });
  // 다시 그려지지 않았는지(전체 새로고침이 아닌지) 보는 표식.
  await page.evaluate(() => { (window as unknown as { __sameDocument: boolean }).__sameDocument = true; });

  const dialog = page.getByRole('dialog', { name: 'NextSpot 알아보기' });
  // 레일 맨 아래의 '서비스 소개'는 개발 서버의 Next 표시 단추와 겹친다 — 키보드로 연다(service-guide.spec 과 같다).
  const openGuide = async () => {
    await launcher.focus();
    await page.keyboard.press('Enter');
  };
  for (const key of ['voice', 'forecast', 'live'] as const) {
    await openGuide();
    await expect(dialog).toBeVisible();
    await dialog.locator(`[data-shortcut="${key}"]`).click();
    await expect(dialog).not.toBeVisible();
  }
  await expect(page).toHaveURL(/\/main$/);
  expect(await page.evaluate(() => (window as unknown as { __mainFocus: unknown[] }).__mainFocus)).toEqual(['voice', 'forecast', 'live']);
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);

  // 콘솔 버튼(5번)은 그대로 이동한다.
  await openGuide();
  await dialog.locator('[data-shortcut="console"]').getByRole('link', { name: '관제 대시보드' }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard\?demo=1$/, { timeout: 30_000 });
});

// ── 랜딩 위에 연 소개 모달 — 같은 목록이 두 번 그려져도 제목 id 가 겹치지 않는다 ───────────────────

test('desktop: the intro opened over the landing labels its shortcut list with its own heading', async ({ page }) => {
  test.setTimeout(90_000);
  await stubLanding(page);
  await page.setViewportSize({ width: 1536, height: 730 });
  await page.goto('/');
  await expect(shortcut(page, 'forecast')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'NextSpot 알아보기' }).locator('visible=true').first().click();
  const dialog = page.getByRole('dialog', { name: 'NextSpot 알아보기' });
  await expect(dialog).toBeVisible();
  // 모달 안 목록의 aria-labelledby 가 모달 안의 제목을 가리키고, 그 id 는 문서에 하나뿐이다.
  const labelledInside = await dialog.locator('section[aria-labelledby]').evaluateAll((sections) =>
    sections.map((section) => {
      const id = section.getAttribute('aria-labelledby') ?? '';
      const target = document.getElementById(id);
      return Boolean(target && section.contains(target) && document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length === 1);
    }),
  );
  expect(labelledInside.length).toBeGreaterThan(0);
  expect(labelledInside.every(Boolean)).toBe(true);
  await expect(dialog.getByRole('region', { name: '이렇게 써 보세요' })).toBeVisible();
});

// ── 데이터 띠의 '데이터 출처 자세히' — 밝은 화면에서도 작은 글자 대비 4.5:1 이상 ─────────────────────

function contrastRatio(fg: string, bg: string): number {
  const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

test('light theme: the data band link reads at 4.5:1 or better', async ({ page }) => {
  test.setTimeout(90_000);
  await stubLanding(page);
  await seed(page, { nextspot_theme: 'light' });
  await page.setViewportSize({ width: 1536, height: 730 });
  await page.goto('/');
  const more = page.getByRole('button', { name: '데이터 출처 자세히' });
  await expect(more).toBeVisible({ timeout: 30_000 });
  const colors = await more.evaluate((el) => {
    // 계산된 색은 oklab()·color-mix() 로 올 수 있다 — 캔버스에 칠해 sRGB 로 읽는다(띠의 반투명은 무시: 불투명
    // hanji-deep 로 본다).
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    const toRgb = (color: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return `rgb(${r}, ${g}, ${b})`;
    };
    let node: HTMLElement | null = el.parentElement;
    let bg = 'rgba(0, 0, 0, 0)';
    while (node && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) {
      bg = getComputedStyle(node).backgroundColor;
      node = node.parentElement;
    }
    return { fg: toRgb(getComputedStyle(el).color), bg: toRgb(bg) };
  });
  expect(contrastRatio(colors.fg, colors.bg), `${colors.fg} on ${colors.bg}`).toBeGreaterThanOrEqual(4.5);
});

// ── en·ja·zh 배너 — 한국어 원문 축제 이름 줄 없이, 날짜는 그 언어로 ────────────────────────────

for (const scenario of [
  { code: 'en', label: 'On now in Gyeongju', date: 'until Oct 24' },
  { code: 'ja', label: '開催中の慶州の祭り', date: '10月24日まで' },
  { code: 'zh', label: '庆州节庆进行中', date: '至10月24日' },
] as const) {
  test(`${scenario.code} festival banner reads in ${scenario.code} only`, async ({ page }) => {
    test.setTimeout(90_000);
    await stubLanding(page, { events: [ONGOING] });
    await seed(page, { nextspot_intro_seen: '1', nextspot_locale: scenario.code });
    await page.setViewportSize({ width: 1536, height: 730 });
    await page.goto('/');
    const banner = page.locator('button[aria-haspopup="dialog"]').filter({ hasText: scenario.label }).locator('visible=true');
    await expect(banner).toHaveCount(1, { timeout: 30_000 });
    await expect(banner).toContainText(scenario.date);
    await expect(banner).not.toContainText(ONGOING.title);
    // 이름은 화면 읽기 프로그램용 이름(aria-label)에는 남는다.
    expect(await banner.getAttribute('aria-label')).toContain(ONGOING.title);
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
