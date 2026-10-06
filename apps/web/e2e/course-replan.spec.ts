import { expect, test, type Page } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// 분산 코스(/course) 브라우저 회귀 — 자동 추천 → 순서 지정 → 대안 펼치기 → 갈아끼우기.
//
// 이 화면의 조작은 전부 **재요청**이다. 대안을 고르는 것도 카드를 바꿔치기하는 게 아니라
// 그 자리에 고정을 꽂고 다시 짜는 것이라(page.tsx swapTo 주석), 화면만 보고는 '요청이
// 나갔는가' 를 알 수 없다. 그래서 여기서는 **전송된 본문**과 **그려진 정류지**를 함께 잠근다.
//
// 외부로 나가는 것은 공용 스텁이 전부 막는다 — 지도 SDK 와 Supabase 인증(support/stubs.ts).
// 인증이 늦으면 화면이 '조건에 맞는 곳 0건' 을 '장애' 로 바꿔 말하므로, 이 배선이 빠지면
// 이 묶음은 간헐적으로 빨간불이 된다(lib/e2eDeterminism.test.ts 가 소스에서 강제한다).

test.beforeEach(async ({ page }) => {
  // Windows dev server 의 첫 /course 컴파일 여유 — journey-loop.spec.ts 와 같은 이유.
  test.setTimeout(60_000);
  await stubExternalServices(page);
  // 위치는 **묻지도 답하지도 않게** 둔다. 권한 거부 콜백은 map.locationFallback 토스트를
  // 띄우는데(page.tsx 2번 effect), sonner 는 bottom-center 라 그 4초 동안 시트 아래쪽의
  // '여기로 바꾸기' 를 덮어 클릭이 가로채인다. 콜백이 오지 않으면 coords 는 지역 중심
  // 기본값 그대로라(REGION.center) 재조회도 생기지 않는다 — 이 스펙이 세는 요청 수가
  // 위치 허용 여부에 따라 달라지지 않아야 한다.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: () => { /* 응답하지 않는다(권한 대기 상태와 동일) */ },
        watchPosition: () => 0,
        clearWatch: () => { /* no-op */ },
      },
    });
  });
});

/** 서버가 실제로 받는 모양 — apiClient 가 요청에 keysToSnake 를 적용한다. */
interface PlanPin {
  order: number;
  facility_id: string;
}
interface PlanRequest {
  sequence?: string[];
  types?: string[];
  pins?: PlanPin[];
}

/** 자리마다 1등 + 차점 2곳. 갈아끼우기가 '정말 교체됐는가' 를 이름으로 확인하려면
 *  같은 종류 안에 서로 다른 이름이 여러 개 있어야 한다. */
const CATALOG: Record<string, { id: string; name: string }[]> = {
  cafe: [
    { id: 'cafe-1', name: '고요한 찻집' },
    { id: 'cafe-2', name: '황남 커피' },
    { id: 'cafe-3', name: '대릉원 라운지' },
  ],
  attraction: [
    { id: 'att-1', name: '첨성대 뜰' },
    { id: 'att-2', name: '동궁과 월지' },
    { id: 'att-3', name: '교촌 한옥길' },
  ],
  restaurant: [
    { id: 'res-1', name: '황리단길 국밥' },
    { id: 'res-2', name: '쌈밥 정식' },
    { id: 'res-3', name: '보문 손칼국수' },
  ],
};

/** sequence 를 안 보냈을 때 서버가 알아서 짜는 순서(자동 모드). */
const AUTO_SEQUENCE = ['cafe', 'attraction'];

/**
 * 요청 본문으로 계획을 **실제로 계산해서** 돌려준다(고정한 자리는 고정한 가게로).
 *
 * 응답은 snake_case 로 만든다 — apiClient 가 응답에 keysToCamel 을 적용하므로
 * 여기서 camelCase 로 주면 화면은 `arrivalOffsetMin` 대신 아무것도 못 읽는다.
 */
