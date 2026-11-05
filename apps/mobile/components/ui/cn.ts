// className 조각 잇기. 주의: NativeWind 는 같은 속성의 두 클래스(text-sm · text-base)를 '나중에 쓴 쪽'이 아니라
// 생성된 CSS 순서로 고른다(tailwind-merge 없음). 그래서 기본값은 같은 종류의 클래스가 없을 때만 붙인다(withDefault).
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** className 에 pattern 과 맞는 클래스가 하나도 없으면 fallback 을 붙인다. */
export function withDefault(
  className: string | undefined,
  pattern: RegExp | ((c: string) => boolean),
  fallback: string,
): string {
  const test = typeof pattern === 'function' ? pattern : (c: string) => pattern.test(c);
  const classes = (className ?? '').split(/\s+/).filter(Boolean);
  return classes.some(test) ? classes.join(' ') : cn(fallback, ...classes);
}

/** 글자 크기 클래스(text-xs … text-9xl, text-[13px]). */
export const TEXT_SIZE_CLASS = /^text-(xs|sm|base|lg|xl|[2-9]xl|\[\d+(\.\d+)?(px|rem)?\])$/;
/** 글자 정렬 클래스 — 색이 아니다. */
const TEXT_ALIGN_CLASS = /^text-(left|center|right|justify|start|end)$/;
/** 글자 색 클래스(크기·정렬이 아닌 text-*). */
export function isTextColorClass(c: string): boolean {
  const base = c.replace(/^[\w-]+:/, '');
  return base.startsWith('text-') && !TEXT_SIZE_CLASS.test(base) && !TEXT_ALIGN_CLASS.test(base);
}
