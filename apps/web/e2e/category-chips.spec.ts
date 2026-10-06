import { expect, test, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';
import { stubMain } from './support/mainStubs';

// 카테고리 칩과 ♿ 가 막다른 길이 되지 않는다(계획 A5).
//   · 온보딩에서 음식점+카페만 골랐어도 관광지·문화시설 칩은 제 유형을 추천한다 — 저장된 categories 는
//     첫 칩을 고를 뿐, 다른 칩을 '추천할 곳이 없어요' 로 막지 않는다(by-type 요청도 categories:[]).
//   · 도보 제한(10분)이 칩을 비우면 한 번만 넓힌다 — 직선거리로 이미 비면 처음부터, 서버가 실제 걷는 길로
//     0곳을 주면 한 번 더 묻는다.
//   · ♿ 를 켠 칩에 무장애 확인 장소가 없으면 가장 많은 칩으로 옮기고 그 사실을 말한다. 그 상태로 빈 칩을
//     누르면 '없어요' 두 개 대신 갈 칩을 고르는 카드 하나다. 무장애 확인 장소가 한 곳도 없으면 ♿ 칩이 없다.

// 외부로 나가는 호출을 전부 막는다 — 지도 SDK 와 Supabase 인증(support/stubs.ts).
test.beforeEach(async ({ page }) => stubExternalServices(page));

const CENTER = { lat: 35.8362, lng: 129.2095 }; // REGION.center — 위치 권한이 없으면 여기서 잰다
const NORTH_M = (meters: number) => CENTER.lat + meters / 111_000;

interface Place { id: string; name: string; type: string; meters: number; barrierFree?: boolean }

function mapRow(place: Place) {
  return {
    id: place.id,
    name: place.name,
    type: place.type,
    latitude: NORTH_M(place.meters),
    longitude: CENTER.lng,
    capacity: 30,
    features: {},
    barrier_free: place.barrierFree ?? null,
    congestion: null,
    operating_hours: { open: '00:00~23:59', closed: '연중무휴' },
  };
}

function rec(place: Place) {
  return {
    recommendation_id: `rec-${place.id}`,
    facility: mapRow(place),
    spot_score: 0.7,
    distance_m: place.meters,
    rank: 1,
    total_candidates: 1,
    reason: `${place.name} 고정 추천 사유`,
    reason_source: 'template',
    congestion_level: null,
    congestion_source: 'none',
    congestion_timestamp: null,
    open_status_at_arrival: 'open_expected',
    scoring_mode: 'degraded_rules',
    prediction_source: 'unavailable',
    breakdown: { preference: 0.7, wait_time: null, travel_time: Math.ceil(place.meters / 67), incentive: 0 },
  };
}

interface ByTypeBody { facility_type: string; context?: { categories?: string[]; max_walk_minutes?: number | null } }

async function openMain(page: Page, places: Place[], options: {
  setupPrefs?: Record<string, unknown>;
  /** by-type 응답 — 기본은 그 유형의 첫 장소 하나. */
  respond?: (body: ByTypeBody) => Place[];
} = {}): Promise<ByTypeBody[]> {
  const bodies: ByTypeBody[] = [];
  await stubMain(page, { facilities: places.map(mapRow), byType: () => [] });
  if (options.setupPrefs) {
    await page.addInitScript((prefs) => {
      localStorage.setItem('nextspot_setup_prefs', JSON.stringify(prefs));
    }, options.setupPrefs);
  }
  await page.route('**/api/v1/recommendations/by-type', (route) => {
    const body = route.request().postDataJSON() as ByTypeBody;
    bodies.push(body);
    const picks = options.respond
      ? options.respond(body)
      : places.filter((place) => place.type === body.facility_type).slice(0, 1);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(picks.map(rec)) });
  });
  await page.goto('/main');
  return bodies;
}

const cardHeading = (page: Page, name: string) =>
  page.getByTestId('recommendation-card').getByRole('heading', { name, exact: true });

