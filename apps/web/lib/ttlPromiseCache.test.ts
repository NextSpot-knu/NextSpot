// ttlPromiseCache — 장소 관리의 추정 피드 캐시(리뷰 10-07: 첫 응답을 화면 수명 내내 붙들고, 실패도 다시 묻지 않았다).

import assert from 'node:assert/strict';
import { ttlPromiseCache } from './ttlPromiseCache';

async function main() {
  // 수명 안에서는 한 번만 묻고 같은 결과를 나눠 쓴다.
  {
    let t = 0;
    let calls = 0;
    const get = ttlPromiseCache(async () => ++calls, 300_000, () => t);
    assert.equal(await get(), 1);
    t = 299_999;
    assert.equal(await get(), 1);
    assert.equal(calls, 1);
    // 수명이 지나면 새로 묻는다(새 관측과 오래된 추정이 짝지어지지 않게).
    t = 300_000;
    assert.equal(await get(), 2);
    assert.equal(calls, 2);
  }

  // 실패는 담아 두지 않는다 — 다음 호출이 바로 다시 묻는다(수명이 남아 있어도).
  {
    let calls = 0;
    const get = ttlPromiseCache(async () => {
      calls += 1;
      if (calls === 1) throw new Error('timeout');
      return 'ok';
    }, 300_000, () => 0);
    await assert.rejects(get(), /timeout/);
    assert.equal(await get(), 'ok');
    assert.equal(calls, 2);
    assert.equal(await get(), 'ok');
    assert.equal(calls, 2, '성공한 결과는 수명 동안 다시 묻지 않는다');
  }

  // 늦게 실패한 옛 조회가 그 뒤에 담긴 새 결과를 지우지 않는다.
  {
    let t = 0;
    let rejectFirst: (e: Error) => void = () => {};
    let calls = 0;
    const get = ttlPromiseCache(() => {
      calls += 1;
      if (calls === 1) return new Promise<string>((_, reject) => { rejectFirst = reject; });
      return Promise.resolve('fresh');
    }, 1000, () => t);
    const first = get();
    t = 1000;
    assert.equal(await get(), 'fresh');
    rejectFirst(new Error('late'));
    await assert.rejects(first, /late/);
    assert.equal(await get(), 'fresh');
    assert.equal(calls, 2);
  }

  console.log('ttlPromiseCache.test.ts OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
