import { expect, test } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// /explore/recommend 의 by-type 대안 — **원래 장소와 같은 유형**을 묻는다.
//
// 추천 effect 는 userId 가 오면 시작하는데, userId 는 로컬 세션에서 바로 나오고 원래 장소는
// 네트워크 왕복 뒤에 온다. 그래서 effect 가 잡아 둔 originalFacility 는 대개 null 이었고, 대안이
// 늘 'restaurant' 로 나갔다 — 카페 화면의 '대안' 이 음식점으로 찼다. 여기서는 원래 장소 응답을
// 일부러 늦춰 그 순서를 고정하고, 개인화 추천을 두 번 실패시켜 대안 경로로 보낸다.

test.beforeEach(async ({ page }) => stubExternalServices(page));

const alternatives = [
  ['alt-a', '고요한 찻집'],
  ['alt-b', '박물관 카페'],
].map(([id, name], index) => ({
  recommendation_id: `rec-${id}`,
  facility: {
    id, name, type: 'cafe', latitude: 35.838 + index * 0.001, longitude: 129.209, capacity: 30,
    coupon_rate: 0, features: { indoor: true }, operating_hours: { open: '09:00~22:00', closed: '연중무휴' },
  },
  spot_score: 0.8 - index * 0.1, distance_m: 150 + index * 60, rank: index + 1, total_candidates: 2,
  breakdown: { preference: 0.8, wait_time: null, travel_time: 3, incentive: 0 },
  reason: `${name} 추천 사유`, reason_source: 'template',
  congestion_level: null, congestion_source: 'none', open_status_at_arrival: 'open_expected',
  scoring_mode: 'area_stats_rules', prediction_source: 'unavailable',
}));

test('카페에서 추천이 실패하면 대안도 카페로 묻는다', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => localStorage.setItem('nextspot_onboarding_done', '1'));

  await page.route('**/rest/v1/**', async (route) => {
    if (route.request().url().includes('/facilities')) {
      // 원래 장소는 추천 effect 가 시작된 뒤에 도착한다(실서비스의 흔한 순서).
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: 'origin-cafe', name: '황리단길 카페', type: 'cafe', features: {}, congestion_logs: [],
      }) });
      return;
    }
    await route.fulfill({ status: 200, headers: { 'content-range': '0-0/1' }, body: '[]' });
  });

  const byTypeBodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/api/v1/recommendations/by-type')) {
      byTypeBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(alternatives) });
    } else if (url.endsWith('/api/v1/recommendations')) {
      // 응답이 온 실패(타임아웃 아님) → 2.5초 뒤 1회 재시도 → 다시 실패 → by-type 대안.
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"fixture failure"}' });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
  });

  await page.goto('/explore/recommend?facilityId=origin-cafe&lat=35.838&lng=129.209');

  await expect(page.locator('section.space-y-4 h4')).toHaveText(['고요한 찻집', '박물관 카페'], { timeout: 30_000 });
  expect(byTypeBodies.length).toBeGreaterThan(0);
  for (const body of byTypeBodies) {
    expect(body.facility_type, '카페 화면의 대안을 다른 유형으로 물었다').toBe('cafe');
    expect(body.exclude_ids).toEqual(['origin-cafe']);
  }
});
