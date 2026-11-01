import assert from 'node:assert/strict';

import { createGuestMerge, GUEST_MERGE_KEY, GUEST_MERGE_TTL_MS, readCaptured, type SessionLike } from './guestMergeCore';

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      m.set(k, String(v));
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
    map: m,
  };
}

function harness(opts: { session?: SessionLike | null; mergeError?: unknown; retryable?: boolean } = {}) {
  const store = memoryStore();
  let now = 1_000_000;
  let session: SessionLike | null = opts.session ?? null;
  const merges: string[] = [];
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  const gm = createGuestMerge({
    store: () => store,
    now: () => now,
    getSession: async () => session,
    merge: async (token) => {
      merges.push(token);
      if (gate) await gate;
      if (opts.mergeError) throw opts.mergeError;
    },
    shouldRetry: () => opts.retryable ?? false,
  });
  return {
    gm,
    store,
    merges,
    setSession(s: SessionLike | null) {
      session = s;
    },
    advance(ms: number) {
      now += ms;
    },
    hold() {
      gate = new Promise<void>((r) => {
        release = r;
      });
    },
    release() {
      release?.();
      gate = null;
    },
  };
}

const guest: SessionLike = { access_token: 'guest-token', user: { id: 'g1', is_anonymous: true } };
const member: SessionLike = { access_token: 'member-token', user: { id: 'm1', is_anonymous: false } };

async function main() {
  // 잡기 → localStorage 에 {token, uid, at}
  {
    const h = harness({ session: guest });
    await h.gm.capture();
    const saved = JSON.parse(h.store.getItem(GUEST_MERGE_KEY) as string);
    assert.deepEqual(saved, { token: 'guest-token', uid: 'g1', at: 1_000_000 });
    // 가입 계정이면 잡지 않는다
    const h2 = harness({ session: member });
    await h2.gm.capture();
    assert.equal(h2.store.getItem(GUEST_MERGE_KEY), null);
  }

  // 다른 계정으로 로그인 → 합치고 지운다
  {
    const h = harness({ session: guest });
    await h.gm.capture();
    h.setSession(member);
    assert.equal(await h.gm.mergeCaptured(), true);
    assert.deepEqual(h.merges, ['guest-token']);
    assert.equal(h.store.getItem(GUEST_MERGE_KEY), null);
    assert.equal(await h.gm.mergeCaptured(), true, '잡은 것이 없으면 할 일 없음');
    assert.equal(h.merges.length, 1);
  }

  // 1시간이 지나면 버린다(서버에 보내지 않는다)
  {
    const h = harness({ session: guest });
    await h.gm.capture();
    h.setSession(member);
    h.advance(GUEST_MERGE_TTL_MS);
    assert.equal(await h.gm.mergeCaptured(), true);
    assert.equal(h.merges.length, 0);
    assert.equal(h.store.getItem(GUEST_MERGE_KEY), null);
  }

  // 아직 익명(같은 uid) — 남겨 두고 false
  {
    const h = harness({ session: guest });
    await h.gm.capture();
    assert.equal(await h.gm.mergeCaptured(), false);
    assert.ok(h.store.getItem(GUEST_MERGE_KEY));
  }

  // 일시 실패 — 남겨 두고 false / 영구 실패 — 지우고 true
  {
    const h = harness({ session: guest, mergeError: new Error('timeout'), retryable: true });
    await h.gm.capture();
    h.setSession(member);
    assert.equal(await h.gm.mergeCaptured(), false);
    assert.ok(h.store.getItem(GUEST_MERGE_KEY));

    const p = harness({ session: guest, mergeError: new Error('400'), retryable: false });
    await p.gm.capture();
    p.setSession(member);
    assert.equal(await p.gm.mergeCaptured(), true);
    assert.equal(p.store.getItem(GUEST_MERGE_KEY), null);
  }

  // 동시 호출은 한 번만 보낸다(single-flight), 끝나면 다시 부를 수 있다
  {
    const h = harness({ session: guest });
    await h.gm.capture();
    h.setSession(member);
    h.hold();
    const a = h.gm.mergeCaptured();
    const b = h.gm.mergeCaptured();
    assert.equal(a, b, '같은 약속');
    await new Promise((r) => setTimeout(r, 0));
    h.release();
    assert.deepEqual(await Promise.all([a, b]), [true, true]);
    assert.equal(h.merges.length, 1);
    assert.notEqual(h.gm.mergeCaptured(), a, '끝난 뒤에는 새로 돈다');
  }

  // 깨진 값·옛 모양(at 없음)은 지운다
  {
    const s = memoryStore();
    s.setItem(GUEST_MERGE_KEY, '{nope');
    assert.equal(readCaptured(s, 0), null);
    assert.equal(s.getItem(GUEST_MERGE_KEY), null);
    s.setItem(GUEST_MERGE_KEY, JSON.stringify({ token: 't', uid: 'u' }));
    assert.equal(readCaptured(s, 0), null);
    assert.equal(s.getItem(GUEST_MERGE_KEY), null);
    s.setItem(GUEST_MERGE_KEY, JSON.stringify({ token: 't', uid: 'u', at: 100 }));
    assert.equal(readCaptured(s, 50), null, '미래 시각(시계 되감김)도 믿지 않는다');
    assert.equal(readCaptured(null, 0), null);
  }

  console.log('ok guestMergeCore');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
