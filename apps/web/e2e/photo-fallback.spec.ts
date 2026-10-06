import { expect, test, type Locator, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 사진이 없는 장소의 사진 자리 — '사진이 깨졌다' 가 아니라 처음부터 디자인된 표지로 보여야 한다.
// 근처 식당·카페 대부분(카카오로 찾은 곳)은 쓸 수 있는 사진이 없다. 대기 보드의 대표 카드는 그 자리를
// 장소마다 다른 경주 문양 표지로 채우고, 사진이 있으면 표지 위로 서서히 드러낸다. 야간(18시 이후 자동)에도
// 표지는 카드 바탕과 구분되는 판이어야 한다(검은 구멍 금지). 대기가 같을 때만 사진 있는 곳이 앞에 선다.
// /explore 추천 카드는 대표 사진이 깨지면 갤러리 사진으로 넘어간다(출처는 보이는 Wikimedia 사진에만).

// 첫 컴파일(Windows dev 서버)이 겹치면 보드가 30초 안에 안 뜰 수 있다 — photo-credit 의 /main 과 같은 여유.
test.beforeEach(async ({ page }, testInfo) => {
  testInfo.setTimeout(90_000);
  await stubExternalServices(page);
});

const TOUR_PHOTO = 'https://tong.visitkorea.or.kr/cms/resource/01/e2e_ok_image2_1.jpg';
const TOUR_PHOTO_2 = 'https://tong.visitkorea.or.kr/cms/resource/04/e2e_ok_gallery_1.jpg';
const TOUR_BROKEN = 'https://tong.visitkorea.or.kr/cms/resource/02/e2e_broken_image2_1.jpg';
const TOUR_SLOW = 'https://tong.visitkorea.or.kr/cms/resource/03/e2e_slow_image2_1.jpg';
const WIKI_PHOTO = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Cheomseongdae.jpg/640px-Cheomseongdae.jpg';
const SLOW_WIKI_PHOTO = 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/Slow_wiki.jpg/640px-Slow_wiki.jpg';
const CREDIT_LINK = 'a[href^="https://commons.wikimedia.org/wiki/File:"]';

function photoSvg(label: string, fill: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300">`
    + `<rect width="600" height="300" fill="${fill}"/>`
    + `<text x="300" y="165" font-family="sans-serif" font-size="44" font-weight="700" fill="#fff" text-anchor="middle">${label}</text>`
    + `</svg>`;
}

/** 사진 서버 스텁 — 'broken' 은 404, 'slow' 는 release() 까지 붙잡아 둔다. */
async function stubPhotoHosts(page: Page): Promise<{ releaseSlow: () => void }> {
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  await page.route('**://upload.wikimedia.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: photoSvg('Wikimedia photo', '#7a5c2e') }),
  );
  await page.route('**://tong.visitkorea.or.kr/**', async (route) => {
    const url = route.request().url();
    if (url.includes('broken')) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' });
    if (url.includes('slow')) await slowGate;
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: photoSvg('TourAPI photo', '#2f6b5a') });
  });
  return { releaseSlow };
}

type Place = {
  id: string;
  name: string;
  type: 'restaurant' | 'cafe' | 'attraction' | 'culture';
  image_url?: string | null;
  gallery_images?: string[] | null;
  features?: Record<string, unknown>;
  /** 서버 검증 대기(분) — 있으면 카드가 그대로 'N분' 으로 말하고 그 값으로 줄을 세운다. */
  wait?: number | null;
};

function recommendation(p: Place, rank: number, total: number) {
  const facility = {
    id: p.id, name: p.name, type: p.type,
    latitude: 35.8363 + rank * 0.0002, longitude: 129.2107, capacity: 30, congestion: null,
    image_url: p.image_url ?? null, gallery_images: p.gallery_images ?? null, features: p.features ?? {},
    operating_hours: { open: '00:00~23:59', closed: '연중무휴' },
  };
  return {
    recommendation_id: `rec-${p.id}`, facility, spot_score: 0.8 - rank * 0.01,
    breakdown: { preference: 0.8, wait_time: p.wait ?? null, travel_time: 3, incentive: 0 },
    distance_m: 120, reason: '테스트 추천', reason_source: 'template',
    congestion_level: null, congestion_source: 'none', congestion_log_source: null,
    congestion_is_stale: null, congestion_timestamp: null,
    rank, total_candidates: total, open_status_at_arrival: 'open_expected',
    information_confidence: 'verified', eligibility_tier: 'verified_open_route',
    place_data_source: 'test', data_updated_at: null,
    scoring_mode: 'degraded_rules', model_version: null, prediction_source: 'unavailable',
  };
}

