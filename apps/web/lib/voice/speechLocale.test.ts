import assert from "node:assert/strict";
import { pickVoice, speechLangFor } from "./speechLocale";

// 화면 언어 → 음성 언어.
assert.equal(speechLangFor("ko"), "ko-KR");
assert.equal(speechLangFor("en"), "en-US");
assert.equal(speechLangFor("ja"), "ja-JP");
assert.equal(speechLangFor("zh"), "zh-CN");
assert.equal(speechLangFor(undefined), "ko-KR", "모르면 예전처럼 한국어");
assert.equal(speechLangFor("fr"), "ko-KR");

const voices = [
  { name: "Microsoft Heami - Korean", lang: "ko-KR", localService: true },
  { name: "Google 한국의", lang: "ko-KR", localService: false },
  { name: "Microsoft Zira", lang: "en-US", localService: true },
  { name: "Microsoft Aria Online (Natural)", lang: "en-US", localService: false },
  { name: "Google UK English Female", lang: "en-GB", localService: false },
  { name: "Google 日本語", lang: "ja-JP", localService: false },
  { name: "Google 國語（臺灣）", lang: "zh-TW", localService: false },
  { name: "Microsoft Huihui", lang: "zh-CN", localService: true },
];

assert.equal(pickVoice(voices, "ko-KR")?.name, "Google 한국의", "구글·클라우드 보이스가 OS 기본보다 먼저");
assert.equal(pickVoice(voices, "en-US")?.name, "Microsoft Aria Online (Natural)", "Natural 보이스 우선");
assert.equal(pickVoice(voices, "ja-JP")?.name, "Google 日本語");
assert.equal(pickVoice(voices, "zh-CN")?.name, "Microsoft Huihui", "간체(zh-CN)를 번체(zh-TW)보다 먼저");
assert.equal(pickVoice([{ name: "Google 國語（臺灣）", lang: "zh-TW", localService: false }], "zh-CN")?.lang, "zh-TW", "간체가 없으면 번체라도");
assert.equal(pickVoice(voices.filter((v) => !v.lang.startsWith("ja")), "ja-JP"), null, "맞는 언어가 없으면 null(브라우저 기본)");
assert.equal(pickVoice([], "ko-KR"), null);
assert.equal(pickVoice(null, "ko-KR"), null);

console.log("PASS speechLocale");
