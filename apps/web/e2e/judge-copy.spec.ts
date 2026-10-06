import { expect, test, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';
import { stubMain, type E2eLocale } from './support/mainStubs';
import { expandPeek } from './support/recCard';

// 심사위원이 보는 카드 문구가 참인가 — 계획 A2(가치 문장·낡은 데이터·서울 표기) · A3(접힌 카드의 내부 사정·빈 자리).
//   · 카드 첫 줄의 화살표("지금 A → 대신 B")는 B 가 정말 덜 붐비는 **다른** 곳일 때만이다.
//     추천된 곳이 기준 명소 자신이면 '지금 가까운 추천' 머리표와 혜택 문장으로 말한다.
//   · 경주 관광객 화면(/main · /explore/recommend · /course)에 서울 이야기가 없다 — 추정이 서울 실측으로
//     보정된 값이어도 근거 칩은 '경주 공영주차 실측' 만 말한다.
//   · 접힌 카드(1536 · 390, 4로케일)에 순위 산식·근거 원자료('상대지수'·'후보와 0m')·'수집 중' 같은 빈 자리
//     표시가 없다. 근거는 '상세 정보 펼치기' 뒤에 있다.

const LOCALES: E2eLocale[] = ['ko', 'en', 'ja', 'zh'];
const SEOUL = /서울|Seoul|ソウル|首尔/;
/** '영업시간 미확인' 칩(card.arrivalStatus.needs_confirmation) — 어느 화면에도 그리지 않는다(계획 A4). */
const HOURS_UNVERIFIED = /영업시간 미확인|Hours unverified|営業時間未確認|营业时间未确认/;
/** 추정 근거 칩(card.evidenceEstimated)의 '경주 공영주차' 부분 — 칩이 떠 있어야 '서울 없음' 이 의미가 있다. */
const GYEONGJU_PARKING: Record<E2eLocale, string> = {
  ko: '경주 공영주차 실측 기반',
  en: 'from live Gyeongju public parking',
  ja: '慶州の公営駐車場の実測に基づく',
  zh: '基于庆州公共停车实测',
};
const LAT = 35.8347;
const LNG = 129.2190;

/** 방금 관측한 추정(서울 실측 보정이 적용된 값) — 60분 안쪽이라야 화면이 '지금' 으로 그린다. */
function calibratedEstimate(level: number) {
  return {
    level,
    source: 'estimated',
    observed_at: new Date(Date.now() - 3 * 60_000).toISOString(),
    parking_level: level,
    tourism_level: 0.6,
    lot_count: 1,
    nearest_lot_m: 320,
    radius_m: 2000,
    raw_level: 0.31,
    calibrated: true,
    calibration_basis: '서울 실측으로 보정(명동·동대문, 14일 · 900표본)',
  };
}

function mapFacility(id: string, name: string, type: string, index = 0) {
  return {
    id, name, type,
    latitude: LAT + index * 0.0008,
    longitude: LNG + index * 0.0004,
    capacity: 30,
    features: {},
    congestion: null,
    operating_hours: { open: '00:00~23:59', closed: '연중무휴' },
  };
}

/** by-type 추천 한 건 — 관광 근거가 그 장소 자신(거리 0)이고 주변 주차도 붐빈다. */
function selfAnchorRec(type: string) {
  const facility = mapFacility('cand-self', '경주 첨성대', type);
  return {
    recommendation_id: 'rec-self',
    facility,
    spot_score: 0.74,
    distance_m: 90,
    rank: 1,
    total_candidates: 1,
    reason: '경주 첨성대 고정 추천 사유',
    reason_source: 'template',
    congestion_level: null,
    congestion_source: 'none',
    congestion_is_current: null,
    congestion_timestamp: null,
    congestion_estimate: calibratedEstimate(0.82),
    open_status_at_arrival: 'open_expected',
    scoring_mode: 'area_stats_rules',
    prediction_source: 'unavailable',
    breakdown: {
      preference: 0.51,
      wait_time: null,
      travel_time: 1,
      incentive: 0,
      area_demand_level: 0.84,
      area_demand_mode: 'live',
      area_demand_sources: ['parking', 'tourism'],
      area_demand_parking_evidence: { level: 0.84, mode: 'live', observed_at: new Date().toISOString(), radius_m: 500 },
      area_demand_tourism_evidence: {
        reference_name: '경주 첨성대',
        distance_m: 0,
        forecast_date: '2026-10-06',
        relative_index: 86,
      },
    },
  };
}

async function openMain(page: Page, locale: E2eLocale): Promise<void> {
  await stubMain(page, {
    locale,
    // 첫 화면은 음식점 탭이다(온보딩 카테고리가 없으면) — 같은 id 의 지도 시설도 같은 종류로 둔다.
    facilities: [mapFacility('cand-self', '경주 첨성대', 'restaurant'), mapFacility('other', '우직', 'cafe', 1)],
    byType: (type) => [selfAnchorRec(type)],
  });
  await page.goto('/main');
  await expect(page.getByTestId('recommendation-card')).toBeVisible({ timeout: 25_000 });
}

// ───────────────────────────────────────────────────────────────────────────
// 가치 문장 — 자기 자신과 비교하지 않는다.
// ───────────────────────────────────────────────────────────────────────────

for (const viewport of [{ width: 1536, height: 730 }, { width: 390, height: 844 }]) {
  test(`a place recommended in its own spot gets the nearby-pick line, never an arrow, at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    await openMain(page, 'ko');
    if (viewport.width < 768) await expandPeek(page);

    const card = page.getByTestId('recommendation-card');
    await expect(card.getByText('지금 가까운 추천', { exact: true })).toBeVisible();
    const line = card.locator('p').filter({ hasText: /^경주 첨성대 · 도보 \d+분/ }).first();
    await expect(line).toBeVisible();
    await expect(line).toContainText('도착 시 영업');
    await expect(line).toContainText('취향 51% 일치');
    await expect(card).not.toContainText('→');
    await expect(card).not.toContainText('대신 경주 첨성대');
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 서울 표기 없음 — /main · /explore/recommend · /course, 4개 로케일.
// ───────────────────────────────────────────────────────────────────────────

async function expectNoSeoul(page: Page): Promise<void> {
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(SEOUL);
}

/** /explore/recommend — journey-loop.spec.ts 의 스텁과 같은 모양(기준 시설 + 추천 1건). */
async function openRecommend(page: Page, locale: E2eLocale): Promise<void> {
  await stubExternalServices(page);
  await page.addInitScript((selected) => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    localStorage.setItem('nextspot_locale', selected);
  }, locale);
  await page.route('**/rest/v1/**', async (route) => {
    if (route.request().url().includes('/facilities')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: 'origin', name: '황리단길', type: 'attraction', features: {}, congestion_logs: [],
      }) });
    } else {
      await route.fulfill({ status: 200, headers: { 'content-range': '0-0/1' }, body: '[]' });
    }
  });
  await page.route('**/api/v1/**', async (route) => {
    if (route.request().url().endsWith('/api/v1/recommendations')) {
      const rec = selfAnchorRec('cafe');
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { ...rec, facility: { ...rec.facility, name: '고요한 찻집' } },
      ]) });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
  });
  await page.goto(`/explore/recommend?facilityId=origin&lat=${LAT}&lng=${LNG}`);
  await expect(page.locator('section.space-y-4 h4')).toHaveCount(1, { timeout: 25_000 });
}

/** /course — 정류지 하나, 예측 없이 보정된 추정만 있다. */
async function openCourse(page: Page, locale: E2eLocale): Promise<void> {
  await stubExternalServices(page);
  await page.addInitScript((selected) => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    localStorage.setItem('nextspot_locale', selected);
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: () => {}, watchPosition: () => 0, clearWatch: () => {} },
    });
  }, locale);
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/v1/courses/plan', (route) => {
    const stop = {
      order: 1,
      facility: { id: 'att-1', name: '첨성대 뜰', type: 'attraction', latitude: LAT, longitude: LNG, capacity: 30 },
      arrival_offset_min: 12,
      predicted_congestion: null,
      congestion_estimate: calibratedEstimate(0.45),
      spot_score: 0.82,
      reason: '첨성대 뜰 고정 추천 사유',
      travel_minutes: 12,
      open_status_at_arrival: 'needs_confirmation',
      alternatives: [],
    };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      plan_id: 'att-1',
      stops: [stop],
      slot_outcomes: [{ order: 1, requested_type: 'attraction', status: 'filled', facility_id: 'att-1', pinned: false }],
    }) });
  });
  await page.goto('/course');
  await expect(page.getByRole('heading', { level: 3 }).first()).toContainText('첨성대 뜰', { timeout: 30_000 });
}

for (const locale of LOCALES) {
  test(`${locale}: no Seoul wording on the /main card (estimate calibrated on Seoul data)`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1536, height: 730 });
    await openMain(page, locale);
    await expect(page.getByTestId('recommendation-card')).toContainText(GYEONGJU_PARKING[locale]);
    await expectNoSeoul(page);
  });

  test(`${locale}: no Seoul wording on /explore/recommend`, async ({ page }) => {
    test.setTimeout(90_000);
    await openRecommend(page, locale);
    await expect(page.locator('section.space-y-4')).toContainText(GYEONGJU_PARKING[locale]);
    await expectNoSeoul(page);
  });

  test(`${locale}: no Seoul wording on /course, and no 'hours unverified' chip on its stop`, async ({ page }) => {
    test.setTimeout(90_000);
    await openCourse(page, locale);
    await expect(page.locator('main')).toContainText(GYEONGJU_PARKING[locale]);
    await expectNoSeoul(page);
    // 정류지는 서버가 영업시간 '미확인' 이라고 준 곳이다(계획 A4) — 그 사실을 칩으로 말하지 않는다.
    expect(await page.locator('main').innerText()).not.toMatch(HOURS_UNVERIFIED);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 접힌 카드에는 관광객이 얻는 것만 — 내부 사정·빈 자리 표시 없음(1536 · 390, 4로케일).
// ───────────────────────────────────────────────────────────────────────────

/** 예전 접힌 카드에 있던 문구들(로케일별). 하나라도 보이면 실패다. */
const MACHINERY: Record<E2eLocale, RegExp> = {
  ko: /수집 중|혼잡 추정 · 수집 중|대안 비교용|근거가 도착하면|SPOT 점수는 도보|사용자 패턴|상대지수|후보와|수준입니다/,
  en: /[Cc]ollecting|once it arrives|SPOT score uses walking|Based on your patterns|relative index|from this option/,
  ja: /収集中|届くとここに表示|SPOTスコアは徒歩基準|利用パターン|相対指数|候補から/,
  zh: /收集中|到达后会显示在这里|SPOT评分按步行计算|基于用户习惯|相对指数|距候选/,
};

/** 첫 방문 장소의 제보 알약 — '수집 중 · 혼잡 제보' 대신 관광객에게 묻는다. */
const REPORT_FIRST: Record<E2eLocale, string> = {
  ko: '지금 붐비나요? 알려 주세요',
  en: 'Busy now? Tell us',
  ja: '今混んでいますか？教えてください',
  zh: '现在拥挤吗？告诉我们',
};

/** 근거가 하나도 없는 추천 — 예전에는 '혼잡 추정 · 수집 중' 칩과 '주변 붐빔 · 수집 중' 자리가 떴다. */
function bareRec(type: string) {
  return {
    ...selfAnchorRec(type),
    facility: mapFacility('cand-bare', '우직 쌈밥집', type),
    recommendation_id: 'rec-bare',
    congestion_estimate: null,
    breakdown: { preference: 0.7, wait_time: null, travel_time: 5, incentive: 0 },
  };
}

async function collapsedCardText(page: Page, viewportWidth: number, locale: E2eLocale): Promise<string> {
  // 휴대폰은 미리보기로 뜬다 — 전체 카드(상세는 접힌 채)를 펼쳐서 본다.
  if (viewportWidth < 768) await expandPeek(page, locale);
  const card = page.getByTestId('recommendation-card');
  await expect(card).toContainText(REPORT_FIRST[locale]);
  return card.innerText();
}

for (const locale of LOCALES) {
  for (const viewport of [{ width: 1536, height: 730 }, { width: 390, height: 844 }]) {
    test(`${locale} ${viewport.width}px: the collapsed card shows no ranking machinery or placeholders`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize(viewport);
      await openMain(page, locale);
      const text = await collapsedCardText(page, viewport.width, locale);
      expect(text).not.toMatch(MACHINERY[locale]);
      expect(text).not.toMatch(SEOUL);
    });
  }

  test(`${locale}: a card with no crowd evidence shows no placeholder chip or box`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1536, height: 730 });
    await stubMain(page, {
      locale,
      facilities: [mapFacility('cand-bare', '우직 쌈밥집', 'restaurant')],
      byType: (type) => [bareRec(type)],
    });
    await page.goto('/main');
    await expect(page.getByTestId('recommendation-card')).toBeVisible({ timeout: 25_000 });
    const text = await collapsedCardText(page, 1536, locale);
    expect(text).not.toMatch(MACHINERY[locale]);
  });
}

test('the nearby-crowd evidence sits behind 상세 정보 펼치기', async ({ page }) => {
  test.setTimeout(90_000);
  await openMain(page, 'ko');
  const card = page.getByTestId('recommendation-card');
  // 390px: 미리보기 → 전체 카드 → 상세. 접힌 전체 카드에는 근거 원자료가 없다.
  await expandPeek(page);
  await expect(card).not.toContainText('공영주차 실측 수요');
  await page.getByRole('button', { name: '상세 정보 펼치기' }).click();
  await expect(card).toContainText('공영주차 실측 수요');
  // 💡 사유는 관광객이 얻는 것(걷는 시간)이다 — 근거 원자료 문장이 아니다.
  await expect(card).toContainText('💡 경주 첨성대까지 걸어서 1분이에요.');
  // 자동차 길안내 버튼은 그 말만 한다.
  await expect(card.getByRole('button', { name: '자동차 길안내', exact: true })).toBeVisible();
});