async function mockBoard(
  page: Page,
  places: Place[],
  options: {
    locale?: 'ko' | 'en';
    theme?: 'light' | 'dark';
    /** 시설별 혼잡 추정(0~1) — 분이 없는 카드가 '추정 혼잡도: 여유/혼잡' 으로 말하게 한다. */
    estimates?: Record<string, number>;
  } = {},
) {
  const hosts = await stubPhotoHosts(page);
  await page.addInitScript(({ locale, theme }) => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    localStorage.setItem('nextspot_locale', locale);
    localStorage.setItem('nextspot_theme', theme);
  }, { locale: options.locale ?? 'ko', theme: options.theme ?? 'light' });
  await page.route('**/api/v1/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/api/v1/recommendations/by-type')) {
      const type = String((route.request().postDataJSON() as { facility_type?: string }).facility_type ?? '');
      const matches = places.filter((p) => p.type === type);
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(matches.map((p, i) => recommendation(p, i + 1, matches.length))),
      });
    }
    if (pathname.endsWith('/api/v1/congestion/estimates') && options.estimates) {
      const observedAt = new Date().toISOString();
      const estimates = Object.fromEntries(
        Object.entries(options.estimates).map(([id, level]) => [id, { source: 'estimated', level, observed_at: observedAt }]),
      );
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true, estimates }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  return hosts;
}

const cell = (page: Page, name: string) => page.locator('div.grid-rows-\\[1fr_auto\\]').filter({ hasText: name });
const tileOf = (c: Locator) => c.locator('[data-photo-fallback]');
/** 섹터(유형 한 판)의 대표 카드 이름 — 화면 순서(순위 ①②③) 그대로. */
async function topCardNames(page: Page, sectorIndex: number): Promise<string[]> {
  const sector = page.locator('main section.fractal-glass').nth(sectorIndex);
  return sector.locator('div.grid-rows-\\[1fr_auto\\] > button').evaluateAll((buttons) =>
    buttons.map((b) => b.querySelector('p')?.textContent?.trim() ?? ''),
  );
}

/**
 * 표지 한 장을 잰다(브라우저 안에서): 표지 판의 실제 색, 같은 카드 본문의 실제 색, 가운데 그림과 받침의 대비.
 * 반투명 바탕은 조상 쪽으로 겹쳐 합성한다(흐림·그림 효과는 무시). 색 문자열(oklab·color()·rgb)은 캔버스로 sRGB 로 푼다.
 */
function measureTile(tile: Element) {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  const rgba = (css: string): [number, number, number, number] => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const effective = (el: Element): [number, number, number] => {
    const layers: [number, number, number, number][] = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
      const css = getComputedStyle(node).backgroundColor;
      const c = rgba(css);
      if (css !== 'rgba(0, 0, 0, 0)' && c[3] > 0) {
        layers.push(c);
        if (c[3] >= 1) break;
      }
    }
    let out: [number, number, number] = [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse()) out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
    return out;
  };
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const glyph = tile.querySelector('[data-tile-glyph]')!;
  const fg = rgba(getComputedStyle(glyph).color);
  const badgeBg = effective(glyph.parentElement!);
  const [l1, l2] = [lum(fg), lum(badgeBg)].sort((x, y) => y - x);
  const body = tile.closest('button')!.querySelector('div.flex-1')!;
  return {
    tile: effective(tile).map(Math.round),
    card: effective(body).map(Math.round),
    glyphContrast: (l1 + 0.05) / (l2 + 0.05),
  };
}

