import { createPublicClient } from "./supabase";
const supabase = createPublicClient();

// 인증 필요(HTTP 401)를 서버 장애·기타 오류와 구분하기 위한 전용 에러 타입.
// 관광객 로그인이 없어 인증 필수 엔드포인트(/coupons/mine, /courses/recommend 등)는 401 을 준다.
// 호출부는 isAuthError() 로 이 경우를 가려내 '다시 시도' 대신 정직한 안내를 보여준다.
export class AuthError extends Error {
  readonly status = 401;
  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthError";
  }
}

// AuthError(또는 status === 401 이 붙은 임의 에러) 여부 판별 가드.
export function isAuthError(err: unknown): err is AuthError {
  return (
    err instanceof AuthError ||
    (typeof err === "object" && err !== null && (err as { status?: number }).status === 401)
  );
}

// 일시적 서버 의존성 장애(HTTP 503)를 인증 실패·기타 오류와 구분하기 위한 전용 타입.
export class ServiceUnavailableError extends Error {
  readonly status = 503;
  constructor(message = "Service temporarily unavailable") {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}

// ServiceUnavailableError(또는 status === 503 이 붙은 임의 에러) 여부 판별 가드.
export function isServiceUnavailable(err: unknown): err is ServiceUnavailableError {
  return (
    err instanceof ServiceUnavailableError ||
    (typeof err === "object" && err !== null && (err as { status?: number }).status === 503)
  );
}

// 헬퍼: snake_case -> camelCase
function snakeToCamel(s: string): string {
  return s.replace(/(_\w)/g, (k) => k[1].toUpperCase());
}

// 헬퍼: camelCase -> snake_case
function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// 재귀적으로 객체 키를 camelCase로 변환 (모듈 내부 전용)
// 입력은 임의 JSON(unknown). 반환은 any 유지 — request() 의 추론 반환형(Promise<any>)이
// 레포 전역의 apiClient.get/post 소비처(res.predictions, data.vector 등) 계약이기 때문.
function keysToCamel(o: unknown): any {
  if (o === null || o === undefined) return o;
  if (Array.isArray(o)) {
    return o.map(keysToCamel);
  }
  if (typeof o === "object") {
    const n: Record<string, unknown> = {};
    Object.keys(o).forEach((k) => {
      n[snakeToCamel(k)] = keysToCamel((o as Record<string, unknown>)[k]);
    });
    return n;
  }
  return o;
}

// 재귀적으로 객체 키를 snake_case로 변환 (모듈 내부 전용)
function keysToSnake(o: unknown): unknown {
  if (o === null || o === undefined) return o;
  if (Array.isArray(o)) {
    return o.map(keysToSnake);
  }
  if (typeof o === "object") {
    const n: Record<string, unknown> = {};
    Object.keys(o).forEach((k) => {
      n[camelToSnake(k)] = keysToSnake((o as Record<string, unknown>)[k]);
    });
    return n;
  }
  return o;
}

// --- LLM 동작 디버그 배지 이벤트 (개발 전용) ---
// components/LlmDebugToast.tsx 가 구독하는 전역 CustomEvent. 백엔드가 llm_status/reason_source
// 필드를 아직 안 주는 구버전 응답에도 무해하도록, 호출부는 필드가 있을 때만 발행한다(방어적).
// 정적 export(SSR) 안전을 위해 window 존재 가드 필수.
type LlmDebugDetail =
  | { feature: "voice" | "lab"; status: string }
  | { feature: "reason"; llmCount: number; templateCount: number };

function dispatchLlmDebug(detail: LlmDebugDetail): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("nextspot:llm-debug", { detail }));
  } catch {
    // 디버그 배지는 절대 주 기능(추천/음성/실험실 응답)을 방해하지 않는다(Codex P2) —
    // CustomEvent 미지원·패치된 dispatchEvent 등 어떤 예외도 조용히 무시.
  }
}

