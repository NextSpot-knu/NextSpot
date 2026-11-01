// 안드로이드 한국어 낱말 단위 줄바꿈 — iOS 의 lineBreakStrategyIOS="hangul-word"(웹 word-break: keep-all)에 해당하는 것이
// 안드로이드에는 없다(기본은 음절 사이 어디서나 끊는다). 낱말 안 한글 음절 사이에 U+2060(WORD JOINER)을 넣어 끊지 못하게 한다.
// 공백·문장부호 앞뒤는 그대로라 거기서만 줄이 바뀐다.
import { Children, type ReactNode } from 'react';

export const WORD_JOINER = '⁠';

// 한글 음절(AC00–D7A3) · 호환 자모(3130–318F) · 자모(1100–11FF)
const HANGUL = '[\\u1100-\\u11FF\\u3130-\\u318F\\uAC00-\\uD7A3]';
const BETWEEN_HANGUL = new RegExp(`(?<=${HANGUL})(?=${HANGUL})`, 'g');

/** 한글과 한글 사이에 WORD JOINER 를 넣는다. 한글이 아닌 글자 사이·이미 들어 있는 곳에는 넣지 않는다. */
export function keepKoreanWords(text: string): string {
  return text.replace(BETWEEN_HANGUL, WORD_JOINER);
}

/** keepKoreanWords 의 역 — 접근성 라벨 등 읽기 화면에 넘기는 글에서 WORD JOINER 를 뺀다. */
export function stripWordJoiners(text: string): string {
  return text.split(WORD_JOINER).join('');
}

/** 자식 중 문자열에만 keepKoreanWords 를 건다(배열이면 원소별). 겹친 Text 요소는 자기 Text 가 처리한다. */
export function keepKoreanWordsInChildren(children: ReactNode): ReactNode {
  if (typeof children === 'string') return keepKoreanWords(children);
  if (Array.isArray(children)) {
    return Children.toArray(children).map((child) => (typeof child === 'string' ? keepKoreanWords(child) : child));
  }
  return children;
}
