import { strict as assert } from 'node:assert';
import { fetchAdminFacilityRows } from './adminFacilityList';

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

  console.log('admin facility list tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
