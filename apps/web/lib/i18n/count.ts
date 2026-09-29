/**
 * 개수 문구의 단수 키 — 영어는 1 일 때 '1 spots' 가 아니라 '1 spot' 이어야 한다.
 * n 이 1 이면 `<key>One` 을 쓴다. 단·복수 구별이 없는 언어(ko·ja·zh)는 두 키에 같은 문장을 둔다.
 */
export function countKey(key: string, n: number): string {
  return n === 1 ? `${key}One` : key;
}
