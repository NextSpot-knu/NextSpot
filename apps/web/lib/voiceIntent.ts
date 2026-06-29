// 음성 비서 의도 분류 + 발화 문장 생성 (순수 함수 — 단위 테스트 가능, DOM/React 비의존).
//
// 추천 카드를 음성으로 안내한 뒤 사용자의 한국어 음성 응답을 행동으로 매핑한다. 의도 분류는
// 100% 클라이언트 키워드 매칭이다(좁고 닫힌 의도 집합, 0ms 지연, 오프라인 안전, 신규 백엔드 0).
// "Gemini 음성 체감"은 낭독 콘텐츠(rec.reason)가 Gemini 산출물이라는 점으로 충족된다.

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
export function classifyIntent(transcripts: string[]): VoiceIntent {
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

/**
 * 카드 진입 발화 문장. 핵심은 Gemini가 만든 reason을 그대로 읽어주는 것.
 * 예: "1번째 추천이에요. Indu 뷔페 식당. 도보 2분, 예상 대기 8분 수준으로 지금 가장 여유로워요. 여기로 안내할까요?"
 */
export function buildCardSpeech(name: string, reason: string, indexZeroBased: number): string {
  const r = (reason || "").slice(0, 200).trim();
  const body = r ? `${name}. ${r}` : `${name}.`;
  return `${indexZeroBased + 1}번째 추천이에요. ${body} 여기로 안내할까요?`;
}
