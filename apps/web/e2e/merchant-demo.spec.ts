import { expect, test, type Page, type Route } from '@playwright/test';
import { stubExternalServices } from './support/stubs';
import { stubMain } from './support/mainStubs';

// 사장님 콘솔 — 심사위원이 보는 첫 화면 계약(2026-10-06 A9).
//
//   1. ① 예상 혼잡은 **항상** 보인다. 모델이 미학습이면 같은 업종의 요일·시간대 '예측' 곡선이고,
//      실패할 /predict/batch 는 한 번도 부르지 않는다(model-info 로 먼저 묻는다).
//   2. 곡선 맨 위 눈금은 '100%' 로 읽힌다(예전에는 축 폭이 좁아 '00%' 로 잘렸다).
//   3. 가장 한가한 시간 콜아웃 → '타임세일 열기' 가 ③ 으로 데려간다.
//   4. 개발자 사과·면책 문구가 없다. 데모 표시는 톱바의 '예시 화면' 칩 하나뿐이다.
//   5. 기본 쿠폰율 조건 문장은 고른 할인율이 그 쿠폰율에 묻힐 때만, 한 화면에 한 번 보인다.
//   6. 데모 ① 의 X축은 실제 시계를 따른다. 발행 확인 단계는 손님이 실제로 볼 배지(활성 세일 중 최댓값)를 말한다.
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
// 데모 ① 곡선은 지금 KST 시각부터 6시간이다 — 콜아웃 문장('19시가 …')을 단언하려면 시계를 고정한다.
const KST_13 = new Date('2026-10-06T13:00:00+09:00');

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
      await page.clock.setFixedTime(KST_13);
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

test('demo ① follows the real clock; the confirm step previews the live 20% badge when 15% is chosen', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await stubConsoleNetwork(page, 'guest');
  // 15:30 KST — 고정 13~19시 곡선이면 X축이 '지금 → 14시' 로 시계와 어긋났다.
  await page.clock.setFixedTime(new Date('2026-10-06T15:30:00+09:00'));
  await page.goto('/merchant?demo=1');

  const forecast = page.locator('section', { hasText: '① 예상 혼잡' });
  await expect(forecast).toBeVisible({ timeout: 20_000 });
  const tick = (label: RegExp) => forecast.locator('text.recharts-cartesian-axis-tick-value', { hasText: label });
  await expect(tick(/^지금$/)).toBeVisible();
  await expect(tick(/^16시$/)).toBeVisible();
  await expect(tick(/^21시$/)).toBeVisible();
  await expect(tick(/^14시$/)).toHaveCount(0);
  await expect(forecast.getByText('21시가 가장 한가할 것 같아요')).toBeVisible();

  // 데모 가게에는 20% 세일이 진행 중이다(기본 쿠폰 10%). 15% 를 골라도 손님 카드의 배지는 20% 그대로다.
  await expect(page.getByText('⚡ 20% 타임세일 진행 중')).toBeVisible();
  await page.getByRole('group', { name: '할인율' }).getByRole('button', { name: '15%' }).click();
  await page.getByRole('group', { name: '지속 시간' }).getByRole('button', { name: '1시간' }).click();
  await page.getByRole('button', { name: '타임세일 발행' }).click();
  // 진행 중 배너에도 같은 배지 미리보기가 있다(B4) — 확인 상자 안의 것을 본다.
  await expect(page.getByTestId('timesale-confirm').getByText('⚡ 타임세일 20%')).toBeVisible();
  await expect(page.getByText(/손님 추천 카드에는 지금 진행 중인/)).toBeVisible();
  await expect(page.getByText('⚡ 타임세일 15%')).toHaveCount(0);
});

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
  const suggestion = page.getByText(/더 높은 할인율을 골라 보세요/);
  await rates.getByRole('button', { name: '20%' }).click();
  await expect(hint).toBeVisible();
  await expect(suggestion).toBeVisible();

  // 20% 그대로 확인 단계를 열면 같은 사실은 확인 상자 안에 한 번만, '골라 보세요' 권유 없이 나온다
  // (발행 직전에 '다른 걸 고르라' 와 '이대로 발행할까요?' 를 한 번에 말하지 않는다). 발행은 누르지 않는다.
  const durations = page.getByRole('group', { name: '지속 시간' });
  await durations.getByRole('button', { name: '1시간' }).click();
  await page.getByRole('button', { name: '타임세일 발행' }).click();
  await expect(page.getByText(/이대로 발행할까요/)).toBeVisible();
  await expect(hint).toHaveCount(1);
  await expect(suggestion).toHaveCount(0);
  await page.getByRole('button', { name: '다시 고르기' }).click();

  await rates.getByRole('button', { name: '30%' }).click();
  await expect(page.getByText(/기본 쿠폰이/)).toHaveCount(0);

  // 30% + 1시간 → 확인 단계는 손님이 보게 될 배지를 미리 보여 준다(쓰기 전 단계 — 발행은 누르지 않는다).
  await page.getByRole('button', { name: '타임세일 발행' }).click();
  await expect(page.getByTestId('timesale-confirm').getByText('⚡ 타임세일 30%')).toBeVisible();
  await expect(page.getByText(/할인율이 기본 쿠폰율보다 높으면/)).toHaveCount(0);
});

