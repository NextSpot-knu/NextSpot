import assert from 'node:assert/strict';

import { fitRegion, kakaoLevelOf, regionForKakaoLevel } from './geometry';
import {
  clampKakaoLevel,
  createKakaoLoader,
  kakaoAppKey,
  kakaoCameraForBand,
  kakaoCameraForFit,
  kakaoCameraForRegion,
  kakaoSdkUrl,
  needsLevelChange,
  overlayAnchor,
  parseCssColor,
  type KakaoLoaderDeps,
  type KakaoMapsNamespace,
} from './kakaoWeb';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

// ── 키 · 주소 ──
assert.equal(kakaoAppKey(undefined), null);
assert.equal(kakaoAppKey(null), null);
assert.equal(kakaoAppKey(''), null);
assert.equal(kakaoAppKey('   '), null);
assert.equal(kakaoAppKey(' abc '), 'abc');
assert.equal(
  kakaoSdkUrl('k1'),
  'https://dapi.kakao.com/v2/maps/sdk.js?appkey=k1&autoload=false&libraries=services,clusterer',
);
assert.ok(kakaoSdkUrl('a&b').includes('appkey=a%26b&'), '키는 주소에 인코딩해 넣는다');

// ── 색 ──
assert.deepEqual(parseCssColor('#c19a3e'), { color: '#c19a3e', opacity: 1 });
assert.deepEqual(parseCssColor('#FFF'), { color: '#ffffff', opacity: 1 });
assert.deepEqual(parseCssColor('transparent'), { color: '#000000', opacity: 0 });
{
  const c = parseCssColor('rgba(193,85,59,0.18)');
  assert.equal(c.color, '#c1553b');
  close(c.opacity, 0.18);
  const d = parseCssColor('rgb(255, 0, 16)');
  assert.deepEqual(d, { color: '#ff0010', opacity: 1 });
  const e = parseCssColor('#11223380');
  assert.equal(e.color, '#112233');
  close(e.opacity, 0x80 / 255);
  const f = parseCssColor('rgba(0 0 0 / 50%)');
  assert.equal(f.color, '#000000');
  close(f.opacity, 0.5);
}
assert.deepEqual(parseCssColor('red'), { color: 'red', opacity: 1 }, '모르는 형식은 그대로');

// ── level ──
assert.equal(clampKakaoLevel(0), 1);
assert.equal(clampKakaoLevel(20), 14);
assert.equal(clampKakaoLevel(3.6), 4);
assert.equal(clampKakaoLevel(Number.NaN), 14);

// 첫 영역: 화면이 regionForKakaoLevel(가운데, L) 로 만든 영역은 상자 크기와 상관없이 level L 로 읽는다.
{
  const center = { latitude: 35.836, longitude: 129.21 };
  for (const lv of [3, 4, 6]) {
    const cam = kakaoCameraForRegion(regionForKakaoLevel(center, lv));
    assert.equal(cam.level, lv);
    assert.deepEqual(cam.center, center);
  }
}

// 영역 맞춤: 정수 level, 연속 level 보다 넓거나 같고(다 들어온다), 하한을 지킨다.
{
  const size = { width: 390, height: 720 };
  const pad = { top: 80, right: 40, bottom: 40, left: 40 };
  const coords = [
    { latitude: 35.8351, longitude: 129.2105 },
    { latitude: 35.8402, longitude: 129.2189 },
    { latitude: 35.8299, longitude: 129.2240 },
  ];
  const cam = kakaoCameraForFit(coords, size, pad, { minLevel: 4 });
  assert.ok(cam);
  assert.equal(Number.isInteger(cam!.level), true);
  const loose = fitRegion(coords, size, pad, { minLevel: 4 })!;
  const cont = kakaoLevelOf(loose, size);
  assert.ok(cam!.level >= cont - 1e-6 && cam!.level < cont + 1, `level ${cam!.level} vs ${cont}`);
  // 정수 level 로 다시 맞춘 영역의 가운데와 같다.
  const exact = fitRegion(coords, size, pad, { minLevel: cam!.level, maxLevel: cam!.level })!;
  close(cam!.center.latitude, exact.latitude);
  close(cam!.center.longitude, exact.longitude);

  // 점 하나 — 하한 level 로.
  const one = kakaoCameraForFit([coords[0]], size, pad, { minLevel: 4 });
  assert.equal(one!.level, 4);
  assert.equal(kakaoCameraForFit([], size, pad), null);
}

