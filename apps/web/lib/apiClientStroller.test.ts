// 유모차 조건의 배포 시차 가드(postWithTravelContext, P1-6). 옛 API 의 422 에는 'stroller' 만 빼고 한 번 다시 묻는다.
// 그 재시도가 일시 오류(503·타임아웃·취소)로 끝나면 **그 오류를** 던진다 — 처음 422 로 덮으면 호출부의 503 재시도
// (getRecommendations)가 돌지 않고, 취소도 진짜 실패처럼 보인다(라운드 3 검증).
import assert from 'node:assert/strict';
import { apiClient, HttpError, RequestTimeoutError, ServiceUnavailableError, httpStatus, postWithTravelContext } from './api-client';
import { resetStrollerSupportForTest, serverSkipsStroller } from './strollerSupport';

type Post = (path: string, body?: unknown, options?: unknown) => Promise<unknown>;
type Step = { ok: unknown } | { fail: unknown };

const sent: unknown[] = [];
function mockPost(...steps: Step[]): void {
  let call = 0;
  (apiClient as unknown as { post: Post }).post = async (_path, body) => {
    sent.push((body as { context?: { requiredAttributes?: unknown } } | undefined)?.context?.requiredAttributes);
    const step = steps[Math.min(call++, steps.length - 1)];
    if ('fail' in step) throw step.fail;
    return step.ok;
  };
}
function fresh(): void {
  resetStrollerSupportForTest();
  sent.length = 0;
}

const PATH = '/api/v1/recommendations/by-type';
const withStroller = { userId: 'u', context: { categories: [], requiredAttributes: ['indoor', 'stroller'] } };
const rejected = new HttpError('Input should be indoor or accessible', 422);

void (async () => {
  // (1) 422 → 'stroller' 만 빼고 한 번 → 통하면 결과를 돌려주고 이 세션에 표시한다.
  fresh();
  mockPost({ fail: rejected }, { ok: ['ok'] });
  assert.deepEqual(await postWithTravelContext<string[]>(PATH, withStroller), { data: ['ok'], strollerDropped: true });
  assert.deepEqual(sent, [['indoor', 'stroller'], ['indoor']], '유모차만 빼고 다시 묻는다');
  assert.equal(serverSkipsStroller(), true);

  // (2) 표시된 세션은 처음부터 빼고 묻는다(다시 422 를 받지 않는다).
  sent.length = 0;
  mockPost({ ok: ['again'] });
  assert.deepEqual(await postWithTravelContext<string[]>(PATH, withStroller), { data: ['again'], strollerDropped: true });
  assert.deepEqual(sent, [['indoor']]);

  // (3) 빼고 보내도 422 — 원인이 유모차가 아니었다. 처음 오류를 그대로 두고 표시하지 않는다.
  fresh();
  mockPost({ fail: rejected }, { fail: new HttpError('other field', 422) });
  await assert.rejects(postWithTravelContext(PATH, withStroller), (err) => err === rejected);
  assert.equal(serverSkipsStroller(), false, '유모차 탓이 아닌 422 로 세션을 표시했다');

  // (4) 재시도가 503 — 처음 422 로 덮지 않고 503 을 던진다(호출부의 503 재시도가 돌 수 있게). 표시는 하지 않는다.
  fresh();
  const unavailable = new ServiceUnavailableError();
  mockPost({ fail: rejected }, { fail: unavailable });
  await assert.rejects(postWithTravelContext(PATH, withStroller), (err) => err === unavailable && httpStatus(err) === 503);
  assert.equal(serverSkipsStroller(), false, '빼면 통하는지 모르는데 세션을 표시했다');

  // (5) 재시도가 타임아웃·취소 — 그 오류 그대로(취소를 422 실패로 바꾸지 않는다).
  fresh();
  const timeout = new RequestTimeoutError();
  mockPost({ fail: rejected }, { fail: timeout });
  await assert.rejects(postWithTravelContext(PATH, withStroller), (err) => err === timeout);
  const abort = new DOMException('aborted', 'AbortError');
  mockPost({ fail: rejected }, { fail: abort });
  await assert.rejects(postWithTravelContext(PATH, withStroller), (err) => err === abort);
  assert.equal(serverSkipsStroller(), false);

  // (6) 유모차를 묻지 않은 요청의 422 는 다시 보내지 않는다.
  fresh();
  mockPost({ fail: rejected }, { ok: ['never'] });
  await assert.rejects(
    postWithTravelContext(PATH, { userId: 'u', context: { categories: [], requiredAttributes: ['indoor'] } }),
    (err) => err === rejected,
  );
  assert.equal(sent.length, 1);

  console.log('api-client stroller retry tests passed');
})();
