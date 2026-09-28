// 대기 보드 사진 커서 — 보이는 사진과 그 출처가 같은 렌더에서 같은 값으로 정해진다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  advancePhotoCursor,
  creditForDisplayedPhoto,
  displayedPhotoUrl,
  photoListKey,
  type PhotoCursor,
} from './photoCredit';

const WIKI = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Bulguksa.jpg';
const TOUR_BROKEN = 'https://tong.visitkorea.or.kr/cms/resource/02/broken_image2_1.jpg';
const TOUR_NEW = 'https://tong.visitkorea.or.kr/cms/resource/03/new_image2_1.jpg';
const FEATURES = {
  imageSource: { sourceUrl: 'https://commons.wikimedia.org/wiki/File:Bulguksa.jpg', license: 'CC BY-SA 4.0', artist: 'A' },
};

// --- 커서 없음 = 첫 후보 ---------------------------------------------------------------
assert.equal(displayedPhotoUrl([TOUR_BROKEN, WIKI], undefined), TOUR_BROKEN);
assert.equal(displayedPhotoUrl([], undefined), null);

// --- 첫 렌더부터 Wikimedia 사진이면 같은 렌더에서 출처가 정해진다(캐시 복원 첫 페인트) ------------
const wikiFirst = displayedPhotoUrl([WIKI], undefined);
assert.equal(wikiFirst, WIKI);
assert.equal(creditForDisplayedPhoto(wikiFirst, FEATURES)?.license, 'CC BY-SA 4.0');

// --- 대표 사진이 깨지면 다음 후보로, 그 사진의 출처가 붙는다 ---------------------------------
const list1 = [TOUR_BROKEN, WIKI];
const afterBreak = advancePhotoCursor(list1, undefined, TOUR_BROKEN);
assert.deepEqual(afterBreak, { listKey: photoListKey(list1), index: 1 });
assert.equal(displayedPhotoUrl(list1, afterBreak), WIKI);
assert.equal(creditForDisplayedPhoto(displayedPhotoUrl(list1, afterBreak), FEATURES)?.label, 'A');

// --- 새로고침으로 목록이 바뀌면 같은 렌더에서 새 첫 후보(TourAPI)로 — 이전 Wikimedia 출처가 남지 않는다 ---
const list2 = [TOUR_NEW, WIKI];
const shown = displayedPhotoUrl(list2, afterBreak);
assert.equal(shown, TOUR_NEW);
assert.equal(creditForDisplayedPhoto(shown, FEATURES), null, 'TourAPI 사진 아래에 Wikimedia 출처 없음');

// --- 이미 지나간 사진의 늦은 onError 는 커서를 밀지 않는다 --------------------------------------
const cursor: PhotoCursor = { listKey: photoListKey(list1), index: 1 };
assert.equal(advancePhotoCursor(list1, cursor, TOUR_BROKEN), cursor, '같은 객체 — 상태 갱신 없음');
assert.equal(displayedPhotoUrl(list1, advancePhotoCursor(list1, cursor, TOUR_BROKEN)), WIKI);

// --- 후보를 다 쓰면 사진도 출처도 없다 -----------------------------------------------------
const exhausted = advancePhotoCursor(list1, cursor, WIKI);
assert.equal(displayedPhotoUrl(list1, exhausted), null);
assert.equal(creditForDisplayedPhoto(displayedPhotoUrl(list1, exhausted), FEATURES), null);

// --- 대기 보드가 이 커서로 사진과 출처를 한 값에서 그린다 -------------------------------------
const waiting = readFileSync(join(process.cwd(), 'app/waiting/page.tsx'), 'utf8');
assert.match(waiting, /displayedPhotoUrl\(photoUrls, photoCursors\[row\.facilityId\]\)/, '보이는 사진을 렌더 중에 계산');
assert.match(waiting, /creditForDisplayedPhoto\(photoUrl, photoFeatures\)/, '출처가 같은 값을 따른다');
assert.doesNotMatch(waiting, /onDisplayedUrl/, '자식이 effect 로 알려 주는 한 커밋 늦은 경로가 없다');

console.log('photoCursor tests passed');
