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
  MerchantApiError,
  MerchantForecastUnavailableError,
  fetchFacilityCongestionForecast,
  forecastHonestNote,
  hasTimesaleOverlapNotice,
  timesalePublishNotice,
  type MerchantTimesaleCreated,
} from './api';

// 러너가 cwd 를 apps/web 으로 고정한다(직접 실행할 때도 apps/web 에서 돈다).
const WEB = process.cwd();

// --- fetch 스텁 ------------------------------------------------------------
// api.ts 의 예측 경로는 전역 fetch 만 쓴다(Supabase 는 끼어들지 않는다).

type Route = (url: string) => { status: number; body: unknown } | 'network-error';

function withFetch<T>(route: Route, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const result = route(url);
    if (result === 'network-error') throw new TypeError('fetch failed');
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

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

async function main() {
  // --- (2) 예측 실패: 서버가 준 사유를 살려 '재시도 무의미' 를 판정한다 -------------

  // 배포 환경의 상시 상태 재현: 모델 미학습 → /predict/batch 는 항상 503.
  await withFetch(
    (url) => {
      if (url.includes('/predict/batch')) {
        return { status: 503, body: { detail: '검증된 혼잡 예측 모델이 없습니다.' } };
      }
      if (url.includes('/predict/model-info')) {
        return { status: 200, body: { trained: false, fallback_state: 'degraded_rules' } };
      }
      throw new Error(`예상치 못한 요청: ${url}`);
    },
    async () => {
      const error = await rejection(fetchFacilityCongestionForecast('f-1', 2));
      assert.ok(error instanceof MerchantForecastUnavailableError, '영구 실패로 승격되지 않았다');
      assert.equal(error.retryable, false, '눌러도 소용없는 실패에 재시도를 권하면 안 된다');
      assert.equal(error.reason, 'model_not_trained');
      assert.equal(error.modelState, 'degraded_rules', '서버가 준 모델 상태를 버렸다');
      assert.match(error.message, /검증된 혼잡 예측 모델이 없습니다/, '서버 사유가 뭉개졌다');
    },
  );

  // 같은 503 이라도 모델이 학습돼 있으면 일시적 실패다 — 그때는 재시도를 권해야 한다.
  await withFetch(
    (url) => {
      if (url.includes('/predict/batch')) {
        return { status: 503, body: { detail: '이 시점의 혼잡 예측을 낼 수 없습니다.' } };
      }
      if (url.includes('/predict/model-info')) {
        return { status: 200, body: { trained: true, fallback_state: null } };
      }
      throw new Error(`예상치 못한 요청: ${url}`);
    },
    async () => {
      const error = await rejection(fetchFacilityCongestionForecast('f-1', 1));
      assert.ok(error instanceof MerchantApiError);
      assert.ok(
        !(error instanceof MerchantForecastUnavailableError),
        '일시 장애를 영구 실패로 오판했다',
      );
      assert.equal(error.retryable, true);
      assert.match(error.message, /이 시점의 혼잡 예측을 낼 수 없습니다/);
    },
  );

  // model-info 조차 못 물어보면 '모른다' 로 둔다 — 지어내서 영구 실패로 단정하지 않는다.
  await withFetch(
    (url) => {
      if (url.includes('/predict/batch')) return { status: 503, body: { detail: '예측 불가' } };
      return 'network-error';
    },
    async () => {
      const error = await rejection(fetchFacilityCongestionForecast('f-1', 1));
      assert.ok(error instanceof MerchantApiError);
      assert.equal(error.retryable, true, '판정 불가를 영구 실패로 단정하면 안 된다');
    },
  );

  // 네트워크 자체가 죽은 경우는 그대로 재시도 가능한 실패다.
  await withFetch(
    () => 'network-error',
    async () => {
      const error = await rejection(fetchFacilityCongestionForecast('f-1', 1));
      assert.ok(error instanceof MerchantApiError);
      assert.equal(error.retryable, true);
      assert.equal(error.status, undefined);
    },
  );

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
  assert.match(timesalePublishNotice(solo), /추천 랭킹 인센티브/, '겹치는 세일이 없으면 기본 안내');
  assert.equal(hasTimesaleOverlapNotice(solo), false);

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

  const noCurve = forecastHonestNote({ curveShown: false, anchored: false });
  assert.doesNotMatch(noCurve, /곡선/, '곡선을 하나도 못 그리는데 곡선을 약속했다');
  assert.doesNotMatch(noCurve, /유형/, '없는 폴백(유형 곡선)을 제공하는 것처럼 말했다');
  assert.match(noCurve, /예측치/, '이 값이 무엇인지는 여전히 말해야 한다');

  // 실패했을 때도(곡선 없음) 같은 문장이어야 한다 — anchored 값에 흔들리면 안 된다.
  assert.equal(forecastHonestNote({ curveShown: false, anchored: true }), noCurve);

  const typeCurve = forecastHonestNote({ curveShown: true, anchored: false });
  assert.match(typeCurve, /유형/, '유형 수준 곡선을 그리고 있으면 그렇다고 말해야 한다');

  const anchoredCurve = forecastHonestNote({ curveShown: true, anchored: true });
  assert.match(anchoredCurve, /앵커링/);
  assert.notEqual(anchoredCurve, typeCurve);

  // --- 화면 배선 가드 ---------------------------------------------------------

  const dashboardSrc = readFileSync(join(WEB, 'app', 'merchant', 'dashboard', 'page.tsx'), 'utf8');
  const gateSrc = readFileSync(join(WEB, 'app', 'merchant', 'page.tsx'), 'utf8');

  assert.match(dashboardSrc, /timesalePublishNotice\(/, '대시보드가 실제 적용 할인율 안내를 쓰지 않는다');
  assert.match(dashboardSrc, /forecastHonestNote\(/, '대시보드가 예측 안내 문구를 직접 지어내고 있다');
  assert.doesNotMatch(
    dashboardSrc,
    /유형 평균 곡선/,
    '예측 실패 상태에서도 폴백 곡선을 약속하는 옛 문구가 남아 있다',
  );
  assert.match(dashboardSrc, /permanentFailure/, '예측 영구 실패에 재시도를 권하지 않는 분기가 사라졌다');
  assert.match(
    dashboardSrc,
    /observation_logged === false/,
    '좌석 방송의 부분 실패(관측 기록 누락)를 화면이 삼키고 있다',
  );

  assert.match(gateSrc, /setFailed\(true\)/, '개발자 가게 피커가 조회 실패를 구분하지 않는다');
  assert.match(gateSrc, /t\('common\.error'\)/, "조회 실패에 '결과 없음' 이 아닌 별도 문구가 없다");
  assert.match(gateSrc, /t\('merchantGate\.developerEmpty'\)/, "'결과 없음' 문구가 사라졌다");

  console.log('lib/merchant/api.test.ts ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