// ───────────────────────────────────────────────────────────────────────────
// B4(2026-10-07) — 두 열 · 휴대폰 바로 가기 · 진행 중 배너 · 성적표 · 고른 칩 · 토스트 자리
// ───────────────────────────────────────────────────────────────────────────

const ZERO_STATS = {
  facility_id: 'f-e2e',
  since: '',
  window_days: 7,
  coupons_issued: 0,
  coupons_used: 0,
  congestion_reports: 0,
  recommendations_exposed: 0,
  recommendations_accepted: 0,
  visit_confirmations: null as number | null,
  visit_confirmations_note: '',
};

/** P1-2 응답의 지표 하나 — previous=null 은 '비교할 수 없음'(0 이 아니다). */
type Metric = { current: number | null; previous: number | null; people: number | null; counted_since: string | null };
const metric = (current: number | null, previous: number | null = null, people: number | null = null, countedSince: string | null = null): Metric => ({
  current,
  previous,
  people,
  counted_since: countedSince,
});

/** 성적표 응답 — 예전 칸 + P1-2 칸(기준 · 지표별 직전 기간 · 사람 수). 예전 칸만 주면 구 API 모양이다. */
type StatsBody = typeof ZERO_STATS & {
  exposure_basis?: 'card_shown' | 'list_rows';
  internal_accounts_excluded?: boolean;
  metrics?: Partial<Record<string, Metric>>;
};

/** 실계정 사장님 콘솔(심사 가게 모양) — 진행 중인 20% 타임세일 하나, 기본 쿠폰 5%.
 *  statsFor 를 주면 요청한 기간(?days=)마다 다른 성적표를 돌려준다. */
async function openRealConsole(
  page: Page,
  {
    stats = {},
    activeSale = true,
    statsFor,
  }: { stats?: Partial<StatsBody>; activeSale?: boolean; statsFor?: (days: number) => Partial<StatsBody> } = {},
): Promise<void> {
  await stubConsoleNetwork(page, 'merchant');
  await page.route('**/api/v1/merchant/briefing**', (route) => json(route, 200, { briefing: null, llm_status: 'skipped' }));
  await page.route('**/api/v1/merchant/stats**', (route) => {
    const days = Number(new URL(route.request().url()).searchParams.get('days') ?? 7);
    return json(route, 200, { ...ZERO_STATS, window_days: days, ...stats, ...(statsFor?.(days) ?? {}) });
  });
  const now = Date.now();
  await page.route('**/api/v1/merchant/timesale**', (route) =>
    json(
      route,
      200,
      activeSale
        ? [{
            id: 'ts-e2e', facility_id: 'f-e2e', rate: 0.2, canceled_at: null,
            starts_at: new Date(now - 20 * 60_000).toISOString(),
            ends_at: new Date(now + 84 * 60_000).toISOString(),
            created_at: new Date(now - 20 * 60_000).toISOString(),
          }]
        : [],
    ),
  );
  await page.route('**/rest/v1/facilities**', (route) => json(route, 200, [{ coupon_rate: 0.05, features: null }]));
  await page.addInitScript(() => {
    localStorage.setItem(
      'nextspot_merchant_facility',
      JSON.stringify({ id: 'f-e2e', name: '경주 테스트 식당', type: 'restaurant', couponRate: 0 }),
    );
  });
  await page.goto('/merchant/dashboard');
  await expect(page.locator('section', { hasText: '① 예상 혼잡' })).toBeVisible({ timeout: 20_000 });
}

