import assert from 'node:assert/strict';

import koJson from '@/lib/i18n/messages/ko.json';
// en.json 은 check-shared-imports 의 본문 검사에 오탐이 있어(catalog.ts 주석) ja.json 으로 본다.
import jaJson from '@/lib/i18n/messages/ja.json';
import type { Messages } from '@/lib/i18n/config';
import { DISCOVERY_MESSAGES } from '@/lib/i18n/discovery-messages';
import { countKey } from '@/lib/i18n/count';
import { createTranslator, interpolate, lookup } from './translate';
import { isLocale, pickInitialLocale } from './initialLocale';

// --- lookup ---
const nested: Messages = { a: { b: 'AB', c: { d: 'ACD' } }, top: 'T' };
assert.equal(lookup(nested, 'a.b'), 'AB');
assert.equal(lookup(nested, 'a.c.d'), 'ACD');
assert.equal(lookup(nested, 'top'), 'T');
assert.equal(lookup(nested, 'a'), undefined, '절(객체)은 문자열이 아니다');
assert.equal(lookup(nested, 'a.x.y'), undefined);
assert.equal(lookup(undefined, 'a.b'), undefined);

// --- 조회 순서: 현재 사이드 → 현재 JSON → ko 사이드 → ko JSON → 키 ---
const sideKey = 'discovery.entry';
const table = {
  ko: { discovery: { entry: 'ko-json-entry' }, only: { ko: '한국어만' }, both: { k: '둘 다 ko' } } as Messages,
  en: { discovery: { entry: 'en-json-entry' }, both: { k: 'both en' }, enOnly: 'english only' } as Messages,
};
const tEn = createTranslator('en', table);
assert.equal(tEn(sideKey), DISCOVERY_MESSAGES.en[sideKey], '현재 로케일 사이드 사전이 JSON 보다 먼저');
assert.equal(tEn('both.k'), 'both en', '현재 로케일 JSON');
assert.equal(tEn('only.ko'), '한국어만', 'ko JSON 으로 폴백');
assert.equal(tEn('no.such.key'), 'no.such.key', '마지막은 키 자체');

// 현재 로케일 사이드에 없고 ko 사이드에만 있는 키는 현재 JSON 보다 늦게, ko JSON 보다 먼저 본다.
const koSideOnly = Object.keys(DISCOVERY_MESSAGES.ko).find((k) => DISCOVERY_MESSAGES.ja[k] === undefined);
if (koSideOnly) {
  const tJa = createTranslator('ja', { ko: { [koSideOnly]: 'ko-json' } as Messages, ja: {} });
  assert.equal(tJa(koSideOnly), DISCOVERY_MESSAGES.ko[koSideOnly]);
}
// ko 사이드 > ko JSON: 같은 키를 ko JSON 에 넣어도 ko 사이드가 이긴다(현재 로케일 사전이 비었을 때).
const flatSide = sideKey.split('.');
const tJaEmpty = createTranslator('ja', { ko: { [flatSide[0]]: { [flatSide[1]]: 'ko-json' } } as Messages });
assert.equal(tJaEmpty(sideKey), DISCOVERY_MESSAGES.ja[sideKey] ?? DISCOVERY_MESSAGES.ko[sideKey]);

// 현재 로케일 사전이 아직 없으면 ko JSON 을 쓴다(웹의 `messagesRef.current[locale] ?? ko`).
const tZhMissing = createTranslator('zh', { ko: { both: { k: '둘 다 ko' } } as Messages });
assert.equal(tZhMissing('both.k'), '둘 다 ko');

// --- 치환 ---
assert.equal(interpolate('{n}분 · {name}', { n: 5, name: '첨성대' }), '5분 · 첨성대');
assert.equal(interpolate('{n}분 {missing}', { n: 0 }), '0분 {missing}', '0 은 채우고 없는 자리는 그대로');
assert.equal(interpolate('{a}', { a: null as unknown as string }), '{a}');
assert.equal(interpolate('no vars {x}'), 'no vars {x}');
assert.equal(createTranslator('en', table)('discovery.walkMinutes', { n: 7 }), DISCOVERY_MESSAGES.en['discovery.walkMinutes'].replace('{n}', '7'));

// --- countKey 복수 ---
assert.equal(countKey('main.spots', 1), 'main.spotsOne');
assert.equal(countKey('main.spots', 2), 'main.spots');
assert.equal(countKey('main.spots', 0), 'main.spots');

// --- 실제 웹 JSON 으로: ja 에 있는 키는 ja, 키 자체로 떨어지지 않는다 ---
const real = { ko: koJson as Messages, ja: jaJson as Messages };
const firstLeaf = (dict: Messages, prefix = ''): string => {
  for (const [k, v] of Object.entries(dict)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') return key;
    const inner = firstLeaf(v, key);
    if (inner) return inner;
  }
  return '';
};
const leaf = firstLeaf(koJson as Messages);
assert.ok(leaf);
assert.equal(createTranslator('ko', real)(leaf), lookup(koJson as Messages, leaf));
assert.equal(createTranslator('ja', real)(leaf), lookup(jaJson as Messages, leaf) ?? lookup(koJson as Messages, leaf));

// --- 첫 언어 고르기 ---
assert.equal(pickInitialLocale('ja', ['ko-KR']), 'ja', '저장된 선택이 기기 언어보다 먼저');
assert.equal(pickInitialLocale('fr', ['en-US']), 'en', '알 수 없는 저장값은 무시');
assert.equal(pickInitialLocale(null, ['en-US', 'ko-KR']), 'ko', '목록 어디든 한국어면 ko');
assert.equal(pickInitialLocale(null, ['ja-JP', 'en-US']), 'ja');
assert.equal(pickInitialLocale(null, ['zh-Hant-TW']), 'zh');
assert.equal(pickInitialLocale(null, ['zh_CN']), 'zh');
assert.equal(pickInitialLocale(null, ['fr-FR', 'ja-JP']), 'en', '첫 언어 기준 — 프랑스어면 en');
assert.equal(pickInitialLocale(null, []), 'ko', '목록이 비면 기본 ko');
assert.equal(pickInitialLocale(undefined, undefined), 'ko');
assert.ok(isLocale('zh'));
assert.ok(!isLocale('ZH'));
