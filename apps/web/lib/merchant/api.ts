// 사장님 콘솔(머천트) 전용 API 헬퍼 — apps/web/lib/api-client.ts·lib/supabase.ts 의 타임아웃 관례를 미러한다.
// 정적 export 앱이라 모든 호출은 클라이언트에서 직접 FastAPI 를 부른다(서버 액션/route handler 없음).

import { createPublicClient } from "@/lib/supabase";

const BASE_URL = process.env.NEXT_PUBLIC_FASTAPI_URL || "http://localhost:8000";
// 무응답 백엔드에 무한 대기하지 않도록 타임아웃 — 각 섹션이 스켈레톤에 영원히 갇히지 않게 한다.
// (/predict/batch 는 전체 시설 순회 + 행사 보정을 포함해 콜드 캐시일 때 1~2초대가 걸릴 수 있고,
//  예측 섹션은 이 호출을 여러 hours_ahead 값으로 동시에 여러 번 보낸다 — 넉넉히 12초로 잡는다.)
const REQUEST_TIMEOUT_MS = 12000;

/** 서버가 알려준 실패 사유의 기계 판독용 코드. 화면이 문구를 고르는 근거다. */
export type MerchantErrorReason = "unknown" | "model_not_trained";

export class MerchantApiError extends Error {
  readonly status?: number;
  /** 다시 눌러 보면 달라질 수 있는 실패인가.
   *
   * false 면 화면은 '다시 시도' 를 **권하지 않는다**. 영구 실패에 재시도 버튼을 붙이면
   * 사장님은 눌러도 영원히 같은 결과를 본다 — 화면이 원인을 안다고 말할 수 있는데도
   * 모르는 척하는 것과 같다. */
  readonly retryable: boolean;
  readonly reason: MerchantErrorReason;
  constructor(
    message: string,
    status?: number,
    options: { retryable?: boolean; reason?: MerchantErrorReason } = {}
  ) {
    super(message);
    this.name = "MerchantApiError";
    this.status = status;
    this.retryable = options.retryable ?? true;
    this.reason = options.reason ?? "unknown";
  }
}