for (const mode of ['demo', 'real'] as const) {
  test(`1536×730 (${mode}) — ③ 타임세일과 ④ 좌석 방송 머리가 첫 화면에 있고, 머리글은 로고와 '사장님 콘솔'`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1536, height: 730 });
    await page.clock.setFixedTime(KST_13);
    if (mode === 'demo') {
      await stubConsoleNetwork(page, 'guest');
      await page.goto('/merchant?demo=1');
    } else {
      await openRealConsole(page);
    }
    const timesale = page.getByRole('heading', { name: '지금 할인, 지금 발행' });
    const seat = page.getByRole('heading', { name: '지금 우리 가게 상태' });
    await expect(timesale).toBeVisible({ timeout: 20_000 });
    for (const heading of [timesale, seat]) {
      const box = await heading.boundingBox();
      expect(box, '섹션 머리 상자').not.toBeNull();
      console.log(`${mode} section heading bottom at 1536×730: ${Math.round(box!.y + box!.height)}px`);
      expect(box!.y + box!.height, '③④ 머리가 스크롤 없이 첫 화면에 있어야 한다').toBeLessThan(730);
    }
    // 두 행동 버튼도 스크롤 없이 첫 화면 안이다(③ 발행 · ④ 여유/보통/만석).
    await expect(page.getByRole('button', { name: '타임세일 발행', exact: true })).toBeInViewport({ ratio: 1 });
    const seatGroup = page.getByRole('group', { name: '좌석 상태 방송' });
    const seatBox = await seatGroup.boundingBox();
    console.log(`${mode} seat buttons top/bottom at 1536×730: ${Math.round(seatBox!.y)} / ${Math.round(seatBox!.y + seatBox!.height)}px`);
    await expect(seatGroup).toBeInViewport({ ratio: 1 });
    // 넓은 화면 머리글 — NextSpot 로고 + '사장님 콘솔'.
    const header = page.locator('header').first();
    await expect(header.getByRole('img', { name: 'NextSpot' })).toBeVisible();
    await expect(header.getByText('사장님 콘솔', { exact: true })).toBeVisible();
    // 휴대폰 하단 바는 넓은 화면에 없다.
    await expect(page.getByRole('navigation', { name: '사장님 바로 가기' })).toBeHidden();
  });
}

test('390×844 — 하단 바로 가기 바가 ③ 타임세일·④ 좌석 방송으로 데려간다', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await stubConsoleNetwork(page, 'guest');
  await page.clock.setFixedTime(KST_13);
  await page.goto('/merchant?demo=1');
  const bar = page.getByRole('navigation', { name: '사장님 바로 가기' });
  await expect(bar).toBeVisible({ timeout: 20_000 });
  const barBox = await bar.boundingBox();
  expect(barBox!.y + barBox!.height, '바로 가기 바가 화면 아래에 붙어 있다').toBeGreaterThan(830);
  // 첫 화면에서는 ③④ 가 아래쪽에 있다 — 바가 그 사실을 먼저 보여 준다.
  await expect(page.getByRole('heading', { name: '지금 우리 가게 상태' })).not.toBeInViewport();
  await bar.getByRole('button', { name: '🪑 좌석 상태 방송' }).click();
  await expect(page.getByRole('heading', { name: '지금 우리 가게 상태' })).toBeInViewport();
  await bar.getByRole('button', { name: '⚡ 타임세일 발행' }).click();
  await expect(page.getByRole('heading', { name: '지금 할인, 지금 발행' })).toBeInViewport();
  // 바가 마지막 카드를 가리지 않는다(본문 아래 여백).
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  await page.waitForTimeout(300);
  const lastCard = page.locator('section', { hasText: '④ 좌석 상태 방송' });
  const cardBox = await lastCard.boundingBox();
  const bar2 = await bar.boundingBox();
  expect(cardBox!.y + cardBox!.height, '마지막 카드가 바로 가기 바 아래에 깔린다').toBeLessThanOrEqual(bar2!.y + 1);
});

test('진행 중인 타임세일 — 추천 반영 중 · 손님 카드 배지 미리보기 · 손님 화면에서 보기(/main?place=)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openRealConsole(page, { stats: { recommendations_exposed: 3120, recommendations_accepted: 1 } });
  const banner = page.getByTestId('timesale-active');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('⚡ 20% 타임세일 진행 중');
  await expect(banner).toContainText(/남음/);
  await expect(banner.getByText('추천 반영 중')).toBeVisible();
  await expect(banner.getByText('⚡ 타임세일 20%')).toBeVisible();
  const link = banner.getByRole('link', { name: /손님 화면에서 보기/ });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/main?place=f-e2e');
  // 새 탭으로 연다 — 사장님은 콘솔을 그대로 둔 채 손님 카드를 확인한다(아이콘도 '새 창').
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
});

