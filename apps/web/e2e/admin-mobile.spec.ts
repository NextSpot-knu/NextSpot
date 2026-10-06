import { writeFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 관제 콘솔을 **휴대폰(390px)** 으로 여는 심사위원 동선.
//
// 관제 화면은 데스크톱 기준으로 만들어졌다 — 고정 폭 사이드바(256px)가 390px 화면의 3분의 2를
// 차지해, 본문 표가 한 칸 40px 남짓으로 짓눌렸다. 이 스펙이 잠그는 것은 세 가지다:
//   · 어느 관제 화면도 본문이 화면 밖으로 밀려나지 않는다(표는 카드 **안에서만** 가로로 민다)
//   · 표의 칸이 글자를 읽을 수 있는 폭을 유지한다
//   · 사이드바가 접혀도 메뉴(다른 관제 화면·관광객 앱·로그아웃)에 닿을 수 있다
//
// 실계정·실서버는 쓰지 않는다. 관리자 판정(/account/me)과 관리자 API·Supabase REST 는 전부 스텁이다.

const ADMIN_ROUTES = [
  '/admin/dashboard',
  '/admin/infrastructure',
  '/admin/simulator',
  '/admin/reports',
  '/admin/safety',
  '/admin/report',
  '/admin/engine-validation',
  '/admin/support',
  '/admin/settings',
] as const;

/** 심사 기간에 메뉴에서만 감춘 화면(components/AdminSidebar.tsx HIDDEN_FROM_MENU) — 화면 자체는 위 목록처럼 URL 로 열린다. */
const HIDDEN_FROM_MENU = new Set<string>(['/admin/engine-validation']);

/** 읽을 수 있는 최소 칸 폭(px). 한글 두 글자 + 좌우 여백이 들어가는 폭이다. */
const MIN_CELL_WIDTH = 44;

const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const FACILITIES = Array.from({ length: 8 }, (_, i) => ({
  id: String(1000 + i),
  name: ['불국사', '석굴암', '첨성대', '동궁과 월지', '황리단길 카페', '교리김밥', '대릉원', '경주국립박물관'][i],
  type: ['attraction', 'attraction', 'attraction', 'attraction', 'cafe', 'restaurant', 'attraction', 'culture'][i],
  capacity: 120 + i * 40,
  operating_hours: '09:00-18:00',
  is_active: true,
  coupon_rate: i % 3 === 0 ? 10 : 0,
  updated_at: iso(60),
}));

const INQUIRIES = [
  { id: 'q1', user_id: 'u1', user_name: '관광객 A', type: '이용 문의', title: '쿠폰은 어디서 확인하나요?', content: '받은 쿠폰을 다시 보고 싶어요.', status: 'new', created_at: iso(30) },
  { id: 'q2', user_id: null, user_name: null, type: '오류 신고', title: '지도가 늦게 떠요', content: '첫 화면 지도가 늦게 보입니다.', status: 'in_progress', created_at: iso(300) },
  { id: 'q3', user_id: 'u3', user_name: '관광객 C', type: '제안', title: '야간 코스도 추천해 주세요', content: '동궁과 월지 야경 코스가 있으면 좋겠어요.', status: 'resolved', created_at: iso(3000), reply_body: '야간 코스를 준비하고 있어요.', replied_at: iso(2000) },
];

const SAFETY_STATUS = {
  generatedAt: iso(1),
  sampleEmpty: false,
  thresholds: { alert: 0.8, warn: 0.6 },
  meta: { zoneMethod: 'grid' },
  facilityAlerts: [
    { facilityId: '1000', facilityName: '불국사', facilityType: 'attraction', congestion: 0.86, nextHourCongestion: 0.8, timestamp: iso(5) },
  ],
  facilityWarnings: [
    { facilityId: '1002', facilityName: '첨성대', facilityType: 'attraction', congestion: 0.66, nextHourCongestion: 0.6, timestamp: iso(7) },
  ],
  zones: [
    { zoneId: 'z1', zoneLabel: '불국사 일원', topFacilityId: '1000', avgCongestion: 0.82, maxCongestion: 0.86, facilityCount: 4, level: 'alert', nextHourCongestion: 0.78 },
    { zoneId: 'z2', zoneLabel: '대릉원 일원', topFacilityId: '1006', avgCongestion: 0.61, maxCongestion: 0.66, facilityCount: 6, level: 'warn', nextHourCongestion: 0.55 },
    { zoneId: 'z3', zoneLabel: '보문단지', topFacilityId: null, avgCongestion: 0.3, maxCongestion: 0.4, facilityCount: 5, level: 'normal', nextHourCongestion: null },
  ],
  summary: { alertZones: 1, warnZones: 1, normalZones: 1, alertFacilities: 1, warnFacilities: 1 },
};

function json(route: Route, status: number, body: unknown, headers: Record<string, string> = {}) {
  return route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
}

/** 관리자 세션 — /account/me 가 admin 을 말하고, 관리자 API·Supabase REST 는 고정 응답으로 닫는다. */
async function stubAdminConsole(page: Page): Promise<void> {
  await page.route('**/rest/v1/**', (route) => {
    const url = route.request().url();
    if (route.request().method() === 'HEAD') {
      return route.fulfill({ status: 200, headers: { 'content-range': '0-0/8' }, body: '' });
    }
    if (url.includes('/rpc/latest_congestion_for_facilities')) {
      return json(route, 200, FACILITIES.map((f, i) => ({
        facility_id: f.id,
        congestion_level: [0.86, 0.4, 0.66, 0.3, 0.5, 0.2, 0.7, 0.35][i],
        current_count: null,
        source: 'user_report',
        timestamp: iso(10 + i),
      })));
    }
    if (url.includes('/facilities')) return json(route, 200, FACILITIES, { 'content-range': `0-7/${FACILITIES.length}` });
    return json(route, 200, []);
  });

  await page.route('**/api/v1/**', (route) => {
    const url = route.request().url();
    if (url.includes('/account/me')) {
      return json(route, 200, {
        id: '00000000-0000-4000-8000-0000000000ad',
        role: 'admin',
        is_anonymous: false,
        nickname: '관제 담당자',
        owned_facilities: [],
        pending_verification: false,
      });
    }
    if (url.includes('/admin/inquiries')) return json(route, 200, INQUIRIES);
    if (url.includes('/admin/safety/status')) return json(route, 200, SAFETY_STATUS);
    if (url.includes('/admin/settings')) {
      return json(route, 200, { maintenance_mode: false, notice_text: '', congestion_threshold: 80, coldstart_weight: 50 });
    }
    if (url.includes('/ingest-requests')) return json(route, 200, []);
    // 나머지 관리자 API 는 '아직 없음' 으로 닫는다 — 화면은 실패 상태를 그리고, 레이아웃 검사는 그대로 성립한다.
    return json(route, 404, { detail: 'not stubbed' });
  });
}

/** 본문이 화면 밖으로 밀려났는가 — 가로 스크롤 컨테이너 **안**에 있는 것은 정상(카드 안에서 민다). */
async function escapingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    const scrollsX = (el: Element | null): boolean => {
      for (let p = el?.parentElement ?? null; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
      return false;
    };
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.position === 'fixed') continue;
      if (r.right <= vw + 1 && r.left >= -1) continue;
      if (scrollsX(el)) continue;
      const label = `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} [${Math.round(r.left)}..${Math.round(r.right)}]`;
      out.push(label);
      if (out.length > 8) break;
    }
    return out;
  });
}

