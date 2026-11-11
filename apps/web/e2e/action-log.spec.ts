import { expect, test, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';
import { stubMain } from './support/mainStubs';
import { stubFakeKakaoMap } from './support/fakeKakaoMap';

// 접속·조작 기록(lib/actionLog) — 브라우저가 실제로 보내는 줄을 가로채 본다.
//
// 이 기록은 운영 주소의 사람 브라우저에서만 켜진다. Playwright 는 navigator.webdriver=true 라 원래 꺼지므로
// window.__NEXTSPOT_ACTION_LOG__='force' 로 켠다(addInitScript — 앱 스크립트보다 먼저). POST /rest/v1/action_logs 는
// 201 로 받아 몸통(줄 배열)을 모은다. 나머지 외부 호출은 support/stubs 가 막는다.
//
// 지키는 것: 방문 하나가 session_start · page_view · click · search 를 남긴다 · 화면 이동은 nav=route 로 이어진다 ·
// 로그인 칸에 친 이메일·비밀번호는 어떤 줄에도 없다 · 주소창·시설의 좌표도 어떤 줄에도 없다.

interface LogRow {
  occurred_at: string;
  device_id: string;
  session_id: string;
  seq: number;
  event: string;
  page: string;
  host: string;
  locale: string;
  props: Record<string, unknown>;
}

interface Captured {
  bodies: string[];
  headers: Record<string, string>[];
  /** (session_id, seq) 로 하나씩 — 다시 보내기로 같은 줄이 두 번 와도 한 줄로 본다. */
  rows: () => LogRow[];
  /** 같은 (session_id, seq) 에 내용이 다른 줄이 온 경우 — 순번이 겹쳤다는 뜻이다. */
  conflicts: () => string[];
}

async function captureActionLogs(page: Page): Promise<Captured> {
  const bodies: string[] = [];
  const headers: Record<string, string>[] = [];
  const byKey = new Map<string, LogRow>();
  const conflicts: string[] = [];
  await page.addInitScript(() => {
    (window as unknown as { __NEXTSPOT_ACTION_LOG__?: string }).__NEXTSPOT_ACTION_LOG__ = 'force';
  });
  // 다른 스텁(**/rest/v1/** → [])보다 나중에 등록해야 이긴다.
  await page.route('**/rest/v1/action_logs**', async (route) => {
    const request = route.request();
    const body = request.postData() ?? '';
    bodies.push(body);
    headers.push(request.headers());
    try {
      for (const row of JSON.parse(body) as LogRow[]) {
        const key = `${row.session_id}#${row.seq}`;
        const seen = byKey.get(key);
        if (seen && JSON.stringify(seen) !== JSON.stringify(row)) conflicts.push(key);
        else byKey.set(key, row);
      }
    } catch {
      /* 배열이 아닌 몸통은 아래 검사가 잡는다 */
    }
    await route.fulfill({
      status: 201,
      headers: { 'Access-Control-Allow-Origin': request.headers().origin ?? '*' },
      body: '',
    });
  });
  return { bodies, headers, rows: () => [...byKey.values()], conflicts: () => [...conflicts] };
}

const FACILITY = {
  id: 'r1',
  name: '황남 쌈밥',
  type: 'restaurant',
  latitude: 35.8372,
  longitude: 129.2095,
  capacity: 30,
  features: {},
  congestion: null,
  operating_hours: { open: '24시간', closed: '연중무휴' },
};

function recFor(type: string) {
  return [FACILITY].filter((f) => f.type === type).map((facility) => ({
    recommendation_id: `rec-${facility.id}`,
    facility,
    spot_score: 0.7,
    distance_m: 110,
    rank: 1,
    total_candidates: 1,
    reason: '고정 추천 사유',
    reason_source: 'template',
    congestion_level: null,
    congestion_source: 'none',
    open_status_at_arrival: 'open_expected',
    scoring_mode: 'degraded_rules',
    prediction_source: 'unavailable',
    breakdown: { preference: 0.7, wait_time: null, travel_time: 2, incentive: 0 },
  }));
}

const COORDINATE_KEYS = /"(lat|lng|lon|latitude|longitude|mapx|mapy)"\s*:/;

test('a guest visit leaves session_start, page_view, click and search rows — and no coordinates', async ({ page }) => {
  test.setTimeout(120_000);
  // 넓은 화면 — 왼쪽 레일의 탭이 카드에 가리지 않는다.
  await page.setViewportSize({ width: 1536, height: 730 });
  await stubMain(page, { facilities: [FACILITY], byType: recFor });
  await stubFakeKakaoMap(page);
  const log = await captureActionLogs(page);

  // 주소창에 좌표가 실려 와도 기록에는 [geo] 로만 남는다.
  await page.goto('/main?lat=35.8372&lng=129.2095');
  await expect(page.getByTestId('recommendation-card')).toBeVisible({ timeout: 25_000 });

  const search = page.getByPlaceholder('경주 장소·메뉴·분위기 검색');
  await search.click();
  await search.fill('황남');
  await search.press('Enter');

  await page.locator('nav[aria-label="주요 내비게이션"]:visible').getByRole('button', { name: '마이' }).click();
  await expect(page).toHaveURL(/\/mypage/, { timeout: 30_000 });

  // 3초 묶음으로 나간다 — 모일 때까지 기다린다.
  await expect.poll(() => log.rows().map((r) => r.event), { timeout: 30_000 })
    .toEqual(expect.arrayContaining(['session_start', 'page_view', 'click', 'search']));
  await expect.poll(() => log.rows().some((r) => r.event === 'page_view' && r.page === '/mypage'), { timeout: 30_000 }).toBe(true);
  const rows = log.rows();

  // 한 기기 · 한 세션, 첫 줄은 session_start(순번 0), 순번은 겹치지 않는다.
  expect(new Set(rows.map((r) => r.device_id)).size).toBe(1);
  expect(new Set(rows.map((r) => r.session_id)).size).toBe(1);
  expect(rows.every((r) => Number.isInteger(r.seq) && r.seq >= 0)).toBe(true);
  expect(log.conflicts()).toEqual([]);
  const start = rows.find((r) => r.event === 'session_start')!;
  expect(start.seq).toBe(0);
  expect(start.host).toBe(new URL(page.url()).host);
  expect(start.locale).toBe('ko');
  expect(start.props.landing).toBe('/main?lat=[geo]&lng=[geo]');

  const landing = rows.find((r) => r.event === 'page_view' && r.page === '/main')!;
  expect(landing.props).toMatchObject({ nav: 'load', from: null, query: '?lat=[geo]&lng=[geo]' });
  const moved = rows.find((r) => r.event === 'page_view' && r.page === '/mypage')!;
  expect(moved.props).toMatchObject({ nav: 'route', from: '/main' });

  expect(rows.some((r) => r.event === 'click' && r.props.tag === 'input' && r.props.name === '경주 장소·메뉴·분위기 검색')).toBe(true);
  expect(rows.some((r) => r.event === 'click' && r.props.name === '마이' && r.page === '/main')).toBe(true);
  const searched = rows.find((r) => r.event === 'search' && r.props.via === 'enter');
  expect(searched?.props).toMatchObject({ q: '황남', source: 'main', via: 'enter' });

  // API 호출은 경로만 — 쿼리스트링은 담지 않는다.
  const api = rows.filter((r) => r.event === 'api');
  expect(api.length).toBeGreaterThan(0);
  for (const row of api) {
    expect(String(row.props.path)).not.toContain('?');
    expect(['api', 'supabase']).toContain(row.props.svc);
  }

  // 좌표는 어디에도 — 주소창의 lat/lng, 시설 좌표, 좌표 이름의 칸.
  const all = log.bodies.join('\n');
  expect(all).not.toContain('35.8372');
  expect(all).not.toContain('129.2095');
  expect(all).not.toMatch(COORDINATE_KEYS);

  // 전송 규약 — anon 키 머리말 · 응답 없이 넣기 · 한 번에 50줄 이하.
  expect(log.headers[0].apikey).toBeTruthy();
  expect(log.headers[0].authorization).toMatch(/^Bearer /);
  expect(log.headers[0].prefer).toBe('return=minimal');
  expect(log.headers[0]['content-type']).toContain('application/json');
  for (const body of log.bodies) expect((JSON.parse(body) as unknown[]).length).toBeLessThanOrEqual(50);
});

test('an email and a password typed on the login form never reach the log', async ({ page }) => {
  test.setTimeout(90_000);
  await stubExternalServices(page);
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const log = await captureActionLogs(page);

  // 명백한 가짜 값(@example.invalid — 예약 TLD).
  const email = 'action-log-check@example.invalid';
  const password = 'never-log-this-password-9271';

  await page.goto('/login');
  const emailBox = page.getByPlaceholder('이메일');
  const passwordBox = page.getByPlaceholder('비밀번호');
  await expect(emailBox).toBeVisible({ timeout: 30_000 });
  await emailBox.click();
  await emailBox.fill(email);
  await passwordBox.click(); // 이메일 칸의 change 가 여기서 난다
  await passwordBox.fill(password);
  await page.locator('form button[type="submit"]').click(); // 비밀번호 칸의 change, 그다음 submit

  await expect.poll(() => log.rows().filter((r) => r.event === 'input').map((r) => r.props.type), { timeout: 30_000 })
    .toEqual(expect.arrayContaining(['email', 'password']));
  await expect.poll(() => log.rows().some((r) => r.event === 'submit'), { timeout: 30_000 }).toBe(true);

  const rows = log.rows();
  for (const row of rows.filter((r) => r.event === 'input')) {
    // 칸 이름과 종류만 — 값도, 이메일·비밀번호 칸은 길이도 없다.
    expect(row.props).not.toHaveProperty('value');
    expect(row.props).not.toHaveProperty('length');
  }
  const submitted = rows.find((r) => r.event === 'submit')!;
  expect(submitted.props).not.toHaveProperty('q');

  const all = log.bodies.join('\n');
  expect(all).not.toContain(email);
  expect(all).not.toContain('example.invalid');
  expect(all).not.toContain(password);
  expect(all).not.toMatch(COORDINATE_KEYS);
});
