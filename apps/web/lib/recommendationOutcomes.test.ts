import assert from 'node:assert/strict';
import { flushRecommendationOutcomes, isPermanentFailure } from './recommendationOutcomes';
import { apiClient, AuthError, HttpError, ServiceUnavailableError, httpStatus } from './api-client';

// 이 판정이 없으면 영구 실패 하나가 큐 맨 앞에 앉아 그 뒤 전부를 영영 막는다 —
// 단계 순서를 지키려고 실패 지점 이후를 통째로 되돌려 넣기 때문이다.

// ── httpStatus — 상태 코드를 잃지 않는가 ──────────────────────────────────
assert.equal(httpStatus(new HttpError('gone', 404)), 404);
assert.equal(httpStatus(new AuthError()), 401);
assert.equal(httpStatus(new ServiceUnavailableError()), 503);
// 상태가 없는 실패(네트워크 단절·abort·문자열 throw)는 undefined 여야 한다.
assert.equal(httpStatus(new Error('Failed to fetch')), undefined);
assert.equal(httpStatus('boom'), undefined);
assert.equal(httpStatus(null), undefined);

// ── 영구 실패 — 버린다 ────────────────────────────────────────────────────
// 409 = 서버가 단계 순서로 거절(앞 단계가 서버에 없음 · 이미 기록됨). 큐 안 순서는 queuedAt 이 지키므로 이 409 는
// 다시 보내도 같다 — 남기면 큐 맨 앞에서 그 뒤 기록을 7일 동안 막는다(아래 flush (3) 이 잠근다).
for (const status of [400, 403, 404, 409, 410, 422]) {
  assert.equal(isPermanentFailure(new HttpError('nope', status)), true, `${status} 가 재시도 대상이 됐다`);
}

// ── 일시적 실패 — 남긴다 ──────────────────────────────────────────────────
// 401 은 세션이 아직 안 붙었을 뿐이다(익명 세션 부트스트랩 레이스). 버리면 텔레메트리가 사라진다.
assert.equal(isPermanentFailure(new AuthError()), false, '401 을 버리면 세션 붙기 전 기록이 사라진다');
assert.equal(isPermanentFailure(new ServiceUnavailableError()), false);
for (const status of [408, 429, 500, 502, 504]) {
  assert.equal(isPermanentFailure(new HttpError('later', status)), false, `${status} 를 버렸다`);
}

// 상태를 모르는 실패는 일시적으로 본다 — 모르면 재시도하는 쪽이 안전하다.
assert.equal(isPermanentFailure(new Error('Failed to fetch')), false);
assert.equal(isPermanentFailure(undefined), false);

console.log('recommendationOutcomes tests passed');


// ── flush — 7일 컷오프가 **실제로** 버리는가 ───────────────────────────────
//
// 이 파일은 오랫동안 isPermanentFailure 만 검사했다. 그래서 컷오프가 아무것도 버리지 않는
// 결함이 오래 살아남았다: 되쓰기 단계에서 만료 항목이 '그 사이 새로 들어온 것' 으로 오인돼
// 그대로 복원됐다. 위 409 주석("안 되면 7일 컷오프가 걷어낸다")이 기대는 안전망이
// 존재하지 않았던 것이다. 그래서 여기서 flush 를 실제로 돌린다.
//
// 잔류가 무해하지도 않다 — queueRecommendationOutcome 은 같은 (recommendationId, stage) 키를
// 덮어쓸 때 옛 queuedAt 을 유지하므로, 만료 항목이 남으면 같은 키의 **새 기록이 낡은 시각을
// 물려받아 한 번도 전송되지 않고 묻힌다.**

const QUEUE_KEY = 'nextspot_recommendation_outcome_queue';
const DAY = 24 * 60 * 60 * 1000;

function installBrowser(): void {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
  (globalThis as Record<string, unknown>).localStorage = localStorage;
  (globalThis as Record<string, unknown>).window = { localStorage };
}

function seed(items: unknown[]): void {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
}

function queued(): Array<{ recommendationId: string; stage: string; queuedAt: number }> {
  return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
}

installBrowser();

