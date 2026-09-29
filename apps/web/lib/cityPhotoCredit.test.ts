// 경주시 사진 출처 — features.city_photo.url 과 같은 사진이 보일 때만 '사진: 경주시', 짝 없는 경주시 사진은 띄우지 않는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cityPhotoCredit,
  cityPhotoOf,
  creditedPhotoUrls,
  creditForDisplayedPhoto,
  isCityPhotoUrl,
  mayShowPhotoCredit,
  photoCreditFeatures,
} from './photoCredit';

const CITY = 'https://www.gyeongju.go.kr/upload/content/thumb/20200101/menu_1.jpg';
const CITY_OTHER = 'https://www.gyeongju.go.kr/upload/content/thumb/20200101/menu_2.jpg';
const TOUR = 'https://tong.visitkorea.or.kr/cms/resource/01/1_image2_1.jpg';
const WIKI = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg';
const LICENSE = '공공데이터포털 15114465 경주시_경주문화관광_메뉴별음식점 · 이용허락범위 제한 없음';

// API 응답(keysToCamel)과 Supabase 직접 읽기(snake_case) 두 모양.
const CAMEL = {
  cityPhoto: { url: CITY, provider: '경주시', sourceUrl: 'https://www.gyeongju.go.kr/tour/', license: LICENSE, caption: '한식', conUid: 7 },
};
const SNAKE = {
  city_photo: { url: CITY, provider: '경주시', source_url: 'https://www.gyeongju.go.kr/tour/', license: LICENSE, con_uid: 7 },
};

// --- 경주시 사진 URL 판정 -------------------------------------------------------------------
assert.equal(isCityPhotoUrl(CITY), true);
assert.equal(isCityPhotoUrl('https://gyeongju.go.kr/upload/a.jpg'), true);
assert.equal(isCityPhotoUrl(TOUR), false);
assert.equal(isCityPhotoUrl(WIKI), false);
assert.equal(isCityPhotoUrl('https://notgyeongju.go.kr/a.jpg'), false, '접두 호스트 위장');
assert.equal(isCityPhotoUrl('https://www.gyeongju.go.kr.evil.example/a.jpg'), false, '접미 호스트 위장');
assert.equal(isCityPhotoUrl('https://tong.visitkorea.or.kr/gyeongju.go.kr.jpg'), false, '경로 속 이름');
assert.equal(isCityPhotoUrl(null), false);

// --- 출처 읽기: camel·snake 둘 다 ----------------------------------------------------------
assert.deepEqual(cityPhotoOf(CAMEL), CAMEL.cityPhoto);
assert.deepEqual(cityPhotoOf(SNAKE), SNAKE.city_photo);
assert.deepEqual(cityPhotoCredit(CAMEL), {
  kind: 'city', label: '경주시', license: LICENSE, sourceUrl: 'https://www.gyeongju.go.kr/tour/',
});
assert.deepEqual(cityPhotoCredit(SNAKE), {
  kind: 'city', label: '경주시', license: LICENSE, sourceUrl: 'https://www.gyeongju.go.kr/tour/',
});
assert.equal(cityPhotoCredit({ cityPhoto: null }), null, '적재 배치가 걷어 낸 출처(null)');
assert.equal(cityPhotoCredit({ city_photo: null }), null);
assert.equal(cityPhotoCredit({ cityPhoto: { provider: '경주시' } }), null, '짝지을 사진 url 이 없다');
assert.equal(cityPhotoCredit({ cityPhoto: { url: '   ' } }), null);
assert.equal(cityPhotoCredit({ cityPhoto: [CITY] }), null);
assert.equal(cityPhotoCredit({ cityPhoto: 'CITY' }), null);
assert.equal(cityPhotoCredit(null), null);
// 원문 링크가 없거나 링크로 걸면 안 되는 주소면 링크 없이 글자만(출처 줄 자체는 남는다).
assert.equal(cityPhotoCredit({ cityPhoto: { url: CITY } })?.sourceUrl, '');
assert.equal(cityPhotoCredit({ cityPhoto: { url: CITY, sourceUrl: 'javascript:alert(1)' } })?.sourceUrl, '');
assert.equal(cityPhotoCredit({ cityPhoto: { url: CITY } })?.kind, 'city');
// Wikimedia 출처(image_source)는 경주시 출처가 아니다 — 두 키는 섞이지 않는다.
assert.equal(cityPhotoCredit({ imageSource: { url: CITY, sourceUrl: 'https://commons.wikimedia.org/wiki/File:X.jpg' } }), null);

