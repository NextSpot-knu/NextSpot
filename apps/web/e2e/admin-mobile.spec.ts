import { writeFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 관제 콘솔을 **휴대폰(390px)** 으로 여는 심사위원 동선.
//
// 관제 화면은 데스크톱 기준으로 만들어졌다 — 고정 폭 사이드바(256px)가 390px 화면의 3분의 2를
// 차지해, 본문 표가 한 칸 40px 남짓으로 짓눌렸다. 이 스펙이 잠그는 것은 세 가지다:
//   · 어느 관제 화면도 본문이 화면 밖으로 밀려나지 않는다(표는 카드 **안에서만** 가로로 민다)
//   · 표의 칸이 글자를 읽을 수 있는 폭을 유지한다
//   · 사이드바가 접혀도 메뉴(다른 관제 화면·관광객 앱·로그아웃)에 닿을 수 있다
//
// 실계정·실서버는 쓰지 않는다. 관리자 판정(/account/me)과 관리자 API·Supabase REST 는 전부 스텁이다.

const ADMIN_ROUTES = [
  '/admin/dashboard',
  '/admin/infrastructure',
  '/admin/simulator',
  '/admin/reports',
  '/admin/safety',
  '/admin/report',
  '/admin/engine-validation',
  '/admin/support',
  '/admin/settings',
] as const;

/** 심사 기간에 메뉴에서만 감춘 화면(components/AdminSidebar.tsx HIDDEN_FROM_MENU) — 화면 자체는 위 목록처럼 URL 로 열린다. */
const HIDDEN_FROM_MENU = new Set<string>(['/admin/engine-validation']);

/** 읽을 수 있는 최소 칸 폭(px). 한글 두 글자 + 좌우 여백이 들어가는 폭이다. */
const MIN_CELL_WIDTH = 44;

const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const FACILITIES = Array.from({ length: 8 }, (_, i) => ({
  id: String(1000 + i),
  name: ['불국사', '석굴암', '첨성대', '동궁과 월지', '황리단길 카페', '교리김밥', '대릉원', '경주국립박물관'][i],
  type: ['attraction', 'attraction', 'attraction', 'attraction', 'cafe', 'restaurant', 'attraction', 'culture'][i],
  capacity: 120 + i * 40,
  operating_hours: '09:00-18:00',
  is_active: true,
  coupon_rate: i % 3 === 0 ? 10 : 0,
  updated_at: iso(60),
}));

const INQUIRIES = [
  { id: 'q1', user_id: 'u1', user_name: '관광객 A', type: '이용 문의', title: '쿠폰은 어디서 확인하나요?', content: '받은 쿠폰을 다시 보고 싶어요.', status: 'new', created_at: iso(30) },
  { id: 'q2', user_id: null, user_name: null, type: '오류 신고', title: '지도가 늦게 떠요', content: '첫 화면 지도가 늦게 보입니다.', status: 'in_progress', created_at: iso(300) },
  { id: 'q3', user_id: 'u3', user_name: '관광객 C', type: '제안', title: '야간 코스도 추천해 주세요', content: '동궁과 월지 야경 코스가 있으면 좋겠어요.', status: 'resolved', created_at: iso(3000), reply_body: '야간 코스를 준비하고 있어요.', replied_at: iso(2000) },
];

// 안전 경보 — 최근 30분 관측만으로 판정한 새 응답 모양(P0-4: judgement · 존별 관측 시각 · 출처). 존 카드의 관측 줄
// ('관측 HH:MM · N분 전 · 손님 제보 2 · 관리자 입력 1')이 390px 에서도 카드 밖으로 밀리지 않는지 함께 본다.
const SAFETY_STATUS = {
  generatedAt: iso(1),
  judgement: 'available',
  sampleEmpty: false,
  thresholds: { alert: 0.9, warn: 0.7 },
  meta: { zoneMethod: 'grid150m', maxObservationAgeMinutes: 30 },
  observedFacilities: 15,
  staleFacilities: 3,
  latestObservedAt: iso(5),
  facilityAlerts: [
    { facilityId: '1000', facilityName: '불국사', facilityType: 'attraction', congestion: 0.92, nextHourCongestion: 0.8, timestamp: iso(5), source: 'user_report', evidenceTier: 'single_report' },
  ],
  facilityWarnings: [
    { facilityId: '1002', facilityName: '첨성대', facilityType: 'attraction', congestion: 0.76, nextHourCongestion: 0.6, timestamp: iso(7), source: 'merchant_report', evidenceTier: 'single_report' },
  ],
  zones: [
    { zoneId: 'z1', zoneLabel: '불국사 일원', topFacilityId: '1000', avgCongestion: 0.82, maxCongestion: 0.92, facilityCount: 4, level: 'alert', nextHourCongestion: 0.78, observedAt: iso(5), sourceCounts: { user_report: 2, admin_override: 1, merchant_report: 1 } },
    { zoneId: 'z2', zoneLabel: '대릉원 일원', topFacilityId: '1006', avgCongestion: 0.61, maxCongestion: 0.76, facilityCount: 6, level: 'warn', nextHourCongestion: 0.55, observedAt: iso(12), sourceCounts: { merchant_report: 6 } },
    { zoneId: 'z3', zoneLabel: '보문단지', topFacilityId: null, avgCongestion: 0.3, maxCongestion: 0.4, facilityCount: 5, level: 'normal', nextHourCongestion: null, observedAt: iso(20), sourceCounts: { user_report: 5 } },
  ],
  summary: { alertZones: 1, warnZones: 1, normalZones: 1, alertFacilities: 1, warnFacilities: 1, observedZones: 3 },
};

// 실시간 데이터 리허설(/admin/engine-validation) — 요약 응답에 대상지별 수집 상태(pipeline)를 실어, 새 표와
// 알림이 390px 에서 실제로 그려지게 한다. 상태를 섞었다(최신·지연·행 없음·설정 밖, 마지막 시도 실패, 정규화 표
// 미적용 + 긴 마이그레이션 파일명이 든 사람 작업) — 가장 긴 문구 조합이 카드 밖으로 밀리지 않는지 본다.
const ZONE_STEP = "Supabase SQL Editor 에서 supabase/migrations/20261031120000_crowd_zones.sql 을 실행하고 NOTIFY pgrst, 'reload schema'; 로 스키마 캐시를 새로 읽힌다(사람 작업).";

function rehearsalTarget(area: string, over: Record<string, unknown> = {}) {
  return {
    area_nm: area, zone_id: `seoul:${area}`, configured: true, state: 'fresh',
    every_buckets: 3, offset_buckets: 2, cadence_minutes: 30, stale_after_minutes: 68,
    latest_bucket_at: iso(14), latest_age_minutes: 14, first_bucket_in_window_at: iso(60 * 24 * 2),
    counted_since_at: iso(60 * 24 * 2),
    window: { expected_buckets: 96, collected_buckets: 95, off_schedule_buckets: 12, fill_rate: 0.9896 },
    last_24h: { expected_buckets: 48, collected_buckets: 47, off_schedule_buckets: 0, fill_rate: 0.9792 },
    rows_24h: 47, zone_rows_24h: null, primary_calls_per_day: 48, retry_calls_per_day_worst: 0,
    last_run: { state: 'stored', checked_at: iso(10), error_code: null, upstream_code: null, last_success_at: iso(10) },
    ...over,
  };
}

const ENGINE_SUMMARY = {
  state: 'collecting', window_days: 14, window_start: iso(60 * 24 * 14), generated_at: iso(0),
  table: 'seoul_citydata_snapshots', migration: '20260920120000_seoul_citydata_snapshots.sql',
  grade_labels: ['여유', '보통', '약간 붐빔', '붐빔'], estimate_grade_edges: [0.25, 0.5, 0.75],
  min_samples: 36, min_danger_samples: 12, omitted_metrics: [],
  collection: {
    row_count: 1200, first_bucket_at: iso(60 * 24 * 13), last_bucket_at: iso(14), first_observed_at: iso(60 * 24 * 13),
    last_observed_at: iso(18), hours_collected: 312, latest_bucket_at: iso(14), latest_age_minutes: 14, stale: false,
    stale_after_minutes: 30,
  },
  places: [],
  pipeline: {
    schedule_state: 'ok', schedule_error: null, key_configured: true, table_state: 'has_rows', human_step: null,
    stale_rule: { formula: 'max(30, 2 × 주기 + 8)분', base_minutes: 30, collection_offset_minutes: 8 },
    bucket_minutes: 10,
    budget: {
      primary_per_day: 720, retry_worst_case_per_day: 144, worst_case_per_day: 864, limit_per_day: 1000,
      headroom_per_day: 136, within_limit: true, retry_cron: '9,39 * * * *',
      retry_migration: '20260920140000_seoul_citydata_retry_budget.sql',
    },
    targets: [
      rehearsalTarget('홍대 관광특구', { every_buckets: 1, offset_buckets: 0, cadence_minutes: 10, stale_after_minutes: 30, primary_calls_per_day: 144, retry_calls_per_day_worst: 48 }),
      rehearsalTarget('창덕궁·종묘', {
        state: 'stale', latest_age_minutes: 190,
        last_run: { state: 'failed', checked_at: iso(9), error_code: 'seoul_quota_exceeded', upstream_code: 'ERROR-337', last_success_at: iso(190) },
      }),
      rehearsalTarget('북촌한옥마을', {
        state: 'empty', latest_bucket_at: null, latest_age_minutes: null, first_bucket_in_window_at: null,
        window: { expected_buckets: 671, collected_buckets: 0, off_schedule_buckets: 0, fill_rate: 0 },
        last_24h: { expected_buckets: 48, collected_buckets: 0, off_schedule_buckets: 0, fill_rate: 0 }, rows_24h: 0, last_run: null,
      }),
      rehearsalTarget('광화문·덕수궁', {
        configured: false, state: 'not_configured', every_buckets: null, offset_buckets: null, cadence_minutes: null,
        stale_after_minutes: null, primary_calls_per_day: null, retry_calls_per_day_worst: null, last_run: null,
        window: { expected_buckets: null, collected_buckets: 30, off_schedule_buckets: 0, fill_rate: null },
      }),
    ],
    last_run: {
      state: 'partial', last_run_at: iso(9), last_success_at: iso(9), error_code: 'seoul_quota_exceeded',
      skipped_targets: ['명동 관광특구', '동대문 관광특구'], memory_only: true,
    },
    zones: {
      table: 'zone_crowd_snapshots', migration: '20261031120000_crowd_zones.sql', table_state: 'not_migrated',
      rows_24h: null, latest_bucket_at: null, latest_age_minutes: null,
      last_write: { state: 'migration_not_applied', stored_count: 0, errors: { 'seoul:POI007': 'migration_not_applied' }, at: iso(9) },
      human_step: ZONE_STEP,
    },
  },
  // S4 재생 요약(커밋된 decision_quality/<cluster>.json) — 카드 문구가 가장 길어지는 조합: 예비 · 표본 부족 ·
  // 구조상 달성 불가 · 근사 구간 · 작은 권역 · 한계 여럿. 390px 에서 카드 밖으로 밀리지 않는지 본다.
  decision_quality: {
    state: 'evaluated', stage: 'S4',
    criterion: "V3 — 붐비는 출발지에서 대안이 2곳 이상인 결정에서, 추천지가 도착 시 1단계 이상 덜 붐빌 확률이 '가장 가까운 곳' 기준선보다 10%p 이상 높고, 그 차의 판정 하한(일 블록 부트스트랩 95% 하한과 날짜 군집 t 95% 하한 중 작은 쪽) > 0",
    result: {
      schema_version: 'decision_quality_summary/3',
      clusters: [{
        schema_version: 'decision_quality_summary/3', cluster: 'hongdae', zones: ['홍대 관광특구', '연남동', '합정역'],
        run_label: 'pilot', criteria_version: '0139e2f69f47', code_version: '8e27138',
        period: { first_decision_at: '2026-09-20', last_decision_at: '2026-10-31', days: 42 },
        inputs_sha256: 'f'.repeat(64), population: 'crowded_origin_choice_feasible', n_decisions: 812, days: 9, episodes: 18,
        n_disagree: 24, headroom: 0.06, opportunity_rate: 0.42,
        hit_rate: { engine: 0.36, nearest: 0.29, climatology_choice: 0.33, current_band_greedy: 0.35, random: 0.27, oracle: 0.35 },
        hit_vs_now: { engine: 0.4, stay: 0.12 }, harm_rate: { engine: 0.08, nearest: 0.1 },
        verdicts: {
          V3: {
            status: 'insufficient', criterion: '엔진 − 가장 가까운 곳 적중률 ≥ 0.10 그리고 차의 95% CI 하한 > 0', diff: 0.07,
            ci_low: -0.021, ci_high: 0.123, ci_label: 'approximate (blocks < 20)', ci_low_t: -0.03, gate_low: -0.03,
            n: 812, n_distinct: 271, days: 9, n_disagree: 24, n_disagree_distinct: 11,
            headroom: 0.06, criterion_attainable: false,
            reason: 'insufficient: crowded_days<10, episodes<20, n_disagree_distinct<30; unattainable_by_construction',
          },
          V4: { status: 'fail', recommendation: 'persistence', lead_bin: 30, mae_provider: 0.512, mae_persistence: 0.48, n: 2900, days: 38,
            reason: 'mae_provider>=mae_persistence' },
          V2: { status: 'report', share_crowd_gt_travel: 0.22 },
        },
        contrasts: {
          engine_minus_climatology: { diff: 0.03, ci_low: -0.01, ci_high: 0.07 },
          engine_minus_greedy: { diff: 0.01, ci_low: -0.02, ci_high: 0.04 },
        },
        thin_cluster: true, alternatives_per_origin: 2,
        notes: ['대안이 2곳뿐이라 엔진은 먼 쪽을 고를 때만 가장 가까운 곳과 다르다 — 참고 결과다', '날짜 블록이 20개 미만이라 신뢰구간은 근사다'],
        limits: [
          "서울에는 NextSpot 사용자가 없다 — '한 사람이 옮겨도 혼잡은 변하지 않는다'는 가정 아래 고른 곳이 도착 때 덜 붐볐는지만 쟀다. 사람이 옮겨 붐빔이 줄었는지는 재지 않았다(경주 파일럿 P3-1).",
          '엔진은 라우터와 같은 이동(구역 중심 간 직선 × 1.18 ÷ 66.67 m/분)을 보고, 정답은 그보다 보수적인 도착 시각(직선 × 1.4, 분 올림)에서 잰다 — 실제 경로·구역 안 위치는 반영하지 않는다.',
        ],
      }],
    },
  },
};

function json(route: Route, status: number, body: unknown, headers: Record<string, string> = {}) {
  return route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
}

/** 관리자 세션 — /account/me 가 admin 을 말하고, 관리자 API·Supabase REST 는 고정 응답으로 닫는다. */
async function stubAdminConsole(page: Page): Promise<void> {
  await page.route('**/rest/v1/**', (route) => {
    const url = route.request().url();
    if (route.request().method() === 'HEAD') {
      return route.fulfill({ status: 200, headers: { 'content-range': '0-0/8' }, body: '' });
    }
    if (url.includes('/rpc/latest_congestion_for_facilities')) {
      return json(route, 200, FACILITIES.map((f, i) => ({
        facility_id: f.id,
        congestion_level: [0.86, 0.4, 0.66, 0.3, 0.5, 0.2, 0.7, 0.35][i],
        current_count: null,
        source: 'user_report',
        timestamp: iso(10 + i),
      })));
    }
    if (url.includes('/facilities')) return json(route, 200, FACILITIES, { 'content-range': `0-7/${FACILITIES.length}` });
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
    if (url.includes('/admin/inquiries')) return json(route, 200, INQUIRIES);
    if (url.includes('/admin/safety/status')) return json(route, 200, SAFETY_STATUS);
    if (url.includes('/admin/settings')) {
      return json(route, 200, { maintenance_mode: false, notice_text: '', congestion_threshold: 80, coldstart_weight: 50 });
    }
    if (url.includes('/ingest-requests')) return json(route, 200, []);
    if (url.includes('/admin/engine-validation/seoul/summary')) return json(route, 200, ENGINE_SUMMARY);
    // 나머지 관리자 API 는 '아직 없음' 으로 닫는다 — 화면은 실패 상태를 그리고, 레이아웃 검사는 그대로 성립한다.
    return json(route, 404, { detail: 'not stubbed' });
  });
}

/**
 * 본문이 화면 밖으로 밀려났는가 — **가로** 스크롤 상자(`overflow-x-auto`, 표를 담는 카드) **안**에 있는 것은 정상.
 *
 * 관제 화면의 본문 상자는 `overflow-y-auto`(세로 스크롤)다. CSS 규칙상 한쪽이 visible 이 아니면 다른 쪽도 auto 로
 * 계산돼서, 계산값(overflowX)만 보면 본문 전체가 '가로 스크롤 상자 안' 으로 면제됐다 — 그 안에서 밀려난 요소는
 * 하나도 잡히지 않았다. 그래서 면제는 가로 스크롤을 **의도한** 상자(클래스)만 하고, 본문 상자 자체가 가로로
 * 넘치는지는 `scrollOverflows` 가 따로 본다.
 */
async function escapingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    const HORIZONTAL = ['overflow-x-auto', 'overflow-x-scroll', 'overflow-auto', 'overflow-scroll'];
    const scrollsX = (el: Element | null): boolean => {
      for (let p = el?.parentElement ?? null; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if ((ox === 'auto' || ox === 'scroll') && HORIZONTAL.some((name) => p!.classList.contains(name))) return true;
      }
      return false;
    };
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.position === 'fixed') continue;
      if (r.right <= vw + 1 && r.left >= -1) continue;
      if (scrollsX(el)) continue;
      const label = `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} [${Math.round(r.left)}..${Math.round(r.right)}]`;
      out.push(label);
      if (out.length > 8) break;
    }
    return out;
  });
}

