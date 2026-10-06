import { expect, test, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// /waiting 이 '한 등급' 보드를 어떻게 말하는가(2026-10-06 감사 I03 · I64 · I25 · P12).
// - 추정·주변 수요는 공영주차 몇 곳으로 만든 권역 값이라 낮에는 거의 모든 카드가 '추정 혼잡: 혼잡' 을 똑같이 말했다.
//   다 찬 보드가 한 등급이면 그 등급을 보드 위 한 줄로 한 번만 말하고, 카드에는 걷는 시간을 둔다.
// - 판정은 다 찬 보드에서만 — 도착 중인 섹션(부분 보드)으로는 바꾸지 않는다(섹션이 올 때마다 문구가 뒤집히지 않게).
// - 등급이 갈리면 카드마다 등급, 등급마다 다른 색(혼잡 terracotta · 보통 gold · 여유/한산 jade).
// - 카드를 누르면 그 장소의 좌표·종류로 대안을 묻는다. 대표 카드에는 '대신 갈 곳 보기' 가 글로 보인다.

test.beforeEach(async ({ page }) => stubExternalServices(page));

type Kind = 'restaurant' | 'cafe' | 'attraction' | 'culture';
const NAMES: Record<Kind, string[]> = {
  restaurant: ['황남 국밥', '구로 쌈밥', '교리 김밥'],
  cafe: ['한옥 찻집', '대릉원 커피', '첨성대 베이커리'],
  attraction: ['경주 첨성대', '경주 계림', '동궁과 월지'],
  culture: ['국립경주박물관'],
};
const idOf = (kind: Kind, i: number) => `${kind}${i}`;

function item(kind: Kind, i: number) {
  const facility = {
    id: idOf(kind, i), name: NAMES[kind][i], type: kind, latitude: 35.83 + i * 0.001, longitude: 129.21 + i * 0.001,
    capacity: 30, congestion: null, image_url: null, gallery_images: null, features: {},
    operating_hours: { open: '00:00~23:59', closed: '연중무휴' },
  };
  return {
    recommendation_id: `rec-${facility.id}`, facility, spot_score: 0.8 - i * 0.01,
    breakdown: { preference: 0.8, wait_time: null, travel_time: 3 + i * 2, incentive: 0 },
    distance_m: 200 + i * 150, reason: '테스트 추천', reason_source: 'template',
    congestion_level: null, congestion_source: 'none', congestion_log_source: null,
    congestion_is_stale: null, congestion_timestamp: null, rank: i + 1, total_candidates: 3,
    open_status_at_arrival: 'open_expected', information_confidence: 'verified', eligibility_tier: 'verified_open_route',
    place_data_source: 'test', data_updated_at: null,
    scoring_mode: 'area_stats_rules', model_version: null, prediction_source: 'unavailable',
  };
}

async function routeBoard(page: Page, levels: Record<string, number>, hold?: (type: string) => Promise<void> | void) {
  await page.addInitScript(() => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    localStorage.setItem('nextspot_assumed_at', 'now');
    localStorage.removeItem('nextspot_waiting_board_v2');
  });
  await page.route('**/api/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/api/v1/recommendations/by-type')) {
      const type = String((route.request().postDataJSON() as { facility_type?: string }).facility_type ?? '') as Kind;
      await hold?.(type);
      const body = (NAMES[type] ?? []).map((_, i) => item(type, i));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    }
    if (pathname.endsWith('/api/v1/congestion/estimates')) {
      const observedAt = new Date().toISOString();
      const estimates = Object.fromEntries(
        Object.entries(levels).map(([id, level]) => [id, { source: 'estimated', level, observed_at: observedAt }]),
      );
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true, estimates }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

const allIds = () => (Object.keys(NAMES) as Kind[]).flatMap((k) => NAMES[k].map((_, i) => idOf(k, i)));
const cards = (page: Page) => page.locator('div.grid-rows-\\[1fr_auto\\] > button');
const board = (page: Page) => page.locator('main [aria-busy]');
const areaLine = (page: Page) => page.getByTestId('waiting-area-line');

test('a one-grade board says the grade once and shows walking minutes on the cards', async ({ page }) => {
  test.setTimeout(90_000);
  await routeBoard(page, Object.fromEntries(allIds().map((id) => [id, 0.88])));
  await page.goto('/waiting');
  await expect(board(page)).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });

  await expect(areaLine(page)).toHaveCount(1);
  await expect(areaLine(page)).toContainText('지금 경주 시내 중심 혼잡 · 추정');
  await expect(cards(page).filter({ hasText: '추정 혼잡' })).toHaveCount(0);
  await expect(cards(page).first()).toContainText('도보 3분');
  // 머리글은 카드가 보여 주는 것만 약속한다 — 카드는 걷는 시간을 보여 주고, 그 걷는 시간이 어디서 출발하는지 말한다
  // (보드는 황리단길에서 잰다 — 서울의 심사위원이 '내 자리에서 3분' 으로 읽지 않게).
  await expect(page.getByText('카드의 걷는 시간은 황리단길에서 출발한 기준이에요.')).toBeVisible();
  await expect(page.getByText('카드마다 도착할 때의 붐빔')).toHaveCount(0);
  // 대표 카드마다 무엇이 열리는지 글로.
  await expect(cards(page).filter({ hasText: '대신 갈 곳 보기' })).toHaveCount(await cards(page).count());
});

