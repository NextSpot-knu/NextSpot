// 관제 화면의 혼잡 경보 기준 — 대시보드 '이상 혼잡' · 예측 피크 · 안전 경보가 같은 숫자를 쓴다(P0-4).
//
// 예전에는 안전 경보 화면만 경보 85% 였고, 대시보드·추정 집계·예측 피크는 90% 였다. 같은 시각에 대시보드는
// '이상 0건' 인데 안전 화면은 '경보' 를 띄울 수 있었다. 서버의 정본은
// apps/api/app/services/congestion_estimator_service.py 의 ANOMALY_LEVEL 이고(안전 라우터 safety.py 의
// 기본 경보값도 그 상수다), adminAlertLevels.test.ts 가 두 숫자가 갈라지지 않게 잠근다.

/** 경보(이상 혼잡) 기준 — 혼잡도 0..1. 이 값 이상이면 경보다(경계 포함). */
export const ADMIN_ALERT_LEVEL = 0.9;

/** 주의 기준(안전 경보 화면의 기본값) — 서버 safety.DEFAULT_WARN_THRESHOLD 와 같다. */
export const ADMIN_WARN_LEVEL = 0.7;

/** 기준을 화면 문구용 % 정수로('90%' 의 90). */
export function levelPercent(level: number): number {
  return Math.round(level * 100);
}
