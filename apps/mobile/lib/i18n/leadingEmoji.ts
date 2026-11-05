// 문구 맨 앞 이모지를 떼어 낸다 — 이모지는 장식이라 스크린리더(TalkBack)가 읽지 않게 따로 숨기고 나머지만 읽히게.
// 순수 함수(테스트: leadingEmoji.test.ts). 맨 앞 '낱말'(공백 전까지)이 이모지·기호로만 이뤄졌을 때만 이모지로 본다.

const EMOJI_ONLY =
  /^(?:[\uD83C-\uD83E][\uDC00-\uDFFF]|[←-⇿⌀-⏿☀-➿⬀-⯿️‍⃣©®‼⁉™ℹ〰〽㊗㊙])+$/;

export function splitLeadingEmoji(text: string): { emoji: string | null; rest: string } {
  const m = /^(\S+)\s+([\s\S]+)$/.exec(text);
  if (!m) return { emoji: null, rest: text };
  const head = m[1]!;
  return EMOJI_ONLY.test(head) ? { emoji: head, rest: m[2]! } : { emoji: null, rest: text };
}
