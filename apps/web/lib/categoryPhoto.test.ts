import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORY_PHOTO_KEYS, categoryPhotoKey, categoryPhotoUrl, cuisineTagsOf } from './categoryPhoto';

// 구체 업종이 넓은 업종보다 먼저 — 실데이터에 흔한 태그 조합(2026-11-25 운영 DB 상위 조합).
assert.equal(categoryPhotoKey('restaurant', ['한식', '육류,고기']), 'korean_bbq');
assert.equal(categoryPhotoKey('restaurant', ['한식', '육류,고기', '닭요리']), 'korean_bbq');
assert.equal(categoryPhotoKey('restaurant', ['한식', '해물,생선', '회']), 'seafood');
assert.equal(categoryPhotoKey('restaurant', ['한식', '국수', '칼국수']), 'noodles');
assert.equal(categoryPhotoKey('restaurant', ['한식', '국밥']), 'soup');
assert.equal(categoryPhotoKey('restaurant', ['한식', '두부전문점']), 'tofu');
assert.equal(categoryPhotoKey('restaurant', ['한식']), 'korean');
assert.equal(categoryPhotoKey('restaurant', ['술집', '일본식주점']), 'pub');
assert.equal(categoryPhotoKey('restaurant', ['일식', '돈까스,우동']), 'japanese');
assert.equal(categoryPhotoKey('restaurant', ['중식', '중국요리']), 'chinese');
assert.equal(categoryPhotoKey('restaurant', ['분식']), 'bunsik');
assert.equal(categoryPhotoKey('restaurant', ['치킨']), 'chicken');
assert.equal(categoryPhotoKey('restaurant', ['양식', '피자']), 'western');
assert.equal(categoryPhotoKey('cafe', ['간식', '제과,베이커리']), 'bakery');
assert.equal(categoryPhotoKey('cafe', ['간식', '떡,한과']), 'ricecake');
assert.equal(categoryPhotoKey('cafe', ['테마카페', '디저트카페']), 'cafe_theme');
assert.equal(categoryPhotoKey('cafe', ['커피전문점', '이디야커피']), 'cafe');
assert.equal(categoryPhotoKey('cafe', ['전통찻집']), 'tea');

// 태그가 없거나 모르는 태그면 유형으로. 음식점·카페가 아니면 업종 사진이 없다.
assert.equal(categoryPhotoKey('cafe', []), 'cafe');
assert.equal(categoryPhotoKey('restaurant', ['처음 보는 업종']), 'restaurant');
assert.equal(categoryPhotoKey('attraction', ['한식']), null);
assert.equal(categoryPhotoKey('culture', []), null);
assert.equal(categoryPhotoKey(undefined, []), null);

// features 는 API(camel)·Supabase 직접 읽기(snake) 두 모양. 문자열이 아닌 값은 버린다.
assert.deepEqual(cuisineTagsOf({ cuisineTags: ['한식', ' 국밥 ', 3, ''] }), ['한식', '국밥']);
assert.deepEqual(cuisineTagsOf({ cuisine_tags: ['분식'] }), ['분식']);
assert.deepEqual(cuisineTagsOf({ cuisine_tags: '한식' }), []);
assert.deepEqual(cuisineTagsOf(null), []);
assert.equal(categoryPhotoUrl('restaurant', { cuisine_tags: ['분식'] }), '/category/bunsik.webp');
assert.equal(categoryPhotoUrl('attraction', null), null);

// 모든 키에 사진 파일이 있다 — 없으면 표지 자리에 빈 배경이 깔린다.
const publicDir = join(process.cwd(), 'public', 'category');
for (const key of CATEGORY_PHOTO_KEYS) {
  assert.ok(existsSync(join(publicDir, `${key}.webp`)), `public/category/${key}.webp 가 없다`);
}

console.log('categoryPhoto.test: ok');
