import { expect, test, type Page } from '@playwright/test';
import { expandPeek } from './support/recCard';
import { stubExternalServices } from './support/stubs';

// 한국어 줄바꿈(2026-10-06 감사 I61)과 로그인 화면 언어 칩 겹침(I65).
//
// 한국어는 낱말 단위로만 줄을 바꾼다(html:lang(ko) body { word-break: keep-all; overflow-wrap: break-word }).
// keep-all 은 낱말이 칸보다 길면 칸을 밀어낼 수 있어, 좁은 폰(360)에서 가로 스크롤이 생기지 않는지 화면마다 본다.
// anywhere 를 쓰지 않은 이유(이메일·'TourAPI'·'1,240분' 이 글자 단위로 쪼개진다)는 이메일 한 줄 검사로 잠근다.

test.beforeEach(async ({ page }) => {
  await stubExternalServices(page);
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
});

const PAGES_360 = ['/', '/setup', '/login', '/saved', '/mypage', '/mypage/coupons', '/mypage/impact', '/mypage/privacy', '/merchant', '/guide'];

test('Korean screens have no horizontal scroll at 360px and wrap at word boundaries', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.addInitScript(() => localStorage.setItem('nextspot_onboarding_done', '1'));
  for (const path of PAGES_360) {
    await page.goto(path);
    await expect(page.locator('body')).toBeVisible();
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
    const { doc, offenders } = await horizontalOverflow(page);
    expect(doc, `${path}: 360px 에서 가로 스크롤`).toBeLessThanOrEqual(1);
    expect(offenders, `${path}: 화면 오른쪽 밖으로 밀려 잘린 글자`).toEqual([]);
  }
  await expect(page.locator('body')).toHaveCSS('word-break', 'keep-all');
  await expect(page.locator('body')).toHaveCSS('overflow-wrap', 'break-word');
});

test('only Korean switches to word-boundary wrapping', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nextspot_locale', 'ja'));
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('body')).toHaveCSS('word-break', 'normal');
});

test('judge account emails stay on one line on /login at 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/login');
  const hint = page.getByRole('region', { name: '공모전 심사용 계정' });
  await expect(hint).toBeVisible({ timeout: 30_000 });
  for (const email of ['openapi@naver.com', 'openapi@gmail.com']) {
    const node = hint.getByText(email, { exact: true });
    await expect(node).toBeVisible();
    expect(await node.evaluate((el) => el.getClientRects().length), `${email} 이 두 줄로 갈라졌다`).toBe(1);
  }
});

