import { expect, test, type Page, type Route } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 익명 로그인이 거절될 때(Supabase IP 한도 429 — 2026-10-06 감사 I22).
// 예전: 거절 뒤에도 호출마다 곧바로 다시 가입을 보냈고(/waiting 한 번에 14~17건), 한도가 풀려도 대기 보드·코스는
// 새로고침 전까지 실패 화면에 머물렀다. 지금: 창(5초 → 15초 → …)마다 한 번만 묻고, 성공하면 화면이 스스로 채워진다.
// 실제 시간으로 돈다(가입 창 5초·15초) — 그래서 테스트마다 넉넉한 시간을 준다.

const SESSION_USER = '00000000-0000-4000-8000-000000000002';

function anonymousSession() {
  return {
    access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDIiLCJhdWQiOiJhdXRoZW50aWNhdGVkIn0.e2e',
    token_type: 'bearer',
    expires_in: 86_400,
    expires_at: Math.floor(Date.now() / 1000) + 86_400,
    refresh_token: 'e2e-refresh-limit',
    user: {
      id: SESSION_USER, aud: 'authenticated', role: 'authenticated', is_anonymous: true,
      app_metadata: { provider: 'anonymous', providers: ['anonymous'] }, user_metadata: {}, created_at: new Date(0).toISOString(),
    },
  };
}

/** 가입(익명 로그인)을 refuse(n번째 호출, 경과 ms) 가 참인 동안 429 로 거절한다. 공용 스텁 뒤에 걸어 그것을 덮는다. */
async function limitSignup(page: Page, refuse: (call: number, elapsedMs: number) => boolean): Promise<{ calls: () => number }> {
  let calls = 0;
  const started = Date.now();
  await page.route('**/auth/v1/signup**', (route: Route) => {
    calls += 1;
    if (refuse(calls, Date.now() - started)) {
      return route.fulfill({
        status: 429, contentType: 'application/json',
        body: JSON.stringify({ code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(anonymousSession()) });
  });
  return { calls: () => calls };
}

function boardItem(name: string) {
  return {
    recommendation_id: `rec-${name}`,
    facility: {
      id: `f-${name}`, name, type: 'restaurant', latitude: 35.8363, longitude: 129.2107, capacity: 30,
      congestion: null, image_url: null, gallery_images: null, features: {}, operating_hours: { open: '00:00~23:59' },
    },
    spot_score: 0.8, breakdown: { preference: 0.8, wait_time: null, travel_time: 2, incentive: 0 },
    distance_m: 120, reason: '테스트', reason_source: 'template', congestion_level: null, congestion_source: 'none',
    rank: 1, total_candidates: 1, open_status_at_arrival: 'open_expected', scoring_mode: 'degraded_rules',
  };
}

async function routeBoard(page: Page) {
  await page.route('**/api/v1/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/api/v1/recommendations/by-type')) {
      const type = String((route.request().postDataJSON() as { facility_type?: string }).facility_type ?? '');
      const body = type === 'restaurant' ? [boardItem('회복된 식당')] : [];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

async function openFresh(page: Page, locale: 'ko' | 'en') {
  await page.addInitScript((l) => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    localStorage.setItem('nextspot_locale', l);
    localStorage.setItem('nextspot_assumed_at', 'now');
    localStorage.removeItem('nextspot_waiting_board_v2');
    localStorage.removeItem('nextspot_course_plan_v1');
  }, locale);
}

const ERROR_TEXT = { ko: '잠시 후 다시 불러올게요.', en: "We'll load this again shortly." } as const;

for (const locale of ['ko', 'en'] as const) {
  test(`/waiting (${locale}): two refused sign-ins, then the board fills by itself`, async ({ page }) => {
    test.setTimeout(90_000);
    await stubExternalServices(page);
    const signup = await limitSignup(page, (call) => call <= 2);
    await openFresh(page, locale);
    await routeBoard(page);
    await page.goto('/waiting');

    await expect(page.getByText('회복된 식당').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(ERROR_TEXT[locale])).toHaveCount(0);
    // 거절 두 번 + 성공 한 번 — 예전에는 보드 요청마다 가입을 다시 보내 14건이 넘었다.
    expect(signup.calls()).toBeLessThanOrEqual(3);
  });
}

test('/waiting: refused until 12 s — the error card shows, then the board heals without a click', async ({ page }) => {
  test.setTimeout(90_000);
  await stubExternalServices(page);
  const signup = await limitSignup(page, (_call, elapsed) => elapsed < 12_000);
  await openFresh(page, 'ko');
  await routeBoard(page);
  await page.goto('/waiting');

  await expect(page.getByText(ERROR_TEXT.ko)).toBeVisible({ timeout: 40_000 });
  await expect(page.getByText('회복된 식당').first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(ERROR_TEXT.ko)).toHaveCount(0);
  expect(signup.calls()).toBeLessThanOrEqual(4);
});

test('/course: the map card shows while sign-in is refused, then the course replaces it', async ({ page }) => {
  test.setTimeout(90_000);
  await stubExternalServices(page);
  await limitSignup(page, (_call, elapsed) => elapsed < 12_000);
  await openFresh(page, 'ko');
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/v1/courses/plan', (route) => {
    if (!route.request().headers()['authorization']) {
      return route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"Not authenticated"}' });
    }
    const stop = (order: number, name: string, type: string) => ({
      order, facility: { id: `c-${order}`, name, type, latitude: 35.836 + order / 1000, longitude: 129.21, capacity: 30 },
      arrival_offset_min: 10 * order, predicted_congestion: null, spot_score: 0.8, reason: '테스트', travel_minutes: 10 * order,
    });
    const stops = [stop(1, '회복된 찻집', 'cafe'), stop(2, '회복된 유적', 'attraction')];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      plan_id: 'c-1+c-2', stops,
      slot_outcomes: stops.map((s) => ({ order: s.order, requested_type: null, status: 'filled', facility_id: s.facility.id, pinned: false })),
    }) });
  });
  await page.goto('/course');

  // 가입이 거절된 동안 — '로그인이 필요해요' 대신 지도로 가는 안내.
  await expect(page.getByText('덜 붐비는 코스는 지도에서 시작해요')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByText('로그인이 필요해요')).toHaveCount(0);
  // 한도가 풀리면 코스가 스스로 들어온다.
  await expect(page.getByRole('heading', { level: 3, name: /회복된 찻집/ })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText('덜 붐비는 코스는 지도에서 시작해요')).toHaveCount(0);
});
