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

/** 출처 링크 상자 폭 − 보이는 글자 폭(두 줄이면 긴 줄, 한 줄이면 조각의 합). 0 이면 누르는 자리가 글자만큼이다. */
function tapBoxExtraWidth(a: Element): number {
  const box = a.getBoundingClientRect().width;
  const parts = Array.from(a.children).map((c) => c.getBoundingClientRect());
  const stacked = parts.length > 1 && parts[1].top >= parts[0].bottom - 1;
  const text = stacked ? Math.max(...parts.map((r) => r.width)) : parts.reduce((w, r) => w + r.width, 0);
  return box - text;
}

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
  // TourAPI 적재분 식별자 — 있으면 상세에 '실시간 정보 새로고침' 과 ⓒ한국관광공사 TourAPI 표시가 뜬다.
  contentid?: string;
  contenttypeid?: number;
  overview?: string;
  address?: string;
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
  // 긴 작가 이름은 한 줄에서 말줄임 — 390px 에서 가로 넘침이 없다(글자 한 줄 + 누르는 자리, 24px 상자).
  expect((await link.boundingBox())?.height ?? 0).toBeLessThanOrEqual(24);
  // 누르는 자리는 보이는 글자 폭만큼 — 줄 오른쪽 빈자리가 새 창 링크가 되지 않는다.
  expect(await link.evaluate(tapBoxExtraWidth)).toBeLessThanOrEqual(1);
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
  expect((await fallbackCredit.boundingBox())?.height ?? 0).toBeLessThanOrEqual(28); // 이름 한 줄 + 라이선스 한 줄
  await expect.poll(
    () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1);
});

test('main card: the ⓒ TourAPI chip sits with the TourAPI text, apart from the Wikimedia photo', async ({ page }) => {
  test.setTimeout(90_000);
  // TourAPI 적재 관광지(contentid 있음)인데 사진은 적재 배치가 넣은 Wikimedia 대체 사진뿐인 경우.
  await mockFacilities(page, [{
    id: 'wiki-tourapi', name: '분황사 쉼터', type: 'restaurant',
    contentid: '126207', contenttypeid: 12,
    image_url: null, gallery_images: [WIKI_PHOTO],
    features: { image_source: credit('Bunhwangsa.jpg', 'Commons Photographer') },
    overview: '분황사 모전석탑 앞 마당에 자리한 작은 쉼터.',
    address: '경상북도 경주시 분황로 94-11',
  }]);
  await page.goto('/main');
  await expect(page.getByText('분황사 쉼터').first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '상세 정보 펼치기' }).click();

  const photo = page.locator(`img[src="${WIKI_PHOTO}"]`);
  await photo.scrollIntoViewIfNeeded();
  await expect(photo).toBeVisible();
  const link = page.locator(CREDIT_LINK);
  await expect(link).toBeVisible();
  const refresh = page.getByRole('button', { name: '실시간 정보 새로고침' });
  await expect(refresh).toBeVisible();
  const chip = refresh.locator('xpath=following-sibling::span');
  await expect(chip).toHaveText('ⓒ한국관광공사 TourAPI');

  // 상세의 차례: [사진 + 사진의 출처] → [💡 추천 사유] → [새로고침 · ⓒ TourAPI] → [개요] …
  // ⓒ 표시 바로 아래가 그것이 가리키는 TourAPI 글이고, 사진의 출처와 ⓒ 표시 사이에는 사진이 아닌 글 블록이 있다.
  const chipRow = refresh.locator('xpath=..');
  await expect(chipRow.locator('xpath=..').getByText('ⓒ한국관광공사 TourAPI')).toHaveCount(1); // 상세 안에 한 번만
  const afterChip = chipRow.locator('xpath=following-sibling::*[1]');
  await expect(afterChip).toContainText('소개');
  await expect(afterChip).toContainText('분황사 모전석탑 앞 마당에 자리한 작은 쉼터.');
  const beforeChip = chipRow.locator('xpath=preceding-sibling::*[1]');
  await expect(beforeChip).toContainText('💡');
  await expect(beforeChip.locator('img')).toHaveCount(0);
  await expect(beforeChip.locator(CREDIT_LINK)).toHaveCount(0);
  const photoBlock = beforeChip.locator('xpath=preceding-sibling::*[1]');
  await expect(photoBlock.locator(`img[src="${WIKI_PHOTO}"]`)).toHaveCount(1);
  await expect(photoBlock.locator(CREDIT_LINK)).toHaveCount(1);

  const [linkBox, reasonBox, chipBox] = await Promise.all([link.boundingBox(), beforeChip.boundingBox(), chip.boundingBox()]);
  expect(linkBox && reasonBox && chipBox).toBeTruthy();
  expect(reasonBox!.y).toBeGreaterThanOrEqual(linkBox!.y + linkBox!.height - 5); // 출처 상자 아래 5px 은 누르는 여백(-mb-[5px])
  expect(chipBox!.y).toBeGreaterThanOrEqual(reasonBox!.y + reasonBox!.height);
  // 출처 링크는 누르기 좋은 24px 상자, 폭은 보이는 글자만큼.
  expect(linkBox!.height).toBeGreaterThanOrEqual(24);
  expect(await link.evaluate(tapBoxExtraWidth)).toBeLessThanOrEqual(1);
});

