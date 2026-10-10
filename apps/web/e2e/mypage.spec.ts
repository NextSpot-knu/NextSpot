import { expect, test, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 마이페이지 — 새로 온 게스트에게 지어낸 '나의' 숫자를 보이지 않는다(2026-10-06 감사 I18, PM 결정 4.19a).
//
// 예전에는 방문 0 인 게스트에게 '누적 임팩트 [예시 값] 분산 유도 312건 · 절약된 대기 1,240분 · 참여 점포 14곳'과
// '나의 경주 여행 임팩트 – 312곳 이동 확정' 카드·공유 버튼, 로그아웃, 영어 'Explorer' 칩이 보였다.
// 지금은: 숫자 없음 → 시작 상태('지도에서 시작'), 실제 기록이 있을 때만 천 단위 구분된 숫자, 게스트에게 로그아웃 없음.
// 개인정보 화면 푸터는 '공모전 출품 버전' 대신 날짜다(I81).
// 콘솔 카드(기능 5 입구)는 메뉴·로그아웃 근처 맨 아래가 아니라 프로필 바로 아래, 첫 화면 안에 있다(I14).

type Account = { role: string; is_anonymous: boolean };
type Impact = { status: number; body: Record<string, unknown> };

const UNAUTHORIZED: Impact = { status: 401, body: { detail: 'unauthorized' } };

async function stubApis(page: Page, account: Account, impact: Impact): Promise<{ impactCalls: () => number }> {
  let impactCalls = 0;
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/v1/**', (route) => {
    const url = route.request().url();
    if (url.includes('/account/me')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', nickname: null, owned_facilities: [], pending_verification: false, ...account }),
      });
    }
    if (url.includes('/impact/summary')) {
      impactCalls += 1;
      return route.fulfill({ status: impact.status, contentType: 'application/json', body: JSON.stringify(impact.body) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  return { impactCalls: () => impactCalls };
}

test.beforeEach(async ({ page }) => stubExternalServices(page));

const ZERO_IMPACT: Impact = {
  status: 200,
  body: { accepted: 0, congestion_avoided: 0, coupons_issued: 0, coupons_used: 0, wait_saved_minutes: 0 },
};

test('a new guest sees no sample impact numbers, no sign-out and a Korean role chip', async ({ page }) => {
  test.setTimeout(90_000);
  // 실서비스의 게스트는 익명 세션이라 임팩트 API 가 0 으로 답한다.
  const api = await stubApis(page, { role: 'tourist', is_anonymous: true }, ZERO_IMPACT);
  await page.goto('/mypage');

  await expect(page.getByText('경주 여행자', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(api.impactCalls, { timeout: 20_000 }).toBeGreaterThan(0);
  // 출발점 카드는 그대로 있다(긍정 문구 · 임팩트 상세로) — 예시 숫자 카드 대신 이것이 첫 줄이다.
  await expect(page.getByText('지금부터 아낀 시간이 쌓입니다').first()).toBeVisible({ timeout: 20_000 });

  const body = page.locator('body');
  await expect(body).not.toContainText(/예시 값|312|1,240|Explorer|참여 점포|분산 유도/);
  await expect(page.getByRole('button', { name: '로그아웃' })).toHaveCount(0);
});

test('a guest whose impact call fails still sees no sample numbers after the retry', async ({ page }) => {
  test.setTimeout(90_000);
  await stubApis(page, { role: 'tourist', is_anonymous: true }, UNAUTHORIZED);
  await page.goto('/mypage');
  await expect(page.getByText('경주 여행자', { exact: true })).toBeVisible({ timeout: 30_000 });
  // 첫 실패 뒤 2.5초 유예 재시도까지 끝난 다음에 본다 — 예전에는 바로 그 시점에 예시 숫자가 떴다.
  await page.waitForTimeout(4_000);
  await expect(page.locator('body')).not.toContainText(/예시 값|312|1,240|참여 점포|분산 유도/);
});

test('a signed-in account keeps the sign-out button', async ({ page }) => {
  test.setTimeout(90_000);
  await stubApis(page, { role: 'tourist', is_anonymous: false }, UNAUTHORIZED);
  await page.goto('/mypage');
  await expect(page.getByRole('button', { name: '로그아웃' })).toBeVisible({ timeout: 30_000 });
});

test('the impact page starts with a map button instead of sample numbers or a share button', async ({ page }) => {
  test.setTimeout(90_000);
  await stubApis(page, { role: 'tourist', is_anonymous: true }, UNAUTHORIZED);
  await page.goto('/mypage/impact');

  await expect(page.getByText('첫 대안으로 이동하면 아낀 시간이 여기에 쌓여요')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('body')).not.toContainText(/예시 값|312|1,240|참여 점포/);
  await expect(page.getByRole('button', { name: /공유/ })).toHaveCount(0);
  await page.getByRole('button', { name: '지도에서 시작' }).click();
  await expect(page).toHaveURL(/\/main/, { timeout: 30_000 });
});

test('the impact page treats an all-zero record as the start state too', async ({ page }) => {
  test.setTimeout(90_000);
  await stubApis(page, { role: 'tourist', is_anonymous: true }, ZERO_IMPACT);
  await page.goto('/mypage/impact');
  await expect(page.getByRole('button', { name: '지도에서 시작' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /공유/ })).toHaveCount(0);
});

test('real impact numbers use thousands separators and drop the store count', async ({ page }) => {
  test.setTimeout(90_000);
  await stubApis(page, { role: 'tourist', is_anonymous: false }, {
    status: 200,
    body: { accepted: 1234, congestion_avoided: 2, coupons_issued: 1500, coupons_used: 0, wait_saved_minutes: 5 },
  });
  await page.goto('/mypage');
  await expect(page.getByText('대안으로 이동 1,234번')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('아낀 대기 5분')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('참여 점포');

  await page.goto('/mypage/impact');
  await expect(page.getByText('1,234곳')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('1,500장')).toBeVisible();
  await expect(page.getByRole('button', { name: '임팩트 카드 공유하기' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/참여 점포|예시 값/);
});

for (const [locale, footer] of [
  ['ko', '최종 업데이트 · 2026-10-06'],
  ['en', 'Last updated · 2026-10-06'],
  ['ja', '最終更新 · 2026-10-06'],
  ['zh', '最后更新 · 2026-10-06'],
] as const) {
  test(`${locale} privacy footer shows the update date, not a contest edition`, async ({ page }) => {
    await stubApis(page, { role: 'tourist', is_anonymous: true }, UNAUTHORIZED);
    await page.addInitScript((code) => localStorage.setItem('nextspot_locale', code), locale);
    await page.goto('/mypage/privacy');
    await expect(page.getByText(footer, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('body')).not.toContainText(/공모전|Contest|コンテスト|大赛/);
  });
}

// 게스트 이름은 고른 언어로 — 프로필 effect 가 첫 렌더(늘 ko)의 t 로 문장을 만들어 en·ja·zh 에도
// '게스트 탐험가' 가 남던 것(10-09 라이브 감사). 고치기 전에는 세 로케일 모두 실패한다.
for (const [locale, guest] of [
  ['en', 'Guest Explorer'],
  ['ja', 'ゲスト探検家'],
  ['zh', '访客探索者'],
] as const) {
  test(`${locale} guest profile name is in the chosen language`, async ({ page }) => {
    test.setTimeout(90_000);
    await stubApis(page, { role: 'tourist', is_anonymous: true }, ZERO_IMPACT);
    await page.addInitScript((code) => localStorage.setItem('nextspot_locale', code), locale);
    await page.goto('/mypage');
    await expect(page.getByRole('heading', { name: guest, exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('body')).not.toContainText('게스트 탐험가');
  });
}

// ── 마이페이지 콘솔 카드 ────────────────────────────────────────────────────

test('mypage shows the console preview right under the profile, in the first desktop view', async ({ page }) => {
  test.setTimeout(90_000);
  await stubApis(page, { role: 'tourist', is_anonymous: true }, ZERO_IMPACT);
  await page.setViewportSize({ width: 1536, height: 730 });
  await page.goto('/mypage');

  const preview = page.getByText('콘솔 미리보기');
  await expect(preview).toBeVisible({ timeout: 30_000 });
  const previewBox = (await preview.boundingBox())!;
  expect(previewBox.y + previewBox.height).toBeLessThan(730);
  // 메뉴 목록·로그아웃 근처(맨 아래)가 아니라 그보다 위에 있다.
  const menu = (await page.getByRole('button', { name: '여행 임팩트' }).boundingBox())!;
  expect(previewBox.y).toBeLessThan(menu.y);
  // 게스트에게는 실제 콘솔 카드가 없다.
  await expect(page.getByText('사장님 콘솔 열기')).toHaveCount(0);
});

test('mypage merchant card is translated and opens the console', async ({ page }) => {
  test.setTimeout(90_000);
  await stubApis(page, { role: 'merchant', is_anonymous: false }, ZERO_IMPACT);
  await page.addInitScript(() => localStorage.setItem('nextspot_locale', 'en'));
  await page.goto('/mypage');

  const card = page.getByRole('button', { name: /Open merchant console/ });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('비즈니스 계정으로 전환')).toHaveCount(0);
  await expect(page.getByText('Console preview')).toHaveCount(0);
  await card.click();
  await expect(page).toHaveURL(/\/merchant$/, { timeout: 30_000 });
});

// 관제 대시보드 카드도 사장님 카드처럼 번역된다 — 예전에는 영어·일본어·중국어 화면 첫 줄에 한국어
// '관제 대시보드 · 실시간 혼잡도 …' 가 그대로 떴다(2026-10-06 리뷰). 이름은 용어집(운영 대시보드)을 따른다.
const ADMIN_CARD = {
  ko: { title: '관제 대시보드 열기', desc: '실시간 혼잡도 · 안전 경보 · 통계 리포트 · 문의 관리' },
  en: { title: 'Open operations dashboard', desc: 'Live crowds, safety alerts, reports and inquiries' },
  ja: { title: '運営ダッシュボードを開く', desc: 'リアルタイム混雑・安全アラート・統計レポート・お問い合わせ管理' },
  zh: { title: '打开运营仪表盘', desc: '实时拥挤度、安全警报、统计报告、咨询管理' },
} as const;

for (const [locale, card] of Object.entries(ADMIN_CARD) as [keyof typeof ADMIN_CARD, (typeof ADMIN_CARD)[keyof typeof ADMIN_CARD]][]) {
  test(`${locale} mypage admin card is translated and opens the dashboard`, async ({ page }) => {
    test.setTimeout(90_000);
    await stubApis(page, { role: 'admin', is_anonymous: false }, ZERO_IMPACT);
    await page.addInitScript((code) => localStorage.setItem('nextspot_locale', code), locale);
    await page.goto('/mypage');

    const entry = page.getByRole('button', { name: new RegExp(card.title) });
    await expect(entry).toBeVisible({ timeout: 30_000 });
    await expect(entry).toContainText(card.desc);
    if (locale !== 'ko') await expect(page.locator('main')).not.toContainText(/관제|실시간 혼잡도/);
    await entry.click();
    await expect(page).toHaveURL(/\/admin\/dashboard$/, { timeout: 30_000 });
  });
}

// 일본어 관광객 화면에는 '管制' 를 쓰지 않는다(용어집 3.3) — 로그인한 계정이 보는 역할 변경 카드도 같다.
test('ja mypage role-request card names the operations dashboard, not 管制', async ({ page }) => {
  test.setTimeout(90_000);
  await stubApis(page, { role: 'tourist', is_anonymous: false }, ZERO_IMPACT);
  await page.addInitScript(() => localStorage.setItem('nextspot_locale', 'ja'));
  await page.goto('/mypage');

  const entry = page.getByRole('button', { name: /アカウント権限の変更申請/ });
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await expect(entry).toContainText('運営ダッシュボード');
  await expect(page.locator('body')).not.toContainText('管制');
});

// AI 취향 프로필(기능 2-⑤ 8축 레이더) — 4개 언어로, 엔진 말('벡터'·'8차원') 없이(2026-10-06 감사 I55).
// 수락 +10% · 거절 −5% 는 '자세히' 뒤에서 그대로 확인할 수 있다.
async function stubRadar(page: Page, locale: 'ko' | 'en') {
  await page.addInitScript((l) => localStorage.setItem('nextspot_locale', l), locale);
  await stubApis(page, { role: 'tourist', is_anonymous: true }, ZERO_IMPACT);
  await page.route('**/api/v1/users/me/vector', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ vector: [0.62, 0.48, 0.71, 0.35, 0.4, 0.55, 0.2, 0.3] }),
  }));
}