test('after a 음식점+카페 onboarding every category chip still ranks its own type', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const places: Place[] = [
    { id: 'r1', name: '황남 쌈밥', type: 'restaurant', meters: 200 },
    { id: 'c1', name: '먼 한옥카페', type: 'cafe', meters: 900 },        // 10분(667m) 밖 — 칩에서 처음부터 넓힌다
    { id: 'a1', name: '고분길 정원', type: 'attraction', meters: 400 },
    { id: 'u1', name: '신라 공예관', type: 'culture', meters: 600 },     // 직선으로는 안, 실제 걷는 길로는 밖
  ];
  const bodies = await openMain(page, places, {
    setupPrefs: {
      version: 2, categories: ['restaurant', 'cafe'], cuisine: '한식', maxWalkMinutes: 10,
      requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [],
    },
    // 서버는 걷는 길로 잰다 — 문화시설은 10분 제한이면 0곳, 제한을 풀면 한 곳.
    respond: (body) => places.filter((place) => place.type === body.facility_type
      && !(place.type === 'culture' && body.context?.max_walk_minutes)).slice(0, 1),
  });

  await expect(cardHeading(page, '황남 쌈밥')).toBeVisible({ timeout: 25_000 });

  await page.getByRole('button', { name: '관광지', exact: true }).click();
  await expect(cardHeading(page, '고분길 정원')).toBeVisible({ timeout: 25_000 });

  await page.getByRole('button', { name: '문화시설', exact: true }).click();
  await expect(cardHeading(page, '신라 공예관')).toBeVisible({ timeout: 25_000 });

  await page.getByRole('button', { name: '카페', exact: true }).click();
  await expect(cardHeading(page, '먼 한옥카페')).toBeVisible({ timeout: 25_000 });

  await expect(page.getByText('추천할 곳이 없어요')).toHaveCount(0);

  const ofType = (type: string) => bodies.filter((body) => body.facility_type === type);
  for (const type of ['restaurant', 'cafe', 'attraction', 'culture']) {
    expect(ofType(type).length, `${type} 요청`).toBeGreaterThan(0);
    for (const body of ofType(type)) expect(body.context?.categories, `${type} 요청의 categories`).toEqual([]);
  }
  // 도보 제한 안에 후보가 있는 칩은 제한 그대로 묻는다.
  expect(ofType('restaurant').every((body) => body.context?.max_walk_minutes === 10)).toBe(true);
  expect(ofType('attraction').every((body) => body.context?.max_walk_minutes === 10)).toBe(true);
  // 직선거리로 이미 빈 칩은 처음부터 제한 없이 묻는다.
  expect(ofType('cafe').every((body) => body.context?.max_walk_minutes == null)).toBe(true);
  // 서버가 0곳을 주면 한 번만 넓혀 다시 묻는다.
  expect(ofType('culture').some((body) => body.context?.max_walk_minutes === 10)).toBe(true);
  expect(ofType('culture').some((body) => body.context?.max_walk_minutes == null)).toBe(true);
});

test('♿ switches to the category that has barrier-free places, and an empty chip offers that category', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const places: Place[] = [
    { id: 'r1', name: '황남 쌈밥', type: 'restaurant', meters: 200 },
    { id: 'c1', name: '고요한 찻집', type: 'cafe', meters: 300 },
    { id: 'a1', name: '대릉원 산책길', type: 'attraction', meters: 400, barrierFree: true },
    { id: 'a2', name: '첨성대 꽃길', type: 'attraction', meters: 500, barrierFree: true },
    { id: 'u1', name: '신라 공예관', type: 'culture', meters: 600 },
  ];
  await openMain(page, places);
  await expect(cardHeading(page, '황남 쌈밥')).toBeVisible({ timeout: 25_000 });

  await page.getByRole('button', { name: '♿ 무장애' }).click();
  await expect(page.getByText('♿ 무장애 확인된 관광지 2곳을 보여드려요')).toBeVisible();
  await expect(cardHeading(page, '대릉원 산책길')).toBeVisible({ timeout: 25_000 });

  // ♿ 를 켠 채 무장애 확인 장소가 없는 칩으로 — '없어요' 대신 갈 칩을 고르는 카드 하나.
  await page.getByRole('button', { name: '음식점', exact: true }).click();
  const suggestion = page.getByTestId('category-suggestion');
  await expect(suggestion).toBeVisible({ timeout: 25_000 });
  await expect(suggestion).toContainText('♿ 무장애 확인 장소는 이쪽에 있어요');
  await expect(page.getByText(/없어요/)).toHaveCount(0);
  await suggestion.getByRole('button', { name: '관광지 2곳 보기' }).click();
  await expect(cardHeading(page, '대릉원 산책길')).toBeVisible({ timeout: 25_000 });
});

