import assert from 'node:assert/strict';

import { countUnseenReplies, markInquiryRepliesSeen, readInquiries, repliedIds } from './inquiryCore';

function memStore(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; },
  };
}

const items = readInquiries({
  items: [
    { id: 1, type: '앱 버그', title: 'a', content: 'c', status: 'resolved', createdAt: '2026-11-01', replyBody: '답변', repliedAt: '2026-11-02' },
    { id: 'b', status: 'weird', replyBody: '   ' },
    null,
  ],
});
assert.equal(items.length, 3);
assert.equal(items[0].id, '1');
assert.equal(items[0].replyBody, '답변');
assert.equal(items[1].status, 'new', '모르는 상태는 new');
assert.equal(items[1].replyBody, null, '공백 답변은 답 없음');
assert.deepEqual(repliedIds(items), ['1']);
assert.deepEqual(readInquiries(undefined), []);
assert.deepEqual(readInquiries({ items: 'x' }), []);

const store = memStore();
assert.equal(countUnseenReplies(['1', '2'], store), 2);
markInquiryRepliesSeen(['1'], store);
assert.equal(countUnseenReplies(['1', '2'], store), 1);
markInquiryRepliesSeen(['2'], store);
assert.equal(countUnseenReplies(['1', '2'], store), 0, '합쳐 기록');
assert.equal(countUnseenReplies([], store), 0);
assert.equal(countUnseenReplies(['1'], memStore({ nextspot_seen_inquiry_replies: '{broken' })), 1, '손상은 안 읽음');
assert.equal(countUnseenReplies(['1'], null), 1, '저장소 없음은 안 읽음');
console.log('inquiryCore ok');
