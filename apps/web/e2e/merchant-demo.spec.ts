import { expect, test, type Page, type Route } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 사장님 콘솔 — 심사위원이 보는 첫 화면 계약(2026-10-06 A9).
//
//   1. ① 예상 혼잡은 **항상** 보인다. 모델이 미학습이면 같은 업종의 요일·시간대 '예측' 곡선이고,
//      실패할 /predict/batch 는 한 번도 부르지 않는다(model-info 로 먼저 묻는다).
//   2. 곡선 맨 위 눈금은 '100%' 로 읽힌다(예전에는 축 폭이 좁아 '00%' 로 잘렸다).
//   3. 가장 한가한 시간 콜아웃 → '타임세일 열기' 가 ③ 으로 데려간다.
//   4. 개발자 사과·면책 문구가 없다. 데모 표시는 톱바의 '예시 화면' 칩 하나뿐이다.
//   5. 기본 쿠폰율 조건 문장은 고른 할인율이 그 쿠폰율에 묻힐 때만 보인다.
//
// 이 파일은 우리 API·Supabase 로 나가는 요청을 전부 가로챈다 — 실 DB 에는 어떤 쓰기도 닿지 않는다.

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** 이 페이지가 실제로 낸 백엔드 요청 경로를 기록한다(라우트 처리와 무관하게 전부 잡힌다). */
function recordBackendCalls(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/v1/') || url.includes('/predict/')) seen.push(new URL(url).pathname);
  });
  return seen;
}

/**
 * 네트워크 봉쇄. 카탈-올을 **먼저** 등록한다 — Playwright 는 나중에 등록한 라우트가 이기므로,
 * 뒤에 붙는 구체 라우트가 카탈-올을 덮는다.
 */
async function stubConsoleNetwork(page: Page, account: 'guest' | 'merchant'): Promise<void> {
  await stubExternalServices(page);
  await page.route('**/rest/v1/**', (route) => json(route, 200, []));
  await page.route('**/api/v1/**', (route) => json(route, 200, {}));
  await page.route('**/predict/**', (route) => json(route, 503, { detail: '검증된 혼잡 예측 모델이 없습니다.' }));
  await page.route('**/predict/model-info', (route) =>
    json(route, 200, { trained: false, fallback_state: 'degraded_rules', refresh_error: 'no_active_model' }),
  );
  await page.route('**/api/v1/account/me', (route) =>
    account === 'guest'
      ? json(route, 401, { detail: 'unauthorized' })
      : json(route, 200, {
          id: 'merchant-e2e',
          role: 'merchant',
          is_anonymous: false,
          nickname: null,
          owned_facilities: [{ id: 'f-e2e', name: '경주 테스트 식당', type: 'restaurant' }],
          pending_verification: false,
        }),
  );
}

const DEMO_CHIP = '예시 화면';

for (const viewport of [
  { width: 1536, height: 730 },
  { width: 390, height: 844 },
]) {
  test.describe(`merchant demo console at ${viewport.width}px`, () => {
    test.use({ viewport });

    test('shows ① with the 예측 curve, a readable 100% tick and the quiet-hour callout; one demo chip', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const calls = recordBackendCalls(page);
      await stubConsoleNetwork(page, 'guest');
      await page.goto('/merchant?demo=1');

      // 데모 표시는 톱바 칩 하나 — 떠다니는 배지·'(데모)' 꼬리표 없음.
      const chip = page.getByText(DEMO_CHIP, { exact: true });
      await expect(chip).toBeVisible({ timeout: 20_000 });
      await expect(chip).toHaveCount(1);
      await expect(page.getByText('데모 데이터로 보는 중')).toHaveCount(0);
      await expect(page.getByText(/\(데모/)).toHaveCount(0);
      await expect(page.getByText('황리단길 한옥카페', { exact: true })).toBeVisible();

      // ① 예상 혼잡 + '예측' 칩 + 콜아웃.
      const forecast = page.locator('section', { hasText: '① 예상 혼잡' });
      await expect(forecast).toBeVisible();
      await expect(forecast.getByText('예측', { exact: true })).toBeVisible();
      await expect(forecast.getByText('19시가 가장 한가할 것 같아요')).toBeVisible();

      // Y축 맨 위 눈금이 SVG 안에 온전히 들어온다(잘리면 '00%' 로 읽힌다). recharts 3 는 눈금 글자를
      // 축 그룹 밖 레이어에 그리므로 축 클래스가 아니라 눈금 글자 클래스로 찾는다.
      const svg = forecast.locator('svg.recharts-surface').first();
      const topTick = forecast.locator('text.recharts-cartesian-axis-tick-value', { hasText: /^100%$/ });
      await expect(topTick).toBeVisible();
      const [svgBox, tickBox] = [await svg.boundingBox(), await topTick.boundingBox()];
      expect(svgBox && tickBox).toBeTruthy();
      expect(tickBox!.x).toBeGreaterThanOrEqual(svgBox!.x);

      // 개발자용 문구 없음.
      await expect(page.getByText(/서버가 계산한 예측값|예측 학습에도/)).toHaveCount(0);

      // 콜아웃 → ③ 셀프 타임세일로 스크롤.
      await forecast.getByRole('button', { name: '타임세일 열기' }).click();
      await expect(page.getByRole('heading', { name: '지금 할인, 지금 발행' })).toBeInViewport();

      // 스크롤해도 칩은 sticky 톱바와 함께 남는다(톱바 위에 떠 있는 것은 없다).
      await page.mouse.wheel(0, 600);
      await expect(chip).toBeInViewport();
      const header = await page.locator('header', { hasText: '황리단길 한옥카페' }).boundingBox();
      expect(header?.y ?? -1).toBe(0);

      // 데모는 콘솔 백엔드를 부르지 않는다(조회도, 예측도). 계정 조회(/account/me)는 앱 셸 몫이라 제외.
      expect(calls.filter((p) => p.startsWith('/api/v1/merchant/') || p.startsWith('/predict/'))).toEqual([]);
    });
  });
}