for (const locale of ['ko', 'en', 'ja', 'zh'] as const) {
  for (const width of [360, 390]) {
    test(`${locale} /login language pill never touches the heading at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((code) => localStorage.setItem('nextspot_locale', code), locale);
      await page.goto('/login');
      const heading = page.getByRole('heading', { level: 1, name: 'NextSpot' });
      await expect(heading).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      const pill = page.locator('label').filter({ has: page.locator('select') }).first();
      const h = (await heading.boundingBox())!;
      const p = (await pill.boundingBox())!;
      // 칩은 제목보다 위에서 끝난다 — 가로로 겹치지 않아도 세로로 붙어 있으면 실패로 본다.
      expect(p.y + p.height, `${locale} ${width}px: 언어 칩이 제목을 덮는다`).toBeLessThanOrEqual(h.y);
    });
  }
}

// ── 카드·보드 화면 ─────────────────────────────────────────────────────────
// keep-all 은 한국어 낱말 하나를 쪼갤 수 없는 덩어리로 만든다 — 최소 폭이 늘어난 flex 칸이 옆 칸을 밀어
// 화면 오른쪽 밖으로 글자를 내보낼 수 있다. 빈 응답 화면만 보면 이것을 놓치므로, 카드가 실제로 그려지는
// /main · /waiting · /course · /explore/recommend 를 띄어쓰기 없는 긴 가게 이름·메뉴로 채워 360px 에서 잰다.
// body 는 overflow-x:clip, 페이지 <main> 은 대개 overflow-hidden 이라 넘친 글자가 가로 스크롤 대신 잘려 사라진다 —
// 그래서 문서 폭과 함께 '보이는 자리 오른쪽을 넘어 잘린 글자' 도 센다(아래 horizontalOverflow).

const LONG_NAMES = ['황리단길치즈갈비카츠정식전문점', '이풍녀구로쌈밥경주황남본점', '국립경주박물관신라천년서고'];
const LONG_MENU = '치즈갈비카츠정식, 경주한우육회비빔밥, 보리쌈밥정식';

function place(id: string, name: string, rank: number) {
  return {
    id, name, type: 'restaurant', latitude: 35.8363 + rank * 0.0006, longitude: 129.2107, capacity: 30, congestion: null,
    image_url: null, gallery_images: null, features: { first_menu: LONG_MENU }, overview: `${name}은 황리단길에서오래사랑받아온곳입니다`,
    operating_hours: { open: '24시간', closed: '연중무휴' }, address: '경상북도 경주시 포석로1050번길', coupon_rate: 0,
  };
}

function recommendation(facility: ReturnType<typeof place>, rank: number, total: number) {
  return {
    recommendation_id: `rec-${facility.id}`, facility, spot_score: 0.8 - rank * 0.01,
    breakdown: { preference: 0.8, wait_time: 10 + rank, travel_time: rank + 3, incentive: 0 },
    distance_m: 190 + rank * 60, reason: `${facility.name}까지걸어서금방이에요`, reason_source: 'template',
    congestion_level: null, congestion_source: 'none', congestion_log_source: null,
    congestion_is_stale: null, congestion_timestamp: null, rank, total_candidates: total,
    open_status_at_arrival: 'open_expected', information_confidence: 'verified', eligibility_tier: 'verified_open_route',
    place_data_source: 'tourapi', data_updated_at: null,
    scoring_mode: 'degraded_rules', model_version: null, prediction_source: 'unavailable',
  };
}

const PLACES = LONG_NAMES.map((name, i) => place(`long-${i}`, name, i));
const RECOMMENDATIONS = PLACES.map((p, i) => recommendation(p, i + 1, PLACES.length));

function coursePlan() {
  const stops = PLACES.slice(0, 2).map((p, i) => ({
    order: i + 1, facility: p, arrival_offset_min: 12 * (i + 1), predicted_congestion: 0.35, spot_score: 0.82,
    reason: `${p.name}고정추천사유가길게이어집니다`, travel_minutes: 12 * (i + 1),
    alternatives: [{ facility: PLACES[2], arrival_offset_min: 14, predicted_congestion: 0.2, spot_score: 0.7, travel_minutes: 14 }],
  }));
  return {
    plan_id: stops.map((s) => s.facility.id).join('+'), stops,
    slot_outcomes: stops.map((s) => ({ order: s.order, requested_type: 'restaurant', status: 'filled', facility_id: s.facility.id, pinned: false })),
  };
}

/**
 * 문서 가로 넘침(px)과, 보이는 자리의 오른쪽 끝을 넘어 잘려 나간 글자 요소.
 * 보이는 자리 = 화면 폭과 '자르는 조상'(overflow hidden·clip — 페이지 <main> 이 대개 그렇다)의 오른쪽 중 가장 왼쪽.
 * 옆으로 넘겨 보는 칸(칩 줄처럼 한 줄짜리 flex·nowrap, /guide 데이터 표처럼 세로로는 넘치지 않는 넘침 auto·scroll 칸)
 * 안의 글자는 의도된 넘침이라 뺀다. 세로 스크롤 칸(overflow-y auto 는 x 도 auto 로 계산된다 — 세로로 넘친다)은
 * 옆으로 넘겨 보는 칸이 아니므로 자르는 조상처럼 다룬다.
 */
async function horizontalOverflow(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const offenders: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const ownText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0);
      if (!ownText || getComputedStyle(el).visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      let limit = vw;
      let inSideScroller = false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX === 'visible') continue;
        const scrolls = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
        const oneRow = (cs.display.includes('flex') && cs.flexDirection.startsWith('row') && cs.flexWrap === 'nowrap')
          || cs.whiteSpace === 'nowrap';
        if (scrolls && (oneRow || a.scrollHeight <= a.clientHeight + 1)) { inSideScroller = true; break; }
        limit = Math.min(limit, a.getBoundingClientRect().right);
      }
      if (!inSideScroller && r.right > limit + 1) {
        offenders.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 24)}" right=${Math.round(r.right)} > ${Math.round(limit)}`);
      }
    }
    return { doc: document.documentElement.scrollWidth - vw, offenders };
  });
}