// 계획 B4 — '손님 화면에서 보기' 는 /main 에서 그 가게를 '선택한 장소' 카드로 연다(교차 레인 계약 2). 레인이 합쳐진 뒤로는
// 늘 돈다 — 예전의 소스 정규식 건너뛰기는 ?place 읽는 방식만 바꿔도 이 유일한 끝-끝 검사를 조용히 꺼 버렸다(리뷰 10-07).
test('손님 화면에서 보기 — /main?place= 가 그 가게를 선택한 장소 카드로 연다', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openRealConsole(page);
  const href = await page.getByTestId('timesale-active').getByRole('link', { name: /손님 화면에서 보기/ }).getAttribute('href');
  expect(href).toBe('/main?place=f-e2e');

  // 새 탭과 같은 조건 — 콘솔 탭의 스텁 없이, /main 만의 스텁으로 연다(외부 호출은 stubMain 이 막는다).
  const tab = await page.context().newPage();
  await tab.setViewportSize({ width: 1536, height: 730 });
  const store = {
    id: 'f-e2e', name: '경주 테스트 식당', type: 'restaurant', latitude: 35.8347, longitude: 129.219, capacity: 40,
    features: {}, congestion: null, operating_hours: { open: '10:00~21:00' }, coupon_rate: 0.2,
  };
  const other = { ...store, id: 'cand-1', name: '우직 쌈밥집', latitude: 35.8351 };
  await stubMain(tab, {
    facilities: [store, other],
    byType: () => [{
      recommendation_id: 'rec-1', facility: other, spot_score: 0.7, distance_m: 200, rank: 1, total_candidates: 1,
      reason: '우직 쌈밥집 고정 추천 사유', reason_source: 'template', congestion_level: null, congestion_source: 'none',
      congestion_is_current: null, congestion_timestamp: null, open_status_at_arrival: 'open_expected',
      scoring_mode: 'degraded_rules', prediction_source: 'unavailable',
      breakdown: { preference: 0.7, wait_time: null, travel_time: 4, incentive: 0 },
    }],
  });
  // 새 탭(noopener)은 세션 표시를 물려받지 못한다 — 예전에는 이 탭이 무거운 세션 프리페치(추천 4 + 코스 1)를 사장님 계정으로
  // 다시 보냈다(리뷰 10-07). 증명 탭은 데우지 않는다.
  const heavy: string[] = [];
  tab.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /\/api\/v1\/(courses\/plan|recommendations\/by-type)$/.test(path)) heavy.push(path);
  });
  await tab.goto(href!);
  const card = tab.getByTestId('recommendation-card');
  await expect(card).toBeVisible({ timeout: 25_000 });
  await expect(card).toContainText('경주 테스트 식당');
  await expect(card).toContainText('선택한 장소');
  await tab.waitForTimeout(8_000); // 프리페치는 마운트 4초 뒤 + 한가할 때(최대 3초)
  expect(heavy.filter((p) => p.endsWith('/courses/plan')), heavy.join(', ')).toEqual([]);
  // 칩 하나(음식점)의 추천만 — 대기 보드 4유형을 미리 묻지 않는다.
  expect(heavy.filter((p) => p.endsWith('/by-type')).length, heavy.join(', ')).toBeLessThanOrEqual(3);
});

test('데모 가게는 실제 지도에 없으니 손님 화면 링크를 두지 않는다(배지 미리보기는 있다)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await stubConsoleNetwork(page, 'guest');
  await page.goto('/merchant?demo=1');
  const banner = page.getByTestId('timesale-active');
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(banner.getByText('추천 반영 중')).toBeVisible();
  await expect(banner.getByRole('link', { name: /손님 화면에서 보기/ })).toHaveCount(0);
});

test('성적표 — 0 타일 없이 노출이 맨 앞, 쿠폰을 안 줬고 진행 중인 세일이 없으면 타임세일 안내(PM 4.18)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  // 서버가 화면 카드 기준(rec_shown)으로 셌다고 말한 응답 — 이름은 '손님 화면에 뜬 추천 카드'(P1-2).
  await openRealConsole(page, {
    stats: { recommendations_exposed: 3120, recommendations_accepted: 1, exposure_basis: 'card_shown' },
    activeSale: false,
  });
  const card = page.locator('section', { hasText: '② 성적표' });
  const exposedLabel = '손님 화면에 뜬 추천 카드';
  await expect(card.getByText(exposedLabel, { exact: true })).toBeVisible();
  await expect(card.getByText('3,120회', { exact: true })).toBeVisible();
  await expect(card.getByText('길안내 시작', { exact: true })).toBeVisible();
  await expect(card.getByText(/0 \/ 0/)).toHaveCount(0);
  await expect(card.getByText(/1 \/ 3120|추천 수락|추천 제안/)).toHaveCount(0);
  await expect(card.getByText('혼잡 제보', { exact: true })).toHaveCount(0);
  await expect(card.getByText(/^타임세일을 열어 보세요/)).toBeVisible();
  // 지난 세일 이력은 이 화면이 모른다 — '첫' 을 붙이지 않는다(리뷰 10-07).
  await expect(card.getByText(/첫 타임세일/)).toHaveCount(0);
  // 노출이 길안내보다 앞(맨 앞 타일).
  const exposed = await card.getByText(exposedLabel, { exact: true }).boundingBox();
  const guide = await card.getByText('길안내 시작', { exact: true }).boundingBox();
  expect(exposed!.y).toBeLessThan(guide!.y);
  // 맨 앞 타일 뒤에 하나뿐인 '길안내 시작' 은 반 칸 옆 빈칸을 남기지 않고 두 칸을 쓴다(리뷰 10-07).
  const tileOf = (label: string) => card.locator('div.rounded-2xl', { has: page.getByText(label, { exact: true }) }).last();
  const [heroBox, loneBox] = [await tileOf(exposedLabel).boundingBox(), await tileOf('길안내 시작').boundingBox()];
  expect(Math.abs(loneBox!.width - heroBox!.width), '외톨이 타일이 반 칸이다').toBeLessThanOrEqual(1);
});