/** 예측 모델이 아직 학습되지 않아 예측 섹션을 제공할 수 없을 때 던진다(영구 실패). */
export class MerchantForecastUnavailableError extends MerchantApiError {
  /** 서버 /predict/model-info 의 fallback_state 원문(예: "degraded_rules"). 모르면 null. */
  readonly modelState: string | null;
  constructor(message: string, status: number | undefined, modelState: string | null) {
    super(message, status, { retryable: false, reason: "model_not_trained" });
    this.name = "MerchantForecastUnavailableError";
    this.modelState = modelState;
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
  // 인증은 Supabase JWT 하나로 통일한다(RBAC P2). 백엔드가 이 토큰에서 users.role 과
  // facility_owners 소유권을 확인하므로, 프런트가 가게 id 를 바꿔 보내도 남의 가게는 열리지 않는다.
  // (구 X-Merchant-Token 공유 토큰 경로는 백엔드에서 LEGACY_CONSOLE_TOKENS 로만 남아 있고,
  //  프런트는 더 이상 보내지 않는다 — 그 플래그를 내리면 완전히 사라진다.)
  const { data: { session } } = await createPublicClient().auth.getSession();
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (session?.access_token) {
    headers.set("Authorization", `Bearer ${session.access_token}`);
    // 프록시 경유 배포에서 Authorization 이 덮이는 경우 대비(api-client 와 동일 관례).
    headers.set("X-Supabase-Authorization", `Bearer ${session.access_token}`);
  }

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

/** POST /timesale 의 응답 — 목록(GET)에는 없는 '실제 적용 할인율' 안내가 함께 온다.
 *
 * 서버는 활성 세일이 겹칠 때 **최댓값 rate 만** 추천에 반영한다(merchant_boost). 그래서 방금
 * 발행한 할인율이 실제로 적용되는 값과 다를 수 있고, 그건 사장님이 반드시 알아야 하는 사실이다.
 * 세 필드가 모두 null 이면 서버가 활성 세일을 조회하지 못했다는 뜻이다(모르는 값을 지어내지
 * 않는다) — 그때는 안내를 생략한다.
 */
export interface MerchantTimesaleCreated extends MerchantTimesale {
  other_active_timesale_count: number | null;
  effective_timesale_rate: number | null;
  effective_timesale_note: string | null;
}

/** 기본 안내 — 겹치는 세일이 없어 방금 발행한 할인율이 그대로 적용될 때 쓴다. */
const TIMESALE_DEFAULT_NOTICE =
  "할인율이 기본 쿠폰율보다 높으면 추천 랭킹 인센티브에 반영됩니다.";

/** 발행 직후 사장님에게 보여줄 설명 문구.
 *
 * 서버가 '실제 적용 할인율' 안내를 실어 보냈으면 **그것을 우선한다.** 예전에는 서버가 이
 * 문장을 만들어 보내는데도 프런트가 응답에서 읽지 않아, 30% 세일이 진행 중인데 15% 를 발행한
 * 사장님이 "15% 발행 완료" 만 보고 자기 값이 적용된다고 믿었다.
 */
export function timesalePublishNotice(created: MerchantTimesaleCreated | null | undefined): string {
  const note = created?.effective_timesale_note;
  if (typeof note === "string" && note.trim()) return note;
  return TIMESALE_DEFAULT_NOTICE;
}

/** 서버가 준 안내가 있는가(있으면 화면에 오래 남겨야 한다 — 토스트만으로는 놓치기 쉽다). */
export function hasTimesaleOverlapNotice(
  created: MerchantTimesaleCreated | null | undefined
): boolean {
  return timesalePublishNotice(created) !== TIMESALE_DEFAULT_NOTICE;
}

export function fetchActiveTimesales(facilityId: string): Promise<MerchantTimesale[]> {
  return merchantFetch(`/api/v1/merchant/timesale?facility_id=${encodeURIComponent(facilityId)}`);
}

export function createTimesale(
  facilityId: string,
  rate: 0.15 | 0.2 | 0.3,
  durationMinutes: 60 | 120 | 180
): Promise<MerchantTimesaleCreated> {
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
  /** 이 방송을 시계열 관측(congestion_logs)으로도 남겼는가.
   *
   * true=기록됨 / false=기록 실패(방송 자체는 반영됨) / null=해당 없음(해제 요청).
   * 서버는 방송(facilities 갱신)이 성공한 뒤 관측 기록이 실패하면 **200 을 주되 이 필드로
   * 알린다** — 예전에는 500 을 던져 놓고 화면 상태는 이미 바뀌어 있었다(merchant.py 참조).
   * 구 서버(필드 없음)와도 섞여 배포되므로 undefined 를 허용한다. */
  observation_logged?: boolean | null;
  /** observation_logged=false 일 때 사장님에게 그대로 보여줄 서버 문구. */
  observation_note?: string | null;
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

// --- 오늘의 실행 브리핑 (P1-5) — GET /api/v1/merchant/briefing ---
// 백엔드(merchant_briefing_service)가 '앞으로 6시간' 예측 창의 최저 혼잡 시간대 + 타임세일
// 현황을 Solar 로 2~3문장 프로즈화한 결과. briefing=null(스킵/폐기/장애/키 미설정)이면
// 프런트는 카드 자체를 렌더하지 않는다(무해 폴백).
export interface MerchantBriefing {
  briefing: string | null;
  llmStatus: string; // "llm" | "rejected" | "llm_failed" | "disabled" | "skipped" (관찰 필드)
}

// LLM 동작 디버그 배지 — lib/api-client.ts 가 발행하는 'nextspot:llm-debug' CustomEvent 와
// 동일 메커니즘(components/LlmDebugToast.tsx 가 구독, lib/admin-api.ts 패턴 미러).
// 정적 export SSR 안전을 위해 window 가드 + 어떤 예외도 조용히 무시(디버그 배지는 절대
// 주 기능을 방해하지 않는다).
function dispatchMerchantLlmDebug(status: string): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent("nextspot:llm-debug", { detail: { feature: "merchant", status } })
    );
  } catch {
    // CustomEvent 미지원 등 — 무시
  }
}

/** 오늘의 실행 브리핑 조회 — 응답 파싱 직후 디버그 이벤트를 중앙 발행(admin-api 관례 미러). */
export async function fetchMerchantBriefing(facilityId: string): Promise<MerchantBriefing> {
  const data: MerchantBriefing = await merchantFetch(
    `/api/v1/merchant/briefing?facility_id=${encodeURIComponent(facilityId)}`
  );
  if (data && typeof data.llmStatus === "string") {
    dispatchMerchantLlmDebug(data.llmStatus);
  }
  return data;
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
    // 서버가 detail 로 사유를 준다(예: 503 "검증된 혼잡 예측 모델이 없습니다.").
    // 예전에는 그걸 읽지도 않고 상태 코드만 붙여 뭉갰다 — merchantFetch 와 동일하게 살려 쓴다.
    let detail = `예측 조회에 실패했습니다. (${res.status})`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* 본문이 JSON 이 아니면 기본 메시지 유지 */
    }
    throw new MerchantApiError(detail, res.status);
  }
  return res.json();
}

