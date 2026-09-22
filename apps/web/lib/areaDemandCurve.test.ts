// 권역 수요 전망 곡선 — **모르는 시각을 채우지 않는다**가 이 파일의 주제다.
// available:false 인 시각을 0 으로 채우면 /waiting 의 '한산해지는 시각'이 거짓으로 당겨진다
// (docs/CONGESTION_DATA.md §2 원칙 6).
// tsx 는 cjs 로 변환하므로 최상위 await 를 쓸 수 없다 — main() 으로 감싸고 실패는 종료코드로 알린다.
import assert from 'node:assert/strict';
import { apiClient } from './api-client';
import { fetchAreaDemandCurve } from './areaDemandCurve';

// KST 12:00 → 서버를 훑는 정시는 KST 13~18 시다.
const BASE_AT = new Date('2026-09-21T03:00:00Z');
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

type GetFn = (path: string, options?: { params?: Record<string, string> }) => Promise<unknown>;
const realGet = apiClient.get;
const patch = (fn: GetFn) => {
  (apiClient as { get: GetFn }).get = fn;
};

/** 요청의 arrivalAt 에서 KST 정시를 뽑는다 — 응답을 시각별로 갈라 주기 위해. */
const hourOf = (options?: { params?: Record<string, string> }) =>
  new Date(new Date(String(options?.params?.arrivalAt)).getTime() + KST_OFFSET_MS).getUTCHours();

async function main() {
  const calls: string[] = [];

  // --- 표본이 있는 시각만 곡선에 들어간다 ---------------------------------------
  patch(async (path, options) => {
    calls.push(path);
    const hour = hourOf(options);
    if (hour === 15) return { available: true, forecast: { level: 0.42 } };
    if (hour === 16) return { available: false, forecast: null }; // 표본 부족 — 0 으로 채우면 안 된다
    if (hour === 17) return { available: true, forecast: { level: null } }; // 값 없음
    if (hour === 18) throw new Error('503'); // 일시 장애 — 이 시각만 비우고 계속
    return { available: true, forecast: { level: hour === 13 ? 1.7 : -0.3 } }; // 범위 밖 → 클램프
  });

  const curve = await fetchAreaDemandCurve(35.83, 129.21, BASE_AT);
  assert.deepEqual(
    curve,
    { 13: 1, 14: 0, 15: 0.42 },
    '표본 없는 시각이 곡선에 들어갔거나 0~1 클램프가 빠졌다',
  );
  assert.ok(!(16 in curve) && !(17 in curve) && !(18 in curve), '모르는 시각을 0 으로 채웠다');
  assert.equal(calls.length, 6, '도착 30분~6시간 창의 정시 6개를 훑어야 한다');
  assert.ok(calls.every((p) => p === '/api/v1/area-demand/forecast'));

  // --- 전부 실패해도 빈 곡선으로 끝난다(호출부는 내장 곡선으로 계속 동작) ---------
  patch(async () => {
    throw new Error('down');
  });
  assert.deepEqual(await fetchAreaDemandCurve(35.83, 129.21, BASE_AT), {});

  // --- 이미 취소된 요청은 한 번도 호출하지 않는다 --------------------------------
  let hits = 0;
  patch(async () => {
    hits += 1;
    return { available: true, forecast: { level: 0.5 } };
  });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await fetchAreaDemandCurve(35.83, 129.21, BASE_AT, controller.signal), {});
  assert.equal(hits, 0, '취소된 뒤에도 네트워크를 쳤다');
}

main()
  .then(() => console.log('areaDemandCurve tests passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    (apiClient as { get: GetFn }).get = realGet as GetFn;
  });
