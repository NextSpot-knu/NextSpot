// 화면 하단 ⓒ한국관광공사 TourAPI 표시가 Wikimedia(CC) 사진의 출처로 읽히지 않는다(PM 규칙 2026-09-28).
// /waiting·/explore/recommend 는 Wikimedia 대체 사진을 그 사진 아래 출처와 함께 보여 준다 — 하단 줄이 '사진'을
// 말한다면, 따로 출처를 적은 사진은 빠진다고 같은 줄에서 밝혀야 한다.
import assert from 'node:assert/strict';
import ko from './messages/ko.json';
import en from './messages/en.json';
import ja from './messages/ja.json';
import zh from './messages/zh.json';

const LOCALES = { ko, en, ja, zh } as const;
// 로케일별 '사진' 과 '따로 출처를 적은 사진 제외' 표현.
const PHOTO_WORD: Record<keyof typeof LOCALES, RegExp> = { ko: /사진/, en: /photo/i, ja: /写真/, zh: /照片/ };
const SCOPED: Record<keyof typeof LOCALES, RegExp> = {
  ko: /출처를 따로 적은 사진 제외/,
  en: /except photos credited separately/,
  ja: /個別に出典を記した写真を除く/,
  zh: /单独注明来源的照片除外/,
};

for (const [locale, messages] of Object.entries(LOCALES) as [keyof typeof LOCALES, typeof ko][]) {
  for (const screen of ['waiting', 'recommend'] as const) {
    const line = messages[screen].dataAttribution;
    assert.match(line, /ⓒ/, `${locale} ${screen}: ⓒ 표기`);
    assert.match(line, /TourAPI/, `${locale} ${screen}: TourAPI 표기`);
    if (PHOTO_WORD[locale].test(line)) {
      assert.match(line, SCOPED[locale], `${locale} ${screen}: 하단 ⓒ 줄이 출처를 따로 적은 Wikimedia 사진까지 덮는다`);
    }
  }
}

console.log('footer attribution tests passed');
