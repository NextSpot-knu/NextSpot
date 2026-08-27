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
