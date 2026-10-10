import assert from 'node:assert/strict';
import { cardMenu, cuisineItems, menuItems } from './cardMenu';

// 실제 메뉴: TourAPI 대표·취급 + 경주시 메뉴, 중복 없이 앞에서부터. '등 …' 꼬리는 뗀다.
assert.deepEqual(menuItems({ firstMenu: '쌈밥 정식', treatMenu: '쌈밥 정식, 된장찌개' }), ['쌈밥 정식', '된장찌개']);
assert.deepEqual(menuItems({ first_menu: '들깨칼국수' }), ['들깨칼국수'], 'snake_case 도 읽는다');
assert.deepEqual(menuItems({ menu: '스시, 나가사키짬뽕 등 일식' }), ['스시', '나가사키짬뽕']);
assert.deepEqual(menuItems({ menu: '비빔만두, 탕수만두 /즉석떡볶이' }), ['비빔만두', '탕수만두', '즉석떡볶이']);
assert.deepEqual(menuItems({ menu: 'a,b,c,d,e,f' }, 3), ['a', 'b', 'c']);
assert.deepEqual(menuItems({ firstMenu: '   ', menu: 42 }), []);
assert.deepEqual(menuItems(null), []);
// 가격의 쉼표는 나누지 않고, '없음'·'-' 같은 자리표시 값은 음식으로 내지 않는다(리뷰 10-10).
assert.deepEqual(menuItems({ firstMenu: '쌈밥정식(15,000원), 된장찌개' }), ['쌈밥정식(15,000원)', '된장찌개']);
assert.deepEqual(menuItems({ firstMenu: '없음', treatMenu: '-', menu: '해당 없음' }), []);
assert.equal(cardMenu('restaurant', '황남 쌈밥', { firstMenu: '없음', cuisineTags: ['한식'] })?.kind, 'cuisine', '자리표시 메뉴면 분류로');
// '등심' · '등갈비' 의 '등' 은 꼬리가 아니다.
assert.deepEqual(menuItems({ menu: '한우 등심, 등갈비' }), ['한우 등심', '등갈비']);

// 카카오 분류: 맨 위 + 가장 자세한 것, 상호 조각은 뺀다.
assert.deepEqual(cuisineItems({ cuisineTags: ['한식', '육류,고기', '갈비'] }, '육부장갈비 본점'), ['한식', '육류·고기'],
  '가장 자세한 분류가 상호 조각(갈비 ⊂ 육부장갈비)이면 그 앞 분류');
assert.deepEqual(cuisineItems({ cuisine_tags: ['한식', '육류,고기', '곱창,막창'] }, '경주황소곱창 용강직영점'), ['한식', '곱창·막창']);
assert.deepEqual(cuisineItems({ cuisineTags: ['커피전문점', '컴포즈커피'] }, '컴포즈커피 황리단길점'), ['커피전문점']);
assert.deepEqual(cuisineItems({ cuisineTags: ['일식', '돈까스,우동'] }, '경도미야꼬우동'), ['일식', '돈까스·우동']);
assert.deepEqual(cuisineItems({ cuisineTags: ['한식'] }, '옹기종기보리밥'), ['한식']);
assert.deepEqual(cuisineItems({ cuisineTags: '양식' }, '이사부피자'), ['양식'], '문자열 하나도 읽는다');
assert.deepEqual(cuisineItems({ cuisineTags: [] }, 'x'), []);
assert.deepEqual(cuisineItems({}, 'x'), []);

// 우선순위: 실제 메뉴 → 분류. 음식점·카페만.
assert.deepEqual(cardMenu('restaurant', '우직 쌈밥집', { firstMenu: '쌈밥 정식', cuisineTags: ['한식'] }), { kind: 'menu', items: ['쌈밥 정식'] });
assert.deepEqual(cardMenu('restaurant', '가마솥족발', { cuisineTags: ['한식', '육류,고기', '족발,보쌈'] }), { kind: 'cuisine', items: ['한식', '족발·보쌈'] });
assert.deepEqual(cardMenu('cafe', '동대로놀이터찻집', { cuisineTags: ['전통찻집'] }), { kind: 'cuisine', items: ['전통찻집'] });
assert.equal(cardMenu('attraction', '대릉원', { firstMenu: '없음' }), null);
assert.equal(cardMenu('restaurant', '동경당', {}), null);

console.log('cardMenu tests passed');
