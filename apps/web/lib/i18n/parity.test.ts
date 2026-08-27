import ko from './messages/ko.json';
import en from './messages/en.json';
import ja from './messages/ja.json';
import zh from './messages/zh.json';
import { AREA_DEMAND_MESSAGES } from './area-demand-messages';

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

const areaDemandKeys = Object.keys(AREA_DEMAND_MESSAGES.ko).sort();
for (const locale of ['en', 'ja', 'zh'] as const) {
  const keys = Object.keys(AREA_DEMAND_MESSAGES[locale]).sort();
  if (JSON.stringify(keys) !== JSON.stringify(areaDemandKeys)) {
    failures++;
    console.error(`FAIL ${locale} area-demand key parity`);
  }
  const variableMismatches = areaDemandKeys.filter((key) =>
    placeholders(AREA_DEMAND_MESSAGES.ko[key]).join(',')
      !== placeholders(AREA_DEMAND_MESSAGES[locale][key] ?? '').join(','),
  );
  if (variableMismatches.length) {
    failures++;
    console.error(`FAIL ${locale} area-demand placeholder parity`, variableMismatches);
  }
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