async function openAdmin(page: Page, path: string): Promise<void> {
  await page.goto(path);
  // 관제 게이트(권한 확인 중)를 지나 콘솔이 그려질 때까지.
  await expect(page.locator('main').first()).toBeVisible({ timeout: 30_000 });
  // 첫 조회가 화면에 반영될 시간을 준다(스텁이라 곧 끝난다).
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(500);
}

const SHOT_DIR = process.env.ADMIN_SHOT_DIR;

test.beforeEach(async ({ page }) => {
  await stubExternalServices(page);
  await stubAdminConsole(page);
});

for (const path of ADMIN_ROUTES) {
  test(`390px — ${path} 본문이 화면 안에 머물고 표 칸이 읽힌다`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAdmin(page, path);
    if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/390${path.replaceAll('/', '_')}.png` });

    const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(docOverflow, '문서 가로 스크롤').toBeLessThanOrEqual(0);
    // 본문이 화면 폭을 다 쓴다 — 사이드바가 옆에 남아 본문을 세로 띠로 누르지 않는다.
    const mainWidth = await page.locator('main').first().evaluate((el) => el.getBoundingClientRect().width);
    expect(mainWidth, '본문 폭').toBeGreaterThanOrEqual(389);
    expect(await escapingElements(page), '화면 밖으로 밀려난 요소').toEqual([]);

    const narrowCells = await page.evaluate((min) =>
      Array.from(document.querySelectorAll('main th, main td'))
        .map((c) => ({ w: c.getBoundingClientRect().width, t: (c.textContent ?? '').trim().slice(0, 20) }))
        .filter((c) => c.w > 0 && c.w < min && c.t.length > 0),
    MIN_CELL_WIDTH);
    expect(narrowCells, '읽을 수 없게 좁은 표 칸').toEqual([]);

    // 사이드바가 접힌 폭에서는 상단 메뉴 버튼으로 같은 메뉴를 연다.
    const menuButton = page.getByRole('button', { name: '관제 메뉴 열기' });
    await expect(menuButton).toBeVisible();
    // 아이콘만이 아니라 글자로도 '관제 메뉴' 가 보인다(어디를 누르면 다른 관제 화면이 있는지).
    await expect(menuButton).toHaveText('관제 메뉴');

    if (SHOT_DIR) {
      // 관제 화면은 화면 높이 고정 + 본문 스크롤이라 전체 캡처가 첫 화면만 찍는다 — 키 큰 창으로 한 장 더.
      await page.setViewportSize({ width: 390, height: 3200 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOT_DIR}/390${path.replaceAll('/', '_')}_tall.png` });
    }
  });

  for (const width of [1024, 1280]) {
    test(`${width}px — ${path} 데스크톱 사이드바 그대로`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openAdmin(page, path);
      if (SHOT_DIR) {
        const name = `${SHOT_DIR}/${width}${path.replaceAll('/', '_')}`;
        await page.screenshot({ path: `${name}.png` });
        // 데스크톱이 '전과 똑같은가' 를 눈 대신 숫자로 비교하려고 요소 상자를 떠 둔다(전/후 diff).
        const boxes = await page.evaluate(() => Array.from(document.querySelectorAll('aside, aside *, main, main *'))
          .map((el) => {
            const r = el.getBoundingClientRect();
            return `${el.tagName} ${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}`;
          }));
        writeFileSync(`${name}.boxes.txt`, `${boxes.join('\n')}\n`);
      }
      await expect(page.getByRole('button', { name: '관제 메뉴 열기' })).toBeHidden();
      const aside = page.locator('aside').first();
      await expect(aside).toBeVisible();
      expect((await aside.boundingBox())?.width).toBe(256);
    });
  }
}

