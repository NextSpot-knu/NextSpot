import { expect, test, type Page, type Route } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 심사위원 경로 회귀 테스트 ② — 메인 지도(/main)에서 손으로 눌러야만 드러나는 것들.
//   · 비교 헤더("지금 A … → 대신 B · 도보 N분 · 등급")가 **근거가 하나도 없어도** 사라지지 않는가
//   · 🕒 가정 시간 셀렉트와 ✨ 경주 테마 칩이 스켈레톤 → 카드 교체 → 토스트로 응답하는가
//   · 스켈레톤이 **반드시** 걷히는가(응답이 영영 오지 않아도 3초 하드캡)
//   · 🏮 축제 패널이 열리고, 바깥을 누르면 닫히는가
//
// 모든 네트워크는 스텁이다. 카탈-올을 먼저 등록하고 구체 경로를 나중에 등록한다
// (Playwright 는 나중에 등록한 라우트가 이긴다).

const ANCHORS = [
  { id: 'anchor-daereungwon', name: '대릉원', type: 'attraction' },
  { id: 'anchor-donggung', name: '동궁과 월지', type: 'attraction' },
  { id: 'anchor-museum', name: '국립경주박물관', type: 'culture' },
  { id: 'anchor-woljeonggyo', name: '월정교', type: 'attraction' },
];

const CANDIDATES = [
  { id: 'cand-cafe', name: '우직 한옥카페', type: 'cafe' },
  { id: 'cand-attraction', name: '우직 고분길', type: 'attraction' },
  { id: 'cand-culture', name: '우직 공예관', type: 'culture' },
  { id: 'cand-restaurant', name: '우직 쌈밥집', type: 'restaurant' },
];

function facility(row: { id: string; name: string; type: string }, index: number) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    latitude: 35.8355 + index * 0.0008,
    longitude: 129.2105 + index * 0.0004,
    capacity: 20 + index * 10,
    features: {},
    congestion: null,
    operating_hours: { open: '00:00~23:59', closed: '연중무휴' },
  };
}

const ALL_FACILITIES = [...ANCHORS, ...CANDIDATES].map(facility);

/** 근거가 **있는** 추천 — 관광 근거(기준 명소 이름 + 상대지수)와 실측 혼잡을 함께 준다. */
function recWithEvidence(row: { id: string; name: string; type: string }, index: number) {
  return {
    recommendation_id: `rec-${row.id}`,
    facility: facility(row, index),
    spot_score: 0.78,
    distance_m: 240,
    rank: 1,
    total_candidates: 1,
    reason: `${row.name} 고정 추천 사유`,
    reason_source: 'template',
    congestion_level: 0.22,
    congestion_source: 'measured',
    congestion_is_current: true,
    open_status_at_arrival: 'open_expected',
    scoring_mode: 'area_stats_rules',
    prediction_source: 'unavailable',
    breakdown: {
      preference: 0.8,
      wait_time: null,
      travel_time: 4,
      incentive: 0,
      area_demand_level: 0.81,
      area_demand_mode: 'live',
      area_demand_sources: ['parking', 'tourism'],
      area_demand_parking_evidence: { level: 0.84, mode: 'live', observed_at: '2026-09-21T02:00:00+00:00' },
      area_demand_tourism_evidence: {
        reference_name: '대릉원',
        distance_m: 184,
        forecast_date: '2026-09-21',
        relative_index: 86,
      },
    },
  };
}

/** 근거가 **하나도 없는** 추천 — 혼잡 추정도, 주차 실측도, 관광 근거도 없다. */
function recWithoutEvidence(row: { id: string; name: string; type: string }, index: number) {
  return {
    recommendation_id: `rec-${row.id}`,
    facility: facility(row, index),
    spot_score: 0.61,
    distance_m: 260,
    rank: 1,
    total_candidates: 1,
    reason: `${row.name} 고정 추천 사유`,
    reason_source: 'template',
    congestion_level: null,
    congestion_source: 'none',
    congestion_log_source: null,
    congestion_is_stale: null,
    congestion_timestamp: null,
    open_status_at_arrival: 'open_expected',
    scoring_mode: 'degraded_rules',
    prediction_source: 'unavailable',
    breakdown: { preference: 0.7, wait_time: null, travel_time: 5, incentive: 0 },
  };
}

