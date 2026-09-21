import { expect, test, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 심사위원 경로 회귀 테스트 ① — 로그인 없는 데모 콘솔(`?demo=1`).
//
// 계약(lib/demoFixtures.ts 머리말):
//   1. 두 콘솔은 로그인·역할 판정 없이 열린다.
//   2. 화면에는 항상 '데모 데이터로 보는 중' 배지가 떠 있다.
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

const DEMO_BADGE = '데모 데이터로 보는 중';
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

  // 배지 — 스크롤해도 사라지지 않는 고정 배지(components/DemoBadge.tsx).
  await expect(page.getByText(DEMO_BADGE)).toBeVisible({ timeout: 20_000 });

  // 고정값 4종(lib/demoFixtures.ts DEMO_MERCHANT_TODAY = 184/41/23/17).
  await expect(page.getByText('184회', { exact: true })).toBeVisible();
  await expect(page.getByText('41건', { exact: true })).toBeVisible();
  await expect(page.getByText('23건', { exact: true })).toBeVisible();
  await expect(page.getByText('17건', { exact: true })).toBeVisible();

  // 데모 가게 이름과 데모 브리핑이 실제로 렌더된다(게이트 문구가 아니라 콘솔 본문).
  await expect(page.getByText('황리단길 한옥카페 (데모)').first()).toBeVisible();
  await expect(page.getByText(/오늘 15~16시에 예상 혼잡이 91%까지/)).toBeVisible();

  expect(writeConsoleCalls(calls)).toEqual([]);
});

test('merchant demo write buttons only toast and issue no request', async ({ page }) => {
  test.setTimeout(90_000);
  const calls = recordApiCalls(page);
  await stubDemoConsole(page);
  await page.goto('/merchant?demo=1');
  await expect(page.getByText(DEMO_BADGE)).toBeVisible({ timeout: 20_000 });

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
  await expect(page.getByText('20% 할인 중')).toBeVisible();

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
  await expect(page.getByText(DEMO_BADGE)).toBeVisible();
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

    await expect(page.getByText(DEMO_BADGE)).toBeVisible({ timeout: 20_000 });

    // DEMO_ADMIN_KPI = 312 분산 / 1,240분 / 14곳 / 38.4%
    await expect(page.getByText('312건', { exact: true })).toBeVisible();
    await expect(page.getByText('1,240분', { exact: true })).toBeVisible();
    await expect(page.getByText('14곳', { exact: true })).toBeVisible();
    await expect(page.getByText('38.4%', { exact: true })).toBeVisible();

    // 게이트(app/admin/layout.tsx)를 통과해 본문이 그려졌는지 — '권한 확인 중' 로더가 남으면 실패.
    await expect(page.getByText('권한 확인 중…')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '경주 관광 혼잡 종합 대시보드' })).toBeVisible();
    await expect(page.getByText(/오늘 14~16시 황리단길·대릉원 구간이/)).toBeVisible();

    expect(writeConsoleCalls(calls)).toEqual([]);
  });

  test('admin demo write buttons only toast and issue no request', async ({ page }) => {
    test.setTimeout(90_000);
    const calls = recordApiCalls(page);
    await stubDemoConsole(page);
    await page.goto('/admin/dashboard?demo=1');
    await expect(page.getByText(DEMO_BADGE)).toBeVisible({ timeout: 20_000 });

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
    await expect(page.getByText(DEMO_BADGE)).toBeVisible();
  });
});
