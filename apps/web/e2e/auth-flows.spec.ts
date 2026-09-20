import { expect, test, type Page, type Route } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 인증 흐름 회귀 — **심사위원이 직접 눌러 보는** 경로만 모았다.
//
// 지키려는 것은 기능이 아니라 '막히지 않는 것' 이다:
//   · 실패한 뒤 버튼이 다시 눌리는가(스피너·비활성 잠김 금지)
//   · 실패 문구가 원인을 맞게 말하는가(서버 장애를 '비밀번호가 틀렸다' 로 말하지 않는다)
//   · 어느 화면에서도 앞으로 갈 길이 남는가(막다른 콜백·토큰 없는 비밀번호 변경 화면)
//   · 로그인 없이 둘러보기가 살아 있는가(이 제품의 핵심 약속)
//
// 실계정은 어디에도 쓰지 않는다. Supabase 응답은 전부 스텁이고, 입력값은 명백한 가짜다
// (`@example.invalid` — 예약 TLD 라 실제로 존재할 수 없다).

const FAKE_EMAIL = 'judge-demo@example.invalid';
const FAKE_PASSWORD = 'not-a-real-password';

/** 로그인에 성공한 '정회원' 세션. 익명 세션(support/stubs.ts)과 달리 is_anonymous=false 다. */
const MEMBER_USER = {
  id: '00000000-0000-4000-8000-0000000000aa',
  aud: 'authenticated',
  role: 'authenticated',
  email: FAKE_EMAIL,
  is_anonymous: false,
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { full_name: '심사용 계정' },
  identities: [{ provider: 'email', id: 'x' }],
  created_at: new Date(0).toISOString(),
};

