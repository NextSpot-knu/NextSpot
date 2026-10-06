import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { stubMain } from './support/mainStubs';
import { expandPeek } from './support/recCard';
import { stubFakeKakaoMap, type FakePin, type KakaoFakeWindow } from './support/fakeKakaoMap';
import { stubExternalServices } from './support/stubs';

// 기능설명서 §5 크로스워크(2026-10-06 감사 계획 3.2 표 · 배치 B).
//
// 심사위원은 제출한 기능설명서 §5 의 '화면 흐름 예시' 다섯 묶음을 옆에 두고 라이브 화면을 그대로 따라 한다.
// 이 파일은 그 문장을 **문서의 말 그대로** 한 단계씩 밟는다 — 문서의 말과 화면 이름이 다른 곳은 계획 3.2 표의
// 대응을 따른다(아래 DOC 표). 데스크톱 노트북 창(1536×730)과 휴대폰(390×844) 두 화면에서 같은 길을 걷는다.
//   핵심 기능 1 도착 시점 혼잡 예측 지도 · 2 SPOT 점수 기반 대안 추천 카드 · 3 실시간 TourAPI 정보 조회 ·
//   4 음성 AI 비서 · 5 소상공인 타임세일 + B2G 관제 — 그리고 그 입구(사장님 콘솔 · 관제 대시보드 · '이렇게 써 보세요').
// 실계정·실서버·외부 네트워크는 쓰지 않는다 — 우리 API · Supabase · 지도 SDK 는 전부 스텁이다(쓰기도 스텁에서 끝난다).

/** 문서의 말 → 화면의 이름(계획 3.2 크로스워크 표). */
const DOC = {
  slider: '+2시간 후', // 하단 시간 슬라이더 "+2시간 후" → '🔮 혼잡 예측' 줄의 '+2시간 후' 칸
  spotInfo: 'SPOT 점수 설명 보기', // SPOT 점수 배지 옆 정보 아이콘 → 60px 배지 'SPOT 점수 ⓘ'(배지 전체가 단추)
  details: '상세 정보 펼치기', // 카드를 위로 끌어 올려 → 손잡이 끌기 + '상세 정보 펼치기'
  guide: /여기로 (길)?안내/, // "여기로 안내" → '도보 길안내'(접근 이름 '여기로 길안내 시작')
  reject: /관심 없음/, // "관심 없음" → '관심 없어요'(접근 이름 '이 추천에 관심 없음, …')
  liveRefresh: '실시간 정보 새로고침', // 같은 이름
  ingest: '다음 배치 추가 요청', // 같은 이름
  orb: 'AI 음성 추천 듣기', // 추천 카드 위 음성 오브 → '🎙 AI 음성 비서' 알약(접근 이름은 그대로)
  merchant: '사장님 콘솔',
  admin: '관제 대시보드',
} as const;

const DESKTOP = { width: 1536, height: 730 };
const PHONE = { width: 390, height: 844 };

test.beforeEach(async ({ page }) => stubExternalServices(page));

// ───────────────────────────────────────────────────────────────────────────
// 고정 데이터 — 황리단길 둘레 몇 백 m 안의 관광지 여섯 곳과 음식점 두 곳
// ───────────────────────────────────────────────────────────────────────────

const LAT = 35.8358;
const LNG = 129.2098;
const TOUR_PHOTO = 'https://tong.visitkorea.or.kr/cms/resource/01/e2e_crosswalk_1.jpg';
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

type Row = Record<string, unknown> & { id: string; name: string; type: string };

function place(id: string, name: string, type: string, i: number, extra: Record<string, unknown> = {}): Row {
  return {
    id, name, type,
    latitude: LAT + (i % 3) * 0.0006,
    longitude: LNG + Math.floor(i / 3) * 0.0007,
    capacity: 30, features: {}, congestion: null,
    operating_hours: { open: '00:00~23:59', closed: '연중무휴' },
    ...extra,
  };
}

// 관광공사(TourAPI) 상세가 있는 관광지 — 사진 · 출처 · 실시간 정보 새로고침 · 전화 · 홈페이지. 무장애 확인 · 주차 가능.
const GYERIM = place('att-gyerim', '경주 계림', 'attraction', 0, {
  image_url: TOUR_PHOTO, contentid: '126207', contenttypeid: 12,
  overview: '첨성대와 월성 사이에 있는 숲이다.', phone: '054-779-6100', homepage: 'https://www.gyeongju.go.kr/tour',
  operating_hours: { open: '상시 개방', closed: '연중무휴' },
  barrier_free: true, features: { parking: '가능' },
});
const HYANGGYO = place('att-hyanggyo', '경주 향교', 'attraction', 1, { barrier_free: true });
// 지금 잰 한산(6분 전) — 칠해진 '붐비지 않는 마커'.
const GYOCHON = place('att-gyochon', '교촌 한옥마을', 'attraction', 2, {
  congestion: { level: 0.22, current_count: null, timestamp: minutesAgo(6), source: 'traffic_cctv', is_stale: false, is_current: true },
});
const WOLJEONG = place('att-woljeong', '월정교 산책길', 'attraction', 3);
// 반려동물 동반 정보가 있는 곳 — 🐾 필터는 이런 값이 하나라도 있을 때만 선다.
const FLOWER = place('att-flower', '첨성대 꽃밭', 'attraction', 4, { features: { chk_pet: '가능' } });
// 지금 잰 혼잡(5분 전) — 순위 밖이라 등급색 핀 그대로.
const DAEREUNGWON = place('anchor-drw', '대릉원', 'attraction', 5, {
  congestion: { level: 0.88, current_count: null, timestamp: minutesAgo(5), source: 'user_report', is_stale: false, is_current: true },
});
const KOREAN = place('rest-korean', '황남 쌈밥', 'restaurant', 6, { features: { cuisine_tags: ['한식'] } });
const PIZZA = place('rest-pizza', '이사부피자', 'restaurant', 7, { features: { cuisine_tags: ['양식', '피자'] } });

const ATTRACTION_LIST = [GYERIM, HYANGGYO, GYOCHON, WOLJEONG, FLOWER];
const FACILITIES = [...ATTRACTION_LIST, DAEREUNGWON, KOREAN, PIZZA];

function rec(row: Row, rank: number, total: number) {
  return {
    recommendation_id: `rec-${row.id}`, facility: row, spot_score: 0.8 - rank * 0.03, distance_m: 180 + rank * 40,
    rank, total_candidates: total, reason: `${row.name} 추천`, reason_source: 'template',
    congestion_level: rank === 1 ? 0.2 : null, congestion_source: rank === 1 ? 'measured' : 'none',
    congestion_is_current: rank === 1 ? true : null, congestion_timestamp: rank === 1 ? minutesAgo(4) : null,
    open_status_at_arrival: 'open_expected', scoring_mode: 'area_stats_rules', prediction_source: 'unavailable',
    breakdown: { preference: 0.82 - rank * 0.04, wait_time: null, travel_time: 2.4 + rank, incentive: 0 },
  };
}

