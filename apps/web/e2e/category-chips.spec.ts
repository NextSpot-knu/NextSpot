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

interface Place { id: string; name: string; type: string; meters: number; barrierFree?: boolean; stroller?: string }

function mapRow(place: Place) {
  return {
    id: place.id,
    name: place.name,
    type: place.type,
    latitude: NORTH_M(place.meters),
    longitude: CENTER.lng,
    capacity: 30,
    // TourAPI '유모차 대여 정보' 원문(chk_babycarriage) — 👶 조건의 근거(P1-6).
    features: place.stroller ? { chk_babycarriage: place.stroller } : {},
    barrier_free: place.barrierFree ?? null,
    congestion: null,
    operating_hours: { open: '24시간', closed: '연중무휴' },
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

interface ByTypeBody {
  facility_type: string;
  context?: { categories?: string[]; max_walk_minutes?: number | null; required_attributes?: string[] };
}

async function openMain(page: Page, places: Place[], options: {
  setupPrefs?: Record<string, unknown>;
  /** by-type 응답 — 기본은 그 유형의 첫 장소 하나. */
  respond?: (body: ByTypeBody) => Place[];
  /** true 면 그 요청을 422 로 거절한다 — 'stroller' 를 모르는 옛 API 흉내(P1-6 배포 시차). */
  reject?: (body: ByTypeBody) => boolean;
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
    if (options.reject?.(body)) {
      return route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ detail: [{ loc: ['body', 'context', 'required_attributes', 0], msg: 'Input should be indoor or accessible' }] }),
      });
    }
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

  await page.getByRole('button', { name: '♿ 휠체어' }).click();
  await expect(page.getByText('♿ 휠체어 편의가 확인된 관광지 2곳을 보여드려요')).toBeVisible();
  await expect(cardHeading(page, '대릉원 산책길')).toBeVisible({ timeout: 25_000 });

  // ♿ 를 켠 채 무장애 확인 장소가 없는 칩으로 — '없어요' 대신 갈 칩을 고르는 카드 하나.
  await page.getByRole('button', { name: '음식점', exact: true }).click();
  const suggestion = page.getByTestId('category-suggestion');
  await expect(suggestion).toBeVisible({ timeout: 25_000 });
  await expect(suggestion).toContainText('♿ 휠체어 편의가 확인된 곳은 이쪽에 있어요');
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

  await page.getByRole('button', { name: '♿ 휠체어' }).click();
  const suggestion = page.getByTestId('category-suggestion');
  await expect(suggestion).toBeVisible({ timeout: 25_000 });
  await expect(suggestion).toContainText('♿ 휠체어 편의가 확인된 1곳이 지도에 있어요');
  await expect(suggestion.getByRole('button', { name: '지도에서 보기' })).toBeVisible();
  await expect(page.getByTestId('recommendation-card')).toHaveCount(0);
  await expect(page.getByText(/없어요/)).toHaveCount(0);
});

// 계획 B2: 서버가 200 [] 을 주면 즉시 계산한 카드를 바로 띄운다 — 무장애 확인 장소가 걸어서 갈 거리에 있으면 그곳이 카드다
// (예전에는 '지도에 있어요' 제안 카드만 떴다).
test('♿ whose category the server leaves empty still opens the barrier-free place as a card', async ({ page }) => {
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

  await page.getByRole('button', { name: '♿ 휠체어' }).click();
  await expect(page.getByText('♿ 휠체어 편의가 확인된 관광지 1곳을 보여드려요')).toBeVisible();
  await expect(cardHeading(page, '대릉원 산책길')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('recommendation-card').getByRole('button', { name: '휠체어 조건 해제' })).toBeVisible();
  await expect(page.getByTestId('category-suggestion')).toHaveCount(0);
  // 카드의 '다시 안볼래요' 버튼과 별개로 카테고리 전환을 확인한다.
  await expect(page.getByText(/(?<!관심 )없어요/)).toHaveCount(0);
});

// P1-6 — 👶 유모차는 ♿ 휠체어와 따로 켠다. 켜면 서버에 'stroller' 조건이 실려 가고, 지금 칩에 유모차 편의가 확인된 곳이
// 없으면 그런 곳이 있는 칩으로 옮겨 그 사실을 말한다. 휠체어 확인만 있는 곳은 유모차 조건을 채우지 못한다.
test('👶 is its own condition: it moves to the category with stroller-friendly places and asks the server for it', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const places: Place[] = [
    { id: 'r1', name: '황남 쌈밥', type: 'restaurant', meters: 200, barrierFree: true },
    { id: 'u1', name: '신라 역사관', type: 'culture', meters: 400, stroller: '가능' },
  ];
  const bodies = await openMain(page, places);
  await expect(cardHeading(page, '황남 쌈밥')).toBeVisible({ timeout: 25_000 });

  await page.getByRole('button', { name: '👶 유모차' }).click();
  await expect(page.getByText('👶 유모차 편의가 확인된 문화시설 1곳을 보여드려요')).toBeVisible();
  await expect(cardHeading(page, '신라 역사관')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('recommendation-card').getByRole('button', { name: '유모차 조건 해제' })).toBeVisible();
  await expect.poll(() => bodies.some((body) => JSON.stringify(body.context ?? {}).includes('"stroller"'))).toBe(true);
});

