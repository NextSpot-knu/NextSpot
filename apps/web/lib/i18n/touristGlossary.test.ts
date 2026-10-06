// 관광객 문구가 용어집(2026-10-06 계획 3.3)의 금지어를 쓰지 않는가.
// 'KTO' 는 영어 카드 출처 칩에 남아 있었다 — 실시간 새로고침을 누르면 같은 칩이 'Korea Tourism Organization'
// 에서 'KTO' 로 바뀌어 심사 도중 기관 이름이 달라졌다. '상대지수' 계열은 /waiting 머리줄에 그대로 섰다(zh 만 고쳐져 있었다).
import assert from 'node:assert/strict';
import ko from './messages/ko.json';
import en from './messages/en.json';
import ja from './messages/ja.json';
import zh from './messages/zh.json';
import { AREA_DEMAND_MESSAGES } from './area-demand-messages';
import { DISCOVERY_MESSAGES } from './discovery-messages';
import { THEME_MESSAGES } from './theme-messages';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = '', result: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') result[path] = value;
    else flatten(value, path, result);
  }
  return result;
}

const LOCALES = { ko, en, ja, zh } as const;
type Locale = keyof typeof LOCALES;

for (const locale of Object.keys(LOCALES) as Locale[]) {
  const all = {
    ...flatten(LOCALES[locale] as unknown as Tree),
    ...AREA_DEMAND_MESSAGES[locale],
    ...DISCOVERY_MESSAGES[locale],
    ...THEME_MESSAGES[locale],
  };
  for (const [key, value] of Object.entries(all)) {
    // 기관 약칭은 어느 화면에도 쓰지 않는다 — 출처는 늘 'ⓒ Korea Tourism Organization'.
    assert.doesNotMatch(value, /\bKTO\b/, `${locale} ${key}: 'KTO' → 'Korea Tourism Organization'`);
  }
  // 영어 출처 표기(ⓒ … TourAPI)는 기관 이름을 줄이지 않는다.
  if (locale === 'en') {
    for (const [key, value] of Object.entries(all)) {
      if (value.includes('ⓒ') && value.includes('TourAPI')) {
        assert.match(value, /Korea Tourism Organization/, `en ${key}: 출처에 기관 이름이 없다 — ${value}`);
      }
    }
  }
  // 추천 카드·대기 보드의 관광 근거 문구 — 내부 지표 이름('상대지수') 대신 관광객 말.
  for (const [key, value] of Object.entries(AREA_DEMAND_MESSAGES[locale])) {
    assert.doesNotMatch(value, /상대지수|relative index|相対指数|相对指数/i, `${locale} ${key}: ${value}`);
  }
}

console.log('tourist glossary tests passed');
