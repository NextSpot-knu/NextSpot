import { expect, test, type Locator, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';
import { openCardDetails } from './support/recCard';

// 경주시 사진은 '사진: 경주시' 줄과 함께만 보인다(PM 규칙 2026-09-29).
// 적재 배치는 사진 없는 음식점에만 경주시 사진을 gallery_images 에 넣고, 출처를 features.city_photo 에 둔다
// ({url, provider:'경주시', source_url, license} — image_source 는 Wikimedia 전용). 출처 줄은 '지금 보이는 사진' 이
// city_photo.url 과 같을 때만, 그리고 그 사진이 보인 뒤에만 뜬다(표지 아래·다른 사진 아래에는 없다).
// 사진 서버(visitkorea·gyeongju.go.kr)는 스텁한다 — 외부 네트워크 없이, 경주시 사진을 붙잡았다 풀 수 있게.

test.beforeEach(async ({ page }, testInfo) => {
  testInfo.setTimeout(90_000); // /main·/waiting 첫 컴파일(Windows dev server) 여유
  await stubExternalServices(page);
});

const CITY_PHOTO = 'https://www.gyeongju.go.kr/upload/content/thumb/20240101/e2e_city_menu_1.jpg';
const CITY_OTHER = 'https://www.gyeongju.go.kr/upload/content/thumb/20240101/e2e_city_menu_2.jpg';
const TOUR_PHOTO = 'https://tong.visitkorea.or.kr/cms/resource/01/e2e_ok_image2_1.jpg';
const CITY_SOURCE = 'https://www.gyeongju.go.kr/tour/';
const LINE = { ko: '사진: 경주시', en: 'Photo: Gyeongju City' } as const;
type Locale = keyof typeof LINE;

/** 적재 배치가 쓰는 모양 그대로(snake_case — API 응답을 apiClient 가 camel 로 바꾼다). */
const cityCredit = (url = CITY_PHOTO) => ({
  url,
  provider: '경주시',
  source_url: CITY_SOURCE,
  license: '공공데이터포털 15114465 경주시_경주문화관광_메뉴별음식점 · 이용허락범위 제한 없음',
  con_uid: 101,
});

function photoSvg(label: string, fill: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300">`
    + `<rect width="600" height="300" fill="${fill}"/>`
    + `<text x="300" y="165" font-family="sans-serif" font-size="44" font-weight="700" fill="#fff" text-anchor="middle">${label}</text>`
    + `</svg>`;
}

/** 사진 서버 스텁. 경주시 사진은 release() 까지 붙잡아 둔다 — 받는 동안에는 출처 줄이 보이면 안 된다. */
async function stubPhotoHosts(page: Page): Promise<{ release: () => void; requested: Promise<void> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markRequested!: () => void;
  const requested = new Promise<void>((resolve) => { markRequested = resolve; });
  await page.route('**://www.gyeongju.go.kr/upload/**', async (route) => {
    markRequested();
    await gate;
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: photoSvg('Gyeongju City photo', '#8a4b2a') });
  });
  await page.route('**://tong.visitkorea.or.kr/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: photoSvg('TourAPI photo', '#2f6b5a') }),
  );
  return { release, requested };
}

type Fixture = {
  id: string;
  name: string;
  image_url: string | null;
  gallery_images: string[] | null;
  features: Record<string, unknown>;
};

function facilityRow(f: Fixture, index: number) {
  return {
    ...f,
    type: 'restaurant',
    latitude: 35.8363 + index * 0.0002,
    longitude: 129.2107,
    capacity: 30,
    congestion: null,
    operating_hours: { open: '24시간', closed: '연중무휴' },
  };
}

function recommendation(f: ReturnType<typeof facilityRow>, rank: number, total: number) {
  return {
    recommendation_id: `rec-${f.id}`,
    facility: f,
    spot_score: 0.8 - rank * 0.01,
    breakdown: { preference: 0.8, wait_time: null, travel_time: rank, incentive: 0 },
    distance_m: 80 + rank * 10,
    reason: '테스트 추천', reason_source: 'template',
    congestion_level: null, congestion_source: 'none', congestion_log_source: null,
    congestion_is_stale: null, congestion_timestamp: null,
    rank, total_candidates: total, open_status_at_arrival: 'open_expected',
    information_confidence: 'verified', eligibility_tier: 'verified_open_route',
    place_data_source: 'test', data_updated_at: null,
    scoring_mode: 'degraded_rules', model_version: null, prediction_source: 'unavailable',
  };
}