interface MainOptions {
  /** 추천 응답에 근거를 실을지. false 면 폴백 문구('인기 명소' / '수집 중') 경로를 탄다. */
  evidence?: boolean;
  /** GET /api/v1/events 응답. null 이면 source=unavailable(칩 자체가 숨는다). */
  events?: unknown[] | null;
}

/** 응답이 영영 오지 않게 만드는 스위치 — 3초 하드캡 검증용. */
interface Hang {
  on: boolean;
}

async function mockMain(page: Page, options: MainOptions = {}): Promise<Hang> {
  const hang: Hang = { on: false };
  const evidence = options.evidence ?? true;
  const build = evidence ? recWithEvidence : recWithoutEvidence;

  await stubExternalServices(page);
  await page.addInitScript(() => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    localStorage.setItem('nextspot_locale', 'ko');
  });

  await page.route('**/rest/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  // 카탈-올 먼저.
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );

  const recommendFor = (type: string) => {
    const row = CANDIDATES.find((c) => c.type === type) ?? CANDIDATES[0];
    return [build(row, CANDIDATES.indexOf(row))];
  };

  await page.route('**/api/v1/infrastructures**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ALL_FACILITIES) }),
  );

  const answerByType = async (route: Route) => {
    if (hang.on) return new Promise<void>(() => { /* 영영 응답하지 않는다 */ });
    const body = route.request().postDataJSON() as { facility_type?: string } | null;
    const type = String(body?.facility_type ?? 'cafe');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(recommendFor(type)),
    });
  };
  await page.route('**/api/v1/recommendations/by-type', answerByType);

  // 테마 칩 경로(POST /api/v1/recommendations, anchor 기준).
  await page.route('**/api/v1/recommendations', async (route) => {
    if (hang.on) return new Promise<void>(() => {});
    const body = route.request().postDataJSON() as { candidate_types?: string[] } | null;
    const type = String(body?.candidate_types?.[0] ?? 'attraction');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(recommendFor(type)),
    });
  });

  await page.route('**/api/v1/events**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        options.events === null || options.events === undefined
          ? { source: 'unavailable', events: [] }
          : { source: 'tourapi', events: options.events },
      ),
    }),
  );

  return hang;
}

/** 비교 헤더 한 줄의 모양. 근거 유무와 무관하게 이 모양은 항상 성립해야 한다. */
const COMPARE_HEADER =
  /지금 .+ (혼잡|보통|여유|한산|인기) → 대신 .+ · 도보 \d+분 · (혼잡|보통|여유|한산|수집 중)/;

// ───────────────────────────────────────────────────────────────────────────
// ② 비교 헤더 — 근거가 있든 없든 사라지지 않는다.
// ───────────────────────────────────────────────────────────────────────────

test('comparison header renders when the response carries evidence', async ({ page }) => {
  test.setTimeout(90_000);
  await mockMain(page, { evidence: true });
  await page.goto('/main');

  await expect(page.getByRole('heading', { name: '우직 쌈밥집' })).toBeVisible({ timeout: 25_000 });
  const header = page.getByText(COMPARE_HEADER).first();
  await expect(header).toBeVisible();
  // 근거가 있으면 기준 명소 이름과 등급 단어를 그대로 말한다(폴백 문구가 아니다).
  await expect(header).toContainText('대릉원');
  await expect(header).not.toContainText('인기 명소');
  await expect(header).not.toContainText('수집 중');
});

