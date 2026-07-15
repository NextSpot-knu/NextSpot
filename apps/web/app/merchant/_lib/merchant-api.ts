// 사장님 콘솔(머천트) 전용 API 헬퍼 — apps/web/lib/api-client.ts·lib/supabase.ts 의 타임아웃 관례를 미러한다.
// 정적 export 앱이라 모든 호출은 클라이언트에서 직접 FastAPI 를 부른다(서버 액션/route handler 없음).

import { getMerchantToken } from "./merchant-auth";

const BASE_URL = process.env.NEXT_PUBLIC_FASTAPI_URL || "http://localhost:8000";
// 무응답 백엔드에 무한 대기하지 않도록 타임아웃 — 각 섹션이 스켈레톤에 영원히 갇히지 않게 한다.
// (/predict/batch 는 전체 시설 순회 + 행사 보정을 포함해 콜드 캐시일 때 1~2초대가 걸릴 수 있고,
//  예측 섹션은 이 호출을 여러 hours_ahead 값으로 동시에 여러 번 보낸다 — 넉넉히 12초로 잡는다.)
const REQUEST_TIMEOUT_MS = 12000;

export class MerchantApiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "MerchantApiError";
    this.status = status;
  }
}

async function timeoutFetch(input: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function merchantFetch(path: string, init: RequestInit = {}) {
  const token = getMerchantToken();
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("X-Merchant-Token", token);

  let res: Response;
  try {
    res = await timeoutFetch(`${BASE_URL}${path}`, { ...init, headers });
  } catch {
    // 네트워크 오류/타임아웃(AbortError 포함) — 백엔드 미가용으로 통일해 호출부가 동일하게 폴백하게 한다.
    throw new MerchantApiError("사장님 서버에 연결할 수 없습니다.");
  }

  if (!res.ok) {
    let detail = `요청이 실패했습니다. (${res.status})`;
    try {
      const body = await res.json();
      if (body?.detail) detail = body.detail;
    } catch {
      /* 본문이 JSON 이 아니면 기본 메시지 유지 */
    }
    throw new MerchantApiError(detail, res.status);
  }
  if (res.status === 204) return null;
  return res.json();
}

// --- 성적표 ---
export interface MerchantStats {
  facility_id: string;
  since: string;
  window_days: number;
  coupons_issued: number;
  coupons_used: number;
  congestion_reports: number;
  recommendations_exposed: number;
  recommendations_accepted: number;
  visit_confirmations: number | null;
  visit_confirmations_note: string;
}

export function fetchMerchantStats(facilityId: string): Promise<MerchantStats> {
  return merchantFetch(`/api/v1/merchant/stats?facility_id=${encodeURIComponent(facilityId)}`);
}

// --- 셀프 타임세일 ---
export interface MerchantTimesale {
  id: string;
  facility_id: string;
  rate: number;
  starts_at: string;
  ends_at: string;
  canceled_at: string | null;
  created_at: string;
}

export function fetchActiveTimesales(facilityId: string): Promise<MerchantTimesale[]> {
  return merchantFetch(`/api/v1/merchant/timesale?facility_id=${encodeURIComponent(facilityId)}`);
}

export function createTimesale(
  facilityId: string,
  rate: 0.15 | 0.2 | 0.3,
  durationMinutes: 60 | 120 | 180
): Promise<MerchantTimesale> {
  return merchantFetch(`/api/v1/merchant/timesale`, {
    method: "POST",
    body: JSON.stringify({ facility_id: facilityId, rate, duration_minutes: durationMinutes }),
  });
}

export function cancelTimesale(id: string, facilityId: string): Promise<MerchantTimesale> {
  return merchantFetch(`/api/v1/merchant/timesale/cancel`, {
    method: "POST",
    body: JSON.stringify({ id, facility_id: facilityId }),
  });
}

// --- 좌석 상태 방송 ---
export type SeatLevel = "low" | "mid" | "full";

export interface SeatStatusResult {
  facility_id: string;
  level: SeatLevel;
  updated_at: string;
}

export function updateSeatStatus(facilityId: string, level: SeatLevel): Promise<SeatStatusResult> {
  return merchantFetch(`/api/v1/merchant/seat-status`, {
    method: "POST",
    body: JSON.stringify({ facility_id: facilityId, level }),
  });
}

/** 좌석 상태 방송 해제 결과 — 해제 시 level 은 null 로 내려온다(응답 형태는 저장과 동일). */
export interface SeatStatusClearResult {
  facility_id: string;
  level: SeatLevel | null;
  updated_at: string | null;
}

// 방송 끄기 — 같은 엔드포인트에 level:null 을 보내면 features.seat_status 가 제거된다.
// (제거 후에는 merchant_boost 의 좌석 오버레이가 더 이상 적용되지 않는다.)
export function clearSeatStatus(facilityId: string): Promise<SeatStatusClearResult> {
  return merchantFetch(`/api/v1/merchant/seat-status`, {
    method: "POST",
    body: JSON.stringify({ facility_id: facilityId, level: null }),
  });
}

// --- 예측 유입 (기존 공개 엔드포인트 POST /predict/batch 재사용, 무인증) ---
interface PredictBatchItem {
  facility_id: string;
  predicted_congestion: number;
  anchored: boolean;
  event_boost: number;
}

interface PredictBatchResponse {
  generated_at: string;
  hours_ahead: number;
  predictions: PredictBatchItem[];
}

async function predictBatch(hoursAhead: number): Promise<PredictBatchResponse> {
  let res: Response;
  try {
    res = await timeoutFetch(`${BASE_URL}/predict/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hours_ahead: hoursAhead }),
    });
  } catch {
    throw new MerchantApiError("예측 서버에 연결할 수 없습니다.");
  }
  if (!res.ok) {
    throw new MerchantApiError(`예측 조회에 실패했습니다. (${res.status})`, res.status);
  }
  return res.json();
}

export interface HourlyCongestionPoint {
  hoursAhead: number;
  /** KST 기준 시(0-23) 라벨 — 화면 표시용. */
  hour: number;
  congestion: number;
  /** 이 시설의 실측 로그에 앵커링된 예측인지(false 면 타입 수준 원값). */
  anchored: boolean;
}

// 지금(+0h)부터 maxHoursAhead 시간 뒤까지, 이 시설 하나의 예측 혼잡도만 뽑아 시계열로 만든다.
// /predict/batch 는 전체 시설을 반환하므로(시설별 필터 파라미터 없음) hours_ahead 값별로 호출한 뒤
// facility_id 로 걸러낸다 — score.py/predict.py 를 건드리지 않고 기존 엔드포인트만 재사용.
export async function fetchFacilityCongestionForecast(
  facilityId: string,
  maxHoursAhead = 6
): Promise<HourlyCongestionPoint[]> {
  const hoursAheadList = Array.from({ length: maxHoursAhead + 1 }, (_, i) => i);
  const responses = await Promise.all(hoursAheadList.map((h) => predictBatch(h)));

  const points: HourlyCongestionPoint[] = [];
  for (const res of responses) {
    const item = res.predictions.find((p) => p.facility_id === facilityId);
    if (!item) continue;
    const targetUtcMs = new Date(res.generated_at).getTime() + res.hours_ahead * 3600 * 1000;
    const kstHour = new Date(targetUtcMs + 9 * 3600 * 1000).getUTCHours();
    points.push({
      hoursAhead: res.hours_ahead,
      hour: kstHour,
      congestion: item.predicted_congestion,
      anchored: item.anchored,
    });
  }
  return points;
}