test('under an assumed time the one-grade line names that time and never says now', async ({ page }) => {
  test.setTimeout(90_000);
  await routeBoard(page, Object.fromEntries(allIds().map((id) => [id, 0.88])));
  // routeBoard 의 'now' 뒤에 등록 — 나중 스크립트가 이긴다.
  await page.addInitScript(() => localStorage.setItem('nextspot_assumed_at', 'sat_afternoon'));
  await page.goto('/waiting');
  await expect(board(page)).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await expect(areaLine(page)).toContainText('토 14:00 기준 경주 시내 중심 혼잡 · 추정');
  await expect(areaLine(page)).not.toContainText('지금');
});

test("the board grades with the operator's busy threshold, like the map and the alternatives", async ({ page }) => {
  test.setTimeout(90_000);
  await routeBoard(page, Object.fromEntries(allIds().map((id) => [id, 0.7])));
  // 운영자가 '혼잡' 을 65%부터로 정했다 — 0.7 은 기본 눈금(75%)이면 '보통', 이 설정이면 '혼잡'.
  await page.route('**/api/v1/system/public-settings', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ maintenanceMode: false, noticeText: '', congestionThreshold: 65 }),
  }));
  await page.goto('/waiting');
  await expect(board(page)).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await expect(areaLine(page)).toContainText('지금 경주 시내 중심 혼잡 · 추정');
});

test('partial sections never switch the board to the one-grade line', async ({ page }) => {
  test.setTimeout(90_000);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await routeBoard(page, Object.fromEntries(allIds().map((id) => [id, 0.88])), async (type) => {
    if (type === 'culture') await held;
  });
  await page.goto('/waiting');
  // 음식점·카페·관광지는 이미 보이지만 문화시설이 오는 중 — 보드는 아직 다 차지 않았다.
  await expect(page.getByText('경주 첨성대').first()).toBeVisible({ timeout: 60_000 });
  await expect(board(page)).toHaveAttribute('aria-busy', 'true');
  await page.waitForTimeout(1500); // 추정 피드가 도착할 틈 — 와도 부분 보드에서는 한 줄로 바꾸지 않는다
  await expect(areaLine(page)).toHaveCount(0);
  await expect(cards(page).filter({ hasText: '추정 혼잡: 혼잡' })).toHaveCount(9);

  release();
  await expect(board(page)).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
  await expect(areaLine(page)).toHaveCount(1);
  await expect(cards(page).filter({ hasText: '추정 혼잡' })).toHaveCount(0);
});

test('when grades differ, each card keeps its grade in its own colour and calm cards lead', async ({ page }) => {
  test.setTimeout(90_000);
  const levels = Object.fromEntries(allIds().map((id) => [id, 0.5]));
  levels[idOf('restaurant', 0)] = 0.9; // 서버 1위가 혼잡
  levels[idOf('restaurant', 1)] = 0.6;
  levels[idOf('restaurant', 2)] = 0.1; // 서버 3위가 한산
  await routeBoard(page, levels);
  await page.goto('/waiting');
  await expect(board(page)).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await expect(areaLine(page)).toHaveCount(0);

  const restaurant = page.locator('main section.fractal-glass').first().locator('div.grid-rows-\\[1fr_auto\\] > button');
  // 한산한 곳이 먼저(PM 결정 4.20) — 서버 순서는 혼잡 → 보통 → 한산이었다.
  await expect(restaurant.locator('[data-card-body] p').first()).toHaveText('교리 김밥');
  const quiet = restaurant.filter({ hasText: '교리 김밥' }).locator('[data-wait-stats] > p').first();
  const busy = restaurant.filter({ hasText: '황남 국밥' }).locator('[data-wait-stats] > p').first();
  await expect(quiet).toHaveText('추정 혼잡: 한산');
  await expect(busy).toHaveText('추정 혼잡: 혼잡');
  await expect(quiet).toHaveClass(/text-jade/);
  await expect(busy).toHaveClass(/text-terracotta/);
  await expect(busy).toHaveClass(/border-dashed/);
});

test('tapping a card asks for alternatives around that place, of the same kind', async ({ page }) => {
  test.setTimeout(90_000);
  await routeBoard(page, {});
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('/waiting');
  await expect(board(page)).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await cards(page).filter({ hasText: '경주 계림' }).click();
  await expect(page).toHaveURL(/\/explore\/recommend\?/);
  const url = new URL(page.url());
  expect(url.searchParams.get('facilityId')).toBe(idOf('attraction', 1));
  expect(Number(url.searchParams.get('lat'))).toBeCloseTo(35.831, 6);
  expect(Number(url.searchParams.get('lng'))).toBeCloseTo(129.211, 6);
  expect(url.searchParams.get('type')).toBe('attraction');
  expect(url.searchParams.get('from')).toBe('waiting');
});

test('an empty board offers the map instead of saying there is nothing', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => localStorage.setItem('nextspot_onboarding_done', '1'));
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('/waiting');
  const cta = page.getByRole('link', { name: '지도에서 고르기' });
  await expect(cta).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/표시할 장소가 없어요|없어요/)).toHaveCount(0);
  await cta.click();
  await expect(page).toHaveURL(/\/main/, { timeout: 30_000 }); // 첫 /main 컴파일(dev 서버) 여유
});
