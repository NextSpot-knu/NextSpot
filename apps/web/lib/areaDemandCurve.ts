// 권역 주차 수요 전망 곡선 — GET /api/v1/area-demand/forecast 를 앞으로 몇 시간의 정시마다
// 훑어 "KST 정시 → 수요(0~1)" 맵으로 만든다. /waiting 보드의 '한산해지는 시각'이 이 곡선을 읽는다.
//
// 이 엔드포인트는 공개 GET 이고(인증 불필요), 과거 동일 시간대 표본이 모자라면 숫자를 만들지 않고
// `available=false` 로 정직하게 빈손을 돌려준다. 그래서 여기서도 없는 시각은 맵에 넣지 않는다 —
// 모르는 시간대를 0 으로 채우면 '한산해지는 시각'이 거짓으로 당겨진다.
//
// 서버 계약상 창은 도착 30분~6시간 뒤다. 그 밖은 조용히 비는 게 정상이다(에러 아님).
// 백엔드가 동시 요청에 503 을 내는 사례가 있어(waiting/page.tsx 주석 참조) **순차**로 호출한다.
// 전부 실패해도 빈 맵을 돌려주고, 호출부는 내장 시간대 곡선만으로 계속 동작한다.

import { apiClient } from "@/lib/api-client";

/** KST 정시(0~23) → 권역 수요(0~1). 표본이 없는 시각은 아예 키가 없다. */
export type AreaDemandCurve = Record<number, number>;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 서버가 전망을 만들어 주는 창(도착 30분~6시간 뒤) 안쪽의 정시들. */
const FORECAST_STEPS_HOURS = [1, 2, 3, 4, 5, 6];

interface ForecastResponse {
  available?: boolean;
  forecast?: { level?: number | null } | null;
}

/**
 * 기준 시각(baseAt)부터 앞으로 6시간의 정시 권역 수요를 모은다.
 * 실패·미가용은 조용히 건너뛴다 — 부분만 채워진 곡선도 그대로 쓸모가 있다.
 */
export async function fetchAreaDemandCurve(
  lat: number,
  lng: number,
  baseAt: Date = new Date(),
  signal?: AbortSignal,
): Promise<AreaDemandCurve> {
  const curve: AreaDemandCurve = {};
  // 기준 시각의 '다음 정시'부터 훑는다(과거 시각은 서버가 422 로 거절한다).
  const kstBase = new Date(baseAt.getTime() + KST_OFFSET_MS);
  const nextHourUtcMs =
    Date.UTC(
      kstBase.getUTCFullYear(),
      kstBase.getUTCMonth(),
      kstBase.getUTCDate(),
      kstBase.getUTCHours() + 1,
      0,
      0,
    ) - KST_OFFSET_MS;

  for (const step of FORECAST_STEPS_HOURS) {
    if (signal?.aborted) break;
    const at = new Date(nextHourUtcMs + (step - 1) * 60 * 60 * 1000);
    try {
      const data: ForecastResponse = await apiClient.get("/api/v1/area-demand/forecast", {
        params: { lat: String(lat), lng: String(lng), arrivalAt: at.toISOString() },
        timeoutMs: 8000,
        signal,
      });
      const level = data?.forecast?.level;
      if (data?.available && typeof level === "number" && Number.isFinite(level)) {
        const hourKst = new Date(at.getTime() + KST_OFFSET_MS).getUTCHours();
        curve[hourKst] = Math.min(1, Math.max(0, level));
      }
    } catch {
      /* 표본 부족·일시 장애 — 이 시각만 비워 두고 계속 진행한다 */
    }
  }
  return curve;
}