function byType(type: string) {
  const rows = type === 'attraction' ? ATTRACTION_LIST : type === 'restaurant' ? [KOREAN, PIZZA] : [];
  return rows.map((row, i) => rec(row, i + 1, rows.length));
}

/** 음성 분류기(/voice/turn) 대역 — 한국어 문장은 서버가 해석한다(문서 ②④). */
function voiceTurn(utterance: string) {
  const reply = (body: Record<string, unknown>) => ({ target_facility_id: null, match_ids: [], spoken: null, suggestion_id: null, ...body });
  if (utterance.includes('다음')) return reply({ action: 'next' });
  if (utterance.trim() === '응') return reply({ action: 'accept' });
  if (utterance.includes('실내')) return reply({ action: 'command', command: { name: 'set_indoor_mode', args: { enabled: true } } });
  if (/도보\s*10분/.test(utterance)) return reply({ action: 'command', command: { name: 'set_max_walk_minutes', args: { max_walk_minutes: 10 } } });
  return reply({ action: 'unknown' });
}

const GOLGULSA = {
  contentid: '127693', title: '골굴사(경주)', addr1: '경상북도 경주시 양북면 기림로 101-5',
  mapx: 129.3529, mapy: 35.8064, contenttypeid: 12, firstimage: null,
};
const KAKAO_PUB = {
  place_id: 'k1', name: '황남 맥주집', type: 'restaurant', latitude: 35.8371, longitude: 129.2101,
  address: '경북 경주시 포석로 1050', place_url: 'https://place.map.kakao.com/987654', category_name: '음식점 > 술집',
};

interface Calls { byType: { assumedAt: string | null }[]; voiceTurn: number; ingest: number; liveDetail: number }

async function openMain(page: Page, url = '/main'): Promise<Calls> {
  const calls: Calls = { byType: [], voiceTurn: 0, ingest: 0, liveDetail: 0 };
  await page.route('**://tong.visitkorea.or.kr/**', (route) => route.fulfill({
    status: 200, contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#3e7c6a"/></svg>',
  }));
  await stubMain(page, { facilities: FACILITIES, byType });
  await stubFakeKakaoMap(page);
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/v1/recommendations/by-type', (route) => {
    const body = route.request().postDataJSON() as { facility_type?: string; assumed_at?: string | null };
    calls.byType.push({ assumedAt: body.assumed_at ?? null });
    return json(route, byType(String(body.facility_type ?? '')));
  });
  await page.route('**/api/v1/area-demand/forecast**', (route) => json(route, { available: true, forecast: { level: 0.35 } }));
  await page.route('**/predict/model-info', (route) => json(route, { trained: false, fallback_state: 'degraded_rules' }));
  await page.route('**/predict/batch', (route) => json(route, { detail: 'untrained' }, 503));
  await page.route('**/api/v1/freshness**', (route) => json(route, { last_tourapi_sync: new Date(Date.now() - 2 * 3600_000).toISOString() }));
  await page.route('**/api/v1/account/me', (route) => json(route, {
    id: '00000000-0000-4000-8000-000000000001', role: 'tourist', is_anonymous: true, nickname: null, owned_facilities: [], pending_verification: false,
  }));
  await page.route('**/api/v1/users/me/vector', (route) => json(route, { vector: [0.62, 0.48, 0.71, 0.35, 0.4, 0.55, 0.2, 0.3] }));
  await page.route('**/api/v1/impact/summary**', (route) => json(route, { accepted: 0, congestion_avoided: 0, coupons_issued: 0, coupons_used: 0, wait_saved_minutes: 0 }));
  await page.route('**/api/v1/voice/turn', (route) => {
    calls.voiceTurn += 1;
    const body = route.request().postDataJSON() as { utterance?: string };
    return json(route, voiceTurn(String(body.utterance ?? '')));
  });
  await page.route('**/api/v1/infrastructures/live-detail/**', (route) => {
    calls.liveDetail += 1;
    return json(route, {
      source: 'tourapi-live',
      operating_hours: { open: '상시 개방', closed: '연중무휴' },
      overview: '첨성대와 월성 사이의 숲 — 방금 TourAPI 에서 받은 소개.',
      phone: '054-779-6100', homepage: 'https://www.gyeongju.go.kr/tour', image_url: TOUR_PHOTO,
    });
  });
  await page.route('**/api/v1/search/places**', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    return json(route, { items: q.includes('맥주') ? [KAKAO_PUB] : [] });
  });
  await page.route('**/api/v1/search/keyword**', (route) => json(route, { items: [GOLGULSA], source: 'tourapi' }));
  await page.route('**/api/v1/search/ingest-request', (route) => {
    calls.ingest += 1;
    return json(route, { status: 'pending' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('nextspot_theme', 'light');
    localStorage.setItem('nextspot_setup_prefs', JSON.stringify({
      version: 2, categories: ['attraction'], requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [],
    }));
    if (!sessionStorage.getItem('e2e_seeded')) {
      sessionStorage.setItem('e2e_seeded', '1');
      localStorage.setItem('nextspot_assumed_at', 'now');
    }
    // 길안내는 카카오맵 새 창 — 열린 주소만 기록한다.
    window.open = ((target?: string | URL) => {
      (window as unknown as { __opened?: string }).__opened = String(target);
      return window;
    }) as typeof window.open;
    // 음성 — 말한 문장과 언어를 기록하고, 듣기는 테스트가 결과를 넣는다.
    const w = window as unknown as Record<string, unknown>;
    w.__utterances = [];
    w.__recognitions = [];
    class MockUtterance {
      text: string; lang = ''; rate = 1; pitch = 1; volume = 1; voice = null;
      onend?: () => void; onerror?: () => void;
      constructor(text: string) { this.text = text; }
    }
    class MockRecognition {
      lang = ''; interimResults = false; continuous = false; maxAlternatives = 1;
      onresult?: (event: unknown) => void; onerror?: (event: unknown) => void; onend?: () => void;
      constructor() { (w.__recognitions as unknown[]).push(this); w.__recognition = this; }
      start() { /* the test dispatches a final result */ }
      abort() { this.onend?.(); }
      stop() { this.onend?.(); }
    }
    w.SpeechSynthesisUtterance = MockUtterance;
    w.SpeechRecognition = MockRecognition;
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [], cancel: () => {},
      speak: (u: MockUtterance) => {
        if (u.text.trim()) (w.__utterances as { text: string; lang: string }[]).push({ text: u.text, lang: u.lang });
        setTimeout(() => u.onend?.(), 0);
      },
      onvoiceschanged: null,
    } });
  });
  await page.goto(url);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  return calls;
}

