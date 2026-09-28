import { expect, test } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// /waiting 대표 카드(최소 높이 h-72): 영어·일본어는 대기 문구·배지가 두 줄씩 접혀 아래 숫자 블록이 커진다.
// 예전에는 그만큼 위 이름 블록이 0 까지 눌려, 사진과 숫자만 있고 **장소 이름이 없는** 카드가 됐다.
// 이름은 어떤 언어·폭에서도 적어도 한 줄은 온전히 보여야 하고, 이름·메뉴·소개는 줄 단위로만 잘린다
// (가로로 반쯤 잘린 줄 없음). 카드의 주인공인 대기 숫자와 맨 아래 근거 주석도 카드 안에 온전히 보인다.

test.beforeEach(async ({ page }) => stubExternalServices(page));

// 메뉴·소개가 긴 카드(두 줄씩 접힌다)와 짧은 카드를 섞는다 — 남는 높이가 카드마다 달라 자르는 자리도 다르다.
const LONG_FEATURES = {
  first_menu: '한우국밥, 육회비빔밥, 수육',
  overview_i18n: {
    en: 'A beloved gukbap house on Hwangnidan-gil serving slow-simmered beef soup since 1987, popular with locals and visitors alike.',
    ja: '皇理団通りにある老舗のクッパ店。1987年から牛骨スープを煮込み続け、地元の人にも観光客にも人気。',
    zh: '皇理团路上的老字号汤饭店，自1987年起熬制牛骨汤，深受本地人和游客喜爱。',
  },
};
const LONG_OVERVIEW = '황리단길에서 1987년부터 소뼈 국물을 우려 온 국밥집으로, 동네 사람과 여행객 모두에게 사랑받는 곳입니다.';

function item(id: string, name: string, rank: number, level: number, long = false) {
  const facility = {
    id, name, type: 'restaurant', latitude: 35.8363 + rank * 0.0006, longitude: 129.2107,
    capacity: 30, congestion: level, image_url: null, gallery_images: null, features: long ? LONG_FEATURES : {},
    overview: long ? LONG_OVERVIEW : '황리단길 국밥집', operating_hours: { open: '00:00~23:59', closed: '연중무휴' },
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
  item('n1', '분황사 쉼터', 0, 0.3, true),
  item('n2', '황남 국밥', 1, 0.4, true),
  item('n3', '월정교 식당', 2, 0.5),
];

const CASES = (['ko', 'en', 'ja', 'zh'] as const).flatMap((l) => [[l, 360], [l, 390]] as const);

for (const [locale, width] of CASES) {
  test(`waiting board (${locale}, ${width}px): every card keeps at least one full line of its place name`, async ({ page }) => {
    test.setTimeout(90_000); // 첫 /waiting 컴파일(Windows dev server) 여유 — 재시도가 아니라 시간
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
    await expect(cards).toHaveCount(3, { timeout: 60_000 });

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

    // 카드 = [사진, 본문[글 블록, 대기 스탯[대기 숫자, …, 근거 주석]]].
    const report = await cards.evaluateAll((buttons) => buttons.map((button) => {
      const card = button.getBoundingClientRect();
      const body = button.lastElementChild as HTMLElement;
      const intro = body.firstElementChild as HTMLElement;
      const stats = body.lastElementChild as HTMLElement;
      const clip = intro.getBoundingClientRect();
      const within = (el: Element, box: DOMRect) => {
        const r = el.getBoundingClientRect();
        return r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
      };
      // 보이는 글 줄마다: 블록 안에 통째로 들어가고, 높이가 줄 높이의 정수배(줄 단위로만 잘림).
      const paragraphs = Array.from(intro.children).filter((p) => getComputedStyle(p).display !== 'none').map((p) => {
        const r = p.getBoundingClientRect();
        const line = parseFloat(getComputedStyle(p).lineHeight);
        const lines = r.height / line;
        return {
          text: (p.textContent ?? '').slice(0, 16),
          inside: within(p, clip),
          wholeLines: Math.abs(lines - Math.round(lines)) < 0.05 && Math.round(lines) >= 1,
        };
      });
      const headline = stats.firstElementChild as HTMLElement;
      const footnote = stats.lastElementChild as HTMLElement;
      return {
        paragraphs,
        // 대기 숫자: 카드 안에 온전히, 글자가 상자 밖으로 넘치지 않는다.
        waitVisible: within(headline, card) && headline.scrollHeight <= headline.clientHeight + 1,
        waitText: headline.textContent ?? '',
        footnoteVisible: within(footnote, card),
      };
    }));
    for (const [i, card] of report.entries()) {
      for (const p of card.paragraphs) {
        expect(p.inside, `card ${i + 1} "${p.text}": 글 블록 밖으로 반쯤 나간 줄`).toBe(true);
        expect(p.wholeLines, `card ${i + 1} "${p.text}": 줄 단위로 잘리지 않음`).toBe(true);
      }
      expect(card.waitText.trim().length, `card ${i + 1}: 대기 숫자`).toBeGreaterThan(0);
      expect(card.waitVisible, `card ${i + 1}: 대기 숫자 "${card.waitText}" 가 온전히 보임`).toBe(true);
      expect(card.footnoteVisible, `card ${i + 1}: 근거 주석이 카드 안에 온전히 보임`).toBe(true);
    }
  });
}
