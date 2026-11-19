import assert from 'node:assert/strict';

import { REGION } from '@/lib/region';

import {
  assertableCongestionLevel,
  buildFallbackReason,
  clampToRegion,
  fetchAlternatives,
  headerTitleSpec,
  initialCoords,
  isSyntheticRecommendationId,
  kakaoDetailsUrl,
  loadAlternativesFlow,
  needsHoursCheck,
  originPillTone,
  typeLabelKey,
  type FetchDeps,
} from './logic';

const t = (key: string, vars?: Record<string, string | number>) => `${key}|${JSON.stringify(vars ?? {})}`;

// 합성 id
assert.equal(isSyntheticRecommendationId('mock-1'), true);
assert.equal(isSyntheticRecommendationId('7f3a'), false);

// 사유 폴백
assert.match(buildFallbackReason(t, 'A', null, 100, null), /fallbackTravelOnly/);
assert.match(buildFallbackReason(t, 'A', 4.6, 100, null), /fallbackWithWait.*"wait":5/);
assert.match(buildFallbackReason(t, 'A', null, 100, 0.2), /fallbackMeasured/);

// 혼잡 주장 — 기준선 예측은 주장하지 않는다
assert.equal(assertableCongestionLevel({ congestionLevel: 0.9, congestionSource: 'measured' }), 0.9);
assert.equal(
  assertableCongestionLevel({ congestionLevel: 0.9, congestionSource: 'predicted', congestionPredictionBasis: 'industry_baseline' }),
  null,
);
assert.equal(
  assertableCongestionLevel({ congestionLevel: 0.6, congestionSource: 'predicted', congestionPredictionBasis: 'model' }),
  0.6,
);
assert.equal(assertableCongestionLevel({ congestionLevel: null, congestionSource: 'none' }), null);

// 영업시간 확인
const fac = (type: string, features: Record<string, unknown> | null = null, address: string | null = null) => ({
  id: 'x', name: '가게', type, features, address,
});
assert.equal(needsHoursCheck({ openStatusAtArrival: 'needs_confirmation', facility: fac('cafe') }), true);
assert.equal(needsHoursCheck({ openStatusAtArrival: 'needs_confirmation', facility: fac('attraction') }), false);
assert.equal(needsHoursCheck({ openStatusAtArrival: 'open_expected', facility: fac('cafe') }), false);

// 카카오 상세 주소
assert.equal(
  kakaoDetailsUrl({ facility: fac('cafe', { kakaoPlaceUrl: 'http://place.map.kakao.com/123' }) }),
  'https://place.map.kakao.com/123',
);
assert.equal(kakaoDetailsUrl({ facility: fac('cafe', { kakao_place_id: '77' }) }), 'https://place.map.kakao.com/77');
assert.equal(
  kakaoDetailsUrl({ facility: fac('cafe', null, '경북 경주시') }),
  `https://map.kakao.com/?q=${encodeURIComponent('가게 경북 경주시')}`,
);
assert.equal(kakaoDetailsUrl({ facility: fac('cafe') }), `https://map.kakao.com/?q=${encodeURIComponent('가게 경주')}`);

// 위치
const inside = clampToRegion(REGION.center.lat, REGION.center.lng);
assert.equal(inside.moved, false);
const outside = clampToRegion(37.5, 127.0);
assert.deepEqual(outside, { lat: REGION.center.lat, lng: REGION.center.lng, moved: true });
assert.deepEqual(initialCoords({ lat: 35.83, lng: 129.21 }), { lat: 35.83, lng: 129.21 });
assert.deepEqual(initialCoords({ lat: null, lng: null }), { lat: REGION.center.lat, lng: REGION.center.lng });

// 머리글
assert.deepEqual(headerTitleSpec({ originName: null, noAlternatives: false, walkFromPlace: false, loading: true, count: 0 }), {
  key: 'recommend.heroTitle',
});
assert.deepEqual(headerTitleSpec({ originName: 'A', noAlternatives: true, walkFromPlace: true, loading: false, count: 0 }), {
  key: 'literal',
  text: 'A',
});
assert.equal(
  headerTitleSpec({ originName: 'A', noAlternatives: false, walkFromPlace: true, loading: false, count: 3 }).key,
  'recommend.headerFrom',
);
assert.equal(
  headerTitleSpec({ originName: 'A', noAlternatives: false, walkFromPlace: false, loading: false, count: 3 }).key,
  'recommend.headerInstead',
);
assert.equal(
  headerTitleSpec({ originName: 'A', noAlternatives: false, walkFromPlace: false, loading: true, count: 3 }).key,
  'recommend.headerInsteadPending',
);
assert.equal(originPillTone({ key: 'busy', estimated: false }), 'busy');
assert.equal(originPillTone({ key: 'relaxed', estimated: true }), 'calm');
assert.equal(originPillTone({ key: 'moderate', estimated: false }), null);
assert.equal(originPillTone(null), null);
assert.equal(typeLabelKey('cafe'), 'category.cafe');
assert.equal(typeLabelKey('parking'), 'course.typeFallback');

