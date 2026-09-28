import { expect, test } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// /waiting 대표 카드(고정 높이 h-72): 영어·일본어는 대기 문구·배지가 두 줄씩 접혀 아래 숫자 블록이 커진다.
// 예전에는 그만큼 위 이름 블록이 0 까지 눌려, 사진과 숫자만 있고 **장소 이름이 없는** 카드가 됐다.
// 이름은 어떤 언어·폭에서도 적어도 한 줄은 온전히 보여야 한다.

test.beforeEach(async ({ page }) => stubExternalServices(page));

function item(id: string, name: string, rank: number, level: number) {
  const facility = {
    id, name, type: 'restaurant', latitude: 35.8363 + rank * 0.0006, longitude: 129.2107,
    capacity: 30, congestion: level, image_url: null, gallery_images: null, features: {},
    overview: '황리단길 국밥집', operating_hours: { open: '00:00~23:59', closed: '연중무휴' },
  };
  return {
    recommendation_id: `rec-${id}`, facility, spot_score: 0.8 - rank * 0.01,
    breakdown: { preference: 0.8, wait_time: null, travel_time: rank + 3, incentive: 0 },
    distance_m: 190 + rank * 60, reason: '테스트 추천', reason_source: 'template',
    congestion_level: level, congestion_source: 'measured', congestion_log_source: 'user_report',
    congestion_is_stale: false, congestion_timestamp: new Date().toISOString(), rank: rank + 1, total_candidates: 3,
    open_status_at_arrival: 'open_expected', information_confidence: 'verified', eligibility_tier: 'verified_open_route',
    place_data_source: 'tourapi', data_updated_at: null,
    scoring_mode: 'degraded_rules', model_version: null, prediction_source: 'unavailable',
  };
}

const PLACES = [
  item('n1', '분황사 쉼터', 0, 0.3),
  item('n2', '황남 국밥', 1, 0.4),
  item('n3', '월정교 식당', 2, 0.5),
];

for (const [locale, width] of [['en', 360], ['en', 390], ['ja', 360]] as const) {
  test(`waiting board (${locale}, ${width}px): every card keeps at least one full line of its place name`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript((l) => {
      localStorage.setItem('nextspot_onboarding_done', '1');
      localStorage.setItem('nextspot_locale', l);
    }, locale);
    await page.route('**/api/v1/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith('/api/v1/recommendations/by-type')) {
        const type = String((route.request().postDataJSON() as { facility_type?: string }).facility_type ?? '');
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(type === 'restaurant' ? PLACES : []) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('/waiting');
    const cards = page.locator('div.grid-rows-\\[1fr_auto\\] > button');
    await expect(cards).toHaveCount(3, { timeout: 30_000 });

    for (const name of ['분황사 쉼터', '황남 국밥', '월정교 식당']) {
      const nameP = cards.locator('p', { hasText: name }).first();
      await expect(nameP).toHaveCount(1);
      // 이름 한 줄 높이만큼 잘리지 않고 보이는지: 이름 줄과 그것을 자르는 블록(overflow-hidden)의 겹침을 잰다.
      const { visible, line } = await nameP.evaluate((p) => {
        const r = p.getBoundingClientRect();
        const clip = p.parentElement!.getBoundingClientRect();
        const lineHeight = parseFloat(getComputedStyle(p).lineHeight);
        return { visible: Math.min(r.bottom, clip.bottom) - Math.max(r.top, clip.top), line: lineHeight };
      });
      expect(visible, `${name}: 보이는 이름 높이`).toBeGreaterThanOrEqual(line - 0.5);
    }
  });
}
