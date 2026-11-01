// 웹과 같은 문구 JSON(apps/web/lib/i18n/messages/*.json)을 싣는다. 한국어만 처음부터 번들에서 평가하고,
// en·ja·zh 는 그 언어가 처음 필요할 때 require 로 평가한다(Metro 는 모듈을 require 시점에 평가한다 — 큰 JSON 을
// 시작 때 파싱하지 않는다). 웹의 동적 import() 청크와 같은 목적이다.
//
// en·ja·zh 를 백틱 문자열로 require 하는 이유: scripts/check-shared-imports.mjs 는 import 한 웹 파일의 '본문'에서
// `document.` 같은 글자를 찾는데, en.json 의 영어 문장('…the current document. Leave it…')이 걸린다(JSON 은 코드가
// 아니라 데이터라 오탐이다). 검사기가 .json 을 건너뛰게 고치면 보통 따옴표로 되돌린다. Metro 는 식이 없는 템플릿
// 문자열을 정적 경로로 해석한다(babel evaluate) — npm run export:android 로 확인.
import koMessages from '@/lib/i18n/messages/ko.json';
import type { Locale, Messages } from '@/lib/i18n/config';
import type { MessageTable } from './translate';

const loaders: Record<Exclude<Locale, 'ko'>, () => Messages> = {
  en: () => require(`@/lib/i18n/messages/en.json`) as Messages,
  ja: () => require(`@/lib/i18n/messages/ja.json`) as Messages,
  zh: () => require(`@/lib/i18n/messages/zh.json`) as Messages,
};

const table: MessageTable = { ko: koMessages as Messages };

/** 로케일 사전을 (없으면) 실어 두고 전체 표를 돌려준다. 동기 — 화면 깜빡임 없이 바로 바꾼다. */
export function ensureMessages(locale: Locale): MessageTable {
  if (!table[locale] && locale !== 'ko') table[locale] = loaders[locale]();
  return table;
}

export function messageTable(): MessageTable {
  return table;
}
