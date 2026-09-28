// Wikimedia 사진 출처 — 보이는 사진이 Wikimedia 일 때만, 늘 그 출처와 함께.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { creditedPhotoUrls, creditForDisplayedPhoto, isWikimediaUrl, wikimediaCredit } from './photoCredit';

const WIKI = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Bulguksa.jpg/1200px-Bulguksa.jpg';
const TOUR = 'https://tong.visitkorea.or.kr/cms/resource/01/1_image2_1.jpg';
const CAMEL = {
  imageSource: {
    provider: 'Wikimedia Commons',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Bulguksa.jpg',
    license: 'CC BY-SA 4.0',
    artist: 'Someone',
  },
};
const SNAKE = {
  image_source: {
    provider: 'Wikimedia Commons',
    source_url: 'https://commons.wikimedia.org/wiki/File:Bulguksa.jpg',
    license: 'CC BY 4.0',
    artist: '',
  },
};

// --- Wikimedia URL 판정 ---------------------------------------------------------------
assert.equal(isWikimediaUrl(WIKI), true);
assert.equal(isWikimediaUrl(TOUR), false);
assert.equal(isWikimediaUrl('https://evilwikimedia.org/x.jpg'), false);
assert.equal(isWikimediaUrl('not a url'), false);
assert.equal(isWikimediaUrl(null), false);

// --- 출처 읽기: API(camel)·Supabase 직접 읽기(snake) 둘 다 --------------------------------
assert.deepEqual(wikimediaCredit(CAMEL), {
  label: 'Someone', license: 'CC BY-SA 4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Bulguksa.jpg',
});
assert.deepEqual(wikimediaCredit(SNAKE), {
  label: 'Wikimedia Commons', license: 'CC BY 4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Bulguksa.jpg',
});
assert.equal(wikimediaCredit({ imageSource: null }), null); // 적재 배치가 걷어 낸 출처(null)
assert.equal(wikimediaCredit({ imageSource: { provider: 'Wikimedia Commons' } }), null); // 링크 없음
assert.equal(wikimediaCredit(null), null);

// --- 출처는 보이는 사진이 Wikimedia 일 때만 ------------------------------------------------
assert.equal(creditForDisplayedPhoto(TOUR, CAMEL), null, 'TourAPI 사진 아래에 Wikimedia 출처를 붙이지 않는다');
assert.equal(creditForDisplayedPhoto(WIKI, CAMEL)?.license, 'CC BY-SA 4.0');
assert.equal(creditForDisplayedPhoto(undefined, CAMEL), null);

// --- 출처 없는 Wikimedia 사진은 후보에서 빠진다 -------------------------------------------
assert.deepEqual(creditedPhotoUrls([TOUR, WIKI], CAMEL), [TOUR, WIKI]);
assert.deepEqual(creditedPhotoUrls([TOUR, WIKI], { imageSource: null }), [TOUR]);
assert.deepEqual(creditedPhotoUrls([WIKI], {}), []);

// --- 추천 카드(/main·/saved)가 이 판정으로 사진과 출처를 그린다 --------------------------------
const card = readFileSync(join(process.cwd(), 'components/RecommendationCard.tsx'), 'utf8');
assert.match(card, /creditedPhotoUrls\(/, 'RecommendationCard 가 출처 없는 Wikimedia 사진을 거른다');
assert.match(card, /creditForDisplayedPhoto\(cardImageUrl/, 'RecommendationCard 가 보이는 사진의 출처를 그린다');

console.log('photoCredit tests passed');
