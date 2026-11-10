import assert from 'node:assert/strict';

import { applyDocumentLang } from './documentLang';

const doc = { documentElement: { lang: 'en' } };
applyDocumentLang('ko', doc);
assert.equal(doc.documentElement.lang, 'ko');
applyDocumentLang('ja', doc);
assert.equal(doc.documentElement.lang, 'ja');
// 문서가 없으면(네이티브) 아무 일도 하지 않는다
applyDocumentLang('zh', undefined);
applyDocumentLang('zh', { documentElement: null });
// node 에는 document 가 없다 — 기본 인자로도 던지지 않는다
applyDocumentLang('ko');
console.log('ok documentLang');
