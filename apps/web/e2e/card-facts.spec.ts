import { expect, test, type Page } from '@playwright/test';
import { stubMain, type E2eLocale } from './support/mainStubs';

// 추천 카드의 시간 · 영업 · 연락처가 스스로와 맞는가 — 계획 A4.
//   · 큰 숫자는 보이는 칩의 합이고(대기가 없으면 '도보 시간'), 도착 시각은 출발 + 도보 칩 분이다.
//   · '상시 개방' 야외 유적은 '도착 시 영업 예상' 이다. '영업시간 미확인' 칩은 어디에도 없다.
//   · 영업시간을 모르는 음식점도 버튼 이름은 '도보 길안내' 이고, 누르면 카카오맵 영업시간과 확인 질문이 먼저 뜬다.
//   · 운영시간은 철·문마다 한 줄('<br>' 이 글자로 보이지 않는다), 전화번호는 누르면 걸린다(tel:).
//   · 예측 모델이 학습되지 않았으면 상세를 몇 번 펼쳐도 /predict/day 를 부르지 않는다.
//
// 외부 호출은 stubMain 이 공용 스텁(stubExternalServices, support/stubs.ts)으로 전부 막는다.

const LAT = 35.8347;
const LNG = 129.2190;
const DESKTOP = { width: 1536, height: 730 };

interface RecOptions {
  name?: string;
  operatingHours?: Record<string, string> | null;
  openStatus?: string | null;
  travelTime?: number;
  phone?: string | null;
  features?: Record<string, unknown>;
  /** 학습 모델 점수 + 지금 실측(검증된 대기 분이 화면에 뜨는 경우). */
  modelWait?: number;
}

function rec(type: string, options: RecOptions = {}) {
  const facility = {
    id: 'cand-1',
    name: options.name ?? '우직 쌈밥집',
    type,
    latitude: LAT,
    longitude: LNG,
    capacity: 30,
    features: options.features ?? {},
    congestion: null,
    operating_hours: options.operatingHours === undefined ? { open: '00:00~23:59', closed: '연중무휴' } : options.operatingHours,
    phone: options.phone ?? null,
  };
  return {
    recommendation_id: 'rec-1',
    facility,
    spot_score: 0.7,
    distance_m: 200,
    rank: 1,
    total_candidates: 1,
    reason: `${facility.name} 고정 추천 사유`,
    reason_source: 'template',
    congestion_level: options.modelWait === undefined ? null : 0.4,
    congestion_source: options.modelWait === undefined ? 'none' : 'measured',
    congestion_is_current: options.modelWait === undefined ? null : true,
    congestion_timestamp: options.modelWait === undefined ? null : new Date(Date.now() - 5 * 60_000).toISOString(),
    open_status_at_arrival: options.openStatus === undefined ? 'open_expected' : options.openStatus,
    scoring_mode: options.modelWait === undefined ? 'degraded_rules' : 'model',
    prediction_source: 'unavailable',
    breakdown: { preference: 0.7, wait_time: options.modelWait ?? null, travel_time: options.travelTime ?? 4, incentive: 0 },
  };
}

async function openMain(page: Page, options: RecOptions & { locale?: E2eLocale } = {}): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await stubMain(page, {
    locale: options.locale ?? 'ko',
    facilities: [rec('restaurant', options).facility],
    byType: (type) => [rec(type, options)],
  });
  await page.goto('/main');
  await expect(page.getByTestId('recommendation-card')).toBeVisible({ timeout: 25_000 });
}

/** 예측 API 스텁 — model-info 응답을 정하고, /predict/day 호출 수를 센다. */
async function stubPredict(page: Page, trained: boolean): Promise<{ modelInfo: number; day: number }> {
  const counts = { modelInfo: 0, day: 0 };
  await page.route('**/predict/**', (route) => {
    const url = route.request().url();
    if (url.includes('/predict/model-info')) {
      counts.modelInfo += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        trained, version: trained ? 'v1' : null, real_data_count: 0, mae: null, baseline_improvement: null,
        fallback_state: trained ? null : 'degraded_rules',
      }) });
    }
    if (url.includes('/predict/day')) {
      counts.day += 1;
      if (!trained) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"model not trained"}' });
      const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, congestion: hour === 15 ? 0.1 : 0.5 }));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        hours, best_hour: 15, best_congestion: 0.1,
      }) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  return counts;
}

async function toggleDetails(page: Page): Promise<void> {
  const card = page.getByTestId('recommendation-card');
  await card.getByRole('button', { name: '상세 정보 펼치기' }).click();
  await expect(card.getByRole('button', { name: '상세 정보 접기' })).toBeVisible();
}

// ───────────────────────────────────────────────────────────────────────────
// /predict/day — 학습되지 않은 모델에는 묻지 않는다.
// ───────────────────────────────────────────────────────────────────────────

test('no /predict/day request while the model is untrained, however often details open', async ({ page }) => {
  test.setTimeout(90_000);
  const counts = await stubPredict(page, false);
  await openMain(page);
  const card = page.getByTestId('recommendation-card');
  for (let i = 0; i < 3; i += 1) {
    await toggleDetails(page);
    await card.getByRole('button', { name: '상세 정보 접기' }).click();
    await expect(card.getByRole('button', { name: '상세 정보 펼치기' })).toBeVisible();
  }
  await page.waitForTimeout(500);
  expect(counts.day).toBe(0);
  expect(counts.modelInfo).toBeLessThanOrEqual(1);
});

