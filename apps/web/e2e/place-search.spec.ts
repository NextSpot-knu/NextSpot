import { expect, test, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';
import { stubMain, type E2eLocale } from './support/mainStubs';
import { stubFakeKakaoMap, type KakaoFakeWindow } from './support/fakeKakaoMap';

// 검색 결과는 검색창 바로 아래, 목록마다 출처 한 줄(계획 A7).
//   · 우리 지도에도 Kakao 에도 없는 이름(골굴사)은 관광공사(TourAPI) 목록으로 — 사진 · '지도에서 보기'(임시 핀) ·
//     '카카오맵 길찾기' 를 주고, 기능설명서 그대로의 '다음 배치 추가 요청' 은 작은 보조 버튼이다.
//   · Kakao 목록(맛집·카페)에는 '출처: 카카오맵' 과 카카오맵 장소 링크.
//   · 검색하는 동안 날씨·첫 방문 카드는 감춘다 — 날씨 카드는 마운트된 채라 날씨를 다시 부르지 않는다.

// 외부로 나가는 호출을 전부 막는다 — 지도 SDK 와 Supabase 인증(support/stubs.ts).
test.beforeEach(async ({ page }) => stubExternalServices(page));

const GOLGULSA = {
  contentid: '127693',
  title: '골굴사(경주)',
  addr1: '경상북도 경주시 양북면 기림로 101-5',
  mapx: 129.3529,
  mapy: 35.8064,
  contenttypeid: 12,
  firstimage: 'https://tong.visitkorea.example/golgulsa.png',
};

// 1×1 PNG — 썸네일이 실제로 그려지는지(naturalWidth) 보려고 진짜 이미지를 준다.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const FACILITIES = [
  {
    id: 'r1', name: '황남 쌈밥', type: 'restaurant', latitude: 35.8372, longitude: 129.2095, capacity: 30,
    features: {}, congestion: null, operating_hours: { open: '00:00~23:59', closed: '연중무휴' },
  },
];

function recFor(type: string) {
  return FACILITIES.filter((f) => f.type === type).map((facility) => ({
    recommendation_id: `rec-${facility.id}`,
    facility,
    spot_score: 0.7,
    distance_m: 110,
    rank: 1,
    total_candidates: 1,
    reason: '고정 추천 사유',
    reason_source: 'template',
    congestion_level: null,
    congestion_source: 'none',
    open_status_at_arrival: 'open_expected',
    scoring_mode: 'degraded_rules',
    prediction_source: 'unavailable',
    breakdown: { preference: 0.7, wait_time: null, travel_time: 2, incentive: 0 },
  }));
}

interface SearchStubs {
  kakao?: unknown[];
  tourApi?: unknown[];
}

async function openMain(page: Page, locale: E2eLocale, stubs: SearchStubs) {
  const counts = { weather: 0, keyword: 0, ingest: 0 };
  await stubMain(page, { locale, facilities: FACILITIES, byType: recFor });
  await stubFakeKakaoMap(page);
  await page.route('**/api/v1/weather', (route) => {
    counts.weather += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      source: 'kma',
      current: { at: new Date().toISOString(), temperature_c: 22, sky: 1, precipitation_type: 0, precipitation_probability: 10, wind_speed_mps: 1 },
      forecasts: [],
      indoor_recommended: false,
    }) });
  });
  await page.route('**/api/v1/search/places**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: stubs.kakao ?? [] }) }),
  );
  await page.route('**/api/v1/search/keyword**', (route) => {
    counts.keyword += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: stubs.tourApi ?? [], source: 'tourapi' }) });
  });
  await page.route('**/api/v1/search/ingest-request', (route) => {
    counts.ingest += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"pending"}' });
  });
  await page.route('https://tong.visitkorea.example/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX }),
  );
  await page.goto('/main');
  await expect(page.getByTestId('recommendation-card')).toBeVisible({ timeout: 25_000 });
  return counts;
}

const PLACEHOLDER: Record<E2eLocale, string> = {
  ko: '경주 장소·메뉴·분위기 검색',
  en: 'Search Gyeongju places, menus or vibes',
  ja: '慶州の施設・メニュー・雰囲気を検索',
  zh: '搜索庆州的地点、菜单或氛围',
};
const TOUR_SOURCE: Record<E2eLocale, string> = {
  ko: '출처: ⓒ한국관광공사',
  en: 'Source: ⓒ Korea Tourism Organization',
  ja: '出典: ⓒ韓国観光公社',
  zh: '来源：ⓒ韩国旅游发展局',
};
const INGEST: Record<E2eLocale, string> = {
  ko: '다음 배치 추가 요청',
  en: 'Request in the next update',
  ja: '次回の更新で追加をリクエスト',
  zh: '申请在下次更新时添加',
};