// 배포 시차(P1-6 · 라운드 2): 웹이 먼저 배포되면 'stroller' 를 모르는 옛 API 가 422 를 준다. 빈 카드·오류로 끝내지 않고
// 그 조건만 빼고 한 번 다시 묻고(결과는 화면이 유모차 판정으로 거른다), 같은 세션의 다음 요청은 처음부터 빼고 묻는다.
test('👶 against an API that rejects "stroller" retries once without it and keeps the card', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const places: Place[] = [
    { id: 'r1', name: '황남 쌈밥', type: 'restaurant', meters: 200 },
    { id: 'u0', name: '가까운 미술관', type: 'culture', meters: 150 },
    { id: 'u1', name: '신라 역사관', type: 'culture', meters: 400, stroller: '가능' },
  ];
  const asksStroller = (body: ByTypeBody) => (body.context?.required_attributes ?? []).includes('stroller');
  const bodies = await openMain(page, places, {
    reject: asksStroller,
    respond: (body) => places.filter((place) => place.type === body.facility_type),
  });
  await expect(cardHeading(page, '황남 쌈밥')).toBeVisible({ timeout: 25_000 });

  await page.getByRole('button', { name: '👶 유모차' }).click();
  await expect(cardHeading(page, '신라 역사관')).toBeVisible({ timeout: 25_000 });
  // 지도 카드의 요청만 센다 — 대기 보드 프리페치(api-client prefetchDemoHotPaths)는 여행 조건 없이 같은 경로를 부른다.
  const culture = () => bodies.filter((body) => body.facility_type === 'culture' && body.context);
  expect(culture().filter(asksStroller)).toHaveLength(1); // 한 번 거절당하고
  expect(culture().some((body) => !asksStroller(body))).toBe(true); // 빼고 다시 물었다

  // 다른 칩에 다녀와도 다시 422 를 받지 않는다 — 이 세션은 처음부터 빼고 묻는다.
  await page.getByRole('button', { name: '음식점', exact: true }).click();
  await page.getByRole('button', { name: '문화시설', exact: true }).click();
  await expect(cardHeading(page, '신라 역사관')).toBeVisible({ timeout: 25_000 });
  await expect.poll(() => culture().length).toBeGreaterThan(2);
  expect(bodies.filter(asksStroller)).toHaveLength(1);
});

// ♿ 와 같은 규칙(라운드 2): 👶 를 켰는데 카드에 오를 곳이 없으면(전부 걸어갈 거리 밖) 빈 지도로 두지 않고 핀이 있는 칩으로
// 옮겨 '지도에 N곳' 과 '지도에서 보기' 를 말한다.
test('👶 with stroller-friendly pins only beyond walking range says where they are', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const places: Place[] = [
    { id: 'r1', name: '황남 쌈밥', type: 'restaurant', meters: 200 },
    { id: 'u1', name: '먼 어린이 박물관', type: 'culture', meters: 3_000, stroller: '가능' }, // 도보 20분(1,333m) 밖
  ];
  await openMain(page, places);
  await expect(cardHeading(page, '황남 쌈밥')).toBeVisible({ timeout: 25_000 });

  await page.getByRole('button', { name: '👶 유모차' }).click();
  const suggestion = page.getByTestId('category-suggestion');
  await expect(suggestion).toBeVisible({ timeout: 25_000 });
  await expect(suggestion).toContainText('👶 유모차 편의가 확인된 1곳이 지도에 있어요');
  await expect(suggestion.getByRole('button', { name: '지도에서 보기' })).toBeVisible();
  await expect(page.getByTestId('recommendation-card')).toHaveCount(0);
});

// 👶 를 설정 화면에서 켜 두었는데 유모차 편의가 확인된 곳이 하나도 없다 — 칩도 카드도 없는 빈 지도 대신 그 사실과
// '유모차 조건 끄기' 를 준다. 끄면 카드가 바로 돌아온다.
test('👶 from setup with no stroller-friendly place anywhere says so and offers to turn it off', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  await openMain(page, [{ id: 'r1', name: '황남 쌈밥', type: 'restaurant', meters: 200 }], {
    setupPrefs: {
      version: 2, categories: ['restaurant'], requiredAttributes: ['stroller'], excludeVisited: false, visitedFacilityIds: [],
    },
  });
  const suggestion = page.getByTestId('category-suggestion');
  await expect(suggestion).toBeVisible({ timeout: 25_000 });
  await expect(suggestion.getByTestId('stroller-none')).toHaveText('👶 유모차 편의가 확인된 곳을 아직 찾지 못했어요');
  await suggestion.getByRole('button', { name: '유모차 조건 끄기' }).click();
  await expect(cardHeading(page, '황남 쌈밥')).toBeVisible({ timeout: 25_000 });
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
    await expect(page.getByRole('button', { name: /휠체어|무장애|배리어프리/ })).toHaveCount(0);
    // 유모차 대여 정보도 없으면 👶 칩도 없다(P1-6 — 늘 빈 지도가 되는 칩은 두지 않는다).
    await expect(page.getByRole('button', { name: /유모차/ })).toHaveCount(0);
  });
}
