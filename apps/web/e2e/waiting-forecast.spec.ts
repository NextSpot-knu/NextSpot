import { expect, test, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// /waiting 권역 수요 곡선(lib/areaDemandCurve.ts) — 서버는 도착 30분~6시간 뒤만 전망한다(밖이면 422).
// 분 30 이후에 열면 예전에는 다음 정시(H+1:00)가 창 밖이라 422 로 빠졌고, 도착 정시의 키가 비어
// 받아 온 곡선 전체가 쓰이지 않았다. 지금은 그 정시를 창 안(지금+32분)으로 당겨 묻는다.
//
// 요일이 중요하다: 2026-10-05 는 **월요일**이다. 토요일에 돌리면 'sat_afternoon'(토 14:00)이 같은 날
// 창 안에 들어와 '먼 프리셋은 묻지 않는다' 검사가 뜻을 잃는다.
//
// 횟수를 정확히 세지 않는다 — `next dev` 는 Strict Mode 라 effect 가 두 번 돌고, 첫 번째 실행의
// 선행 요청이 취소 전에 기록될 수 있다. 그래서 **어느 시를 물었는지(집합)** 와 창 안인지만 본다.

const NOW = new Date('2026-10-05T03:45:00Z'); // 월 12:45 KST
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

test.beforeEach(async ({ page }) => stubExternalServices(page));

async function recordForecasts(page: Page): Promise<string[]> {
  const arrivals: string[] = [];
  // 먼저 등록한 경로가 가장 낮은 우선순위다.
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  // 응답을 준 요청은 재시도되지 않는다 — 기록은 핸들러에서 한다.
  await page.route('**/api/v1/area-demand/forecast**', (route) => {
    const arrival = new URL(route.request().url()).searchParams.get('arrival_at');
    if (arrival) arrivals.push(arrival);
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"available":false}' });
  });
  return arrivals;
}

test('대기 보드는 서버 창 밖 전망을 묻지 않는다', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  const arrivals = await recordForecasts(page);

  await page.goto('/waiting');

  const hoursOf = () =>
    [...new Set(arrivals.map((a) => new Date(new Date(a).getTime() + KST_OFFSET_MS).getUTCHours()))].sort((a, b) => a - b);
  await expect.poll(hoursOf, { timeout: 30_000 }).toEqual([13, 14, 15, 16, 17, 18]);

  const lo = NOW.getTime() + 30 * 60 * 1000;
  const hi = NOW.getTime() + 6 * 60 * 60 * 1000;
  for (const a of arrivals) {
    const t = new Date(a).getTime();
    expect(t, `서버 창 밖 도착 시각을 물었다: ${a}`).toBeGreaterThanOrEqual(lo);
    expect(t, `서버 창 밖 도착 시각을 물었다: ${a}`).toBeLessThanOrEqual(hi);
  }

  // 먼 프리셋(토 14:00 — 5일 뒤)은 한 건도 묻지 않는다(예전에는 422 가 확실한 요청 6건).
  await page.evaluate(() => localStorage.setItem('nextspot_assumed_at', 'sat_afternoon'));
  arrivals.length = 0;
  await page.reload();
  await expect(page.locator('body')).toBeVisible();
  // 곡선 조회는 마운트 직후에 시작한다. 보드가 자리를 잡을 시간을 준 뒤 0 건인지 본다.
  await page.waitForTimeout(3000);
  expect(arrivals).toEqual([]);
});
