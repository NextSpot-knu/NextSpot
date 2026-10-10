import assert from 'node:assert/strict';
import { pickBrowserLocale } from './browserLocale';

assert.equal(pickBrowserLocale(['ko-KR', 'en-US']), 'ko');
assert.equal(pickBrowserLocale(['ja-JP']), 'ja');
assert.equal(pickBrowserLocale(['zh-CN']), 'zh');
assert.equal(pickBrowserLocale(['zh-TW', 'en']), 'zh', '번체도 중국어 화면');
assert.equal(pickBrowserLocale(['zh_Hant_HK']), 'zh');
assert.equal(pickBrowserLocale(['en-US', 'ko-KR']), 'ko', '목록에 한국어가 있으면 한국어(영문 브라우저를 쓰는 한국 사람)');
assert.equal(pickBrowserLocale(['en-GB', 'ja-JP']), 'en', '한국어가 없으면 첫 번째 언어');
assert.equal(pickBrowserLocale(['fr-FR']), 'en', '지원하지 않는 언어는 영어');
assert.equal(pickBrowserLocale(['th']), 'en');
assert.equal(pickBrowserLocale(['  ', 'JA']), 'ja', '빈 항목은 건너뛰고 대소문자 무시');
assert.equal(pickBrowserLocale([]), null);
assert.equal(pickBrowserLocale(undefined), null);

console.log('browserLocale tests passed');