// P1-2 — 서버가 기준을 말하지 않는 응답(구 API: 추천 목록 행 수)은 '노출' 이라고 부르지 않는다.
// /main 이 미리 받아 두는 4업종×8곳 목록까지 들어간 숫자라, 손님이 봤다는 뜻으로 읽히면 안 된다.
test('성적표 — 목록 행 기준 숫자는 이름을 바꾸고 손님이 봤는지 모른다고 말한다(P1-2)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openRealConsole(page, { stats: { recommendations_exposed: 3120, recommendations_accepted: 1 }, activeSale: false });
  const card = page.locator('section', { hasText: '② 성적표' });
  await expect(card.getByText('추천 목록에 포함된 횟수', { exact: true })).toBeVisible();
  await expect(card.getByText('3,120회', { exact: true })).toBeVisible();
  await expect(card.getByText(/손님이 실제로 봤는지는 이 숫자로 알 수 없어요/)).toBeVisible();
  await expect(card.getByText('손님 화면에 뜬 추천 카드', { exact: true })).toHaveCount(0);
  // 구 API 는 ?days= 를 무시하고 늘 7일을 준다 — 눌러도 7일 숫자가 나오는 30일 토글을 두지 않는다.
  await expect(card.getByRole('group', { name: '성적표 기간' })).toHaveCount(0);
});

test('성적표 — 사람 수 · 직전 기간 비교 · 30일 보기, 7일로 돌아오면 다시 묻지 않는다(P1-2)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const requested: number[] = [];
  await openRealConsole(page, {
    activeSale: false,
    statsFor: (days) => {
      requested.push(days);
      return days === 30
        ? {
            exposure_basis: 'card_shown',
            recommendations_exposed: 410,
            recommendations_accepted: 12,
            metrics: { exposures: metric(410, null, 120, '2026-10-24T03:00:00+00:00'), accepts: metric(12, 9, 10) },
          }
        : {
            exposure_basis: 'card_shown',
            recommendations_exposed: 128,
            recommendations_accepted: 5,
            visit_confirmations: 3,
            metrics: { exposures: metric(128, 97, 41), accepts: metric(5, 3, 4), arrivals: metric(3, 1, 3) },
          };
    },
  });
  const card = page.locator('section', { hasText: '② 성적표' });
  await expect(card.getByRole('heading', { name: '최근 7일 활동' })).toBeVisible();
  await expect(card.getByText('128회', { exact: true })).toBeVisible();
  await expect(card.getByText('41명 · 직전 7일 97회(+31)', { exact: true })).toBeVisible();
  await expect(card.getByText('4명 · 직전 7일 3건(+2)', { exact: true })).toBeVisible();
  // 도착 확인은 서버 숫자 그대로(예전에는 실계정에서 늘 비어 있었다).
  await expect(card.getByText('도착 확인', { exact: true })).toBeVisible();
  await expect(card.getByText('3명 · 직전 7일 1건(+2)', { exact: true })).toBeVisible();

  const toggle = card.getByRole('group', { name: '성적표 기간' });
  await toggle.getByRole('button', { name: '30일' }).click();
  await expect(toggle.getByRole('button', { name: '30일' })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.getByRole('heading', { name: '최근 30일 활동' })).toBeVisible();
  await expect(card.getByText('410회', { exact: true })).toBeVisible();
  // 카드 기록은 10-24 에 생겼다 — 30일 전체가 아니라 그날부터 센 숫자이고, 직전 30일과 비교하지 않는다.
  await expect(card.getByText('120명 · 10월 24일부터 집계', { exact: true })).toBeVisible();
  await expect(card.getByText('10명 · 직전 30일 9건(+3)', { exact: true })).toBeVisible();

  const asked = requested.length;
  await toggle.getByRole('button', { name: '7일' }).click();
  await expect(card.getByText('128회', { exact: true })).toBeVisible();
  expect(requested.length, '한 번 받은 기간을 다시 묻는다').toBe(asked);
  expect(new Set(requested)).toEqual(new Set([7, 30]));
});

