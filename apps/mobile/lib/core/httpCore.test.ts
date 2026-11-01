import assert from 'node:assert/strict';

import {
  AuthError,
  CLIENT_HEADER,
  HttpError,
  RequestTimeoutError,
  ServiceUnavailableError,
  buildRequestHeaders,
  buildUrl,
  clientPlatformFrom,
  createRequester,
  errorMessageFrom,
  httpStatus,
  isAbortError,
  isAuthError,
  isRequestTimeout,
  isServiceUnavailable,
  serializeBody,
  type RequesterDeps,
} from './httpCore';

type Call = { url: string; init: RequestInit };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

function makeRequester(
  handler: (call: Call, attempt: number) => Promise<Response>,
  overrides: Partial<RequesterDeps> = {},
) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const request = createRequester({
    baseUrl: 'https://api.test',
    fetch: (url, init) => {
      const call = { url, init };
      calls.push(call);
      return handler(call, calls.length);
    },
    getAccessToken: async () => 'tok',
    platform: 'android',
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0,
    ...overrides,
  });
  return { request, calls, sleeps };
}

async function main() {
  // ── 헤더 ──
  {
    const h = buildRequestHeaders({ 'X-Extra': '1' }, 'abc', 'ios');
    assert.equal(h.get('Content-Type'), 'application/json');
    assert.equal(h.get('Authorization'), 'Bearer abc');
    assert.equal(h.get('X-Supabase-Authorization'), 'Bearer abc');
    assert.equal(h.get(CLIENT_HEADER), 'ios');
    assert.equal(h.get('X-Extra'), '1');
    assert.equal(h.get('X-NextSpot-Region'), null, '앱은 지역 헤더를 싣지 않는다');

    const anon = buildRequestHeaders(undefined, null, 'android');
    assert.equal(anon.get('Authorization'), null);
    assert.equal(anon.get('X-Supabase-Authorization'), null);
    assert.equal(anon.get(CLIENT_HEADER), 'android');

    assert.equal(buildRequestHeaders(undefined, 't', null).get(CLIENT_HEADER), null);
    assert.equal(clientPlatformFrom('ios'), 'ios');
    assert.equal(clientPlatformFrom('android'), 'android');
    assert.equal(clientPlatformFrom('web'), null);
    assert.equal(clientPlatformFrom(undefined), null);
  }

  // ── URL·본문 변환 ──
  {
    assert.equal(buildUrl('https://a', '/x'), 'https://a/x');
    assert.equal(buildUrl('https://a', '/x', { userLat: '1', limit: '3' }), 'https://a/x?user_lat=1&limit=3');
    assert.equal(serializeBody({ userId: 'u', nested: { facilityType: 'cafe' }, list: [{ aB: 1 }] }),
      JSON.stringify({ user_id: 'u', nested: { facility_type: 'cafe' }, list: [{ a_b: 1 }] }));
    const params = new URLSearchParams('a=1');
    assert.equal(serializeBody(params), params, 'BodyInit 은 그대로');
    assert.equal(serializeBody(undefined), undefined);
  }

  // ── 성공: 요청은 snake, 응답은 camel, 헤더 실림 ──
  {
    const { request, calls } = makeRequester(async () => jsonResponse(200, { recommendation_id: 'r', nested_list: [{ spot_score: 1 }] }));
    const data = await request('/api/v1/x', { method: 'POST', body: { userId: 'u' }, params: { pageSize: '2' } });
    assert.deepEqual(data, { recommendationId: 'r', nestedList: [{ spotScore: 1 }] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.test/api/v1/x?page_size=2');
    assert.equal(calls[0].init.body, JSON.stringify({ user_id: 'u' }));
    assert.equal(calls[0].init.method, 'POST');
    const headers = calls[0].init.headers as Headers;
    assert.equal(headers.get('Authorization'), 'Bearer tok');
    assert.equal(headers.get(CLIENT_HEADER), 'android');
    assert.ok(!('params' in calls[0].init) && !('timeoutMs' in calls[0].init), 'fetch 에 내부 옵션을 넘기지 않는다');
  }

  // ── 응답 전 네트워크 실패만 한 번 다시 보낸다(지터 포함 700ms) ──
  {
    const { request, calls, sleeps } = makeRequester(async (_c, attempt) => {
      if (attempt === 1) throw new TypeError('Network request failed');
      return jsonResponse(200, { ok_value: 1 });
    });
    assert.deepEqual(await request('/r'), { okValue: 1 });
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [700]);
  }
  {
    const { request, calls } = makeRequester(async () => { throw new TypeError('Network request failed'); });
    await assert.rejects(request('/r'), (err: unknown) => err instanceof TypeError);
    assert.equal(calls.length, 2, '최대 2번(1 + 재시도 1)');
  }
  {
    const { request, calls } = makeRequester(async () => { throw new TypeError('offline'); });
    await assert.rejects(request('/r', { noRetry: true }), TypeError);
    assert.equal(calls.length, 1, 'noRetry 면 다시 보내지 않는다');
  }

  // ── 응답을 받았으면 상태와 무관하게 다시 보내지 않는다 + 분류 ──
  for (const [status, check] of [
    [401, (e: unknown) => e instanceof AuthError && isAuthError(e) && httpStatus(e) === 401],
    [503, (e: unknown) => e instanceof ServiceUnavailableError && isServiceUnavailable(e)],
    [429, (e: unknown) => e instanceof HttpError && httpStatus(e) === 429],
    [422, (e: unknown) => e instanceof HttpError && (e as Error).message === 'bad field'],
  ] as const) {
    const body = status === 422 ? { detail: [{ loc: ['x'], msg: 'bad field' }] } : { detail: 'nope' };
    const { request, calls } = makeRequester(async () => jsonResponse(status, body));
    await assert.rejects(request('/r'), check as (e: unknown) => boolean);
    assert.equal(calls.length, 1, `${status} 는 재시도하지 않는다`);
  }

  // ── 타임아웃 → RequestTimeoutError(재시도 없음) ──
  {
    const { request, calls } = makeRequester((call) => new Promise<Response>((_resolve, reject) => {
      call.init.signal?.addEventListener('abort', () => reject(abortError()));
    }));
    await assert.rejects(request('/slow', { timeoutMs: 20 }), (err: unknown) => isRequestTimeout(err) && err instanceof RequestTimeoutError);
    assert.equal(calls.length, 1);
  }

  // ── 호출자 취소 → 원래 AbortError 그대로(타임아웃으로 바꾸지 않는다) ──
  {
    const controller = new AbortController();
    const { request } = makeRequester((call) => new Promise<Response>((_resolve, reject) => {
      call.init.signal?.addEventListener('abort', () => reject(abortError()));
      setTimeout(() => controller.abort(), 5);
    }));
    await assert.rejects(request('/x', { signal: controller.signal, timeoutMs: 5000 }), (err: unknown) => isAbortError(err) && !isRequestTimeout(err));
  }

  // ── 토큰이 없으면 인증 헤더 없음 ──
  {
    const { request, calls } = makeRequester(async () => jsonResponse(200, {}), { getAccessToken: async () => null, platform: 'ios' });
    await request('/x');
    const headers = calls[0].init.headers as Headers;
    assert.equal(headers.get('Authorization'), null);
    assert.equal(headers.get(CLIENT_HEADER), 'ios');
  }

  // ── 보조 판정 ──
  assert.equal(errorMessageFrom(null, 500), 'HTTP error! status: 500');
  assert.equal(errorMessageFrom({ detail: '' }, 404), 'HTTP error! status: 404');
  assert.equal(isAbortError({ name: 'AbortError' }), true);
  assert.equal(isAbortError(new Error('x')), false);
  assert.equal(isAuthError({ status: 401 }), true);
  assert.equal(httpStatus('x'), undefined);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
