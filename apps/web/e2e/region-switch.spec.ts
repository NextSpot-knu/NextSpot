import { expect, test, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 내부 검증 지역(S3) — 지역 스위처·배지는 내부 계정(developer)에게만 있고, 그 밖의 계정은 내부 지역 목록을 **묻지도 않는다**.
//
// 지키는 것:
//   · 게스트·관광객·관리자(외부 관제 역할 · 심사 공용 계정)는 스위처(data-testid=region-switcher)도 배지(region-badge)도 없고,
//     GET /api/v1/internal/regions 요청이 0건이다 — 기기에 내부 지역 선택이 남아 있어도 그렇다(남은 선택은 지운다).
//   · developer 는 서버가 허락한 지역이 있으면 스위처가 보이고, 고르면 '내부 검증 지역' 배지가 뜨며 요청에 지역 헤더가 실린다.
// 실계정·외부 네트워크는 쓰지 않는다(support/stubs.ts). 내부 지역 값은 가짜 고정물이다(실제 지역 좌표·이름이 아니다).

type Account = { role: string; is_anonymous: boolean };

const FAKE_REGION = {
  id: 'testbed',
  names: { ko: '시험 지역', en: 'Test region', ja: 'テスト地域', zh: '测试地区' },
  center: { lat: 36.5, lng: 127.5 },
  bounds: { min_lat: 36.4, max_lat: 36.6, min_lng: 127.4, max_lng: 127.6 },
  presets: [{ id: 'p1', name: '시험 구역', lat: 36.5, lng: 127.5 }],
  address_token: '시험',
  facility_count: 3,
  mapped_facility_count: 3,
  zone_count: 1,
  latest_observed_at: null,
};

interface Probe {
  regionCalls: () => number;
  regionHeaders: () => string[];
  /** 모든 /api/v1 요청(경로 + 지역 헤더 + 메서드 + 본문) — 순서대로. */
  requests: () => ProbedRequest[];
}

interface ProbedRequest {
  path: string;
  region: string | null;
  method: string;
  body: string | null;
}

async function stubApis(
  page: Page,
  account: Account,
  opts: { accountDelayMs?: number; areaDemandDelayMs?: number } = {},
): Promise<Probe> {
  let regionCalls = 0;
  const regionHeaders: string[] = [];
  const requests: ProbedRequest[] = [];
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = request.url();
    const header = request.headers()['x-nextspot-region'];
    if (header) regionHeaders.push(header);
    requests.push({ path: new URL(url).pathname, region: header ?? null, method: request.method(), body: request.postData() });
    if (url.includes('/api/v1/internal/regions')) {
      regionCalls += 1;
      // 서버 규칙(require_internal_region_viewer)을 흉내 낸다 — developer 만 200.
      if (account.role !== 'developer' || account.is_anonymous) {
        return route.fulfill({ status: 403, contentType: 'application/json', body: '{"detail":"forbidden"}' });
      }
      if (/\/internal\/regions\/[^/?]+\/zones/.test(url)) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ region: 'testbed', zones: [] }) });
      }
      if (/\/internal\/regions\/[^/?]+\/infrastructures/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ region: 'testbed', generated_at: new Date().toISOString(), items: [] }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ regions: [FAKE_REGION] }) });
    }
    if (opts.areaDemandDelayMs && url.includes('/area-demand/')) {
      // 차가운 서버처럼 권역 수요 응답이 늦다 — 곡선 수집이 지역 전환을 넘겨 이어지게.
      await new Promise((resolve) => setTimeout(resolve, opts.areaDemandDelayMs));
    }
    if (url.includes('/account/me')) {
      // 콜드 스타트처럼 계정 확인이 늦는 경우를 흉내 낸다.
      if (opts.accountDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.accountDelayMs));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', nickname: null, owned_facilities: [], pending_verification: false, ...account }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  return { regionCalls: () => regionCalls, regionHeaders: () => regionHeaders, requests: () => requests };
}

test.beforeEach(async ({ page }) => stubExternalServices(page));

