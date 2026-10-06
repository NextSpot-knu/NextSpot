import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { stubExternalServices } from './support/stubs';
import { expandPeek } from './support/recCard';

// 심사위원 경로 회귀 테스트 ② — 메인 지도(/main)에서 손으로 눌러야만 드러나는 것들.
//   · 카드 첫 줄이 참인가 — 화살표("지금 A … → 대신 B · 도보 N분 · 등급")는 B 가 정말 덜 붐빌 때만,
//     근거가 하나도 없으면 혜택 문장("B · 도보 N분 · …")으로 남는다(사라지지 않는다)
//   · 🕒 가정 시간 셀렉트와 ✨ 경주 테마 칩이 스켈레톤 → 카드 교체 → 토스트로 응답하는가
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
  /** 추천 응답에 근거를 실을지. false 면 비교가 성립하지 않아 혜택 문장 경로를 탄다. */
  evidence?: boolean;
  /** GET /api/v1/events 응답. null 이면 source=unavailable(칩 자체가 숨는다). */
  events?: unknown[] | null;
}

async function mockMain(page: Page, options: MainOptions = {}): Promise<void> {
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
}

/**
 * 손가락이 정말 닿는가 — 요소 가운데 점에서 맨 위에 그려진 것이 그 요소(또는 그 자식)이고,
 * 요소가 하단 내비 위에 있다. dispatchEvent 로 우회하지 않고 이 단언 뒤에 실제 click 을 한다.
 */
async function expectTappable(target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const probe = await target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    const nav = [...document.querySelectorAll('nav')]
      .find((n) => n.getClientRects().length > 0 && getComputedStyle(n).position === 'fixed');
    return {
      reachable: !!hit && (hit === el || el.contains(hit)),
      coveredBy: hit && !(hit === el || el.contains(hit)) ? (hit.textContent ?? '').trim().slice(0, 40) : null,
      bottom: box.bottom,
      navTop: nav ? nav.getBoundingClientRect().top : window.innerHeight,
    };
  });
  expect(probe.reachable, `covered by: ${probe.coveredBy}`).toBe(true);
  expect(probe.bottom).toBeLessThanOrEqual(probe.navTop);
}

/** 화살표 비교 한 줄의 모양 — 두 곳 모두 실제 등급 단어로만 말한다('인기'·'수집 중' 같은 대체어 없음). */
const COMPARE_HEADER =
  /지금 .+ (혼잡|보통|여유|한산) → 대신 .+ · 도보 \d+분 · (혼잡|보통|여유|한산)/;

// ───────────────────────────────────────────────────────────────────────────
// ② 카드 첫 줄 — 근거가 있든 없든 사라지지 않고, 언제나 참이다(lib/compareHeader.ts chooseCompareHeadline).
// ───────────────────────────────────────────────────────────────────────────

test('comparison header renders when the response carries evidence', async ({ page }) => {
  test.setTimeout(90_000);
  await mockMain(page, { evidence: true });
  await page.goto('/main');

  await expect(page.getByRole('heading', { name: '우직 쌈밥집' })).toBeVisible({ timeout: 25_000 });
  await expandPeek(page); // 390px — 비교 헤더는 펼친 카드에 있다
  const header = page.getByText(COMPARE_HEADER).first();
  await expect(header).toBeVisible();
  // 대릉원(주변 공영주차 혼잡, 184m) → 우직 쌈밥집(실측 한산): 정말 덜 붐비는 다른 곳이라 화살표가 참이다.
  await expect(header).toContainText('지금 대릉원 혼잡 → 대신 우직 쌈밥집');
  await expect(header).toContainText('한산');
  await expect(page.getByText('줄 서는 대신', { exact: true })).toBeVisible();
});

test('with no congestion estimate and no parking evidence the first line is the benefit line', async ({ page }) => {
  test.setTimeout(90_000);
  await mockMain(page, { evidence: false });
  await page.goto('/main');

  await expect(page.getByRole('heading', { name: '우직 쌈밥집' })).toBeVisible({ timeout: 25_000 });
  await expandPeek(page); // 390px — 카드 첫 줄은 펼친 카드에 있다
  // 비교할 근거가 없으면 화살표 대신 관광객이 얻는 것: 이름 · 도보 N분 · 도착 시 영업 · 취향 N% 일치.
  const card = page.getByTestId('recommendation-card');
  const line = card.locator('p').filter({ hasText: /^우직 쌈밥집 · 도보 \d+분/ }).first();
  await expect(line).toBeVisible();
  await expect(line).toContainText('도착 시 영업');
  await expect(line).toContainText(/취향 \d+% 일치/);
  await expect(page.getByText(COMPARE_HEADER)).toHaveCount(0);
  await expect(card).not.toContainText('→');
  await expect(card).not.toContainText('인기 명소');
  await expect(line).not.toContainText('수집 중');
});