test('waiting board: three photo-less cards show three different designed tiles, no image and no hole', async ({ page }) => {
  await mockBoard(page, [
    { id: 'kakao-cafe-101', name: '이치니산도', type: 'cafe' },
    { id: 'kakao-cafe-102', name: '스테이550', type: 'cafe' },
    { id: 'kakao-cafe-103', name: '샬로우커피', type: 'cafe' },
  ]);
  await page.goto('/waiting');
  const names = ['이치니산도', '스테이550', '샬로우커피'];
  await expect(cell(page, names[0])).toBeVisible({ timeout: 30_000 });

  const motifs: string[] = [];
  const shots: Buffer[] = [];
  for (const name of names) {
    const c = cell(page, name);
    const tile = tileOf(c);
    await expect(tile).toBeVisible();
    await expect(tile).toHaveAttribute('data-photo-fallback', 'cafe');
    // 표지는 인라인 SVG 뿐 — 사진(<img>)도, 깨진 그림도 없다. 카드의 첫 <img> 는 언제나 사진이다.
    await expect(c.locator('img')).toHaveCount(0);
    await expect(tile.locator('img')).toHaveCount(0);
    await expect(tile.locator('[data-tile-pattern]')).toBeVisible();
    await expect(tile.locator('[data-tile-glyph]')).toBeVisible();
    // 사진 자리(표지를 담은 상자, 아래 1px 경계선 포함)는 높이 112px 그대로.
    const slot = (await tile.locator('xpath=..').boundingBox())!;
    expect(Math.abs(slot.height - 112)).toBeLessThanOrEqual(0.5);
    motifs.push((await tile.getAttribute('data-motif')) ?? '');
    shots.push(await tile.screenshot());
  }
  // 한 줄의 세 표지는 무늬가 서로 다르다(같은 판 세 장 = 로딩 자리처럼 읽힌다) — 그림으로도 다르다.
  expect(new Set(motifs).size).toBe(3);
  expect(shots[0].equals(shots[1]) || shots[1].equals(shots[2]) || shots[0].equals(shots[2])).toBe(false);
  // 장식이다 — 화면 읽기 프로그램에는 카드 이름만.
  for (const name of names) await expect(tileOf(cell(page, name))).toHaveAttribute('aria-hidden', 'true');
});

for (const width of [320, 360]) {
  test(`waiting board (${width}px): the type glyph stays clear of the rank badge`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mockBoard(page, [
      { id: 'narrow-1', name: '좁은폭 카페', type: 'cafe' },
      { id: 'narrow-2', name: '좁은폭 식당', type: 'restaurant' },
      { id: 'narrow-3', name: '좁은폭 문화', type: 'culture' },
    ]);
    await page.goto('/waiting');
    for (const name of ['좁은폭 카페', '좁은폭 식당', '좁은폭 문화']) {
      const c = cell(page, name);
      await expect(c).toBeVisible({ timeout: 30_000 });
      const [badge, disc] = await Promise.all([
        c.locator('button > span.left-1\\.5').boundingBox(),
        tileOf(c).locator('[data-tile-glyph]').locator('xpath=..').boundingBox(),
      ]);
      // 두 원 사이의 틈 = 중심 거리 − 두 반지름(받침의 1px 테두리 포함). 4px 이상 떨어져야 '붙은' 모습이 아니다.
      const center = (b: { x: number; y: number; width: number; height: number }) => [b.x + b.width / 2, b.y + b.height / 2];
      const [bx, by] = center(badge!);
      const [dx, dy] = center(disc!);
      const gap = Math.hypot(dx - bx, dy - by) - badge!.width / 2 - (disc!.width / 2 + 1);
      expect(gap, `${name}: 배지와 그림 받침 사이`).toBeGreaterThanOrEqual(4);
    }
  });
}