function memberSession() {
  return {
    access_token: 'e2e-member-token',
    token_type: 'bearer',
    expires_in: 86_400,
    expires_at: Math.floor(Date.now() / 1000) + 86_400,
    refresh_token: 'e2e-member-refresh',
    user: MEMBER_USER,
  };
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * auth 경로 중 **이 테스트가 관심 있는 것만** 가로챈다.
 *
 * 나머지는 route.fallback() 으로 support/stubs.ts 의 익명 세션 스텁에 넘긴다 —
 * 앱 부팅(익명 로그인)이 계속 네트워크 없이 성립해야 하기 때문이다.
 * Playwright 는 **나중에 등록한 핸들러가 먼저** 잡으므로 이 함수는 beforeEach 뒤에 부른다.
 */
async function interceptAuth(
  page: Page,
  match: (url: string) => boolean,
  reply: { status: number; body: unknown },
): Promise<void> {
  await page.route('**/auth/v1/**', async (route) => {
    if (match(route.request().url())) await json(route, reply.status, reply.body);
    else await route.fallback();
  });
}

const passwordGrant = (url: string) => url.includes('/auth/v1/token') && url.includes('grant_type=password');

/** 우리 백엔드는 전부 빈 성공으로 닫는다(로그인 후처리: 저장 목록 동기화·역할 조회 등). */
async function stubOurApi(page: Page, account: Record<string, unknown> = {}): Promise<void> {
  await page.route('**/api/v1/**', (route) => {
    const url = route.request().url();
    if (url.includes('/account/me')) {
      return json(route, 200, {
        id: MEMBER_USER.id,
        role: 'tourist',
        is_anonymous: false,
        nickname: null,
        owned_facilities: [],
        pending_verification: false,
        ...account,
      });
    }
    return json(route, 200, {});
  });
}

const submitButton = (page: Page) => page.locator('form button[type="submit"]');

test.beforeEach(async ({ page }) => stubExternalServices(page));

// ── 로그인 성공 ─────────────────────────────────────────────────────────────

test('로그인에 성공하면 /main 으로 넘어간다', async ({ page }) => {
  await stubOurApi(page);
  await interceptAuth(page, passwordGrant, { status: 200, body: memberSession() });

  await page.goto('/login');
  await page.getByPlaceholder('이메일').fill(FAKE_EMAIL);
  await page.getByPlaceholder('비밀번호').fill(FAKE_PASSWORD);
  await submitButton(page).click();

  await expect(page).toHaveURL(/\/main/, { timeout: 20_000 });
});

test('?next= 로 요청된 목적지가 로그인 뒤에 지켜진다', async ({ page }) => {
  await stubOurApi(page);
  await interceptAuth(page, passwordGrant, { status: 200, body: memberSession() });

  await page.goto('/login?next=/saved');
  await page.getByPlaceholder('이메일').fill(FAKE_EMAIL);
  await page.getByPlaceholder('비밀번호').fill(FAKE_PASSWORD);
  await submitButton(page).click();

  await expect(page).toHaveURL(/\/saved/, { timeout: 20_000 });
});

// ── 로그인 실패: 원인별로 다른 말을 한다 ────────────────────────────────────

test('비밀번호가 틀리면 자격증명 안내가 뜨고 버튼이 다시 눌린다', async ({ page }) => {
  await stubOurApi(page);
  await interceptAuth(page, passwordGrant, {
    status: 400,
    body: { error: 'invalid_grant', error_code: 'invalid_credentials', msg: 'Invalid login credentials' },
  });

  await page.goto('/login');
  await page.getByPlaceholder('이메일').fill(FAKE_EMAIL);
  await page.getByPlaceholder('비밀번호').fill(FAKE_PASSWORD);
  await submitButton(page).click();

  await expect(page.getByText('이메일 또는 비밀번호가 올바르지 않아요.')).toBeVisible({ timeout: 15_000 });
  // 핵심: 실패한 뒤에도 다시 시도할 수 있어야 한다(버튼 잠김 금지).
  await expect(submitButton(page)).toBeEnabled();
  await expect(page).toHaveURL(/\/login/);
});

test('서버 장애(500)는 비밀번호 탓으로 말하지 않고 버튼도 살아 있다', async ({ page }) => {
  await stubOurApi(page);
  await interceptAuth(page, passwordGrant, {
    status: 500,
    body: { error: 'unexpected_failure', msg: 'Internal Server Error' },
  });

  await page.goto('/login');
  await page.getByPlaceholder('이메일').fill(FAKE_EMAIL);
  await page.getByPlaceholder('비밀번호').fill(FAKE_PASSWORD);
  await submitButton(page).click();

  // 장애 안내가 뜬다 — 그리고 '비밀번호가 틀렸다' 는 **뜨지 않는다**.
  await expect(page.getByText('문제가 발생했어요')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('이메일 또는 비밀번호가 올바르지 않아요.')).toHaveCount(0);
  await expect(submitButton(page)).toBeEnabled();
});

test('빈 입력으로 제출하면 안내만 뜨고 화면이 잠기지 않는다', async ({ page }) => {
  await stubOurApi(page);
  await page.goto('/login');
  await submitButton(page).click();

  await expect(page.getByText('이메일과 비밀번호를 입력해 주세요.')).toBeVisible({ timeout: 10_000 });
  await expect(submitButton(page)).toBeEnabled();
});

// ── 회원가입 ────────────────────────────────────────────────────────────────

test('이미 가입된 이메일이면 로그인 탭으로 되돌린다', async ({ page }) => {
  await stubOurApi(page);
  // 게스트(익명) 세션 위에서 가입하면 PUT /user 승격 경로를 탄다.
  // ⚠️ 익명 로그인도 POST /auth/v1/signup 이다 — 그걸 같이 막으면 세션이 없는 채로 테스트가
  //    돌아 승격 경로를 아예 지나치지 못한다. **이메일이 실린 요청만** 가로챈다.
  await page.route('**/auth/v1/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const carriesEmail = (route.request().postData() ?? '').includes(FAKE_EMAIL);
    if (carriesEmail && ((url.includes('/auth/v1/user') && method === 'PUT') || url.includes('/auth/v1/signup'))) {
      await json(route, 422, {
        code: 'email_exists',
        error_code: 'email_exists',
        msg: 'A user with this email address has already been registered',
      });
      return;
    }
    await route.fallback();
  });

  await page.goto('/login');
  await page.getByRole('button', { name: '회원가입', exact: true }).first().click();
  await page.getByPlaceholder('이메일').fill(FAKE_EMAIL);
  await page.getByPlaceholder('비밀번호').fill(FAKE_PASSWORD);
  await submitButton(page).click();

  await expect(page.getByText('이미 가입된 이메일이에요. 로그인 탭에서 로그인해 주세요.')).toBeVisible({ timeout: 15_000 });
  // 재시도해도 소용없는 실패라 로그인 탭으로 옮겨 준다 — 제출 버튼이 '로그인' 으로 바뀐다.
  await expect(submitButton(page)).toHaveText('로그인');
  await expect(submitButton(page)).toBeEnabled();
});