// ───────────────────────────────────────────────────────────────────────────
// ③ 가정 시간 셀렉트 · 경주 테마 칩 — 스켈레톤 → 카드 → 토스트
// ───────────────────────────────────────────────────────────────────────────

const skeletonOf = (page: Page) => page.getByText(/기준으로 다시 계산 중…/);

test.describe('recalculation feedback (desktop toolbar)', () => {
  // 🕒 가정 시간 셀렉트는 `hidden … md:flex` 툴바 안에 있어 모바일 폭에서는 렌더되지 않는다.
  // 기능 자체를 검증하기 위해 데스크톱 폭으로 연다(휴대폰 시간 조작은 지도 위 '혼잡 예측' 줄 쪽 e2e 가 잠근다).
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
// 390px(휴대폰) 도달 가능성 — 위 기능들이 실제로 손에 닿는가.
// 상단 컨트롤 줄은 `hidden … md:flex` 라 모바일에서는 렌더되지 않고,
// 그 대체 경로는 '필터·편의' 시트뿐이다.
// ───────────────────────────────────────────────────────────────────────────

test('festival chip lives in the 필터·편의 sheet at 390px', async ({ page }) => {
  test.setTimeout(90_000);
  await mockMain(page, { events: [] });
  await page.goto('/main');
  await expect(page.getByRole('heading', { name: '우직 쌈밥집' })).toBeVisible({ timeout: 25_000 });

  // 카드는 짧은 미리보기로 떠 있으므로 '필터·편의' 버튼이 가려지지 않는다 — 실제로 눌러 연다.
  const tools = page.getByRole('button', { name: '필터·편의' });
  await expectTappable(tools);
  await tools.click();
  const festival = page.getByRole('button', { name: /경주 축제·행사/ }).locator('visible=true');
  await expect(festival).toHaveCount(1);
  // 시트 맨 아래 줄(축제·화장실)이 하단 내비 위로 그려지는지는 여기서 보지 않는다 — 시트 아래 여백으로
  // 피하던 임시 처리를 빼고, 페이지 진입 애니메이션의 쌓임 맥락을 고치는 쪽(계획 A11/I66)이
  // 자기 e2e(fixed-overlays)로 잠근다.
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

// ───────────────────────────────────────────────────────────────────────────
// ⑤ 휴대폰 추천 카드 미리보기 — 카드가 지도와 톱바를 덮지 않는다(PM 2026-09-26).
//   미리보기: 이름 · 도보 N분 · 혼잡 배지 · 도보 길안내. 누르거나 위로 밀면 전체 카드, 아래로 밀면 다시 미리보기.
// ───────────────────────────────────────────────────────────────────────────

/** 카드를 마우스로 끌어 민다(framer-motion drag 는 포인터 이벤트라 마우스로도 같은 경로를 탄다). */
async function swipeCard(page: Page, dy: number): Promise<void> {
  // 접힘·펼침 layout 애니메이션이 끝나 카드가 제자리에 선 뒤에 민다(사람도 그렇게 민다).
  // 150ms 간격으로 잰 위치·높이가 **세 번 연달아** 같아야 멈춘 것으로 본다 — 곧바로 잇단 두 번 읽기는
  // 상태가 바뀐 직후 애니메이션이 첫 프레임을 그리기 전이라 같게 나올 수 있다(그러면 옛 자리를 민다).
  const card = page.getByTestId('recommendation-card');
  let box: Awaited<ReturnType<Locator['boundingBox']>> = null;
  let stableReads = 0;
  await expect.poll(async () => {
    const next = await card.boundingBox();
    const same = !!box && !!next && Math.abs(next.y - box.y) < 0.5 && Math.abs(next.height - box.height) < 0.5;
    stableReads = same ? stableReads + 1 : 0;
    box = next;
    return stableReads;
  }, { intervals: [150] }).toBeGreaterThanOrEqual(3);
  if (!box) throw new Error('recommendation card is not on screen');
  const { x: left, y: top, width } = box;
  // 손잡이 줄에서 시작한다 — 그 점이 정말 카드 위인지 먼저 확인한다(지도를 밀면 카드가 아니라 지도가 움직인다).
  const x = left + width / 2;
  const y = top + 14;
  const onCard = await card.evaluate((el, [px, py]) => {
    const hit = document.elementFromPoint(px, py);
    return !!hit && el.contains(hit);
  }, [x, y] as const);
  expect(onCard, 'swipe must start on the recommendation card').toBe(true);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(x, y + (dy * step) / 8);
  await page.mouse.up();
}

async function stubWindowOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.open = ((url?: string | URL) => {
      (window as unknown as { __opened?: string }).__opened = String(url);
      return window;
    }) as typeof window.open;
  });
}

test.describe('phone recommendation peek', () => {
  test('opens as a peek; tap expands, swipe down returns, swipe up expands, then 도보 길안내 starts the walk', async ({ page }) => {
    test.setTimeout(90_000);
    await stubWindowOpen(page);
    await mockMain(page, { evidence: true });
    await page.goto('/main');

    const peek = page.getByTestId('rec-card-peek');
    await expect(peek).toBeVisible({ timeout: 25_000 });
    // 미리보기에는 관광객이 지금 알아야 할 것만 — 이름 · 도보 N분 · 혼잡(전체 카드와 같은 배지 문구).
    await expect(peek.getByRole('heading', { name: '우직 쌈밥집' })).toBeVisible();
    await expect(peek).toContainText('도보 4분');
    await expect(peek).toContainText('혼잡도: 한산');
    await expect(peek.getByRole('button', { name: '여기로 길안내 시작' })).toBeVisible();
    await expect(page.getByText(COMPARE_HEADER)).toHaveCount(0);

    // 미리보기 줄을 누르면 전체 카드.
    await peek.getByRole('heading', { name: '우직 쌈밥집' }).click();
    await expect(peek).toBeHidden();
    await expect(page.getByText(COMPARE_HEADER).first()).toBeVisible();
    await expect(page.getByRole('button', { name: '추천 간단히 보기' })).toHaveAttribute('aria-expanded', 'true');

    // 아래로 밀면 미리보기, 위로 밀면 다시 전체 카드.
    await swipeCard(page, 160);
    await expect(peek).toBeVisible();
    await swipeCard(page, -160);
    await expect(peek).toBeHidden();
    await expect(page.getByText(COMPARE_HEADER).first()).toBeVisible();

    // 전체 카드의 도보 길안내.
    await page.getByRole('button', { name: '여기로 길안내 시작' }).click();
    const active = await page.evaluate(() => JSON.parse(localStorage.getItem('nextspot_active_trip') ?? 'null'));
    expect(active.facilityId).toBe('cand-restaurant');
    expect(active.status).toBe('navigating');
    expect(await page.evaluate(() => (window as unknown as { __opened?: string }).__opened)).toContain('map.kakao.com');
  });

  test('도보 길안내 in the peek works like the full card without expanding it', async ({ page }) => {
    test.setTimeout(90_000);
    await stubWindowOpen(page);
    await mockMain(page, { evidence: true });
    await page.goto('/main');

    const peek = page.getByTestId('rec-card-peek');
    await expect(peek).toBeVisible({ timeout: 25_000 });
    const go = peek.getByRole('button', { name: '여기로 길안내 시작' });
    await expectTappable(go);
    await go.click();
    const active = await page.evaluate(() => JSON.parse(localStorage.getItem('nextspot_active_trip') ?? 'null'));
    expect(active.facilityId).toBe('cand-restaurant');
    expect(active.status).toBe('navigating');
    expect(active.navigationMode).toBe('walk');
    expect(await page.evaluate(() => (window as unknown as { __opened?: string }).__opened)).toContain('map.kakao.com');
    await expect(page.getByText(COMPARE_HEADER)).toHaveCount(0);
  });

  for (const viewport of [
    { width: 360, height: 640 },
    { width: 360, height: 740 },
    { width: 390, height: 844 },
    { width: 414, height: 896 },
  ]) {
    test(`search, ✨, chips and 필터·편의 stay tappable with the peek open at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(viewport);
      await mockMain(page, { events: [] });
      await page.goto('/main');
      await expect(page.getByTestId('rec-card-peek')).toBeVisible({ timeout: 25_000 });

      const search = page.getByPlaceholder('장소·메뉴·분위기 검색');
      const discovery = page.getByRole('button', { name: /경주가 처음이라면/ });
      const cafe = page.getByRole('button', { name: '카페', exact: true });
      const tools = page.getByRole('button', { name: '필터·편의' });
      const go = page.getByTestId('rec-card-peek').getByRole('button', { name: '여기로 길안내 시작' });
      for (const control of [search, discovery, page.getByRole('button', { name: '음식점', exact: true }), cafe, tools, go]) {
        await expectTappable(control);
      }

      // 실제 클릭 — 검색창은 포커스를 받는다.
      await search.click();
      await expect(search).toBeFocused();

      // 필터·편의 → 시트가 열리고, 닫으면 미리보기가 그대로다.
      await tools.click();
      const sheetTitle = page.getByRole('heading', { name: '필터와 여행 편의' });
      await expect(sheetTitle).toBeVisible();
      await page.locator('section').filter({ has: sheetTitle }).getByRole('button', { name: '닫기' }).click();
      await expect(sheetTitle).toBeHidden();
      await expect(page.getByTestId('rec-card-peek')).toBeVisible();

      // 카테고리 칩 → 새 추천도 미리보기로 열린다.
      await cafe.click();
      await expect(page.getByTestId('rec-card-peek').getByRole('heading', { name: '우직 한옥카페' }))
        .toBeVisible({ timeout: 25_000 });

      // ✨ 경주가 처음이라면 → 테마 칩이 펼쳐진다.
      await expectTappable(discovery);
      await discovery.click();
      await expect(page.getByRole('button', { name: /신라 핵심 산책/ })).toBeVisible();
    });
  }

  // 진짜 손가락(터치)으로 누른다. CI 기본 프로젝트는 마우스뿐이라 이 묶음만 터치를 켠다.
  // 사람의 탭은 몇 px 흔들린다 — framer-motion 은 3px 부터 '드래그' 로 보지만 브라우저는 그 탭에 click 을
  // 그대로 보낸다. 그 click 을 버리면 휴대폰에서 도보 길안내가 가끔 아무 반응을 안 한다(검증 2026-09-26).
  test.describe('with a real touchscreen', () => {
    test.use({ hasTouch: true, isMobile: true });

    /** 터치를 points 순서대로 움직였다가 뗀다(CDP — Playwright 의 tap 은 움직임을 줄 수 없다). */
    async function touchPath(page: Page, points: Array<[number, number]>, stepDelayMs = 30): Promise<void> {
      const cdp = await page.context().newCDPSession(page);
      const [x0, y0] = points[0];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
      for (const [x, y] of points.slice(1)) {
        await page.waitForTimeout(stepDelayMs);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      }
      await page.waitForTimeout(stepDelayMs);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    }

    async function centerOf(target: Locator): Promise<[number, number]> {
      const box = await target.boundingBox();
      if (!box) throw new Error('target is not on screen');
      return [box.x + box.width / 2, box.y + box.height / 2];
    }

    async function openPeek(page: Page): Promise<Locator> {
      await stubWindowOpen(page);
      await mockMain(page, { evidence: true });
      await page.goto('/main');
      const peek = page.getByTestId('rec-card-peek');
      await expect(peek).toBeVisible({ timeout: 25_000 });
      // 등장 애니메이션이 끝나 제자리에 선 뒤에 누른다(사람도 멈춘 버튼을 누른다) — swipeCard 와 같은 판정:
      // 150ms 간격으로 잰 위치가 세 번 연달아 같아야 멈춘 것으로 본다.
      let lastY: number | null = null;
      let stableReads = 0;
      await expect.poll(async () => {
        const y = (await peek.boundingBox())?.y ?? null;
        stableReads = y !== null && lastY !== null && Math.abs(y - lastY) < 0.5 ? stableReads + 1 : 0;
        lastY = y;
        return stableReads;
      }, { intervals: [150] }).toBeGreaterThanOrEqual(3);
      return peek;
    }

    test('a slightly shaky tap on the peek 도보 길안내 still starts the walk', async ({ page }) => {
      test.setTimeout(90_000);
      const peek = await openPeek(page);
      const go = peek.getByRole('button', { name: '여기로 길안내 시작' });
      await expectTappable(go);
      const [x, y] = await centerOf(go);
      // 6px 흔들린 탭 — 드래그 시작(3px)은 넘지만 밀기는 아니다.
      await touchPath(page, [[x, y], [x + 2, y + 3], [x + 2, y + 6]]);
      await expect.poll(() => page.evaluate(() =>
        JSON.parse(localStorage.getItem('nextspot_active_trip') ?? 'null')?.status ?? null)).toBe('navigating');
      expect(await page.evaluate(() => (window as unknown as { __opened?: string }).__opened)).toContain('map.kakao.com');
    });

    test('a slightly shaky tap on the peek title expands the card', async ({ page }) => {
      test.setTimeout(90_000);
      const peek = await openPeek(page);
      const [x, y] = await centerOf(peek.getByRole('heading', { name: '우직 쌈밥집' }));
      await touchPath(page, [[x, y], [x, y - 3], [x + 1, y - 6]]);
      await expect(peek).toBeHidden();
      await expect(page.getByText(COMPARE_HEADER).first()).toBeVisible();
    });

    test('a swipe up that starts on 도보 길안내 opens the card and does not start the walk', async ({ page }) => {
      test.setTimeout(90_000);
      const peek = await openPeek(page);
      const [x, y] = await centerOf(peek.getByRole('button', { name: '여기로 길안내 시작' }));
      await touchPath(page, [[x, y], [x, y - 20], [x, y - 45], [x, y - 70], [x, y - 90]], 16);
      await expect(peek).toBeHidden();
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => localStorage.getItem('nextspot_active_trip'))).toBeNull();
      expect(await page.evaluate(() => (window as unknown as { __opened?: string }).__opened ?? null)).toBeNull();
    });
  });
});
