import assert from 'node:assert/strict';
import type { Session } from '@supabase/supabase-js';
import { createAnonymousSessionEnsurer } from './anonymousSession';

const guest = { user: { id: 'guest' } } as Session;
const member = { user: { id: 'member' } } as Session;

let current: Session | null = null;
let signInCalls = 0;
const ensure = createAnonymousSessionEnsurer(() => ({
  async getSession() {
    return { data: { session: current } };
  },
  async signInAnonymously() {
    signInCalls += 1;
    await Promise.resolve();
    current = guest;
    return { data: { session: guest }, error: null };
  },
}));

async function run() {
  const [first, concurrent] = await Promise.all([ensure(), ensure()]);
  assert.equal(first?.user.id, 'guest');
  assert.equal(concurrent?.user.id, 'guest');
  assert.equal(signInCalls, 1, 'concurrent bootstrap must create only one anonymous user');

  current = member;
  const afterAccountSwitch = await ensure();
  assert.equal(afterAccountSwitch?.user.id, 'member', 'completed guest session must not remain cached');
  assert.equal(signInCalls, 1);

  console.log('anonymous session tests passed');
}

void run();