const card = (page: Page) => page.getByTestId('recommendation-card');
const strip = (page: Page) => page.getByTestId('forecast-strip');
const track = (page: Page) => page.getByTestId('forecast-track');
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1536) < 768;
const pins = (page: Page): Promise<FakePin[]> => page.evaluate(() => (window as unknown as KakaoFakeWindow).__kakaoFake.pins());
const markers = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as KakaoFakeWindow).__kakaoFake.markers());
const tapMarker = (page: Page, title: string) =>
  page.evaluate((t) => (window as unknown as KakaoFakeWindow).__kakaoFake.click(t), title);

/** 요소가 화면 안에 다 들어온다(스크롤 없이 보인다). */
async function expectInView(target: Locator) {
  await expect(target).toBeVisible();
  await expect(target).toBeInViewport({ ratio: 1 });
}

/** 휴대폰은 카드가 짧은 미리보기로 열린다 — 전체 카드에만 있는 것을 보기 전에 펼친다. */
async function fullCard(page: Page) {
  if (isPhone(page) && await page.getByTestId('rec-card-peek').isVisible()) await expandPeek(page);
}

/** 휴대폰의 지도 도구(히트맵 · ♿ · 🅿)는 '필터·편의' 시트 안에, 데스크톱은 툴바 둘째 줄에 있다. */
const toolSheet = (page: Page) => page.locator('section', { has: page.getByRole('heading', { name: '필터와 여행 편의' }) });
async function mapTool(page: Page, name: RegExp): Promise<Locator> {
  if (!isPhone(page)) return page.getByTestId('toolbar-row-2').getByRole('button', { name });
  if (!(await toolSheet(page).isVisible())) await page.getByRole('button', { name: '필터·편의' }).click();
  await expect(toolSheet(page)).toBeVisible();
  return toolSheet(page).getByRole('button', { name });
}
async function closeSheet(page: Page) {
  if (isPhone(page) && await toolSheet(page).isVisible()) {
    await toolSheet(page).getByRole('button', { name: '닫기' }).click();
    await expect(toolSheet(page)).toHaveCount(0);
  }
}

