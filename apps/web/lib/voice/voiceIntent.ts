// 음성 비서 의도 분류 + 발화 문장 생성 (순수 함수 — 단위 테스트 가능, DOM/React 비의존).
//
// 추천 카드를 음성으로 안내한 뒤 사용자의 음성 응답을 행동으로 매핑한다. 의도 분류는
// 100% 클라이언트 키워드 매칭이다(좁고 닫힌 의도 집합, 0ms 지연, 오프라인 안전, 신규 백엔드 0).
// 음성 안내 체감은 낭독 콘텐츠(rec.reason)가 추천 사유라는 점으로 충족된다.
//
// 화면 언어마다 명령어가 다르다(계획 B5 · I21): ko 는 예전 그대로(기본값), en/ja/zh 는 아래 LEXICONS.
// en 은 낱말 단위로만 맞춘다('go' 가 'good' 안에서 걸리지 않게).

import type { PlaceCategory } from "../travelContext";
import type { VoiceAppCommand } from "./voiceCommands";

export type VoiceIntent =
  | "accept" // 이 추천 수락 → 길안내
  | "detail" // 자세한 정보 다시 듣기
  | "next" // 다음 추천으로 넘기기
  | "negative" // 별로 — 만족도 하향 + 다음
  | "rejectAll" // 전부 별로 → 새 대안 세트
  | "cancel" // 음성 안내 종료
  | "unknown"; // 미매칭 → 재안내

// 매우 짧은 긍정/부정어는 부분일치 오탐(예: "예약"의 '예')을 막기 위해 "첫 토큰 정확일치"로만 본다.
const SHORT_YES = ["응", "어", "네", "넵", "예", "옙", "웅", "그래", "응응", "오케", "오케이", "콜", "yes", "ok", "okay"];
const SHORT_NO = ["아니", "아뇨", "노", "놉", "no"];

// 우선순위 순서대로 검사한다(앞선 그룹이 이긴다): cancel > rejectAll > negative > next > accept > detail.
const GROUPS: { intent: VoiceIntent; words: string[] }[] = [
  { intent: "cancel", words: ["그만", "됐어", "됐어요", "중지", "중단", "스톱", "스탑", "멈춰", "꺼줘", "종료", "그만해"] },
  { intent: "rejectAll", words: ["다 별로", "전부 별로", "전부", "모두", "다시 추천", "새로 추천", "새로고침", "다른 곳", "다른곳", "싹 다", "전부 다", "전부다", "다 싫"] },
  { intent: "negative", words: ["별로", "싫어", "싫", "안 좋", "안좋", "마음에 안", "마음에안", "별로야", "별로예요"] },
  { intent: "next", words: ["다음", "넘겨", "넘어", "넘기", "패스", "스킵", "다른거", "다른 거", "다른 것", "말고", "딴거", "딴 거", "아니", "아뇨", "아니요", "아니야"] },
  { intent: "accept", words: ["좋아", "갈래", "갈게", "가자", "가줘", "가요", "출발", "맞아", "여기로", "거기로", "안내", "수락", "선택", "좋습니다", "좋아요", "그래"] },
  { intent: "detail", words: ["자세히", "자세", "상세", "정보", "얼마나", "얼마", "대기", "거리", "도보", "몇 분", "몇분", "설명", "더 알려", "어때"] },
];

