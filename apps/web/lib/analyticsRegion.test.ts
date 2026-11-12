import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_REGION_ID, setActiveRegion } from './regionRuntime';

// 내부 검증 지역을 보는 동안 분석 이벤트(analytics.track → /events/track)와 이용 기록(usageEvents.trackEvent →
// usage_events)은 아무것도 보내지 않는다. /events/track 은 인증이 없어 서버가 내부 계정을 걸러 낼 수 없기 때문이다.
// 경주에서는 지역 기능 전과 똑같이 보낸다.

const beacons: string[] = [];
const fetches: string[] = [];
const storageWrites: string[] = [];
const timers: number[] = [];

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storageWrites.push(k);
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
  };
}

// 운영 주소에서 사람이 쓰는 브라우저처럼 꾸민다(usageEvents.shouldRecord 의 조건).
const fakeWindow = {
  location: { hostname: 'nextspot-nu.vercel.app', pathname: '/main' },
  localStorage: memoryStorage(),
  sessionStorage: memoryStorage(),
  addEventListener: () => {},
};
Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'navigator', {
  value: {
    webdriver: false,
    doNotTrack: null,
    sendBeacon: (url: string) => {
      beacons.push(url);
      return true;
    },
  },
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, 'document', {
  value: { documentElement: { lang: 'ko' } },
  configurable: true,
  writable: true,
});
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown) => {
  fetches.push(String(url));
  return new Response('{}', { status: 200 });
}) as typeof fetch;
// usageEvents 는 2초 뒤에 모아 보낸다 — 타이머를 잡아 두고 실제로 보내지는 않는다(외부 호출 없음).
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((_fn: () => void, ms?: number) => {
  timers.push(ms ?? 0);
  return 0 as unknown as ReturnType<typeof setTimeout>;
}) as unknown as typeof setTimeout;

function reset() {
  beacons.length = 0;
  fetches.length = 0;
  storageWrites.length = 0;
  timers.length = 0;
}

void (async () => {
  const { track } = await import('./analytics');
  const { trackEvent } = await import('./usageEvents');
  try {
    // ── 내부 지역: 아무것도 보내지 않고, 저장소·타이머도 건드리지 않는다 ──
    setActiveRegion('testbed');
    reset();
    track('recommendation_compared', { count: 2 });
    track('navigation_started', { facility_type: 'cafe' });
    assert.deepEqual(beacons, [], '내부 지역에서 분석 이벤트를 보냈다');
    assert.deepEqual(fetches, [], '내부 지역에서 분석 이벤트를 보냈다(fetch)');
    trackEvent('page_view');
    trackEvent('rec_shown', { rank: 1 });
    assert.deepEqual(storageWrites, [], '내부 지역에서 익명 번호를 만들었다');
    assert.deepEqual(timers, [], '내부 지역에서 이용 기록을 모았다');

    // ── 경주: 지역 기능 전과 같다 ──
    setActiveRegion(PUBLIC_REGION_ID);
    reset();
    track('recommendation_compared', { count: 2 });
    assert.equal(beacons.length, 1, '경주에서 분석 이벤트가 나가지 않는다');
    assert.ok(beacons[0].endsWith('/api/v1/events/track'));
    trackEvent('page_view');
    assert.ok(storageWrites.includes('nextspot_anon_id'), '경주에서 이용 기록이 모이지 않는다');
    assert.deepEqual(timers, [2000], '경주에서 이용 기록 전송이 예약되지 않는다');

    // 다시 내부 지역 — 이미 모인 경주 기록 외에 새로 모으지 않는다.
    setActiveRegion('testbed');
    reset();
    trackEvent('rec_accept');
    track('trip_resumed', { facility_type: 'cafe' });
    assert.deepEqual([beacons, fetches, storageWrites, timers], [[], [], [], []]);
  } finally {
    setActiveRegion(PUBLIC_REGION_ID);
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
  console.log('analyticsRegion tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// 공유 유입 계측 두 곳(/explore/recommend 의 share_visit · /course 의 course_share_visit)은 analytics.track 을 거치지 않고
// apiClient 로 직접 보낸다(경주 요청을 오늘과 같게 두려고). 그래서 같은 지역 규칙을 그 자리에서 건다 — 빠지면 내부 지역의
// 방문이 운영 분석에 섞인다.
{
  const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
  for (const [rel, cond] of [
    ['explore/recommend/page.tsx', 'searchParams.get("ref") === "share" && isPublicRegion(getActiveRegion())'],
    ['course/page.tsx', 'searchParams.get("s") && isPublicRegion(getActiveRegion())'],
  ] as const) {
    const src = readFileSync(join(appDir, rel), 'utf8');
    assert.ok(src.includes(cond), `${rel}: 공유 유입 계측이 지역 규칙 없이 나간다`);
  }
  console.log('share-visit region gate wiring passed');
}