function buildPlan(body: PlanRequest) {
  const sequence = body.sequence && body.sequence.length > 0 ? body.sequence : AUTO_SEQUENCE;
  const pinned = new Map((body.pins ?? []).map((pin) => [pin.order, pin.facility_id]));

  const stops = sequence.map((type, index) => {
    const order = index + 1;
    const pool = CATALOG[type] ?? [];
    const chosen = pool.find((f) => f.id === pinned.get(order)) ?? pool[0];
    const alternatives = pool.filter((f) => f.id !== chosen.id);
    const arrival = 12 * order;
    const place = (id: string, name: string) => ({
      id, name, type, latitude: 35.836 + order / 1000, longitude: 129.21, capacity: 30,
    });
    return {
      order,
      facility: place(chosen.id, chosen.name),
      arrival_offset_min: arrival,
      predicted_congestion: 0.35,
      spot_score: 0.82,
      reason: `${chosen.name} 고정 추천 사유`,
      travel_minutes: arrival,
      alternatives: alternatives.map((alt, altIndex) => ({
        facility: place(alt.id, alt.name),
        arrival_offset_min: arrival + 2 + altIndex,
        predicted_congestion: 0.2,
        spot_score: 0.7,
        travel_minutes: arrival + 2 + altIndex,
      })),
    };
  });

  return {
    // 선택된 시설 열이 바뀌면 planId 도 바뀐다 — 화면은 이 값으로 '정말 바뀌었는지' 를 판정한다.
    plan_id: stops.map((stop) => stop.facility.id).join('+'),
    stops,
    // **성공한 자리에도** 결과를 넣는다. 비어 있으면 화면이 구 API 응답으로 보고
    // 고정·대안 조작을 아예 그리지 않는다(page.tsx StopRows: replanSupported = outcomes.length > 0).
    // 실제 서버도 채운 자리에 status:'filled' 를 넣는다.
    slot_outcomes: stops.map((stop) => ({
      order: stop.order,
      requested_type: stop.facility.type,
      status: 'filled',
      facility_id: stop.facility.id,
      pinned: pinned.get(stop.order) === stop.facility.id,
    })),
  };
}

/**
 * /courses/plan 스텁을 걸고, 나간 요청 본문을 순서대로 모아 돌려준다.
 *
 * **넓은 것을 먼저, 좁은 것을 나중에** 등록한다 — Playwright 는 나중에 등록한 route 가
 * 이긴다. catch-all 을 뒤에 걸면 /courses/plan 스텁이 영영 불리지 않아 계획이 `{}` 로 온다.
 */
async function stubCoursePlan(
  page: Page,
  options: {
    /** 첫 응답 이후의 응답을 지연시킨다(재계획 중 화면을 관찰하려고). */
    replanDelayMs?: number;
    /** 계획 대신 이 본문을 돌려준다(빈 코스 등 특수 응답용). */
    respondWith?: () => unknown;
  } = {},
): Promise<PlanRequest[]> {
  const requests: PlanRequest[] = [];
  // 코스 외 호출(공개 설정·계정 등)은 빈 성공으로 닫는다 — 어느 것도 밖으로 나가지 않는다.
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/v1/courses/plan', async (route) => {
    const body: PlanRequest = route.request().postDataJSON() ?? {};
    requests.push(body);
    if (requests.length > 1 && options.replanDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.replanDelayMs));
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(options.respondWith ? options.respondWith() : buildPlan(body)),
    });
  });
  return requests;
}

/** 정류지 행의 제목(h3). 이 화면에서 h3 는 정류지 행뿐이다. */
function stopHeadings(page: Page) {
  return page.getByRole('heading', { level: 3 });
}

