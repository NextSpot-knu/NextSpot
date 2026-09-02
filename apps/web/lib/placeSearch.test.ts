import assert from 'node:assert/strict';
import { facilityMatchesSearch } from './placeSearch';

const porkPlace = {
  name: '황남숯불',
  address: '경북 경주시 포석로',
  features: { cuisine_tags: ['고깃집', '육류'], first_menu: '삼겹살' },
};
const cafe = {
  name: '봄날',
  address: '경북 경주시',
  features: { category: '카페', treat_menu: '아메리카노 / 카페라떼' },
};

assert.equal(facilityMatchesSearch(porkPlace, '돼지고기'), true);
assert.equal(facilityMatchesSearch(porkPlace, '구이 추천'), true);
assert.equal(facilityMatchesSearch(cafe, '라떼'), true);
assert.equal(facilityMatchesSearch(cafe, '아메리카노'), true);
assert.equal(facilityMatchesSearch(porkPlace, '물고기 체험'), false);
assert.equal(facilityMatchesSearch(porkPlace, '고기잡이'), false);
assert.equal(facilityMatchesSearch(cafe, '황남숯불'), false);

console.log('place search tests passed');


// ── apiClient 를 거친 실제 형태(camelCase) ─────────────────────────────────
// 위 픽스처들은 전부 Supabase 원형(snake)이다. 그런데 프로덕션 호출부는 전부
// apiClient.get('/api/v1/infrastructures') 로 받은 **camelCase** 객체를 넘긴다
// (api-client 의 keysToCamel). 그 형태에 대한 픽스처가 없어서, features.cuisine_tags 와
// features.category_name 이 프로덕션에서 한 번도 매칭되지 않는데도 테스트는 초록이었다.

const porkPlaceCamel = {
  name: '황남숯불',
  address: '경북 경주시 포석로',
  features: { cuisineTags: ['고깃집', '육류'], firstMenu: '삼겹살' },
};
const cafeCamel = {
  name: '봄날',
  address: '경북 경주시',
  features: { categoryName: '카페', treatMenu: '아메리카노 / 카페라떼' },
};

assert.equal(facilityMatchesSearch(porkPlaceCamel, '고깃집'), true, 'cuisineTags 가 검색에 안 걸린다');
assert.equal(facilityMatchesSearch(porkPlaceCamel, '삼겹살'), true);
assert.equal(facilityMatchesSearch(cafeCamel, '카페'), true, 'categoryName 이 검색에 안 걸린다');
assert.equal(facilityMatchesSearch(cafeCamel, '아메리카노'), true);

// 두 형태가 같은 결과를 내야 한다 — 어느 경로로 들어오든 검색은 같아야 한다.
for (const q of ['고깃집', '삼겹살', '황남']) {
  assert.equal(
    facilityMatchesSearch(porkPlace, q),
    facilityMatchesSearch(porkPlaceCamel, q),
    `snake/camel 결과가 다르다: ${q}`,
  );
}

console.log('placeSearch camelCase tests passed');