// 대안 조회 흐름
type Call = string;
function makeDeps(script: {
  typed?: unknown[] | Error;
  untyped?: unknown[] | Error | Array<unknown[] | Error>;
  byType?: unknown[] | Error;
  timeout?: boolean;
}): { deps: FetchDeps<string>; calls: Call[] } {
  const calls: Call[] = [];
  const untypedQueue = Array.isArray(script.untyped) && script.untyped.length > 0 && (Array.isArray(script.untyped[0]) || script.untyped[0] instanceof Error)
    ? [...(script.untyped as Array<unknown[] | Error>)]
    : [script.untyped ?? []];
  const settle = <T,>(v: unknown): Promise<T> => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v as T));
  const deps: FetchDeps<string> = {
    getRecommendations: (types) => {
      if (types.length > 0) {
        calls.push('typed');
        return settle(script.typed ?? []);
      }
      calls.push('untyped');
      const next = untypedQueue.length > 1 ? untypedQueue.shift() : untypedQueue[0];
      return settle(next);
    },
    byType: () => {
      calls.push('byType');
      return settle(script.byType ?? []);
    },
    isTimeout: () => script.timeout === true,
    sleep: async () => {
      calls.push('sleep');
    },
    cancelled: () => false,
  };
  return { deps, calls };
}
const run = async () => {
  const dbOrigin = { facilityId: 'f1', name: '', type: 'cafe' };
  const namedOrigin = { facilityId: '', name: '새 카페', type: 'cafe' };
  const noType = { facilityId: 'f1', name: '', type: null };

  // 같은 종류가 있으면 그것만
  let m = makeDeps({ typed: ['a'] });
  assert.deepEqual(await fetchAlternatives(m.deps, dbOrigin), ['a']);
  assert.deepEqual(m.calls, ['typed']);
  // 같은 종류가 비면 종류 없이 한 번 더
  m = makeDeps({ typed: [], untyped: ['b'] });
  assert.deepEqual(await fetchAlternatives(m.deps, dbOrigin), ['b']);
  assert.deepEqual(m.calls, ['typed', 'untyped']);
  // 종류를 모르면 곧장 종류 없이
  m = makeDeps({ untyped: ['c'] });
  assert.deepEqual(await fetchAlternatives(m.deps, noType), ['c']);
  assert.deepEqual(m.calls, ['untyped']);
  // DB 에 없는 장소는 처음부터 by-type
  m = makeDeps({ byType: ['d'] });
  assert.deepEqual(await fetchAlternatives(m.deps, namedOrigin), ['d']);
  assert.deepEqual(m.calls, ['byType']);

  // 흐름: 성공
  m = makeDeps({ typed: ['a'] });
  assert.deepEqual(await loadAlternativesFlow(m.deps, dbOrigin), ['a']);

  // 흐름: 시간 초과 → 같은 요청 재전송 없이 by-type
  m = makeDeps({ typed: new Error('timeout'), timeout: true, byType: ['t'] });
  assert.deepEqual(await loadAlternativesFlow(m.deps, dbOrigin), ['t']);
  assert.deepEqual(m.calls, ['typed', 'byType']);

  // 흐름: 일반 실패 → 2.5초 뒤 재시도 성공
  let n = 0;
  m = makeDeps({ byType: ['z'] });
  const flaky: FetchDeps<string> = {
    ...m.deps,
    getRecommendations: async () => {
      n += 1;
      if (n === 1) throw new Error('boom');
      return ['ok'];
    },
  };
  assert.deepEqual(await loadAlternativesFlow(flaky, noType), ['ok']);
  assert.deepEqual(m.calls, ['sleep']);

  // 흐름: 두 번 실패 → by-type
  m = makeDeps({ untyped: new Error('x'), byType: ['bt'] });
  assert.deepEqual(await loadAlternativesFlow(m.deps, noType), ['bt']);
  assert.deepEqual(m.calls, ['untyped', 'sleep', 'untyped', 'byType']);

  // 흐름: by-type 까지 실패하면 throw(화면이 loadFailed)
  m = makeDeps({ untyped: new Error('x'), byType: new Error('y') });
  await assert.rejects(() => loadAlternativesFlow(m.deps, noType), /y/);

  // 흐름: 개인화가 비면 by-type 한 번 더, 그것도 실패하면 빈 결과
  m = makeDeps({ untyped: [], byType: ['rescue'] });
  assert.deepEqual(await loadAlternativesFlow(m.deps, noType), ['rescue']);
  m = makeDeps({ untyped: [], byType: new Error('no') });
  assert.deepEqual(await loadAlternativesFlow(m.deps, noType), []);
  // 이미 by-type 으로 물었으면 같은 질문을 되풀이하지 않는다
  m = makeDeps({ byType: [] });
  assert.deepEqual(await loadAlternativesFlow(m.deps, namedOrigin), []);
  assert.deepEqual(m.calls, ['byType']);

  // 흐름: 취소되면 null
  m = makeDeps({ typed: ['a'] });
  let calls = 0;
  const cancelling: FetchDeps<string> = { ...m.deps, cancelled: () => ++calls > 0 };
  assert.equal(await loadAlternativesFlow(cancelling, dbOrigin), null);

  console.log('logic.test.ts ok');
};
void run();
