import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGION, isWithinRegion } from './region';
import {
  buildInternalPack,
  GYEONGJU_FEATURES,
  GYEONGJU_PACK,
  INTERNAL_PACK_FEATURES,
  internPack,
  isRegionSuffixedKey,
  isWithinBounds,
  isWithinPack,
  packDisplayName,
  purgeRegionCaches,
  regionCacheKey,
} from './regionPacks';
import type { InternalRegionView } from './api-client';

// 지역 묶음(lib/regionPacks.ts). 내부 지역의 이름·좌표는 실행 중에 서버 응답으로만 만든다 — 아래 픽스처도 가상의 지역이다.

// ── 경주 묶음 = lib/region.ts REGION 그대로 ─────────────────────────────────────────
{
  assert.equal(GYEONGJU_PACK.id, 'gyeongju');
  assert.deepEqual(GYEONGJU_PACK.center, REGION.center);
  assert.deepEqual(GYEONGJU_PACK.bounds, REGION.bounds);
  assert.deepEqual(GYEONGJU_PACK.presets, REGION.presets);
  assert.equal(GYEONGJU_PACK.name, REGION.name);
  // 복사가 아니라 같은 객체 — 경주 화면이 쓰는 값은 오늘과 같은 참조다.
  assert.equal(GYEONGJU_PACK.center, REGION.center);
  assert.equal(GYEONGJU_PACK.bounds, REGION.bounds);
  assert.equal(GYEONGJU_PACK.presets, REGION.presets);
  assert.equal(GYEONGJU_PACK.addressToken, '경주');
  assert.equal(GYEONGJU_PACK.features, GYEONGJU_FEATURES);
  // 경주는 오늘 있는 기능을 전부 켜 둔다(구역 오버레이만 없다).
  for (const [name, on] of Object.entries(GYEONGJU_FEATURES)) {
    assert.equal(on, name !== 'zoneLayer', `경주 기능 ${name}`);
  }
  // isWithinPack(경주) 는 isWithinRegion 과 같은 판정이다.
  for (const [lat, lng] of [
    [REGION.center.lat, REGION.center.lng],
    [REGION.bounds.minLat, REGION.bounds.minLng],
    [REGION.bounds.maxLat, REGION.bounds.maxLng],
    [REGION.bounds.minLat - 0.0001, REGION.center.lng],
    [REGION.center.lat, REGION.bounds.maxLng + 0.0001],
    [0, 0],
  ]) {
    assert.equal(isWithinPack(GYEONGJU_PACK, lat, lng), isWithinRegion(lat, lng), `${lat},${lng}`);
  }
  assert.equal(isWithinPack(GYEONGJU_PACK, Number.NaN, REGION.center.lng), false);
}

// ── 내부 지역 기능 표 — 경주 전용 기능과 공유는 끄고 구역 오버레이만 켠다 ───────────────
{
  const off = [
    'weather', 'festival', 'parking', 'discovery', 'externalSearch', 'estimates', 'predictBatch',
    'crowdReports', 'availabilityReports', 'seatStatus', 'timesale', 'supabaseFallback', 'areaDemandForecast', 'share',
  ] as const;
  for (const name of off) assert.equal(INTERNAL_PACK_FEATURES[name], false, `내부 지역에서 ${name} 가 켜져 있다`);
  assert.equal(INTERNAL_PACK_FEATURES.zoneLayer, true);
  assert.deepEqual(Object.keys(INTERNAL_PACK_FEATURES).sort(), Object.keys(GYEONGJU_FEATURES).sort(), '두 기능 표의 항목이 다르다');
  assert.ok(Object.isFrozen(INTERNAL_PACK_FEATURES) && Object.isFrozen(GYEONGJU_FEATURES));
}

