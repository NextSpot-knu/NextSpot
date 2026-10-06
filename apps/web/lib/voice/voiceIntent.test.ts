// voiceIntent 의도 분류 단위 테스트 (프레임워크 불필요).
// 실행: apps/web 에서 `npm run test` (scripts/run-web-tests.mjs 가 lib/**/*.test.ts 를 전부 tsx 로 돌린다)
//   단독: npx tsx lib/voice/voiceIntent.test.ts
import { classifyIntent, buildCardSpeech, localeVoiceCommand, type VoiceIntent } from "./voiceIntent";

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

// 화면 언어별 명령어(계획 B5 · I21) — ko 는 기본값 그대로, en/ja/zh 는 그 언어의 말로.
const localeCases: [string, string, VoiceIntent][] = [
  ["en", "yes please", "accept"],
  ["en", "next", "next"],
  ["en", "no thanks", "next"],
  ["en", "not good", "negative"],
  ["en", "I don't want to go", "negative"],
  ["en", "tell me more", "detail"],
  ["en", "stop", "cancel"],
  ["en", "none of these", "rejectAll"],
  ["en", "go", "accept"],
  ["en", "no go", "next"],
  ["en", "good morning", "unknown"],
  ["ja", "はい", "accept"],
  ["ja", "はい、お願いします", "accept"],
  ["ja", "次", "next"],
  ["ja", "つぎ", "next"],
  ["ja", "いいえ", "next"],
  ["ja", "詳しく", "detail"],
  ["ja", "やめて", "cancel"],
  ["zh", "好的。", "accept"],
  ["zh", "下一个", "next"],
  ["zh", "不好", "negative"],
  ["zh", "不错", "unknown"],
  ["zh", "详细", "detail"],
  ["zh", "停止", "cancel"],
  // ko 를 명시해도 예전 그대로.
  ["ko", "응 가자", "accept"],
  ["ko", "다음", "next"],
];
for (const [locale, phrase, expected] of localeCases) {
  const got = classifyIntent([phrase], locale);
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  [${locale}] "${phrase}" -> ${got}${ok ? "" : ` (expected ${expected})`}`);
}

// en/ja/zh 의 장소 종류 · 실내 · 도보 N분 — 서버(한국어 전용 분류기) 없이 앱 명령으로(리뷰 10-07: 비서가 권한 "show me cafés" 가
// 재질문으로 끝났다). 한국어는 null — 종전대로 서버가 맡는다.
const commandCases: [string, string, string | null][] = [
  ["en", "show me cafés", "set_facility_type:cafe"],
  ["en", "Show me cafes nearby", "set_facility_type:cafe"],
  ["en", "somewhere to eat", "set_facility_type:restaurant"],
  ["en", "a museum please", "set_facility_type:culture"],
  ["en", "sights around here", "set_facility_type:attraction"],
  ["en", "something indoors", "set_indoor_mode:true"],
  ["en", "within 10 minutes walk", "set_max_walk_minutes:10"],
  ["en", "a 5-minute walk", "set_max_walk_minutes:5"],
  ["en", "15 min", "set_max_walk_minutes:20"],
  ["en", "good morning", null],
  ["en", "cafeteria talk", null],
  ["ja", "カフェを見せて", "set_facility_type:cafe"],
  ["ja", "ご飯を食べたい", "set_facility_type:restaurant"],
  ["ja", "室内がいい", "set_indoor_mode:true"],
  ["ja", "徒歩１０分以内", "set_max_walk_minutes:10"],
  ["ja", "こんにちは", null],
  ["zh", "看看咖啡厅", "set_facility_type:cafe"],
  ["zh", "附近的景点", "set_facility_type:attraction"],
  ["zh", "室内的地方", "set_indoor_mode:true"],
  ["zh", "步行10分钟以内", "set_max_walk_minutes:10"],
  ["zh", "你好", null],
  ["ko", "카페 보여줘", null],
];
for (const [locale, phrase, expected] of commandCases) {
  const command = localeVoiceCommand(phrase, locale);
  const got = command
    ? `${command.name}:${command.name === "set_facility_type" ? command.args.facilityType
      : command.name === "set_indoor_mode" ? command.args.enabled
        : command.name === "set_max_walk_minutes" ? command.args.maxWalkMinutes : ""}`
    : null;
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  command [${locale}] "${phrase}" -> ${got}${ok ? "" : ` (expected ${expected})`}`);
}

const total = cases.length + 3 + localeCases.length + commandCases.length;
console.log(`\n${total - fail}/${total} passed`);
if (fail) process.exit(1);
