// 사장님 콘솔 API 헬퍼 테스트 — 2026-09 감사에서 나온 '실패를 정직하게 전달하는가' 계약을 잠근다.
//
// 이 저장소의 웹 테스트 규약: jest/vitest 없이 node:assert 로 스스로 판정하는 독립 스크립트다
// (scripts/run-web-tests.mjs 가 lib/**/*.test.ts 를 전부 tsx 로, cwd=apps/web 으로 돌린다).
// tsx 가 CJS 로 변환하므로 top-level await 는 못 쓴다 — main() 으로 감싼다.
//
// React 테스트 러너가 없어서 화면(.tsx) 렌더는 직접 확인할 수 없다. 그래서 판단이 들어가는
// 부분을 순수 함수로 뽑아 여기서 잠그고, 화면이 그 함수를 실제로 쓰는지는 파일 끝의
// '화면 배선 가드' 가 소스에서 확인한다 — 이걸 안 두면 함수만 맞고 화면은 예전 문구로 남는다
// (이번 감사 (3)번 결함이 정확히 그 모양이었다: 서버는 만들어 보내고 프런트는 읽지 않았다).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchFacilityCongestionForecast,
  forecastNote,
  hasTimesaleOverlapNotice,
  resetPredictModelInfoMemo,
  timesaleConfirmPreview,
  timesalePublishNotice,
  timesaleRateHint,
  type MerchantTimesaleCreated,
} from './api';
import { kstParts, predictedLevel } from '../adminPredictedView';

// 러너가 cwd 를 apps/web 으로 고정한다(직접 실행할 때도 apps/web 에서 돈다).
const WEB = process.cwd();

// --- fetch 스텁 ------------------------------------------------------------
// api.ts 의 예측 경로는 전역 fetch 만 쓴다(Supabase 는 끼어들지 않는다).

type Route = (
  url: string,
  init?: RequestInit,
) => { status: number; body: unknown } | 'network-error' | 'aborted';

function withFetch<T>(route: Route, run: () => Promise<T>): Promise<T> {
  // 케이스마다 새 탭처럼 — 앞 케이스가 기억시킨 모델 상태가 호출 수 계약을 흐리지 않게.
  resetPredictModelInfoMemo();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const result = route(url, init);
    if (result === 'network-error') throw new TypeError('fetch failed');
    // 타임아웃이 걸린 요청 — AbortController 가 abort 하면 fetch 는 AbortError 로 끝난다.
    if (result === 'aborted') throw new DOMException('The operation was aborted.', 'AbortError');
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body,
    } as Response;
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

/** 요청 경로별 호출 수를 센다(같은 경로를 몇 번 불렀는지가 이 계약의 핵심이다). */
function counter() {
  const calls: string[] = [];
  return {
    calls,
    count: (part: string) => calls.filter((u) => u.includes(part)).length,
  };
}

const HOUR_MS = 3600 * 1000;
// 2026-10-06(화) 14:00 KST — 결정적인 '지금'.
const NOW = Date.UTC(2026, 9, 6, 5, 0, 0);

/** 업종 요일·시간대 패턴 곡선의 기대값 — adminPredictedView 와 **같은 함수**로 계산한다. */
function expectedPattern(facilityType: string, hours = 6) {
  return Array.from({ length: hours + 1 }, (_, h) => {
    const { hour, weekday } = kstParts(NOW + h * HOUR_MS);
    return { hoursAhead: h, hour, congestion: predictedLevel({ facilityType, kstHour: hour, weekday }) };
  });
}

function assertPattern(
  result: Awaited<ReturnType<typeof fetchFacilityCongestionForecast>>,
  facilityType: string,
  why: string,
) {
  assert.equal(result.basis, 'pattern', why);
  assert.equal(result.points.length, 7, '지금부터 6시간 뒤까지 7개 점이어야 한다');
  assert.deepEqual(
    result.points.map((p) => ({ hoursAhead: p.hoursAhead, hour: p.hour, congestion: p.congestion })),
    expectedPattern(facilityType),
    '관제 대시보드 예측 칸과 다른 숫자를 그렸다',
  );
  assert.ok(result.points.every((p) => p.anchored === false), '패턴 곡선은 우리 가게 실측에 앵커링된 값이 아니다');
}

