import { expect, test } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// /explore/recommend 의 by-type 대안 — **원래 장소와 같은 유형**을 묻는다.
//
// 추천 effect 는 userId 가 오면 시작하는데, userId 는 로컬 세션에서 바로 나오고 원래 장소는
// 네트워크 왕복 뒤에 온다. 그래서 effect 가 잡아 둔 originalFacility 는 대개 null 이었고, 대안이
// 늘 'restaurant' 로 나갔다 — 카페 화면의 '대안' 이 음식점으로 찼다. 여기서는 원래 장소 응답을
// 일부러 늦춰 그 순서를 고정하고, 개인화 추천을 두 번 실패시켜 대안 경로로 보낸다.

test.beforeEach(async ({ page }) => stubExternalServices(page));

const alternatives = [
  ['alt-a', '고요한 찻집'],
  ['alt-b', '박물관 카페'],
].map(([id, name], index) => ({
  recommendation_id: `rec-${id}`,
  facility: {
    id, name, type: 'cafe', latitude: 35.838 + index * 0.001, longitude: 129.209, capacity: 30,
    coupon_rate: 0, features: { indoor: true }, operating_hours: { open: '09:00~22:00', closed: '연중무휴' },
  },
  spot_score: 0.8 - index * 0.1, distance_m: 150 + index * 60, rank: index + 1, total_candidates: 2,
  breakdown: { preference: 0.8, wait_time: null, travel_time: 3, incentive: 0 },
  reason: `${name} 추천 사유`, reason_source: 'template',
  congestion_level: null, congestion_source: 'none', open_status_at_arrival: 'open_expected',
  scoring_mode: 'area_stats_rules', prediction_source: 'unavailable',
}));

test('카페에서 추천이 실패하면 대안도 카페로 묻는다', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => localStorage.setItem('nextspot_onboarding_done', '1'));

  await page.route('**/rest/v1/**', async (route) => {
    if (route.request().url().includes('/facilities')) {
      // 원래 장소는 추천 effect 가 시작된 뒤에 도착한다(실서비스의 흔한 순서).
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: 'origin-cafe', name: '황리단길 카페', type: 'cafe', features: {}, congestion_logs: [],
      }) });
      return;
    }
    await route.fulfill({ status: 200, headers: { 'content-range': '0-0/1' }, body: '[]' });
  });

  const byTypeBodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/api/v1/recommendations/by-type')) {
      byTypeBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(alternatives) });
    } else if (url.endsWith('/api/v1/recommendations')) {
      // 응답이 온 실패(타임아웃 아님) → 2.5초 뒤 1회 재시도 → 다시 실패 → by-type 대안.
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"fixture failure"}' });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
  });

  await page.goto('/explore/recommend?facilityId=origin-cafe&lat=35.838&lng=129.209');

  await expect(page.locator('section.space-y-4 h4')).toHaveText(['고요한 찻집', '박물관 카페'], { timeout: 30_000 });
  expect(byTypeBodies.length).toBeGreaterThan(0);
  for (const body of byTypeBodies) {
    expect(body.facility_type, '카페 화면의 대안을 다른 유형으로 물었다').toBe('cafe');
    expect(body.exclude_ids).toEqual(['origin-cafe']);
  }
});

// 10-06 실측(밤): 대기 보드에서 누른 장소의 개인화 추천이 [] — 머리글은 '… 주변의 지금 좋은 선택을 모았어요' 인데
// 아래는 '주변 다른 곳에서 다시 찾아볼까요? 반경을 넓히면 …' 빈 상자였다. 비면 같은 유형 대안을 한 번 더 찾고,
// 그래도 없으면 머리글이 결과를 약속하지 않고 빈 상자 대신 지도로 가는 버튼 하나만 둔다.
async function stubEmptyPersonalised(page: import('@playwright/test').Page, byType: unknown[]) {
  await page.addInitScript(() => localStorage.setItem('nextspot_onboarding_done', '1'));
  await page.route('**/rest/v1/**', async (route) => {
    if (route.request().url().includes('/facilities')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: 'origin-cafe', name: '황리단길 카페', type: 'cafe', features: {}, congestion_logs: [],
      }) });
      return;
    }
    await route.fulfill({ status: 200, headers: { 'content-range': '0-0/1' }, body: '[]' });
  });
  const byTypeBodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/api/v1/recommendations/by-type')) {
      byTypeBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(byType) });
    } else if (url.endsWith('/api/v1/recommendations')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
  });
  return byTypeBodies;
}

