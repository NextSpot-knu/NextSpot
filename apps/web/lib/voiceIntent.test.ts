// voiceIntent 의도 분류 단위 테스트 (프레임워크 불필요).
// 실행: node --experimental-strip-types lib/voiceIntent.test.ts  (Node 22.6+)
//   또는: npx tsx lib/voiceIntent.test.ts
import { classifyIntent, buildCardSpeech, type VoiceIntent } from "./voiceIntent.ts";

const cases: [string, VoiceIntent][] = [
  // accept
  ["응 가자", "accept"],
  ["네 좋아요", "accept"],
  ["여기로 안내해줘", "accept"],
  ["그래 갈래", "accept"],
  ["콜", "accept"],
  ["오케이 출발", "accept"],
  // next
  ["다음", "next"],
  ["다음 거 보여줘", "next"],
  ["아니 다른거", "next"],
  ["패스", "next"],
  ["이거 말고", "next"],
  // negative
  ["별로예요", "negative"],
  ["싫어", "negative"],
  ["안 좋아", "negative"],
  // rejectAll
  ["다 별로야", "rejectAll"],
  ["전부 별로", "rejectAll"],
  ["새로 추천해줘", "rejectAll"],
  ["다른 곳들 보여줘", "rejectAll"],
  // detail
  ["자세히 알려줘", "detail"],
  ["대기 얼마나 돼", "detail"],
  ["거리 어때", "detail"],
  // cancel
  ["그만", "cancel"],
  ["됐어요", "cancel"],
  ["중지해줘", "cancel"],
  // unknown
  ["", "unknown"],
  ["음 글쎄", "unknown"],
];

let fail = 0;
for (const [phrase, expected] of cases) {
  const got = classifyIntent(phrase ? [phrase] : []);
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  "${phrase}" -> ${got}${ok ? "" : ` (expected ${expected})`}`);
}

// multi-alternative: 하나라도 매칭되면 채택
{
  const got = classifyIntent(["음 글쎄", "응 가자"]);
  const ok = got === "accept";
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  [alts] -> ${got}${ok ? "" : " (expected accept)"}`);
}

// buildCardSpeech
{
  const s = buildCardSpeech("황남쌈밥 식당", "지금 가장 여유로워요.", 0);
  const ok = s.startsWith("1번째 추천이에요. 황남쌈밥 식당.") && s.endsWith("여기로 안내할까요?");
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  buildCardSpeech -> ${s}`);
  // reason 없을 때도 자연스러운 문장
  const s2 = buildCardSpeech("남부 라운지", "", 2);
  const ok2 = s2 === "3번째 추천이에요. 남부 라운지. 여기로 안내할까요?";
  if (!ok2) fail++;
  console.log(`${ok2 ? "PASS" : "FAIL"}  buildCardSpeech(no reason) -> ${s2}`);
}

const total = cases.length + 3;
console.log(`\n${total - fail}/${total} passed`);
if (fail) process.exit(1);
