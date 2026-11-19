import assert from 'node:assert/strict';
import { createElement } from 'react';

import { WORD_JOINER as J, keepKoreanWords, keepKoreanWordsInChildren, stripWordJoiners } from './koreanWordKeep';

assert.equal(keepKoreanWords('안녕 하세요'), `안${J}녕 하${J}세${J}요`);
assert.equal(keepKoreanWords('가까운 곳, 추천!'), `가${J}까${J}운 곳, 추${J}천!`);
assert.equal(keepKoreanWords('Hello world'), 'Hello world');
assert.equal(keepKoreanWords('3분 걸어요'), `3분 걸${J}어${J}요`);
assert.equal(keepKoreanWords('A한B'), 'A한B');
assert.equal(keepKoreanWords(''), '');
assert.equal(keepKoreanWords(keepKoreanWords('한글')), `한${J}글`); // 두 번 걸어도 한 번만
assert.equal(stripWordJoiners(keepKoreanWords('안녕 하세요')), '안녕 하세요');

assert.equal(keepKoreanWordsInChildren('한글'), `한${J}글`);
assert.equal(keepKoreanWordsInChildren(5), 5);
assert.equal(keepKoreanWordsInChildren(null), null);
const el = createElement('b', { key: 'x' }, '한글');
const out = keepKoreanWordsInChildren(['한글 ', el, 3]) as unknown[];
assert.equal(out[0], `한${J}글 `);
assert.equal((out[1] as { props: { children: string } }).props.children, '한글'); // 겹친 요소는 건드리지 않는다
assert.equal(out[2], 3);

console.log('koreanWordKeep ok');
