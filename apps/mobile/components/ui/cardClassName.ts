// Card 의 className 짓기 — react-native 를 import 하지 않는 순수 모듈이라 node 테스트(cardClassName.test.ts)로 잠근다.
import { cn, withDefault } from './cn';

/**
 * 테두리 '색' 클래스 — border-gold/35 · border-line · border-[#abc] · border-transparent.
 * 색이 아닌 것은 빼고 본다: 방향(border-t · border-x-2 · border-s-gold), 두께(border-2 · border-[1.5px]),
 * 선 모양(border-solid · border-dashed · border-dotted · border-double · border-hidden · border-none). (R3 G5b-03 ③)
 */
export const CARD_BORDER_COLOR =
  /^border-(?!(?:[trblxyse]{1}(?:$|-)|\d|\[\d|(?:solid|dashed|dotted|double|hidden|none)$))/;
/** 네 변 테두리 두께 — border-0 · border-2 · border-[1.5px]. 방향 두께(border-t-2)는 네 변 기본 1px 위에 덮이므로 넣지 않는다. */
const CARD_BORDER_WIDTH = /^border-(?:\d|\[\d)/;
/** 바탕 — bg-gold/10 · bg-hanji-deep · bg-[#fff] · bg-transparent. */
const CARD_BG = /^bg-/;
/** 네 모서리 둥글기 — rounded · rounded-3xl · rounded-[20px]. 한쪽 모서리(rounded-t-3xl)는 나머지에 기본이 남아야 하므로 넣지 않는다. */
const CARD_RADIUS = /^rounded(?:-(?:none|sm|md|lg|xl|[2-9]xl|full|\[[^\]]+\]))?$/;

/**
 * 기본 모양(rounded-2xl · border(1px) · border-line · bg-white)은 화면 className 이 같은 속성을 주지 않았을 때만 붙인다.
 * NativeWind 는 같은 속성의 두 클래스 중 '나중에 쓴 쪽'이 아니라 CSS 순서(알파벳)로 고르므로 덧붙이면 기본값이 이긴다
 * (예: bg-white 가 bg-gold/10 을, border-line 이 border-gold/35 를 이긴다 — G5b-03, 안드로이드도 같다).
 * 안쪽 여백은 예외로 padded 만 본다 — 다른 여백을 주려면 padded={false} 와 함께 준다.
 */
export function cardClassName(className: string | undefined, padded: boolean): string {
  let classes = cn(padded && 'p-[16px]', className);
  classes = withDefault(classes, CARD_BG, 'bg-white');
  classes = withDefault(classes, CARD_BORDER_COLOR, 'border-line');
  classes = withDefault(classes, CARD_BORDER_WIDTH, 'border');
  classes = withDefault(classes, CARD_RADIUS, 'rounded-2xl');
  return classes;
}
