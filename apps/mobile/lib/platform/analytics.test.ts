import assert from 'node:assert/strict';

import {
  EVENT_PROPS,
  FLUSH_DELAY_MS,
  MAX_BATCH,
  USAGE_EVENTS,
  createTracker,
  createUsageRecorder,
  usageCardProps,
  type UsageRecorderDeps,
  type UsageRow,
} from './analyticsCore';

const flush = () => new Promise((r) => setTimeout(r, 0));

function recorderHarness(overrides: Partial<UsageRecorderDeps> = {}) {
  const sent: UsageRow[][] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  let error: unknown = null;
  const deps: UsageRecorderDeps = {
    enabled: () => true,
    insert: () => async (rows) => {
      sent.push(rows);
      return { error };
    },
    anonId: () => 'anon-1234',
    sessionId: () => 'sess-1234',
    page: () => '/explore/recommend',
    locale: () => 'en',
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    ...overrides,
  };
  return {
    recorder: createUsageRecorder(deps),
    sent,
    timers,
    fail(e: unknown) {
      error = e;
    },
    fire() {
      for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
    },
  };
}

async function main() {
  // DB CHECK 와 같은 목록
  assert.deepEqual([...USAGE_EVENTS], [
    'page_view', 'rec_shown', 'rec_accept', 'rec_drive', 'rec_next', 'rec_later',
    'visit_arrived', 'visit_congestion', 'congestion_report',
  ]);

  // 2초 묶음 — 타이머 하나, 행 모양
  {
    const h = recorderHarness();
    h.recorder.trackEvent('page_view');
    h.recorder.trackEvent('rec_shown', usageCardProps({ id: 42, type: 'cafe' }, 1));
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, FLUSH_DELAY_MS);
    assert.equal(h.sent.length, 0);
    h.fire();
    await flush();
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.sent[0][1], {
      anon_id: 'anon-1234',
      session_id: 'sess-1234',
      event: 'rec_shown',
      page: '/explore/recommend',
      locale: 'en',
      props: { facility_id: '42', type: 'cafe', rank: 1 },
    });
  }

  // 20건이면 바로 보낸다
  {
    const h = recorderHarness();
    for (let i = 0; i < MAX_BATCH; i += 1) h.recorder.trackEvent('rec_next');
    await flush();
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].length, MAX_BATCH);
    assert.ok(h.timers[0].cancelled, '바로 보냈으면 타이머는 취소');
  }

  // 백그라운드 전환 같은 수동 flush
  {
    const h = recorderHarness();
    h.recorder.trackEvent('visit_arrived');
    await h.recorder.flush();
    assert.equal(h.sent.length, 1);
    assert.equal(h.recorder.pending, 0);
  }

  // 꺼져 있으면(빌드 설정·내부 지역) 쌓지 않는다
  {
    const h = recorderHarness({ enabled: () => false });
    h.recorder.trackEvent('page_view');
    assert.equal(h.recorder.pending, 0);
    assert.equal(h.timers.length, 0);
  }
  // 전송 수단·익명 번호가 없으면 쌓지 않는다
  {
    const h = recorderHarness({ insert: () => null });
    h.recorder.trackEvent('page_view');
    assert.equal(h.recorder.pending, 0);
    const h2 = recorderHarness({ anonId: () => null });
    h2.recorder.trackEvent('page_view');
    assert.equal(h2.recorder.pending, 0);
  }
  // 목록에 없는 이벤트는 버린다
  {
    const h = recorderHarness();
    h.recorder.trackEvent('nope' as never);
    assert.equal(h.recorder.pending, 0);
  }
  // 첫 실패 뒤에는 그만 보낸다(웹과 같다)
  {
    const h = recorderHarness();
    h.fail({ message: 'relation does not exist' });
    h.recorder.trackEvent('page_view');
    await h.recorder.flush();
    assert.ok(h.recorder.stopped);
    h.recorder.trackEvent('page_view');
    assert.equal(h.recorder.pending, 0);
  }
  // 긴 경로·언어는 자른다
  {
    const h = recorderHarness({ page: () => '/x'.repeat(100), locale: () => 'zh-Hant-TW-x' });
    h.recorder.trackEvent('page_view');
    await h.recorder.flush();
    assert.equal(h.sent[0][0].page.length, 120);
    assert.equal(h.sent[0][0].locale, 'zh-Hant-');
  }

  // --- /events/track ---
  type Post = { body: unknown };
  function trackerHarness(statuses: number[] = [], opts: { enabled?: boolean; skips?: boolean } = {}) {
    const posts: Post[] = [];
    let skips = opts.skips ?? false;
    let marked = false;
    const tracker = createTracker({
      enabled: () => opts.enabled ?? true,
      post: () => async (payload) => {
        posts.push({ body: JSON.parse(payload) });
        const status = statuses.shift() ?? 200;
        return { ok: status < 400, status };
      },
      serverSkipsStroller: () => skips,
      markServerSkipsStroller: () => {
        skips = true;
        marked = true;
      },
    });
    return { tracker, posts, get marked() { return marked; } };
  }
  {
    const h = trackerHarness();
    h.tracker.track('navigation_started', { facility_type: 'cafe', walk_minutes: 4, lat: 35.1 });
    h.tracker.track('unknown_event', { a: 1 });
    await flush();
    assert.deepEqual(h.posts.map((p) => p.body), [
      { event: 'navigation_started', props: { facility_type: 'cafe', walk_minutes: 4 } },
    ], '허용 속성만, 모르는 이벤트는 버린다');
  }
  {
    const h = trackerHarness([], { enabled: false });
    h.tracker.track('trip_resumed', { facility_type: 'cafe' });
    await flush();
    assert.equal(h.posts.length, 0);
  }
  // 유모차 422 → 빼고 한 번 더, 통하면 표시
  {
    const h = trackerHarness([422, 200]);
    h.tracker.track('context_applied', { required_attributes: ['stroller', 'wheelchair'], categories: ['cafe'] });
    await flush();
    await flush();
    await flush();
    assert.deepEqual(h.posts.map((p) => p.body), [
      { event: 'context_applied', props: { required_attributes: ['stroller', 'wheelchair'], categories: ['cafe'] } },
      { event: 'context_applied', props: { required_attributes: ['wheelchair'], categories: ['cafe'] } },
    ]);
    assert.ok(h.marked);
  }
  {
    const h = trackerHarness([], { skips: true });
    h.tracker.track('context_applied', { required_attributes: ['stroller'] });
    await flush();
    assert.deepEqual(h.posts.map((p) => p.body), [{ event: 'context_applied', props: { required_attributes: [] } }]);
  }
  // 전송 실패도 삼킨다
  {
    const tracker = createTracker({
      enabled: () => true,
      post: () => () => Promise.reject(new Error('offline')),
      serverSkipsStroller: () => false,
      markServerSkipsStroller: () => {},
    });
    tracker.track('trip_resumed', { facility_type: 'cafe' });
    tracker.track('context_applied', { required_attributes: ['stroller'] });
    await flush();
  }
  assert.ok(EVENT_PROPS.visit_confirmed.has('rating'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