// 로컬 전용: FastAPI 백엔드 직접 호출(기본 http://localhost:8000). 대회용 API Gateway 경유는 제거됨.
const BASE_URL = process.env.NEXT_PUBLIC_FASTAPI_URL || "http://localhost:8000";
// 무응답 백엔드에 무한 대기하지 않도록 타임아웃(lib/admin-api.ts adminRequest 의 기존 패턴 미러).
const REQUEST_TIMEOUT_MS = 10000;

interface RequestOptions extends Omit<RequestInit, "body"> {
  params?: Record<string, string>;
  /** 평문 객체를 주면 request() 가 snake_case 변환 후 JSON 직렬화한다(FormData 등 BodyInit 은 그대로 전송) */
  body?: unknown;
}

async function request(path: string, options: RequestOptions = {}) {
  // 1. Supabase JWT 토큰 추출
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (token) {
    // 로컬/직접 호출에서는 Authorization 을 읽는다. API Gateway 경유(프로덕션)에서는 게이트웨이가
    // Authorization 을 백엔드 인증용 OIDC 로 덮어쓰므로, Supabase JWT 를 X-Supabase-Authorization
    // 로도 실어 보낸다(백엔드 get_current_user 가 X-(Forwarded|Supabase)-Authorization 을 우선 확인).
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("X-Supabase-Authorization", `Bearer ${token}`);
  }

  // query parameter 처리
  let url = `${BASE_URL}${path}`;
  if (options.params) {
    const queryParams = new URLSearchParams(keysToSnake(options.params) as Record<string, string>);
    url += `?${queryParams.toString()}`;
  }

  // body가 존재하는 경우 camelCase -> snake_case 변환 후 전송
  // (평문 객체는 아래에서 JSON 문자열로 직렬화되므로 fetch 에 넘어갈 때는 항상 BodyInit 계열 — 타입 단언만, 런타임 동일)
  let body = options.body as BodyInit | null | undefined;
  if (body && typeof body === "object" && !(body instanceof FormData)) {
    body = JSON.stringify(keysToSnake(body));
  }

  // 10초 타임아웃 — 미응답 시 명확한 에러로 실패시켜 화면이 무한 로딩에 갇히지 않게 한다.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const message = errorData.detail || `HTTP error! status: ${response.status}`;
    // 401 은 서버 장애가 아니라 '인증 필요' 신호 → 호출부가 구분할 수 있게 전용 타입으로 던진다.
    if (response.status === 401) {
      throw new AuthError(message);
    }
    if (response.status === 503) {
      throw new ServiceUnavailableError(message);
    }
    throw new Error(message);
  }

  // 응답 데이터 json 파싱 및 snake_case -> camelCase 변환
  const data = await response.json();
  return keysToCamel(data);
}

// D5: TourAPI 마지막 동기화 신선도 — GET /api/v1/freshness 응답(keysToCamel 적용 후).
// source: 'event'=app_events 동기화 마커 실측, 'estimate'=facilities.updated_at 추정. 이력 전무면 전부 null.
export interface FreshnessResponse {
  lastTourapiSync: string | null; // ISO 시각
  source: "event" | "estimate" | null;
  written: number | null; // 마지막 동기화에서 기록된 시설 수(추정 폴백이면 null)
}