/** /main·/waiting·/explore 가 부르는 API 를 고정한다. */
async function mockPlaces(page: Page, fixtures: Fixture[], locale: Locale) {
  const photos = await stubPhotoHosts(page);
  await page.addInitScript((loc) => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    localStorage.setItem('nextspot_locale', loc);
    localStorage.setItem('nextspot_theme', 'light');
  }, locale);
  const rows = fixtures.map(facilityRow);
  const items = rows.map((row, i) => recommendation(row, i + 1, rows.length));
  await page.route('**/rest/v1/**', async (route) => {
    if (route.request().url().includes('/facilities')) {
      // /explore 의 원래 장소(.single() — 객체 한 개)와, 느린 러너에서 API 가 늦을 때 /main 이 쓰는 Supabase 직접
      // 읽기(배열)를 둘 다 같은 장소로 답한다 — 폴백으로 넘어가도 같은 카드가 뜬다.
      const single = (route.request().headers()['accept'] ?? '').includes('vnd.pgrst.object');
      const body = single
        ? { id: 'origin-r', name: '황리단길 식당', type: 'restaurant', features: {}, congestion_logs: [] }
        : rows;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    return route.fulfill({ status: 200, headers: { 'content-range': '0-0/1' }, body: '[]' });
  });
  await page.route('**/api/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/api/v1/infrastructures')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    }
    if (pathname.endsWith('/api/v1/recommendations/by-type')) {
      // 보드는 유형마다 부른다 — 식당 섹터에만 싣는다(다른 섹터에 같은 카드가 겹치지 않게).
      const requestedType = String((route.request().postDataJSON() as { facility_type?: string }).facility_type ?? 'restaurant');
      const body = requestedType === 'restaurant' ? items : [];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (pathname.endsWith('/api/v1/recommendations')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  return photos;
}

const loaded = (img: Locator) => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0);
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const locale of ['ko', 'en'] as const) {
  test(`main card (${locale}): a city photo shows its source line only once the photo is visible`, async ({ page }) => {
    const photos = await mockPlaces(page, [{
      id: 'city-main', name: '황남 칼국수', image_url: null, gallery_images: [CITY_PHOTO],
      features: { city_photo: cityCredit() },
    }], locale);
    await page.goto('/main');
    await expect(page.getByText('황남 칼국수').first()).toBeVisible({ timeout: 20_000 });
    await openCardDetails(page, locale); // 390px — 미리보기를 펼친 뒤 상세를 연다

    const photo = page.locator(`img[src="${CITY_PHOTO}"]`);
    await photo.scrollIntoViewIfNeeded(); // loading="lazy" — 화면에 들어와야 받는다
    await photos.requested;
    const line = page.getByText(LINE[locale], { exact: true });
    // 사진을 받는 동안에는 출처 줄이 보이지 않는다.
    await expect(line).toBeHidden();

    photos.release();
    await expect.poll(() => loaded(photo)).toBe(true);
    await expect(line).toBeVisible();
    const link = page.getByRole('link', { name: LINE[locale] });
    await expect(link).toHaveAttribute('href', CITY_SOURCE);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // 사진 바로 아래 한 줄(24px 상자) — Wikimedia 출처 링크는 없다.
    const [photoBox, lineBox] = await Promise.all([photo.boundingBox(), link.boundingBox()]);
    expect(lineBox!.height).toBeLessThanOrEqual(24);
    expect(lineBox!.y).toBeGreaterThanOrEqual(photoBox!.y + photoBox!.height - 2);
    expect(lineBox!.y).toBeLessThanOrEqual(photoBox!.y + photoBox!.height + 4);
    await expect(page.locator('a[href^="https://commons.wikimedia.org/"]')).toHaveCount(0);
    await expect.poll(() => noHorizontalScroll(page)).toBeLessThanOrEqual(1);
  });

  test(`main card (${locale}): a TourAPI photo carries no city source line`, async ({ page }) => {
    const photos = await mockPlaces(page, [{
      // 경주시 출처가 남아 있어도(그 사진은 갤러리 뒤쪽) 보이는 사진은 TourAPI 대표 사진이다.
      id: 'tour-main', name: '교동 한정식', image_url: TOUR_PHOTO, gallery_images: [CITY_PHOTO],
      features: { city_photo: cityCredit() },
    }], locale);
    photos.release();
    await page.goto('/main');
    await expect(page.getByText('교동 한정식').first()).toBeVisible({ timeout: 20_000 });
    await openCardDetails(page, locale); // 390px — 미리보기를 펼친 뒤 상세를 연다

    const photo = page.locator(`img[src="${TOUR_PHOTO}"]`);
    await photo.scrollIntoViewIfNeeded();
    await expect.poll(() => loaded(photo)).toBe(true);
    await expect(page.getByText(LINE[locale], { exact: true })).toHaveCount(0);
    await expect(page.locator(`a[href="${CITY_SOURCE}"]`)).toHaveCount(0);
  });

  test(`waiting board (${locale}): the city line follows the photo each card actually shows`, async ({ page }) => {
    const photos = await mockPlaces(page, [
      { // 사진이 경주시 사진뿐 — 그 사진이 보인 뒤에 출처 줄.
        id: 'board-city', name: '경주시사진 식당', image_url: null, gallery_images: [CITY_PHOTO],
        features: { city_photo: cityCredit() },
      },
      { // TourAPI 대표 사진이 보인다 — 경주시 출처 줄이 없다.
        id: 'board-tour', name: '대표사진 식당', image_url: TOUR_PHOTO, gallery_images: null, features: {},
      },
      { // 출처와 짝이 아닌 경주시 사진 — 띄우지 않는다(표지).
        id: 'board-unpaired', name: '짝없음 식당', image_url: null, gallery_images: [CITY_OTHER],
        features: { city_photo: cityCredit(CITY_PHOTO) },
      },
    ], locale);
    // 붙잡힌 경주시 사진은 첫 섹터의 먼저 받는(eager) 사진이라 window load 를 막는다 — load 를 기다리지 않는다.
    await page.goto('/waiting', { waitUntil: 'domcontentloaded' });
    const cell = (name: string) => page.locator('div.grid-rows-\\[1fr_auto\\]').filter({ hasText: name });
    await expect(cell('경주시사진 식당')).toBeVisible({ timeout: 30_000 });
    await photos.requested;
    const cityImg = cell('경주시사진 식당').locator('img');
    await expect(cityImg).toHaveAttribute('src', CITY_PHOTO);
    // 받는 동안: 표지가 보이고 출처 줄은 없다.
    await expect(page.getByText(LINE[locale], { exact: true })).toHaveCount(0);

    photos.release();
    await expect.poll(() => loaded(cityImg)).toBe(true);
    const line = cell('경주시사진 식당').getByText(LINE[locale], { exact: true });
    await expect(line).toBeVisible();
    await expect(cell('경주시사진 식당').getByRole('link', { name: LINE[locale] })).toHaveAttribute('href', CITY_SOURCE);

    const tourImg = cell('대표사진 식당').locator('img');
    await expect(tourImg).toHaveAttribute('src', TOUR_PHOTO);
    await expect.poll(() => loaded(tourImg)).toBe(true);
    await expect(cell('대표사진 식당').getByText(LINE[locale], { exact: true })).toHaveCount(0);

    await expect(cell('짝없음 식당').locator('img')).toHaveCount(0);
    await expect(page.getByText(LINE[locale], { exact: true })).toHaveCount(1);

    // 출처 줄은 카드 아래(8px 이상 띄워) 한 줄, 가로 넘침 없음.
    const [cardBox, lineBox] = await Promise.all([
      cell('경주시사진 식당').getByRole('button').first().boundingBox(),
      cell('경주시사진 식당').getByRole('link', { name: LINE[locale] }).boundingBox(),
    ]);
    expect(lineBox!.y - (cardBox!.y + cardBox!.height)).toBeGreaterThanOrEqual(8);
    expect(lineBox!.height).toBeLessThanOrEqual(24);
    await expect.poll(() => noHorizontalScroll(page)).toBeLessThanOrEqual(1);
  });
}

