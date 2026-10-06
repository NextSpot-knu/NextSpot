import { expect, test, type Page, type Route } from '@playwright/test';
import { E2E_ANON_USER_ID, stubExternalServices } from './support/stubs';

// 심사용 관리자 계정(openapi@gmail.com)은 전체 설정 저장이 403 으로 막힌다(apps/api/app/routers/admin.py).
// 그때 관제 화면은 '잠시 후 다시 시도' 가 아니라 그 이유를 보여 줘야 한다 — 몇 번을 눌러도 되지 않는
// 재시도를 권하지 않게. 서버 문장의 웹 사본은 lib/adminJudgeGuard.ts(단위 테스트가 서버 상수와 대조한다).

const JUDGE_SETTINGS_MESSAGE = '심사용 계정에서는 전체 설정을 바꿀 수 없어요.';
const RETRY_MESSAGE = '저장에 실패했습니다. 잠시 후 다시 시도해 주세요.';

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** 관리자 계정 + 설정 조회 성공 + 저장(PUT)만 `putStatus` 로 실패. 그 밖의 우리 API 는 빈 성공. */
async function stubAdminConsole(page: Page, putStatus: number): Promise<void> {
  // 설정 화면의 DB 통계(anon count)는 이 검증과 무관하다 — 빈 결과로 닫는다.
  await page.route('**/rest/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '*/0' }, body: '[]' }),
  );
  await page.route('**/api/v1/**', (route) => {
    const request = route.request();
    const url = request.url();
    if (url.includes('/account/me')) {
      return json(route, 200, {
        id: E2E_ANON_USER_ID,
        role: 'admin',
        is_anonymous: false,
        nickname: null,
        owned_facilities: [],
        pending_verification: false,
      });
    }
    if (url.includes('/admin/settings')) {
      if (request.method() === 'PUT') {
        return json(route, putStatus, { detail: putStatus === 403 ? JUDGE_SETTINGS_MESSAGE : 'Internal Server Error' });
      }
      return json(route, 200, {
        id: 1,
        maintenance_mode: false,
        notice_text: '경주 주요 관광지·맛집 혼잡 정보를 실시간으로 제공하고 있습니다.',
        congestion_threshold: 80,
        coldstart_weight: 50,
      });
    }
    return json(route, 200, {});
  });
}

/** 세션을 먼저 세운 뒤 설정 화면으로 — 첫 화면에서 조회가 세션보다 먼저 나가는 경합을 없앤다. */
async function openSettings(page: Page): Promise<void> {
  await page.goto('/login');
  await page.waitForFunction(() => Object.keys(localStorage).some((k) => /^sb-.*-auth-token$/.test(k)));
  await page.goto('/admin/settings');
  await expect(page.getByRole('button', { name: '변경사항 저장' })).toBeEnabled({ timeout: 30_000 });
}

test.beforeEach(async ({ page }) => stubExternalServices(page));

test('심사용 계정으로 막힌 설정 저장(403)은 재시도 대신 그 이유를 보여 준다', async ({ page }) => {
  await stubAdminConsole(page, 403);
  await openSettings(page);

  await page.getByRole('button', { name: '변경사항 저장' }).click();

  await expect(page.getByText(JUDGE_SETTINGS_MESSAGE)).toBeVisible();
  await expect(page.getByText(RETRY_MESSAGE)).toHaveCount(0);
});

test('그 밖의 저장 실패(500)는 기존 재시도 안내 그대로다', async ({ page }) => {
  await stubAdminConsole(page, 500);
  await openSettings(page);

  await page.getByRole('button', { name: '변경사항 저장' }).click();

  await expect(page.getByText(RETRY_MESSAGE)).toBeVisible();
  await expect(page.getByText(JUDGE_SETTINGS_MESSAGE)).toHaveCount(0);
});
