// Wikimedia 사진 출처 — 보이는 사진이 Wikimedia 일 때만, 늘 그 출처와 함께.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { creditedPhotoUrls, creditForDisplayedPhoto, imageSourceOf, isWikimediaUrl, wikimediaCredit } from './photoCredit';

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
  kind: 'wikimedia', label: 'Someone', license: 'CC BY-SA 4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Bulguksa.jpg',
});
assert.deepEqual(wikimediaCredit(SNAKE), {
  kind: 'wikimedia', label: 'Wikimedia Commons', license: 'CC BY 4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Bulguksa.jpg',
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

// --- URL 판정: 대소문자·공백·다른 위키 호스트·깨진 주소 --------------------------------------
assert.equal(isWikimediaUrl('  HTTPS://UPLOAD.WIKIMEDIA.ORG/wikipedia/commons/a/ab/X.jpg  '), true);
assert.equal(isWikimediaUrl('https://upload.wikimedia.org.evil.example/x.jpg'), false, '접미 호스트 위장');
assert.equal(isWikimediaUrl('https://example.com/?u=https://upload.wikimedia.org/x.jpg'), false, '쿼리 속 주소');
assert.equal(isWikimediaUrl('//upload.wikimedia.org/x.jpg'), false, '스킴 없는 주소는 판정하지 않는다');
assert.equal(isWikimediaUrl('http://'), false);
assert.equal(isWikimediaUrl(''), false);
assert.equal(isWikimediaUrl(42), false);
assert.equal(isWikimediaUrl('https://tong.visitkorea.or.kr/cms/resource/wikimedia.org.jpg'), false, '경로 속 이름');

// --- 출처 원본: camel·snake·깨진 모양 ------------------------------------------------------
assert.deepEqual(imageSourceOf(CAMEL), CAMEL.imageSource);
assert.deepEqual(imageSourceOf(SNAKE), SNAKE.image_source);
assert.equal(imageSourceOf({ imageSource: 'CC BY' }), null);
assert.equal(imageSourceOf({ imageSource: ['x'] }), null);
assert.equal(imageSourceOf(undefined), null);
// 카멜 필드명을 가진 snake 객체(Supabase 직접 읽기 + 부분 변환)도 읽는다.
assert.equal(wikimediaCredit({ image_source: { sourceUrl: 'https://commons.wikimedia.org/wiki/File:A.jpg' } })?.label, 'Wikimedia');

// --- 원문 링크가 없거나 링크로 걸면 안 되는 주소면 출처가 없는 것으로 본다 ---------------------
assert.equal(wikimediaCredit({ image_source: { provider: 'Wikimedia Commons', license: 'CC BY 4.0' } }), null, 'source_url 없음');
assert.equal(wikimediaCredit({ image_source: { source_url: '   ' } }), null, '빈 source_url');
assert.equal(wikimediaCredit({ imageSource: { sourceUrl: 'javascript:alert(1)' } }), null, 'javascript: 링크 금지');
assert.equal(wikimediaCredit({ imageSource: { sourceUrl: 'data:text/html,<b>x</b>' } }), null, 'data: 링크 금지');
assert.equal(wikimediaCredit({ imageSource: { sourceUrl: 'not a url' } }), null, '깨진 원문 주소');
assert.equal(wikimediaCredit({ imageSource: { sourceUrl: 42 } }), null);
assert.equal(
  wikimediaCredit({ imageSource: { sourceUrl: ' https://commons.wikimedia.org/wiki/File:A.jpg ', artist: '  ' } })?.sourceUrl,
  'https://commons.wikimedia.org/wiki/File:A.jpg',
);
// 출처 링크가 깨졌으면 그 Wikimedia 사진도 띄우지 않는다(출처 없이 보이면 안 된다).
assert.deepEqual(creditedPhotoUrls([TOUR, WIKI], { imageSource: { sourceUrl: 'javascript:alert(1)' } }), [TOUR]);

// --- 대기 보드 시나리오: TourAPI 대표 + 갤러리 Wikimedia 대체 사진 ----------------------------
// 대표 사진이 보이는 동안에는 출처가 없고, 대표가 깨져 Wikimedia 로 넘어가면 그때 출처가 붙는다.
const boardUrls = creditedPhotoUrls([TOUR, WIKI], SNAKE);
assert.deepEqual(boardUrls, [TOUR, WIKI]);
assert.equal(creditForDisplayedPhoto(boardUrls[0], SNAKE), null, '대표(TourAPI) 사진 아래엔 출처 없음');
assert.equal(creditForDisplayedPhoto(boardUrls[1], SNAKE)?.sourceUrl, SNAKE.image_source.source_url, '대체 사진엔 출처');
assert.equal(creditForDisplayedPhoto(boardUrls[2], SNAKE), null, '사진이 전부 실패하면 출처도 없다');
assert.equal(creditForDisplayedPhoto(null, SNAKE), null);
assert.equal(creditForDisplayedPhoto('https://evilwikimedia.org/x.jpg', CAMEL), null);

// --- 사진이 뜨는 화면이 모두 이 판정으로 사진과 출처를 그린다 ----------------------------------
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const card = read('components/RecommendationCard.tsx'); // /main 상세 시트 · /saved
assert.match(card, /creditedPhotoUrls\(/, 'RecommendationCard 가 출처 없는 Wikimedia 사진을 거른다');
assert.match(card, /creditForDisplayedPhoto\(cardImageUrl/, 'RecommendationCard 가 보이는 사진의 출처를 그린다');
assert.match(card, /<PhotoCreditLink /, 'RecommendationCard 가 공용 출처 줄을 쓴다');

const waiting = read('app/waiting/page.tsx');
assert.match(waiting, /creditedPhotoUrls\(row\.imageUrls/, '대기 보드가 출처 없는 Wikimedia 사진을 거른다');
// 대기 보드 출처가 보이는 사진을 같은 렌더에서 따라가는지는 photoCursor.test.ts 가 본다.
assert.doesNotMatch(waiting, /row\.imageSource\??\.sourceUrl/, '대기 보드가 보이는 사진과 무관하게 출처를 찍지 않는다');

const explore = read('app/explore/recommend/page.tsx');
assert.match(explore, /creditedPhotoUrls\(/, '추천 목록이 출처 없는 Wikimedia 사진을 거른다');
assert.match(explore, /creditForDisplayedPhoto\(photoUrl/, '추천 목록이 보이는 사진의 출처를 그린다');

const link = read('components/PhotoCreditLink.tsx');
assert.match(link, /target="_blank"/);
assert.match(link, /rel="noopener noreferrer"/, '새 창 링크는 opener 를 넘기지 않는다');
assert.match(link, /truncate/, '긴 작가 이름은 한 줄에서 말줄임');

console.log('photoCredit tests passed');