/** 글자가 상자 안에 다 보이는가(말줄임·잘림 없음) — 줄 글자 span 의 scrollWidth ≤ clientWidth. */
const textFits = (line: Locator) =>
  line.evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight + 1);

test('waiting board (en, 320px): the city line is never cut off on the narrowest phones', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const photos = await mockPlaces(page, [
    { id: 'narrow-city', name: '경주시사진 식당', image_url: null, gallery_images: [CITY_PHOTO], features: { city_photo: cityCredit() } },
    { id: 'narrow-tour', name: '대표사진 식당', image_url: TOUR_PHOTO, gallery_images: null, features: {} },
    { id: 'narrow-plain', name: '표지 식당', image_url: null, gallery_images: null, features: {} },
  ], 'en');
  photos.release();
  await page.goto('/waiting', { waitUntil: 'domcontentloaded' });
  const cell = page.locator('div.grid-rows-\\[1fr_auto\\]').filter({ hasText: '경주시사진 식당' });
  const line = cell.getByText(LINE.en, { exact: true });
  await expect(line).toBeVisible({ timeout: 30_000 });
  // 말줄임 없이 전부 보인다(폭이 모자라면 낱말 단위로 접힌다) — 출처 자리(min-h-9 pt-2) 안에 담긴다.
  await expect.poll(() => textFits(line)).toBe(true);
  const [lineBox, slotBox] = await Promise.all([
    cell.getByRole('link', { name: LINE.en }).boundingBox(),
    cell.locator(':scope > div').last().boundingBox(),
  ]);
  expect(lineBox!.y + lineBox!.height).toBeLessThanOrEqual(slotBox!.y + slotBox!.height + 1);
  await expect.poll(() => noHorizontalScroll(page)).toBeLessThanOrEqual(1);
});

