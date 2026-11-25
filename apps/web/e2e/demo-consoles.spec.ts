import { expect, test, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 심사위원 경로 회귀 테스트 ① — 로그인 없는 데모 콘솔(`?demo=1`).
//
// 계약(lib/demoFixtures.ts 머리말):
//   1. 두 콘솔은 로그인·역할 판정 없이 열린다.
//   2. 화면에는 항상 데모 표시가 있다 — 두 콘솔 모두 머리글의 '예시 화면' 칩 하나(계획 A9 · B4).
//      떠다니는 '데모 데이터로 보는 중' 배지는 없다(2026-10-07 B4 — 관제 데모도 칩 하나로).
//   3. **데모는 백엔드를 부르지 않는다** — 조회도, 쓰기도. 쓰기 버튼은 토스트만 띄운다.
//
// (3) 은 화면만 봐서는 증명되지 않으므로 page.on('request') 로 실제로 나간 요청을 세고,
// /api/v1/merchant/** · /api/v1/admin/** 이 한 건도 없음을 단언한다. 이 파일은 프로덕션 API 로
// 나가는 요청을 전부 가로채므로 실 DB 에는 어떤 쓰기도 닿지 않는다.

/** 이 페이지가 실제로 낸 /api/v1 요청 경로를 기록한다(라우트 처리와 무관하게 전부 잡힌다). */
function recordApiCalls(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/v1/')) seen.push(new URL(url).pathname);
  });
  return seen;
}

/**
 * 데모 콘솔용 네트워크 봉쇄.
 * 카탈-올을 **먼저** 등록한다 — Playwright 는 나중에 등록한 라우트가 이기므로, 뒤에 붙는
 * 구체 라우트가 카탈-올을 덮어야 한다(그 반대면 카탈-올이 전부 먹어 버린다).
 */
async function stubDemoConsole(page: Page): Promise<void> {
  await stubExternalServices(page);
  await page.route('**/rest/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  // 세션 없음 = 게스트. 게이트 화면과 데모 진입점을 판정하는 유일한 입력이다.
  await page.route('**/api/v1/account/me', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"unauthorized"}' }),
  );
}

/** 예전 관제 데모의 떠다니는 배지 문구 — 이제 어느 데모에도 없어야 한다. */
const OLD_FLOATING_BADGE = '데모 데이터로 보는 중';
/** 데모의 표시 — 두 콘솔 모두 머리글 칩 하나(떠 있는 배지는 없다). */
const DEMO_CHIP = '예시 화면';

async function expectOneDemoChip(page: Page): Promise<void> {
  const chip = page.getByText(DEMO_CHIP, { exact: true });
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await expect(chip).toHaveCount(1);
  await expect(page.getByText(OLD_FLOATING_BADGE)).toHaveCount(0);
}
const expectOneMerchantDemoChip = expectOneDemoChip;

const NO_SAVE_TOAST = '데모에서는 저장되지 않아요';

/** 데모가 절대 부르면 안 되는 경로. */
function writeConsoleCalls(paths: string[]): string[] {
  return paths.filter((p) => p.startsWith('/api/v1/merchant/') || p.startsWith('/api/v1/admin/'));
}

// ───────────────────────────────────────────────────────────────────────────
// 사장님 콘솔 — /merchant?demo=1 (모바일 화면)
// ───────────────────────────────────────────────────────────────────────────

test('merchant demo console renders fixtures without login and never calls the merchant API', async ({ page }) => {
  test.setTimeout(90_000);
  const calls = recordApiCalls(page);
  await stubDemoConsole(page);
  await page.goto('/merchant?demo=1');

  // 데모 표시 — 고정 머리글의 '예시 화면' 칩 하나.
  await expectOneMerchantDemoChip(page);

  // 고정값 4종(lib/demoFixtures.ts DEMO_MERCHANT_TODAY = 184/41/23/17).
  await expect(page.getByText('184회', { exact: true })).toBeVisible();
  await expect(page.getByText('41건', { exact: true })).toBeVisible();
  await expect(page.getByText('23건', { exact: true })).toBeVisible();
  await expect(page.getByText('17건', { exact: true })).toBeVisible();

  // 데모 가게 이름과 데모 브리핑이 실제로 렌더된다(게이트 문구가 아니라 콘솔 본문).
  await expect(page.getByText('황리단길 한옥카페', { exact: true })).toBeVisible();
  // 브리핑은 시계와 무관한 시제다(16시가 지나도 '올라갑니다' 가 아니다).
  await expect(page.getByText(/오늘은 15~16시가 가장 붐비는 시간대예요/)).toBeVisible();

  expect(writeConsoleCalls(calls)).toEqual([]);
});