test('comparison header still renders with no congestion estimate and no parking evidence', async ({ page }) => {
  test.setTimeout(90_000);
  await mockMain(page, { evidence: false });
  await page.goto('/main');

  await expect(page.getByRole('heading', { name: '우직 쌈밥집' })).toBeVisible({ timeout: 25_000 });
  const header = page.getByText(COMPARE_HEADER).first();
  await expect(header).toBeVisible();
  // 근거가 전부 없을 때의 폴백 문구(lib/compareHeader.ts 계약 ①·②).
  await expect(header).toContainText('인기 명소');
  await expect(header).toContainText('수집 중');
});

// ───────────────────────────────────────────────────────────────────────────
// ③ 가정 시간 셀렉트 · 경주 테마 칩 — 스켈레톤 → 카드 → 토스트
// ───────────────────────────────────────────────────────────────────────────

const skeletonOf = (page: Page) => page.getByText(/기준으로 다시 계산 중…/);

test.describe('recalculation feedback (desktop toolbar)', () => {
  // 🕒 가정 시간 셀렉트는 `hidden … md:flex` 툴바 안에 있어 모바일 폭에서는 렌더되지 않는다.
  // 기능 자체를 검증하기 위해 데스크톱 폭으로 연다(모바일 노출 여부는 아래 별도 테스트).
  test.use({ viewport: { width: 1280, height: 900 } });

  test('assumed-time select shows a skeleton, swaps the card and toasts', async ({ page }) => {
    test.setTimeout(90_000);
    await mockMain(page);
    await page.goto('/main');
    await expect(page.getByRole('heading', { name: '우직 쌈밥집' })).toBeVisible({ timeout: 25_000 });

    const skeleton = skeletonOf(page);
    const sameToast = page.getByText('이 시간대에도 같은 추천이 유효해요');

    await page.getByLabel('가정 시간').selectOption('weekday_noon');
    await expect(skeleton).toBeVisible();
    // 스텁 응답이 그대로라 추천도 그대로 — 그 사실을 침묵이 아니라 문장으로 말해야 한다.
    await expect(sameToast).toBeVisible({ timeout: 15_000 });
    await expect(skeleton).toBeHidden();
    await expect(page.getByRole('heading', { name: '우직 쌈밥집' })).toBeVisible();
    // 가정 시각 배지도 함께 올라온다.
    await expect(page.getByText('가정: 평일 12:00')).toBeVisible();
  });

  test('the skeleton always clears within the 3 second hard cap', async ({ page }) => {
    test.setTimeout(90_000);
    const hang = await mockMain(page);
    await page.goto('/main');
    await expect(page.getByRole('heading', { name: '우직 쌈밥집' })).toBeVisible({ timeout: 25_000 });

    // 이 시점부터 추천 응답은 영영 오지 않는다.
    hang.on = true;
    const skeleton = skeletonOf(page);
    const startedAt = Date.now();
    await page.getByLabel('가정 시간').selectOption('sat_afternoon');
    await expect(skeleton).toBeVisible();
    await expect(skeleton).toBeHidden({ timeout: 8_000 });
    // 하드캡(3s) + 최소 노출 보정(420ms) 안에서 걷혀야 한다 — 넉넉히 6초로 본다.
    expect(Date.now() - startedAt).toBeLessThan(6_000);
  });

  test('discovery theme chips recalculate with a skeleton and a toast', async ({ page }) => {
    test.setTimeout(90_000);
    await mockMain(page);
    await page.goto('/main');
    await expect(page.getByRole('heading', { name: '우직 쌈밥집' })).toBeVisible({ timeout: 25_000 });

    await page.getByRole('button', { name: /경주가 처음이라면/ }).click();
    const chips = page.getByRole('button', {
      name: /신라 핵심 산책|오늘 밤 야경|황리단길 한옥 카페|실내 역사 여행|교촌·월정교 산책/,
    });
    await expect(chips).toHaveCount(5);

    const skeleton = skeletonOf(page);
    await chips.filter({ hasText: '신라 핵심 산책' }).click();
    await expect(skeleton).toBeVisible();
    await expect(page.getByText(/다시 계산했어요|이 시간대에도 같은 추천이 유효해요|대안/).first())
      .toBeVisible({ timeout: 15_000 });
    await expect(skeleton).toBeHidden();
    // 테마가 걸린 카드가 실제로 나타난다.
    await expect(page.getByText('대릉원 기준 대안')).toBeVisible();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 390px(심사위원의 폰) 도달 가능성 — 위 기능들이 실제로 손에 닿는가.
// 상단 컨트롤 줄(app/main/page.tsx:3243)은 `hidden … md:flex` 라 모바일에서는 렌더되지 않고,
// 그 대체 경로는 '필터·편의' 시트(app/main/page.tsx:3442)뿐이다.
// ───────────────────────────────────────────────────────────────────────────

test('the recommendation card must not cover the map controls at 390px', async ({ page }) => {
  test.setTimeout(90_000);
  await mockMain(page, { evidence: true });
  await page.goto('/main');
  await expect(page.getByRole('heading', { name: '우직 쌈밥집' })).toBeVisible({ timeout: 25_000 });

  const geometry = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('필터·편의'));
    const orb = document.querySelector('button[aria-label="AI 음성 추천 듣기"]');
    const card = document.querySelector('div[class*="toss-surface"][class*="backdrop-blur-2xl"]');
    const box = button?.getBoundingClientRect();
    const hit = box ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) : null;
    return {
      filterButtonIsHittable: !!button && !!hit && (hit === button || button.contains(hit)),
      hitElementText: hit?.textContent?.slice(0, 40) ?? null,
      cardTop: card ? Math.round(card.getBoundingClientRect().top) : null,
      orbTop: orb ? Math.round(orb.getBoundingClientRect().top) : null,
    };
  });

  // 카드는 하단 고정 시트다 — 화면 위로 넘치면 상단 컨트롤 줄을 덮어 버린다.
  expect(geometry.cardTop, `추천 카드 상단이 화면 밖: ${geometry.cardTop}px`).toBeGreaterThanOrEqual(0);
  // 음성 오브는 카드와 같은 컨테이너에 얹혀 있어 카드가 길어지면 함께 밀려 나간다.
  expect(geometry.orbTop, `음성 오브 상단이 화면 밖: ${geometry.orbTop}px`).toBeGreaterThanOrEqual(0);
  expect(
    geometry.filterButtonIsHittable,
    `'필터·편의' 중앙을 덮고 있는 것: ${geometry.hitElementText}`,
  ).toBe(true);
});