test('an empty personalised answer is filled once with same-type alternatives', async ({ page }) => {
  test.setTimeout(60_000);
  const byTypeBodies = await stubEmptyPersonalised(page, alternatives);
  await page.goto('/explore/recommend?facilityId=origin-cafe&lat=35.838&lng=129.209');

  await expect(page.locator('section.space-y-4 h4')).toHaveText(['고요한 찻집', '박물관 카페'], { timeout: 30_000 });
  // 머리글은 한 줄 — 무엇을 보여 주는지 그대로 말한다(계획 B5/P11, 예전 '… 주변의 지금 좋은 선택을 모았어요').
  await expect(page.getByRole('heading', { level: 1, name: '황리단길 카페 대신 갈 만한 2곳' })).toBeVisible();
  expect(byTypeBodies).toHaveLength(1);
  expect(byTypeBodies[0].facility_type).toBe('cafe');
  expect(byTypeBodies[0].exclude_ids).toEqual(['origin-cafe']);
});

test('no alternatives at all: no promise in the header and no empty box, one way to the map', async ({ page }) => {
  test.setTimeout(60_000);
  // 심사 데스크톱(1536×730) — 밤의 흔한 경우다. 결과 칸은 데스크톱에서 두 칸 격자라, 다음 행동 상자가 왼쪽 반에만 서면 오른쪽이 텅 빈다.
  await page.setViewportSize({ width: 1536, height: 730 });
  await stubEmptyPersonalised(page, []);
  await page.goto('/explore/recommend?facilityId=origin-cafe&lat=35.838&lng=129.209');

  const toMap = page.getByRole('button', { name: '지도에서 다른 곳 둘러보기' });
  await expect(toMap).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: '황리단길 카페', exact: true })).toBeVisible();
  await expect(page.getByText(/모았어요|다시 찾아볼까요|반경을 넓히면|아래에서 바로 비교|대신 갈 만한|걸어서 갈 수 있는 곳/)).toHaveCount(0);
  await expect(page.getByText('실시간 추천 대안')).toHaveCount(0);
  // 빈 상자 대신 긍정적인 다음 행동 한 줄 — 결과 칸의 전체 폭으로.
  await expect(page.getByText('근처 다른 곳은 지도에서 바로 고를 수 있어요')).toBeVisible();
  const next = page.getByTestId('recommend-empty-next');
  const [nextBox, sectionBox] = await Promise.all([next.boundingBox(), page.locator('section.space-y-4').boundingBox()]);
  expect(nextBox!.width, '다음 행동 상자가 결과 칸의 반만 쓴다').toBeGreaterThanOrEqual(sectionBox!.width * 0.9);
  await toMap.click();
  await expect(page).toHaveURL(/\/main/, { timeout: 30_000 });
});

// ── 대기 보드에서 눌러 온 화면(2026-10-06 감사 I25 · P11 · I74) ────────────────────────────────────
// 대기 보드는 누른 장소의 좌표·종류를 넘긴다 — 대안은 그 장소 둘레의 같은 종류이고, 걷는 시간도 그 장소에서 잰다.
// 머리글은 한 줄('{장소}에서 걸어서 갈 수 있는 곳'), 원래 장소의 붐빔은 알약 하나(조사는 받침으로 — '은(는)' 금지).
const ATTRACTIONS = [
  ['alt-gyerim', '경주 계림', 'attraction'],
  ['alt-museum', '국립경주박물관', 'culture'],
  ['alt-wolji', '동궁과 월지', 'attraction'],
].map(([id, name, type], index) => ({
  recommendation_id: `rec-${id}`,
  facility: {
    id, name, type, latitude: 35.832 + index * 0.001, longitude: 129.219, capacity: 300,
    coupon_rate: 0, features: {}, operating_hours: { open: '09:00~22:00', closed: '연중무휴' },
  },
  spot_score: 0.8 - index * 0.05, distance_m: 180 + index * 90, rank: index + 1, total_candidates: 3,
  breakdown: { preference: 0.7, wait_time: null, travel_time: 3 + index * 2, incentive: 0 },
  reason: `${name}까지 도보 ${3 + index * 2}분 · 혼잡도 82%`, reason_source: 'template',
  congestion_level: null, congestion_source: 'none', open_status_at_arrival: 'open_expected',
  scoring_mode: 'area_stats_rules', prediction_source: 'unavailable',
  // 이 대안의 지금 추정 붐빔(공영주차 실측 기반) — 원래 장소(혼잡)보다 덜하다.
  congestion_estimate: {
    source: 'estimated', level: 0.3, observed_at: new Date(Date.now() - 3 * 60_000).toISOString(),
    parking_level: 0.3, tourism_level: null, lot_count: 1, nearest_lot_m: 300, radius_m: 2000,
  },
}));