/** '코스 직접 짜기'(P13) — 정류지가 먼저 보이고, 순서·종류를 고르는 판은 이 버튼 뒤에 있다. */
async function openBuilder(page: Page) {
  const toggle = page.getByRole('button', { name: '코스 직접 짜기' });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

/** 정류지의 '더보기'(I58) — 자동차 · 다른 곳 N · 이 자리 고정은 그 뒤에 있다. */
async function openMore(page: Page, facilityId: string) {
  const more = page.locator(`button[aria-controls="course-more-${facilityId}"]`);
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
}

/** 그 정류지의 대안 토글.
 *
 * 이름('다른 곳 2')으로 잡으면 **누른 뒤에 놓친다** — 라벨이 '접기' 로 바뀌는 순간 그 버튼은
 * 더 이상 이름에 걸리지 않고, `.first()` 는 조용히 아래 정류지의 토글로 옮겨간다(실제로 그렇게
 * 한 번 틀렸다). 자리를 여는 대상(aria-controls)으로 잡으면 라벨이 바뀌어도 같은 버튼이다. */
function altsToggle(page: Page, facilityId: string) {
  return page.locator(`button[aria-controls="course-alts-${facilityId}"]`);
}

/** 정류지가 이 이름들로 **이 순서대로** 그려졌는가.
 *  고정된 자리는 제목에 '📌 고정됨' 배지가 붙으므로 완전 일치가 아니라 포함으로 본다. */
async function expectStops(page: Page, names: string[]) {
  const headings = stopHeadings(page);
  await expect(headings).toHaveCount(names.length, { timeout: 30_000 });
  for (const [index, name] of names.entries()) {
    await expect(headings.nth(index)).toContainText(name, { timeout: 30_000 });
  }
}

test('첫 진입은 sequence 없이 자동 추천을 받아 정류지를 그린다', async ({ page }) => {
  const requests = await stubCoursePlan(page);
  await page.goto('/course');

  await expectStops(page, ['고요한 찻집', '첨성대 뜰']);
  // 아무 순서도 짜지 않았으면 sequence 를 **보내지 않는다**(자동 모드). 빈 배열이라도 실어
  // 보내면 서버는 '0곳짜리 순서를 지정했다' 로 읽는다.
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request.sequence).toBeUndefined();
    expect(request.pins).toBeUndefined();
  }
});

test('순서를 직접 짜면 그 순서가 요청에 실리고 정류지도 그 순서로 갈린다', async ({ page }) => {
  const requests = await stubCoursePlan(page);
  await page.goto('/course');
  await expectStops(page, ['고요한 찻집', '첨성대 뜰']);

  await openBuilder(page);
  await page.getByRole('button', { name: '관광지 코스에 추가' }).click();
  await page.getByRole('button', { name: '카페 코스에 추가' }).click();

  // 담은 순서가 **실제로 전송**되는지부터 본다. 화면만 보면 서버가 알아서 그 순서를 골랐을
  // 가능성과 구분되지 않는다(드래그 연타는 디바운스로 한 번만 나갈 수도, 두 번 나갈 수도 있어
  // 마지막 요청을 본다).
  await expect.poll(() => requests[requests.length - 1]?.sequence, { timeout: 30_000 })
    .toEqual(['attraction', 'cafe']);
  await expectStops(page, ['첨성대 뜰', '고요한 찻집']);
});

test('대안 토글이 차점 후보를 펼치고 라벨이 접기로 바뀐다', async ({ page }) => {
  await stubCoursePlan(page);
  await page.goto('/course');
  await expectStops(page, ['고요한 찻집', '첨성대 뜰']);

  await openMore(page, 'cafe-1');
  const toggle = altsToggle(page, 'cafe-1');
  await expect(toggle).toHaveText('다른 곳 2');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();

  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveText('접기');
  // 대안 행의 버튼은 이름으로 구분된다 — 보이는 글자('여기로 바꾸기')는 전부 같아서
  // 화면 없이 듣는 사람에게는 aria-label 만이 어느 가게인지 말해 준다(page.tsx altsPickAria).
  await expect(page.getByRole('button', { name: '황남 커피(으)로 바꾸기' })).toBeVisible();
  await expect(page.getByRole('button', { name: '대릉원 라운지(으)로 바꾸기' })).toBeVisible();
});

test("'여기로 바꾸기' 는 그 자리에 고정을 꽂아 다시 요청하고 정류지를 교체한다", async ({ page }) => {
  const requests = await stubCoursePlan(page);
  await page.goto('/course');
  await expectStops(page, ['고요한 찻집', '첨성대 뜰']);

  await openMore(page, 'cafe-1');
  await altsToggle(page, 'cafe-1').click();
  await page.getByRole('button', { name: '황남 커피(으)로 바꾸기' }).click();

  // 카드만 바꿔치기하면 뒤 정류지의 도착 시각이 낡은 값이 된다 — 그래서 이 조작은 반드시
  // **재요청**이어야 한다. 자동 모드의 자리 키는 auto-0 이므로 1번 자리로 나간다.
  await expect.poll(() => requests[requests.length - 1]?.pins, { timeout: 30_000 })
    .toEqual([{ order: 1, facility_id: 'cafe-2' }]);
  await expectStops(page, ['황남 커피', '첨성대 뜰']);
  await expect(page.getByText('고정됨')).toBeVisible();
});