/** GET /predict/model-info 의 일부 — 예측 실패가 '영구' 인지 판정하는 데만 쓴다. */
interface PredictModelInfo {
  trained: boolean;
  /** 미학습 시 서버가 쓰는 폴백 이름(예: "degraded_rules"). 없으면 null. */
  fallbackState: string | null;
}

/** 모델 학습 여부를 서버에 직접 묻는다. 못 물어봤으면 null(=판정 불가, 지어내지 않는다). */
async function fetchPredictModelInfo(): Promise<PredictModelInfo | null> {
  try {
    const res = await timeoutFetch(`${BASE_URL}/predict/model-info`);
    if (!res.ok) return null;
    const body = await res.json();
    if (typeof body?.trained !== "boolean") return null;
    return {
      trained: body.trained,
      fallbackState: typeof body.fallback_state === "string" ? body.fallback_state : null,
    };
  } catch {
    return null;
  }
}

/** 예측 실패의 성격을 서버에 되물어 확정한다.
 *
 * /predict/batch 는 모델 미학습이면 **항상** 503 을 준다(배포 환경의 상시 상태다). 그런데
 * 503 에는 일시적인 것도 있어("이 시점의 혼잡 예측을 낼 수 없습니다") 상태 코드만으로는
 * 구분되지 않는다. 한국어 detail 문자열을 매칭하는 건 서버 문구가 바뀌면 조용히 깨지므로,
 * 권위 있는 출처(model-info)에 한 번 더 물어 trained=false 일 때만 '영구 실패' 로 승격한다.
 * 이 추가 요청은 **실패 경로에서만** 나간다 — 정상 경로의 왕복 수는 그대로다.
 */
async function classifyForecastFailure(error: unknown): Promise<MerchantApiError> {
  const base =
    error instanceof MerchantApiError
      ? error
      : new MerchantApiError("예측 데이터를 불러오지 못했습니다.");
  if (base.status !== 503) return base;
  const info = await fetchPredictModelInfo();
  if (!info || info.trained) return base;
  return new MerchantForecastUnavailableError(base.message, base.status, info.fallbackState);
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
  let responses: PredictBatchResponse[];
  try {
    responses = await Promise.all(hoursAheadList.map((h) => predictBatch(h)));
  } catch (e) {
    // 실패를 일반 오류로 뭉개지 않는다 — 사유를 확정해 화면이 '재시도' 를 권할지 결정하게 한다.
    throw await classifyForecastFailure(e);
  }

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

// --- 예측 섹션 안내 문구 ---------------------------------------------------
// 화면이 **실제로 무엇을 보여주고 있는지**만 말한다. 예전에는 곡선을 하나도 못 그린 상태
// (예측 실패·내 시설이 응답에 없음)에서도 "최근 실측 혼잡 로그가 없어 유형 평균 곡선을
// 보여드립니다" 라고 적혀 있었다 — 있지도 않은 폴백을 제공하는 것처럼 말한 셈이다.
// 문구 선택이 렌더 조건과 어긋나지 않게 순수 함수로 묶어 두고 테스트로 잠근다.

const FORECAST_BASE_NOTE = "가게가 얼마나 붐빌지에 대한 예측치이며, 방문객 수나 실측이 아닙니다.";

export function forecastHonestNote(opts: { curveShown: boolean; anchored: boolean }): string {
  if (!opts.curveShown) {
    // 곡선이 없을 때는 '무엇을 보여준다' 는 약속을 아예 하지 않는다.
    return FORECAST_BASE_NOTE;
  }
  return opts.anchored
    ? `${FORECAST_BASE_NOTE} 우리 가게의 최근 실측 혼잡도에 앵커링된 시간대 곡선입니다.`
    : `${FORECAST_BASE_NOTE} 우리 가게의 최근 실측 혼잡 로그가 없어, 시설 유형 수준의 예측 곡선을 보정 없이 보여드립니다.`;
}