async function stubFromWaiting(
  page: import('@playwright/test').Page,
  opts: {
    typedEmpty?: boolean;
    originLevel?: number;
    locale?: 'ko' | 'en';
    /** 원래 장소의 congestion_logs(최신순). */
    originLogs?: unknown[];
    /** 대안 목록을 바꿔 끼운다. */
    items?: unknown[];
  } = {},
) {
  await page.addInitScript((locale) => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    localStorage.setItem('nextspot_locale', locale);
  }, opts.locale ?? 'ko');
  await page.route('**/rest/v1/**', async (route) => {
    if (route.request().url().includes('/facilities')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: 'origin-cheom', name: '경주 첨성대', type: 'attraction', features: {}, congestion_logs: opts.originLogs ?? [],
      }) });
    }
    return route.fulfill({ status: 200, headers: { 'content-range': '0-0/1' }, body: '[]' });
  });
  const bodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/api/v1/recommendations')) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      bodies.push(body);
      const typed = Array.isArray(body.candidate_types) && (body.candidate_types as unknown[]).length > 0;
      const items = typed && opts.typedEmpty ? [] : (opts.items ?? ATTRACTIONS);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) });
    }
    if (url.includes('/api/v1/congestion/estimates')) {
      const observedAt = new Date().toISOString();
      const estimates: Record<string, unknown> = {};
      if (typeof opts.originLevel === 'number') {
        estimates['origin-cheom'] = { source: 'estimated', level: opts.originLevel, observed_at: observedAt };
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true, estimates }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  return bodies;
}

const FROM_WAITING = '/explore/recommend?facilityId=origin-cheom&lat=35.8347&lng=129.219&type=attraction&from=waiting';

test('from the waiting board: same-kind alternatives around the tapped place, one header, a josa-safe origin pill', async ({ page }) => {
  test.setTimeout(60_000);
  const bodies = await stubFromWaiting(page, { originLevel: 0.9 });
  await page.goto(FROM_WAITING);

  await expect(page.locator('section.space-y-4 h4')).toHaveText(['경주 계림', '국립경주박물관', '동궁과 월지'], { timeout: 30_000 });
  expect(bodies[0].candidate_types).toEqual(['attraction', 'culture']);
  expect(bodies[0].user_lat).toBeCloseTo(35.8347, 6);
  expect(bodies[0].user_lng).toBeCloseTo(129.219, 6);
  // 머리글 한 줄 + 원래 장소의 붐빔 알약(받침 없는 '대' → '는').
  await expect(page.getByRole('heading', { level: 1, name: '경주 첨성대에서 걸어서 갈 수 있는 곳' })).toBeVisible();
  const pill = page.getByTestId('recommend-origin-pill');
  await expect(pill).toContainText('경주 첨성대는 지금 붐비는 편이에요');
  await expect(pill).toContainText('추정');
  await expect(page.getByText(/은\(는\)|이\(가\)/)).toHaveCount(0);
  // 원래 장소(혼잡)보다 확실히 덜 붐비는 대안만 앞면에 등급 칩이 붙는다.
  await expect(page.locator('[data-testid="alt-benefits"]').first()).toContainText('추정 혼잡: 여유');
  // 앞면에는 관광객이 얻는 것만 — 순위 산식·근거 원자료·서버 사유는 '추천 근거 자세히' 뒤에.
  const firstCard = page.getByTestId('alt-card').first();
  await expect(firstCard).not.toContainText('혼잡도 82%');
  await expect(firstCard).not.toContainText('경주 공영주차 실측 기반');
  await firstCard.getByRole('button', { name: '추천 근거 자세히' }).click();
  await expect(firstCard).toContainText('혼잡도 82%');
  await expect(firstCard).toContainText('경주 공영주차 실측 기반');
});

