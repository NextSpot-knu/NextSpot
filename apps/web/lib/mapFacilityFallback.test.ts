import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanGalleryImages, loadMapFacilitiesFromSupabase } from './mapFacilityFallback';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOUNDS = { minLat: 35.8, maxLat: 35.9, minLng: 129.1, maxLng: 129.3 };

type Call = [string, ...unknown[]];

function fakeClient(opts: { total: number; facilityError?: boolean; rpcError?: boolean; rpcDeferred?: boolean }) {
  const calls: Call[] = [];
  const tables: string[] = [];
  const rpcCalls: Array<{ fn: string; ids: string[] }> = [];
  const pendingRpc: Array<() => void> = [];
  const facilities = Array.from({ length: opts.total }, (_, i) => ({ id: `f-${String(i).padStart(5, '0')}`, name: `시설 ${i}` }));
  const builder = {
    select(...a: unknown[]) { calls.push(['select', ...a]); return builder; },
    eq(...a: unknown[]) { calls.push(['eq', ...a]); return builder; },
    gte(...a: unknown[]) { calls.push(['gte', ...a]); return builder; },
    lte(...a: unknown[]) { calls.push(['lte', ...a]); return builder; },
    order(...a: unknown[]) { calls.push(['order', ...a]); return builder; },
    range(from: number, to: number) {
      calls.push(['range', from, to]);
      if (opts.facilityError) return Promise.resolve({ data: null, error: new Error('시설 조회 실패') });
      return Promise.resolve({ data: facilities.slice(from, Math.min(to, from + 999) + 1), error: null });
    },
  };
  const client = {
    from(table: string) { tables.push(table); return builder; },
    rpc(fn: string, args: { facility_ids: string[] }) {
      rpcCalls.push({ fn, ids: args.facility_ids });
      const result = opts.rpcError
        ? { data: null, error: new Error('rpc 실패') }
        : { data: [{ facility_id: args.facility_ids[0], congestion_level: 0.5, current_count: null, timestamp: '2026-09-28T01:00:00Z', source: 'user_report', evidence_tier: 'single_report' }], error: null };
      if (!opts.rpcDeferred) return Promise.resolve(result);
      return new Promise((resolve) => pendingRpc.push(() => resolve(result)));
    },
  };
  return { client, calls, tables, rpcCalls, pendingRpc };
}