/** /account/me 만 다른 역할로 덮는다(나중에 건 route 가 먼저 잡힌다). */
async function stubAccountRole(page: Page, role: 'admin' | 'developer'): Promise<void> {
  await page.route('**/api/v1/account/me', (route) => json(route, 200, {
    id: '00000000-0000-4000-8000-0000000000ad',
    role,
    is_anonymous: false,
    nickname: '관제 담당자',
    owned_facilities: [],
    pending_verification: false,
  }));
}

async function openAdmin(page: Page, path: string): Promise<void> {
  await page.goto(path);
  // 관제 게이트(권한 확인 중)를 지나 콘솔이 그려질 때까지.
  await expect(page.locator('main').first()).toBeVisible({ timeout: 30_000 });
  // 첫 조회가 화면에 반영될 시간을 준다(스텁이라 곧 끝난다).
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(500);
}

/** 본문의 세로 스크롤 상자(`overflow-y-auto`)가 가로로 넘치는가 — 넘치면 휴대폰에서 본문이 옆으로 밀린다. */
async function scrollOverflows(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('main .overflow-y-auto, main.overflow-y-auto'))
      .filter((el) => !el.classList.contains('overflow-x-auto'))
      .map((el) => ({ el, over: el.scrollWidth - el.clientWidth }))
      .filter(({ el, over }) => over > 1 && el.getBoundingClientRect().width > 0)
      .map(({ el, over }) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} +${over}px`),
  );
}

const SHOT_DIR = process.env.ADMIN_SHOT_DIR;

test.beforeEach(async ({ page }) => {
  await stubExternalServices(page);
  await stubAdminConsole(page);
});

for (const path of ADMIN_ROUTES) {
  test(`390px — ${path} 본문이 화면 안에 머물고 표 칸이 읽힌다`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    // 실시간 데이터 리허설은 developer 전용이다(사용자 결정 1) — 레이아웃은 그 화면을 실제로 보는 developer 로 잰다.
    if (path === '/admin/engine-validation') await stubAccountRole(page, 'developer');
    await openAdmin(page, path);
    if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/390${path.replaceAll('/', '_')}.png` });

    const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(docOverflow, '문서 가로 스크롤').toBeLessThanOrEqual(0);
    // 본문이 화면 폭을 다 쓴다 — 사이드바가 옆에 남아 본문을 세로 띠로 누르지 않는다.
    const mainWidth = await page.locator('main').first().evaluate((el) => el.getBoundingClientRect().width);
    expect(mainWidth, '본문 폭').toBeGreaterThanOrEqual(389);
    expect(await escapingElements(page), '화면 밖으로 밀려난 요소').toEqual([]);
    expect(await scrollOverflows(page), '가로로 넘치는 본문 스크롤 상자').toEqual([]);
    if (path === '/admin/engine-validation') {
      // 스텁한 수집 상태가 실제로 그려졌다 — 그려지지 않으면 위 검사는 빈 화면을 잰 것이다.
      await expect(page.getByRole('region', { name: '수집 상태' })).toBeVisible();
      await expect(page.getByText('정규화 표 미적용 — 20261031120000_crowd_zones.sql')).toBeVisible();
      // 커밋된 S4 요약이 권역 카드로 그려진다 — 판정 배지와 한계 첫 줄(사용자 없음)이 함께 보인다.
      const hongdae = page.getByTestId('decision-quality-hongdae');
      await expect(hongdae).toBeVisible();
      await expect(hongdae.getByText('V3 표본 부족')).toBeVisible();
      await expect(hongdae.getByText(/^구조상 달성 불가 — /)).toBeVisible();
      await expect(hongdae.getByText(/^한계: 서울에는 NextSpot 사용자가 없다/)).toBeVisible();
    }

    const narrowCells = await page.evaluate((min) =>
      Array.from(document.querySelectorAll('main th, main td'))
        .map((c) => ({ w: c.getBoundingClientRect().width, t: (c.textContent ?? '').trim().slice(0, 20) }))
        .filter((c) => c.w > 0 && c.w < min && c.t.length > 0),
    MIN_CELL_WIDTH);
    expect(narrowCells, '읽을 수 없게 좁은 표 칸').toEqual([]);

    // 사이드바가 접힌 폭에서는 상단 메뉴 버튼으로 같은 메뉴를 연다.
    const menuButton = page.getByRole('button', { name: '관제 메뉴 열기' });
    await expect(menuButton).toBeVisible();
    // 아이콘만이 아니라 글자로도 '관제 메뉴' 가 보인다(어디를 누르면 다른 관제 화면이 있는지).
    await expect(menuButton).toHaveText('관제 메뉴');

    if (SHOT_DIR) {
      // 관제 화면은 화면 높이 고정 + 본문 스크롤이라 전체 캡처가 첫 화면만 찍는다 — 키 큰 창으로 한 장 더.
      await page.setViewportSize({ width: 390, height: 3200 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOT_DIR}/390${path.replaceAll('/', '_')}_tall.png` });
    }
  });

  for (const width of [1024, 1280]) {
    test(`${width}px — ${path} 데스크톱 사이드바 그대로`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openAdmin(page, path);
      if (SHOT_DIR) {
        const name = `${SHOT_DIR}/${width}${path.replaceAll('/', '_')}`;
        await page.screenshot({ path: `${name}.png` });
        // 데스크톱이 '전과 똑같은가' 를 눈 대신 숫자로 비교하려고 요소 상자를 떠 둔다(전/후 diff).
        const boxes = await page.evaluate(() => Array.from(document.querySelectorAll('aside, aside *, main, main *'))
          .map((el) => {
            const r = el.getBoundingClientRect();
            return `${el.tagName} ${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}`;
          }));
        writeFileSync(`${name}.boxes.txt`, `${boxes.join('\n')}\n`);
      }
      await expect(page.getByRole('button', { name: '관제 메뉴 열기' })).toBeHidden();
      const aside = page.locator('aside').first();
      await expect(aside).toBeVisible();
      expect((await aside.boundingBox())?.width).toBe(256);
    });
  }
}

test('390px — 접힌 메뉴에서 다른 관제 화면으로 이동하고, 관광객 앱·로그아웃에도 닿는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAdmin(page, '/admin/dashboard');

  await page.getByRole('button', { name: '관제 메뉴 열기' }).click();
  const drawer = page.getByRole('dialog', { name: '관제 메뉴' });
  await expect(drawer).toBeVisible();
  for (const path of ADMIN_ROUTES) {
    if (HIDDEN_FROM_MENU.has(path)) {
      await expect(drawer.locator(`a[href="${path}"]`)).toHaveCount(0);
      continue;
    }
    await expect(drawer.locator(`a[href="${path}"]`)).toBeVisible();
  }
  await expect(drawer.locator('a[href="/main"]')).toBeVisible();
  await expect(drawer.getByRole('button', { name: '로그아웃' })).toBeVisible();
  // 현재 화면이 표시된다.
  await expect(drawer.locator('a[href="/admin/dashboard"]')).toHaveAttribute('aria-current', 'page');

  // Escape 로 닫히고, 다시 열어 이동하면 서랍이 닫힌 채 새 화면이 뜬다.
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await page.getByRole('button', { name: '관제 메뉴 열기' }).click();
  await drawer.locator('a[href="/admin/support"]').click();
  await expect(page).toHaveURL(/\/admin\/support/);
  await expect(page.getByRole('dialog', { name: '관제 메뉴' })).toBeHidden();
});

// 리뷰(10-07) — 지금 화면의 링크(대시보드에서 '관제 대시보드')는 경로가 바뀌지 않는다. 서랍이 그대로 남으면 누른 것이
// 아무 일도 안 한 것처럼 보였다 — 누르면 닫힌다.
test('390px — 서랍에서 지금 화면의 링크를 누르면 서랍이 닫힌다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAdmin(page, '/admin/dashboard');
  await page.getByRole('button', { name: '관제 메뉴 열기' }).click();
  const drawer = page.getByRole('dialog', { name: '관제 메뉴' });
  await expect(drawer).toBeVisible();
  await drawer.locator('a[href="/admin/dashboard"]').click();
  await expect(page.getByRole('dialog', { name: '관제 메뉴' })).toBeHidden();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
});

// 리뷰(10-07) — 휴대폰 실제 대시보드 머리글은 두 줄(제목 + 알림 / 근거 칩)이다. 알림·AD 가 셋째 줄을 따로 차지해
// 단계 바 위가 약 190px 였다.
test('390px — 실제 대시보드 머리글은 알림을 제목 줄에 두고 두 줄 안이다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAdmin(page, '/admin/dashboard');
  const header = page.locator('main header').first();
  const title = header.getByRole('heading', { name: '경주 관광 혼잡 종합 대시보드' });
  await expect(title).toBeVisible();
  const [headerBox, titleBox] = [await header.boundingBox(), await title.boundingBox()];
  // 머리글의 오른쪽 묶음(알림) — 근거 칩 안의 버튼과 헷갈리지 않게 머리글 바로 아래 마지막 칸으로 찾는다.
  const bell = await header.locator(':scope > div').last().boundingBox();
  console.log(`dashboard header at 390: ${Math.round(headerBox!.height)}px tall`);
  // 알림 버튼이 제목과 같은 줄에 있다(따로 한 줄을 차지하지 않는다).
  expect(bell!.y, '알림이 제목 아래 줄로 내려갔다').toBeLessThan(titleBox!.y + titleBox!.height);
  expect(headerBox!.height, '머리글이 두 줄을 넘는다').toBeLessThanOrEqual(110);
  // 단계 바가 그만큼 위로 올라온다(상단 바 56px + 머리글).
  const steps = await page.getByRole('navigation', { name: '관제 단계' }).boundingBox();
  expect(steps!.y, '단계 바가 머리글 아래로 밀려 있다').toBeLessThanOrEqual(56 + 110 + 2);
});

// 리뷰(10-07) — 휴대폰 관제 데모(관제 대시보드 바로 가기의 게스트 길)는 문서 스크롤 + 붙어 있는 머리글이다.
// 단계 바를 누르면 그 단계 제목이 머리글 아래에 보여야 한다(예전 scroll-mt 80px 는 머리글 약 90px 에 '② 정책 개입' 이 깔렸다).
for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 640 }]) {
  test(`${viewport.width}px — 관제 데모의 단계 바는 각 단계 제목을 머리글 아래에 데려온다`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    await page.goto('/admin/dashboard?demo=1');
    const header = page.locator('main header').first();
    await expect(header.getByText('예시 화면', { exact: true })).toBeVisible({ timeout: 30_000 });
    for (const [label, id] of [['② 정책 개입', 'step-policy'], ['③ 분산 효과', 'step-effect'], ['① 실시간 관제', 'step-monitor']] as const) {
      await page.getByRole('navigation', { name: '관제 단계' }).getByRole('button', { name: label }).click();
      // 부드러운 스크롤이 멈출 때까지 기다린다.
      let last = -1;
      await expect.poll(async () => {
        const y = await page.evaluate(() => window.scrollY);
        const settled = y === last;
        last = y;
        return settled;
      }, { intervals: [150, 150, 150, 300, 300, 500] }).toBe(true);
      const headerBottom = (await header.boundingBox())!.y + (await header.boundingBox())!.height;
      const target = await page.locator(`#${id}`).boundingBox();
      const atBottom = await page.evaluate(() => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4);
      console.log(`${viewport.width}px ${label}: header bottom ${Math.round(headerBottom)} · target top ${Math.round(target!.y)}${atBottom ? ' (page bottom)' : ''}`);
      expect(target!.y, `${label} 제목이 머리글 밑에 깔린다`).toBeGreaterThanOrEqual(headerBottom);
      if (!atBottom) expect(target!.y, `${label} 로 옮겨 오지 않았다`).toBeLessThanOrEqual(headerBottom + 60);
    }
  });
}

