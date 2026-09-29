// 화면 하단 ⓒ한국관광공사 TourAPI 표시가 Wikimedia(CC) 사진의 출처로 읽히지 않는다(PM 규칙 2026-09-28).
// /waiting·/explore/recommend 는 Wikimedia 대체 사진을 그 사진 아래 출처와 함께 보여 준다 — 하단 줄이 '사진'을
// 말한다면, 따로 출처를 적은 사진은 빠진다고 같은 줄에서 밝혀야 한다.
import assert from 'node:assert/strict';
import ko from './messages/ko.json';
import en from './messages/en.json';
import ja from './messages/ja.json';
import zh from './messages/zh.json';

const LOCALES = { ko, en, ja, zh } as const;
// 로케일별 '사진' 과 '따로 출처를 적은 것 제외' 표현. 하단 줄은 390px 폰에서 두 줄 안에 들어가야 해서
// '사진' 을 두 번 말하지 않는다(예전 영어 문구는 photos 를 되풀이해 세 줄로 접혔다).
// 여기서는 문구만 본다 — 실제 줄 수(360·390px, 네 언어)는 e2e/mobile-locales.spec.ts 가 잰다.
const PHOTO_WORD: Record<keyof typeof LOCALES, RegExp> = { ko: /사진/g, en: /photo/gi, ja: /写真/g, zh: /照片/g };
const SCOPED: Record<keyof typeof LOCALES, RegExp> = {
  ko: /\(출처를 따로 적은 것 제외\)/,
  en: /\(unless credited otherwise\)/,
  ja: /（出典を別記したものを除く）/,
  zh: /（另有注明者除外）/,
};

for (const [locale, messages] of Object.entries(LOCALES) as [keyof typeof LOCALES, typeof ko][]) {
  for (const screen of ['waiting', 'recommend'] as const) {
    const line = messages[screen].dataAttribution;
    assert.match(line, /ⓒ/, `${locale} ${screen}: ⓒ 표기`);
    assert.match(line, /TourAPI/, `${locale} ${screen}: TourAPI 표기`);
    const photoMentions = line.match(PHOTO_WORD[locale])?.length ?? 0;
    if (photoMentions > 0) {
      assert.match(line, SCOPED[locale], `${locale} ${screen}: 하단 ⓒ 줄이 출처를 따로 적은 Wikimedia 사진까지 덮는다`);
    }
    assert.ok(photoMentions <= 1, `${locale} ${screen}: '사진' 을 되풀이한다 — 폰에서 줄이 늘어난다`);
  }
}

console.log('footer attribution tests passed');