// 10-06 실측: 관광지에 무장애 핀은 있지만(원자료 3곳) 카드에 오를 곳이 없었다 — 카드도 제안도 토스트도 없는 빈 지도.
// 핀 수가 아니라 카드에 오를 수로 칩을 고르고, 그래도 어디에도 없으면 핀 수와 '지도에서 보기' 를 말한다.
test('♿ with barrier-free pins only beyond walking range moves to their category and says where they are', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const places: Place[] = [
    { id: 'r1', name: '황남 쌈밥', type: 'restaurant', meters: 200 },
    { id: 'a1', name: '먼 무장애 정원', type: 'attraction', meters: 3_000, barrierFree: true }, // 도보 20분(1,333m) 밖
  ];
  await openMain(page, places);
  await expect(cardHeading(page, '황남 쌈밥')).toBeVisible({ timeout: 25_000 });

  await page.getByRole('button', { name: '♿ 무장애' }).click();
  const suggestion = page.getByTestId('category-suggestion');
  await expect(suggestion).toBeVisible({ timeout: 25_000 });
  await expect(suggestion).toContainText('♿ 무장애 확인 장소 1곳이 지도에 있어요');
  await expect(suggestion.getByRole('button', { name: '지도에서 보기' })).toBeVisible();
  await expect(page.getByTestId('recommendation-card')).toHaveCount(0);
  await expect(page.getByText(/없어요/)).toHaveCount(0);
});

test('♿ whose category the server leaves empty still shows where the barrier-free places are', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const places: Place[] = [
    { id: 'r1', name: '황남 쌈밥', type: 'restaurant', meters: 200 },
    { id: 'a1', name: '대릉원 산책길', type: 'attraction', meters: 400, barrierFree: true },
  ];
  // 서버는 지금 관광지를 하나도 추천하지 않는다(밤·영업 판정 등) — 다른 칩에도 무장애 후보가 없다.
  await openMain(page, places, {
    respond: (body) => (body.facility_type === 'attraction' ? [] : places.filter((place) => place.type === body.facility_type)),
  });
  await expect(cardHeading(page, '황남 쌈밥')).toBeVisible({ timeout: 25_000 });

  await page.getByRole('button', { name: '♿ 무장애' }).click();
  await expect(page.getByText('♿ 무장애 확인된 관광지 1곳을 보여드려요')).toBeVisible();
  const suggestion = page.getByTestId('category-suggestion');
  await expect(suggestion).toBeVisible({ timeout: 25_000 });
  await expect(suggestion).toContainText('♿ 무장애 확인 장소 1곳이 지도에 있어요');
  await expect(suggestion.getByRole('button', { name: '지도에서 보기' })).toBeVisible();
  await expect(page.getByText(/없어요/)).toHaveCount(0);
});

for (const viewport of [{ width: 1536, height: 730 }, { width: 390, height: 844 }]) {
  test(`♿ is not offered when no place has verified barrier-free access (${viewport.width}px)`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    await openMain(page, [
      { id: 'r1', name: '황남 쌈밥', type: 'restaurant', meters: 200 },
      { id: 'a1', name: '고분길 정원', type: 'attraction', meters: 400 },
    ]);
    await expect(page.getByTestId('recommendation-card')).toBeVisible({ timeout: 25_000 });
    if (viewport.width < 768) {
      await page.getByRole('button', { name: '필터·편의' }).click();
      await expect(page.getByRole('heading', { name: '필터와 여행 편의' })).toBeVisible();
      await expect(page.getByRole('button', { name: /히트맵/ })).toBeVisible();
    } else {
      await expect(page.getByRole('button', { name: /히트맵/ })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: /무장애|배리어프리/ })).toHaveCount(0);
  });
}
