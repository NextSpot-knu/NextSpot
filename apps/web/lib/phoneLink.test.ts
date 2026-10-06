import assert from 'node:assert/strict';

import { telHref } from './phoneLink';

// 번호 하나.
assert.equal(telHref('054-750-8650'), 'tel:0547508650');
assert.equal(telHref('+82 54-750-8650'), 'tel:+82547508650');
// 여러 번호는 첫 번호만.
assert.equal(telHref('054-772-3843, 010-1234-5678'), 'tel:0547723843');
assert.equal(telHref('054-772-3843 / 054-772-3844'), 'tel:0547723843');
assert.equal(telHref('054-772-3843  010-1234-5678'), 'tel:0547723843');
// 끝자리 범위('~4')와 괄호 설명이 번호에 붙지 않는다 — 예전에는 'tel:05477238434'(없는 번호)였다.
assert.equal(telHref('054-772-3843~4'), 'tel:0547723843');
assert.equal(telHref('054-772-3843(매표소)'), 'tel:0547723843');
// 괄호로 감싼 지역번호는 번호의 일부다.
assert.equal(telHref('(054)772-3843'), 'tel:0547723843');
assert.equal(telHref('(054) 772-3843~4'), 'tel:0547723843');
// 걸 수 없는 값은 링크를 만들지 않는다.
assert.equal(telHref('문의 바람'), null);
assert.equal(telHref(''), null);
assert.equal(telHref(null), null);

console.log('phone link tests passed');