// ── buildInternalPack — 서버 응답(camelCase)으로 묶음을 만든다 ──────────────────────────
const FIXTURE: InternalRegionView = {
  id: 'testbed',
  names: { ko: '시험지구', en: 'Testbed', ja: 'テスト地区', zh: '测试区' },
  center: { lat: 10.5, lng: 20.5 },
  bounds: { minLat: 10, maxLat: 11, minLng: 20, maxLng: 21 },
  presets: [
    { id: 'Z1', name: '첫 구역', lat: 10.2, lng: 20.2 },
    { id: 'Z2', name: '둘째 구역', lat: 10.8, lng: 20.9 },
    { id: 'OUT', name: '경계 밖', lat: 50, lng: 50 },
  ],
  addressToken: '시험',
  facilityCount: 42,
  mappedFacilityCount: 42,
  zoneCount: 2,
  latestObservedAt: '2026-10-31T09:00:00+09:00',
};
{
  const pack = buildInternalPack(FIXTURE);
  assert.ok(pack);
  assert.equal(pack.id, 'testbed');
  assert.equal(pack.name, '시험지구');
  assert.deepEqual(pack.center, { lat: 10.5, lng: 20.5 });
  assert.deepEqual(pack.bounds, { minLat: 10, maxLat: 11, minLng: 20, maxLng: 21 });
  assert.equal(pack.addressToken, '시험');
  assert.equal(pack.features, INTERNAL_PACK_FEATURES);
  assert.equal(pack.facilityCount, 42);
  assert.equal(pack.zoneCount, 2);
  // 프리셋 번호는 경주와 같은 형식(1부터) · 서버 id 는 key · 경계 밖 프리셋은 버린다.
  assert.deepEqual(
    pack.presets.map((p) => [p.id, p.key, p.name]),
    [[1, 'Z1', '첫 구역'], [2, 'Z2', '둘째 구역']],
  );
  assert.equal(packDisplayName(pack, 'en'), 'Testbed');
  assert.equal(packDisplayName(pack, 'zh'), '测试区');
  assert.equal(isWithinPack(pack, 10.5, 20.5), true);
  assert.equal(isWithinPack(pack, REGION.center.lat, REGION.center.lng), false, '경주 좌표가 내부 지역 안으로 판정된다');
  assert.equal(isWithinPack(GYEONGJU_PACK, 10.5, 20.5), false);
  // 경계만 받는 판(useRegionGeo 를 쓰는 효과)도 같은 판정이다.
  assert.equal(isWithinBounds(pack.bounds, 10.5, 20.5), true);
  assert.equal(isWithinBounds(pack.bounds, REGION.center.lat, REGION.center.lng), false);
  assert.equal(isWithinBounds(GYEONGJU_PACK.bounds, REGION.center.lat, REGION.center.lng), true);
  assert.equal(isWithinBounds(pack.bounds, Number.NaN, 20.5), false);
  assert.ok(Object.isFrozen(pack));

  // 재확인(5분마다·탭 복귀)마다 같은 값으로 새로 만든 묶음은 같은 객체여야 한다 — 객체가 바뀌면 `pack` 에 걸린 화면 효과
  // (/course 위치 재요청·안내 토스트, /waiting 구역 재조회)가 매번 다시 돈다. 관측 시각만 바뀐 답도 같은 묶음이다.
  const first = internPack(pack);
  assert.equal(internPack(buildInternalPack(FIXTURE)!), first, '같은 값의 묶음이 새 객체가 됐다');
  assert.equal(internPack(buildInternalPack({ ...FIXTURE, latestObservedAt: '2026-10-31T09:05:00+09:00' })!), first);
  // 값이 바뀌면(장소 수) 새 객체 — 화면이 새 값을 본다.
  const changed = internPack(buildInternalPack({ ...FIXTURE, facilityCount: 43 })!);
  assert.notEqual(changed, first);
  assert.equal(changed.facilityCount, 43);

  // 로케일 이름이 비면 한국어 이름으로 채운다.
  const partial = buildInternalPack({ ...FIXTURE, names: { ko: '시험지구', en: '', ja: '', zh: '' } });
  assert.equal(partial && packDisplayName(partial, 'ja'), '시험지구');

  // 고를 수 없는 응답은 null.
  assert.equal(buildInternalPack(null), null);
  assert.equal(buildInternalPack({ ...FIXTURE, id: '' }), null);
  assert.equal(buildInternalPack({ ...FIXTURE, id: 'gyeongju' }), null, '공개 지역 id 로 내부 묶음을 만들면 안 된다');
  assert.equal(buildInternalPack({ ...FIXTURE, bounds: { minLat: 11, maxLat: 10, minLng: 20, maxLng: 21 } }), null);
  assert.equal(buildInternalPack({ ...FIXTURE, center: { lat: 50, lng: 50 } }), null, '중심이 경계 밖');
  assert.equal(
    buildInternalPack({ ...FIXTURE, center: { lat: Number.NaN, lng: 20.5 } }),
    null,
  );
}

// ── regionCacheKey — 경주는 키 그대로(오늘 캐시를 그대로 읽는다) ────────────────────────
{
  assert.equal(regionCacheKey('nextspot_waiting_board_v2', 'gyeongju'), 'nextspot_waiting_board_v2');
  assert.equal(regionCacheKey('nextspot_waiting_board_v2', null), 'nextspot_waiting_board_v2');
  assert.equal(regionCacheKey('nextspot_waiting_board_v2', ''), 'nextspot_waiting_board_v2');
  assert.equal(regionCacheKey('nextspot_waiting_board_v2', 'testbed'), 'nextspot_waiting_board_v2__testbed');
  assert.equal(isRegionSuffixedKey('nextspot_waiting_board_v2__testbed'), true);
  assert.equal(isRegionSuffixedKey('nextspot_waiting_board_v2__gyeongju'), false);
  assert.equal(isRegionSuffixedKey('nextspot_waiting_board_v2'), false);
  assert.equal(isRegionSuffixedKey('other_app__testbed'), false, 'nextspot 키가 아니면 건드리지 않는다');
}

