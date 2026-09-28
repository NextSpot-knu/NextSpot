// 권역 수요 전망 곡선 — **모르는 시각을 채우지 않는다**가 이 파일의 주제다.
// available:false 인 시각을 0 으로 채우면 /waiting 의 '한산해지는 시각'이 거짓으로 당겨진다
// (docs/CONGESTION_DATA.md §2 원칙 6).
// 두 번째 주제: 서버 창(지금+30분~6시간) 밖을 묻지 않는다 — 분 30 이후엔 다음 정시가 창 밖이라
// 예전에는 곡선을 받아 놓고 쓰지 못했다(도착 정시의 키가 비었다).
// tsx 는 cjs 로 변환하므로 최상위 await 를 쓸 수 없다 — main() 으로 감싸고 실패는 종료코드로 알린다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiClient } from './api-client';
import { curveForBase, fetchAreaDemandCurve, forecastArrivalTimes, mergeAreaCurve } from './areaDemandCurve';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** 2026-09-21(월) KST hh:mm:ss.ms 의 UTC ms. */
const kst = (h: number, m = 0, s = 0, ms = 0) => Date.UTC(2026, 8, 21, h, m, s, ms) - KST_OFFSET_MS;
/** KST 12:10 → 서버를 훑는 정시는 KST 13~18 시다. */
const BASE_AT = new Date(kst(12, 10));
const NOW = BASE_AT.getTime();

type Opts = { params?: Record<string, string>; noRetry?: boolean; timeoutMs?: number; signal?: AbortSignal };
type GetFn = (path: string, options?: Opts) => Promise<unknown>;
const realGet = apiClient.get;
const patch = (fn: GetFn) => {
  (apiClient as { get: GetFn }).get = fn;
};