test('merchant demo write buttons only toast and issue no request', async ({ page }) => {
  test.setTimeout(90_000);
  const calls = recordApiCalls(page);
  await stubDemoConsole(page);
  await page.goto('/merchant?demo=1');
  await expectOneMerchantDemoChip(page);

  // ③ 타임세일 — 진행 중인 데모 세일을 '취소 → 종료' 까지 눌러 본다(쓰기 경로의 끝).
  await page.getByRole('button', { name: '20% 할인 타임세일 취소' }).click();
  await page.getByRole('button', { name: '종료', exact: true }).click();
  await expect(page.getByText(NO_SAVE_TOAST).first()).toBeVisible();

  // ④ 좌석 상태 — 세 버튼 모두 쓰기다.
  const seatGroup = page.getByRole('group', { name: '좌석 상태 방송' });
  await seatGroup.getByRole('button', { name: '여유' }).click();
  await expect(page.getByText(NO_SAVE_TOAST).first()).toBeVisible();
  await page.getByRole('button', { name: '좌석 상태 방송 끄기' }).click();
  await expect(page.getByText(NO_SAVE_TOAST).first()).toBeVisible();

  // 세일은 여전히 진행 중이고 좌석 방송도 그대로다 — 데모는 상태를 바꾸지 않는다.
  await expect(page.getByText('⚡ 20% 타임세일 진행 중')).toBeVisible();

  expect(writeConsoleCalls(calls)).toEqual([]);
});

test('merchant gate offers the demo link when the visitor is not a merchant', async ({ page }) => {
  test.setTimeout(90_000);
  await stubDemoConsole(page);
  await page.goto('/merchant');

  const demoEntry = page.getByRole('button', { name: '데모로 둘러보기' });
  await expect(demoEntry).toBeVisible({ timeout: 20_000 });
  await demoEntry.click();
  await expect(page).toHaveURL(/\/merchant\?demo=1$/);
  await expectOneMerchantDemoChip(page);
});

// ───────────────────────────────────────────────────────────────────────────
// 관제 대시보드 — /admin/dashboard?demo=1 (데스크톱 콘솔)
// ───────────────────────────────────────────────────────────────────────────