// 띠 가운데: 위 가림(top)이 크면 target 은 화면 아래쪽 띠 가운데로 가야 하므로 지도 가운데는 target 보다 북쪽이다.
{
  const size = { width: 390, height: 720 };
  const target = { latitude: 35.836, longitude: 129.21 };
  const plain = kakaoCameraForBand(target, size, {}, 4);
  assert.equal(plain.level, 4);
  close(plain.center.latitude, target.latitude);
  close(plain.center.longitude, target.longitude);
  const topHeavy = kakaoCameraForBand(target, size, { top: 300 }, 4.4);
  assert.equal(topHeavy.level, 4);
  assert.ok(topHeavy.center.latitude > target.latitude);
}

assert.deepEqual(overlayAnchor('bottom'), { xAnchor: 0.5, yAnchor: 1 });
assert.deepEqual(overlayAnchor('center'), { xAnchor: 0.5, yAnchor: 0.5 });
assert.deepEqual(overlayAnchor('above'), { xAnchor: 0.5, yAnchor: 1.35 });
// 확대 경합(G4b-R01) — 애니메이션 중 getLevel() 이 시작 level(6→4 요청 뒤에도 6)을 돌려줘도 마지막 요청과 비교한다.
assert.equal(needsLevelChange(null, 6, 6), false, '요청 없음 → 지도 level');
assert.equal(needsLevelChange(null, 4, 6), true);
assert.equal(needsLevelChange(6, 4, 6), false, '6 으로 가는 중 → 같은 6 요청은 이동만');
assert.equal(needsLevelChange(6, 4, 4), true, '6 으로 가는 중 → 4 요청은 지도가 아직 4 라고 해도 확대를 바꾼다');
assert.deepEqual(overlayAnchor('search'),{ xAnchor: 0.5, yAnchor: 3.2 }, '웹 검색 이름표');
assert.deepEqual(overlayAnchor('popover'), { xAnchor: 0.5, yAnchor: 1.3 }, '웹 묶음 핀 말풍선');

// ── loader ──
interface Fake {
  deps: KakaoLoaderDeps;
  injected: string[];
  timers: (() => void)[];
  ns: KakaoMapsNamespace | undefined;
  scriptLoad: (() => void) | null;
  scriptError: (() => void) | null;
}
function fakeNs(callLoad = true): KakaoMapsNamespace {
  return { load: (cb: () => void) => { if (callLoad) cb(); } } as unknown as KakaoMapsNamespace;
}
function fake(): Fake {
  const f: Fake = { injected: [], timers: [], ns: undefined, scriptLoad: null, scriptError: null } as unknown as Fake;
  f.deps = {
    readNamespace: () => f.ns,
    injectScript: (src, onLoad, onError) => {
      f.injected.push(src);
      f.scriptLoad = onLoad;
      f.scriptError = onError;
    },
    setTimeout: (fn) => { f.timers.push(fn); return f.timers.length; },
    clearTimeout: () => {},
  };
  return f;
}

async function loaderTests() {
  // 스크립트를 넣고 load 콜백 뒤에 풀린다. 두 번 불러도 한 번만 넣는다.
  {
    const f = fake();
    const load = createKakaoLoader(f.deps);
    const p1 = load('key');
    const p2 = load('key');
    assert.equal(p1, p2);
    assert.equal(f.injected.length, 1);
    f.ns = fakeNs();
    f.scriptLoad!();
    assert.equal(await p1, f.ns);
    assert.equal(await load('key'), f.ns, '성공한 약속은 재사용');
    assert.equal(f.injected.length, 1);
  }
  // 이미 전역에 있으면 스크립트를 넣지 않는다.
  {
    const f = fake();
    f.ns = fakeNs();
    const load = createKakaoLoader(f.deps);
    assert.equal(await load('key'), f.ns);
    assert.equal(f.injected.length, 0);
  }
  // 스크립트 실패 → 거부, 다음 호출은 다시 시도한다.
  {
    const f = fake();
    const load = createKakaoLoader(f.deps);
    const p = load('key');
    f.scriptError!();
    await assert.rejects(p);
    load('key');
    assert.equal(f.injected.length, 2);
  }
  // 스크립트는 왔는데 kakao.maps 가 없다(키 거부 등) → 거부.
  {
    const f = fake();
    const load = createKakaoLoader(f.deps);
    const p = load('key');
    f.scriptLoad!();
    await assert.rejects(p);
  }
  // load 콜백이 오지 않으면 시간 초과로 거부.
  {
    const f = fake();
    const load = createKakaoLoader(f.deps);
    const p = load('key');
    f.ns = fakeNs(false);
    f.scriptLoad!();
    assert.equal(f.timers.length, 1);
    f.timers[0]();
    await assert.rejects(p, /timed out/);
  }
}

loaderTests().then(
  () => console.log('OK kakaoWeb'),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