/** 요청의 arrivalAt 과 그 KST 시 — 응답을 시각별로 갈라 주기 위해. */
const arrivalMs = (options?: Opts) => new Date(String(options?.params?.arrivalAt)).getTime();
const hourOf = (options?: Opts) => new Date(arrivalMs(options) + KST_OFFSET_MS).getUTCHours();
const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  // --- 표본이 있는 시각만 곡선에 들어간다 ---------------------------------------
  {
    const calls: string[] = [];
    patch(async (path, options) => {
      calls.push(path);
      const hour = hourOf(options);
      if (hour === 15) return { available: true, forecast: { level: 0.42 } };
      if (hour === 16) return { available: false, forecast: null }; // 표본 부족 — 0 으로 채우면 안 된다
      if (hour === 17) return { available: true, forecast: { level: null } }; // 값 없음
      if (hour === 18) throw new Error('503'); // 일시 장애 — 이 시각만 비우고 계속
      return { available: true, forecast: { level: hour === 13 ? 1.7 : -0.3 } }; // 범위 밖 → 클램프
    });
    const curve = await fetchAreaDemandCurve(35.83, 129.21, BASE_AT, undefined, NOW);
    assert.deepEqual(curve, { 13: 1, 14: 0, 15: 0.42 }, '표본 없는 시각이 곡선에 들어갔거나 0~1 클램프가 빠졌다');
    assert.ok(!(16 in curve) && !(17 in curve) && !(18 in curve), '모르는 시각을 0 으로 채웠다');
    assert.equal(calls.length, 6, '도착 30분~6시간 창의 정시 6개를 훑어야 한다');
    assert.ok(calls.every((p) => p === '/api/v1/area-demand/forecast'));
  }

  // --- 분 ≥ 30: 첫 정시를 창 안으로 당긴다(예전에는 422 로 빠졌다) ------------------
  {
    const now = kst(12, 45);
    const got: Array<{ hour: number; at: number }> = [];
    patch(async (_path, options) => {
      got.push({ hour: hourOf(options), at: arrivalMs(options) });
      return { available: true, forecast: { level: 0.5 } };
    });
    const curve = await fetchAreaDemandCurve(35.83, 129.21, new Date(now), undefined, now);
    assert.deepEqual(Object.keys(curve).map(Number).sort((a, b) => a - b), [13, 14, 15, 16, 17, 18]);
    const first = got.find((g) => g.hour === 13);
    assert.equal(first?.at, kst(13, 17), '13시는 지금+32분(13:17)에 물어야 한다');
    for (const h of [14, 15, 16, 17, 18]) assert.ok(got.some((g) => g.at === kst(h)), `${h}시는 정시에 묻는다`);
    for (const g of got) {
      assert.ok(g.at >= now + 32 * MIN && g.at <= now + 6 * HOUR - 2 * MIN, '서버 창 밖을 물었다');
    }
  }

  // --- 정시 딱 12:00:00.000 → 13…18, 18시는 17:58 에 --------------------------------
  {
    const now = kst(12, 0, 0, 0);
    const pts = forecastArrivalTimes(new Date(now), now);
    assert.deepEqual(pts.map((p) => p.hourKst), [13, 14, 15, 16, 17, 18]);
    assert.equal(pts[5].at.getTime(), kst(17, 58));
  }

  // --- 분 59 → 14…19(13:31 은 14시로 반올림되므로 13 은 묻지 않는다) ----------------
  {
    const now = kst(12, 59);
    assert.deepEqual(forecastArrivalTimes(new Date(now), now).map((p) => p.hourKst), [14, 15, 16, 17, 18, 19]);
  }

  // --- 먼 프리셋은 아무것도 묻지 않는다 --------------------------------------------
  {
    let hits = 0;
    patch(async () => {
      hits += 1;
      return { available: true, forecast: { level: 0.5 } };
    });
    const curve = await fetchAreaDemandCurve(35.83, 129.21, new Date(NOW + 3 * 24 * HOUR), undefined, NOW);
    assert.deepEqual(curve, {});
    assert.equal(hits, 0, '서버 창 밖 프리셋에 422 가 확실한 요청을 보냈다');
  }

  // --- 창 안 프리셋은 그 정시부터 묻는다(15:00 프리셋을 12:10 에 열면 15…18) ---------
  assert.deepEqual(forecastArrivalTimes(new Date(kst(15)), kst(12, 10)).map((p) => p.hourKst), [15, 16, 17, 18]);

  // --- 표: 'now' 모드는 몇 분이든 6점, 13시는 분 57까지, 당긴 시각은 30분 미만 이동 ----
  for (const m of [0, 10, 28, 29, 30, 45, 57, 58, 59]) {
    const now = kst(12, m);
    const pts = forecastArrivalTimes(new Date(now), now);
    assert.equal(pts.length, 6, `분 ${m}: 6점이어야 한다`);
    assert.equal(pts.some((p) => p.hourKst === 13), m <= 57, `분 ${m}: 13시 포함 여부가 틀렸다`);
    for (const p of pts) {
      const t = p.at.getTime();
      assert.ok(t >= now + 32 * MIN && t <= now + 6 * HOUR - 2 * MIN, `분 ${m}: 창 밖`);
      const hourStart = kst(p.hourKst);
      assert.ok(Math.abs(t - hourStart) < 30 * MIN, `분 ${m}: ${p.hourKst}시를 30분 이상 옮겨 물었다`);
    }
  }

  // --- 선행 1회 뒤 최대 3개 동시 -----------------------------------------------------
  {
    const pending: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let total = 0;
    patch(
      () =>
        new Promise((resolve) => {
          total += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          pending.push(() => {
            inFlight -= 1;
            resolve({ available: true, forecast: { level: 0.3 } });
          });
        }),
    );
    const p = fetchAreaDemandCurve(35.83, 129.21, BASE_AT, undefined, NOW);
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(inFlight, 1, '선행 요청이 끝나기 전에 다른 요청이 나갔다');
    pending.shift()!();
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(inFlight, 3, '선행 뒤에는 3개가 함께 나가야 한다');
    while (pending.length) {
      pending.shift()!();
      for (let i = 0; i < 3; i++) await tick();
    }
    const curve = await p;
    assert.equal(total, 6);
    assert.ok(maxInFlight <= 3, `동시 요청이 3개를 넘었다: ${maxInFlight}`);
    assert.equal(Object.keys(curve).length, 6);
  }

  // --- 모든 요청이 noRetry·8초 --------------------------------------------------------
  {
    const seen: Opts[] = [];
    patch(async (_path, options) => {
      seen.push(options ?? {});
      return { available: false };
    });
    await fetchAreaDemandCurve(35.83, 129.21, BASE_AT, undefined, NOW);
    assert.equal(seen.length, 6);
    for (const o of seen) {
      assert.equal(o.noRetry, true, '전망 요청이 전송 계층 재시도를 쓴다');
      assert.equal(o.timeoutMs, 8000);
    }
  }

  // --- 선행 중 취소되면 새 요청을 시작하지 않는다 ------------------------------------
  {
    let hits = 0;
    let releaseLead: () => void = () => {};
    patch(
      () =>
        new Promise((resolve) => {
          hits += 1;
          releaseLead = () => resolve({ available: true, forecast: { level: 0.2 } });
        }),
    );
    const controller = new AbortController();
    const p = fetchAreaDemandCurve(35.83, 129.21, BASE_AT, controller.signal, NOW);
    await tick();
    controller.abort();
    releaseLead();
    const curve = await p;
    assert.equal(hits, 1, '취소 뒤에 새 요청을 시작했다');
    assert.deepEqual(curve, { 13: 0.2 }, '이미 받은 부분 곡선은 돌려준다');
  }

  // --- 전부 실패해도 빈 곡선으로 끝난다(호출부는 내장 곡선으로 계속 동작) ---------
  patch(async () => {
    throw new Error('down');
  });
  assert.deepEqual(await fetchAreaDemandCurve(35.83, 129.21, BASE_AT, undefined, NOW), {});

  // --- 이미 취소된 요청은 한 번도 호출하지 않는다 --------------------------------
  {
    let hits = 0;
    patch(async () => {
      hits += 1;
      return { available: true, forecast: { level: 0.5 } };
    });
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await fetchAreaDemandCurve(35.83, 129.21, BASE_AT, controller.signal, NOW), {});
    assert.equal(hits, 0, '취소된 뒤에도 네트워크를 쳤다');
  }

  // --- curveForBase: 다른 기준 시각의 곡선은 절대 쓰지 않는다 ----------------------
  {
    const nowCurve = { 13: 0.4 };
    const curves = { now: nowCurve, '1790000000000': {} };
    assert.equal(curveForBase(curves, '1791000000000'), null, '다른 기준 시각의 곡선을 빌려 썼다');
    assert.equal(curveForBase(curves, '1790000000000'), null, '빈 곡선은 null');
    assert.equal(curveForBase(curves, 'now'), nowCurve);
    assert.equal(curveForBase({}, 'toString'), null);
  }

  // --- 선행이 전망을 못 돌려주면(실패·시간 초과·미가용) 나머지는 하나씩 ------------
  // 선행이 캐시를 데우지 못했는데 3개를 동시에 보내면, 서버에서 각 요청이 차가운 백테스트를 기다리며
  // 스레드를 하나씩 붙든다(관광객 Supabase 호출과 같은 스레드 풀).
  for (const lead of ['throw', 'unavailable'] as const) {
    let inFlight = 0;
    let maxInFlight = 0;
    let total = 0;
    patch(async (_path, options) => {
      total += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight -= 1;
      if (hourOf(options) === 13) {
        if (lead === 'throw') throw new Error('요청 시간이 초과되었습니다');
        return { available: false, forecast: null };
      }
      return { available: true, forecast: { level: 0.4 } };
    });
    const curve = await fetchAreaDemandCurve(35.83, 129.21, BASE_AT, undefined, NOW);
    assert.equal(maxInFlight, 1, `선행이 ${lead} 인데 나머지를 동시에 보냈다`);
    assert.equal(total, 6, `선행이 ${lead} 여도 나머지 시각은 묻는다`);
    assert.deepEqual(Object.keys(curve).map(Number).sort((a, b) => a - b), [14, 15, 16, 17, 18]);
  }

  // --- 선행이 전망을 돌려주면 그때만 3개 동시 ---------------------------------------
  {
    let inFlight = 0;
    let maxInFlight = 0;
    patch(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight -= 1;
      return { available: true, forecast: { level: 0.4 } };
    });
    await fetchAreaDemandCurve(35.83, 129.21, BASE_AT, undefined, NOW);
    assert.equal(maxInFlight, 3, '데워진 뒤에는 3개가 함께 나가야 한다');
  }

  // --- mergeAreaCurve: 빈 재조회가 좋은 곡선을 지우지 않는다 ------------------------
  {
    const good = { 13: 0.4, 14: 0.5 };
    const prev = { now: good, '1790000000000': { 15: 0.2 } };
    assert.equal(mergeAreaCurve(prev, 'now', {}), prev, '빈 재조회가 같은 기준의 곡선을 지웠다');
    assert.equal(curveForBase(mergeAreaCurve(prev, 'now', {}), 'now'), good);
    const fresh = { 13: 0.1 };
    const replaced = mergeAreaCurve(prev, 'now', fresh);
    assert.equal(replaced.now, fresh, '새 곡선이 들어가지 않았다');
    assert.equal(replaced['1790000000000'], prev['1790000000000'], '다른 기준의 곡선을 건드렸다');
    assert.notEqual(replaced, prev, '상태 갱신은 새 객체여야 한다');
    // 처음 보는 기준의 빈 결과는 '알고 보니 없음' 으로 기록하고, 오늘 곡선을 빌려 쓰지 않는다.
    const empty = mergeAreaCurve(prev, '1791000000000', {});
    assert.deepEqual(empty['1791000000000'], {});
    assert.equal(curveForBase(empty, '1791000000000'), null, '다른 기준(오늘) 곡선이 새 기준에 쓰였다');
    // 프로토타입 키는 '이미 있음' 이 아니다.
    assert.deepEqual(mergeAreaCurve({}, 'toString', {}), { toString: {} });
  }

  // --- 화면 배선 가드 (병합·기준 격리·프리셋 읽은 뒤 조회) --------------------------
  {
    const src = readFileSync(join(WEB, 'app', 'waiting', 'page.tsx'), 'utf8');
    assert.match(src, /const areaCurve = curveForBase\(areaCurves, baseKey\);/, '/waiting 이 지금 기준의 곡선만 쓰지 않는다');
    assert.match(src, /setAreaCurves\(\(prev\) => mergeAreaCurve\(prev, baseKey, curve\)\)/, '/waiting 이 곡선 병합 헬퍼를 쓰지 않는다');
    assert.doesNotMatch(src, /\{\s*\.\.\.prev,\s*\[baseKey\]:\s*curve\s*\}/, '/waiting 에 조건 없는 곡선 덮어쓰기가 있다');
    assert.match(src, /if \(!presetHydrated\) return;/, '/waiting 이 저장된 프리셋을 읽기 전에 곡선을 묻는다');
  }

  // --- 화면 배선 가드 --------------------------------------------------------------
  const waitingSrc = readFileSync(join(WEB, 'app', 'waiting', 'page.tsx'), 'utf8');
  assert.match(waitingSrc, /curveForBase\(/, '/waiting 이 기준 시각별 곡선을 쓰지 않는다(다른 요일 곡선이 섞인다)');
  assert.doesNotMatch(waitingSrc, /setAreaCurve\(/, '/waiting 에 기준 시각을 모르는 단일 곡선 상태가 남아 있다');
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