test('en: the taste radar speaks English end to end', async ({ page }) => {
  test.setTimeout(90_000);
  await stubRadar(page, 'en');
  await page.goto('/mypage');
  const radar = page.getByTestId('taste-radar');
  await expect(radar).toContainText('AI taste profile', { timeout: 30_000 });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(radar.locator('.recharts-wrapper')).toBeVisible();
  await expect(radar).toContainText('Restaurants');
  await expect(radar).toContainText('#Sightseeing');
  expect(await radar.innerText()).not.toMatch(/[가-힣]/);
});

// 어두운 테마(18~06시 자동) — 축 글자·격자가 밝은 테마 색으로 박혀 있으면 어두운 카드에서 거의 안 보인다.
test('dark: the radar axis labels and grid follow the theme colours', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => localStorage.setItem('nextspot_theme', 'dark'));
  await stubRadar(page, 'ko');
  await page.goto('/mypage');
  const radar = page.getByTestId('taste-radar');
  await expect(radar.locator('.recharts-polar-angle-axis-tick text').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('html')).toHaveClass(/nextspot-dark/);
  const colours = await radar.evaluate((el) => {
    const text = el.querySelector('.recharts-polar-angle-axis-tick text');
    const grid = el.querySelector('.recharts-polar-grid-concentric-polygon, .recharts-polar-grid-angle line');
    return { fill: text ? getComputedStyle(text).fill : null, stroke: grid ? getComputedStyle(grid).stroke : null };
  });
  expect(colours.fill, '축 글자가 어두운 테마의 보조 글자색이 아니다').toBe('rgb(196, 180, 159)');
  expect(colours.stroke, '격자가 어두운 테마의 선 색이 아니다').toBe('rgb(73, 58, 44)');
});

