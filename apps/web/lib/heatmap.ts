// 히트맵 오버레이 공용 헬퍼 — 혼잡 blob 의 색/크기 규칙을 한 곳에 모아
// 카카오맵(CustomOverlay)과 시뮬레이션(절대배치 div) 양쪽에서 동일하게 재사용한다.
//
// 색 임계값은 lib/utils 의 getMarkerSvg 와 컴포넌트의 getCongestionBadge 가 쓰는
// 0.75 / 0.5 / 0.25 와 완전히 동일하게 유지한다(혼잡=빨강 · 보통=주황 · 여유=에메랄드 · 한산=파랑).
// 마커/배지와 히트맵 색이 어긋나면 정직성 표기가 훼손되므로 이 한 곳만 고쳐 쓴다.

/** 혼잡도(0~1)에 대응하는 히트맵 blob 대표색(밝은 500 계열 RGB 채널) */
export function getHeatColor(level: number): { r: number; g: number; b: number } {
  if (typeof level !== "number" || Number.isNaN(level)) {
    return { r: 148, g: 163, b: 184 }; // 데이터 없음 (slate 400)
  }
  if (level >= 0.75) return { r: 239, g: 68, b: 68 }; // 혼잡 (red-500)
  if (level >= 0.5) return { r: 245, g: 158, b: 11 }; // 보통 (amber-500)
  if (level >= 0.25) return { r: 16, g: 185, b: 129 }; // 여유 (emerald-500)
  return { r: 59, g: 130, b: 246 }; // 한산 (blue-500)
}

/** 혼잡도에 비례한 blob 지름(px) — 40~120 사이 선형 보간(혼잡할수록 크게 번진다) */
export function getHeatRadius(level: number): number {
  const clamped = Math.max(0, Math.min(1, typeof level === "number" ? level : 0));
  return Math.round(40 + clamped * 80);
}

/** blob 배경용 radial-gradient — 중심은 진하고 가장자리로 갈수록 투명해져 열처럼 번진다 */
export function getHeatGradient(level: number): string {
  const { r, g, b } = getHeatColor(level);
  return (
    `radial-gradient(circle, ` +
    `rgba(${r},${g},${b},0.75) 0%, ` +
    `rgba(${r},${g},${b},0.45) 40%, ` +
    `rgba(${r},${g},${b},0) 72%)`
  );
}