// P1-2 · 브리핑 자리 — LLM 이 꺼져 있으면(운영의 평소 상태) 맨 위를 비우지 않고 성적표 숫자 요약을 그린다.
// 'AI 실행 브리핑' 제목 아래 숫자 요약을 두면 그것도 거짓말이라 제목도 바꾼다.
test('AI 브리핑이 없으면 맨 위 자리는 성적표 숫자 요약이다 — AI 제목을 달지 않는다(390px)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openRealConsole(page, {
    activeSale: false,
    statsFor: (days) => ({
      exposure_basis: 'card_shown',
      recommendations_exposed: days === 30 ? 410 : 128,
      recommendations_accepted: 5,
      visit_confirmations: 3,
      metrics: { exposures: metric(days === 30 ? 410 : 128, 97, 41), accepts: metric(5, 3, 4), arrivals: metric(3, 1, 3) },
    }),
  });
  const summary = page.locator('section', { hasText: '성적표 요약' });
  await expect(summary.getByRole('heading', { name: '최근 7일 한눈에' })).toBeVisible();
  await expect(summary).toContainText(
    '최근 7일 동안 우리 가게가 손님 화면에 추천 카드로 128번 떴고, 길안내 시작 5건 · 도착 확인 3건이 있었어요.',
  );
  await expect(summary).toContainText('도착 확인은 직전 7일(1건)보다 2건 늘었어요.');
  await expect(page.getByText('AI 실행 브리핑')).toHaveCount(0);
  await expect(page.getByText('오늘의 실행 브리핑')).toHaveCount(0);
  // 요약은 ① 보다 위(브리핑 자리)다.
  const forecast = page.locator('section', { hasText: '① 예상 혼잡' });
  expect((await summary.boundingBox())!.y).toBeLessThan((await forecast.boundingBox())!.y);
  // ② 를 30일로 바꿔도 맨 위 요약은 최근 7일 그대로다(위쪽이 들썩이지 않게).
  const card = page.locator('section', { hasText: '② 성적표' });
  await card.getByRole('group', { name: '성적표 기간' }).getByRole('button', { name: '30일' }).click();
  await expect(card.getByText('410회', { exact: true })).toBeVisible();
  await expect(summary).toContainText('128번');
});

test('AI 브리핑도 손님 흐름도 없으면 맨 위에 빈 카드·제목을 남기지 않는다', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openRealConsole(page, { activeSale: false });
  await expect(page.locator('section', { hasText: '② 성적표' }).getByText('우리 가게 성적표가 여기에 쌓입니다')).toBeVisible();
  await expect(page.getByText('성적표 요약')).toHaveCount(0);
  await expect(page.getByText('AI 실행 브리핑')).toHaveCount(0);
  // 왼쪽 열의 첫 카드는 ① 예상 혼잡이다(그 위에 빈 자리가 없다). 열은 ① 카드의 부모로 찾는다.
  const forecast = page.locator('section', { hasText: '① 예상 혼잡' });
  const leftColumn = forecast.locator('xpath=..');
  await expect(leftColumn.locator('section').first()).toContainText('① 예상 혼잡');
});

// 평가 M4 — 발행 직전에 비용을 말한다: 쿠폰은 세일이 끝나도 7일 살고, 20% 를 넘는 할인율은 추천에 더 보태지 않는다.
test('발행 확인 단계는 비용 안내 한 줄을 질문보다 먼저 보인다', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await stubConsoleNetwork(page, 'guest');
  await page.goto('/merchant?demo=1');
  await page.getByRole('group', { name: '할인율' }).getByRole('button', { name: '30%' }).click({ timeout: 20_000 });
  await page.getByRole('group', { name: '지속 시간' }).getByRole('button', { name: '1시간' }).click();
  await page.getByRole('button', { name: '타임세일 발행', exact: true }).click();
  const note = page.getByTestId('timesale-confirm').getByTestId('timesale-cost-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('세일이 끝나도 발급 후 7일 동안 쓸 수 있어요');
  await expect(note).toContainText('할인율이 20%를 넘어도 추천에 더해지는 효과는 20%와 같아요');
  const question = page.getByTestId('timesale-confirm').getByText(/이대로 발행할까요/);
  expect((await note.boundingBox())!.y, "'이대로 발행할까요?' 가 버튼 바로 위에 남지 않는다").toBeLessThan((await question.boundingBox())!.y);
});

