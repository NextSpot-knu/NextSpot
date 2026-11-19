import assert from 'node:assert/strict';

import { parseShareParam } from '@/lib/courseShare';
import { clipboardText, shareWithFallback, type ShareDeps } from './shareCore';
import { WEB_ORIGIN, courseShareUrl, recommendShareUrl, reshareCourseUrl } from './shareUrls';

async function main() {
  // --- 링크 형식(웹과 같다) ---
  assert.equal(WEB_ORIGIN, 'https://nextspot-nu.vercel.app');
  assert.equal(courseShareUrl([]), null);
  const url = courseShareUrl([
    { id: 'aaa', offsetMin: 12.4, congestion: 0.31 },
    { id: 'bbb', offsetMin: 40, congestion: null },
  ]);
  assert.ok(url);
  const parsed = new URL(url);
  assert.equal(parsed.origin, WEB_ORIGIN);
  assert.equal(parsed.pathname, '/course');
  assert.equal(parsed.searchParams.get('ref'), 'share');
  const back = parseShareParam(parsed.searchParams.get('s'));
  assert.deepEqual(back.stops, [
    { id: 'aaa', offsetMin: 12, congestion: 0.31 },
    { id: 'bbb', offsetMin: 40, congestion: null },
  ]);
  assert.ok(back.sharedAtMin && back.sharedAtMin > 0);

  assert.equal(reshareCourseUrl('123~a.1.-'), `${WEB_ORIGIN}/course?s=123~a.1.-&ref=share`);
  assert.equal(reshareCourseUrl(null), null);

  assert.equal(
    recommendShareUrl({ facilityId: 'f-1 2', lat: 35.83, lng: 129.21 }),
    `${WEB_ORIGIN}/explore/recommend?facilityId=f-1%202&lat=35.83&lng=129.21&ref=share`,
  );
  assert.equal(
    recommendShareUrl({ name: ' 황남빵 ', type: 'cafe', lat: 1, lng: 2 }),
    `${WEB_ORIGIN}/explore/recommend?name=${encodeURIComponent('황남빵')}&type=cafe&lat=1&lng=2&ref=share`,
  );
  assert.equal(
    recommendShareUrl({ name: 'x', type: null, lat: 1, lng: 2 }, 'http://localhost:3000'),
    'http://localhost:3000/explore/recommend?name=x&type=&lat=1&lng=2&ref=share',
  );

  // --- 공유 흐름 ---
  const input = { title: 'NextSpot', message: '지금 한산해요', url: 'https://x/y' };
  assert.equal(clipboardText(input), '지금 한산해요 https://x/y');
  assert.equal(clipboardText({ title: 't', url: 'https://x' }), 'https://x');

  const copied: string[] = [];
  const deps = (sheet: ShareDeps['openSheet'], copy: ShareDeps['copy'] = async (t) => { copied.push(t); return true; }): ShareDeps => ({ openSheet: sheet, copy });

  assert.equal(await shareWithFallback(input, deps(async () => 'shared')), 'shared');
  assert.equal(await shareWithFallback(input, deps(async () => 'dismissed')), 'dismissed', '닫기는 실패가 아니다');
  assert.equal(copied.length, 0, '시트가 되면 복사하지 않는다');

  assert.equal(await shareWithFallback(input, deps(async () => { throw new Error('x'); })), 'copied');
  assert.deepEqual(copied, ['지금 한산해요 https://x/y']);

  assert.equal(
    await shareWithFallback(input, deps(async () => { throw new Error('x'); }, async () => false)),
    'failed',
  );
  assert.equal(
    await shareWithFallback(input, deps(async () => { throw new Error('x'); }, async () => { throw new Error('y'); })),
    'failed',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