function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[.,!?~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 음성 인식 결과(여러 alternative)를 의도로 분류한다. 하나의 alternative라도 매칭되면 채택해
 * 인식 변동성에 강건하게 만든다. 어디에도 안 걸리면 "unknown"(호출 측에서 재안내).
 */
export function classifyIntent(transcripts: string[], locale: string = "ko"): VoiceIntent {
  if (locale !== "ko" && LEXICONS[locale]) return classifyWithLexicon(transcripts, LEXICONS[locale]);
  const texts = (transcripts || []).map(norm).filter(Boolean);
  if (!texts.length) return "unknown";

  const firstYes = texts.some((t) => SHORT_YES.includes(t.split(" ")[0]));
  const firstNo = texts.some((t) => SHORT_NO.includes(t.split(" ")[0]));
  const hit = (words: string[]) =>
    texts.some((t) => {
      const tn = t.replace(/\s+/g, "");
      return words.some((w) => t.includes(w) || tn.includes(w.replace(/\s+/g, "")));
    });

  if (hit(GROUPS[0].words)) return "cancel";
  if (hit(GROUPS[1].words)) return "rejectAll";
  if (hit(GROUPS[2].words)) return "negative";
  if (firstNo || hit(GROUPS[3].words)) return "next";
  if (firstYes || hit(GROUPS[4].words)) return "accept";
  if (hit(GROUPS[5].words)) return "detail";
  return "unknown";
}

interface Lexicon {
  shortYes: string[];
  shortNo: string[];
  /** 우선순위 순서: cancel > rejectAll > negative > next > accept > detail (ko 와 같다). */
  groups: { intent: VoiceIntent; words: string[] }[];
  /** 낱말 경계로만 맞출지(영어). 일본어·중국어는 띄어쓰기가 없어 부분일치. */
  wholeWord: boolean;
}

const LEXICONS: Record<string, Lexicon> = {
  en: {
    shortYes: ["yes", "yeah", "yep", "yup", "sure", "ok", "okay"],
    shortNo: ["no", "nope", "nah"],
    wholeWord: true,
    groups: [
      { intent: "cancel", words: ["stop", "cancel", "quit", "enough", "that's enough"] },
      { intent: "rejectAll", words: ["none of these", "none of them", "something else", "refresh", "start over"] },
      { intent: "negative", words: ["don't like", "do not like", "don't want", "do not want", "not good", "not great", "not for me", "boring"] },
      { intent: "next", words: ["next", "skip", "pass", "another", "other one", "not this"] },
      { intent: "accept", words: ["go", "let's go", "take me", "guide me", "sounds good", "accept", "sure thing"] },
      { intent: "detail", words: ["details", "detail", "tell me more", "more info", "how far", "how long", "wait time", "menu"] },
    ],
  },
  ja: {
    shortYes: ["はい", "うん", "ええ", "オッケー"],
    shortNo: ["いいえ", "いや", "ううん"],
    wholeWord: false,
    groups: [
      { intent: "cancel", words: ["やめて", "やめ", "止めて", "辞めて", "ストップ", "終了", "もういい", "中止"] },
      { intent: "rejectAll", words: ["全部だめ", "全部いや", "別のところ", "他のところ", "やり直し"] },
      { intent: "negative", words: ["いやだ", "嫌", "微妙", "好きじゃない", "よくない", "興味ない"] },
      { intent: "next", words: ["次", "つぎ", "スキップ", "パス", "他の", "別の", "違う", "ちがう"] },
      { intent: "accept", words: ["お願い", "行く", "行きます", "行こう", "いいね", "いいよ", "案内して", "そこにする"] },
      { intent: "detail", words: ["詳しく", "くわしく", "詳細", "情報", "どのくらい", "何分", "距離", "待ち時間", "メニュー"] },
    ],
  },
  zh: {
    shortYes: ["好", "好的", "嗯", "是", "对", "行", "可以", "去"],
    shortNo: ["不", "不要", "不用", "不了"],
    wholeWord: false,
    groups: [
      { intent: "cancel", words: ["停止", "停下", "结束", "算了", "不用了", "取消", "别说了"] },
      { intent: "rejectAll", words: ["都不要", "都不喜欢", "换一批", "重新推荐"] },
      { intent: "negative", words: ["不喜欢", "不好", "没意思", "不想去", "不行"] },
      { intent: "next", words: ["下一个", "下一", "换一个", "跳过", "别的", "其他", "不要这个"] },
      { intent: "accept", words: ["好的", "好啊", "可以", "走吧", "去吧", "带我去", "导航", "就这个", "确定", "没问题"] },
      { intent: "detail", words: ["详细", "详情", "多远", "多久", "几分钟", "信息", "介绍", "菜单"] },
    ],
  },
};

/** en/ja/zh 정규화 — 소문자, 문장부호(。、，！？… 포함)를 공백으로. 아포스트로피는 남긴다(don't). */
function normLocale(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[.,!?~。、，！？…·「」『』“”"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classifyWithLexicon(transcripts: string[], lexicon: Lexicon): VoiceIntent {
  const texts = (transcripts || []).map(normLocale).filter(Boolean);
  if (!texts.length) return "unknown";
  const firstToken = (t: string) => t.split(" ")[0];
  const firstYes = texts.some((t) => lexicon.shortYes.includes(firstToken(t)) || lexicon.shortYes.includes(t));
  const firstNo = texts.some((t) => lexicon.shortNo.includes(firstToken(t)) || lexicon.shortNo.includes(t));
  const hit = (words: string[]) =>
    texts.some((t) => words.some((w) => (lexicon.wholeWord
      ? new RegExp(`(^|[^a-z'])${escapeRegExp(w)}($|[^a-z'])`).test(t)
      : t.includes(w))));
  const group = (intent: VoiceIntent) => lexicon.groups.find((g) => g.intent === intent)?.words ?? [];
  if (hit(group("cancel"))) return "cancel";
  if (hit(group("rejectAll"))) return "rejectAll";
  if (hit(group("negative"))) return "negative";
  if (firstNo || hit(group("next"))) return "next";
  if (firstYes || hit(group("accept"))) return "accept";
  if (hit(group("detail"))) return "detail";
  return "unknown";
}

// ── en/ja/zh 화면의 '장소 종류 · 실내 · 도보 N분' 말(계획 B5 · I21, 리뷰 10-07) ─────────────────────────
//
// 서버의 키워드 분류기는 한국어만 알아듣는다. 그래서 en/ja/zh 화면에서 비서가 스스로 권하는 "show me cafés" ·
// 「カフェを見せて」 · "看看咖啡厅" 나 기능설명서 F4 ④ 의 "10분 이내" · "실내" 가 LLM 보조가 꺼져 있으면 재질문으로 끝났다.
// 같은 뜻의 앱 명령(VoiceAppCommand)으로 여기서 바로 바꾼다 — 서버를 부르지 않는다. 한국어는 종전대로 서버가 맡는다.

const LOCALE_TYPE_WORDS: Record<string, { type: PlaceCategory; pattern: RegExp }[]> = {
  en: [
    { type: "cafe", pattern: /(^|[^a-z])(caf[eé]s?|coffee|dessert)([^a-z]|$)/ },
    { type: "restaurant", pattern: /(^|[^a-z])(restaurants?|food|eat|lunch|dinner|meal)([^a-z]|$)/ },
    { type: "culture", pattern: /(^|[^a-z])(museums?|galler(y|ies)|culture|cultural|exhibitions?)([^a-z]|$)/ },
    { type: "attraction", pattern: /(^|[^a-z])(attractions?|sights?|sightseeing|landmarks?|tourist spots?)([^a-z]|$)/ },
  ],
  ja: [
    { type: "cafe", pattern: /カフェ|コーヒー|喫茶|スイーツ/ },
    { type: "restaurant", pattern: /レストラン|食事|ご飯|ごはん|食堂|グルメ|食べ/ },
    { type: "culture", pattern: /博物館|美術館|文化施設|展示/ },
    { type: "attraction", pattern: /観光地|観光スポット|名所|見どころ/ },
  ],
  zh: [
    { type: "cafe", pattern: /咖啡|甜品/ },
    { type: "restaurant", pattern: /餐厅|饭店|吃饭|美食|餐馆/ },
    { type: "culture", pattern: /博物馆|美术馆|文化设施|展览/ },
    { type: "attraction", pattern: /景点|名胜|观光/ },
  ],
};
const LOCALE_INDOOR: Record<string, RegExp> = {
  en: /(^|[^a-z])(indoors?|inside)([^a-z]|$)/,
  ja: /屋内|室内/,
  zh: /室内|屋内/,
};
const LOCALE_WALK: Record<string, RegExp> = {
  en: /(\d+)\s*-?\s*(?:min|mins|minute|minutes)(?![a-z])/,
  ja: /(\d+)\s*分/,
  zh: /(\d+)\s*分钟/,
};

/** 도보 N분 → 앱이 아는 세 칸(5 · 10 · 20분) 중 그 안에 드는 가장 짧은 것. */
function walkStep(minutes: number): 5 | 10 | 20 {
  return minutes <= 5 ? 5 : minutes <= 10 ? 10 : 20;
}

/**
 * en/ja/zh 발화 → 앱 명령. 도보 N분 > 실내 > 장소 종류 순으로 하나만 고른다. 한국어(또는 모르는 언어)·못 알아들으면 null.
 * 숫자는 전각(１０)도 읽는다.
 */
export function localeVoiceCommand(utterance: string, locale: string): VoiceAppCommand | null {
  if (locale === "ko" || !LOCALE_TYPE_WORDS[locale]) return null;
  const text = normLocale(utterance).replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  if (!text) return null;
  const walk = LOCALE_WALK[locale].exec(text);
  const minutes = walk ? Number(walk[1]) : NaN;
  if (Number.isFinite(minutes) && minutes > 0 && minutes <= 60) {
    return { name: "set_max_walk_minutes", args: { maxWalkMinutes: walkStep(minutes) } };
  }
  if (LOCALE_INDOOR[locale].test(text)) return { name: "set_indoor_mode", args: { enabled: true } };
  const type = LOCALE_TYPE_WORDS[locale].find(({ pattern }) => pattern.test(text))?.type;
  return type ? { name: "set_facility_type", args: { facilityType: type } } : null;
}

/**
 * 카드 진입 발화 문장. 핵심은 백엔드가 만든 reason을 그대로 읽어주는 것.
 * 예: "1번째 추천이에요. 황리단길 감성카페 봄. 도보 2분, 예상 대기 8분 수준으로 지금 가장 여유로워요. 여기로 안내할까요?"
 */
export function buildCardSpeech(name: string, reason: string, indexZeroBased: number): string {
  const r = (reason || "").slice(0, 200).trim();
  const body = r ? `${name}. ${r}` : `${name}.`;
  return `${indexZeroBased + 1}번째 추천이에요. ${body} 여기로 안내할까요?`;
}