// --- 짝짓기: 보이는 사진 URL == city_photo.url 일 때만 --------------------------------------
assert.equal(creditForDisplayedPhoto(CITY, CAMEL)?.kind, 'city');
assert.equal(creditForDisplayedPhoto(CITY, SNAKE)?.kind, 'city');
assert.equal(creditForDisplayedPhoto(` ${CITY} `, SNAKE)?.kind, 'city', '앞뒤 공백은 같은 사진');
assert.equal(creditForDisplayedPhoto(TOUR, CAMEL), null, 'TourAPI 사진 아래에는 경주시 출처가 없다');
assert.equal(creditForDisplayedPhoto(CITY_OTHER, CAMEL), null, '다른 경주시 사진 아래에는 붙지 않는다');
assert.equal(creditForDisplayedPhoto(WIKI, CAMEL), null, 'Wikimedia 사진 아래에 경주시 출처가 붙지 않는다');
assert.equal(creditForDisplayedPhoto(null, CAMEL), null, '사진 없는 표지 아래에는 출처가 없다');
assert.equal(creditForDisplayedPhoto(undefined, CAMEL), null);
assert.equal(creditForDisplayedPhoto('', { cityPhoto: { url: '' } }), null);
assert.equal(creditForDisplayedPhoto(CITY, { cityPhoto: null }), null);

// --- 출처와 짝이 아닌 경주시 사진은 후보에서 빠진다 -----------------------------------------
assert.deepEqual(creditedPhotoUrls([CITY], CAMEL), [CITY]);
assert.deepEqual(creditedPhotoUrls([CITY], SNAKE), [CITY]);
assert.deepEqual(creditedPhotoUrls([CITY], {}), [], '출처 없는 경주시 사진');
assert.deepEqual(creditedPhotoUrls([CITY], { cityPhoto: null }), [], '걷어 낸 출처');
assert.deepEqual(creditedPhotoUrls([CITY], null), []);
assert.deepEqual(creditedPhotoUrls([CITY_OTHER, CITY], CAMEL), [CITY], '출처가 가리키지 않는 경주시 사진');
assert.deepEqual(creditedPhotoUrls([TOUR, CITY], SNAKE), [TOUR, CITY], 'TourAPI 사진은 그대로, 순서도 그대로');
assert.deepEqual(creditedPhotoUrls([TOUR, CITY], {}), [TOUR]);
// 두 출처가 한 행에 함께 있어도 각자 제 사진에만.
const BOTH = { ...SNAKE, image_source: { source_url: 'https://commons.wikimedia.org/wiki/File:X.jpg', license: 'CC BY 4.0' } };
assert.deepEqual(creditedPhotoUrls([WIKI, CITY], BOTH), [WIKI, CITY]);
assert.equal(creditForDisplayedPhoto(WIKI, BOTH)?.kind, 'wikimedia');
assert.equal(creditForDisplayedPhoto(CITY, BOTH)?.kind, 'city');
// 경주시 출처만 있고 Wikimedia 출처가 없으면 Wikimedia 사진은 여전히 빠진다.
assert.deepEqual(creditedPhotoUrls([WIKI, CITY], SNAKE), [CITY]);

// --- 출처 줄 자리: 후보 중 출처가 붙는 사진이 있을 때만 ------------------------------------
assert.equal(mayShowPhotoCredit([TOUR, CITY], CAMEL), true);
assert.equal(mayShowPhotoCredit([TOUR], CAMEL), false);
assert.equal(mayShowPhotoCredit([], CAMEL), false);
assert.equal(mayShowPhotoCredit([CITY_OTHER], CAMEL), false);

// --- 목록 행이 들고 다니는 출처 조각 -------------------------------------------------------
const slimCamel = photoCreditFeatures({ ...CAMEL, firstMenu: '국밥' });
assert.deepEqual(slimCamel, { imageSource: null, cityPhoto: CAMEL.cityPhoto });
assert.equal(creditForDisplayedPhoto(CITY, slimCamel)?.kind, 'city', '조각만으로 같은 판정');
const slimSnake = photoCreditFeatures(BOTH);
assert.equal(creditForDisplayedPhoto(CITY, slimSnake)?.kind, 'city');
assert.equal(creditForDisplayedPhoto(WIKI, slimSnake)?.kind, 'wikimedia');
assert.deepEqual(photoCreditFeatures(null), { imageSource: null, cityPhoto: null });

// --- 출처 줄 글자: 4로케일 한 키, 공용 출처 줄이 그 키로 그린다 ------------------------------
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const LINE = { ko: '사진: 경주시', en: 'Photo: Gyeongju City', ja: '写真: 慶州市', zh: '照片：庆州市' } as const;
for (const [locale, expected] of Object.entries(LINE)) {
  const messages = JSON.parse(read(`lib/i18n/messages/${locale}.json`)) as { common: Record<string, string> };
  assert.equal(messages.common.cityPhotoCredit, expected, `${locale} common.cityPhotoCredit`);
}
const link = read('components/PhotoCreditLink.tsx');
assert.match(link, /t\('common\.cityPhotoCredit'\)/, '경주시 출처 줄은 i18n 키로 그린다');
assert.match(link, /credit\.kind === 'city'/);

console.log('cityPhotoCredit tests passed');