// ── purgeRegionCaches — 내부 지역 캐시만 지운다 ─────────────────────────────────────
{
  const store = new Map<string, string>([
    ['nextspot_facilities_cache_v3', 'g'],
    ['nextspot_facilities_cache_v3__testbed', 's'],
    ['nextspot_map_center_lat__testbed', '1'],
    ['nextspot_locale', 'ko'],
    ['nextspot_region', 'testbed'],
    ['third_party__testbed', 'x'],
  ]);
  const storage = {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
  };
  assert.equal(purgeRegionCaches(storage), 2);
  assert.deepEqual(
    [...store.keys()].sort(),
    ['nextspot_facilities_cache_v3', 'nextspot_locale', 'nextspot_region', 'third_party__testbed'],
  );
  assert.equal(purgeRegionCaches(null), 0);
  const throwing = {
    get length(): number {
      throw new Error('blocked');
    },
    key: () => null,
    removeItem: () => {},
  };
  assert.equal(purgeRegionCaches(throwing), 0, '저장소가 막혀도 던지지 않는다');
}

console.log('regionPacks tests passed');

// ── 번들 내용 검사 — 내부 지역의 이름·제공처 장소 코드·좌표가 웹 소스에 없다 ─────────────────
// 내부 지역의 기하·이름은 GET /internal/regions 로만 들어와야 한다. 기준 목록은 API 의 구역 정의에서 읽는다
// (여기에 이름을 적으면 이 파일이 곧 누출이다).
{
  const here = dirname(fileURLToPath(import.meta.url));
  const webRoot = join(here, '..');
  const zoneSource = join(webRoot, '..', 'api', 'app', 'services', 'crowd', 'seoul_provider.py');
  assert.ok(existsSync(zoneSource), `구역 정의를 찾지 못했다: ${zoneSource}`);
  const py = readFileSync(zoneSource, 'utf8');
  const zones = [...py.matchAll(/_zone\(\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*([0-9.]+),\s*([0-9.]+)/g)];
  assert.ok(zones.length >= 5, '구역 정의를 읽지 못했다 — 정규식을 정의 모양에 맞출 것');

  const needles = new Set<string>();
  for (const [, code, name, , lat, lng] of zones) {
    needles.add(code);
    needles.add(name);
    needles.add(Number(lat).toFixed(4));
    needles.add(Number(lng).toFixed(4));
  }
  // 제공처 장소 코드의 모양 자체(코드 하나를 새로 넣어도 걸리게) — 문자열을 나눠 이 파일이 걸리지 않게 한다.
  const codeShape = new RegExp(['P', 'O', 'I', '0\\d{2}'].join(''));
  // 내부 지역 위도대(소수 둘째 자리까지) — 경주(35.8x)와 겹치지 않는다.
  const latShape = new RegExp(['37', '\\.5[4-8]\\d'].join(''));

  // 이미 있던 관제 '엔진 검증' 화면(S0·S2 — 관리자 전용, 검증 표본을 제공처 장소 이름으로 설명한다)은 이번 범위 밖이다.
  // 관광객 화면·공용 lib 에는 하나도 없어야 한다. 새 파일을 여기에 더하지 말 것 — 내부 지역 값은 서버 응답으로 받는다.
  const ALLOWED_PREEXISTING = new Set([
    'lib/engineValidation.ts',
    'components/admin/engine-validation/SeoulAlternativesPanel.tsx',
    'app/admin/engine-validation/page.tsx',
  ]);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      // 테스트 파일은 번들에 들어가지 않는다(이 파일 포함).
      if (!/\.(ts|tsx|json)$/.test(entry) || /\.test\.ts$/.test(entry)) continue;
      const rel = relative(webRoot, full).split('\\').join('/');
      if (ALLOWED_PREEXISTING.has(rel)) continue;
      const src = readFileSync(full, 'utf8');
      if (codeShape.test(src)) offenders.push(`${rel}: 장소 코드`);
      if (latShape.test(src)) offenders.push(`${rel}: 내부 지역 위도`);
      for (const needle of needles) if (src.includes(needle)) offenders.push(`${rel}: ${needle}`);
    }
  };
  for (const dir of ['lib', 'components', 'app']) walk(join(webRoot, dir));
  // 허용 목록이 낡으면(파일이 사라지면) 같이 지운다 — 예외가 조용히 남지 않게.
  for (const rel of ALLOWED_PREEXISTING) assert.ok(existsSync(join(webRoot, rel)), `허용 목록의 파일이 없다: ${rel}`);
  assert.deepEqual(offenders, [], `웹 소스에 내부 지역 데이터가 있다:\n${offenders.join('\n')}`);
  console.log(`bundle content check passed (${zones.length} zones, ${needles.size} needles)`);
}