test('ko: the radar face has no engine words; +10% and −5% sit behind 자세히', async ({ page }) => {
  test.setTimeout(90_000);
  await stubRadar(page, 'ko');
  await page.goto('/mypage');
  const radar = page.getByTestId('taste-radar');
  await expect(radar).toContainText('AI 취향 프로필', { timeout: 30_000 });
  await expect(radar.locator('.recharts-wrapper')).toBeVisible();
  await expect(radar).not.toContainText(/벡터|8차원|추천 엔진/);
  await expect(radar).not.toContainText('+10%');
  await radar.getByRole('button', { name: '자세히' }).click();
  await expect(radar).toContainText('+10%');
  await expect(radar).toContainText('−5%');
});

// 기기 언어 — 언어를 고른 적 없는 첫 방문은 기기 언어로 보인다(10-10 실서비스 비교: 외국인 관광객이 한국어 첫 화면에서
// 언어 선택을 찾아야 했다). 자동으로 고른 언어는 저장하지 않고, 사용자가 고른 언어가 늘 이긴다.
test.describe('browser language on a first visit', () => {
  test.use({ locale: 'ja-JP' });

  // 첫 렌더는 늘 한국어다(정적 export) — 언어 바꾸기가 끝난 뒤를 봐야 '한국어로 남았다' 를 확인할 수 있다.
  const settle = async (page: Page) => {
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2_000);
  };

  test('a Japanese browser with no saved choice sees Japanese, and nothing is saved', async ({ page }) => {
    test.setTimeout(90_000);
    await stubApis(page, { role: 'tourist', is_anonymous: true }, ZERO_IMPACT);
    await page.goto('/mypage');
    await expect(page.getByRole('heading', { name: 'ゲスト探検家', exact: true })).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => localStorage.getItem('nextspot_locale'))).toBeNull();
  });

  test('Korean anywhere in the browser list keeps Korean (English-first browser of a Korean user)', async ({ page }) => {
    test.setTimeout(90_000);
    await stubApis(page, { role: 'tourist', is_anonymous: true }, ZERO_IMPACT);
    await page.addInitScript(() => Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'ko-KR'] }));
    await page.goto('/mypage');
    await expect(page.getByRole('heading', { name: '게스트 탐험가', exact: true })).toBeVisible({ timeout: 30_000 });
    await settle(page);
    await expect(page.getByRole('heading', { name: '게스트 탐험가', exact: true })).toBeVisible();
    await expect(page.getByText('Guest Explorer')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('ko');
  });

  test('the merchant console ignores the browser language (it has no language picker)', async ({ page }) => {
    test.setTimeout(90_000);
    await stubApis(page, { role: 'tourist', is_anonymous: true }, ZERO_IMPACT);
    await page.goto('/merchant?demo=1');
    await expect(page.getByRole('heading', { name: '지금 할인, 지금 발행' })).toBeVisible({ timeout: 30_000 });
    await settle(page);
    await expect(page.getByRole('heading', { name: '지금 할인, 지금 발행' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('ko');
  });

  test('a saved choice wins over the browser language', async ({ page }) => {
    test.setTimeout(90_000);
    await stubApis(page, { role: 'tourist', is_anonymous: true }, ZERO_IMPACT);
    await page.addInitScript(() => localStorage.setItem('nextspot_locale', 'ko'));
    await page.goto('/mypage');
    await expect(page.getByRole('heading', { name: '게스트 탐험가', exact: true })).toBeVisible({ timeout: 30_000 });
    await settle(page);
    await expect(page.getByText('ゲスト探検家')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('ko');
  });
});
