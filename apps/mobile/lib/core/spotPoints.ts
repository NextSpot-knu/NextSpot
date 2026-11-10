// 서버 SPOT 점수(0~1)를 카드에 보이는 정수 점수(0~100)로 바꾼다 — 웹 apps/web/lib/recommender.ts recToSpot 과 같은 규칙.
// 이미 100 단위로 저장된 값(옛 킵 북마크 등)은 그대로 둔다. 숫자가 아니면 0.

export function spotPoints(raw?: number | null): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.round(raw <= 1 ? raw * 100 : raw);
}