test('waiting board: a mixed row keeps equal card heights, fades the photo in and falls back to the tile when a photo fails', async ({ page }) => {
  await mockBoard(page, [
    { id: 'mix-photo', name: '사진있는 식당', type: 'restaurant', image_url: TOUR_PHOTO, wait: 5 },
    { id: 'mix-none', name: '사진없는 식당', type: 'restaurant', image_url: null, gallery_images: [], wait: 10 },
    { id: 'mix-broken', name: '사진깨진 식당', type: 'restaurant', image_url: TOUR_BROKEN, gallery_images: null, wait: 15 },
  ]);
  await page.goto('/waiting');
  await expect(cell(page, '사진있는 식당')).toBeVisible({ timeout: 30_000 });

  // 사진: 다 받은 뒤 불투명해진다.
  const photo = cell(page, '사진있는 식당').locator('img');
  await expect(photo).toHaveAttribute('src', TOUR_PHOTO);
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(photo).toHaveCSS('opacity', '1');
  // 표지는 사진 아래에 그대로 깔려 있다(사진이 늦거나 깨져도 빈 상자가 보이지 않는다).
  await expect(tileOf(cell(page, '사진있는 식당'))).toHaveCount(1);

  // 깨진 사진: 다음 후보가 없으니 <img> 가 빠지고 표지만 남는다(깨진 그림 기호 없음).
  await expect(cell(page, '사진깨진 식당').locator('img')).toHaveCount(0);
  await expect(tileOf(cell(page, '사진깨진 식당'))).toBeVisible();
  await expect(tileOf(cell(page, '사진없는 식당'))).toBeVisible();

  // 세 카드와 사진 자리의 높이가 같다.
  const heights = await Promise.all(['사진있는 식당', '사진없는 식당', '사진깨진 식당'].map(async (name) => {
    const c = cell(page, name);
    const [card, slot] = await Promise.all([
      c.getByRole('button').first().boundingBox(),
      c.locator('[data-photo-fallback]').locator('xpath=..').boundingBox(),
    ]);
    return { card: card!.height, slot: slot!.height };
  }));
  for (const h of heights) {
    expect(Math.abs(h.card - heights[0].card)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(h.slot - 112)).toBeLessThanOrEqual(0.5);
  }
  // 불투명하게 보이는 <img> 는 모두 실제 그림을 가졌다.
  const broken = await page.locator('main img').evaluateAll((imgs) =>
    (imgs as HTMLImageElement[]).filter((img) => getComputedStyle(img).opacity === '1' && img.naturalWidth === 0).length,
  );
  expect(broken).toBe(0);
});

test('waiting board: a slow photo keeps the tile visible until it arrives, then fades in', async ({ page }) => {
  const { releaseSlow } = await mockBoard(page, [
    { id: 'slow-1', name: '느린사진 식당', type: 'restaurant', image_url: TOUR_SLOW, wait: 5 },
  ]);
  // 붙잡힌 사진은 첫 섹터의 먼저 받는(eager) 사진이라 window load 를 막는다 — load 를 기다리지 않는다.
  await page.goto('/waiting', { waitUntil: 'domcontentloaded' });
  const c = cell(page, '느린사진 식당');
  await expect(c).toBeVisible({ timeout: 30_000 });
  const img = c.locator('img');
  await expect(img).toHaveAttribute('src', TOUR_SLOW);
  // 받는 동안: 사진은 투명, 표지가 보인다.
  await expect(img).toHaveCSS('opacity', '0');
  await expect(tileOf(c).locator('[data-tile-glyph]')).toBeVisible();
  releaseSlow();
  await expect(img).toHaveCSS('opacity', '1');
});

