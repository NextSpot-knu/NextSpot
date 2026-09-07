import type { Page } from '@playwright/test';

// e2e 를 **정말로** 결정적으로 만드는 스텁 모음.
//
// 왜 생겼나: CI 워크플로는 이 묶음을 "결정적(실계정·GPS·지도 SDK·외부 네트워크 없이)" 이라고
// 적어 두었는데 **사실이 아니었다.** 앱은 부팅하면서 익명 세션을 만들려고
// `POST https://<project>.supabase.co/auth/v1/signup` 을 **프로덕션 Supabase 로 실제로** 보냈다.
//
// 그게 왜 테스트를 깨뜨리나: `recommendByType` 은 세션이 없으면 `AuthError` 를 던지고
// (`api-client.ts` — `if (!userId) throw new AuthError()`), ActiveJourneyCard 의 catch 가 그걸
// **'장애'** 로 표시한다. 그래서 서버가 정상적으로 '조건에 맞는 곳 0건' 을 준 상황이
// "추천을 불러오지 못했어요" 로 뒤바뀐다 — `empty` 와 `failed` 를 갈라 놓으려고 만든 판정
// (`lib/replanOutcome.ts`)이 인증 지연 하나에 무너지는 것이다.
//
// 로컬(빠른 네트워크)에서는 대개 제때 붙어서 통과하고, 러너가 느리거나 Supabase 가
// 레이트리밋을 걸면 실패한다 — 재시도를 해도 같은 제한에 걸리므로 재시도가 구해 주지 않는다.
// 2026-09-07 에 실제로 재현했다: `page.route('**/auth/v1/**', abort)` 하나만 걸면
// '다른 카테고리를 선택하거나…' 가 '추천을 불러오지 못했어요' 로 바뀐다.
//
// 그래서 여기서 인증을 **네트워크 없이** 끝낸다. 토큰은 우리 API 가 전부 스텁되어 있어
// 검증되지 않으므로 형식만 맞으면 된다.

/** 고정 익명 사용자 — 테스트가 uid 를 근거로 무언가 판단하면 여기서 바뀌지 않아야 한다. */
export const E2E_ANON_USER_ID = '00000000-0000-4000-8000-000000000001';

/** 형식만 갖춘 가짜 JWT. 서명은 검증되지 않는다(우리 API 는 스텁된다). */
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJhdWQiOiJhdXRoZW50aWNhdGVkIn0.' +
  'e2e-not-a-real-signature';

function anonymousSession() {
  // 만료를 멀리 둔다 — 가까우면 supabase-js 가 refresh 왕복을 시도해 외부 호출이 되살아난다.
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24;
  return {
    access_token: FAKE_JWT,
    token_type: 'bearer',
    expires_in: 60 * 60 * 24,
    expires_at: expiresAt,
    refresh_token: 'e2e-refresh-token',
    user: {
      id: E2E_ANON_USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      is_anonymous: true,
      app_metadata: { provider: 'anonymous', providers: ['anonymous'] },
      user_metadata: {},
      created_at: new Date(0).toISOString(),
    },
  };
}

/** 지도 SDK — 실제로 받아오지 않는다(원래부터 스텁하던 것). */
export async function stubKakaoSdk(page: Page): Promise<void> {
  await page.route('**://dapi.kakao.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: '/* Kakao SDK is intentionally unavailable in deterministic E2E. */',
    }),
  );
}

/**
 * Supabase 인증 — **외부 호출 없이** 익명 세션을 즉시 성립시킨다.
 *
 * `signup`(익명 로그인)과 `token`(갱신)은 세션을 돌려주고, 나머지 auth 경로는 빈 성공으로
 * 닫는다. 여기서 404 나 abort 를 주면 supabase-js 가 재시도하며 지연이 생겨,
 * 이 파일이 없애려는 바로 그 경합이 다시 생긴다.
 */
export async function stubSupabaseAuth(page: Page): Promise<void> {
  await page.route('**/auth/v1/**', (route) => {
    const url = route.request().url();
    if (url.includes('/auth/v1/signup') || url.includes('/auth/v1/token')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(anonymousSession()),
      });
    }
    if (url.includes('/auth/v1/user')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(anonymousSession().user),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

/** 모든 스펙의 beforeEach 가 부르는 한 줄. 외부로 나가는 것을 여기서 전부 막는다. */
export async function stubExternalServices(page: Page): Promise<void> {
  await stubKakaoSdk(page);
  await stubSupabaseAuth(page);
}
