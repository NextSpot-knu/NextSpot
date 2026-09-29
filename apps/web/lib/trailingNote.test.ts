import assert from 'node:assert/strict';
import { splitTrailingNote } from './trailingNote';
import ko from './i18n/messages/ko.json';
import en from './i18n/messages/en.json';
import ja from './i18n/messages/ja.json';
import zh from './i18n/messages/zh.json';

// 영어: 괄호 앞 공백은 본문 쪽에 남는다 — 그 자리에서만 줄이 바뀐다.
assert.deepEqual(splitTrailingNote('Photos: ⓒ TourAPI (unless credited otherwise)'), {
  lead: 'Photos: ⓒ TourAPI ',
  note: '(unless credited otherwise)',
});
// 전각 괄호(일본어·중국어).
assert.deepEqual(splitTrailingNote('写真: ⓒ TourAPI（出典を別記したものを除く）'), {
  lead: '写真: ⓒ TourAPI',
  note: '（出典を別記したものを除く）',
});
// 끝이 괄호가 아니거나, 괄호뿐이면 그대로.
assert.deepEqual(splitTrailingNote('Data: ⓒ TourAPI · KMA'), { lead: 'Data: ⓒ TourAPI · KMA', note: null });
assert.deepEqual(splitTrailingNote('(note only)'), { lead: '(note only)', note: null });
// 가운데 괄호는 건드리지 않고 끝 괄호만.
assert.deepEqual(splitTrailingNote('A (b) c (d)'), { lead: 'A (b) c ', note: '(d)' });

// 실제 하단 출처 줄(대기 보드·추천): 네 언어 모두 덧붙임이 떨어지고, 이어 붙이면 원문 그대로.
for (const [locale, messages] of Object.entries({ ko, en, ja, zh })) {
  for (const screen of ['waiting', 'recommend'] as const) {
    const line = messages[screen].dataAttribution;
    const { lead, note } = splitTrailingNote(line);
    assert.ok(note, `${locale} ${screen}: 끝 괄호 덧붙임`);
    assert.equal(lead + note, line, `${locale} ${screen}: 글자 손실 없음`);
  }
}

console.log('trailing note tests passed');