test('waiting board: a city line lines up with the Wikimedia credit under the next card', async ({ page }) => {
  const WIKI_PHOTO = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Seokguram.jpg/1200px-Seokguram.jpg';
  const photos = await mockPlaces(page, [
    { id: 'align-city', name: '경주시사진 식당', image_url: null, gallery_images: [CITY_PHOTO], features: { city_photo: cityCredit() } },
    {
      id: 'align-wiki', name: '위키사진 식당', image_url: null, gallery_images: [WIKI_PHOTO],
      features: {
        image_source: {
          provider: 'Wikimedia Commons', source_url: 'https://commons.wikimedia.org/wiki/File:Seokguram.jpg',
          license: 'CC BY-SA 4.0', artist: 'Very Long Artist Name For Alignment',
        },
      },
    },
  ], 'ko');
  await page.route('**://upload.wikimedia.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: photoSvg('Wikimedia photo', '#7a5c2e') }),
  );
  photos.release();
  await page.goto('/waiting', { waitUntil: 'domcontentloaded' });
  const cell = (name: string) => page.locator('div.grid-rows-\\[1fr_auto\\]').filter({ hasText: name });
  const cityLine = cell('경주시사진 식당').getByText(LINE.ko, { exact: true });
  const wikiLink = cell('위키사진 식당').locator('a[href^="https://commons.wikimedia.org/"]');
  await expect(cityLine).toBeVisible({ timeout: 30_000 });
  await expect(wikiLink).toBeVisible();
  // 두 카드는 같은 줄 — 출처 첫 줄의 글자 위치가 같은 높이다.
  const [cityBox, wikiBox] = await Promise.all([cityLine.boundingBox(), wikiLink.locator('span').first().boundingBox()]);
  expect(Math.abs(cityBox!.y - wikiBox!.y)).toBeLessThanOrEqual(1);
});

test('explore: a city gallery photo shows its source line after it is visible; a TourAPI photo shows none', async ({ page }) => {
  const photos = await mockPlaces(page, [
    { id: 'exp-city', name: '경주시사진 식당', image_url: null, gallery_images: [CITY_PHOTO], features: { city_photo: cityCredit() } },
    { id: 'exp-tour', name: '대표사진 식당', image_url: TOUR_PHOTO, gallery_images: [CITY_PHOTO], features: { city_photo: cityCredit() } },
  ], 'ko');
  await page.goto('/explore/recommend?facilityId=origin-r&lat=35.838&lng=129.209');
  await expect(page.locator('section.space-y-4 h4')).toHaveText(['경주시사진 식당', '대표사진 식당'], { timeout: 30_000 });
  const card = (name: string) => page.locator('section.space-y-4 > div').filter({ has: page.locator('h4', { hasText: name }) });

  await card('경주시사진 식당').scrollIntoViewIfNeeded();
  await photos.requested;
  const cityImg = card('경주시사진 식당').locator('img');
  await expect(cityImg).toHaveAttribute('src', CITY_PHOTO);
  const line = card('경주시사진 식당').getByText(LINE.ko, { exact: true });
  await expect(line).toBeHidden();

  photos.release();
  await expect.poll(() => loaded(cityImg)).toBe(true);
  await expect(line).toBeVisible();

  await card('대표사진 식당').scrollIntoViewIfNeeded();
  const tourImg = card('대표사진 식당').locator('img');
  await expect(tourImg).toHaveAttribute('src', TOUR_PHOTO);
  await expect.poll(() => loaded(tourImg)).toBe(true);
  await expect(card('대표사진 식당').getByText(LINE.ko, { exact: true })).toHaveCount(0);
});
