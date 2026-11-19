import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideRegion,
  isPublicOnlyPath,
  normalizeStoredRegion,
  REGION_STORAGE_KEY,
  regionsFetchFailure,
  type DecideRegionInput,
  type RegionsFetchState,
} from './regionState';
import { canSeeInternalRegions, type Account, type AccountRole } from './accountRoles';

// 지역 결정 규칙(lib/regionState.ts). RegionProvider 는 shouldValidate 가 true 일 때만 /internal/regions 를 부른다 —
// 그래서 여기서 shouldValidate=false 이면 그 계정은 요청을 0번 보낸다.

const IDLE: RegionsFetchState = { status: 'idle' };
const OK: RegionsFetchState = { status: 'ok', regionIds: ['testbed'] };

function account(role: AccountRole, isAnonymous = false): Account {
  return { id: `u-${role}`, role, isAnonymous, nickname: null, ownedFacilities: [], pendingVerification: false };
}

function input(over: Partial<DecideRegionInput>): DecideRegionInput {
  return { accountStatus: 'ready', canSee: false, stored: null, server: IDLE, ...over };
}

// ── 관광객·게스트·관리자·계정 확인 중 — 요청 0번, 경주를 바로 ────────────────────────────
{
  const cases: Array<[string, DecideRegionInput]> = [
    ['tourist', input({ canSee: canSeeInternalRegions(account('tourist')) })],
    ['tourist + 남은 내부 선택', input({ canSee: canSeeInternalRegions(account('tourist')), stored: 'testbed' })],
    ['merchant', input({ canSee: canSeeInternalRegions(account('merchant')), stored: 'testbed' })],
    ['admin(관제·심사 공용 계정)', input({ canSee: canSeeInternalRegions(account('admin')), stored: 'testbed' })],
    ['guest', input({ canSee: canSeeInternalRegions(account('developer', true)), stored: 'testbed' })],
    ['세션 없음(error)', input({ accountStatus: 'error', canSee: false, stored: 'testbed' })],
    ['loading', input({ accountStatus: 'loading', canSee: false, stored: 'testbed' })],
    ['loading(내부 계정이 될 사람)', input({ accountStatus: 'loading', canSee: true, stored: 'testbed' })],
    // 서버가 무엇을 줬든 내부가 아니면 그 답을 쓰지 않는다.
    ['tourist + (오염된) ok 응답', input({ canSee: false, stored: 'testbed', server: OK })],
  ];
  for (const [name, c] of cases) {
    const d = decideRegion(c);
    assert.equal(d.shouldValidate, false, `${name}: /internal/regions 를 부른다`);
    assert.equal(d.ready, true, `${name}: 경주를 바로 그리지 않는다`);
    assert.equal(d.regionId, 'gyeongju', `${name}: 경주가 아니다`);
    assert.equal(d.notice, null, `${name}: 안내를 띄운다`);
  }
}

// ── 내부가 아니라고 확정되면 남은 내부 지역 흔적을 지운다 · 모를 때는 미룬다 ─────────────────
{
  assert.equal(decideRegion(input({ canSee: false, stored: 'testbed' })).purge, true, 'tourist 확정 → 지운다');
  assert.equal(decideRegion(input({ accountStatus: 'error', canSee: false, stored: 'testbed' })).purge, true, '세션 없음 → 지운다');
  assert.equal(decideRegion(input({ accountStatus: 'loading', stored: 'testbed' })).purge, false, 'loading 은 아직 모른다');
  assert.equal(
    decideRegion(input({ accountStatus: 'error', canSee: false, unreachable: true, stored: 'testbed' })).purge,
    false,
    '서버에 닿지 못한 실패는 계정을 모르는 것 — 지우지 않는다',
  );
}