test('재계획이 도착하기 전에는 고정·대안 조작을 그리지 않는다', async ({ page }) => {
  // 자리 키가 어긋난 창(디바운스 500ms + 왕복)을 넉넉히 벌린다.
  await stubCoursePlan(page, { replanDelayMs: 1500 });
  await page.goto('/course');
  await expectStops(page, ['고요한 찻집', '첨성대 뜰']);

  const pinButtons = page.getByRole('button', { name: /이 자리 고정/ });
  const altToggles = page.locator('button[aria-controls^="course-alts-"]');
  // 고정·대안 조작은 정류지마다 '더보기' 뒤에 있다(I58).
  await openMore(page, 'cafe-1');
  await openMore(page, 'att-1');
  await expect(pinButtons).toHaveCount(2);

  await openBuilder(page);
  await page.getByRole('button', { name: '카페 코스에 추가' }).click();

  // 여기서 누른 고정은 slotKeys.indexOf(옛 키) === -1 이라 조용히 걸러진다. 눌러도 아무 일도
  // 일어나지 않는 버튼을 주지 않으려고 그 창에서는 조작 자체를 내린다(lib/courseSlotKeys.ts).
  await expect(pinButtons).toHaveCount(0);
  await expect(altToggles).toHaveCount(0);

  // 새 계획이 오면 다시 그린다 — 조작이 영영 사라지는 것이 아니라 그 창 동안만 없다.
  await expectStops(page, ['고요한 찻집']);
  await expect(pinButtons).toHaveCount(1);
});

// ── 정류지가 먼저, 읽기 쉬운 시간표(P13 · I58) ─────────────────────────────────────────────────────
test('stops come first: the builder waits behind one button, names stay whole, times are clock times, no %', async ({ page }) => {
  await stubCoursePlan(page);
  await page.goto('/course');
  await expectStops(page, ['고요한 찻집', '첨성대 뜰']);

  // 첫 화면에는 종류 칩이 없다 — '코스 직접 짜기' 한 버튼 뒤에.
  await expect(page.getByRole('button', { name: /코스에 추가$/ })).toHaveCount(0);
  const builder = page.getByRole('button', { name: '코스 직접 짜기' });
  await expect(builder).toHaveAttribute('aria-expanded', 'false');
  // 정류지 목록이 그 버튼보다 위에 있다.
  const [firstStop, builderBox] = await Promise.all([page.getByRole('heading', { level: 3 }).first().boundingBox(), builder.boundingBox()]);
  expect(firstStop!.y).toBeLessThan(builderBox!.y);
  await builder.click();
  await expect(page.getByRole('button', { name: /코스에 추가$/ })).toHaveCount(4);
  await expect(page.getByRole('heading', { level: 2, name: '어떤 곳을 넣을까요?' })).toBeVisible();

  // 스텝퍼: 이름 전체, '+42분' 대신 '12:59 도착'. 탭 이름은 '시간표'.
  const stepper = page.getByRole('list', { name: '코스 순서 미리보기' });
  await expect(stepper).toContainText('고요한 찻집');
  await expect(stepper).not.toContainText('…');
  expect(await stepper.innerText()).not.toMatch(/\+\d+분/);
  await expect(stepper.getByText(/^\d{2}:\d{2} 도착$/)).toHaveCount(2);
  await expect(page.getByRole('tab', { name: '시간표' })).toBeVisible();
  await expect(page.getByText(/간트/)).toHaveCount(0);
  // 붐빔은 등급만 — 정류지 칩·대안 줄에 % 가 없다.
  await expect(page.locator('main')).not.toContainText(/\d+%/);
  // 헤더: 마지막 정류지 도착 시각.
  await expect(page.getByText(/마지막 장소 \d{2}:\d{2} 도착/)).toBeVisible();
});

test('the stop reason is written in the screen language, not the Korean server sentence', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nextspot_locale', 'en'));
  await stubCoursePlan(page);
  await page.goto('/course');
  await expect(page.getByRole('heading', { level: 3 })).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.locator('button[aria-controls="course-reason-cafe-1"]').click();
  const reason = page.locator('#course-reason-cafe-1');
  // 왜 골랐는지를 말한다 — 순서·이름·도착 시각은 칩이 이미 말한다(리뷰: 칩을 되풀이하던 'Stop 1: … arriving at').
  await expect(reason).toContainText('Picked for your taste, walking time and perks.');
  await expect(reason).toContainText('Crowd level when you arrive: Relaxed');
  await expect(reason).not.toContainText('Stop 1');
  await expect(reason).not.toContainText('고정 추천 사유');
});