const REC_OLD = '11111111-1111-4111-8111-111111111111';
const REC_NEW = '22222222-2222-4222-8222-222222222222';

void (async () => {
  const sent: string[] = [];
  // 전송은 전부 성공시킨다 — 여기서 보려는 것은 '남는 것' 이지 재시도 규칙이 아니다.
  (apiClient as unknown as { patch: (p: string, b?: unknown) => Promise<unknown> }).patch =
    async (path: string) => { sent.push(path); return {}; };

  // (1) 만료 항목은 전송되지도, 되쓰이지도 않는다.
  seed([
    { recommendationId: REC_OLD, stage: 'navigation_started', queuedAt: Date.now() - 30 * DAY },
    { recommendationId: REC_NEW, stage: 'navigation_started', queuedAt: Date.now() - 60_000 },
  ]);
  await flushRecommendationOutcomes();

  assert.deepEqual(
    sent.map((p) => p.split('/')[4]),
    [REC_NEW],
    '만료된 항목을 전송했거나 새 항목을 빠뜨렸다',
  );
  assert.deepEqual(
    queued().map((i) => i.recommendationId),
    [],
    '7일 컷오프가 아무것도 버리지 않았다 — 만료 항목이 되쓰기에서 복원됐다',
  );

  // (2) 컷오프 안쪽 항목은 전송 뒤 사라지고, 그 사이 들어온 새 항목은 살아남는다
  //     (되쓰기 병합 자체는 그대로 동작해야 한다 — 컷오프를 걸다 이것까지 죽이면 안 된다).
  sent.length = 0;
  let injected = false;
  (apiClient as unknown as { patch: (p: string, b?: unknown) => Promise<unknown> }).patch =
    async (path: string) => {
      sent.push(path);
      if (!injected) {
        injected = true;
        // 네트워크를 기다리는 사이 사용자가 평가를 남긴 상황.
        seed([...queued(), { recommendationId: REC_NEW, stage: 'rated', queuedAt: Date.now() }]);
      }
      return {};
    };
  seed([{ recommendationId: REC_NEW, stage: 'navigation_started', queuedAt: Date.now() - 60_000 }]);
  await flushRecommendationOutcomes();

  assert.deepEqual(
    queued().map((i) => i.stage),
    ['rated'],
    '전송 도중 들어온 기록이 되쓰기에서 사라졌다',
  );

  // (3) 409(단계 순서 거절)는 그 항목만 버리고 뒤 기록은 그대로 보낸다 — 큐를 막지 않는다.
  //     길안내 시작을 기록하지 않던 화면에서 수락한 추천의 '도착 확인' 이 맨 앞에 선 상황이다.
  sent.length = 0;
  const REC_ORPHAN = '33333333-3333-4333-8333-333333333333';
  (apiClient as unknown as { patch: (p: string, b?: unknown) => Promise<unknown> }).patch =
    async (path: string) => {
      sent.push(path);
      if (path.includes(REC_ORPHAN)) throw new HttpError('방문 결과 단계 순서가 올바르지 않습니다.', 409);
      return {};
    };
  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...args: unknown[]) => { warned.push(args); };
  try {
    seed([
      { recommendationId: REC_ORPHAN, stage: 'arrival_confirmed', queuedAt: Date.now() - 120_000 },
      { recommendationId: REC_NEW, stage: 'navigation_started', queuedAt: Date.now() - 60_000 },
      { recommendationId: REC_NEW, stage: 'arrival_confirmed', queuedAt: Date.now() - 30_000 },
    ]);
    await flushRecommendationOutcomes();
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(
    sent.map((p) => p.split('/')[4]),
    [REC_ORPHAN, REC_NEW, REC_NEW],
    '409 항목 뒤의 기록이 전송되지 않았다 — 큐가 막혔다',
  );
  assert.deepEqual(queued(), [], '409 항목이 큐에 남았다 — 다음 회차에도 맨 앞에서 막는다');
  assert.equal(warned.length, 1, '버린 항목을 로그로 남기지 않았다');

  console.log('recommendationOutcomes flush tests passed');
})();

