import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countNameMatchesByType,
  fetchAdminFacilityRows,
  filterAdminFacilities,
  matchesFacilityName,
  normalizeFacilityName,
  type AdminFacilityRow,
} from './adminFacilityList';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

// 가짜 PostgREST 빌더: 체인 호출을 기록하고, range() 에서 요청 범위만큼 잘라 돌려준다(1000행 캡 흉내).
type Call = [string, ...unknown[]];

function fakeClient(total: number, failAtFrom: number | null = null) {
  const calls: Call[] = [];
  const ranges: Array<[number, number]> = [];
  const rows = Array.from({ length: total }, (_, i) => ({
    id: `id-${String(i).padStart(5, '0')}`,
    name: `시설 ${i}`,
    type: 'restaurant',
    capacity: 10,
    is_active: i % 100 !== 0,
  }));
  const builder = {
    select(...a: unknown[]) { calls.push(['select', ...a]); return builder; },
    order(...a: unknown[]) { calls.push(['order', ...a]); return builder; },
    eq(...a: unknown[]) { calls.push(['eq', ...a]); return builder; },
    is(...a: unknown[]) { calls.push(['is', ...a]); return builder; },
    filter(...a: unknown[]) { calls.push(['filter', ...a]); return builder; },
    range(from: number, to: number) {
      calls.push(['range', from, to]);
      ranges.push([from, to]);
      if (failAtFrom !== null && from >= failAtFrom) {
        return Promise.resolve({ data: null, error: new Error('페이지 조회 실패') });
      }
      const cappedTo = Math.min(to, from + 999);
      return Promise.resolve({ data: rows.slice(from, cappedTo + 1), error: null });
    },
  };
  const client = {
    from(table: string) { calls.push(['from', table]); return builder; },
  };
  return { client, calls, ranges };
}