test('from the waiting board: an empty same-kind answer retries once without the kind filter', async ({ page }) => {
  test.setTimeout(60_000);
  const bodies = await stubFromWaiting(page, { typedEmpty: true });
  await page.goto(FROM_WAITING);
  await expect(page.locator('section.space-y-4 h4')).toHaveCount(3, { timeout: 30_000 });
  expect(bodies).toHaveLength(2);
  expect(bodies[0].candidate_types).toEqual(['attraction', 'culture']);
  expect(bodies[1].candidate_types).toEqual([]);
});

test('Top 3 order sits below the list behind a toggle, with minutes written as 분', async ({ page }) => {
  test.setTimeout(60_000);
  await stubFromWaiting(page, { originLevel: 0.9 });
  await page.goto(FROM_WAITING);
  await expect(page.locator('section.space-y-4 h4')).toHaveCount(3, { timeout: 30_000 });
  await expect(page.getByText('추천 Top 3 한눈에 비교')).toHaveCount(0);
  const toggle = page.getByRole('button', { name: '순서 자세히' });
  // 토글은 목록 아래에 있다.
  const [lastCard, toggleBox] = await Promise.all([page.getByTestId('alt-card').last().boundingBox(), toggle.boundingBox()]);
  expect(toggleBox!.y).toBeGreaterThan(lastCard!.y);
  await toggle.click();
  await expect(page.getByText('추천 Top 3 한눈에 비교')).toBeVisible();
  await page.getByRole('button', { name: '상위 추천 비교하기' }).click();
  const walkRow = page.locator('tr', { has: page.getByText('도보 · 대기') });
  await expect(walkRow).toContainText('3분');
  await expect(walkRow).not.toContainText(/\dm\b/);
  await expect(walkRow).not.toContainText('수집 중');
});

// 46일 된 관측(감사 '마지막 관측 8/21')으로 '지금 여유로운 편이에요' 라고 말하지 않는다 — 보드가 방금 '추정' 으로 보여 준
// 등급을 같은 '추정' 표시와 함께 쓴다. 낡은 관측은 '지금' 자격이 없다(신뢰 등급 · 30분 이내만).
test('a month-old origin log never speaks for now: the pill comes from the estimate, tagged as one', async ({ page }) => {
  test.setTimeout(60_000);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  await stubFromWaiting(page, {
    originLevel: 0.9,
    originLogs: [{ congestion_level: 0.1, timestamp: monthAgo, source: 'parking', evidence_tier: 'verified' }],
  });
  await page.goto(FROM_WAITING);
  await expect(page.locator('section.space-y-4 h4')).toHaveCount(3, { timeout: 30_000 });
  const pill = page.getByTestId('recommend-origin-pill');
  await expect(pill).toContainText('경주 첨성대는 지금 붐비는 편이에요');
  await expect(pill).toContainText('추정');
  await expect(page.getByText('지금 여유로운 편이에요')).toHaveCount(0);
  // 대안의 덜 붐빔 칩은 그 추정 등급과 견준다(낡은 '한산' 과 견주면 하나도 붙지 않았다).
  await expect(page.locator('[data-testid="alt-benefits"]').first()).toContainText('추정 혼잡: 여유');
});

test('a fresh trusted origin log still speaks for now, without the estimate tag', async ({ page }) => {
  test.setTimeout(60_000);
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  await stubFromWaiting(page, {
    originLevel: 0.1,
    originLogs: [{ congestion_level: 0.9, timestamp: fiveMinAgo, source: 'merchant', evidence_tier: 'verified' }],
  });
  await page.goto(FROM_WAITING);
  await expect(page.locator('section.space-y-4 h4')).toHaveCount(3, { timeout: 30_000 });
  const pill = page.getByTestId('recommend-origin-pill');
  await expect(pill).toContainText('경주 첨성대는 지금 붐비는 편이에요');
  await expect(pill).not.toContainText('추정');
});

// 앞면은 혜택만 — 실측·예측 붐빔 칩도 원래 장소보다 확실히 덜할 때만, 실제 대기 분이 있으면 '예상 대기' 칩.
function measuredAlt(id: string, name: string, level: number, waitMin: number | null, rank: number) {
  return {
    recommendation_id: `rec-${id}`,
    facility: {
      id, name, type: 'attraction', latitude: 35.833, longitude: 129.219, capacity: 300,
      coupon_rate: 0, features: {}, operating_hours: { open: '09:00~22:00', closed: '연중무휴' },
    },
    spot_score: 0.8, distance_m: 200, rank, total_candidates: 2,
    breakdown: { preference: 0.7, wait_time: waitMin, travel_time: 3, incentive: 0 },
    reason: `${name} 추천 사유`, reason_source: 'template',
    congestion_level: level, congestion_source: 'measured', congestion_is_current: true,
    congestion_timestamp: new Date(Date.now() - 4 * 60_000).toISOString(), congestion_log_source: 'merchant',
    open_status_at_arrival: 'open_expected', scoring_mode: 'measured_rules', prediction_source: 'unavailable',
  };
}