// ── 내부 계정(developer) ───────────────────────────────────────────────────────────
{
  const dev = canSeeInternalRegions(account('developer'));
  assert.equal(dev, true);

  // 경주를 고른(또는 아무것도 안 고른) 내부 계정 — 묻지 않고 경주.
  for (const stored of [null, '', 'gyeongju']) {
    const d = decideRegion(input({ canSee: dev, stored }));
    assert.deepEqual(d, { regionId: 'gyeongju', ready: true, shouldValidate: false, purge: false, notice: null }, String(stored));
  }

  // 내부 지역을 골라 둔 내부 계정 — 첫 답까지 기다리고(ready=false) 확인한다.
  const waiting = decideRegion(input({ canSee: dev, stored: 'testbed' }));
  assert.deepEqual(waiting, { regionId: 'gyeongju', ready: false, shouldValidate: true, purge: false, notice: null });

  // 서버가 허락 → 그 지역.
  assert.deepEqual(decideRegion(input({ canSee: dev, stored: 'testbed', server: OK })), {
    regionId: 'testbed', ready: true, shouldValidate: false, purge: false, notice: null,
  });

  // 401·403 → 경주 + 지움 + 안내.
  for (const status of [401, 403]) {
    const d = decideRegion(input({ canSee: dev, stored: 'testbed', server: regionsFetchFailure(status) }));
    assert.deepEqual(d, { regionId: 'gyeongju', ready: true, shouldValidate: false, purge: true, notice: 'reset' }, String(status));
  }

  // 목록에 그 지역이 없으면 → 경주 + 지움 + 안내.
  assert.deepEqual(decideRegion(input({ canSee: dev, stored: 'other', server: OK })), {
    regionId: 'gyeongju', ready: true, shouldValidate: false, purge: true, notice: 'reset',
  });
  assert.equal(decideRegion(input({ canSee: dev, stored: 'testbed', server: { status: 'ok', regionIds: [] } })).notice, 'reset');

  // 볼 수는 있지만 활성 장소가 0곳인 지역 → 경주 + 지움, 안내는 '권한 없음' 이 아니라 '빈 지역'.
  assert.deepEqual(
    decideRegion(input({ canSee: dev, stored: 'testbed', server: { status: 'ok', regionIds: [], emptyRegionIds: ['testbed'] } })),
    { regionId: 'gyeongju', ready: true, shouldValidate: false, purge: true, notice: 'empty' },
  );
  // 다른 지역이 비었다고 내가 고른 지역의 판정이 바뀌지 않는다.
  assert.equal(
    decideRegion(input({ canSee: dev, stored: 'testbed', server: { status: 'ok', regionIds: ['testbed'], emptyRegionIds: ['other'] } })).regionId,
    'testbed',
  );
  assert.equal(
    decideRegion(input({ canSee: dev, stored: 'gone', server: { status: 'ok', regionIds: [], emptyRegionIds: ['other'] } })).notice,
    'reset',
  );

  // 일시 실패(타임아웃·503) → 경주로 보여 주되 선택은 남긴다.
  for (const status of [undefined, 500, 503, 429]) {
    const d = decideRegion(input({ canSee: dev, stored: 'testbed', server: regionsFetchFailure(status) }));
    assert.deepEqual(d, { regionId: 'gyeongju', ready: true, shouldValidate: false, purge: false, notice: 'unavailable' }, String(status));
  }
}

// ── 보조 함수 ─────────────────────────────────────────────────────────────────────
{
  assert.equal(REGION_STORAGE_KEY, 'nextspot_region');
  assert.equal(normalizeStoredRegion(null), null);
  assert.equal(normalizeStoredRegion(42), null);
  assert.equal(normalizeStoredRegion(' gyeongju '), null);
  assert.equal(normalizeStoredRegion(' testbed '), 'testbed');
  assert.deepEqual(regionsFetchFailure(401), { status: 'denied' });
  assert.deepEqual(regionsFetchFailure(403), { status: 'denied' });
  assert.deepEqual(regionsFetchFailure(404), { status: 'failed' });

  // 경주 전용 화면 — 랜딩·소개·관제·사장님·개발자 콘솔.
  for (const path of ['/', '/guide', '/admin', '/admin/reports', '/merchant', '/merchant/x', '/dev', null]) {
    assert.equal(isPublicOnlyPath(path), true, String(path));
  }
  for (const path of ['/main', '/waiting', '/course', '/saved', '/mypage', '/explore/recommend', '/developer', '/administer']) {
    assert.equal(isPublicOnlyPath(path), false, path);
  }
}

// ── 배선 — RegionProvider 는 내부 계정일 때만, 결정이 시킬 때만 목록을 부른다 ───────────────
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'regionContext.tsx'), 'utf8');
  const calls = src.match(/getInternalRegions\(/g) ?? [];
  assert.equal(calls.length, 1, 'getInternalRegions 를 부르는 곳은 fetchRegions 한 곳이어야 한다');
  assert.match(src, /const fetchKey = canSee && status === 'ready' && account \? account\.id : null;/);
  assert.match(
    src,
    /const needsFirstAnswer = !!fetchKey && !effectiveAnswer && \(decision\.shouldValidate \|\| listWanted\);/,
    '첫 요청 조건이 바뀌었다 — 관광객·게스트가 요청을 보내지 않는지 다시 확인할 것',
  );
  assert.match(src, /if \(!viewingInternal \|\| !fetchKey\) return;/, '재확인이 내부 계정·내부 지역 밖에서도 돈다');
  assert.match(src, /requestRegions = useCallback\(\(\) => \{\s*if \(canSee\) setListWanted\(true\);/);
  // 경주 화면은 다시 마운트되지 않는다 — key 가 경주에서 늘 같다.
  assert.match(src, /<Fragment key=\{pack\.id === PUBLIC_REGION_ID \? PUBLIC_REGION_ID : `region:\$\{pack\.id\}`\}>/);
  // 지역은 자식의 첫 요청보다 먼저 적는다.
  assert.match(src, /useIsoLayoutEffect\(\(\) => \{\s*setActiveRegion\(activeId\);/);
}

console.log('regionState tests passed');
