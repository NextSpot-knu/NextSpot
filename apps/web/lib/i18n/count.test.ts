// 섹터 개수 칩 — 영어 '1 spots' 문법 오류가 /waiting 섹터 머리(카드 한 장짜리 문화시설 등)에 보였다.
import assert from 'node:assert/strict';
import { countKey } from './count';
import ko from './messages/ko.json';
import en from './messages/en.json';
import ja from './messages/ja.json';
import zh from './messages/zh.json';

assert.equal(countKey('waiting.sectorCount', 1), 'waiting.sectorCountOne');
for (const n of [0, 2, 3, 12]) assert.equal(countKey('waiting.sectorCount', n), 'waiting.sectorCount');

const fill = (template: string, n: number) => template.replace('{n}', String(n));
assert.equal(fill(en.waiting.sectorCountOne, 1), '1 spot');
assert.equal(fill(en.waiting.sectorCount, 3), '3 spots');
// 단·복수 구별이 없는 언어는 두 키가 같은 문장 — 키가 빠지면 원문 키가 화면에 나온다.
for (const [locale, messages] of Object.entries({ ko, ja, zh })) {
  assert.equal(messages.waiting.sectorCountOne, messages.waiting.sectorCount, `${locale}: 단수 키`);
}

console.log('count.test: ok');
