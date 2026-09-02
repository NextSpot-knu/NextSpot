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

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

const base = flatten(ko as Tree);
const locales = { en: flatten(en as Tree), ja: flatten(ja as Tree), zh: flatten(zh as Tree) };
let failures = 0;

// 사전은 JSON 하나가 아니다. I18nProvider 의 t() 는 아래 사이드 모듈들을 JSON 보다 **먼저**
// 조회한다(평면 키 형태라 JSON 트리와 구조가 다르다). 예전에는 area-demand 만 검사해서
// discovery·theme 은 로케일이 조용히 어긋나도 통과했다 — 그러면 비한국어 사용자에게 한국어가
// 그대로 나온다(t() 가 ko 로 폴백하므로 원시 키가 아니라 한국어가 보인다).
// 새 사이드 모듈이 생기면 I18nProvider·scripts/check-i18n-keys.mjs 와 함께 여기도 갱신할 것.
const SIDE_DICTS = {
  'area-demand': AREA_DEMAND_MESSAGES,
  discovery: DISCOVERY_MESSAGES,
  theme: THEME_MESSAGES,
};

for (const [name, dict] of Object.entries(SIDE_DICTS)) {
  const baseKeys = Object.keys(dict.ko).sort();
  for (const locale of ['en', 'ja', 'zh'] as const) {
    const keys = Object.keys(dict[locale]).sort();
    if (JSON.stringify(keys) !== JSON.stringify(baseKeys)) {
      failures++;
      const missing = baseKeys.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !baseKeys.includes(k));
      console.error(`FAIL ${locale} ${name} key parity`, { missing, extra });
    }
    const variableMismatches = baseKeys.filter((key) =>
      placeholders(dict.ko[key]).join(',') !== placeholders(dict[locale][key] ?? '').join(','),
    );
    if (variableMismatches.length) {
      failures++;
      console.error(`FAIL ${locale} ${name} placeholder parity`, variableMismatches);
    }
  }
  console.log(`PASS ${name} parity (${baseKeys.length} keys x 4 locales)`);
}

for (const [locale, messages] of Object.entries(locales)) {
  const missing = Object.keys(base).filter((key) => !(key in messages));
  const extra = Object.keys(messages).filter((key) => !(key in base));
  if (missing.length || extra.length) {
    failures++;
    console.error(`FAIL ${locale} key parity`, { missing, extra });
  } else {
    console.log(`PASS ${locale} key parity (${Object.keys(base).length} keys)`);
  }

  const variableMismatches = Object.keys(base).filter((key) =>
    key in messages && placeholders(base[key]).join(',') !== placeholders(messages[key]).join(','),
  );
  if (variableMismatches.length) {
    failures++;
    console.error(`FAIL ${locale} placeholder parity`, variableMismatches.map((key) => ({
      key, ko: placeholders(base[key]), translated: placeholders(messages[key]),
    })));
  } else {
    console.log(`PASS ${locale} placeholder parity`);
  }
}

if (failures) process.exit(1);

