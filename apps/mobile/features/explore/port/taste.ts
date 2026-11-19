// 앞면 취향 일치율 칩 규칙 — 웹 apps/web/lib/compareHeader.ts 의 tasteBenefitPercent·faceTastePercent 만 옮겼다
// (웹 파일은 congestionEstimate → api-client 타입 사슬이 check:shared 에 걸린다).

const TASTE_BENEFIT_MIN_PERCENT = 50;
const TASTE_FACE_MIN_PERCENT = 60;

export function tasteBenefitPercent(preferencePercent: number | null | undefined): number | null {
  return typeof preferencePercent === 'number' &&
    Number.isInteger(preferencePercent) &&
    preferencePercent >= TASTE_BENEFIT_MIN_PERCENT
    ? preferencePercent
    : null;
}

/** 그 숫자가 장소를 가를 때만(60% 이상, 함께 보이는 후보가 모두 같은 숫자가 아닐 때). 아니면 null. */
export function faceTastePercent(
  preferencePercent: number | null | undefined,
  peers: readonly (number | null | undefined)[] = [],
): number | null {
  const pct = tasteBenefitPercent(preferencePercent);
  if (pct === null || pct < TASTE_FACE_MIN_PERCENT) return null;
  const known = peers.filter((p): p is number => typeof p === 'number' && Number.isFinite(p)).map((p) => Math.round(p));
  if (known.length >= 2 && known.every((p) => p === pct)) return null;
  return pct;
}
