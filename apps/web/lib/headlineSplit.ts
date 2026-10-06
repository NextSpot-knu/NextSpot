// 대기 보드 카드 머리줄의 '값 덩어리' 찾기(2026-10-06 감사 I52/I53).
//
// 한국어가 아닌 머리줄은 값(쌍점 뒤 '普通'·'Moderate', 또는 숫자+단위 '約10分'·'约10分钟'·'10 min')을 한 덩어리로
// 묶어 좁은 카드에서도 값 한가운데서 접히지 않게 한다. 중국어·일본어는 띄어 쓰지 않으므로 공백에 기대지 않는다 —
// '预计等待约12分钟' 에서 '约12分钟' 만 묶고, 앞의 '预计等待' 는 그 언어 규칙대로 접힌다.

/** [앞, 묶을 값, 뒤] — 묶을 값이 없으면 null. */
export function splitHeadlineValue(text: string): [string, string, string] | null {
  const colon = Math.max(text.lastIndexOf(': '), text.lastIndexOf('：'));
  if (colon >= 0) {
    const at = text[colon] === ':' ? colon + 2 : colon + 1;
    const value = text.slice(at);
    return value ? [text.slice(0, at), value, ''] : null;
  }
  const m = /[约約]?\d+\S*(?:\s+min\b)?/.exec(text);
  if (!m) return null;
  return [text.slice(0, m.index), m[0], text.slice(m.index + m[0].length)];
}