// 리뷰(10-07) blocking — 심사위원이 ③ 에서 세일을 열면 쿠폰은 아직 0 이다(손님이 추천을 받아들여야 발급된다).
// 그 옆 ② 가 '타임세일을 열어 보세요' 를 계속 말하면 화면이 스스로 모순이다.
for (const viewport of [{ width: 1536, height: 730 }, { width: 390, height: 844 }]) {
  test(`${viewport.width}px — 세일이 진행 중이면 성적표는 '타임세일을 열어 보세요' 를 말하지 않는다`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    await openRealConsole(page, { stats: { recommendations_exposed: 3120, recommendations_accepted: 1 }, activeSale: true });
    await expect(page.getByTestId('timesale-active')).toContainText('⚡ 20% 타임세일 진행 중');
    const card = page.locator('section', { hasText: '② 성적표' });
    await expect(card.getByText('3,120회', { exact: true })).toBeVisible();
    await expect(page.getByText(/타임세일을 열어 보세요/)).toHaveCount(0);
  });
}

// 리뷰(10-07) blocking — 넓은 화면에서 ③ 은 이미 오른쪽 열에 보여 '타임세일 열기' 가 스크롤하지 않는다. 그때 금색 테가
// 그려지지 않으면(ring 은 .toss-surface 그림자에 지고, 바깥 테는 오른쪽 열 스크롤 상자에 잘렸다) 버튼이 아무 일도 안 한다.
test('1536×730 — ① 콜아웃의 타임세일 열기는 ③ 에 금색 테를 두르고 15% 칩으로 초점을 옮긴다', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const section = page.locator('#merchant-timesale');
  const rate15 = page.getByRole('group', { name: '할인율' }).getByRole('button', { name: '15%' });

  // ① 콜아웃(데모 — 13시 고정 시계면 '19시가 가장 한가할 것 같아요').
  await stubConsoleNetwork(page, 'guest');
  await page.clock.setFixedTime(KST_13);
  await page.goto('/merchant?demo=1');
  const forecast = page.locator('section', { hasText: '① 예상 혼잡' });
  await expect(forecast.getByText('19시가 가장 한가할 것 같아요')).toBeVisible({ timeout: 20_000 });
  await forecast.getByRole('button', { name: '타임세일 열기' }).click();
  await expect(section).toHaveCSS('outline-style', 'solid');
  await expect(section).toHaveCSS('outline-width', '2px');
  // 금색 테는 카드 안쪽에 그린다(오른쪽 열 스크롤 상자에 잘리지 않게).
  await expect(section).toHaveCSS('outline-offset', '-2px');
  await expect(rate15).toBeFocused();
});

test('1536×730 — 성적표의 타임세일 열기도 ③ 에 금색 테와 초점을 준다(실계정 · 세일 없음)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openRealConsole(page, { stats: { recommendations_exposed: 3120, recommendations_accepted: 1 }, activeSale: false });
  const card = page.locator('section', { hasText: '② 성적표' });
  await card.getByRole('button', { name: '타임세일 열기' }).click();
  const section = page.locator('#merchant-timesale');
  await expect(section).toHaveCSS('outline-style', 'solid');
  await expect(page.getByRole('group', { name: '할인율' }).getByRole('button', { name: '15%' })).toBeFocused();
  // 잠시 뒤 테는 걷힌다(늘 둘러져 있으면 '선택됨' 으로 읽힌다).
  await expect(section).toHaveCSS('outline-style', 'none', { timeout: 5_000 });
});

// 리뷰(10-07) — 1366×650(계획 3.2 시험 화면)에서는 오른쪽 열이 화면보다 길어 ④ 버튼은 열 안에서 조금 내려야 보인다.
// 알려 둔 한계를 잠근다: ③ 발행 버튼과 ④ 머리까지는 스크롤 없이 첫 화면이다.
for (const mode of ['demo', 'real'] as const) {
  test(`1366×650 (${mode}) — ③ 발행 버튼과 ④ 좌석 방송 머리는 첫 화면에 있다`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1366, height: 650 });
    await page.clock.setFixedTime(KST_13);
    if (mode === 'demo') {
      await stubConsoleNetwork(page, 'guest');
      await page.goto('/merchant?demo=1');
    } else {
      await openRealConsole(page);
    }
    const seat = page.getByRole('heading', { name: '지금 우리 가게 상태' });
    await expect(seat).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: '타임세일 발행', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(seat).toBeInViewport({ ratio: 1 });
    const box = await seat.boundingBox();
    console.log(`${mode} ④ heading bottom at 1366×650: ${Math.round(box!.y + box!.height)}px`);
  });
}

