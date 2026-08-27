import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**://dapi.kakao.com/**', route => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: '/* Kakao SDK is intentionally unavailable in deterministic E2E. */',
  }));
});

const facilities = [
  { id: 'restaurant-1', name: '실내 식당', type: 'restaurant', latitude: 35.8363, longitude: 129.2107,
    capacity: 30, features: {}, congestion: null,
    operating_hours: { open: '00:00~23:59', closed: '연중무휴' } },
  { id: 'cafe-1', name: '실내 카페', type: 'cafe', latitude: 35.8364, longitude: 129.2107,
    capacity: 20, features: {}, congestion: null,
    operating_hours: { open: '00:00~23:59', closed: '연중무휴' } },
];

async function mockMainWithSpeech(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    class MockUtterance {
      text: string; lang = ''; rate = 1; pitch = 1; volume = 1; voice = null;
      onend?: () => void; onerror?: () => void;
      constructor(text: string) { this.text = text; }
    }
    class MockRecognition {
      lang = ''; interimResults = false; continuous = false; maxAlternatives = 1;
      onresult?: (event: unknown) => void; onerror?: (event: unknown) => void; onend?: () => void;
      constructor() { (window as any).__recognition = this; }
      start() { /* test dispatches a final result */ }
      abort() { this.onend?.(); }
      stop() { this.onend?.(); }
    }
    (window as any).SpeechSynthesisUtterance = MockUtterance;
    (window as any).SpeechRecognition = MockRecognition;
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [], cancel: () => {},
      speak: (utterance: MockUtterance) => setTimeout(() => utterance.onend?.(), 0),
      onvoiceschanged: null,
    } });
  });
  await page.route('**/api/v1/**', async route => {
    const url = route.request().url();
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/api/v1/infrastructures')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(facilities) });
    }
    if (pathname.endsWith('/api/v1/recommendations/by-type')) {
      const requestedType = String((route.request().postDataJSON() as any).facility_type ?? 'restaurant');
      const facility = facilities.find((item) => item.type === requestedType);
      const items = facility ? [{
        recommendation_id: `rec-${facility.id}`,
        facility,
        spot_score: 0.72,
        breakdown: { preference: 0.8, wait_time: null, travel_time: 1, incentive: 0 },
        distance_m: 80,
        reason: '테스트 추천', reason_source: 'template',
        congestion_level: null, congestion_source: 'none', congestion_log_source: null,
        congestion_is_stale: null, congestion_timestamp: null,
        rank: 1, total_candidates: 1, open_status_at_arrival: 'open_expected',
        information_confidence: 'verified', eligibility_tier: 'verified_open_route',
        place_data_source: 'test', data_updated_at: null,
        scoring_mode: 'degraded_rules', model_version: null, prediction_source: 'unavailable',
      }] : [];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) });
    }
    if (pathname.endsWith('/api/v1/voice/turn')) {
      const utterance = String((route.request().postDataJSON() as any).utterance ?? '');
      const command = utterance.includes('카페')
        ? { name: 'set_facility_type', args: { facility_type: 'cafe' } }
        : utterance.includes('문화')
          ? { name: 'set_facility_type', args: { facility_type: 'culture' } }
          : { name: 'open_waiting_board', args: {} };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        action: 'command', target_facility_id: null, match_ids: [], spoken: '요청을 적용할게요.',
        suggestion_id: null, llm_status: 'keyword', command,
      }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

async function issueVoiceCommand(page: Page, utterance: string, waitForIdle = true) {
  await page.evaluate(() => { (window as any).__previousRecognition = (window as any).__recognition ?? null; });
  await page.getByRole('button', { name: 'AI 음성 추천 듣기' }).click();
  await expect.poll(() => page.evaluate(() => {
    const current = (window as any).__recognition;
    return Boolean(current) && current !== (window as any).__previousRecognition;
  })).toBe(true);
  await page.evaluate((text) => {
    const recognition = (window as any).__recognition;
    const alternative = { transcript: text };
    const result = Object.assign([alternative], { isFinal: true });
    recognition.onresult?.({ resultIndex: 0, results: [result] });
  }, utterance);
  if (waitForIdle) {
    await expect(page.getByRole('button', { name: 'AI 음성 추천 듣기' })).toBeVisible();
  }
}

test('voice controls apply category and retain the prior card when no candidate matches', async ({ page }) => {
  await mockMainWithSpeech(page);
  await page.goto('/main');
  await expect(page.getByText('실내 식당').first()).toBeVisible({ timeout: 20_000 });

  await issueVoiceCommand(page, '카페 보여줘');
  await expect(page.getByText('실내 카페').first()).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('nextspot_setup_prefs') ?? '{}').categories))
    .toEqual(['cafe']);

  await issueVoiceCommand(page, '문화시설 보여줘', false);
  await expect(page.getByText('음성 선호에 맞는 추천을 찾지 못했어요.')).toBeVisible();
  await expect(page.getByText('실내 카페').first()).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('nextspot_setup_prefs') ?? '{}').categories))
    .toEqual(['cafe']);
});

test('voice waiting-board command navigates without changing recommendation state', async ({ page }) => {
  await mockMainWithSpeech(page);
  await page.goto('/main');
  await expect(page.getByText('실내 식당').first()).toBeVisible({ timeout: 20_000 });
  await issueVoiceCommand(page, '대기 현황 보여줘', false);
  await expect(page).toHaveURL(/\/waiting$/, { timeout: 15_000 });
});