test('festival chip lives in the 필터·편의 sheet at 390px', async ({ page }) => {
  test.setTimeout(90_000);
  await mockMain(page, { events: [] });
  await page.goto('/main');
  await expect(page.getByRole('heading', { name: '우직 쌈밥집' })).toBeVisible({ timeout: 25_000 });

  // 위 테스트가 잡는 겹침 버그를 우회해 시트를 연다 — 여기서 보려는 것은 '시트 안에 칩이
  // 있는가' 이지 '버튼이 눌리는가' 가 아니다(그건 위 테스트의 일).
  await page.getByRole('button', { name: '필터·편의' }).dispatchEvent('click');
  await expect(page.getByRole('button', { name: /경주 축제·행사/ }).locator('visible=true')).toHaveCount(1);
});

test('assumed-time select is reachable at 390px', async ({ page }) => {
  test.setTimeout(90_000);
  await mockMain(page, { events: [] });
  await page.goto('/main');
  await expect(page.getByRole('heading', { name: '우직 쌈밥집' })).toBeVisible({ timeout: 25_000 });

  // 서비스 소개(guide.sigPredictBody)가 "상단 '가정 시간'에서 요일·시각을 고르면…" 이라고
  // 약속하는 컨트롤이다. 상단 줄이 모바일에서 숨는다면 '필터·편의' 시트에라도 있어야 한다.
  if ((await page.getByLabel('가정 시간').locator('visible=true').count()) === 0) {
    await page.getByRole('button', { name: '필터·편의' }).dispatchEvent('click');
  }
  await expect(page.getByLabel('가정 시간').locator('visible=true')).toHaveCount(1);
});