/** 휴대폰 카드를 손잡이 줄에서 위(dy<0)·아래로 민다 — 카드가 제자리에 선 뒤에(judge-flow 와 같은 방식). */
async function swipeCard(page: Page, dy: number) {
  let last: { y: number; height: number } | null = null;
  let stable = 0;
  await expect.poll(async () => {
    const next = await card(page).boundingBox();
    stable = last && next && Math.abs(next.y - last.y) < 0.5 && Math.abs(next.height - last.height) < 0.5 ? stable + 1 : 0;
    last = next;
    return stable;
  }, { intervals: [150] }).toBeGreaterThanOrEqual(3);
  const box = (await card(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 14;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(x, y + (dy * step) / 8);
  await page.mouse.up();
}

/** 음성 비서를 켜고(꺼져 있으면 알약을 누른다) 한 마디를 듣게 한다. */
async function say(page: Page, utterance: string) {
  const count = () => page.evaluate(() => ((window as unknown as { __recognitions: unknown[] }).__recognitions ?? []).length);
  const before = await count();
  const pill = page.getByRole('button', { name: DOC.orb });
  if (await pill.count()) await pill.first().click();
  await expect.poll(count).toBeGreaterThan(before);
  await page.evaluate((text) => {
    const recognition = (window as unknown as { __recognition: { onresult?: (e: unknown) => void } }).__recognition;
    recognition.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
  }, utterance);
}
const spoken = (page: Page) =>
  page.evaluate(() => (window as unknown as { __utterances: { text: string }[] }).__utterances.map((u) => u.text).join(' '));

// ───────────────────────────────────────────────────────────────────────────
// 핵심 기능 1~5 — 1536×730 과 390×844 에서 같은 문장을 밟는다
// ───────────────────────────────────────────────────────────────────────────

for (const viewport of [DESKTOP, PHONE]) {
  test.describe(`기능설명서 §5 at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('[핵심 기능 1] 도착 시점 혼잡 예측 지도 (시간 슬라이더 + 히트맵)', async ({ page }) => {
      test.setTimeout(150_000);
      const calls = await openMain(page);
      await expect(card(page)).toContainText('경주 계림', { timeout: 30_000 });

      await test.step('① 메인화면 진입 — 마커가 실측 혼잡 등급(한산·여유·보통·혼잡) 색으로 채워진다', async () => {
        await expect.poll(async () => (await pins(page)).length).toBeGreaterThan(3);
        const byTitle = new Map((await pins(page)).map((pin) => [pin.title, decodeURIComponent(pin.src)]));
        expect(byTitle.get('대릉원'), '지금 잰 혼잡 마커가 등급색으로 칠해져 있다').toContain('data-pin="filled"');
        for (const pin of await pins(page)) expect(decodeURIComponent(pin.src)).not.toMatch(/#4b5563|#000(?![0-9a-f])/i);
        if (!isPhone(page)) {
          const legend = strip(page).getByTestId('forecast-legend');
          await expect(legend).toContainText('지금 혼잡');
          for (const grade of ['한산', '여유', '보통', '혼잡']) await expect(legend).toContainText(grade);
        }
      });

      await test.step('② 하단 시간 슬라이더를 "+2시간 후"로 — 그 시각 예측으로 마커가 다시 칠해지고 "🔮 예측" 배지', async () => {
        await expectInView(strip(page));
        await expect(strip(page)).toContainText('혼잡 예측');
        const before = calls.byType.length;
        const target = track(page).getByText(DOC.slider, { exact: true });
        if (isPhone(page)) {
          await target.click();
        } else {
          // 문서의 말 그대로 '끈다' — 지금 칸에서 +2시간 후 칸까지 끌어 놓는다.
          const from = (await track(page).getByText('지금', { exact: true }).boundingBox())!;
          const to = (await target.boundingBox())!;
          await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
          await page.mouse.down();
          for (let step = 1; step <= 10; step += 1) {
            await page.mouse.move(from.x + from.width / 2 + ((to.x + to.width / 2) - (from.x + from.width / 2)) * (step / 10), from.y + from.height / 2);
          }
          await page.mouse.up();
        }
        await expect(track(page)).toHaveAttribute('aria-valuenow', '2');
        const badge = strip(page).getByTestId(isPhone(page) ? 'forecast-badge-short' : 'forecast-badge');
        await expect(badge).toContainText('🔮', { timeout: 20_000 });
        await expect(badge).toContainText('예측');
        if (!isPhone(page)) {
          await expect(badge).toContainText('+2시간 후 예측');
          await expect(card(page).getByTestId('value-box')).toContainText('+2시간 후 기준', { timeout: 20_000 });
        }
        await expect.poll(async () => (await pins(page)).filter((pin) => decodeURIComponent(pin.src).includes('data-pin="filled-dashed"')).length,
          { message: '추천 마커가 그 시각의 예측 등급으로 다시 칠해진다' }).toBeGreaterThan(0);
        await expect.poll(() => calls.byType.length).toBeGreaterThan(before);
        expect(calls.byType.at(-1)!.assumedAt, '+2시간 후 기준으로 다시 고른다').toBeTruthy();
        // 지금으로 돌아오면 배지가 걷힌다.
        await track(page).getByText('지금', { exact: true }).click();
        await expect(badge).toHaveCount(0);
      });

      await test.step('③ 히트맵 토글을 켠다', async () => {
        await (await mapTool(page, /히트맵/)).click();
        // 휴대폰 시트는 지도를 덮으므로 히트맵을 켜면 함께 닫힌다 — 다시 열어 켜진 상태를 본다.
        await expect(await mapTool(page, /히트맵/)).toHaveAttribute('aria-pressed', 'true');
        await closeSheet(page);
      });

      await test.step('④ 무장애(♿)·주차(🅿)·반려동물(🐾) 필터 — 조건을 만족하는 시설만 남는다', async () => {
        await expect.poll(() => markers(page)).toContain('대릉원');
        const filters = [
          { name: /^♿ 무장애$/, keeps: '경주 계림' },
          { name: /^🅿 주차$/, keeps: '경주 계림' },
          // 🐾 는 반려동물 동반 정보가 있을 때만 서는 칩이고, 휴대폰 시트에는 없다(데스크톱 툴바 둘째 줄).
          ...(isPhone(page) ? [] : [{ name: /^🐾 반려동물$/, keeps: '첨성대 꽃밭' }]),
        ];
        for (const { name, keeps } of filters) {
          const chip = await mapTool(page, name);
          await chip.click();
          await expect(await mapTool(page, name)).toHaveAttribute('aria-pressed', 'true');
          await closeSheet(page);
          await expect.poll(() => markers(page), { message: `${name} 를 켜면 조건 밖의 대릉원은 지도에서 빠진다` }).not.toContain('대릉원');
          expect(await markers(page)).toContain(keeps);
          await (await mapTool(page, name)).click();
          await expect(await mapTool(page, name)).toHaveAttribute('aria-pressed', 'false');
          await closeSheet(page);
          await expect.poll(() => markers(page)).toContain('대릉원');
        }
      });

      await test.step('⑤ 붐비지 않는 마커를 탭해 상세로 넘어간다', async () => {
        await expect.poll(() => markers(page)).toContain('교촌 한옥마을');
        await tapMarker(page, '교촌 한옥마을');
        await expect(card(page)).toContainText('교촌 한옥마을');
        await fullCard(page);
        await expect(card(page).getByRole('button', { name: DOC.details })).toBeVisible();
      });
    });

    test('[핵심 기능 2] SPOT 점수 기반 대안 추천 카드', async ({ page }) => {
      test.setTimeout(150_000);
      await openMain(page);
      await expect(card(page)).toContainText('경주 계림', { timeout: 30_000 });

      await test.step('① 카테고리(음식점·카페·관광지·문화시설)를 고르면 SPOT 점수 1위 대안이 하단 카드로', async () => {
        for (const category of ['음식점', '카페', '관광지', '문화시설']) {
          await expect(page.getByRole('button', { name: category, exact: true }).locator('visible=true')).toHaveCount(1);
        }
        await page.getByRole('button', { name: '음식점', exact: true }).locator('visible=true').click();
        await expect(card(page)).toContainText('황남 쌈밥', { timeout: 20_000 });
        await page.getByRole('button', { name: '관광지', exact: true }).locator('visible=true').click();
        await expect(card(page)).toContainText('경주 계림', { timeout: 20_000 });
        await fullCard(page);
        await expect(card(page).getByTestId('card-rank')).toHaveText('베스트 추천');
      });

      await test.step('② SPOT 점수 배지 옆 정보 아이콘 — 취향·도착시점 시간비용·인센티브 산정 근거', async () => {
        const badge = card(page).getByRole('button', { name: DOC.spotInfo });
        await expect(badge).toContainText('SPOT 점수');
        await expect(badge).toContainText('ⓘ');
        await badge.click();
        const box = card(page).getByTestId('spot-info');
        await expect(box).toBeVisible();
        await expect(box).toContainText('내 취향(40%)');
        await expect(box).toContainText('걷는 시간과 도착 때 붐빔(40%)');
        await expect(box).toContainText('혜택(20%)');
        await badge.click();
      });

      await test.step('③ 카드를 위로 끌어 올려 도착 예정 시각·혼잡도·도보 시간·영업 상태 상세를 펼친다', async () => {
        if (isPhone(page)) {
          // 문서의 말 그대로 — 접힌 미리보기를 손잡이 줄에서 위로 끌어 올리면 전체 카드가 된다.
          await card(page).getByRole('button', { name: '추천 간단히 보기' }).click();
          await expect(page.getByTestId('rec-card-peek')).toBeVisible();
          await swipeCard(page, -160);
          await expect(page.getByTestId('rec-card-peek')).toBeHidden();
        }
        await expect(card(page).getByTestId('arrival-line')).toContainText(/\d{1,2}:\d{2} 출발 → \d{1,2}:\d{2} 도착/);
        await expect(card(page)).toContainText(/도보 \d+분/);
        await expect(card(page)).toContainText(/한산|여유/);
        const details = card(page).getByRole('button', { name: DOC.details });
        await details.scrollIntoViewIfNeeded();
        await details.click();
        await expect(card(page).getByTestId('detail-hours')).toContainText('상시 개방');
        await expect(card(page).getByRole('button', { name: '상세 정보 접기' })).toBeVisible();
      });

      await test.step('④ "여기로 안내"로 길찾기 · "관심 없음"으로 다음 대안', async () => {
        const reject = card(page).getByRole('button', { name: DOC.reject }).locator('visible=true').first();
        await reject.scrollIntoViewIfNeeded();
        await reject.click();
        await expect(page.getByText('알겠어요, 다른 곳을 보여드릴게요')).toBeVisible();
        // 피드백이 취향 프로필에 들어갔다는 알림 — 마이페이지로 가는 '보기' 가 붙는다(⑤ 로 이어진다).
        await expect(page.getByText('취향 프로필에 반영했어요')).toBeVisible();
        await expect(page.getByRole('button', { name: '보기', exact: true })).toBeVisible();
        // 다음 대안 — 거절한 곳을 뺀 서버 순위의 다음 장소.
        await expect(card(page)).toContainText('경주 향교');
        await expect(card(page)).not.toContainText('경주 계림');
        await fullCard(page);
        const go = card(page).getByRole('button', { name: DOC.guide }).locator('visible=true').first();
        await expect(go).toHaveText('도보 길안내');
        await go.click();
        expect(await page.evaluate(() => (window as unknown as { __opened?: string }).__opened)).toContain('map.kakao.com');
      });

      await test.step('⑤ 마이페이지 AI 취향 프로필(8축 레이더)에서 갱신된 취향을 확인한다', async () => {
        await page.locator('nav[aria-label="주요 내비게이션"]:visible').getByRole('button', { name: '마이' }).click();
        await expect(page).toHaveURL(/\/mypage/, { timeout: 30_000 });
        const radar = page.getByTestId('taste-radar');
        await expect(radar).toContainText('AI 취향 프로필', { timeout: 30_000 });
        await expect(radar.locator('.recharts-polar-angle-axis-tick')).toHaveCount(8);
      });
    });

    test('[핵심 기능 3] 실시간 TourAPI 정보 조회 (live-detail)', async ({ page }) => {
      test.setTimeout(150_000);
      const calls = await openMain(page);
      await expect(card(page)).toContainText('경주 계림', { timeout: 30_000 });

      await test.step('① 관광지 마커를 탭해 상세 카드를 연다', async () => {
        await expect.poll(() => markers(page)).toContain('경주 향교');
        await tapMarker(page, '경주 향교');
        await expect(card(page)).toContainText('경주 향교');
        await tapMarker(page, '경주 계림');
        await expect(card(page)).toContainText('경주 계림');
        await fullCard(page);
        await expect(card(page).getByText('출처: ⓒ한국관광공사 TourAPI', { exact: true })).toBeVisible();
      });

      await test.step('② "실시간 정보 새로고침" — 운영시간·소개·홈페이지·전화·사진을 즉시 다시 불러와 갱신', async () => {
        const refresh = card(page).getByRole('button', { name: DOC.liveRefresh });
        await refresh.scrollIntoViewIfNeeded();
        await refresh.click();
        await expect(card(page).getByTestId('live-refreshed')).toContainText(/방금 갱신 · \d{2}:\d{2}/);
        await expect(page.getByText('관광정보를 최신으로 불러왔어요')).toBeVisible();
        await expect(card(page).getByText('첨성대와 월성 사이의 숲 — 방금 TourAPI 에서 받은 소개.')).toBeVisible();
        expect(await card(page).locator('[data-refreshed="true"]').count()).toBeGreaterThanOrEqual(4);
        expect(calls.liveDetail).toBe(1);
      });

      await test.step('⑤ 홈페이지·전화 링크로 바로 연결한다', async () => {
        await expect(card(page).locator('a[href^="tel:"]:visible').first()).toHaveAttribute('href', /tel:054-?779-?6100/);
        await expect(card(page).locator('a[href*="gyeongju.go.kr"]:visible').first()).toBeVisible();
        if (isPhone(page)) {
          await card(page).getByRole('button', { name: '추천 간단히 보기' }).click();
          await expect(page.getByTestId('rec-card-peek')).toBeVisible();
        }
      });

      const search = page.getByPlaceholder('경주 장소·메뉴·분위기 검색');

      await test.step('③ DB 에 없는 상호 — 카카오·TourAPI 폴백 결과가 출처를 명시한 별도 목록으로', async () => {
        await search.fill('황남 맥주');
        const kakao = page.getByTestId('place-search-results');
        await expect(kakao.getByText('황남 맥주집')).toBeVisible({ timeout: 20_000 });
        await expect(kakao.getByText('출처: 카카오맵', { exact: true })).toBeVisible();
        await expect(kakao.getByRole('link', { name: '카카오맵', exact: true })).toHaveAttribute('href', 'https://place.map.kakao.com/987654');

        await search.fill('골굴사');
        const tour = page.getByTestId('tourapi-search-results');
        await expect(tour.getByText('골굴사(경주)')).toBeVisible({ timeout: 20_000 });
        await expect(tour.getByText('출처: ⓒ한국관광공사', { exact: true })).toBeVisible();
      });

      await test.step('④ "다음 배치 추가 요청"으로 적재를 신청한다', async () => {
        const tour = page.getByTestId('tourapi-search-results');
        await tour.getByRole('button', { name: DOC.ingest }).click();
        await expect(tour.getByRole('button', { name: '요청 접수됨' })).toBeDisabled();
        expect(calls.ingest).toBe(1);
      });

      await test.step('⑤ 카카오맵 링크로 바로 연결해 방문을 확정한다', async () => {
        const route = page.getByTestId('tourapi-search-results').getByRole('link', { name: '카카오맵 길찾기' });
        await expect(route).toHaveAttribute('href', /map\.kakao\.com\/link\/to\//);
        await expect(route).toHaveAttribute('target', '_blank');
      });
    });

    test('[핵심 기능 4] 음성 AI 비서', async ({ page }) => {
      test.setTimeout(150_000);
      const calls = await openMain(page);
      await expect(card(page)).toContainText('경주 계림', { timeout: 30_000 });

      await test.step('① 추천 카드가 뜬 뒤 음성 오브를 탭하면 추천 장소와 이유를 음성으로 읽어 준다', async () => {
        const pill = page.getByRole('button', { name: DOC.orb }).locator('visible=true');
        await expect(pill).toHaveCount(1);
        await expect(pill).toContainText('AI 음성 비서');
        if (isPhone(page)) {
          // 휴대폰은 알약이 카드 안(미리보기 오른쪽 위)에 있다.
          await expect(card(page).getByRole('button', { name: DOC.orb })).toBeVisible();
        } else {
          // 데스크톱은 카드 바로 위 자리.
          const [pillBox, cardBox] = [await pill.boundingBox(), await card(page).boundingBox()];
          expect(pillBox!.y + pillBox!.height).toBeLessThanOrEqual(cardBox!.y + 2);
        }
        await pill.click();
        await expect(page.getByTestId('voice-caption')).toBeVisible();
        await expect.poll(() => spoken(page)).toContain('경주 계림');
        expect(await spoken(page)).toMatch(/걸어서 \d+분/);
      });

      await test.step('② "다음"이면 다음 SPOT 대안, "응"이면 그대로 길안내', async () => {
        await say(page, '다음');
        await expect(card(page)).toContainText('경주 향교');
        // 휴대폰은 음성이 켜지면 카드가 미리보기로 접힌다(순위 이름은 전체 카드에 있다).
        if (!isPhone(page)) await expect(card(page).getByTestId('card-rank')).toHaveText('2번째 추천');
        await say(page, '응');
        await expect.poll(() => page.evaluate(() => (window as unknown as { __opened?: string }).__opened ?? '')).toContain('map.kakao.com');
        const trip = await page.evaluate(() => JSON.parse(localStorage.getItem('nextspot_active_trip') ?? 'null'));
        expect(trip?.facilityId).toBe('att-hyanggyo');
      });

      await test.step('③ "양식 먹고 싶어" — 후보가 양식 위주로 좁혀져 새 1위가 다시 안내된다', async () => {
        await page.getByRole('button', { name: '음식점', exact: true }).locator('visible=true').click();
        await expect(card(page)).toContainText('황남 쌈밥', { timeout: 20_000 });
        const turns = calls.voiceTurn;
        await say(page, '양식 먹고 싶어');
        await expect(card(page)).toContainText('이사부피자', { timeout: 20_000 });
        await expect.poll(() => spoken(page)).toContain('이사부피자');
        // 칩을 누른 것과 같다 — 데스크톱은 '🍽 메뉴 ▾' 가 양식이 된다(음식 말은 기기에서 바로 알아듣는다).
        if (!isPhone(page)) await expect(page.getByRole('combobox', { name: '메뉴 고르기' })).toHaveValue('western');
        expect(calls.voiceTurn).toBe(turns);
      });

      await test.step('④ "실내로 바꿔줘"·"도보 10분 이내" — 조건이 화면에 즉시 적용된다', async () => {
        // 조건 칩은 카드 머리에 남는다(휴대폰은 음성이 켜지면 미리보기로 접히므로 펼쳐서 본다).
        const conditions = card(page).getByTestId('card-conditions');
        await say(page, '실내로 바꿔줘');
        await fullCard(page);
        await expect(conditions).toContainText('🏠 실내', { timeout: 20_000 });
        await say(page, '도보 10분 이내');
        await fullCard(page);
        await expect(conditions).toContainText('🚶 도보 10분 이내', { timeout: 20_000 });
        await expect(conditions).toContainText('🏠 실내');
      });

      await test.step('⑤ 지도 검색창의 마이크를 탭해 음성으로 상호를 불러 검색한다', async () => {
        const mic = page.getByRole('button', { name: '음성으로 검색' });
        if (!isPhone(page)) await expect(mic).toContainText('음성 검색');
        const before = await page.evaluate(() => ((window as unknown as { __recognitions: unknown[] }).__recognitions ?? []).length);
        await mic.click();
        await expect.poll(() => page.evaluate(() => ((window as unknown as { __recognitions: unknown[] }).__recognitions ?? []).length)).toBeGreaterThan(before);
        expect(await page.evaluate(() => (window as unknown as { __recognition: { lang: string } }).__recognition.lang)).toBe('ko-KR');
        await page.evaluate(() => {
          const recognition = (window as unknown as { __recognition: { onresult?: (e: unknown) => void } }).__recognition;
          recognition.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: '월정교 산책길' }], { isFinal: true })] });
        });
        await expect(page.getByPlaceholder('경주 장소·메뉴·분위기 검색')).toHaveValue('월정교 산책길');
        await expect(card(page)).toContainText('월정교 산책길', { timeout: 20_000 });
        await fullCard(page);
        await expect(card(page).getByTestId('card-rank')).toHaveText('선택한 장소');
      });
    });

    test('[핵심 기능 5] 소상공인 타임세일 + B2G 관제', async ({ page }) => {
      test.setTimeout(180_000);
      const merchant = await stubMerchantConsole(page);
      await page.goto('/merchant/dashboard');

      await test.step('① (상인) "예상 혼잡" 섹션으로 오늘 시간대별 손님 흐름을 확인한다', async () => {
        const forecast = page.locator('section', { hasText: '① 예상 혼잡' });
        await expect(forecast).toBeVisible({ timeout: 30_000 });
        await expect(forecast.getByText('예측', { exact: true })).toBeVisible();
        await expect(forecast.locator('svg.recharts-surface').first()).toBeVisible();
      });

      await test.step('② (상인) "셀프 타임세일"에서 할인율을 골라 발행하면 그 즉시 추천에 반영된다', async () => {
        if (isPhone(page)) await page.getByRole('navigation', { name: '사장님 바로 가기' }).getByText('⚡ 타임세일 발행').click();
        const section = page.locator('section', { hasText: '③ 셀프 타임세일' });
        await expect(section).toBeVisible();
        if (!isPhone(page)) await expectInView(page.getByRole('heading', { name: '지금 할인, 지금 발행' }));
        await page.getByRole('group', { name: '할인율' }).getByRole('button', { name: '15%' }).click();
        await page.getByRole('group', { name: '지속 시간' }).getByRole('button', { name: '1시간' }).click();
        await page.getByRole('button', { name: '타임세일 발행', exact: true }).click();
        await page.getByRole('button', { name: '발행 확인' }).click();
        await expect(page.getByText('15% 타임세일을 발행했습니다.')).toBeVisible();
        const banner = page.getByTestId('timesale-active');
        await expect(banner).toContainText('⚡ 15% 타임세일 진행 중');
        await expect(banner.getByText('추천 반영 중')).toBeVisible();
        expect(merchant.published).toEqual([{ rate: 0.15, minutes: 60 }]);
      });

      await test.step('③ (상인) "좌석 상태 방송"에서 여유·보통·만석 — 30분간 실측 혼잡도를 추천에 반영', async () => {
        if (isPhone(page)) await page.getByRole('navigation', { name: '사장님 바로 가기' }).getByText('🪑 좌석 상태 방송').click();
        const seats = page.getByRole('group', { name: '좌석 상태 방송' });
        for (const level of ['여유', '보통', '만석']) await expect(seats.getByRole('button', { name: level })).toBeVisible();
        if (!isPhone(page)) await expect(seats).toBeInViewport({ ratio: 1 });
        await seats.getByRole('button', { name: '여유' }).click();
        await expect(page.getByText("좌석 상태를 '여유'로 알렸어요.")).toBeVisible();
        expect(merchant.seats).toEqual(['low']);
      });

      await stubAdminConsole(page);
      await page.goto('/admin/dashboard');

      await test.step('④ (지자체) 관제 대시보드 KPI — 평균 혼잡도·추천 수락률·활성 사용자·이상 혼잡', async () => {
        const kpis = page.locator('#dashboard-kpis');
        await expect(kpis).toBeVisible({ timeout: 30_000 });
        for (const title of ['오늘 평균 혼잡도', 'AI 추천 수락률', '활성 사용자 수 (DAU)', '이상 혼잡 발생 (오늘)']) {
          await expect(kpis.getByText(title, { exact: true })).toBeVisible();
        }
        if (!isPhone(page)) {
          await expect(page.getByText('실시간 관제 데이터 동기화 중')).toBeHidden({ timeout: 30_000 });
          const box = (await kpis.boundingBox())!;
          expect(box.y + box.height, 'KPI 네 개가 스크롤 없이 첫 화면에').toBeLessThan(DESKTOP.height);
        }
      });

      await test.step('⑤ (지자체) 쿠폰 정책 패널로 개입하고, 30일 수요 분산 효과 추이로 성과를 확인 · 모델 신뢰 패널', async () => {
        const nav = page.getByRole('navigation', { name: '관제 단계' });
        await nav.getByRole('button', { name: '② 정책 개입' }).click();
        await expect(page.locator('#step-policy')).toBeInViewport();
        await expect(page.getByText('쿠폰 정책 개입', { exact: true }).first()).toBeVisible();
        await nav.getByRole('button', { name: '③ 분산 효과' }).click();
        await expect(page.locator('#step-effect')).toBeInViewport();
        await expect(page.getByRole('heading', { name: '도입 30일 분산 효과 시나리오' })).toBeVisible();
        const trust = page.getByRole('region', { name: '추천 모델 신뢰도' });
        await trust.scrollIntoViewIfNeeded();
        await expect(trust).toBeVisible();
        await expect(trust).toContainText('추천 신뢰도');
      });
    });

    test('입구 — 사장님 콘솔 · 관제 대시보드는 왼쪽 레일·휴대폰 줄·첫 화면 바로 가기에', async ({ page }) => {
      test.setTimeout(120_000);
      await openMain(page);
      await expect(card(page)).toContainText('경주 계림', { timeout: 30_000 });
      // 왼쪽 레일(데스크톱) · 하단 탭 위 한 줄(휴대폰) — 게스트는 두 데모로.
      const nav = page.locator('nav[aria-label="주요 내비게이션"]:visible');
      const merchantLink = nav.getByRole('link', { name: DOC.merchant, exact: true });
      const adminLink = nav.getByRole('link', { name: DOC.admin, exact: true });
      await expectInView(merchantLink);
      await expectInView(adminLink);
      await expect(merchantLink).toHaveAttribute('href', '/merchant?demo=1');
      await expect(adminLink).toHaveAttribute('href', '/admin/dashboard?demo=1');

      // 첫 화면 — 데스크톱은 '이렇게 써 보세요' 5번 줄, 휴대폰은 '바로 시작' 아래 콘솔 링크 한 줄.
      await page.addInitScript(() => localStorage.setItem('nextspot_intro_seen', '1'));
      await page.goto('/');
      const landing = isPhone(page) ? page.locator('body') : page.locator('[data-shortcut="console"]:visible');
      await expect(landing.getByRole('link', { name: DOC.merchant, exact: true }).locator('visible=true')).toHaveAttribute('href', '/merchant?demo=1', { timeout: 30_000 });
      await expect(landing.getByRole('link', { name: DOC.admin, exact: true }).locator('visible=true')).toHaveAttribute('href', '/admin/dashboard?demo=1');
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────
// '이렇게 써 보세요' 바로 가기는 그 기능에 불을 켠 채 도착한다(계획 B1 · 교차 레인 계약 ?focus=)
// ───────────────────────────────────────────────────────────────────────────

const FOCUS_EXPECT = {
  forecast: async (page: Page) => {
    await expect(strip(page)).toHaveClass(/ring-gold/, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: /히트맵/ }).locator('visible=true').first()).toHaveAttribute('aria-pressed', 'true');
  },
  live: async (page: Page) => {
    await expect(page.getByRole('button', { name: '관광지', exact: true }).locator('visible=true')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    await expect(card(page).getByRole('button', { name: DOC.liveRefresh })).toBeVisible({ timeout: 30_000 });
  },
  voice: async (page: Page) => {
    await expect(page.getByRole('button', { name: DOC.orb }).locator('visible=true')).toHaveClass(/ring-gold/, { timeout: 30_000 });
  },
} as const;

test.describe('landing shortcuts land on the feature', () => {
  test.use({ viewport: DESKTOP });

  for (const key of ['forecast', 'live', 'voice'] as const) {
    test(`from '/' the ${key} shortcut opens /main?focus=${key} with that feature lit`, async ({ page }) => {
      test.setTimeout(120_000);
      // 첫 칩은 음식점 — 'live' 가 관광지로 옮겨 주는지 보려고.
      await openMain(page, '/');
      await page.addInitScript(() => localStorage.setItem('nextspot_setup_prefs', JSON.stringify({
        version: 2, categories: ['restaurant'], requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [],
      })));
      await page.goto('/');
      await page.locator(`[data-shortcut="${key}"]:visible`).click();
      await expect(page).toHaveURL(new RegExp(`/main\\?focus=${key}$`), { timeout: 30_000 });
      await FOCUS_EXPECT[key](page);
    });
  }

  test('from the intro opened on /main, rows 1·3·4 light the feature without leaving the map', async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(() => localStorage.setItem('nextspot_intro_seen', '1'));
    await openMain(page);
    await expect(card(page)).toContainText('경주 계림', { timeout: 30_000 });
    const launcher = page.getByRole('button', { name: 'NextSpot 알아보기' }).locator('visible=true').first();
    const dialog = page.getByRole('dialog', { name: 'NextSpot 알아보기' });
    for (const key of ['voice', 'forecast'] as const) {
      // 레일 맨 아래의 '서비스 소개'는 개발 서버의 Next 표시 단추와 겹친다 — 키보드로 연다(landing.spec 과 같다).
      await launcher.focus();
      await page.keyboard.press('Enter');
      await expect(dialog).toBeVisible();
      await dialog.locator(`[data-shortcut="${key}"]`).click();
      await expect(dialog).not.toBeVisible();
      await expect(page).toHaveURL(/\/main$/);
      await FOCUS_EXPECT[key](page);
    }
    // 실시간 관광정보 — 음식점 칩에 있다가 관광지로 옮겨 온다.
    await page.getByRole('button', { name: '음식점', exact: true }).locator('visible=true').click();
    await expect(card(page)).toContainText('황남 쌈밥', { timeout: 20_000 });
    await launcher.focus();
    await page.keyboard.press('Enter');
    await dialog.locator('[data-shortcut="live"]').click();
    await expect(dialog).not.toBeVisible();
    await FOCUS_EXPECT.live(page);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 콘솔 스텁 — 실계정 사장님(심사 가게 모양) · 관리자. 쓰기는 여기서 끝난다.
// ───────────────────────────────────────────────────────────────────────────

const routeJson = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });

async function stubMerchantConsole(page: Page): Promise<{ published: { rate: number; minutes: number }[]; seats: string[] }> {
  const record = { published: [] as { rate: number; minutes: number }[], seats: [] as string[] };
  const sales: unknown[] = [];
  await page.route('**/rest/v1/**', (route) => routeJson(route, []));
  await page.route('**/api/v1/**', (route) => routeJson(route, {}));
  await page.route('**/predict/**', (route) => routeJson(route, { detail: 'untrained' }, 503));
  await page.route('**/predict/model-info', (route) => routeJson(route, { trained: false, fallback_state: 'degraded_rules' }));
  await page.route('**/api/v1/account/me', (route) => routeJson(route, {
    id: 'merchant-e2e', role: 'merchant', is_anonymous: false, nickname: null,
    owned_facilities: [{ id: 'f-e2e', name: '경주 테스트 식당', type: 'restaurant' }], pending_verification: false,
  }));
  await page.route('**/api/v1/merchant/briefing**', (route) => routeJson(route, { briefing: null, llm_status: 'skipped' }));
  await page.route('**/api/v1/merchant/stats**', (route) => routeJson(route, {
    facility_id: 'f-e2e', since: '', window_days: 7, coupons_issued: 0, coupons_used: 0, congestion_reports: 0,
    recommendations_exposed: 120, recommendations_accepted: 4, visit_confirmations: null, visit_confirmations_note: '',
  }));
  await page.route('**/api/v1/merchant/timesale**', (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { rate: number; duration_minutes: number };
      record.published.push({ rate: body.rate, minutes: body.duration_minutes });
      const now = Date.now();
      const sale = {
        id: 'ts-e2e', facility_id: 'f-e2e', rate: body.rate, canceled_at: null,
        starts_at: new Date(now).toISOString(), ends_at: new Date(now + body.duration_minutes * 60_000).toISOString(),
        created_at: new Date(now).toISOString(),
      };
      sales.push(sale);
      return routeJson(route, { ...sale, other_active_timesale_count: 0, effective_timesale_rate: body.rate, effective_timesale_note: null });
    }
    return routeJson(route, sales);
  });
  await page.route('**/api/v1/merchant/seat-status', (route) => {
    const body = route.request().postDataJSON() as { level: string | null };
    if (body.level) record.seats.push(body.level);
    return routeJson(route, { facility_id: 'f-e2e', level: body.level, updated_at: new Date().toISOString(), observation_logged: true });
  });
  await page.route('**/rest/v1/facilities**', (route) => routeJson(route, [{ coupon_rate: 0.05, features: null }]));
  await page.addInitScript(() => {
    localStorage.setItem('nextspot_merchant_facility', JSON.stringify({ id: 'f-e2e', name: '경주 테스트 식당', type: 'restaurant', couponRate: 0 }));
  });
  return record;
}

const iso = (minutesBack: number) => new Date(Date.now() - minutesBack * 60_000).toISOString();
const todayKst = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

async function stubAdminConsole(page: Page): Promise<void> {
  await page.route('**/rest/v1/**', (route) => {
    if (route.request().method() === 'HEAD') {
      return route.fulfill({
        status: 200, body: '',
        headers: { 'content-range': '*/1669', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' },
      });
    }
    return routeJson(route, []);
  });
  await page.route('**/api/v1/**', (route) => {
    const url = route.request().url();
    if (url.includes('/account/me')) {
      return routeJson(route, {
        id: '00000000-0000-4000-8000-0000000000ad', role: 'admin', is_anonymous: false, nickname: '관제 담당자',
        owned_facilities: [], pending_verification: false,
      });
    }
    if (url.includes('/admin/dashboard/today')) {
      return routeJson(route, {
        hasLogs: false, sampleCount: 0, sourceComposition: {},
        estimated: {
          hasLogs: true, dateKst: todayKst(),
          avgCongestion: { value: 0.47, changePercent: 3.1, changePercentOrNull: 3.1, prevSampleCount: 120 },
          anomalyCount: 4,
          heatmap: ['불국사', '첨성대', '대릉원'].flatMap((facility) =>
            [9, 10, 11, 12, 13].map((hour) => ({ facility, facilityType: 'attraction', hour, value: 0.3 + hour / 40 }))),
          anomalies: [{ id: 'a1', facilityName: '천마총(대릉원)', timestamp: iso(40), congestionLevel: 0.92, durationMinutes: 10 }],
          sampleCount: 74,
          basis: {
            lotCountMax: 6, latestObservedAt: iso(3), radiusM: 2000, placeCount: 8, estimatedFacilityCount: 612,
            facilityCount: 1669, snapshotCount: 74, weights: { parking: 0.7, tourism: 0.3 },
          },
        },
      });
    }
    if (url.includes('/admin/dashboard/briefing')) return routeJson(route, { briefing: '오늘 오후 1시 무렵 대릉원 일원이 가장 붐볐습니다.', llmStatus: 'llm' });
    if (url.includes('/admin/metrics/trend')) return routeJson(route, { daily: [], truncated: false });
    if (url.includes('/admin/metrics')) {
      return routeJson(route, {
        since: iso(8 * 24 * 60),
        recommendations: Array.from({ length: 40 }, (_, i) => ({ accepted: i % 4 === 0, created_at: iso(30 + i * 60) })),
        feedback: Array.from({ length: 12 }, (_, i) => ({ user_id: `u${i % 7}`, timestamp: iso(5 + i) })),
        truncated: false,
      });
    }
    if (url.includes('/admin/model-trust')) {
      return routeJson(route, {
        model: { trained: false, version: null, real_data_count: 0, mae: null },
        registry: null,
        funnel: { exposures: 4812, navigations: 37, arrivals: 3, positive_ratings: 2, verified_visit_success_rate: 0 },
        top3_evidence: { coverage_rate: 0.62, fresh_rate: 0.3, fresh_trusted_measured_rate: 0.1, operating_hours_rate: 0.91 },
        collection: {
          observations: 12, trusted_observations: 3, remaining_to_candidate: 47, active_facilities: 1669,
          trusted_facility_coverage_rate: 0.002, by_source: { user_report: 9, merchant: 3 }, by_evidence_tier: {}, facility_gaps: [],
        },
        guardrails: { warnings: [], walk_limit_violations: 0, scoring_modes: { degraded_rules: 4812 } },
      });
    }
    if (url.includes('/admin/settings')) {
      return routeJson(route, { maintenance_mode: false, notice_text: '', congestion_threshold: 80, coldstart_weight: 50 });
    }
    return routeJson(route, { detail: 'not stubbed' }, 404);
  });
}
