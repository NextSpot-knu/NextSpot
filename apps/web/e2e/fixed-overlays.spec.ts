import { expect, test, type Locator, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 화면 전환 애니메이션이 transform 을 남기던 문제(2026-10-06 감사 I66)의 회귀 테스트.
//
// `.animate-page-enter` 가 끝난 뒤에도 translateY(0) 을 남기면 그 상자가 position:fixed 자식의 기준이자
// 쌓임 맥락이 된다. 그러면 폰 /main 의 '필터·편의' 시트가 하단 탭(z-40) 아래로 깔려 음식 종류 칩이
// 눌리지 않았고, /explore/recommend 의 음성 버튼은 화면이 아니라 긴 페이지 맨 아래에 붙었다.
// 여기서는 '눈에 보이는가' 가 아니라 **그 자리를 누르면 그 요소가 받는가**(elementFromPoint)를 본다.

test.beforeEach(async ({ page }) => stubExternalServices(page));

/** 요소 한가운데를 누르면 그 요소(또는 그 안쪽)가 받는가. 받으면 'ok', 다른 층이 덮고 있으면 그 층의 요약. */
async function pointerTarget(target: Locator): Promise<string> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit && (hit === el || el.contains(hit))) return 'ok';
    return hit ? `${hit.tagName.toLowerCase()}.${String(hit.className).slice(0, 80)} "${(hit.textContent ?? '').slice(0, 30)}"` : 'nothing';
  });
}

test('the phone filter sheet draws over the tab bar, so its food chips are reachable', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.addInitScript(() => localStorage.setItem('nextspot_onboarding_done', '1'));
  await page.goto('/main');

  // next dev 의 개발 표시(왼쪽 아래 nextjs-portal)는 배포본에 없다 — 히트 테스트를 가리지 않게 숨긴다.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.getByRole('button', { name: '필터·편의' }).click({ timeout: 60_000 });
  const sheet = page.locator('section').filter({ has: page.getByRole('heading', { name: '필터와 여행 편의' }) });
  await expect(sheet).toBeVisible();

  // 시트는 화면 바닥에 붙는다(페이지 상자가 아니라 뷰포트 기준).
  const viewport = page.viewportSize()!;
  const sheetBox = (await sheet.boundingBox())!;
  expect(Math.abs(sheetBox.y + sheetBox.height - viewport.height)).toBeLessThan(2);

  // 음식 종류 칩 — 예전에는 하단 탭·서비스 소개 줄 아래 깔려 눌리지 않았다.
  const firstFoodChip = sheet.getByRole('button', { name: /한식/ });
  await expect(firstFoodChip).toBeVisible();
  expect(await pointerTarget(firstFoodChip), '음식 종류 칩을 다른 층(하단 탭)이 덮고 있다').toBe('ok');
  // 시트 맨 아래 띠도 시트가 받는다.
  const bottomHit = await sheet.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + 24, r.bottom - 12);
    return !!hit && el.contains(hit);
  });
  expect(bottomHit, '시트 아래쪽이 하단 탭 밑에 깔렸다').toBe(true);

  // 칩이 실제로 눌린다.
  await firstFoodChip.click();
});

const alternatives = Array.from({ length: 5 }, (_, index) => ({
  recommendation_id: `rec-alt-${index}`,
  facility: {
    id: `alt-${index}`, name: `대안 카페 ${index + 1}`, type: 'cafe', latitude: 35.838 + index * 0.001, longitude: 129.209,
    capacity: 30, coupon_rate: 0, features: { indoor: true }, operating_hours: { open: '09:00~22:00', closed: '연중무휴' },
  },
  spot_score: 0.8 - index * 0.05, distance_m: 150 + index * 60, rank: index + 1, total_candidates: 5,
  breakdown: { preference: 0.8, wait_time: null, travel_time: 3 + index, incentive: 0 },
  reason: `대안 카페 ${index + 1} 추천 사유`, reason_source: 'template',
  congestion_level: null, congestion_source: 'none', open_status_at_arrival: 'open_expected',
  scoring_mode: 'area_stats_rules', prediction_source: 'unavailable',
}));

async function stubRecommend(page: Page): Promise<void> {
  await page.route('**/rest/v1/**', async (route) => {
    if (route.request().url().includes('/facilities')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: 'origin-cafe', name: '황리단길 카페', type: 'cafe', features: {}, congestion_logs: [],
      }) });
      return;
    }
    await route.fulfill({ status: 200, headers: { 'content-range': '0-0/1' }, body: '[]' });
  });
  await page.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/api/v1/recommendations') || url.endsWith('/api/v1/recommendations/by-type')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(alternatives) });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
  });
}

test('the recommend voice control stays in the viewport while the page scrolls', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('nextspot_onboarding_done', '1'));
  await stubRecommend(page);
  await page.goto('/explore/recommend?facilityId=origin-cafe&lat=35.838&lng=129.209');

  const voice = page.getByRole('button', { name: 'AI 음성 추천 듣기' });
  await expect(voice).toBeVisible({ timeout: 60_000 });
  const viewport = page.viewportSize()!;
  const inViewport = async () => {
    const b = (await voice.boundingBox())!;
    return b.y >= 0 && b.y + b.height <= viewport.height;
  };
  expect(await inViewport(), '음성 버튼이 화면이 아니라 페이지 상자 바닥에 붙었다').toBe(true);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(inViewport).toBe(true);
});