test.describe('admin demo dashboard', () => {
  // 관제 콘솔은 사이드바 + 4열 KPI 로 짜인 데스크톱 화면이다(components/admin/DemoDashboard.tsx).
  test.use({ viewport: { width: 1280, height: 900 } });

  test('renders fixtures without login and never calls the admin API', async ({ page }) => {
    test.setTimeout(90_000);
    const calls = recordApiCalls(page);
    await stubDemoConsole(page);
    await page.goto('/admin/dashboard?demo=1');

    await expectOneDemoChip(page);

    // KPI 네 개는 기능설명서 ④ · 실제 대시보드와 같은 지표다(평균 혼잡도 · AI 추천 수락률 · 활성 사용자 · 이상 혼잡).
    // 수락률은 실제 대시보드 시나리오 값과 같다(1,013건 중 384건 = 37.9%).
    const kpis = page.locator('#demo-kpis');
    for (const title of ['오늘 평균 혼잡도', 'AI 추천 수락률', '활성 사용자 수 (DAU)', '이상 혼잡 발생']) {
      await expect(kpis.getByText(title, { exact: true })).toBeVisible();
    }
    await expect(kpis.getByText('37.9%', { exact: true })).toBeVisible();
    await expect(kpis.getByText('468명', { exact: true })).toBeVisible();
    await expect(kpis.getByText('3건', { exact: true })).toBeVisible();
    await expect(kpis.getByText(/^\d{2}\.\d%$/).first()).toBeVisible();
    // 오늘 분산 유도 · 절약한 대기는 ③ 분산 효과로 옮겼다. 기능설명서에 없는 '참여 점포'·'대안 전환율' KPI 는 없다.
    await expect(page.getByText('312건', { exact: true })).toBeVisible();
    await expect(page.getByText('1,240분', { exact: true })).toBeVisible();
    await expect(page.getByText('14곳', { exact: true })).toHaveCount(0);
    await expect(page.getByText('38.4%', { exact: true })).toHaveCount(0);
    // 실제 대시보드와 같은 단계 바.
    await expect(page.getByRole('navigation', { name: '관제 단계' })).toBeVisible();

    // 게이트(app/admin/layout.tsx)를 통과해 본문이 그려졌는지 — '권한 확인 중' 로더가 남으면 실패.
    await expect(page.getByText('권한 확인 중…')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '경주 관광 혼잡 종합 대시보드' })).toBeVisible();
    await expect(page.getByText(/오늘 황리단길·대릉원 구간은 14~16시가 가장 붐비는 시간대/)).toBeVisible();

    expect(writeConsoleCalls(calls)).toEqual([]);
  });

  test('admin demo write buttons only toast and issue no request', async ({ page }) => {
    test.setTimeout(90_000);
    const calls = recordApiCalls(page);
    await stubDemoConsole(page);
    await page.goto('/admin/dashboard?demo=1');
    await expectOneDemoChip(page);

    await page.getByRole('button', { name: /데이터 내보내기 \(CSV\)/ }).click();
    await expect(page.getByText(NO_SAVE_TOAST).first()).toBeVisible();

    await page.getByRole('button', { name: '쿠폰 인센티브 조정' }).click();
    await expect(page.getByText(NO_SAVE_TOAST).first()).toBeVisible();

    expect(writeConsoleCalls(calls)).toEqual([]);

    // CSV 는 파일도 만들지 않는다 — 다운로드가 시작되면 실패.
    const download = await Promise.race([
      page.waitForEvent('download', { timeout: 1500 }).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1600)),
    ]);
    expect(download).toBeNull();
  });

  test('admin login offers the demo link for visitors without an account', async ({ page }) => {
    test.setTimeout(90_000);
    await stubDemoConsole(page);
    await page.goto('/admin/login');

    const demoEntry = page.getByRole('button', { name: '데모로 둘러보기' });
    await expect(demoEntry).toBeVisible({ timeout: 20_000 });
    await demoEntry.click();
    await expect(page).toHaveURL(/\/admin\/dashboard\?demo=1$/);
    await expectOneDemoChip(page);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 관제 데모의 나머지 화면 — 사이드바 메뉴마다 데모가 열린다(lib/adminDemo.ts ADMIN_DEMO_PATHS, PM 2026-11-25).
// 예전에는 데모 사이드바의 다른 메뉴가 토스트만 띄워, 통계 리포트·SPOT 시뮬레이터 등이 '안 열리는' 것으로 읽혔다.
// ───────────────────────────────────────────────────────────────────────────

/** 데모가 부르면 안 되는 관리자 전용 조회(관리자 API 밖에 있는 것 포함). */
function adminOnlyCalls(paths: string[]): string[] {
  return paths.filter(
    (p) =>
      p.startsWith('/api/v1/admin/') ||
      p.startsWith('/api/v1/merchant/') ||
      p.startsWith('/api/v1/search/ingest-requests') ||
      p.startsWith('/api/v1/preference-stats'),
  );
}

/** 화면 · 머리글 제목 · 첫 화면에 보이는 고정값(lib/demo/*). */
const ADMIN_DEMO_SCREENS: ReadonlyArray<{ path: string; menu: string; heading: string; fixture: string }> = [
  { path: '/admin/infrastructure', menu: '장소 관리', heading: '장소 관리', fixture: '돌담길 다도 체험관' },
  { path: '/admin/simulator', menu: 'SPOT 시뮬레이터', heading: 'SPOT 시뮬레이터', fixture: '감성·인스타' },
  { path: '/admin/reports', menu: '통계 리포트', heading: '통계 리포트', fixture: '+23%' },
  { path: '/admin/safety', menu: '안전 경보', heading: '인파 밀집 안전 경보', fixture: '황리단길 카페거리 일대' },
  { path: '/admin/report', menu: '성과 리포트', heading: '분산정책 성과 리포트', fixture: '29일 / 30일 (97%)' },
  { path: '/admin/support', menu: '문의 관리', heading: '문의 관리', fixture: '관광객 김**' },
  { path: '/admin/settings', menu: '시스템 설정', heading: '시스템 설정', fixture: '1,912개' },
];

test.describe('admin demo screens', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  for (const screen of ADMIN_DEMO_SCREENS) {
    test(`${screen.path}?demo=1 renders fixtures without login and never calls admin APIs`, async ({ page }) => {
      test.setTimeout(90_000);
      const calls = recordApiCalls(page);
      await stubDemoConsole(page);
      await page.goto(`${screen.path}?demo=1`);

      await expectOneDemoChip(page);
      await expect(page).toHaveURL(new RegExp(`${screen.path}\\?demo=1$`));
      await expect(page.getByText('권한 확인 중…')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: screen.heading, level: 2 })).toBeVisible();
      await expect(page.getByText(screen.fixture).first()).toBeVisible({ timeout: 20_000 });
      // 데모 사이드바에서 지금 화면이 현재 메뉴로 표시된다.
      await expect(page.locator('aside').getByRole('link', { name: screen.menu })).toHaveAttribute('aria-current', 'page');

      expect(adminOnlyCalls(calls)).toEqual([]);
    });
  }

  test('demo sidebar moves between demo screens and keeps the demo', async ({ page }) => {
    test.setTimeout(90_000);
    const calls = recordApiCalls(page);
    await stubDemoConsole(page);
    await page.goto('/admin/dashboard?demo=1');
    await expectOneDemoChip(page);

    const rail = page.locator('aside');
    await rail.getByRole('link', { name: '통계 리포트' }).click();
    await expect(page).toHaveURL(/\/admin\/reports\?demo=1$/, { timeout: 30_000 });
    await expectOneDemoChip(page);

    await rail.getByRole('link', { name: 'SPOT 시뮬레이터' }).click();
    await expect(page).toHaveURL(/\/admin\/simulator\?demo=1$/, { timeout: 30_000 });
    await expectOneDemoChip(page);

    await rail.getByRole('link', { name: '관제 대시보드' }).click();
    await expect(page).toHaveURL(/\/admin\/dashboard\?demo=1$/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: '경주 관광 혼잡 종합 대시보드' })).toBeVisible();

    expect(adminOnlyCalls(calls)).toEqual([]);
  });

  test('infrastructure demo shows owner-uploaded shop photos, not category stand-ins', async ({ page }) => {
    test.setTimeout(90_000);
    await stubDemoConsole(page);
    await page.goto('/admin/infrastructure?demo=1');
    await expectOneDemoChip(page);
    const queue = page.getByTestId('admin-merchant-photos');
    await expect(queue.getByText('사장님이 올린 가게 사진 5장')).toBeVisible({ timeout: 20_000 });
    const photos = queue.locator('img');
    await expect(photos).toHaveCount(5);
    // 업종 사진(public/category — 사진 없는 가게의 표지)을 사장님 사진처럼 쓰지 않는다.
    for (const src of await photos.evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src') ?? ''))) {
      expect(src).toMatch(/^\/demo\/merchant\/[a-z-]+\.webp$/);
    }
  });

  test('settings save in demo only toasts', async ({ page }) => {
    test.setTimeout(90_000);
    const calls = recordApiCalls(page);
    await stubDemoConsole(page);
    await page.goto('/admin/settings?demo=1');
    await expectOneDemoChip(page);
    await page.getByRole('button', { name: /변경사항 저장/ }).click();
    await expect(page.getByText(NO_SAVE_TOAST).first()).toBeVisible();
    expect(adminOnlyCalls(calls)).toEqual([]);
  });
});
