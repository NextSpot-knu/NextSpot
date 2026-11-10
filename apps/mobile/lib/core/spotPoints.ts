// 서버 SPOT 점수(0~1)를 카드에 보이는 정수 점수(0~100)로 바꾼다 — 웹 apps/web/lib/recommender.ts recToSpot 과 같은 규칙.
// 이미 100 단위로 저장된 값(옛 킵 북마크 등)은 그대로 둔다. 숫자 문자열("55", "0.548")은 웹처럼 숫자로 읽는다.
// 숫자가 아니거나 음수면 0(웹은 음수를 그대로 내지만 서버가 내지 않는 값이라 'SPOT -50점' 대신 0 으로 막는다).

export function spotPoints(raw?: number | string | null): number {
  const n = typeof raw === 'string' ? (raw.trim() === '' ? Number.NaN : Number(raw)) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0;
  return Math.round(n <= 1 ? n * 100 : n);
}
