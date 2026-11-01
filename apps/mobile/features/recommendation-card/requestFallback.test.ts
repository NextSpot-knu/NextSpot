import assert from 'node:assert/strict';

import { createTranslator } from '~/lib/i18n/translate';

import { REQUESTS, withRequestFallback } from './requestFallback';

// 앱 문구에 있는 키는 앱 문구가 먼저, 없는 키만 요청 파일에서
const base = createTranslator('ko', { ko: { common: { close: '닫기' } } });
const t = withRequestFallback(base, 'ko');
assert.equal(t('common.close'), '닫기');
assert.equal(t('cardSheet.photoHide'), REQUESTS['cardSheet.photoHide'].ko);
assert.equal(withRequestFallback(base, 'en')('cardSheet.photoHide'), REQUESTS['cardSheet.photoHide'].en);
assert.equal(t('nope.key'), 'nope.key');
// 통합 뒤 JSON 에 같은 키가 생기면 JSON 이 먼저
const merged = createTranslator('ko', { ko: { cardSheet: { photoHide: '통합 문구' } } });
assert.equal(withRequestFallback(merged, 'ko')('cardSheet.photoHide'), '통합 문구');

// 요청 파일 — 4로케일이 모두 있고 {변수} 자리가 로케일마다 같다
for (const [key, entry] of Object.entries(REQUESTS)) {
  for (const l of ['ko', 'en', 'ja', 'zh'] as const) assert.ok(entry[l]?.trim(), `${key}.${l} 누락`);
  const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
  for (const l of ['en', 'ja', 'zh'] as const) assert.equal(vars(entry[l] as string), vars(entry.ko), `${key}.${l} 변수 불일치`);
}

console.log('requestFallback.test OK');
