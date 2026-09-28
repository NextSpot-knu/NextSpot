import { expect, test, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// Wikimedia 사진(CC BY/BY-SA)은 출처와 함께만 보이고, 출처는 그 사진 아래에만 붙는다(PM 규칙 2026-09-28).
// 적재 배치는 Wikimedia 대체 사진을 gallery_images 에만 넣고 출처를 features.image_source 에 둔다 —
// 화면은 [대표(TourAPI), ...갤러리] 순으로 사진을 시도하므로, 출처는 '지금 보이는 사진' 을 따라가야 한다.
// 사진 서버(visitkorea·wikimedia)는 스텁한다: 외부 네트워크 없이, 대표 사진이 깨지는 경우도 결정적으로.

test.beforeEach(async ({ page }) => stubExternalServices(page));

const WIKI_PHOTO = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Seokguram.jpg/1200px-Seokguram.jpg';
const TOUR_PHOTO = 'https://tong.visitkorea.or.kr/cms/resource/01/e2e_ok_image2_1.jpg';
const TOUR_BROKEN = 'https://tong.visitkorea.or.kr/cms/resource/02/e2e_broken_image2_1.jpg';

const credit = (file: string, artist: string, license = 'CC BY-SA 4.0') => ({
  provider: 'Wikimedia Commons',
  source_url: `https://commons.wikimedia.org/wiki/File:${file}`,
  license,
  artist,
});

function photoSvg(label: string, fill: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300">`
    + `<rect width="600" height="300" fill="${fill}"/>`
    + `<text x="300" y="165" font-family="sans-serif" font-size="44" font-weight="700" fill="#fff" text-anchor="middle">${label}</text>`
    + `</svg>`;
}

/** 사진 서버 스텁 — 'broken' 이 든 TourAPI 주소는 404(원본 만료), 나머지는 라벨 붙은 그림. */
// 출처 줄 = Wikimedia Commons 원문 페이지로 가는 링크. 구현(클래스·testid)이 아니라 관광객이 보는 링크로 찾는다.
const CREDIT_LINK = 'a[href^="https://commons.wikimedia.org/wiki/File:"]';

async function stubPhotoHosts(page: Page): Promise<void> {
  await page.route('**://upload.wikimedia.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: photoSvg('Wikimedia photo', '#7a5c2e') }),
  );
  await page.route('**://tong.visitkorea.or.kr/**', (route) =>
    route.request().url().includes('broken')
      ? route.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' })
      : route.fulfill({ status: 200, contentType: 'image/svg+xml', body: photoSvg('TourAPI photo', '#2f6b5a') }),
  );
}

type FacilityFixture = {
  id: string;
  name: string;
  type: string;
  image_url: string | null;
  gallery_images: string[] | null;
  features: Record<string, unknown>;
};

function facilityRow(f: FacilityFixture, index: number) {
  return {
    ...f,
    latitude: 35.8363 + index * 0.0002,
    longitude: 129.2107,
    capacity: 30,
    congestion: null,
    operating_hours: { open: '00:00~23:59', closed: '연중무휴' },
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

/** /main 과 /waiting 이 부르는 API 를 고정한다(응답은 snake_case — apiClient 가 camel 로 바꾼다). */
async function mockFacilities(
  page: Page,
  fixtures: FacilityFixture[],
  options: { locale?: 'ko' | 'en' | 'ja' | 'zh'; theme?: 'light' | 'dark' } = {},
): Promise<void> {
  await stubPhotoHosts(page);
  await page.addInitScript(({ locale, theme }) => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    localStorage.setItem('nextspot_locale', locale);
    localStorage.setItem('nextspot_theme', theme);
  }, { locale: options.locale ?? 'ko', theme: options.theme ?? 'light' });
  const rows = fixtures.map(facilityRow);
  await page.route('**/api/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/api/v1/infrastructures')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    }
    if (pathname.endsWith('/api/v1/recommendations/by-type')) {
      const requestedType = String((route.request().postDataJSON() as { facility_type?: string }).facility_type ?? 'restaurant');
      const matches = rows.filter((row) => row.type === requestedType);
      const items = matches.map((row, i) => recommendation(row, i + 1, matches.length));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

test('main card: a Wikimedia gallery photo is shown with its credit link', async ({ page }) => {
  test.setTimeout(90_000); // /main 첫 컴파일(Windows dev server) 여유
  await mockFacilities(page, [{
    id: 'wiki-only', name: '석굴암 쉼터', type: 'restaurant',
    image_url: null, gallery_images: [WIKI_PHOTO],
    features: { image_source: credit('Seokguram.jpg', 'Photographer With A Very Long Commons Username') },
  }]);
  await page.goto('/main');
  await expect(page.getByText('석굴암 쉼터').first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '상세 정보 펼치기' }).click();

  const photo = page.locator(`img[src="${WIKI_PHOTO}"]`);
  await photo.scrollIntoViewIfNeeded(); // loading="lazy" — 화면에 들어와야 받는다
  await expect(photo).toBeVisible();
  const link = page.locator(CREDIT_LINK);
  await expect(link).toHaveCount(1);
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://commons.wikimedia.org/wiki/File:Seokguram.jpg');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link).toContainText('CC BY-SA 4.0');
  // 긴 작가 이름은 한 줄에서 말줄임 — 390px 에서 가로 넘침이 없다.
  expect((await link.boundingBox())?.height ?? 0).toBeLessThanOrEqual(16);
  await expect.poll(
    () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1);
});

test('main card: a TourAPI photo carries no Wikimedia credit', async ({ page }) => {
  test.setTimeout(90_000);
  await mockFacilities(page, [{
    id: 'tour-main', name: '황남 한식당', type: 'restaurant',
    image_url: TOUR_PHOTO, gallery_images: [WIKI_PHOTO],
    features: { image_source: credit('Hwangnam.jpg', 'Someone') },
  }]);
  await page.goto('/main');
  await expect(page.getByText('황남 한식당').first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '상세 정보 펼치기' }).click();

  const photo = page.locator(`img[src="${TOUR_PHOTO}"]`);
  await photo.scrollIntoViewIfNeeded(); // loading="lazy" — 화면에 들어와야 받는다
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.locator(CREDIT_LINK)).toHaveCount(0);
});