const NON_INTERNAL: { label: string; account: Account }[] = [
  { label: 'guest', account: { role: 'tourist', is_anonymous: true } },
  { label: 'tourist', account: { role: 'tourist', is_anonymous: false } },
  // 관리자는 외부 관제 역할이자 심사 공용 계정이다 — 내부 지역을 보지 않는다(사용자 결정 1).
  { label: 'admin', account: { role: 'admin', is_anonymous: false } },
  // 사장님도 내부 계정이 아니다.
  { label: 'merchant', account: { role: 'merchant', is_anonymous: false } },
];

for (const { label, account } of NON_INTERNAL) {
  test(`${label}: no region switcher, no badge and zero /internal/regions requests`, async ({ page }) => {
    test.setTimeout(90_000);
    // 기기에 내부 지역 선택이 남아 있어도(계정 강등·공용 기기) 묻지 않고 경주로 그린다.
    await page.addInitScript(() => {
      try { localStorage.setItem('nextspot_region', 'testbed'); } catch { /* 저장소 차단 */ }
    });
    const probe = await stubApis(page, account);

    await page.goto('/mypage');
    await expect(page.locator('main, body').first()).toBeVisible({ timeout: 30_000 });
    // 계정 판정(/account/me)이 끝날 시간을 준다 — 판정 뒤에도 요청이 생기지 않아야 한다.
    await page.waitForTimeout(2_500);
    // 지도(/main)와 대기 보드(/waiting)도 본다 — /main 위쪽 줄에는 지역 스위처가 서 있고(목록 요청은 내부 계정만),
    // 두 화면 모두 구역 · 내부 장소 요청이 내부 지역에서만 나간다.
    for (const route of ['/saved', '/main', '/waiting']) {
      await page.goto(route);
      await page.waitForTimeout(2_500);
      await expect(page.getByTestId('region-switcher'), `${label} 의 ${route} 에 지역 스위처가 보인다`).toHaveCount(0);
      await expect(page.getByTestId('region-badge'), `${label} 의 ${route} 에 내부 지역 배지가 보인다`).toHaveCount(0);
    }

    await expect(page.getByTestId('region-switcher')).toHaveCount(0);
    await expect(page.getByTestId('region-badge')).toHaveCount(0);
    expect(probe.regionCalls(), `${label} 가 내부 지역 목록을 물었다`).toBe(0);
    expect(probe.regionHeaders(), `${label} 의 요청에 지역 헤더가 실렸다`).toEqual([]);
    // 남아 있던 내부 지역 선택은 계정이 내부 계정이 아니라고 확인되면 지운다.
    await expect.poll(() => page.evaluate(() => localStorage.getItem('nextspot_region')), { timeout: 10_000 }).toBeNull();
  });
}

test('developer: switcher appears, picking the internal region shows the badge and sends the region header', async ({ page }) => {
  test.setTimeout(90_000);
  const probe = await stubApis(page, { role: 'developer', is_anonymous: false });

  await page.goto('/mypage');
  const switcher = page.getByTestId('region-switcher').first();
  await expect(switcher).toBeVisible({ timeout: 30_000 });
  expect(probe.regionCalls()).toBeGreaterThan(0);
  await expect(page.getByTestId('region-badge')).toHaveCount(0);
  expect(probe.regionHeaders(), '경주에서 지역 헤더가 실렸다').toEqual([]);

  await switcher.locator('select').selectOption('testbed');
  await expect(page.getByTestId('region-badge')).toContainText('시험 지역', { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('nextspot_region'))).toBe('testbed');

  // 내부 지역에서 여는 지도의 요청에는 지역 헤더가 실린다(장소는 내부 경로로 — 서버가 역할을 다시 확인한다).
  // /main 은 위쪽 줄의 지역 스위처가 내부 지역을 표시한다(떠 있는 배지는 그 스위처를 덮으므로 그리지 않는다).
  await page.goto('/main');
  await expect(page.getByTestId('region-switcher-internal').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('region-badge')).toHaveCount(0);
  await expect.poll(() => probe.regionHeaders().includes('testbed'), { timeout: 20_000 }).toBe(true);
});

type Box = { x: number; y: number; width: number; height: number };
function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const LOCALES = ['ko', 'en', 'ja', 'zh'] as const;

