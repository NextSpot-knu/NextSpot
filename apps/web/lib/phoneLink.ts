// 카드의 전화번호 → 누르면 걸리는 tel: 링크.
//
// TourAPI·카카오 전화 칸은 번호 하나가 아닐 때가 많다: '054-…, 010-…'(여러 번호), '054-772-3843~4'(끝자리 범위),
// '054-772-3843(매표소)'(괄호 설명). 숫자만 남기면 '05477238434' 처럼 없는 번호가 되어 엉뚱한 곳으로 걸린다.
// 그래서 첫 번호만 — 쉼표·빗금·물결·여는 괄호·두 칸 이상 공백 앞까지 — 숫자와 + 로 남긴다. 숫자만 든 괄호는
// 지역번호 표기('(054)772-3843')라 괄호만 벗긴다.

/** 첫 번호의 tel: 링크. 숫자가 3자리 미만이면 null — 화면은 글자로만 보여 준다. */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = String(phone)
    .replace(/\((\d+)\)/g, '$1')
    .split(/[,/~(]|\s{2,}/)[0]
    .replace(/[^\d+]/g, '');
  return digits.length >= 3 ? `tel:${digits}` : null;
}