test('main card: without an overview the ⓒ TourAPI chip sits right above the address', async ({ page }) => {
  test.setTimeout(90_000);
  // TourAPI 사진·개요 없음 — ⓒ 표시는 주소(TourAPI) 바로 위, 사진 출처 줄은 없다.
  await mockFacilities(page, [{
    id: 'tour-no-overview', name: '황남 국밥', type: 'restaurant',
    contentid: '2790001', contenttypeid: 39,
    image_url: TOUR_PHOTO, gallery_images: null,
    features: {},
    address: '경상북도 경주시 포석로 1080',
  }]);
  await page.goto('/main');
  await expect(page.getByText('황남 국밥').first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '상세 정보 펼치기' }).click();

  const refresh = page.getByRole('button', { name: '실시간 정보 새로고침' });
  await refresh.scrollIntoViewIfNeeded();
  await expect(refresh).toBeVisible();
  await expect(refresh.locator('xpath=following-sibling::span')).toHaveText('ⓒ한국관광공사 TourAPI');
  const afterChip = refresh.locator('xpath=../following-sibling::*[1]');
  await expect(afterChip).toContainText('주소');
  await expect(afterChip).toContainText('경상북도 경주시 포석로 1080');
  await expect(refresh.locator('xpath=../preceding-sibling::*[1]')).toContainText('💡');
  await expect(page.locator(CREDIT_LINK)).toHaveCount(0);
});

