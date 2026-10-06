import { expect, test, type Page, type Route } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 관제 대시보드를 **데스크톱 노트북(1536×730 — 1536×864 화면에서 브라우저 크롬을 뺀 높이)** 으로 여는 심사 동선.
//
// 잠그는 것:
//   · 첫 화면에 기능설명서의 KPI 네 개(평균 혼잡도·추천 수락률·활성 사용자·이상 혼잡)가 스크롤 없이 다 들어온다.
//     가장 키가 큰 실제 조합(추정 모드 + 오늘의 브리핑)으로 잰다.
//   · 산식은 '산식 보기' 를 열어야 보이고, 추천 신뢰도 패널은 맨 아래에 그대로 보인다.
//   · 사이드바는 한국어이고 '엔진 검증' 은 메뉴에 없다(화면은 URL 로 열린다).
//
// 실계정·실서버는 쓰지 않는다. 관리자 판정(/account/me)과 관리자 API·Supabase REST 는 전부 스텁이다.

const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const todayKst = new Date(NOW + 9 * 3_600_000).toISOString().slice(0, 10);

const FACILITIES = [
  { id: '2001', name: '교리김밥', type: 'restaurant', capacity: 46, operating_hours: '10:00~21:00', is_active: true, coupon_rate: 0.1 },
  { id: '2002', name: '이풍녀 구로쌈밥', type: 'restaurant', capacity: 40, operating_hours: '10:00~21:00', is_active: true, coupon_rate: 0 },
  { id: '2003', name: '불국사', type: 'attraction', capacity: 400, operating_hours: '09:00~18:00', is_active: true, coupon_rate: 0 },
  { id: '2004', name: '황리단길 카페', type: 'cafe', capacity: 30, operating_hours: '10:00~22:00', is_active: true, coupon_rate: 0 },
];

// 추정 모드(오늘 실측 없음 → 공영주차 실측 + 관광공사 집중률) — 라이브에서 가장 흔한 상태다.
const DASHBOARD_TODAY = {
  hasLogs: false,
  sampleCount: 0,
  sourceComposition: {},
  estimated: {
    hasLogs: true,
    dateKst: todayKst,
    avgCongestion: { value: 0.47, changePercent: 3.1, changePercentOrNull: 3.1, prevSampleCount: 120 },
    anomalyCount: 4,
    heatmap: ['불국사', '첨성대', '대릉원'].flatMap((facility) =>
      [9, 10, 11, 12, 13].map((hour) => ({ facility, facilityType: 'attraction', hour, value: 0.3 + hour / 40 })),
    ),
    anomalies: [{ id: 'a1', facilityName: '천마총(대릉원)', timestamp: iso(40), congestionLevel: 0.92, durationMinutes: 10 }],
    sampleCount: 74,
    basis: {
      lotCountMax: 6,
      latestObservedAt: iso(3),
      radiusM: 2000,
      placeCount: 8,
      estimatedFacilityCount: 612,
      facilityCount: 1669,
      snapshotCount: 74,
      weights: { parking: 0.7, tourism: 0.3 },
    },
  },
};

const METRICS = {
  since: iso(8 * 24 * 60),
  recommendations: Array.from({ length: 40 }, (_, i) => ({ accepted: i % 4 === 0, created_at: iso(30 + i * 60) })),
  feedback: Array.from({ length: 12 }, (_, i) => ({ user_id: `u${i % 7}`, timestamp: iso(5 + i) })),
  truncated: false,
};

const MODEL_TRUST = {
  model: { trained: false, version: null, real_data_count: 0, mae: null },
  registry: null,
  funnel: { exposures: 4812, navigations: 37, arrivals: 3, positive_ratings: 2, verified_visit_success_rate: 0 },
  top3_evidence: { coverage_rate: 0.62, fresh_rate: 0.3, fresh_trusted_measured_rate: 0.1, operating_hours_rate: 0.91 },
  collection: {
    observations: 12,
    trusted_observations: 3,
    remaining_to_candidate: 47,
    active_facilities: 1669,
    trusted_facility_coverage_rate: 0.002,
    by_source: { user_report: 9, merchant: 3 },
    by_evidence_tier: {},
    facility_gaps: [],
  },
  guardrails: { warnings: [], walk_limit_violations: 0, scoring_modes: { degraded_rules: 4812 } },
};

const BRIEFING =
  '오늘 경주 주요 관광지의 추정 혼잡도는 오후 1시 무렵 가장 높았고, 대릉원 일원에서 90%를 넘는 구간이 4번 있었습니다. 수락된 추천 10건이 덜 붐비는 곳으로 방문을 나눴습니다.';

function json(route: Route, status: number, body: unknown, headers: Record<string, string> = {}) {
  return route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
}