test('waiting board: a Wikimedia credit appears only once its photo is showing, never under the tile', async ({ page }) => {
  await mockBoard(page, [
    {
      id: 'slow-wiki', name: '첨성대', type: 'restaurant', image_url: null, gallery_images: [SLOW_WIKI_PHOTO], wait: 5,
      features: { image_source: {
        provider: 'Wikimedia Commons', source_url: 'https://commons.wikimedia.org/wiki/File:Slow.jpg',
        license: 'CC BY-SA 4.0', artist: 'Slow Photographer',
      } },
    },
  ]);
  let releaseWiki!: () => void;
  const wikiGate = new Promise<void>((resolve) => { releaseWiki = resolve; });
  await page.route('**/*Slow_wiki*', async (route) => {
    await wikiGate;
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: photoSvg('Wikimedia photo', '#7a5c2e') });
  });
  await page.goto('/waiting', { waitUntil: 'domcontentloaded' });
  const c = cell(page, '첨성대');
  await expect(c).toBeVisible({ timeout: 30_000 });
  const img = c.locator('img');
  await expect(img).toHaveAttribute('src', SLOW_WIKI_PHOTO);
  // 받는 동안: 표지가 보이고, 표지 아래에 사진 작가의 출처가 붙지 않는다(그 자리는 비워 둔 채 높이만 잡는다).
  await expect(img).toHaveCSS('opacity', '0');
  await expect(tileOf(c).locator('[data-tile-glyph]')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(c.locator(CREDIT_LINK)).toHaveCount(0);
  const slotBefore = (await c.boundingBox())!.height;
  releaseWiki();
  // 사진이 드러나면 그 아래에 출처 — 카드 높이는 그대로.
  await expect(img).toHaveCSS('opacity', '1');
  await expect(c.locator(CREDIT_LINK)).toBeVisible();
  await expect(c.locator(CREDIT_LINK)).toContainText('CC BY-SA 4.0');
  expect(Math.abs((await c.boundingBox())!.height - slotBefore)).toBeLessThanOrEqual(0.5);
});

test('waiting board: the first sector loads its top photos eagerly, later sectors lazily', async ({ page }) => {
  await mockBoard(page, [
    { id: 'pri-r1', name: '첫판 식당', type: 'restaurant', image_url: TOUR_PHOTO, wait: 5 },
    { id: 'pri-c1', name: '둘째판 카페', type: 'cafe', image_url: TOUR_PHOTO_2, wait: 5 },
  ]);
  await page.goto('/waiting');
  await expect(cell(page, '첫판 식당')).toBeVisible({ timeout: 30_000 });
  const first = cell(page, '첫판 식당').locator('img');
  await expect(first).toHaveAttribute('loading', 'eager');
  await expect(first).toHaveAttribute('fetchpriority', 'high');
  const later = cell(page, '둘째판 카페').locator('img');
  await expect(later).toHaveAttribute('loading', 'lazy');
});

test('waiting board: among equal waits the place with a photo comes first, never ahead of a shorter wait', async ({ page }) => {
  await mockBoard(page, [
    // 서버 순서 그대로면 [사진없음10, 사진있음10, 사진없음5, 사진있음15] — 보드는 대기 순, 같은 10분 안에서만 사진 먼저.
    { id: 'ord-none-10', name: '십분 무사진', type: 'restaurant', wait: 10 },
    { id: 'ord-photo-10', name: '십분 사진', type: 'restaurant', image_url: TOUR_PHOTO, wait: 10 },
    { id: 'ord-none-5', name: '오분 무사진', type: 'restaurant', wait: 5 },
    { id: 'ord-photo-15', name: '십오분 사진', type: 'restaurant', image_url: TOUR_PHOTO_2, wait: 15 },
    // 출처 없는 Wikimedia 사진은 띄울 수 없는 사진 — 같은 대기에서 앞서지 않는다.
    { id: 'ord-uncredited-5', name: '오분 출처없음', type: 'restaurant', gallery_images: [WIKI_PHOTO], features: {}, wait: 5 },
  ]);
  await page.goto('/waiting');
  await expect(cell(page, '오분 무사진')).toBeVisible({ timeout: 30_000 });
  // 대표 3장: 5분(무사진) → 5분(출처없음, 서버 순서 유지) → 10분(사진). 나머지 목록: 10분(무사진) → 15분(사진).
  expect(await topCardNames(page, 0)).toEqual(['오분 무사진', '오분 출처없음', '십분 사진']);
  const rest = page.locator('main section.fractal-glass').first().locator('div.flex-col.gap-2 > button p.truncate');
  await expect(rest).toHaveText(['십분 무사진', '십오분 사진']);
  await expect(page.locator(CREDIT_LINK)).toHaveCount(0);
});