test('waiting board: the credit shows the artist on its own line and keeps clear of the card', async ({ page }) => {
  await mockFacilities(page, [{
    id: 'board-wiki', name: '월정교 식당', type: 'restaurant',
    image_url: null, gallery_images: [WIKI_PHOTO],
    features: { image_source: credit('Woljeonggyo.jpg', 'Kang Byeong Kee', 'CC BY-SA 4.0') },
  }]);
  await page.goto('/waiting');
  const card = page.locator('div.grid-rows-\\[1fr_auto\\]').filter({ hasText: '월정교 식당' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  const link = card.locator(CREDIT_LINK);
  await expect(link).toBeVisible();
  const [name, license] = [link.locator('span').nth(0), link.locator('span').nth(1)];
  await expect(name).toHaveText('Kang Byeong Kee');
  await expect(license).toHaveText('CC BY-SA 4.0');

  // 작가 이름이 좁은 카드 폭 안에서 잘리지 않고, 라이선스는 다음 줄.
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const [nameBox, licenseBox] = await Promise.all([name.boundingBox(), license.boundingBox()]);
  expect(licenseBox!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height - 1);

  // 카드 아래 가장자리와 출처 링크 사이에 틈(8px 이상) — 카드를 누르려던 엄지가 새 창 링크로 새지 않는다.
  const [cardBox, linkBox] = await Promise.all([card.getByRole('button').first().boundingBox(), link.boundingBox()]);
  expect(linkBox!.y - (cardBox!.y + cardBox!.height)).toBeGreaterThanOrEqual(8);
  expect(linkBox!.height).toBeGreaterThanOrEqual(24);
  // 누르는 자리는 두 줄 중 긴 줄의 폭만큼 — 카드 폭 전체가 링크가 되지 않는다.
  expect(await link.evaluate(tapBoxExtraWidth)).toBeLessThanOrEqual(1);
  expect(linkBox!.width).toBeLessThan(cardBox!.width - 8);
});

// 대기 보드 셀 = [카드 버튼, 출처 자리].
const boardCell = (page: Page, name: string) => page.locator('div.grid-rows-\\[1fr_auto\\]').filter({ hasText: name });

test('waiting board: a credit that appears after a broken photo does not move the content below', async ({ page }) => {
  await mockFacilities(page, [
    {
      id: 'shift-fallback', name: '늦은출처 식당', type: 'restaurant',
      image_url: TOUR_BROKEN, gallery_images: [WIKI_PHOTO],
      features: { image_source: credit('Late.jpg', 'Late Artist', 'CC BY 4.0') },
    },
    {
      id: 'shift-tour', name: '옆자리 식당', type: 'restaurant',
      image_url: TOUR_PHOTO, gallery_images: null, features: {},
    },
  ]);
  // 깨진 대표 사진의 404 를 붙잡아 둔다 — 그동안은 출처가 없고, 풀면 Wikimedia 사진과 출처가 뜬다.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let markRequested!: () => void;
  const brokenRequested = new Promise<void>((resolve) => { markRequested = resolve; });
  await page.route('**/e2e_broken_image2_1.jpg', async (route) => {
    markRequested();
    await held;
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' });
  });

  await page.goto('/waiting');
  const cell = boardCell(page, '늦은출처 식당');
  await expect(cell).toBeVisible({ timeout: 30_000 });
  await expect(cell.locator('img')).toHaveAttribute('src', TOUR_BROKEN);
  await brokenRequested;
  await expect(boardCell(page, '옆자리 식당')).toBeVisible();
  await expect(page.locator(CREDIT_LINK)).toHaveCount(0);

  // 카드 줄 바로 아래 내용(골든타임 자리 → 나머지 목록)의 위치를 카드 줄 기준으로 잰다.
  const grid = page.locator('div.grid-cols-3.items-stretch').filter({ has: cell });
  const below = grid.locator('xpath=following-sibling::*[1]');
  const measure = async () => {
    const [g, b] = await Promise.all([grid.boundingBox(), below.boundingBox()]);
    return { belowFromTop: b!.y - g!.y, gridHeight: g!.height };
  };
  const before = await measure();

  release();
  await expect(cell.locator('img')).toHaveAttribute('src', WIKI_PHOTO);
  const lateCredit = cell.locator(CREDIT_LINK);
  await expect(lateCredit).toBeVisible();
  await expect(lateCredit).toContainText('CC BY 4.0');

  const after = await measure();
  expect(Math.abs(after.belowFromTop - before.belowFromTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.gridHeight - before.gridHeight)).toBeLessThanOrEqual(1);
});

test('waiting board: a row with no Wikimedia photo keeps the 16px slot under its cards', async ({ page }) => {
  await mockFacilities(page, [
    { id: 'plain-a', name: '가게하나 식당', type: 'restaurant', image_url: TOUR_PHOTO, gallery_images: null, features: {} },
    { id: 'plain-b', name: '가게둘 식당', type: 'restaurant', image_url: null, gallery_images: null, features: {} },
  ]);
  await page.goto('/waiting');
  await expect(boardCell(page, '가게하나 식당')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(CREDIT_LINK)).toHaveCount(0);
  // 프로덕션(367514c)의 대기 보드와 같은 자리: 카드 아래 16px(min-h-4).
  for (const name of ['가게하나 식당', '가게둘 식당']) {
    const c = boardCell(page, name);
    const [cellBox, cardBox] = await Promise.all([c.boundingBox(), c.getByRole('button').first().boundingBox()]);
    expect(Math.abs(cellBox!.y + cellBox!.height - (cardBox!.y + cardBox!.height) - 16)).toBeLessThanOrEqual(0.5);
  }
});
