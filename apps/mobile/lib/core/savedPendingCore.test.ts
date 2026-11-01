import assert from 'node:assert/strict';

import { deleteWithPending } from './savedPendingCore';

function harness(remoteResult: boolean | 'throw') {
  let pending: string[] = [];
  const log: string[] = [];
  let pendingDuringDelete: string[] | null = null;
  const deps = {
    loadPending: () => [...pending],
    writePending: (ids: string[]) => {
      pending = [...ids];
      log.push(`write:${ids.join(',')}`);
    },
    deleteRemote: async (id: string) => {
      log.push(`delete:${id}`);
      pendingDuringDelete = [...pending];
      if (remoteResult === 'throw') throw new Error('net');
      return remoteResult;
    },
  };
  return { deps, log, get pending() { return pending; }, set pending(v: string[]) { pending = v; }, get during() { return pendingDuringDelete; } };
}

async function main() {
  // 성공 — 원격 삭제가 시작되기 전에 보류 목록에 들어가 있고, 끝나면 빠진다
  {
    const h = harness(true);
    assert.equal(await deleteWithPending('a', h.deps), true);
    assert.deepEqual(h.during, ['a'], '원격 삭제 중에는 보류 목록에 있다(동시 syncSaved 가 되살리지 않게)');
    assert.deepEqual(h.log, ['write:a', 'delete:a', 'write:']);
    assert.deepEqual(h.pending, []);
  }

  // 실패 — 보류 목록에 남는다(다음 syncSaved 가 다시 지운다)
  {
    const h = harness(false);
    assert.equal(await deleteWithPending('a', h.deps), false);
    assert.deepEqual(h.pending, ['a']);
  }
  {
    const h = harness('throw');
    assert.equal(await deleteWithPending('a', h.deps), false);
    assert.deepEqual(h.pending, ['a']);
  }

  // 이미 보류 중이면 중복으로 넣지 않고, 성공하면 그 id 만 뺀다(다른 보류는 남긴다)
  {
    const h = harness(true);
    h.pending = ['x', 'a'];
    assert.equal(await deleteWithPending('a', h.deps), true);
    assert.deepEqual(h.log, ['delete:a', 'write:x']);
    assert.deepEqual(h.pending, ['x']);
  }

  console.log('savedPendingCore.test OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
