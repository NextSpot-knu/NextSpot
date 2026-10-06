import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCardSentence, buildVoiceReason, type VoiceTranslator } from "./voiceReason";

// 실제 사전으로 문장을 만든다 — 키가 빠지거나 자리표시가 어긋나면 여기서 드러난다.
const load = (locale: string) =>
  JSON.parse(readFileSync(join(process.cwd(), "lib/i18n/messages", `${locale}.json`), "utf8")) as Record<string, unknown>;
const translator = (locale: string): VoiceTranslator => {
  const dict = load(locale);
  return (key, vars = {}) => {
    const raw = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], dict);
    assert.equal(typeof raw, "string", `${locale}: missing ${key}`);
    return (raw as string).replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
  };
};

const ko = translator("ko");
const count = (text: string, part: string) => text.split(part).length - 1;

// 이름은 한 번, '수준입니다' 없이 걸어서 N분.
{
  const reason = buildVoiceReason(ko, { name: "이풍녀 구로쌈밥", walkMin: 6, preferencePercent: 72 });
  assert.equal(count(reason, "이풍녀 구로쌈밥"), 1);
  assert.match(reason, /걸어서 6분/);
  assert.match(reason, /72%/);
  assert.ok(!reason.includes("수준입니다"));
  const sentence = buildCardSentence(ko, "이풍녀 구로쌈밥", reason);
  assert.equal(count(sentence, "이풍녀 구로쌈밥"), 1, "카드 문장도 이름을 두 번 읽지 않는다");
  assert.ok(sentence.endsWith("여기로 안내할까요?"));
}

// 화살표일 때만 '대신'.
{
  const instead = buildVoiceReason(ko, { name: "우직", walkMin: 3, preferencePercent: 80, insteadOf: "대릉원" });
  assert.match(instead, /^대릉원 대신 우직/);
  const plain = buildVoiceReason(ko, { name: "우직", walkMin: 3, preferencePercent: 80, insteadOf: null });
  assert.ok(!plain.includes("대신"));
}

// 취향은 문턱(50%) 이상만, 여유 문장은 한산·여유만.
{
  const low = buildVoiceReason(ko, { name: "황남쫀드기", walkMin: 3, preferencePercent: 12 });
  assert.ok(!low.includes("취향"), "낮은 취향 일치는 말하지 않는다");
  assert.ok(!low.includes("{"), "빈 자리표시가 남지 않는다");
  assert.match(buildVoiceReason(ko, { name: "계림", walkMin: 5, crowdGrade: "quiet" }), /지금 여유로운 편이에요/);
  assert.match(buildVoiceReason(ko, { name: "계림", walkMin: 5, crowdGrade: "relaxed" }), /지금 여유로운 편이에요/);
  assert.ok(!buildVoiceReason(ko, { name: "계림", walkMin: 5, crowdGrade: "busy" }).includes("여유"), "혼잡이면 여유를 말하지 않는다");
  assert.ok(!buildVoiceReason(ko, { name: "계림", walkMin: 5, crowdGrade: "moderate" }).includes("여유"));
  assert.ok(!buildVoiceReason(ko, { name: "계림", walkMin: 5, crowdGrade: null }).includes("여유"));
}

// 다른 언어 — 한글이 섞이지 않는다(장소 이름 제외).
for (const locale of ["en", "ja", "zh"]) {
  const t = translator(locale);
  const reason = buildVoiceReason(t, { name: "Gyerim", walkMin: 4, preferencePercent: 70, insteadOf: "Daereungwon", crowdGrade: "quiet" });
  const sentence = buildCardSentence(t, "Gyerim", reason);
  assert.ok(!/[가-힣]/.test(sentence), `${locale}: no Hangul in "${sentence}"`);
  assert.equal(count(sentence, "Gyerim"), 1, `${locale}: name once`);
  assert.ok(!sentence.includes("{"), `${locale}: placeholders filled`);
}

// 이유가 없으면 이름 + 질문.
assert.equal(buildCardSentence(ko, "계림", ""), "계림. 여기로 안내할까요?");
// 서버 문장이 이름을 품고 있지 않으면 앞에 붙인다.
assert.equal(buildCardSentence(ko, "계림", "걸어서 4분이에요."), "계림. 걸어서 4분이에요. 여기로 안내할까요?");

console.log("PASS voiceReason");
