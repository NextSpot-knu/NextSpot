import { expect, test, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 심사위원 경로 회귀 테스트 ③ — 대기 보드 · 임팩트 · 404 · 서비스 소개의 '데이터' 절.
//
// 모든 네트워크는 스텁이다(프로덕션 API 로 나가는 요청 없음). 카탈-올을 먼저 등록하고
// 구체 경로를 나중에 등록한다 — Playwright 는 나중에 등록한 라우트가 이긴다.

async function stubBase(page: Page): Promise<void> {
  await stubExternalServices(page);
  await page.addInitScript(() => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    localStorage.setItem('nextspot_locale', 'ko');
  });
  await page.route('**/rest/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
}

// ───────────────────────────────────────────────────────────────────────────
// ⑤ 대기 보드 — 같은 유형 안에서 카드마다 숫자가 **갈려야** 한다.
//    (원래 결함: 모든 카드가 같은 '예상 대기 약 N분'을 보여줬다.)
// ───────────────────────────────────────────────────────────────────────────

const BOARD_TYPES = ['restaurant', 'cafe', 'attraction', 'culture'] as const;

// 대기 모델은 도착 시각(KST)의 시간대 곡선을 탄다 — 자정 무렵에 돌리면 모든 음식점 대기가 1~3분으로
// 모여 '카드마다 갈린다'는 단언이 실행 시각에 따라 깨진다. 오늘 KST 12:30(점심)에 브라우저 시계를 고정하고
// 응답의 관측 시각도 같은 순간으로 맞춰, 언제 돌려도 같은 화면을 본다.
const BOARD_NOW = new Date(`${new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10)}T12:30:00+09:00`);

/** 같은 유형 안에서 혼잡·좌석 규모·관광 기준지 거리를 모두 다르게 준다 — 이게 숫자를 가르는 실데이터다. */
function boardRows(type: string) {
  const spread = [
    { level: 0.31, capacity: 12, distance: 120 },
    { level: 0.48, capacity: 24, distance: 560 },
    { level: 0.63, capacity: 40, distance: 1100 },
    { level: 0.79, capacity: 60, distance: 1700 },
    { level: 0.94, capacity: 90, distance: 2400 },
  ];
  return spread.map((row, index) => ({
    recommendation_id: `rec-${type}-${index}`,
    facility: {
      id: `${type}-${index}`,
      name: `${type} 후보 ${index + 1}`,
      type,
      latitude: 35.834 + index * 0.001,
      longitude: 129.209 + index * 0.001,
      capacity: row.capacity,
      features: {},
      address: `경주시 스텁로 ${index + 1}`,
      operating_hours: { open: '00:00~23:59', closed: '연중무휴' },
    },
    spot_score: 0.8 - index * 0.05,
    distance_m: 200 + index * 120,
    rank: index + 1,
    total_candidates: spread.length,
    reason: '스텁 사유',
    reason_source: 'template',
    // 실측 혼잡을 '지금' 자격으로 준다 — congestionDisplay 가 measured 로 읽어야 카드가 가른다.
    congestion_level: row.level,
    congestion_source: 'measured',
    congestion_log_source: 'sensor',
    congestion_is_stale: false,
    congestion_is_current: true,
    congestion_timestamp: BOARD_NOW.toISOString(),
    open_status_at_arrival: 'open_expected',
    scoring_mode: 'area_stats_rules',
    prediction_source: 'unavailable',
    breakdown: {
      preference: 0.7,
      // 서버 검증 대기는 없다(프로덕션과 같다) — 화면이 모델 곡선으로 세 숫자를 만들어야 한다.
      wait_time: null,
      travel_time: 3 + index,
      incentive: 0,
      area_demand_level: row.level,
      area_demand_mode: 'live',
      area_demand_sources: ['parking', 'tourism'],
      area_demand_tourism_evidence: {
        reference_name: '대릉원',
        distance_m: row.distance,
        forecast_date: '2026-09-21',
        relative_index: Math.round(row.level * 100),
      },
    },
  }));
}

test('waiting board gives every card its own wait, grade and calm hour', async ({ page }) => {
  test.setTimeout(120_000);
  await stubBase(page);
  await page.route('**/api/v1/recommendations/by-type', (route) => {
    const body = route.request().postDataJSON() as { facility_type?: string } | null;
    const type = String(body?.facility_type ?? 'restaurant');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(BOARD_TYPES.includes(type as (typeof BOARD_TYPES)[number]) ? boardRows(type) : []),
    });
  });

  await page.clock.setFixedTime(BOARD_NOW);
  await page.goto('/waiting');
  await expect(page.getByRole('heading', { name: '음식점' })).toBeVisible({ timeout: 40_000 });

  // 한 섹터(음식점) 안에서 세 숫자가 모두 나오고, 대기 값이 최소 3가지로 갈려야 한다.
  const sector = page.locator('section').filter({ has: page.getByRole('heading', { name: '음식점' }) }).first();

  const waits = await sector.getByText(/예상 대기 약 \d+분|대기 없음/).allTextContents();
  expect(waits.length, '음식점 섹터에 대기 표기가 하나도 없다').toBeGreaterThanOrEqual(3);
  const distinct = new Set(waits.map((w) => w.trim()));
  expect(
    distinct.size,
    `같은 유형 카드들의 예상 대기가 갈리지 않는다: ${[...distinct].join(' / ')}`,
  ).toBeGreaterThanOrEqual(3);

  // 등급 칩과 '한산' 시각도 카드마다 함께 붙는다.
  await expect(sector.getByText(/^(여유|보통|혼잡)$/).first()).toBeVisible();
  await expect(sector.getByText(/\d+시 이후 한산|지금이 가장 한산/).first()).toBeVisible();

  // 네 유형 섹터가 모두 뜬다(응답이 있는 유형은 섹터를 숨기지 않는다).
  for (const heading of ['음식점', '카페', '관광지', '문화시설']) {
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// ⑥ 임팩트 — 401 이어도 에러·빈 화면 금지. 예시 숫자도 내지 않는다(PM 4.19a — '나의' 숫자가 아닌 값을
//    게스트에게 보이지 않는다. 09-21 '예시 값' 배지 결정을 뒤집음). 상세 화면은 '지도에서 시작' 시작 상태.
// ───────────────────────────────────────────────────────────────────────────

const SAMPLE_NUMBERS = /예시 값|312|1,240|참여 점포|분산 유도/;

async function stubImpact401(page: Page): Promise<{ impactCalls: () => number }> {
  await stubBase(page);
  let impactCalls = 0;
  await page.route('**/api/v1/impact/summary', (route) => {
    impactCalls += 1;
    return route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"unauthorized"}' });
  });
  return { impactCalls: () => impactCalls };
}

test('mypage impact card shows no sample numbers and no error when the API returns 401', async ({ page }) => {
  test.setTimeout(120_000);
  const api = await stubImpact401(page);
  await page.goto('/mypage');

  // 401 첫 실패는 2.5초 유예 뒤 1회 자동 재시도 — 재시도까지 끝난 화면을 본다(예전에는 이때 예시 값이 떴다).
  await expect.poll(api.impactCalls, { timeout: 40_000 }).toBeGreaterThan(1);
  await page.waitForTimeout(1_000);
  await expect(page.locator('body')).not.toContainText(SAMPLE_NUMBERS);
  // 에러·빈 상태 문구가 보이면 안 된다.
  await expect(page.getByText('여행 기록을 다시 불러올게요')).toHaveCount(0);
  await expect(page.getByText('여행 임팩트가 여기에 쌓입니다')).toHaveCount(0);
});

test('mypage impact detail shows the start state, not sample numbers, when the API returns 401', async ({ page }) => {
  test.setTimeout(120_000);
  await stubImpact401(page);
  await page.goto('/mypage/impact');

  await expect(page.getByRole('button', { name: '지도에서 시작' })).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('body')).not.toContainText(SAMPLE_NUMBERS);
  await expect(page.getByText('여행 기록을 다시 불러올게요')).toHaveCount(0);
  await expect(page.getByText('여행 임팩트가 여기에 쌓입니다')).toHaveCount(0);
});

