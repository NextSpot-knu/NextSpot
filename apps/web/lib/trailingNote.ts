// 한 줄 문구 끝의 괄호 덧붙임을 떼어 낸다 — 예: 'ⓒ … TourAPI (unless credited otherwise)'.
// 화면은 덧붙임을 한 덩어리(whitespace-nowrap)로 그린다: 좁은 폰에서 줄이 괄호 한가운데서 갈라지면
// ('…TourAPI (unless' / 'credited otherwise)') 괄호가 무엇을 덧붙이는지 한눈에 읽히지 않는다.

export interface TrailingNote {
  /** 덧붙임 앞 본문(뒤 공백 포함 — 그 자리가 줄바꿈 자리다). */
  lead: string;
  /** 끝의 괄호 덧붙임(반각·전각 괄호). 없으면 null. */
  note: string | null;
}

export function splitTrailingNote(text: string): TrailingNote {
  const match = /^([\s\S]*?)([(（][^()（）]*[)）])\s*$/.exec(text);
  if (!match || match[1].trim().length === 0) return { lead: text, note: null };
  return { lead: match[1], note: match[2] };
}