test('card face: a measured crowd chip only when calmer than the origin, and a real wait as a benefit chip', async ({ page }) => {
  test.setTimeout(60_000);
  await stubFromWaiting(page, {
    originLevel: 0.9,
    items: [measuredAlt('calm', '한산한 뜰', 0.1, 12, 1), measuredAlt('busy', '붐비는 뜰', 0.92, null, 2)],
  });
  await page.goto(FROM_WAITING);
  await expect(page.locator('section.space-y-4 h4')).toHaveText(['한산한 뜰', '붐비는 뜰'], { timeout: 30_000 });
  const [calm, busy] = [page.getByTestId('alt-card').nth(0), page.getByTestId('alt-card').nth(1)];
  await expect(calm.getByTestId('alt-benefits')).toContainText('혼잡도: 한산');
  await expect(calm.getByTestId('alt-benefits')).toContainText('예상 대기 12분');
  // 원래 장소만큼 붐비는 곳의 '혼잡' 은 앞면에 쓰지 않는다 — '추천 근거 자세히' 뒤에서는 그대로 볼 수 있다.
  await expect(busy.getByTestId('alt-benefits')).not.toContainText('혼잡도');
  await busy.getByRole('button', { name: '추천 근거 자세히' }).click();
  await expect(busy).toContainText('혼잡도: 혼잡');
});

// 폰: 화면 고정 음성 버튼(+ 이름표)이 첫 카드의 버튼을 덮지 않는다 — 카드 행동 줄이 그 자리를 비워 둔다.
for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 640 }]) {
  test(`${viewport.width}px: the voice control never covers the first card's buttons`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    await stubFromWaiting(page, { originLevel: 0.9 });
    await page.goto(FROM_WAITING);
    await expect(page.locator('section.space-y-4 h4')).toHaveCount(3, { timeout: 30_000 });
    const control = page.getByTestId('recommend-voice-control');
    await expect(control).toBeVisible({ timeout: 20_000 });
    const first = page.getByTestId('alt-card').first();
    const buttons = first.locator('button:visible');
    const n = await buttons.count();
    // 첫 카드가 음성 버튼 높이를 지나도록 굴려 가며 본다(카드마다 같은 줄 구조).
    for (const scroll of [0, 200, 400]) {
      await page.evaluate((y) => window.scrollTo(0, y), scroll);
      const c = (await control.boundingBox())!;
      for (let i = 0; i < n; i++) {
        const b = await buttons.nth(i).boundingBox();
        if (!b) continue;
        const overlap = b.x < c.x + c.width && b.x + b.width > c.x && b.y < c.y + c.height && b.y + b.height > c.y;
        expect(overlap, `음성 버튼이 '${(await buttons.nth(i).innerText()).trim()}' 를 덮는다(scroll ${scroll})`).toBe(false);
      }
      // 카드 전체(사진 · SPOT 배지 포함)가 버튼 왼쪽에서 끝난다 — 목록이 버튼 자리를 비워 둔다(리뷰 10-07: SPOT 배지를 덮었다).
      for (const box of await page.getByTestId('alt-card').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))) {
        expect(box, `카드 오른쪽 끝이 음성 버튼 밑으로 들어간다(scroll ${scroll})`).toBeLessThanOrEqual(c.x);
      }
    }
  });
}

test('en: no Korean server reason anywhere on the alternatives, even behind the toggle', async ({ page }) => {
  test.setTimeout(60_000);
  await stubFromWaiting(page, { originLevel: 0.9, locale: 'en' });
  await page.goto(FROM_WAITING);
  await expect(page.locator('section.space-y-4 h4')).toHaveCount(3, { timeout: 30_000 });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1, name: 'A short walk from 경주 첨성대' })).toBeVisible();
  const toggles = page.getByRole('button', { name: 'See why we picked it' });
  for (let i = 0; i < 3; i++) await toggles.nth(i).click();
  await expect(page.getByText(/혼잡도|도보 \d+분/)).toHaveCount(0);
});