async function main() {
  // --- (2) ① 예상 혼잡은 항상 그려진다 ---------------------------------------------
  // 배포 환경의 상시 상태(모델 미학습)에서 /predict/batch 는 7번 모두 503 이었다. 이제는 model-info
  // 한 번으로 확인하고, 미학습이면 batch 를 부르지 않고 같은 업종의 요일·시간대 패턴으로 그린다.

  // 미학습 → 패턴, batch 0회, model-info 1회.
  {
    const net = counter();
    await withFetch(
      (url) => {
        net.calls.push(url);
        if (url.includes('/predict/model-info')) {
          return { status: 200, body: { trained: false, fallback_state: 'degraded_rules' } };
        }
        if (url.includes('/predict/batch')) {
          return { status: 503, body: { detail: '검증된 혼잡 예측 모델이 없습니다.' } };
        }
        throw new Error(`예상치 못한 요청: ${url}`);
      },
      async () => {
        const result = await fetchFacilityCongestionForecast('f-1', 'restaurant', 6, NOW);
        assertPattern(result, 'restaurant', '미학습인데 패턴 곡선이 아니다');
      },
    );
    assert.equal(net.count('/predict/batch'), 0, '미학습인데 실패할 batch 요청을 보냈다');
    assert.equal(net.count('/predict/model-info'), 1, 'model-info 는 한 번만 물어야 한다');
  }

  // 업종이 다르면 곡선도 다르다(카페 = 오후 피크) — facility.type 이 실제로 전달되는지.
  await withFetch(
    (url) => {
      if (url.includes('/predict/model-info')) return { status: 200, body: { trained: false } };
      throw new Error(`예상치 못한 요청: ${url}`);
    },
    async () => {
      const result = await fetchFacilityCongestionForecast('f-1', 'cafe', 6, NOW);
      assertPattern(result, 'cafe', '카페 패턴이 아니다');
      assert.notDeepEqual(
        result.points.map((p) => p.congestion),
        expectedPattern('restaurant').map((p) => p.congestion),
      );
    },
  );

  // 학습됨 → 기존 batch 경로(서버 예측) 그대로.
  {
    const net = counter();
    await withFetch(
      (url, init) => {
        net.calls.push(url);
        if (url.includes('/predict/model-info')) return { status: 200, body: { trained: true, fallback_state: null } };
        if (url.includes('/predict/batch')) {
          const hoursAhead = JSON.parse(String(init?.body ?? '{}')).hours_ahead as number;
          return {
            status: 200,
            body: {
              generated_at: new Date(NOW).toISOString(),
              hours_ahead: hoursAhead,
              predictions: [
                { facility_id: 'other', predicted_congestion: 0.9, anchored: false, event_boost: 0 },
                { facility_id: 'f-1', predicted_congestion: 0.1 * (hoursAhead + 1), anchored: true, event_boost: 0 },
              ],
            },
          };
        }
        throw new Error(`예상치 못한 요청: ${url}`);
      },
      async () => {
        const result = await fetchFacilityCongestionForecast('f-1', 'restaurant', 6, NOW);
        assert.equal(result.basis, 'model');
        assert.equal(result.points.length, 7);
        assert.deepEqual(
          result.points.map((p) => p.hour),
          [14, 15, 16, 17, 18, 19, 20],
          'KST 시각 라벨이 틀렸다',
        );
        assert.equal(result.points[2].congestion, 0.1 * 3, '서버 예측값을 그대로 쓰지 않았다');
        assert.ok(result.points.every((p) => p.anchored), '서버의 앵커링 여부를 버렸다');
      },
    );
    assert.equal(net.count('/predict/batch'), 7);
    assert.equal(net.count('/predict/model-info'), 1);
  }

  // 어떤 실패든 '다시 시도' 상자 대신 패턴 곡선으로 내려앉는다.
  const fallbackCases: { why: string; route: Route }[] = [
    {
      why: 'model-info 500',
      route: (url) => (url.includes('/predict/model-info') ? { status: 500, body: {} } : 'network-error'),
    },
    {
      why: 'model-info 응답 형식 이상',
      route: (url) => (url.includes('/predict/model-info') ? { status: 200, body: { ok: 1 } } : 'network-error'),
    },
    {
      why: 'model-info 타임아웃(abort)',
      route: (url, init) => {
        if (!url.includes('/predict/model-info')) return 'network-error';
        assert.ok(init?.signal, 'model-info 요청에 타임아웃 신호가 없다');
        return 'aborted';
      },
    },
    { why: '네트워크 단절', route: () => 'network-error' },
    {
      why: '학습됨 + batch 503',
      route: (url) => {
        if (url.includes('/predict/model-info')) return { status: 200, body: { trained: true } };
        return { status: 503, body: { detail: '이 시점의 혼잡 예측을 낼 수 없습니다.' } };
      },
    },
    {
      why: '학습됨 + 응답에 우리 가게 없음',
      route: (url) => {
        if (url.includes('/predict/model-info')) return { status: 200, body: { trained: true } };
        return {
          status: 200,
          body: { generated_at: new Date(NOW).toISOString(), hours_ahead: 0, predictions: [] },
        };
      },
    },
  ];
  for (const { why, route } of fallbackCases) {
    const net = counter();
    await withFetch(
      (url, init) => {
        net.calls.push(url);
        return route(url, init);
      },
      async () => {
        const result = await fetchFacilityCongestionForecast('f-1', 'restaurant', 6, NOW);
        assertPattern(result, 'restaurant', `${why}: 패턴으로 내려앉지 않았다`);
      },
    );
    if (!why.startsWith('학습됨')) {
      assert.equal(net.count('/predict/batch'), 0, `${why}: 학습 여부를 모르는데 batch 를 보냈다`);
    }
  }

  // model-info 는 4초, batch 는 12초 타임아웃이다(계획 A9). 위 'abort' 케이스는 신호가 있는지만 보므로
  // 여기서 timeoutFetch 가 요청마다 실제로 건 시간을 잰다 — model-info 를 12초 기본값으로 되돌리면 실패한다.
  {
    const delays: number[] = [];
    const armed: { url: string; ms: number }[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      delays.push(Number(ms));
      return realSetTimeout(handler, ms);
    }) as unknown as typeof setTimeout;
    try {
      await withFetch(
        (url, init) => {
          // timeoutFetch 는 타이머를 건 직후 fetch 를 부른다 — 마지막 타이머가 이 요청의 것이다.
          armed.push({ url, ms: delays[delays.length - 1] });
          if (url.includes('/predict/model-info')) return { status: 200, body: { trained: true } };
          const hoursAhead = JSON.parse(String(init?.body ?? '{}')).hours_ahead as number;
          return {
            status: 200,
            body: {
              generated_at: new Date(NOW).toISOString(),
              hours_ahead: hoursAhead,
              predictions: [{ facility_id: 'f-1', predicted_congestion: 0.5, anchored: false, event_boost: 0 }],
            },
          };
        },
        () => fetchFacilityCongestionForecast('f-1', 'restaurant', 6, NOW),
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.deepEqual(
      armed.filter((a) => a.url.includes('/predict/model-info')).map((a) => a.ms),
      [4000],
      'model-info 는 4초 안에 답이 없으면 기다리지 않고 패턴으로 그려야 한다',
    );
    const batchTimeouts = armed.filter((a) => a.url.includes('/predict/batch')).map((a) => a.ms);
    assert.equal(batchTimeouts.length, 7);
    assert.ok(batchTimeouts.every((ms) => ms === 12000), `batch 타임아웃이 12초가 아니다: ${batchTimeouts}`);
  }

  // 한 탭 안에서는 model-info 를 한 번만 묻는다(콘솔 재진입·가게 변경). 답을 못 받았으면 다시 묻는다.
  {
    const net = counter();
    await withFetch(
      (url) => {
        net.calls.push(url);
        if (url.includes('/predict/model-info')) return { status: 200, body: { trained: false } };
        throw new Error(`예상치 못한 요청: ${url}`);
      },
      async () => {
        await fetchFacilityCongestionForecast('f-1', 'restaurant', 6, NOW);
        await fetchFacilityCongestionForecast('f-2', 'cafe', 6, NOW);
      },
    );
    assert.equal(net.count('/predict/model-info'), 1, '같은 탭에서 모델 상태를 또 물었다');

    const retry = counter();
    await withFetch(
      (url) => {
        retry.calls.push(url);
        return { status: 500, body: {} };
      },
      async () => {
        await fetchFacilityCongestionForecast('f-1', 'restaurant', 6, NOW);
        await fetchFacilityCongestionForecast('f-1', 'restaurant', 6, NOW);
      },
    );
    assert.equal(retry.count('/predict/model-info'), 2, '답을 못 받은 결과까지 기억해 다시 묻지 않는다');
  }

  // --- (3) 실제 적용 할인율 안내 ---------------------------------------------

  const overlapped: MerchantTimesaleCreated = {
    id: 'ts-2',
    facility_id: 'f-1',
    rate: 0.15,
    starts_at: '2026-09-06T00:00:00+00:00',
    ends_at: '2026-09-06T01:00:00+00:00',
    canceled_at: null,
    created_at: '2026-09-06T00:00:00+00:00',
    other_active_timesale_count: 1,
    effective_timesale_rate: 0.3,
    effective_timesale_note:
      '이미 진행 중인 타임세일이 1건 있습니다. 추천에는 활성 세일 중 가장 높은 할인율인 30% 가 적용됩니다.',
  };

  assert.equal(
    timesalePublishNotice(overlapped),
    overlapped.effective_timesale_note,
    '서버가 만들어 보낸 실제 적용 할인율 안내를 프런트가 또 버렸다',
  );
  assert.equal(hasTimesaleOverlapNotice(overlapped), true);

  const solo: MerchantTimesaleCreated = {
    ...overlapped,
    other_active_timesale_count: 0,
    effective_timesale_rate: 0.15,
    effective_timesale_note: null,
  };
  assert.equal(
    timesalePublishNotice(solo),
    '지금부터 손님 추천 카드에 할인 배지가 붙어요.',
    '겹치는 세일이 없으면 기본 안내',
  );
  assert.doesNotMatch(timesalePublishNotice(solo), /기본 쿠폰율/, '조건 문장을 매번 반복한다');
  assert.equal(hasTimesaleOverlapNotice(solo), false);

  // 기본 쿠폰율이 고른 할인율 이상이면 배지가 붙지 않는다(merchant_boost: ts_rate > coupon_rate 일 때만).
  // 그때만 그 사실을 말한다 — 기본 안내('배지가 붙어요')는 거짓이 된다.
  assert.equal(
    timesalePublishNotice(solo, 0.15),
    '우리 가게 기본 쿠폰이 15%라 15% 타임세일은 추천 순위에 더해지지 않아요.',
  );
  assert.equal(timesalePublishNotice(solo, 0.1), timesalePublishNotice(solo), '쿠폰율이 낮으면 기본 안내');
  assert.equal(timesalePublishNotice(solo, null), timesalePublishNotice(solo), '쿠폰율을 모르면 기본 안내');
  assert.equal(
    timesalePublishNotice(overlapped, 0.5),
    overlapped.effective_timesale_note,
    '서버의 실제 적용 할인율 안내가 우선이다',
  );

  // 할인율 버튼 아래 힌트 — 쿠폰율이 고른 할인율 이상일 때만.
  assert.equal(timesaleRateHint(null, 0.15), null, '쿠폰율을 모르면 지어내지 않는다');
  assert.equal(timesaleRateHint(0, 0.15), null);
  assert.equal(timesaleRateHint(0.1, 0.15), null);
  assert.equal(
    timesaleRateHint(0.15, 0.15),
    '우리 가게 기본 쿠폰이 15%라 15% 타임세일은 추천 순위에 더해지지 않아요. 더 높은 할인율을 골라 보세요.',
  );
  assert.equal(
    timesaleRateHint(0.3, 0.3),
    '우리 가게 기본 쿠폰이 30%라 30% 타임세일은 추천 순위에 더해지지 않아요.',
    '더 높은 선택지가 없으면 고르라고 권하지 않는다',
  );

  // 발행 확인 단계 — 손님 카드에 실제로 붙을 배지를 말한다. 배지는 활성 세일 중 최댓값이다
  // (merchant_boost). 30% 세일이 진행 중인데 15% 를 고르면 손님은 계속 '⚡ 타임세일 30%' 를 본다.
  assert.deepEqual(timesaleConfirmPreview(null, 0.15, [0.3]), { kind: 'badge', rate: 0.3, ongoing: true });
  assert.deepEqual(timesaleConfirmPreview(0.1, 0.15, [0.3]), { kind: 'badge', rate: 0.3, ongoing: true });
  assert.deepEqual(timesaleConfirmPreview(null, 0.3, [0.15]), { kind: 'badge', rate: 0.3, ongoing: false });
  assert.deepEqual(timesaleConfirmPreview(0.1, 0.2, [0.2]), { kind: 'badge', rate: 0.2, ongoing: false });
  assert.deepEqual(timesaleConfirmPreview(0.1, 0.15), { kind: 'badge', rate: 0.15, ongoing: false });
  // 기본 쿠폰에 묻히면 사실 한 줄만 — '이대로 발행할까요?' 앞에서 다른 할인율을 권하지 않는다.
  const buried = timesaleConfirmPreview(0.2, 0.2, []);
  assert.deepEqual(buried, {
    kind: 'baseCoupon',
    text: '우리 가게 기본 쿠폰이 20%라 20% 타임세일은 추천 순위에 더해지지 않아요.',
  });
  assert.doesNotMatch(JSON.stringify(buried), /골라 보세요/, '확인 단계가 발행과 다른 할인율 고르기를 한 번에 권한다');

  // 서버가 활성 세일 조회에 실패해 세 필드가 전부 null 인 경우 — 없는 안내를 지어내지 않는다.
  const unknownRates: MerchantTimesaleCreated = {
    ...overlapped,
    other_active_timesale_count: null,
    effective_timesale_rate: null,
    effective_timesale_note: null,
  };
  assert.equal(hasTimesaleOverlapNotice(unknownRates), false);
  assert.equal(hasTimesaleOverlapNotice(null), false, '응답이 비어도 터지지 않아야 한다');

  // --- (5) 예측 섹션 안내 문구는 '실제로 보여주는 것' 만 말한다 ------------------

  assert.equal(
    forecastNote({ curveShown: false, basis: 'pattern', anchored: false }),
    '앞으로 6시간 동안 우리 가게가 얼마나 붐빌지 보여 드려요.',
  );
  // 곡선이 없으면 basis·anchored 에 흔들리지 않는다.
  assert.equal(
    forecastNote({ curveShown: false, basis: 'model', anchored: true }),
    forecastNote({ curveShown: false, basis: 'pattern', anchored: false }),
  );
  assert.equal(
    forecastNote({ curveShown: true, basis: 'model', anchored: true }),
    '우리 가게 최근 혼잡을 반영한 앞으로 6시간 예상이에요.',
  );
  assert.equal(
    forecastNote({ curveShown: true, basis: 'model', anchored: false }),
    '같은 업종 가게들의 시간대 흐름으로 본 앞으로 6시간 예상이에요.',
  );
  assert.equal(
    forecastNote({ curveShown: true, basis: 'pattern', anchored: false }),
    '같은 업종 가게들의 요일·시간대 흐름으로 본 앞으로 6시간 예상이에요.',
  );
  for (const basis of ['model', 'pattern'] as const) {
    for (const anchored of [true, false]) {
      for (const curveShown of [true, false]) {
        assert.doesNotMatch(
          forecastNote({ curveShown, basis, anchored }),
          /앵커링|실측/,
          '사장님 화면에 내부 용어가 나간다',
        );
      }
    }
  }

  // --- 화면 배선 가드 ---------------------------------------------------------

  // 콘솔 구현은 2026-09-21 에 라우트(app/merchant/dashboard/page.tsx)에서 컴포넌트로 옮겼다 —
  // `/merchant` 와 `/merchant/dashboard`, 그리고 `?demo=1` 데모가 같은 화면을 공유해야 해서다
  // (Next 라우트 파일은 default 외 export 를 못 한다). 가드는 구현 파일을 따라간다.
  const dashboardSrc = readFileSync(join(WEB, 'components', 'merchant', 'MerchantConsole.tsx'), 'utf8');
  const gateSrc = readFileSync(join(WEB, 'app', 'merchant', 'page.tsx'), 'utf8');

  assert.match(dashboardSrc, /timesalePublishNotice\(/, '대시보드가 실제 적용 할인율 안내를 쓰지 않는다');
  assert.match(dashboardSrc, /forecastNote\(/, '대시보드가 예측 안내 문구를 직접 지어내고 있다');
  assert.doesNotMatch(
    dashboardSrc,
    /유형 평균 곡선/,
    '예측 실패 상태에서도 폴백 곡선을 약속하는 옛 문구가 남아 있다',
  );
  // ① 은 항상 그린다(2026-10-06 A9) — 미학습이면 업종 패턴 곡선. 섹션을 통째로 숨기던 분기가 돌아오면
  // 심사위원이 보는 사장님 콘솔이 다시 '② 성적표' 로 시작한다.
  assert.doesNotMatch(dashboardSrc, /permanentFailure\) return null/, '① 예상 혼잡을 숨기는 분기가 되살아났다');
  assert.match(
    dashboardSrc,
    /fetchFacilityCongestionForecast\(facilityId, facilityType/,
    '① 에 가게 업종이 전달되지 않는다',
  );
  assert.match(dashboardSrc, /bestQuietHour\(/, "'가장 한가한 시간' 콜아웃이 배선되지 않았다");
  assert.match(dashboardSrc, /merchant-timesale/, "콜아웃의 '타임세일 열기' 가 갈 곳이 없다");
  assert.doesNotMatch(
    dashboardSrc,
    /모델 상태:/,
    '예측 실패 안내에 내부 모델 상태 값(raw enum)이 그대로 노출된다',
  );
  assert.doesNotMatch(
    dashboardSrc,
    /submitWarning/,
    '관측 기록이 안 남은 것을 실패처럼 경고하던 옛 상태가 남아 있다',
  );
  // 개발자 사과·면책 문구 — 사장님 화면에 내부 사정을 늘어놓지 않는다(2026-10-06 A9).
  assert.doesNotMatch(
    dashboardSrc,
    /서버가 계산한 예측값|예측 학습에도|visit_confirmations_note|<DemoBadge/,
    '사장님 콘솔에 개발자용 안내·면책 문구나 떠다니는 데모 배지가 남아 있다',
  );
  assert.match(dashboardSrc, /timesaleRateHint\(/, '기본 쿠폰율 조건 안내가 조건부로 배선되지 않았다');
  // 확인 단계는 활성 세일까지 넣어 배지를 미리 보이고, 버튼 아래 힌트는 그동안 감춘다(같은 문장 두 번 금지).
  assert.match(
    dashboardSrc,
    /timesaleConfirmPreview\(baseCouponRate, publishConfirm\.rate, activeSales\.map/,
    '확인 단계 배지 미리보기가 진행 중인 세일을 보지 않는다',
  );
  assert.doesNotMatch(
    dashboardSrc,
    /timesaleRateHint\(baseCouponRate, publishConfirm/,
    "확인 단계가 '더 높은 할인율을 골라 보세요' 힌트를 또 보인다",
  );
  assert.match(dashboardSrc, /rateHint && !publishConfirm/, '확인 단계가 열려도 버튼 아래 힌트가 남아 같은 문장이 두 번 보인다');
  assert.doesNotMatch(
    dashboardSrc,
    /할인율이 기본 쿠폰율보다 높으면/,
    '조건 문장이 발행할 때마다 무조건 반복된다',
  );
  assert.equal(
    (dashboardSrc.match(/t\('demo\.badgeShort'\)/g) ?? []).length,
    1,
    "'예시 화면' 칩은 머리글에 한 개여야 한다(데모 카드 배지는 오늘/최근 7일)",
  );

  // ① 차트의 Y축 — 폭이 좁으면 맨 위 눈금 '100%' 가 '00%' 로 잘린다(2026-10-06 감사).
  const forecastAxis = (dashboardSrc.match(/<YAxis\b[\s\S]*?\/>/g) ?? []).find((block) =>
    block.includes('domain={[0, 100]}'),
  );
  assert.ok(forecastAxis, '① 차트의 YAxis(0~100%) 를 찾지 못했다');
  const axisWidth = Number(/width=\{(\d+)\}/.exec(forecastAxis)?.[1] ?? 0);
  assert.ok(axisWidth >= 48, `① 차트 YAxis 폭 ${axisWidth} < 48 — '100%' 가 잘린다`);
  assert.doesNotMatch(dashboardSrc, /left: -\d+/, '차트 왼쪽 여백이 음수라 축 글자가 잘린다');

  assert.match(gateSrc, /setFailed\(true\)/, '개발자 가게 피커가 조회 실패를 구분하지 않는다');
  assert.match(gateSrc, /t\('common\.error'\)/, "조회 실패에 '결과 없음' 이 아닌 별도 문구가 없다");
  assert.match(gateSrc, /t\('merchantGate\.developerEmpty'\)/, "'결과 없음' 문구가 사라졌다");

  console.log('lib/merchant/api.test.ts ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