async function main() {
  // 활성만, id 순서, 1000행 페이지, 경계 4개, gallery_images 선택
  {
    const { client, calls, tables } = fakeClient({ total: 3 });
    const res = await loadMapFacilitiesFromSupabase(client as never, BOUNDS);
    assert.equal(res.rows.length, 3);
    assert.ok(tables.every((t) => t === 'facilities'), 'congestion_logs 를 직접 읽지 않는다');
    const select = calls.find((c) => c[0] === 'select');
    assert.match(String(select?.[1]), /\bgallery_images\b/, '카드 사진 폴백(gallery_images)을 읽지 않는다');
    assert.match(String(select?.[1]), /\blatitude\b/);
    assert.deepEqual(calls.filter((c) => c[0] === 'eq'), [['eq', 'is_active', true]], '비활성 시설을 지도에 그린다');
    assert.deepEqual(
      calls.filter((c) => c[0] === 'gte' || c[0] === 'lte'),
      [['gte', 'latitude', 35.8], ['lte', 'latitude', 35.9], ['gte', 'longitude', 129.1], ['lte', 'longitude', 129.3]],
    );
    assert.deepEqual(calls.filter((c) => c[0] === 'order'), [['order', 'id', { ascending: true }]]);
    assert.deepEqual(calls.filter((c) => c[0] === 'range'), [['range', 0, 999]]);
    assert.equal(res.congestionFailed, false);
    assert.equal(Object.keys(res.latestBy).length, 1);
    assert.equal(res.latestBy['f-00000']?.congestion_level, 0.5);
  }

  // 1000행을 넘으면 다음 페이지
  {
    const { client, calls } = fakeClient({ total: 1200 });
    const res = await loadMapFacilitiesFromSupabase(client as never, BOUNDS);
    assert.equal(res.rows.length, 1200);
    assert.deepEqual(calls.filter((c) => c[0] === 'range'), [['range', 0, 999], ['range', 1000, 1999]]);
  }

  // RPC 는 1000개 이하 묶음, 병렬(첫 응답 전에 둘 다 나간다)
  {
    const { client, rpcCalls, pendingRpc } = fakeClient({ total: 1200, rpcDeferred: true });
    const p = loadMapFacilitiesFromSupabase(client as never, BOUNDS);
    for (let i = 0; i < 20 && rpcCalls.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(rpcCalls.length, 2, '두 묶음이 첫 응답을 기다리지 않고 함께 나가야 한다');
    assert.deepEqual(rpcCalls.map((c) => c.ids.length), [1000, 200]);
    assert.ok(rpcCalls.every((c) => c.fn === 'latest_congestion_for_facilities'));
    pendingRpc.forEach((resolve) => resolve());
    const res = await p;
    assert.equal(Object.keys(res.latestBy).length, 2);
  }

  // RPC 실패 → 지도는 그대로, 혼잡만 모름
  {
    const { client } = fakeClient({ total: 5, rpcError: true });
    const res = await loadMapFacilitiesFromSupabase(client as never, BOUNDS);
    assert.equal(res.rows.length, 5);
    assert.deepEqual(res.latestBy, {});
    assert.equal(res.congestionFailed, true);
  }

  // 시설 실패 → throw(호출부 catch 가 안내)
  {
    const { client } = fakeClient({ total: 5, facilityError: true });
    await assert.rejects(() => loadMapFacilitiesFromSupabase(client as never, BOUNDS), /시설 조회 실패/);
  }

  // 시설 0곳 → RPC 를 부르지 않는다
  {
    const { client, rpcCalls } = fakeClient({ total: 0 });
    const res = await loadMapFacilitiesFromSupabase(client as never, BOUNDS);
    assert.equal(res.rows.length, 0);
    assert.equal(rpcCalls.length, 0);
  }

  // 갤러리 정제 — API _clean_gallery_images 와 같은 결과
  assert.equal(cleanGalleryImages(null), null);
  assert.equal(cleanGalleryImages('https://a'), null);
  assert.equal(cleanGalleryImages([]), null);
  assert.equal(cleanGalleryImages(['', '  ', 3, null]), null);
  assert.deepEqual(cleanGalleryImages(['https://a', '', 7, 'https://b']), ['https://a', 'https://b']);

  // 화면 배선 가드
  const mainSrc = readFileSync(join(WEB, 'app', 'main', 'page.tsx'), 'utf8');
  assert.match(mainSrc, /loadMapFacilitiesFromSupabase\(/, '/main 비상 경로가 활성·RPC 헬퍼를 쓰지 않는다');
  assert.match(mainSrc, /gallery_images/, '/main 비상 경로가 갤러리 사진을 매핑하지 않는다');
  assert.doesNotMatch(mainSrc, /from\(\s*["']congestion_logs["']\s*\)/, '/main 이 congestion_logs 를 직접 읽는다(1000행 캡에 시설이 빠진다)');
  // 주석 속 '_clean_gallery_images' 가 위 검사를 통과시킨다 — 줄 주석을 걷어낸 뒤 매핑 자체를 본다.
  const mainCode = mainSrc.replace(/\/\/.*$/gm, '');
  assert.match(
    mainCode,
    /galleryImages:\s*cleanGalleryImages\(f\.gallery_images\)/,
    '/main 비상 경로가 gallery_images 를 카드 사진 폴백(galleryImages)으로 매핑하지 않는다',
  );

  console.log('map facility fallback tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