test('ko stop reason says why, and adds the time-dispersal benefit when the server found one', async ({ page }) => {
  await stubCoursePlan(page, {
    respondWith: () => {
      const plan = buildPlan({});
      // 서버(courses.py _build_stop_reason)가 도착 때 지금보다 한산해진다고 판단한 정류지.
      plan.stops[1].reason = '2번째 코스 첨성대 뜰: 약 24분 뒤 도착하면 예상 혼잡도 35%(여유) 수준이에요. 지금보다 약 30%p 여유로워질 시간대예요.';
      return plan;
    },
  });
  await page.goto('/course');
  await expectStops(page, ['고요한 찻집', '첨성대 뜰']);
  await page.locator('button[aria-controls="course-reason-cafe-1"]').click();
  await page.locator('button[aria-controls="course-reason-att-1"]').click();
  const first = page.locator('#course-reason-cafe-1');
  const second = page.locator('#course-reason-att-1');
  await expect(first).toContainText('취향·걷는 시간·혜택을 함께 따져 고른 곳이에요.');
  await expect(first).not.toContainText('덜 붐빌 시간대');
  await expect(second).toContainText('도착할 때 지금보다 덜 붐빌 시간대예요.');
  // 순서·시각 되풀이도, '1번째' 같은 어색한 서수도, % 도 없다.
  for (const reason of [first, second]) {
    await expect(reason).not.toContainText(/번째|도착 예정이에요|\d+%/);
  }
});

test('an assumed-time course prints clock times from that time, not from now', async ({ page }) => {
  // 지금은 수 12:30 KST, 가정 시간은 토 14:00 — 도착 오프셋 12·24분은 14:12·14:24 다(12:42·12:54 가 아니다).
  await page.clock.setFixedTime(new Date('2026-10-07T03:30:00Z'));
  await page.addInitScript(() => localStorage.setItem('nextspot_assumed_at', 'sat_afternoon'));
  await stubCoursePlan(page);
  await page.goto('/course');
  await expectStops(page, ['고요한 찻집', '첨성대 뜰']);
  const stepper = page.getByRole('list', { name: '코스 순서 미리보기' });
  await expect(stepper).toContainText('14:12 도착');
  await expect(stepper).toContainText('14:24 도착');
  await expect(page.getByText('마지막 장소 14:24 도착')).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/12:42 도착|12:54 도착/);
});

test('desktop stepper: the first stop sits next to its connector, with no empty gap', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 730 });
  await stubCoursePlan(page);
  await page.goto('/course');
  await expectStops(page, ['고요한 찻집', '첨성대 뜰']);
  const items = page.getByRole('list', { name: '코스 순서 미리보기' }).locator(':scope > li');
  const [first, second] = await Promise.all([items.nth(0).boundingBox(), items.nth(1).boundingBox()]);
  // 첫 칸은 자기 정류지 폭(7rem)만 — 예전에는 flex-1 로 늘어나 첫 정류지 오른쪽에 연결선 없는 빈자리가 ~90px 생겼다.
  expect(first!.width).toBeLessThanOrEqual(7 * 16 + 1);
  expect(second!.x - (first!.x + first!.width)).toBeLessThanOrEqual(1);
});

test('빈 코스에서 다음 선택을 안내한다', async ({ page }) => {
  await stubCoursePlan(page, {
    respondWith: () => ({
      plan_id: '',
      stops: [],
      slot_outcomes: [
        // 자동 모드는 요청한 종류가 없다(requested_type=null) — 종류를 말하지 않는 문장이어야
        // "조건에 맞는 이(가) 없어요" 같은 깨진 문장이 나가지 않는다(page.tsx slotReasonKey).
        { order: 1, requested_type: null, status: 'no_candidate_of_type', facility_id: null, pinned: false },
        { order: 2, requested_type: 'cafe', status: 'late_night_unconfirmed', facility_id: null, pinned: false },
      ],
    }),
  });
  await page.goto('/course');

  await expect(page.getByText('조건을 넓혀 코스를 찾아볼게요')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('도보 시간이나 조건을 넓혀 주변 장소를 더 찾아보세요.')).toBeVisible();
  await expect(page.getByText('가정 시간을 낮 시간대로 바꾸면 식당·카페 선택지가 넓어져요.')).toBeVisible();
});