test('waiting board: without minutes, a photo only moves ahead of a card showing the same estimate', async ({ page }) => {
  // 프로덕션 모양 — 서버 대기가 없어 모든 카드가 분 없이 '추정 혼잡: 한산/혼잡' 으로 말한다.
  await mockBoard(page, [
    { id: 'estquietnone', name: '고요한 식당', type: 'restaurant' },
    { id: 'estbusyphoto', name: '붐비는 식당', type: 'restaurant', image_url: TOUR_PHOTO },
    { id: 'estquietphoto', name: '조용한 식당', type: 'restaurant', image_url: TOUR_PHOTO_2 },
    { id: 'estcafenone', name: '고요한 카페', type: 'cafe' },
    { id: 'estcafephoto', name: '조용한 카페', type: 'cafe', image_url: TOUR_PHOTO },
  ], { estimates: { estquietnone: 0.1, estbusyphoto: 0.9, estquietphoto: 0.1, estcafenone: 0.1, estcafephoto: 0.1 } });
  await page.goto('/waiting', { waitUntil: 'domcontentloaded' });
  const busyCard = cell(page, '붐비는 식당');
  await expect(busyCard).toBeVisible({ timeout: 30_000 });
  await expect(busyCard).toContainText('혼잡');
  await expect(cell(page, '고요한 식당')).toContainText('한산');
  // 분이 없는 카드는 한산한 등급이 먼저(PM 결정 2026-10-06 4.20) — '한산' 두 장이 '혼잡' 카드 앞으로 모이고,
  // 같은 '한산' 끼리만 사진이 앞. '혼잡' 사진 카드는 '한산' 사진 없는 카드를 앞지르지 않는다.
  expect(await topCardNames(page, 0)).toEqual(['조용한 식당', '고요한 식당', '붐비는 식당']);
  // 같은 '한산' 끼리는 사진이 앞.
  expect(await topCardNames(page, 1)).toEqual(['조용한 카페', '고요한 카페']);
});

test('waiting board (dark, after 18:00): the tile is a visible panel, not a dark hole', async ({ page }) => {
  await mockBoard(page, [
    { id: 'kakao-cafe-201', name: '대릉원 찻집', type: 'cafe' },
    { id: 'kakao-cafe-202', name: '첨성대 커피', type: 'cafe' },
    { id: 'kakao-cafe-203', name: '교촌 다방', type: 'cafe' },
  ], { theme: 'dark' });
  await page.goto('/waiting');
  await expect(cell(page, '대릉원 찻집')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('html')).toHaveClass(/nextspot-dark/);

  for (const name of ['대릉원 찻집', '첨성대 커피', '교촌 다방']) {
    const c = cell(page, name);
    const tile = tileOf(c);
    await expect(tile.locator('[data-tile-pattern]')).toBeVisible();
    await expect(tile.locator('[data-tile-glyph]')).toBeVisible();
    expect(await tile.evaluate((el) => getComputedStyle(el).backgroundImage)).not.toBe('none');
    // 표지 판의 색이 카드 본문 바탕과 분명히 다르다(RGB 거리 20 이상) — 같은 먹빛이면 구멍으로 보인다.
    const m = await tile.evaluate(measureTile);
    const distance = Math.hypot(m.tile[0] - m.card[0], m.tile[1] - m.card[1], m.tile[2] - m.card[2]);
    expect(distance, `${name}: 표지 ${m.tile} vs 카드 ${m.card}`).toBeGreaterThanOrEqual(20);
    // 가운데 그림은 둥근 받침 위에서 3:1 이상으로 읽힌다.
    expect(m.glyphContrast, `${name}: 그림 대비`).toBeGreaterThanOrEqual(3);
  }
});