// ── 게스트 둘러보기 — 이 제품의 핵심 약속 ───────────────────────────────────

test('로그인 없이 둘러보기가 살아 있다', async ({ page }) => {
  await stubOurApi(page);
  await page.goto('/login');
  const guest = page.getByRole('button', { name: '게스트로 둘러보기' });
  await expect(guest).toBeVisible();
  await guest.click();
  await expect(page).toHaveURL(/\/setup/, { timeout: 20_000 });
});

// ── 비밀번호 재설정 ─────────────────────────────────────────────────────────

test('재설정 메일 요청이 성공하면 안내가 뜬다', async ({ page }) => {
  await stubOurApi(page);
  await interceptAuth(page, (url) => url.includes('/auth/v1/recover'), { status: 200, body: {} });

  await page.goto('/forgot-password');
  await page.getByPlaceholder('이메일').fill(FAKE_EMAIL);
  await submitButton(page).click();

  await expect(page.getByText(/메일을 보냈습니다/)).toBeVisible({ timeout: 15_000 });
});

test('재설정 메일 요청이 실패해도 버튼이 잠기지 않는다', async ({ page }) => {
  await stubOurApi(page);
  await interceptAuth(page, (url) => url.includes('/auth/v1/recover'), {
    status: 500,
    body: { msg: 'Internal Server Error' },
  });

  await page.goto('/forgot-password');
  await page.getByPlaceholder('이메일').fill(FAKE_EMAIL);
  await submitButton(page).click();

  await expect(page.getByText('재설정 메일을 보내지 못했습니다. 다시 시도해 주세요.')).toBeVisible({ timeout: 15_000 });
  await expect(submitButton(page)).toBeEnabled();
});

test('토큰 없이 비밀번호 변경 화면에 들어오면 폼 대신 다음 걸음을 준다', async ({ page }) => {
  await stubOurApi(page);
  await page.goto('/auth/reset-password');

  // 될 수 없는 폼을 보여 주고 다 입력한 뒤에 실패시키지 않는다.
  await expect(page.getByText(/링크가 만료되었거나 올바르지 않습니다/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByPlaceholder('새 비밀번호')).toHaveCount(0);
  // 막다른 길 금지 — 메일 다시 받기 / 로그인 두 갈래가 있어야 한다.
  await expect(page.getByRole('button', { name: '재설정 링크 보내기' })).toBeVisible();
  await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeVisible();
});

test('만료된 재설정 링크는 메일을 다시 받도록 안내한다', async ({ page }) => {
  await stubOurApi(page);
  // Supabase 는 만료된 링크를 error 쿼리와 함께 콜백으로 돌려보낸다.
  await page.goto('/auth/callback?next=/auth/reset-password&error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');

  await expect(page.getByText(/링크가 만료되었거나 올바르지 않습니다/)).toBeVisible({ timeout: 15_000 });
  const again = page.getByRole('button', { name: '재설정 링크 보내기' });
  await expect(again).toBeVisible();
  await again.click();
  await expect(page).toHaveURL(/\/forgot-password/, { timeout: 15_000 });
});

// ── 콜백 ────────────────────────────────────────────────────────────────────

test('동의를 취소하고 돌아오면 즉시 안내와 나갈 길이 보인다', async ({ page }) => {
  await stubOurApi(page);
  await page.goto('/auth/callback?provider=kakao&error=access_denied&error_description=User+denied+access');

  await expect(page.getByText('로그인을 완료하지 못했어요')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: '마이페이지로' })).toBeVisible();
  await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeVisible();
});

test('주소만 치고 들어온 콜백은 스피너로 끝나지 않는다', async ({ page }) => {
  await stubOurApi(page);
  // 교환할 code 도, 연동 계정 세션도 없는 상태(익명 세션만 있다).
  await page.goto('/auth/callback');

  // 무한 스피너 금지 — 폴링 한도(~8초) 안에 실패 안내와 나갈 길이 나온다.
  await expect(page.getByText('로그인을 완료하지 못했어요')).toBeVisible({ timeout: 30_000 });
  const back = page.getByRole('button', { name: '로그인', exact: true });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
});
