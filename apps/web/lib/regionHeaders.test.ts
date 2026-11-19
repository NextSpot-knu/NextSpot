import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGION_HEADER, regionRequestHeaders } from './regionHeaders';
import { getActiveRegion, isPublicRegion, PUBLIC_REGION_ID, setActiveRegion } from './regionRuntime';

// 경주 요청은 오늘과 같아야 한다 — 지역 헤더가 하나도 붙지 않는다.
assert.deepEqual(regionRequestHeaders('gyeongju'), {});
assert.deepEqual(regionRequestHeaders(PUBLIC_REGION_ID), {});
assert.deepEqual(regionRequestHeaders(null), {});
assert.deepEqual(regionRequestHeaders(undefined), {});
assert.deepEqual(regionRequestHeaders(''), {});

// 내부 지역은 서버가 준 id 를 그대로 싣는다(서버가 DB 역할로 다시 판정한다).
assert.equal(REGION_HEADER, 'X-NextSpot-Region');
assert.deepEqual(regionRequestHeaders('testbed'), { 'X-NextSpot-Region': 'testbed' });

// 형식이 틀린 값은 헤더로 만들지 않는다.
for (const bad of ['Testbed', ' testbed', 'test bed', 'a\r\nX-Evil: 1', 'x'.repeat(40), '1abc']) {
  assert.deepEqual(regionRequestHeaders(bad), {}, JSON.stringify(bad));
}

// 런타임 상태 — 기본은 공개 지역, 빈 값은 공개 지역으로 돌아간다.
assert.equal(getActiveRegion(), PUBLIC_REGION_ID);
setActiveRegion('testbed');
assert.equal(getActiveRegion(), 'testbed');
assert.equal(isPublicRegion(getActiveRegion()), false);
setActiveRegion('');
assert.equal(getActiveRegion(), PUBLIC_REGION_ID);
setActiveRegion(null);
assert.equal(getActiveRegion(), PUBLIC_REGION_ID);
assert.equal(isPublicRegion(undefined), true);

// 배선: request() 가 지역 헤더를 이 함수로만 합친다(직접 헤더 이름을 쓰지 않는다).
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'api-client.ts'), 'utf8');
// 호출부가 지역을 주면(저장해 둔 기록의 지역) 그 값, 아니면 지금 지역.
assert.match(src, /regionRequestHeaders\(options\.region \?\? getActiveRegion\(\)\)/, 'request() 가 지역 헤더를 합치지 않는다');
assert.ok(!src.includes('X-NextSpot-Region'), 'api-client 가 지역 헤더를 직접 만든다 — regionHeaders 를 거칠 것');
// 데모 프리페치는 경주에서만.
assert.match(
  src,
  /export function prefetchDemoHotPaths\(\): void \{\s*(?:\/\/[^\n]*\n\s*)*if \(!isPublicRegion\(getActiveRegion\(\)\)\) return;/,
  '내부 지역에서 경주 데모 프리페치가 돈다',
);

console.log('regionHeaders tests passed');

// 실제 request() 로 확인 — 경주는 지역 헤더가 없고, 내부 지역만 붙는다.
void (async () => {
  const { apiClient } = await import('./api-client');
  const seen: Headers[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    setActiveRegion(PUBLIC_REGION_ID);
    await apiClient.get('/api/v1/freshness');
    setActiveRegion('testbed');
    await apiClient.get('/api/v1/freshness');
    setActiveRegion(PUBLIC_REGION_ID);
    await apiClient.get('/api/v1/freshness');
    // 요청의 지역을 따로 주면 지금 지역과 상관없이 그 지역으로 간다(방문 결과 큐 — 기록한 때의 지역).
    setActiveRegion(PUBLIC_REGION_ID);
    await apiClient.get('/api/v1/freshness', { region: 'testbed' });
    setActiveRegion('testbed');
    await apiClient.get('/api/v1/freshness', { region: PUBLIC_REGION_ID });
  } finally {
    globalThis.fetch = realFetch;
    setActiveRegion(PUBLIC_REGION_ID);
  }
  assert.equal(seen.length, 5);
  assert.equal(seen[3].get(REGION_HEADER), 'testbed', '요청에 준 지역이 헤더로 가지 않았다');
  assert.equal(seen[4].has(REGION_HEADER), false, '경주로 준 요청에 지금 지역(내부) 헤더가 붙었다');
  assert.equal(seen[0].has(REGION_HEADER), false, '경주 요청에 지역 헤더가 붙었다');
  assert.equal(seen[1].get(REGION_HEADER), 'testbed');
  assert.equal(seen[2].has(REGION_HEADER), false, '경주로 돌아온 뒤에도 지역 헤더가 남았다');
  // 경주 요청의 헤더 집합은 지역 기능 전과 같다(Content-Type 만 — 테스트 환경에는 세션이 없다).
  assert.deepEqual([...seen[0].keys()].sort(), ['content-type']);
  console.log('regionHeaders request() wiring passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