test('real merchant console draws ① from the weekday/hour pattern without any /predict/batch call', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const calls = recordBackendCalls(page);
  await stubConsoleNetwork(page, 'merchant');
  await page.route('**/api/v1/merchant/briefing**', (route) =>
    json(route, 200, { briefing: '오늘 오후에는 손님이 조금 줄어들 것 같아요.', llm_status: 'llm' }),
  );
  await page.route('**/api/v1/merchant/stats**', (route) =>
    json(route, 200, {
      facility_id: 'f-e2e',
      since: '',
      window_days: 7,
      coupons_issued: 3,
      coupons_used: 1,
      congestion_reports: 1,
      recommendations_exposed: 120,
      recommendations_accepted: 4,
      visit_confirmations: null,
      visit_confirmations_note: '방문확인은 현재 관광객 단말 로컬 기록(localStorage)이라 2단계 예정입니다.',
    }),
  );
  await page.route('**/api/v1/merchant/timesale**', (route) => json(route, 200, []));
  // 기본 쿠폰율 20% 가게 — 15%·20% 는 묻히고 30% 만 더해진다.
  await page.route('**/rest/v1/facilities**', (route) => json(route, 200, [{ coupon_rate: 0.2, features: null }]));
  await page.addInitScript(() => {
    localStorage.setItem(
      'nextspot_merchant_facility',
      JSON.stringify({ id: 'f-e2e', name: '경주 테스트 식당', type: 'restaurant', couponRate: 0 }),
    );
  });

  await page.goto('/merchant/dashboard');

  const forecast = page.locator('section', { hasText: '① 예상 혼잡' });
  await expect(forecast).toBeVisible({ timeout: 20_000 });
  await expect(forecast.getByText('예측', { exact: true })).toBeVisible();
  await expect(
    forecast.getByText('같은 업종 가게들의 요일·시간대 흐름으로 본 앞으로 6시간 예상이에요.'),
  ).toBeVisible();
  await expect(forecast.locator('text.recharts-cartesian-axis-tick-value', { hasText: /^100%$/ })).toBeVisible();
  await expect(forecast.getByRole('button', { name: '다시 시도' })).toHaveCount(0);

  // 미학습이면 batch 를 한 번도 보내지 않는다(model-info 만 — dev StrictMode 는 효과를 두 번 돈다).
  expect(calls.filter((p) => p === '/predict/batch')).toEqual([]);
  expect(calls.filter((p) => p === '/predict/model-info').length).toBeGreaterThanOrEqual(1);
  expect(calls.filter((p) => p === '/predict/model-info').length).toBeLessThanOrEqual(2);

  // 브리핑은 보이되 면책 문구는 없다. 성적표 아래 개발자 안내(localStorage·2단계)도 없다.
  await expect(page.getByText('오늘 오후에는 손님이 조금 줄어들 것 같아요.')).toBeVisible();
  await expect(page.getByText(/서버가 계산한 예측값/)).toHaveCount(0);
  await expect(page.getByText(/localStorage|2단계 예정/)).toHaveCount(0);

  // ③ 머리말은 혜택만 말하고, 조건 문장은 고른 할인율이 쿠폰율에 묻힐 때만 나온다.
  await expect(page.getByText('발행하면 바로 손님 추천에서 우리 가게가 더 잘 보여요.', { exact: false })).toBeVisible();
  const rates = page.getByRole('group', { name: '할인율' });
  const hint = page.getByText(/기본 쿠폰이 20%라 20% 타임세일은 추천 순위에 더해지지 않아요/);
  await rates.getByRole('button', { name: '20%' }).click();
  await expect(hint).toBeVisible();
  await rates.getByRole('button', { name: '30%' }).click();
  await expect(page.getByText(/기본 쿠폰이/)).toHaveCount(0);

  // 30% + 1시간 → 확인 단계는 손님이 보게 될 배지를 미리 보여 준다(쓰기 전 단계 — 발행은 누르지 않는다).
  await page.getByRole('group', { name: '지속 시간' }).getByRole('button', { name: '1시간' }).click();
  await page.getByRole('button', { name: '타임세일 발행' }).click();
  await expect(page.getByText('⚡ 타임세일 30%')).toBeVisible();
  await expect(page.getByText(/할인율이 기본 쿠폰율보다 높으면/)).toHaveCount(0);
});