// ───────────────────────────────────────────────────────────────────────────
// ⑦ 404 — 브랜드 화면 + 지도로 돌아가는 길.
// ───────────────────────────────────────────────────────────────────────────

test('an unknown route renders the branded 404 with a link back to the map', async ({ page }) => {
  test.setTimeout(90_000);
  await stubBase(page);
  await page.goto('/this-route-does-not-exist-9f2a');

  await expect(page.getByRole('heading', { name: '길을 잘못 드셨어요' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('404', { exact: true })).toBeVisible();
  const back = page.getByRole('link', { name: '지도로 돌아가기' });
  await expect(back).toHaveAttribute('href', '/main');
  await back.click();
  await expect(page).toHaveURL(/\/main/);
});

// ───────────────────────────────────────────────────────────────────────────
// ⑧ 서비스 소개의 '데이터' 절 — 출처 표 + 신선도 폴백 + 홈 푸터 진입.
// ───────────────────────────────────────────────────────────────────────────

const FRESHNESS_FALLBACK =
  '한국관광공사 TourAPI 관광정보는 매일 04:00(KST)에 일괄 적재하고, 장소 상세·축제·키워드 검색은 요청할 때 불러옵니다.';

test('guide data fold carries the source table and falls back when freshness fails', async ({ page }) => {
  test.setTimeout(90_000);
  await stubBase(page);
  // 신선도는 공개 GET 이지만 실패해도 정적 문장으로 조용히 폴백해야 한다.
  await page.route('**/api/v1/freshness**', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"down"}' }),
  );
  await page.goto('/guide');

  const fold = page.locator('details').filter({ has: page.getByText('데이터', { exact: true }) }).first();
  await expect(fold).toBeVisible({ timeout: 30_000 });
  // 이 절은 **기본 접힘**이다(service-guide.spec.ts 가 잠근다). 펼쳐서 표와 신선도 폴백을 본다.
  await expect(fold).not.toHaveAttribute('open', '');
  await fold.locator('summary').click();
  await expect(fold).toHaveAttribute('open', '');

  const table = fold.getByRole('table');
  await expect(table).toBeVisible();
  // 표에는 '출처 기관 · 사용 API · 화면 · 갱신 주기' 네 열이 있고, 코드에 실제로 있는 오퍼레이션만 적힌다.
  for (const column of ['출처 기관', '사용한 API·데이터셋', '서비스에서 쓰이는 화면', '갱신 주기']) {
    await expect(table.getByRole('columnheader', { name: column })).toBeVisible();
  }
  await expect(table.getByText('한국관광공사 TourAPI').first()).toBeVisible();
  await expect(table.getByText('searchFestival2')).toBeVisible();
  await expect(table.getByText('getVilageFcst')).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(11); // 헤더 1 + 출처 10(키워드 검색 searchKeyword2 행 추가)

  // 신선도 실패 → 시각을 지어내지 않고 정적 문장으로 내려앉는다.
  await expect(fold.getByText(FRESHNESS_FALLBACK)).toBeVisible();
  await expect(fold.getByText('동기화 시각을 확인하는 중입니다…')).toHaveCount(0);

  // 접는 장치 자체는 살아 있어야 한다(접었다 다시 펼치기).
  await fold.locator('summary').click();
  await expect(fold).not.toHaveAttribute('open', '');
  await fold.locator('summary').click();
  await expect(fold).toHaveAttribute('open', '');
});

test('the home footer 데이터 출처 line opens the guide with the data fold already expanded', async ({ page }) => {
  test.setTimeout(90_000);
  await stubBase(page);
  await page.route('**/api/v1/freshness**', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"down"}' }),
  );
  await page.goto('/');

  await page.getByRole('button', { name: /데이터 출처/ }).click();
  const dialog = page.getByRole('dialog', { name: 'NextSpot 알아보기' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });

  // 이 절은 기본 접힘이므로, 여기서 펼쳐져 있다는 것은 푸터 줄의 신호(lib/guideDataSection.ts)가
  // 소개 본문까지 도달했다는 뜻이다 — '푸터 줄을 누르면 소개가 열리고, 데이터 표가 곧바로 보인다'.
  const fold = dialog.locator('details').filter({ has: page.getByText('데이터', { exact: true }) }).first();
  await expect(fold).toHaveAttribute('open', '');
  await expect(fold.getByRole('table')).toBeVisible();
  await expect(fold.getByText(FRESHNESS_FALLBACK)).toBeVisible();
  // 홈에 머문 채로 열린다(라우팅하지 않는다).
  await expect(page).toHaveURL(/\/$/);
});