// ───────────────────────────────────────────────────────────────────────────
// ④ 축제 패널 — 가장 위험한 항목(백엔드 없이 재작성됨).
// ───────────────────────────────────────────────────────────────────────────

const EVENTS = [
  {
    contentId: 'ev-1',
    title: '경주 신라문화제',
    startDate: '2026-09-18',
    endDate: '2026-09-27',
    address: '경상북도 경주시 원화로 １２３',
    eventPlace: '경주엑스포대공원',
    latitude: 35.8402,
    longitude: 129.2601,
    tel: '054-000-0000',
    isOngoing: true,
    imageUrl: null,
  },
  {
    contentId: 'ev-2',
    title: '황리단길 한가위 야행',
    startDate: '2026-10-02',
    endDate: '2026-10-05',
    address: '경상북도 경주시 포석로',
    eventPlace: '황리단길 일원',
    latitude: 35.8352,
    longitude: 129.2098,
    tel: null,
    isOngoing: false,
    imageUrl: null,
  },
];

/** 축제 칩은 상단 컨트롤 줄에 있다(데스크톱 폭에서 보인다). */
async function openFestivalPanel(page: Page) {
  await page.getByRole('button', { name: /경주 축제·행사/ }).locator('visible=true').first().click();
  return page.getByRole('dialog', { name: '경주 축제·행사' });
}

// 축제 칩은 `hidden … md:flex` 컨트롤 줄 안에 있으므로 기능 자체는 데스크톱 폭에서 본다.
// (모바일 도달 경로는 위 '필터·편의 시트' 테스트가 따로 지킨다.)
test.describe('festival panel (desktop toolbar)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('festival panel lists events with period, place, distance and a map button', async ({ page }) => {
    test.setTimeout(90_000);
    await mockMain(page, { events: EVENTS });
    await page.goto('/main');
    await expect(page.getByRole('heading', { name: '우직 쌈밥집' })).toBeVisible({ timeout: 25_000 });

    const panel = await openFestivalPanel(page);
    await expect(panel).toBeVisible();

    await expect(panel.getByText('경주 신라문화제')).toBeVisible();
    await expect(panel.getByText('황리단길 한가위 야행')).toBeVisible();
    // 기간
    await expect(panel.getByText('09.18 ~ 09.27')).toBeVisible();
    await expect(panel.getByText('10.02 ~ 10.05')).toBeVisible();
    // 장소
    await expect(panel.getByText('경주엑스포대공원')).toBeVisible();
    await expect(panel.getByText('황리단길 일원')).toBeVisible();
    // 거리(좌표가 있으면 m/km 로 표기)
    await expect(panel.getByText(/^\d+(\.\d)?(m|km)$/).first()).toBeVisible();
    // '지도에서 보기' — 우리 지도에 표시하고 패널을 닫는다.
    const showOnMap = panel.getByRole('button', { name: '지도에서 보기' }).first();
    await expect(showOnMap).toBeVisible();
    await showOnMap.click();
    await expect(panel).toBeHidden();
  });

  test('festival panel closes on an outside click', async ({ page }) => {
    test.setTimeout(90_000);
    await mockMain(page, { events: EVENTS });
    await page.goto('/main');
    await expect(page.getByRole('heading', { name: '우직 쌈밥집' })).toBeVisible({ timeout: 25_000 });

    const panel = await openFestivalPanel(page);
    await expect(panel).toBeVisible();
    // 시트 바깥(어두운 오버레이 상단)을 누른다.
    await page.mouse.click(195, 40);
    await expect(panel).toBeHidden();
  });

  test('festival panel says so honestly when there is no ongoing event', async ({ page }) => {
    test.setTimeout(90_000);
    await mockMain(page, { events: [] });
    await page.goto('/main');
    await expect(page.getByRole('heading', { name: '우직 쌈밥집' })).toBeVisible({ timeout: 25_000 });

    const panel = await openFestivalPanel(page);
    await expect(panel).toBeVisible();
    await expect(panel.getByText('현재 진행 중인 행사가 없어요')).toBeVisible();
  });
});