// 리뷰(10-07) — 관제 데모의 CSV 버튼은 실제 대시보드처럼 ① 제목 줄 오른쪽이다(따로 한 줄이면 브리핑 위에 빈 띠가 생겼다).
test('1280px — 관제 데모의 CSV 버튼은 ① 실시간 관제 제목과 같은 줄이다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/admin/dashboard?demo=1');
  const csv = page.getByRole('button', { name: /데이터 내보내기 \(CSV\)/ });
  await expect(csv).toBeVisible({ timeout: 30_000 });
  const step = page.locator('#step-monitor');
  const [csvBox, stepBox] = [await csv.boundingBox(), await step.boundingBox()];
  const overlap = Math.min(csvBox!.y + csvBox!.height, stepBox!.y + stepBox!.height) - Math.max(csvBox!.y, stepBox!.y);
  expect(overlap, 'CSV 버튼이 ① 제목 줄과 다른 줄이다').toBeGreaterThan(0);
  // 브리핑이 ① 줄보다 위(실제 대시보드와 같은 순서).
  const briefing = await page.getByText('오늘의 정책 브리핑').boundingBox();
  expect(briefing!.y).toBeLessThan(stepBox!.y);
});

test('admin 은 실시간 데이터 리허설(서울)을 URL 로 열어도 서울 데이터를 받지 않는다', async ({ page }) => {
  let summaryCalls = 0;
  page.on('request', (req) => {
    if (req.url().includes('/admin/engine-validation/seoul/')) summaryCalls += 1;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await openAdmin(page, '/admin/engine-validation');
  await expect(page.getByTestId('rehearsal-developer-only')).toBeVisible();
  await expect(page.locator('main')).not.toContainText('서울');
  await expect(page.locator('main')).not.toContainText('홍대');
  expect(summaryCalls, '서울 요약 API 를 부르지 않는다').toBe(0);
});