test('explore: a broken first image falls back to the gallery, and a Wikimedia gallery photo carries its credit', async ({ page }) => {
  await stubPhotoHosts(page);
  await page.addInitScript(() => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    localStorage.setItem('nextspot_locale', 'ko');
    localStorage.setItem('nextspot_theme', 'light');
  });
  await page.route('**/rest/v1/**', async (route) => {
    if (route.request().url().includes('/facilities')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: 'origin-r', name: '황리단길 식당', type: 'restaurant', features: {}, congestion_logs: [],
      }) });
    }
    return route.fulfill({ status: 200, headers: { 'content-range': '0-0/1' }, body: '[]' });
  });
  const items = [
    { id: 'exp-gallery', name: '갤러리 식당', image_url: TOUR_BROKEN, gallery_images: [TOUR_PHOTO_2], features: {} },
    {
      id: 'exp-wiki', name: '위키 식당', image_url: TOUR_BROKEN, gallery_images: [WIKI_PHOTO],
      features: { image_source: {
        provider: 'Wikimedia Commons', source_url: 'https://commons.wikimedia.org/wiki/File:Cheomseongdae.jpg',
        license: 'CC BY-SA 4.0', artist: 'Commons Photographer',
      } },
    },
    { id: 'exp-none', name: '사진없음 식당', image_url: TOUR_BROKEN, gallery_images: null, features: {} },
    // 대표 사진(TourAPI)이 잘 뜨는 곳 — 갤러리에 출처 있는 Wikimedia 후보가 있어도 보이는 사진의 출처가 아니다.
    {
      id: 'exp-tour-ok', name: '대표사진 식당', image_url: TOUR_PHOTO, gallery_images: [WIKI_PHOTO],
      features: { image_source: {
        provider: 'Wikimedia Commons', source_url: 'https://commons.wikimedia.org/wiki/File:Cheomseongdae.jpg',
        license: 'CC BY-SA 4.0', artist: 'Commons Photographer',
      } },
    },
  ].map((p, i, all) => recommendation({ ...p, type: 'restaurant' }, i + 1, all.length));
  await page.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/api/v1/recommendations')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/explore/recommend?facilityId=origin-r&lat=35.838&lng=129.209');
  await expect(page.locator('section.space-y-4 h4')).toHaveText(['갤러리 식당', '위키 식당', '사진없음 식당', '대표사진 식당'], { timeout: 30_000 });
  const card = (name: string) => page.locator('section.space-y-4 > div').filter({ has: page.locator('h4', { hasText: name }) });

  // 대표 사진이 깨지면 갤러리 사진으로 — 출처는 없다(TourAPI 사진).
  // 카드를 스크롤한다 — <img> 는 사진이 바뀔 때(key=URL) 새로 붙으므로 옛 노드를 잡으면 'not attached' 로 흔들린다.
  await card('갤러리 식당').scrollIntoViewIfNeeded();
  const galleryImg = card('갤러리 식당').locator('img');
  await expect(galleryImg).toHaveAttribute('src', TOUR_PHOTO_2);
  await expect.poll(() => galleryImg.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(card('갤러리 식당').locator(CREDIT_LINK)).toHaveCount(0);

  // Wikimedia 갤러리 사진이 뜨면 그 사진 아래에 출처.
  await card('위키 식당').scrollIntoViewIfNeeded();
  const wikiImg = card('위키 식당').locator('img');
  await expect(wikiImg).toHaveAttribute('src', WIKI_PHOTO);
  const credit = card('위키 식당').locator(CREDIT_LINK);
  await expect(credit).toBeVisible();
  await expect(credit).toHaveAttribute('href', 'https://commons.wikimedia.org/wiki/File:Cheomseongdae.jpg');
  await expect(credit).toContainText('CC BY-SA 4.0');

  // 후보가 다 깨지면 사진 상자가 없다(오늘과 같은 모습).
  await card('사진없음 식당').scrollIntoViewIfNeeded();
  await expect(card('사진없음 식당').locator('img')).toHaveCount(0);

  // TourAPI 대표 사진이 보이는 카드에는 갤러리의 Wikimedia 출처가 붙지 않는다(출처는 보이는 사진의 것만).
  await card('대표사진 식당').scrollIntoViewIfNeeded();
  const tourImg = card('대표사진 식당').locator('img');
  await expect(tourImg).toHaveAttribute('src', TOUR_PHOTO);
  await expect.poll(() => tourImg.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(card('대표사진 식당').locator(CREDIT_LINK)).toHaveCount(0);
  await expect(page.locator(CREDIT_LINK)).toHaveCount(1);
});