for (const viewport of [{ width: 1536, height: 730 }, { width: 390, height: 844 }]) {
  test(`a TourAPI hit sits right under the search box with photo, pin and Kakao directions (${viewport.width}px)`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    const counts = await openMain(page, 'ko', { tourApi: [GOLGULSA] });

    // 날씨·첫 방문 카드가 먼저 떠 있다.
    const weather = page.getByText('지금 경주 22℃');
    const firstTimer = page.getByRole('button', { name: /경주가 처음이라면/ });
    await expect(weather).toBeVisible({ timeout: 25_000 });
    await expect(firstTimer).toBeVisible();
    const weatherCallsBefore = counts.weather;

    const search = page.getByPlaceholder(PLACEHOLDER.ko);
    await search.fill('골굴사');
    const block = page.getByTestId('tourapi-search-results');
    await expect(block.getByText('골굴사(경주)')).toBeVisible({ timeout: 20_000 });

    // 결과 블록은 검색창 바로 아래(16px 이내) — 날씨·첫 방문 카드는 검색하는 동안 감춘다.
    await expect(weather).toBeHidden();
    await expect(firstTimer).toBeHidden();
    const bar = await search.locator('xpath=..').boundingBox();
    const box = await block.boundingBox();
    expect(bar && box).toBeTruthy();
    expect(box!.y - (bar!.y + bar!.height)).toBeLessThanOrEqual(16);
    expect(box!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height);

    // 출처 줄과 제목.
    await expect(block).toContainText('경주 장소 검색 결과');
    await expect(block.getByText(TOUR_SOURCE.ko, { exact: true })).toBeVisible();
    await expect(block).not.toContainText('바로 안내해 드릴 수 있어요');

    // 48px 대표 사진이 실제로 그려진다.
    const thumb = block.locator('img');
    await expect(thumb).toBeVisible();
    expect(await thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    const thumbBox = await thumb.boundingBox();
    expect(Math.round(thumbBox!.width)).toBe(48);

    // 카카오맵 길찾기 — 새 창, 이름·좌표가 실린 /link/to/.
    const route = block.getByRole('link', { name: '카카오맵 길찾기' });
    await expect(route).toHaveAttribute('target', '_blank');
    const href = await route.getAttribute('href');
    expect(href).toContain('map.kakao.com/link/to/');
    expect(href).toBe(`https://map.kakao.com/link/to/${encodeURIComponent('골굴사(경주)')},35.8064,129.3529`);

    // 지도에서 보기 — 지도에 그 이름의 핀과 이름표가 생긴다.
    await block.getByRole('button', { name: '지도에서 보기' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as KakaoFakeWindow).__kakaoFake.markers()))
      .toContain('골굴사(경주)');
    expect(await page.evaluate(() => (window as unknown as KakaoFakeWindow).__kakaoFake.labels())).toContain('골굴사(경주)');

    // 다음 배치 추가 요청 — 보조 버튼, 누르면 접수됨으로 잠긴다. 기능설명서가 이름으로 부르는 단계라 깨알 글씨가
    // 아니라 옆 버튼과 같은 알약(테두리 · 11px 이상)으로 보인다.
    const ingest = block.getByRole('button', { name: INGEST.ko });
    const look = await ingest.evaluate((el) => {
      const style = getComputedStyle(el);
      return { fontSize: parseFloat(style.fontSize), border: parseFloat(style.borderTopWidth) };
    });
    expect(look.fontSize).toBeGreaterThanOrEqual(11);
    expect(look.border).toBeGreaterThan(0);
    await ingest.click();
    await expect(block.getByRole('button', { name: '요청 접수됨' })).toBeDisabled();
    expect(counts.ingest).toBe(1);

    // 검색을 지우면 날씨·첫 방문 카드가 돌아온다 — 날씨는 다시 부르지 않는다(마운트 유지).
    await page.getByRole('button', { name: '검색 지우기' }).click();
    await expect(weather).toBeVisible();
    await expect(firstTimer).toBeVisible();
    expect(counts.weather).toBe(weatherCallsBefore);
  });
}

test('Kakao results are labelled restaurants & cafés with a Kakao Map source and place link', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1536, height: 730 });
  const counts = await openMain(page, 'ko', {
    kakao: [{
      place_id: 'k1', name: '황남 맥주집', type: 'restaurant', latitude: 35.8371, longitude: 129.2101,
      address: '경북 경주시 포석로 1050', place_url: 'https://place.map.kakao.com/987654', category_name: '음식점 > 술집',
    }],
  });
  await page.getByPlaceholder(PLACEHOLDER.ko).fill('황남 맥주');
  const block = page.getByTestId('place-search-results');
  await expect(block.getByText('황남 맥주집')).toBeVisible({ timeout: 20_000 });
  await expect(block).toContainText('맛집·카페 검색 결과');
  await expect(block.getByText('출처: 카카오맵', { exact: true })).toBeVisible();
  await expect(block).not.toContainText('경주 전체 장소 검색');
  await expect(block.getByRole('link', { name: '카카오맵', exact: true })).toHaveAttribute('href', 'https://place.map.kakao.com/987654');
  // Kakao 에서 찾았으면 관광공사 목록은 묻지 않는다.
  expect(counts.keyword).toBe(0);
});

for (const locale of ['en', 'ja', 'zh'] as const) {
  test(`${locale}: TourAPI results carry the localized source credit and request label`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1536, height: 730 });
    await openMain(page, locale, { tourApi: [GOLGULSA] });
    await page.getByPlaceholder(PLACEHOLDER[locale]).fill('골굴사');
    const block = page.getByTestId('tourapi-search-results');
    await expect(block.getByText('골굴사(경주)')).toBeVisible({ timeout: 20_000 });
    await expect(block.getByText(TOUR_SOURCE[locale], { exact: true })).toBeVisible();
    await expect(block.getByRole('button', { name: INGEST[locale] })).toBeVisible();
  });
}