async function main() {
  // 1,700행 → (0,999), (1000,1999) 두 번에 전량
  {
    const { client, calls, ranges } = fakeClient(1700);
    const rows = await fetchAdminFacilityRows(client as never);
    assert.equal(rows.length, 1700, '1,000행 캡 뒤의 시설이 빠졌다');
    assert.deepEqual(ranges, [[0, 999], [1000, 1999]]);
    assert.ok(calls.every((c) => c[0] !== 'from' || c[1] === 'facilities'));

    const selects = calls.filter((c) => c[0] === 'select');
    assert.ok(selects.length > 0);
    for (const s of selects) assert.match(String(s[1]), /\bis_active\b/, '비활성 표시에 필요한 is_active 를 읽지 않는다');

    // 페이지마다 order 가 정확히 [name asc, id asc] (전순서)
    const orders = calls.filter((c) => c[0] === 'order').map((c) => [c[1], (c[2] as { ascending?: boolean })?.ascending]);
    assert.equal(orders.length, 4);
    for (let i = 0; i < orders.length; i += 2) {
      assert.deepEqual(orders.slice(i, i + 2), [['name', true], ['id', true]]);
    }

    // 비활성 시설을 걸러내지 않는다(crit8)
    for (const c of calls) {
      if (c[0] === 'eq' || c[0] === 'is' || c[0] === 'filter') {
        assert.notEqual(c[1], 'is_active', '관리 표가 비활성 시설을 걸러낸다');
      }
    }
    assert.ok(rows.some((r) => r.is_active === false), '비활성 행이 결과에 남아야 한다');
  }

  // 딱 1,000행 → 두 번째 빈 페이지로 끝을 확인
  {
    const { client, ranges } = fakeClient(1000);
    const rows = await fetchAdminFacilityRows(client as never);
    assert.equal(rows.length, 1000);
    assert.deepEqual(ranges, [[0, 999], [1000, 1999]]);
  }

  // 페이지 오류는 잘린 목록 대신 reject
  {
    const { client } = fakeClient(1700, 1000);
    await assert.rejects(() => fetchAdminFacilityRows(client as never), /페이지 조회 실패/);
  }

  // ── 탭 + 이름 검색 ─────────────────────────────────────────────────────────
  // 비활성 시설을 빼지 않고(crit8), 대소문자·공백을 무시하고, 지금 탭에 없으면 다른 탭에 몇 곳
  // 있는지 셀 수 있어야 한다(음식점 탭에서 카페 이름을 찾는 심사위원).
  {
    const row = (id: string, name: string, type: string, is_active: boolean | null = true): AdminFacilityRow => ({
      id, name, type, capacity: 30, is_active,
    });
    // (name, id) 순서로 받은 목록 — 필터는 순서를 바꾸지 않는다.
    const rows: AdminFacilityRow[] = [
      row('c1', 'Starbucks 황리단길', 'cafe'),
      row('r1', '황리단길 식당', 'restaurant'),
      row('r2', '황리단길 식당', 'restaurant', false), // 동명 비활성 — 목록에 남아야 한다
      row('c2', '황리단길 카페', 'cafe', false),
      row('r3', '교리김밥', 'restaurant', null),
      row('a1', '대릉원', 'attraction'),
    ];

    assert.equal(normalizeFacilityName('  Star Bucks '), 'starbucks');
    assert.equal(matchesFacilityName('Starbucks 황리단길', 'starbucks'), true, '대소문자를 무시하지 않는다');
    assert.equal(matchesFacilityName('황리단길 식당', '황리단길식당'), true, '공백을 무시하지 않는다');
    assert.equal(matchesFacilityName('황리단길식당', '황리단길 식당'), true, '검색어의 공백을 무시하지 않는다');
    assert.equal(matchesFacilityName('대릉원', ''), true, '빈 검색어는 모두 맞는다');
    assert.equal(matchesFacilityName('대릉원', '   '), true, '공백뿐인 검색어는 모두 맞는다');
    assert.equal(matchesFacilityName('대릉원', '불국사'), false);

    assert.deepEqual(
      filterAdminFacilities(rows, 'restaurant', '').map((r) => r.id),
      ['r1', 'r2', 'r3'],
      '비활성 시설이 장소 관리 표에서 빠졌다(crit8)',
    );
    assert.deepEqual(filterAdminFacilities(rows, 'restaurant', '황리단길식당').map((r) => r.id), ['r1', 'r2']);
    assert.deepEqual(filterAdminFacilities(rows, 'cafe', 'STARBUCKS').map((r) => r.id), ['c1']);
    assert.deepEqual(filterAdminFacilities(rows, 'cafe', '').map((r) => r.id), ['c1', 'c2'], '비활성 카페가 빠졌다');
    assert.deepEqual(filterAdminFacilities(rows, 'culture', ''), []);

    // 음식점 탭에서 카페 이름을 찾으면 0곳 → 카페 탭에 1곳
    assert.deepEqual(filterAdminFacilities(rows, 'restaurant', '카페'), []);
    assert.deepEqual(countNameMatchesByType(rows, '카페'), { cafe: 1 });
    assert.deepEqual(countNameMatchesByType(rows, '황리단길'), { cafe: 2, restaurant: 2 }, '비활성도 센다');
    assert.deepEqual(countNameMatchesByType(rows, ''), {}, '빈 검색어는 세지 않는다');
    assert.deepEqual(countNameMatchesByType(rows, '불국사'), {});
  }

  // 화면 배선 가드 — 표가 이 순수 함수를 쓰고, 화면 쪽에서 활성 여부로 따로 거르지 않는다.
  {
    const tableSrc = readFileSync(join(WEB, 'components', 'admin', 'FacilityTable.tsx'), 'utf8');
    const tableCode = tableSrc.replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    assert.match(tableCode, /filterAdminFacilities\(facilities, selectedCategory, q\)/, '장소 관리 표가 공용 필터를 쓰지 않는다');
    assert.match(tableCode, /countNameMatchesByType\(facilities, q\)/, '지금 탭에 없을 때 다른 탭 결과를 알려 주지 않는다');
    assert.doesNotMatch(tableCode, /f\.name\.includes\(/, '대소문자·공백을 구분하는 옛 이름 검색이 남아 있다');
    assert.doesNotMatch(
      tableCode,
      /is_active\s*!==?\s*false\s*&&|&&\s*\w+\.is_active\s*!==?\s*false|\.filter\([^)]*is_active/,
      '장소 관리 표가 비활성 시설을 화면에서 걸러낸다(crit8)',
    );
    // 위 정규식은 `(f) => f.is_active` 같은 괄호 화살표 필터를 놓친다 — 표가 is_active 를 읽는 곳은
    // '상태' 칸 배지 한 군데뿐이어야 한다(어떤 모양의 거름도 두 번째 읽기가 된다).
    assert.deepEqual(tableCode.match(/\bis_active\b/g), ['is_active'], '장소 관리 표가 배지 밖에서 is_active 를 읽는다(crit8)');
    assert.match(tableCode, /fac\.is_active === false \?/, '상태 칸이 비활성 배지를 그리지 않는다');
  }

  console.log('admin facility list tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