// 390px 휴대폰 · 내부 지역 · 4로케일 — /main 위쪽 줄(언어 · 지역 스위처)이 제 칸 안에 머물고, 시계 알약 밑으로 들어가지
// 않으며, 내부 지역 표시가 스위처를 덮지 않는다. (예전: en 에서 스위처가 220px 칸을 넘어 시계 알약 밑으로 22px 들어갔다.)
// 지역 이름은 실제보다 긴 가짜 이름('Test region' 등)이라 실제 이름보다 빡빡한 조건이다.
for (const locale of LOCALES) {
  test(`developer at 390px in the internal region (${locale}): the /main region switcher stays clear of the clock and badge`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript((value) => {
      try {
        localStorage.setItem('nextspot_region', 'testbed');
        localStorage.setItem('nextspot_locale', value);
      } catch { /* 저장소 차단 */ }
    }, locale);
    await stubApis(page, { role: 'developer', is_anonymous: false });
    await page.goto('/main');
    const switcher = page.getByTestId('region-switcher').first();
    await expect(switcher.getByTestId('region-switcher-internal')).toBeVisible({ timeout: 30_000 });
    const clock = page.locator('[aria-label$=" KST"]').first();
    await expect(clock).toBeVisible();
    const switcherBox = (await switcher.boundingBox())!;
    const clockBox = (await clock.boundingBox())!;
    expect(intersects(switcherBox, clockBox), `${locale}: 지역 스위처가 시계 알약 밑으로 들어간다`).toBe(false);
    expect(switcherBox.x + switcherBox.width, `${locale}: 지역 스위처가 시계보다 오른쪽까지 뻗는다`).toBeLessThanOrEqual(clockBox.x);
    // 언어 알약은 줄지 않는다(지역 이름만 잘린다).
    const language = page.locator('select').first();
    const languageBox = (await language.boundingBox())!;
    expect(intersects(languageBox, switcherBox), `${locale}: 언어 알약과 지역 스위처가 겹친다`).toBe(false);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${locale}: 가로로 넘친다`).toBeLessThanOrEqual(1);
    const badges = page.getByTestId('region-badge');
    for (let i = 0; i < (await badges.count()); i += 1) {
      const badge = badges.nth(i);
      if (!(await badge.isVisible())) continue;
      const box = (await badge.locator('span').first().boundingBox())!;
      expect(intersects(box, switcherBox), '내부 지역 배지가 지역 스위처를 덮는다').toBe(false);
    }
  });
}

// 390px 휴대폰 · 내부 지역 · 4로케일 — 떠 있는 내부 지역 배지가 머리의 로고(/saved · /mypage 가운데) · 언어 알약 · 제목 ·
// 버튼을 덮지 않는다. (예전: /saved · /mypage 에서 배지가 가운데 로고 위쪽 절반을 덮었다.)
const BADGE_ROUTES = ['/saved', '/mypage', '/mypage/settings', '/waiting', '/course'];
for (const locale of LOCALES) {
  test(`developer at 390px in the internal region (${locale}): the floating badge covers no header control or logo`, async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript((value) => {
      try {
        localStorage.setItem('nextspot_region', 'testbed');
        localStorage.setItem('nextspot_locale', value);
        localStorage.setItem('nextspot_onboarding_done', '1');
      } catch { /* 저장소 차단 */ }
    }, locale);
    await stubApis(page, { role: 'developer', is_anonymous: false });
    for (const route of BADGE_ROUTES) {
      await page.goto(route);
      const badge = page.getByTestId('region-badge');
      await expect(badge, `${locale} ${route}: 배지가 없다`).toBeVisible({ timeout: 30_000 });
      // 머리가 다 그려질 시간(로고 이미지 · 언어 알약).
      await page.waitForTimeout(800);
      const hits = await page.evaluate(() => {
        const pill = document.querySelector('[data-testid="region-badge"] > span');
        if (!pill) return ['(배지 알약 없음)'];
        const b = pill.getBoundingClientRect();
        const out: string[] = [];
        const candidates = document.querySelectorAll('header *, h1, h2, img, button, select, input, a, [role="button"]');
        for (const el of Array.from(candidates)) {
          if (el.closest('[data-testid="region-badge"]')) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const style = window.getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
          if (r.left < b.right && b.left < r.right && r.top < b.bottom && b.top < r.bottom) {
            if (!out.length) out.push(`badge ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`);
            const alt = el.getAttribute('alt');
            out.push(`${el.tagName.toLowerCase()}${alt ? `[alt=${alt}]` : ''} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
        }
        return out;
      });
      expect(hits, `${locale} ${route}: 배지가 덮는 요소`).toEqual([]);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${locale} ${route}: 가로로 넘친다`).toBeLessThanOrEqual(1);
    }
  });
}

// 내부 지역의 방문 확인 — 혼잡 제보가 꺼진 지역이라 '얼마나 붐비나요?' 단계를 건너뛰고, 답에 체감 혼잡을 싣지 않으며,
// 답은 수락한 지역(내부 지역)의 헤더로 간다. 같은 대기 방문은 경주 화면에서는 묻지 않는다.
const SEEDED_REC = '77777777-7777-4777-8777-777777777777';
function seedInternalVisit(page: Page, storedRegion: string | null, status: 'arrived' | 'navigating' = 'arrived') {
  return page.addInitScript(({ rec, region, tripStatus }) => {
    try {
      if (region) localStorage.setItem('nextspot_region', region);
      localStorage.setItem('nextspot_onboarding_done', '1');
      // 도착한 여정은 30분이 지난 방문 확인으로, 이동 중 여정은 방금 수락한 것으로(방문 확인은 아직 뜨지 않는다).
      const acceptedAt = tripStatus === 'arrived' ? Date.now() - 31 * 60_000 : Date.now() - 60_000;
      const visit = { facilityId: 'fixture-place', name: '시험 장소', type: 'cafe', lat: 36.5, lng: 127.5, acceptedAt, region: 'testbed' };
      localStorage.setItem('nextspot_pending_visit', JSON.stringify(visit));
      localStorage.setItem(
        'nextspot_active_trip',
        JSON.stringify({ ...visit, version: 1, status: tripStatus, recommendationId: rec, navigationMode: 'walk' }),
      );
    } catch { /* 저장소 차단 */ }
  }, { rec: SEEDED_REC, region: storedRegion, tripStatus: status });
}

// 진행 중 여정 카드(ActiveJourneyCard)도 수락한 지역에서만 — 내부 지역 여정이 경주 지도에 뜨지 않고, 그 지역에서는 뜬다.
test('developer: an internal-region active trip card shows only in that region', async ({ page }) => {
  test.setTimeout(90_000);
  await seedInternalVisit(page, null, 'navigating');
  await stubApis(page, { role: 'developer', is_anonymous: false });
  await page.goto('/main');
  const switcher = page.getByTestId('region-switcher').first();
  await expect(switcher).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_000);
  await expect(page.getByTestId('active-journey'), '내부 지역 여정이 경주 지도에 떴다').toHaveCount(0);
  await switcher.locator('select').selectOption('testbed');
  await expect(page.getByTestId('region-switcher-internal').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('active-journey'), '내부 지역 여정이 그 지역에서 뜨지 않는다').toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('active-journey')).toContainText('시험 장소');
  // 이동 중이라 방문 확인은 아직 묻지 않는다.
  await expect(page.getByRole('button', { name: '네, 다녀왔어요' })).toHaveCount(0);
});

test('developer in the internal region: the visit check never asks the crowd question and answers with the region header', async ({ page }) => {
  test.setTimeout(90_000);
  await seedInternalVisit(page, 'testbed');
  const probe = await stubApis(page, { role: 'developer', is_anonymous: false });
  await page.goto('/main');
  await expect(page.getByTestId('region-switcher-internal').first()).toBeVisible({ timeout: 30_000 });
  const yes = page.getByRole('button', { name: '네, 다녀왔어요' });
  await expect(yes).toBeVisible({ timeout: 20_000 });
  await yes.click();
  // 혼잡 단계 없이 바로 평가로.
  const liked = page.getByRole('button', { name: '좋았어요' });
  await expect(liked).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('visit-congestion-note')).toHaveCount(0);
  await expect(page.getByText('지금 이곳 얼마나 붐비나요?')).toHaveCount(0);
  await liked.click();
  await expect(page.getByTestId('visit-completed')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('visit-congestion-note')).toHaveCount(0);
  // 쿠폰은 경주 가게만 준다 — 내부 지역 방문 뒤에는 쿠폰함으로 보내지 않는다.
  await expect(page.getByTestId('visit-completed').getByRole('link', { name: '내 쿠폰함' })).toHaveCount(0);
  const outcomeCalls = () =>
    probe.requests().filter((r) => r.method === 'PATCH' && r.path.endsWith(`/recommendations/${SEEDED_REC}/outcome`));
  await expect.poll(() => outcomeCalls().length, { timeout: 15_000 }).toBe(2);
  for (const outcome of outcomeCalls()) {
    expect(outcome.region, '방문 결과가 수락한 지역의 헤더 없이 나갔다').toBe('testbed');
    expect(outcome.body ?? '', '혼잡 제보가 꺼진 지역에서 체감 혼잡을 보냈다').not.toContain('observed_congestion');
  }
});

test('developer viewing Gyeongju: an internal-region visit check stays hidden', async ({ page }) => {
  test.setTimeout(90_000);
  await seedInternalVisit(page, null);
  const probe = await stubApis(page, { role: 'developer', is_anonymous: false });
  await page.goto('/main');
  await expect(page.getByTestId('region-switcher').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(3_000);
  await expect(page.getByRole('button', { name: '네, 다녀왔어요' })).toHaveCount(0);
  expect(probe.requests().filter((r) => r.path.includes('/outcome')), '경주 화면에서 내부 지역 방문 결과를 보냈다').toEqual([]);
});

// 390px 휴대폰 — 지역 스위처가 생겨도 왼쪽 위 묶음(언어 · 지역 · 출처)이 검색창을 덮지 않는다.
test('developer at 390px: region switcher and source credit stay above the /main search bar', async ({ page }) => {
  test.setTimeout(90_000);
  await stubApis(page, { role: 'developer', is_anonymous: false });
  await page.goto('/main');
  const switcher = page.getByTestId('region-switcher').first();
  await expect(switcher).toBeVisible({ timeout: 30_000 });
  const search = page.locator('input[enterkeyhint="search"]').first();
  await expect(search).toBeVisible();
  const searchBox = (await search.boundingBox())!;
  const switcherBox = (await switcher.boundingBox())!;
  expect(switcherBox.y + switcherBox.height, '지역 스위처가 검색창을 덮는다').toBeLessThanOrEqual(searchBox.y);
  const credit = page.getByText(/TourAPI/).first();
  if (await credit.isVisible()) {
    const creditBox = (await credit.boundingBox())!;
    expect(creditBox.y + creditBox.height, '출처 알약이 검색창을 덮는다').toBeLessThanOrEqual(searchBox.y);
  }
});

// 내부 지역을 골라 둔 개발자가 새로 고칠 때 — 계정 확인 전 경주 화면에서 시작된 권역 수요 곡선 수집(경주 전용 위젯)이
// 지역이 바뀐 뒤에도 이어져 **경주 좌표 요청이 내부 지역 헤더를 달고** 나가지 않는다.
test('developer hard load on /waiting never sends Gyeongju area-demand requests with the internal region header', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    try { localStorage.setItem('nextspot_region', 'testbed'); } catch { /* 저장소 차단 */ }
  });
  const probe = await stubApis(page, { role: 'developer', is_anonymous: false }, { accountDelayMs: 1_500, areaDemandDelayMs: 700 });
  await page.goto('/waiting');
  await expect(page.getByTestId('region-badge')).toContainText('시험 지역', { timeout: 30_000 });
  // 경주 단계에서 시작된 곡선 수집(선행 1점 + 나머지)이 끝날 시간을 준다.
  await page.waitForTimeout(6_000);
  const leaked = probe.requests().filter((r) => r.region === 'testbed' && r.path.includes('/area-demand/'));
  expect(leaked.map((r) => r.path), '경주 권역 수요 요청이 내부 지역 헤더를 달고 나갔다').toEqual([]);
});