test('waiting board: the credit follows the photo each card actually shows', async ({ page }) => {
  await mockFacilities(page, [
    { // 대표 사진(TourAPI)이 보인다 — 갤러리에 Wikimedia 가 있어도 출처를 붙이지 않는다.
      id: 'board-tour', name: '대표사진 식당', type: 'restaurant',
      image_url: TOUR_PHOTO, gallery_images: [WIKI_PHOTO],
      features: { image_source: credit('Tour.jpg', 'Tour Artist') },
    },
    { // 대표 사진이 깨져 Wikimedia 대체 사진이 뜬다 — 그때 출처가 붙는다.
      id: 'board-fallback', name: '대체사진 식당', type: 'restaurant',
      image_url: TOUR_BROKEN, gallery_images: [WIKI_PHOTO],
      features: { image_source: credit('Fallback.jpg', 'Fallback Artist With A Long Commons Name', 'CC BY 4.0') },
    },
    { // 출처가 없는 Wikimedia 사진은 띄우지 않는다.
      id: 'board-uncredited', name: '출처없음 식당', type: 'restaurant',
      image_url: null, gallery_images: [WIKI_PHOTO],
      features: { image_source: null },
    },
  ]);
  await page.goto('/waiting');
  const card = (name: string) => page.locator('div.grid-rows-\\[1fr_auto\\]').filter({ hasText: name });
  await expect(card('대체사진 식당')).toBeVisible({ timeout: 30_000 });

  // 대체 사진 카드: 대표 사진이 깨져 Wikimedia 사진으로 넘어가고, 그 출처가 붙는다.
  await expect(card('대체사진 식당').locator('img')).toHaveAttribute('src', WIKI_PHOTO);
  const fallbackCredit = card('대체사진 식당').locator(CREDIT_LINK);
  await expect(fallbackCredit).toBeVisible();

  // 대표 사진 카드: TourAPI 사진이 보이고, 갤러리에 Wikimedia 가 있어도 출처가 붙지 않는다.
  const tourPhoto = card('대표사진 식당').locator('img');
  await tourPhoto.scrollIntoViewIfNeeded();
  await expect(tourPhoto).toHaveAttribute('src', TOUR_PHOTO);
  await expect.poll(() => tourPhoto.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(card('대표사진 식당').locator(CREDIT_LINK)).toHaveCount(0);

  await expect(fallbackCredit).toHaveAttribute('href', 'https://commons.wikimedia.org/wiki/File:Fallback.jpg');
  await expect(fallbackCredit).toHaveAttribute('target', '_blank');
  await expect(fallbackCredit).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(fallbackCredit).toContainText('CC BY 4.0');

  // 출처 없는 Wikimedia 사진: 사진도 출처도 없다(유형 아이콘 자리표시).
  await expect(card('출처없음 식당').locator('img')).toHaveCount(0);
  await expect(card('출처없음 식당').locator(CREDIT_LINK)).toHaveCount(0);

  await expect(page.locator(CREDIT_LINK)).toHaveCount(1);

  // 출처 줄이 붙은 카드도 옆 카드와 폭이 같다 — 긴 작가 이름이 카드 열을 밀어 넓히지 않는다.
  const widths = await Promise.all(
    ['대표사진 식당', '대체사진 식당', '출처없음 식당'].map(async (name) => (await card(name).getByRole('button').first().boundingBox())?.width ?? 0),
  );
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  expect((await fallbackCredit.boundingBox())?.height ?? 0).toBeLessThanOrEqual(16);
  await expect.poll(
    () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1);
});