/** 관리자 세션 — /account/me 가 admin 을 말하고, 관리자 API·Supabase REST 는 고정 응답으로 닫는다. */
async function stubAdminConsole(page: Page): Promise<void> {
  await page.route('**/rest/v1/**', (route) => {
    const url = route.request().url();
    if (route.request().method() === 'HEAD') {
      // count(head:true) — 관광정보 시설 수(① 부제)·설정 화면 통계. 교차 출처라 content-range 를 읽게 노출한다.
      return route.fulfill({
        status: 200,
        headers: {
          'content-range': '*/1669',
          'access-control-allow-origin': '*',
          'access-control-expose-headers': 'content-range',
        },
        body: '',
      });
    }
    if (url.includes('/facilities')) return json(route, 200, FACILITIES, { 'content-range': `0-${FACILITIES.length - 1}/${FACILITIES.length}` });
    return json(route, 200, []);
  });

  await page.route('**/api/v1/**', (route) => {
    const url = route.request().url();
    if (url.includes('/account/me')) {
      return json(route, 200, {
        id: '00000000-0000-4000-8000-0000000000ad',
        role: 'admin',
        is_anonymous: false,
        nickname: '관제 담당자',
        owned_facilities: [],
        pending_verification: false,
      });
    }
    if (url.includes('/admin/dashboard/today')) return json(route, 200, DASHBOARD_TODAY);
    if (url.includes('/admin/dashboard/briefing')) return json(route, 200, { briefing: BRIEFING, llmStatus: 'llm' });
    if (url.includes('/admin/metrics/trend')) return json(route, 200, { daily: [], truncated: false });
    if (url.includes('/admin/metrics')) return json(route, 200, METRICS);
    if (url.includes('/admin/model-trust')) return json(route, 200, MODEL_TRUST);
    // 나머지 관리자 API 는 '아직 없음' 으로 닫는다 — 해당 카드는 실패 상태를 그리고, 첫 화면 검사는 그대로 성립한다.
    return json(route, 404, { detail: 'not stubbed' });
  });
}

async function openDashboard(page: Page): Promise<void> {
  await page.goto('/admin/dashboard');
  await expect(page.locator('#dashboard-kpis')).toBeVisible({ timeout: 30_000 });
  // 첫 로드 동기화 스트립이 걷히고(KPI 네 개 도착), 브리핑·관광정보 수까지 그려진 '가장 키 큰' 첫 화면을 잰다.
  await expect(page.getByText('실시간 관제 데이터 동기화 중')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText(BRIEFING)).toBeVisible();
  await expect(page.getByText(/경주 관광정보 1,669곳 · 경주 ITS 공영주차\(10분마다\)로/)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await stubExternalServices(page);
  await stubAdminConsole(page);
});

test('1536×730 — 첫 화면에 KPI 네 개, 산식은 접혀 있고 추천 신뢰도는 맨 아래에 보인다', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 730 });
  await openDashboard(page);

  const kpis = page.locator('#dashboard-kpis');
  for (const title of ['오늘 평균 혼잡도', 'AI 추천 수락률', '활성 사용자 수 (DAU)', '이상 혼잡 발생 (오늘)']) {
    await expect(kpis.getByText(title, { exact: true })).toBeVisible();
  }
  const box = await kpis.boundingBox();
  expect(box, 'KPI 격자 상자').not.toBeNull();
  const kpiBottom = box!.y + box!.height;
  console.log(`KPI grid bottom at 1536×730: ${Math.round(kpiBottom)}px`);
  expect(kpiBottom, 'KPI 격자 아래 끝(px) — 스크롤 없이 첫 화면에 다 들어와야 한다').toBeLessThan(730);

  // ① 아래 출처 한 줄.
  await expect(page.getByText('출처: ⓒ한국관광공사', { exact: true })).toBeVisible();

  // 추정 배너는 한 줄 — 산식은 '산식 보기' 를 열어야 보인다.
  await expect(page.getByText('오늘 시설 혼잡은 공영주차 실측과 관광공사 통계로 추정했어요')).toBeVisible();
  // KPI 툴팁에도 같은 산식이 있다 — 배너의 접힌 상자 안만 본다.
  const formula = page.locator('details', { hasText: '산식 보기' }).getByText(/혼잡도 = 0\.7 × 주변 공영주차 점유율/);
  await expect(formula).toBeHidden();
  await page.getByText('산식 보기').click();
  await expect(formula).toBeVisible();

  // 추천 신뢰도 패널은 KPI 아래(맨 끝)에 그대로 있고, 스크롤하면 보인다.
  const trust = page.getByRole('region', { name: '추천 모델 신뢰도' });
  await trust.scrollIntoViewIfNeeded();
  await expect(trust).toBeVisible();
  const trustBox = await trust.boundingBox();
  const kpiAfterScroll = await kpis.boundingBox();
  expect(trustBox!.y, '추천 신뢰도 패널이 KPI 격자보다 아래에 있다').toBeGreaterThan(kpiAfterScroll!.y + kpiAfterScroll!.height);
  await expect(page.locator('main a[href="/admin/engine-validation"]')).toBeVisible();

  // 서울 데이터 문구는 경주 관제 화면에 없다.
  await expect(page.locator('main')).not.toContainText('서울');
});

test('사이드바는 한국어 메뉴이고 엔진 검증은 메뉴에 없다', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 730 });
  await openDashboard(page);

  const nav = page.locator('aside nav');
  for (const label of ['관제 대시보드', '장소 관리', 'SPOT 시뮬레이터', '문의 관리', '시스템 설정']) {
    await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
  }
  await expect(nav.locator('a[href="/admin/engine-validation"]')).toHaveCount(0);
  const navText = (await nav.innerText()).replace(/SPOT/g, '');
  expect(navText, '메뉴에 영어가 남아 있다').not.toMatch(/[A-Za-z]/);
});