test('390px — 접힌 메뉴에서 다른 관제 화면으로 이동하고, 관광객 앱·로그아웃에도 닿는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAdmin(page, '/admin/dashboard');

  await page.getByRole('button', { name: '관제 메뉴 열기' }).click();
  const drawer = page.getByRole('dialog', { name: '관제 메뉴' });
  await expect(drawer).toBeVisible();
  for (const path of ADMIN_ROUTES) {
    if (HIDDEN_FROM_MENU.has(path)) {
      await expect(drawer.locator(`a[href="${path}"]`)).toHaveCount(0);
      continue;
    }
    await expect(drawer.locator(`a[href="${path}"]`)).toBeVisible();
  }
  await expect(drawer.locator('a[href="/main"]')).toBeVisible();
  await expect(drawer.getByRole('button', { name: '로그아웃' })).toBeVisible();
  // 현재 화면이 표시된다.
  await expect(drawer.locator('a[href="/admin/dashboard"]')).toHaveAttribute('aria-current', 'page');

  // Escape 로 닫히고, 다시 열어 이동하면 서랍이 닫힌 채 새 화면이 뜬다.
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await page.getByRole('button', { name: '관제 메뉴 열기' }).click();
  await drawer.locator('a[href="/admin/support"]').click();
  await expect(page).toHaveURL(/\/admin\/support/);
  await expect(page.getByRole('dialog', { name: '관제 메뉴' })).toBeHidden();
});