async function openKo360(page: Page) {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.addInitScript(() => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    localStorage.setItem('nextspot_locale', 'ko');
  });
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  await expect(page.locator('body')).toHaveCSS('word-break', 'keep-all');
  const { doc, offenders } = await horizontalOverflow(page);
  expect(doc, `${label}: 360px 에서 가로 스크롤`).toBeLessThanOrEqual(1);
  expect(offenders, `${label}: 화면 오른쪽 밖으로 밀린 글자`).toEqual([]);
}

/** 맛집 추천 API — /main 과 /waiting 은 음식점 칸에만 긴 이름 세 곳을 받는다. */
async function stubByType(page: Page) {
  await page.route('**/api/v1/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/api/v1/infrastructures')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PLACES) });
    }
    if (pathname.endsWith('/api/v1/recommendations/by-type')) {
      const type = String((route.request().postDataJSON() as { facility_type?: string }).facility_type ?? '');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(type === 'restaurant' ? RECOMMENDATIONS : []) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

test('/main with a recommendation card has no horizontal overflow at 360px in Korean', async ({ page }) => {
  test.setTimeout(120_000);
  await openKo360(page);
  await stubByType(page);
  await page.goto('/main');
  await expect(page.getByText(LONG_NAMES[0]).first()).toBeVisible({ timeout: 60_000 });
  await expectNoHorizontalOverflow(page, '/main (미리보기 카드)');
  // 폰 카드는 짧은 미리보기로 열린다 — 전체 카드로 펼친 뒤, 펼친 상세(메뉴·주소·사유)까지 같은 폭 안에 있다.
  await expandPeek(page);
  await expectNoHorizontalOverflow(page, '/main (전체 카드)');
  await page.getByRole('button', { name: '상세 정보 펼치기' }).first().click();
  await expectNoHorizontalOverflow(page, '/main (펼친 상세)');
});

test('/waiting with long place names has no horizontal overflow at 360px in Korean', async ({ page }) => {
  test.setTimeout(120_000);
  await openKo360(page);
  await stubByType(page);
  await page.goto('/waiting');
  await expect(page.locator('div.grid-rows-\\[1fr_auto\\] > button')).toHaveCount(3, { timeout: 60_000 });
  await expectNoHorizontalOverflow(page, '/waiting');
});

test('/course with long stop names has no horizontal overflow at 360px in Korean', async ({ page }) => {
  test.setTimeout(120_000);
  await openKo360(page);
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/v1/courses/plan', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(coursePlan()) }),
  );
  await page.goto('/course');
  await expect(page.getByRole('heading', { level: 3 })).toHaveCount(2, { timeout: 60_000 });
  await expectNoHorizontalOverflow(page, '/course');
});

test('/explore/recommend with long alternatives has no horizontal overflow at 360px in Korean', async ({ page }) => {
  test.setTimeout(120_000);
  await openKo360(page);
  await page.route('**/rest/v1/**', (route) => {
    if (route.request().url().includes('/facilities')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: 'origin-cafe', name: '황리단길한옥카페본점', type: 'restaurant', features: {}, congestion_logs: [],
      }) });
    }
    return route.fulfill({ status: 200, headers: { 'content-range': '0-0/1' }, body: '[]' });
  });
  await page.route('**/api/v1/**', (route) => {
    const url = route.request().url();
    if (url.endsWith('/api/v1/recommendations') || url.endsWith('/api/v1/recommendations/by-type')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RECOMMENDATIONS) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/explore/recommend?facilityId=origin-cafe&lat=35.838&lng=129.209');
  await expect(page.getByText(LONG_NAMES[0]).first()).toBeVisible({ timeout: 60_000 });
  await expectNoHorizontalOverflow(page, '/explore/recommend');
});