test('a trained model still gets its /predict/day curve (the gate is not just closed)', async ({ page }) => {
  test.setTimeout(90_000);
  const counts = await stubPredict(page, true);
  await openMain(page);
  await toggleDetails(page);
  await expect(page.getByTestId('recommendation-card')).toContainText('가장 한산한 시간 · 오후 3시', { timeout: 10_000 });
  expect(counts.day).toBe(1);
});

// ───────────────────────────────────────────────────────────────────────────
// 시간 숫자 — 큰 숫자 = 칩의 합, 도착 = 출발 + 도보 칩.
// ───────────────────────────────────────────────────────────────────────────

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.trim().split(':').map(Number);
  return h * 60 + m;
};

test('with no wait the tile reads 도보 시간 and agrees with the walk chip and the timeline', async ({ page }) => {
  test.setTimeout(90_000);
  await openMain(page, { travelTime: 2.4 }); // 2.4분 → 칩 3분(예전 큰 숫자는 반올림 2분이었다)
  const card = page.getByTestId('recommendation-card');
  const tile = card.getByText('도보 시간', { exact: true }).locator('xpath=..');
  await expect(tile).toContainText('3분');
  await expect(card.getByText('총 소요 시간', { exact: true })).toHaveCount(0);
  await expect(card).toContainText('도보 3분');
  const depart = await card.getByText('출발', { exact: true }).locator('xpath=preceding-sibling::span[1]').innerText();
  const arrive = await card.getByText('도착', { exact: true }).locator('xpath=preceding-sibling::span[1]').innerText();
  expect((minutesOf(arrive) - minutesOf(depart) + 1440) % 1440).toBe(3);
});

test('a verified wait reads the same minutes in the 💡 reason, the chip and the arrival summary', async ({ page }) => {
  test.setTimeout(90_000);
  await openMain(page, { modelWait: 2.3, travelTime: 4 }); // 2.3분 → 올림 3분(예전 💡 는 반올림 2분이었다)
  const card = page.getByTestId('recommendation-card');
  await expect(card.getByText('대기 3분', { exact: true }).first()).toBeVisible();
  await expect(card).toContainText('도보 4분 · 대기 3분');
  await toggleDetails(page);
  await expect(card).toContainText('예상 대기 3분이에요');
  await expect(card).not.toContainText('대기 2분');
});

// ───────────────────────────────────────────────────────────────────────────
// 영업 상태 — 야외 유적은 열려 있고, '미확인' 은 어디에도 없다.
// ───────────────────────────────────────────────────────────────────────────

test("an open-air sight with '상시 개방' reads 도착 시 영업 예상", async ({ page }) => {
  test.setTimeout(90_000);
  // 서버 파서는 아직 '상시 개방' 을 모른다(순위가 바뀌는 서버 보강은 심사 뒤) — 카드가 운영시간 문구로 바로잡는다.
  await openMain(page, { name: '경주 계림', operatingHours: { open: '상시 개방' }, openStatus: 'needs_confirmation' });
  const card = page.getByTestId('recommendation-card');
  await expect(card.getByText('도착 시 영업 예상', { exact: true })).toBeVisible();
  await expect(card).not.toContainText(/영업시간 미확인/);
});

for (const locale of ['ko', 'en'] as const) {
  test(`${locale}: unknown-hours restaurant keeps 도보 길안내, opens Kakao hours first, shows no 'unverified' chip`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => {
      window.open = ((url?: string | URL) => {
        (window as unknown as { __opened?: string }).__opened = String(url);
        return window;
      }) as typeof window.open;
    });
    await openMain(page, {
      locale,
      operatingHours: null,
      openStatus: 'needs_confirmation',
      features: { kakao_place_id: '123456' },
    });
    const card = page.getByTestId('recommendation-card');
    await expect(card).not.toContainText(/영업시간 미확인|Hours unverified|카카오맵에서 영업 확인|Check hours on Kakao Map/);
    const go = card.getByRole('button', { name: locale === 'ko' ? '여기로 길안내 시작' : 'Start navigation here' });
    await expect(go).toHaveText(locale === 'ko' ? '도보 길안내' : 'Walking directions');
    await expect(card).toContainText(locale === 'ko'
      ? '출발 전에 카카오맵에서 영업시간을 먼저 보여 드려요.'
      : "Before you set off, we'll show the opening hours on Kakao Map.");
    await go.click();
    expect(await page.evaluate(() => (window as unknown as { __opened?: string }).__opened))
      .toBe('https://place.map.kakao.com/123456');
    await expect(card.getByRole('group', {
      name: locale === 'ko' ? '카카오맵에서 지금 영업 중인지 확인하셨나요?' : 'Did Kakao Map show that this place is open now?',
    })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('nextspot_active_trip'))).toBeNull();
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 운영시간 줄 · 전화 걸기.
// ───────────────────────────────────────────────────────────────────────────

test('hours print one line per part without <br>, and the phone is a tel: link', async ({ page }) => {
  test.setTimeout(90_000);
  await openMain(page, {
    name: '천마총(대릉원)',
    operatingHours: { open: '- 정문 09:00~22:00 (입장 마감 21:30)<br>\n- 후문·천마총 09:00~21:30', closed: '연중무휴' },
    phone: '054-750-8650',
  });
  await toggleDetails(page);
  const card = page.getByTestId('recommendation-card');
  await expect(card.getByText('정문 09:00~22:00 (입장 마감 21:30)', { exact: true })).toBeVisible();
  await expect(card.getByText('후문·천마총 09:00~21:30', { exact: true })).toBeVisible();
  await expect(card).not.toContainText('<br');
  const tel = card.locator('a[href^="tel:"]');
  await expect(tel).toHaveCount(1);
  await expect(tel).toHaveAttribute('href', 'tel:0547508650');
  await expect(tel).toHaveText('054-750-8650');
});
