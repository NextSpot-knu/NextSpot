// 관제 히트맵의 색 척도 — 관광객 지도와 같은 등급·경계·색(PM 결정 4.26, I64).
//
// 예전 관제 히트맵은 여유(옅은 민트)·보통(초록)·혼잡(호박)·매우 혼잡(빨강)이라, 관광객 지도(한산 파랑 · 여유 초록 ·
// 보통 호박 · 혼잡 빨강)와 같은 '보통' 이 한쪽은 초록, 한쪽은 호박이었다. 두 화면이 같은 말을 같은 색으로 하도록
// 경계는 lib/congestionScale.congestionKey(운영자 '혼잡' 경계 포함)를, 색은 지도 마커·열지도의 500 계열을 쓴다.
// 값이 없는 칸은 등급이 아니다 — 범례에 따로 적지 않고 빈 칸으로 둔다.

import { congestionKey, DEFAULT_BUSY_THRESHOLD, type CongestionKey } from './congestionScale';

/** 등급 → 칸 색(Tailwind). lib/map/heatmap.ts·markerSvg.ts 의 500 계열과 같은 색이다. */
export const HEATMAP_GRADE_CLASS: Record<CongestionKey, string> = {
  quiet: 'bg-blue-500',
  relaxed: 'bg-emerald-500',
  moderate: 'bg-amber-500',
  busy: 'bg-red-500',
};

/** 등급 → 한국어 이름(관광객 화면의 congestion.{key} ko 와 같다 — 관제 콘솔은 한국어 전용). */
export const HEATMAP_GRADE_LABEL: Record<CongestionKey, string> = {
  quiet: '한산',
  relaxed: '여유',
  moderate: '보통',
  busy: '혼잡',
};

/** 칸 색. 값이 없으면 null(호출부가 빈 칸으로 그린다). */
export function heatmapCellClass(value: number | null | undefined, busyAt: number = DEFAULT_BUSY_THRESHOLD): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return HEATMAP_GRADE_CLASS[congestionKey(value, busyAt)];
}

/** 범례 네 칸 — 경계는 지도와 같다(한산 <25% · 여유 <50% · 보통 < 혼잡 경계 · 혼잡 ≥ 경계). */
export function heatmapLegend(busyAt: number = DEFAULT_BUSY_THRESHOLD): { key: CongestionKey; label: string; className: string }[] {
  const busyPct = Math.round(busyAt * 100);
  // 경계가 50% 아래로 내려오면 '보통' 이, 25% 아래로 내려오면 '여유' 도 사라진다(혼잡 판정이 먼저다 — congestionKey).
  const keys: CongestionKey[] = (['quiet', 'relaxed', 'moderate', 'busy'] as const).filter(
    (key) => (key !== 'moderate' || busyAt > 0.5) && (key !== 'relaxed' || busyAt > 0.25),
  );
  const range: Record<CongestionKey, string> = {
    quiet: `0~${Math.min(25, busyPct)}%`,
    relaxed: `${Math.min(25, busyPct)}~${Math.min(50, busyPct)}%`,
    moderate: `50~${busyPct}%`,
    busy: `${busyPct}%~`,
  };
  return keys.map((key) => ({ key, label: `${HEATMAP_GRADE_LABEL[key]} (${range[key]})`, className: HEATMAP_GRADE_CLASS[key] }));
}
