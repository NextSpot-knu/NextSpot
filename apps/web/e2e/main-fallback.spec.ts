import { expect, test } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 지도 비상 경로(lib/mapFacilityFallback.ts) — 백엔드 /infrastructures 가 멈췄을 때 지도는 Supabase 를
// 직접 읽는다. 예전 경로는 영업 중지·폐업 시설까지 그렸고(is_active 없음), 갤러리 사진을 읽지 않았고,
// congestion_logs 최신 1000행에서 시설별 최신을 골라 제보가 몰린 시설이 다른 시설을 밀어냈다.
//
// 횟수를 정확히 세지 않는다: `next dev` 는 Strict Mode 라 effect 가 두 번 돈다. 또 신선도 폴백이
// `facilities?select=updated_at` 도 부르므로, 지도 조회는 select 에 latitude 가 있는 요청만 본다.

test.beforeEach(async ({ page }) => stubExternalServices(page));

test('API 가 멈추면 지도는 Supabase 에서 활성 시설만 읽는다', async ({ page }) => {
  const facilityUrls: URL[] = [];
  const rpcBodies: Array<{ facility_ids?: unknown[] }> = [];
  const congestionLogHits: string[] = [];

  // 먼저 등록한 경로가 가장 낮은 우선순위다(Playwright 는 마지막에 등록한 route 부터 본다).
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  // 상태 코드 응답은 재시도되지 않으므로(B4) 곧바로 비상 경로가 돈다.
  await page.route('**/api/v1/infrastructures**', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"restarting"}' }),
  );
  await page.route('**/rest/v1/**', (route) => {
    const url = route.request().url();
    if (url.includes('/rest/v1/congestion_logs')) congestionLogHits.push(url);
    return route.fulfill({ status: 200, headers: { 'content-range': '0-0/0' }, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/rest/v1/facilities**', (route) => {
    const url = new URL(route.request().url());
    const select = url.searchParams.get('select') ?? '';
    if (!select.includes('latitude')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
    facilityUrls.push(url);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: '00000000-0000-4000-8000-00000000f001', name: '고요한 찻집', type: 'cafe',
          latitude: 35.838, longitude: 129.209, capacity: 30, operating_hours: null, features: {},
          address: null, image_url: null, gallery_images: ['https://example.test/g1.jpg', ''],
          phone: null, homepage: null, overview: null, barrier_free: null, contentid: null, contenttypeid: null,
        },
        {
          id: '00000000-0000-4000-8000-00000000f002', name: '한옥 쉼터', type: 'restaurant',
          latitude: 35.836, longitude: 129.211, capacity: 40, operating_hours: null, features: {},
          address: null, image_url: null, gallery_images: null,
          phone: null, homepage: null, overview: null, barrier_free: null, contentid: null, contenttypeid: null,
        },
      ]),
    });
  });
  await page.route('**/rest/v1/rpc/latest_congestion_for_facilities', (route) => {
    rpcBodies.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          facility_id: '00000000-0000-4000-8000-00000000f001', congestion_level: 0.4, current_count: null,
          timestamp: new Date().toISOString(), source: 'user_report', evidence_tier: 'single_report',
        },
      ]),
    });
  });

  await page.goto('/main');

  await expect.poll(() => facilityUrls.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(() => rpcBodies.length, { timeout: 30_000 }).toBeGreaterThan(0);

  for (const url of facilityUrls) {
    expect(url.searchParams.get('is_active')).toBe('eq.true');
    expect(url.searchParams.get('order')).toBe('id.asc');
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.get('limit')).toBe('1000');
    expect(url.searchParams.get('select') ?? '').toContain('gallery_images');
  }
  for (const body of rpcBodies) {
    expect(Array.isArray(body.facility_ids) ? body.facility_ids.length : -1).toBe(2);
  }
  expect(congestionLogHits).toEqual([]);
  await expect(page.getByText('장소 정보를 불러오지 못했어요')).toHaveCount(0);
});