export const apiClient = {
  get: (path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    request(path, { ...options, method: "GET" }),

  post: (path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    request(path, { ...options, method: "POST", body }),

  // D5: TourAPI 마지막 동기화 시각 조회 — 홈 소형 표시·관리자 신선도 배지 공용.
  getFreshness: (): Promise<FreshnessResponse> =>
    request("/api/v1/freshness", { method: "GET" }),
};

export async function mergeGuestData(guestToken: string): Promise<void> {
  await apiClient.post("/api/v1/account/merge-guest", { guestToken });
}

// --- SPOT 추천 엔진 연동 API 함수 ---

export interface RecommendationResponse {
  recommendationId: string;
  facility: {
    id: string;
    name: string;
    type: string;
    latitude: number;
    longitude: number;
    capacity: number;
    // 인제스트는 {open: 영업시간, closed: 휴무일} 저장(수동 시드는 weekday/weekend 등 다른 키도 존재).
    operatingHours?: { open?: string; closed?: string; [key: string]: any } | null;
    features?: Record<string, unknown> | null; // JSONB(주소·전화·cuisine_tags·barrier_free 등 혼합)
    // TourAPI 상세 필드(전부 Optional) — '지어내지 않기': 실데이터가 있을 때만 내려온다.
    imageUrl?: string | null;
    galleryImages?: string[] | null;
    address?: string | null;
    phone?: string | null;
    homepage?: string | null;
    overview?: string | null;
    barrierFree?: boolean | null;
    currentCount?: number;
    congestionLevel?: number;
    // 머천트 랭킹 연동 2단계: 활성 타임세일 할인율(0~0.5) — 타임세일이 기본 쿠폰율보다 클 때만 존재.
    timesaleRate?: number | null;
    // 30분 내 사장 좌석 확인(신선도). 과거 패턴 추정보다 우선하는 실측 신호.
    seatStatusFresh?: { level: "low" | "mid" | "full"; minutesAgo: number } | null;
  };
  spotScore: number;
  breakdown: {
    preference: number;
    waitTime: number;
    travelTime: number;
    incentive: number;
    // 행사 혼잡 보정(A4): 도착시점 인근 진행 중 축제로 인한 예측 혼잡 가중(0=보정 없음)과 근거 축제명
    eventBoost?: number;
    eventTitle?: string | null;
  };
  distanceM: number;
  reason?: string; // 백엔드 템플릿 생성 추천 사유 (snake_case reason → camel reason)
  // 추천 사유가 LLM(Solar)로 생성됐는지 템플릿인지 — LLM 동작 디버그 배지 집계용(구버전 응답엔 없음).
  reasonSource?: "llm" | "template";
  rank: number;
  totalCandidates: number;
}

/** 추천 목록의 reasonSource 를 집계해 디버그 배지 이벤트를 1회 발행한다(항목에 하나도 없으면 무발행). */
function dispatchReasonSourceDebug(items: RecommendationResponse[]): void {
  let llmCount = 0;
  let templateCount = 0;
  let seen = false;
  for (const item of items) {
    if (item.reasonSource === "llm") {
      llmCount++;
      seen = true;
    } else if (item.reasonSource === "template") {
      templateCount++;
      seen = true;
    }
  }
  if (!seen) return;
  dispatchLlmDebug({ feature: "reason", llmCount, templateCount });
}

export async function getRecommendations(
  originalFacilityId: string,
  userLocation: { lat: number; lng: number }
): Promise<RecommendationResponse[]> {
  // Supabase 세션에서 현재 로그인한 유저 ID 획득
  const { data: { session } } = await supabase.auth.getSession();
  let userId = session?.user?.id;

  if (!userId) {
    console.warn("인증 세션이 없습니다. 데모용 모의 사용자 ID(GYEONGJU-VISITOR-01)를 사용합니다.");
    userId = "a2222222-2222-2222-2222-222222222222";
  }

  const res: RecommendationResponse[] = await apiClient.post("/api/v1/recommendations", {
    userId,
    originalFacilityId,
    userLat: userLocation.lat,
    userLng: userLocation.lng
  });
  dispatchReasonSourceDebug(res);
  return res;
}

/**
 * 피드백 액션 어휘(거절 실험실 도입 후 신규). 레거시(accepted/rejected/ignored) 중
 * 'rejected' 만 의미가 유지되고, 나머지 레거시 값은 API 입력에서 제외됐다.
 * - accepted_visit_intent : 실제 방문 수락(길안내/수락) — 쿠폰·성과지표·벡터 +10%
 * - rejected              : 명시 거절 — 이유 질문 대기(pending), 장기 학습은 보류
 * - skipped               : 음성 '다음'/나중에 — 학습 없음
 * - dismissed_batch       : '다른 대안 보기' — 학습 없음
 * - unsaved               : 저장 해제 — 학습 없음
 * - helpful / not_helpful : 만족도 👍/👎 — 품질 신호만, 벡터 학습 없음
 */
export type FeedbackAction =
  | "accepted_visit_intent"
  | "rejected"
  | "skipped"
  | "dismissed_batch"
  | "unsaved"
  | "helpful"
  | "not_helpful";

/**
 * 결정 액션(accepted_visit_intent/rejected/skipped/dismissed_batch/unsaved)은 백엔드에서
 * recommendation_id 기준 멱등 upsert — 같은 추천에 중복 전송해도 학습이 두 번 적용되지 않는다.
 */
export async function submitFeedback(
  recommendationId: string,
  action: FeedbackAction
): Promise<{ success: boolean; updatedVector: boolean }> {
  return apiClient.post("/api/v1/feedback", {
    recommendationId,
    action
  });
}

/** 메인 탐색 거절을 실험실 pending 항목으로 저장한다. 호출부는 UX를 막지 않고 fire-and-forget 한다. */
export async function rejectRecommendation(
  facilityId: string
): Promise<{ success: boolean; recommendationId: string; feedbackId: string; reasonStatus: string }> {
  return apiClient.post("/api/v1/recommendations/reject", { facilityId });
}

// --- 거절 실험실 (Rejection Lab) ---

/** 거절 이유 코드. 백엔드가 learning_scope(long_term|data_quality|session|none)로 매핑한다. */
export type LabReasonCode =
  | "too_far"
  | "too_crowded"
  | "not_my_taste"
  | "too_expensive"
  | "closed"
  | "already_visited"
  | "bad_timing"
  | "inaccurate"
  | "other";

/** GET /api/v1/lab/pending 항목 (keysToCamel 적용 후). */
export interface LabPendingItem {
  feedbackId: string;
  recommendationId: string;
  facilityId: string;
  facilityName: string;
  facilityType: string;
  recommendedAt: string; // ISO 시각
  spotScore?: number;
}

/** 본인의 이유 미응답 거절 목록 — 숨김 제외, 30일 이내, 최신순 최대 10건. */
export async function fetchLabPending(): Promise<LabPendingItem[]> {
  return apiClient.get("/api/v1/lab/pending");
}

/** 이유 질문 대기 건수 — 배지 표시용. */
export async function fetchLabPendingCount(): Promise<number> {
  const data: { count: number } = await apiClient.get("/api/v1/lab/pending/count");
  return data.count;
}

/** 거절 이유 응답 → reason_status='answered' + 학습 정확히 1회 적용. */
export async function answerLabReason(
  feedbackId: string,
  reasonCode: string,
  reasonNote?: string
): Promise<void> {
  await apiClient.post(`/api/v1/lab/${feedbackId}/reason`, {
    reasonCode,
    reasonNote
  });
}

/**
 * 자유 텍스트 거절 이유를 백엔드가 LLM 으로 기존 카테고리에 매핑한다.
 * resolved=true 면 선택지 제출과 동일하게 처리(학습 정확히 1회) → 목록에서 제거.
 * resolved=false 면(LLM 비활성/실패/확신 없음) 프런트가 "선택지에서 골라주세요"로 폴백한다(무해).
 */
export async function classifyLabReason(
  feedbackId: string,
  text: string
): Promise<{ resolved: boolean }> {
  const data: { resolved?: boolean; llmStatus?: "llm" | "llm_failed" | "disabled" } = await apiClient.post(
    `/api/v1/lab/${feedbackId}/reason/classify`,
    { text }
  );
  if (data.llmStatus) {
    dispatchLlmDebug({ feature: "lab", status: data.llmStatus });
  }
  return { resolved: data.resolved === true };
}

/** 이유 응답 건너뛰기 → reason_status='skipped'. */
export async function skipLabItem(feedbackId: string): Promise<void> {
  await apiClient.post(`/api/v1/lab/${feedbackId}/skip`);
}

/** 목록에서 숨기기 → hidden_at=now(). */
export async function hideLabItem(feedbackId: string): Promise<void> {
  await apiClient.post(`/api/v1/lab/${feedbackId}/hide`);
}

/**
 * 타입별(음식점/카페/관광지/문화시설) 추천 랭킹 — 메인 지도 브라우즈용.
 * 백엔드가 사용자 선호 벡터·실시간 혼잡·거리로 SPOT 점수를 매기고 상위 N개에 템플릿 사유를 붙여 반환.
 * (/recommendations 가 '혼잡한 원본의 대안'을 주는 것과 달리, 원본 없이 타입 전체를 랭킹한다.)
 */
export async function recommendByType(
  facilityType: string,
  userLocation: { lat: number; lng: number },
  excludeIds: string[] = [],
  limit = 5
): Promise<RecommendationResponse[]> {
  const { data: { session } } = await supabase.auth.getSession();
  let userId = session?.user?.id;
  if (!userId) {
    console.warn("인증 세션이 없습니다. 데모용 모의 사용자 ID(GYEONGJU-VISITOR-01)를 사용합니다.");
    userId = "a2222222-2222-2222-2222-222222222222";
  }
  const res: RecommendationResponse[] = await apiClient.post("/api/v1/recommendations/by-type", {
    userId,
    facilityType,
    userLat: userLocation.lat,
    userLng: userLocation.lng,
    excludeIds,
    limit
  });
  dispatchReasonSourceDebug(res);
  return res;
}

// --- 자연어 선호 입력 (키워드 파싱 → 추천 반영) ---

export interface ParsePreferenceResult {
  preferredCategories: string[];
  attributes: string[];
  summary: string;       // 'AI가 이렇게 이해했어요' 한국어 문장
  isFallback: boolean;   // 정규 파서 대신 키워드 규칙 폴백을 썼는지
  vectorUpdated: boolean;
  categoriesSaved: boolean;
}

/**
 * 사용자가 자연어로 말한/적은 선호를 백엔드로 보내 구조화하고,
 * 선호 벡터와 preferred_categories 에 즉시 반영한다.
 */
export async function parsePreference(text: string): Promise<ParsePreferenceResult> {
  return apiClient.post("/api/v1/preferences/parse", { text });
}

// --- 음성 비서 1턴 해석 (백엔드 키워드 분류기) ---

export interface VoiceTurnCandidate {
  id: string;
  name: string;
  cuisine?: string[] | string | null; // 음식 종류(한식/분식/카페·디저트 등) — 메뉴/종류 매칭용
  // 공식 메뉴(TourAPI first_menu/treat_menu 결합) — 백엔드 embedding_service 의 후보 haystack
  // (name+cuisine+category+menu)가 이미 읽는 필드인데 프런트가 보낸 적이 없었다(2026-07-17 감사).
  menu?: string | null;
  congestion?: number; // 0~1
  distanceM?: number;
}

export interface VoiceTurnResult {
  action: string; // accept|next|reject|details|select|filter|stop|unknown
  targetFacilityId: string | null;
  matchIds: string[]; // filter 일 때 선호에 맞는 후보 id들('양식'→양식 식당들)
  spoken: string | null; // 백엔드 생성 한국어 응답(없으면 프런트 자체 멘트)
  // 이번 턴이 LLM(Solar)로 처리됐는지/키워드 폴백인지 — LLM 동작 디버그 배지용(구버전 응답엔 없음).
  llmStatus?: "keyword" | "llm" | "llm_failed" | "gated" | "disabled";
}

/**
 * 음성 비서가 추천을 안내한 뒤 사용자의 자유발화 응답을 백엔드(로컬 키워드 분류기)로 보내
 * 의도(accept/next/reject/details/select/stop)를 분류하고, 선호 표현이면 후보 중 가장 맞는
 * 시설(targetFacilityId)을 고르며, 한국어 응답(spoken)을 생성한다. 무인증 엔드포인트.
 */
export async function voiceTurn(
  utterance: string,
  facilityType: string,
  currentName: string | null,
  candidates: VoiceTurnCandidate[]
): Promise<VoiceTurnResult> {
  const res: VoiceTurnResult = await apiClient.post("/api/v1/voice/turn", {
    utterance,
    facilityType,
    currentName,
    candidates,
  });
  if (res.llmStatus) {
    dispatchLlmDebug({ feature: "voice", status: res.llmStatus });
  }
  return res;
}