// 리뷰(10-07) — 오른쪽 열 스크롤 상자는 카드 그림자 자리를 둔다(가장자리에 붙으면 그림자가 잘려 각진 띠가 생겼다).
test('1536×730 — 오른쪽 열 카드와 스크롤 상자 사이에 그림자 자리가 있다', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await stubConsoleNetwork(page, 'guest');
  await page.goto('/merchant?demo=1');
  const actions = page.getByTestId('merchant-actions');
  const timesale = page.locator('#merchant-timesale');
  await expect(timesale).toBeVisible({ timeout: 20_000 });
  const [box, card] = [await actions.boundingBox(), await timesale.boundingBox()];
  expect(card!.x - box!.x, '왼쪽 그림자 자리').toBeGreaterThanOrEqual(12);
  expect(box!.x + box!.width - (card!.x + card!.width), '오른쪽 그림자 자리').toBeGreaterThanOrEqual(12);
  const padBottom = await actions.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
  expect(padBottom, '아래 그림자 자리').toBeGreaterThanOrEqual(24);
  // 그림자 자리(-mx-4)가 가장 좁은 두 열 폭(1024px)에서도 문서 가로 스크롤을 만들지 않는다.
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, '1024px 문서 가로 스크롤').toBeLessThanOrEqual(0);
});

// 리뷰(10-07) — 390px 에서 진행 중 배너 제목이 '진행 / 중' 으로 끊겼다. '타임세일 진행 중' 은 한 덩어리, 남은 시간은 다음 줄.
test('390×844 — 진행 중 배너 제목은 끊기지 않고 남은 시간은 다음 줄이다', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openRealConsole(page);
  const banner = page.getByTestId('timesale-active');
  await expect(banner).toContainText('⚡ 20% 타임세일 진행 중');
  const phrase = banner.getByText('타임세일 진행 중', { exact: true });
  const remaining = banner.getByText(/남음$/);
  const [phraseBox, remainingBox] = [await phrase.boundingBox(), await remaining.boundingBox()];
  expect(phraseBox!.height, "'타임세일 진행 중' 이 두 줄로 끊긴다").toBeLessThan(32);
  expect(remainingBox!.y, '남은 시간이 제목과 같은 줄에 끼어 있다').toBeGreaterThanOrEqual(phraseBox!.y + phraseBox!.height - 2);
});

test('발행 버튼 — 두 가지를 고르기 전에는 이유 한 줄, 고른 칩은 꽉 찬 먹색', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await stubConsoleNetwork(page, 'guest');
  await page.goto('/merchant?demo=1');
  const publish = page.getByRole('button', { name: '타임세일 발행', exact: true });
  const hint = page.getByText('할인율과 시간을 고르면 발행할 수 있어요');
  await expect(publish).toBeDisabled({ timeout: 20_000 });
  await expect(hint).toBeVisible();
  const rate = page.getByRole('group', { name: '할인율' }).getByRole('button', { name: '20%' });
  await rate.click();
  await expect(rate).toHaveAttribute('aria-pressed', 'true');
  await expect(rate).toHaveClass(/bg-muk/);
  await expect(publish).toBeDisabled();
  await page.getByRole('group', { name: '지속 시간' }).getByRole('button', { name: '2시간' }).click();
  await expect(publish).toBeEnabled();
  await expect(hint).toHaveCount(0);
});

test('390×844 — 콘솔 토스트는 위 가운데에 떠서 좌석 버튼을 덮지 않는다', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await stubConsoleNetwork(page, 'guest');
  await page.goto('/merchant?demo=1');
  const seats = page.getByRole('group', { name: '좌석 상태 방송' });
  await seats.getByRole('button', { name: '여유' }).click({ timeout: 20_000 });
  const toast = page.getByText('데모에서는 저장되지 않아요').first();
  await expect(toast).toBeVisible();
  const [toastBox, seatBox] = [await toast.boundingBox(), await seats.boundingBox()];
  expect(toastBox!.y, '토스트가 화면 위쪽이 아니다').toBeLessThan(844 / 2);
  const overlaps = toastBox!.y < seatBox!.y + seatBox!.height && seatBox!.y < toastBox!.y + toastBox!.height;
  expect(overlaps, '토스트가 좌석 버튼을 덮는다').toBe(false);
});
