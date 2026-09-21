import { createPublicClient } from "./supabase";
import { keysToCamel, keysToSnake } from "./caseTransform";
import type { TravelContext } from "./travelContext";
import { loadTravelContext } from "./travelContext";
import { REGION } from "./region";
import type { PlaceCategory } from "./travelContext";
import type { VoiceAppCommand } from "./voice/voiceCommands";
import type { Locale } from "./i18n/config";
import { ensureAnonymousSession } from "./anonymousSession";
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
// 그 밖의 HTTP 오류. 상태 코드를 **버리지 않는다** — 맨 Error 로 던지면 호출부가
// "다시 시도하면 되는 실패" 와 "몇 번을 보내도 같은 실패" 를 구분할 수 없다. 실제로
// 추천 결과 전송 큐가 그것 때문에 영구 실패 하나에 영영 막혔다(lib/recommendationOutcomes.ts).
/** FastAPI 오류 본문에서 사람이 읽을 메시지를 꺼낸다(422 의 배열 detail 포함). */
export function errorMessageFrom(body: unknown, status: number): string {
  const fallback = `HTTP error! status: ${status}`;
  if (typeof body !== "object" || body === null) return fallback;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail)) {
    const first = detail.find(
      (d) => typeof d === "object" && d !== null && typeof (d as { msg?: unknown }).msg === "string",
    ) as { msg?: string } | undefined;
    if (first?.msg) return first.msg;
  }
  return fallback;
}

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HttpError";
  }
}

/** 에러에 실린 HTTP 상태 코드(없으면 undefined). AuthError·ServiceUnavailableError 도 함께 잡는다. */
export function httpStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

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

// 키 변환은 lib/caseTransform.ts 로 분리했다(테스트 가능하게 — 그 파일 주석 참고).
// 응답은 camelCase 로, 요청은 snake_case 로 나간다.

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

// 재시도 백오프(ms). Render 공유 Cloudflare 의 Managed Challenge 가 버스트 요청을 엣지에서
// 막으면 브라우저엔 네트워크/CORS 실패(fetch 거부)로 나타난다 — 요청이 서버에 도달조차 못 한다.
// 짧게 기다렸다 다시 보내면 대개 통과한다. 배열 길이 = 최대 재시도 횟수. 지터로 동시 버스트를 흩뜨려
// 재도전이 또 같은 챌린지에 묶이지 않게 한다.
const RETRY_BACKOFF_MS = [700];
const jittered = (ms: number) => ms + Math.floor(Math.random() * 250);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 의도 선반영 프리페치 — 심사위원이 /main 에 머무는 동안 대기 보드(4유형 by-type)와 분산 코스
 * 요청을 백그라운드로 미리 발사해 **서버 응답 캐시(단일비행·180s TTL)를 먼저 채운다.**
 * 이후 탭을 눌렀을 때의 첫 요청이 캐시 히트가 되어 즉시 뜬다(지각 지연 제거).
 * 대기 보드와 정확히 같은 인자(위치·limit 8·가정 시각)·코스 기본 바디를 미러해야 캐시 키가
 * 일치한다. 전부 발사 후 망각·순차(동시성 1)·실패 무시 — 어떤 경우에도 UI 에 영향 없다.
 */
export function prefetchDemoHotPaths(): void {
  void (async () => {
    try {
      const session = await ensureAnonymousSession();
      const userId = session?.user?.id;
      const assumedAt = assumedAtIsoForPreset(getStoredAssumedPreset());
      const loc = { lat: REGION.center.lat, lng: REGION.center.lng };
      // /waiting 보드 미러 — BOARD_TYPES · PER_TYPE_LIMIT(8) · 45s 타임아웃 동일.
      for (const type of ["restaurant", "cafe", "attraction", "culture"]) {
        try {
          await recommendByType(type, loc, [], 8, undefined, undefined, undefined, 45000, assumedAt);
        } catch { /* 프리페치 실패 무시 — 실제 탭 진입 시 정상 경로가 처리 */ }
      }
      // /course 기본 요청 미러(핀·시퀀스 없음) — 콜드 첫 생성(~40s)을 심사위원 클릭 전에 치른다.
      if (userId) {
        const body: Record<string, unknown> = {
          userId,
          userLat: loc.lat,
          userLng: loc.lng,
          context: loadTravelContext(),
        };
        if (assumedAt) body.assumedAt = assumedAt;
        try {
          await apiClient.post("/api/v1/courses/plan", body, { timeoutMs: 60000 });
        } catch { /* 무시 */ }
      }
    } catch { /* 세션 실패 등 — 프리페치는 어떤 경우에도 조용히 포기 */ }
  })();
}

/**
 * 백엔드 캐시 워밍 트리거 — 발사 후 망각(fire-and-forget).
 * 랜딩 마운트 시 호출해 시설·availability·주차·축제 캐시를 미리 데운다. 사용자가 지도/대기보드/
 * 코스에 도달할 즈음 백엔드가 이미 웜 상태가 되게 하는 것이 목적(콜드 단건 20~40초 실측 대응).
 * 엔드포인트 부재(구 배포 404)·네트워크 실패 전부 조용히 무시 — 어떤 경우에도 UI 에 영향 없다.
 */
export function warmBackend(): void {
  try {
    void fetch(`${BASE_URL}/api/v1/warmup`, { method: "GET", keepalive: true }).catch(() => {});
  } catch { /* fetch 자체가 없는 환경(SSR 등) — 무시 */ }
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  params?: Record<string, string>;
  timeoutMs?: number;
  /** 평문 객체를 주면 request() 가 snake_case 변환 후 JSON 직렬화한다(FormData 등 BodyInit 은 그대로 전송) */
  body?: unknown;
  /** true 면 네트워크/엣지 실패에도 재시도하지 않는다(기본은 재시도 — request() 재시도 주석 참고). */
  noRetry?: boolean;
}

async function request(path: string, options: RequestOptions = {}) {
  // 1. Supabase JWT 토큰 추출
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (token) {
    // Authorization 을 덮어쓰는 프록시 뒤에 놓일 경우를 대비해 Supabase JWT 를
    // X-Supabase-Authorization 으로도 함께 실어 보낸다(백엔드 get_current_user 가
    // X-(Forwarded|Supabase)-Authorization 을 우선 확인한다).
    //
    // 지금 배포에는 그런 프록시가 없다 — Vercel 정적 export → Render 직접 호출이다.
    // 20줄 위 주석이 "대회용 API Gateway 경유는 제거됨" 이라고 적어 둔 그것이고, 예전 이 자리
    // 주석은 반대로 "프로덕션은 게이트웨이 경유" 라고 단언해 서로 어긋나 있었다.
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
  // FormData 만 빼면 안 된다. 위 주석이 약속한 것은 "BodyInit 은 그대로" 인데, Blob·
  // URLSearchParams·ArrayBuffer 도 typeof 가 "object" 라 이 분기에 걸려 JSON.stringify 를
  // 거치면 **본문이 통째로 "{}" 가 되어** 조용히 빈 요청이 나간다. 지금 그런 호출부는 없지만,
  // 주석을 믿고 파일 업로드를 붙이는 다음 사람이 그 자리에서 당한다.
  const isRawBody =
    body instanceof FormData ||
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) ||
    (typeof ArrayBuffer !== "undefined" && (body instanceof ArrayBuffer || ArrayBuffer.isView(body)));
  if (body && typeof body === "object" && !isRawBody) {
    body = JSON.stringify(keysToSnake(body));
  }

  // 10초 타임아웃 — 미응답 시 명확한 에러로 실패시켜 화면이 무한 로딩에 갇히지 않게 한다.
  const externalSignal = options.signal;

  // --- 재시도: Render 공유 Cloudflare 의 Managed Challenge 는 버스트 요청을 엣지에서 막아
  // 브라우저에 네트워크/CORS 실패(fetch 거부)로 나타난다 — 요청이 서버에 도달조차 못 하므로
  // 짧은 백오프 뒤 다시 보내면 대개 통과하고, 서버 미도달이라 재시도가 안전하다(멱등성 무관).
  // '응답을 받은' 경우는 대개 서버가 처리한 결과이므로 재시도하지 않는다. 단, 429(레이트리밋·엣지
  // 챌린지)·503(일시적 미가용 — 재배포·의존성 과부하)은 요청이 처리되지 못한 신호라 재시도한다.
  // 타임아웃·외부 취소는 의도된 중단이라 재시도하지 않는다. 재생 불가 본문(FormData 등)·noRetry 제외.
  const canRetry = !options.noRetry && !isRawBody;
  const maxAttempts = canRetry ? RETRY_BACKOFF_MS.length + 1 : 1;

  let response: Response | undefined;
  let lastNetworkErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? REQUEST_TIMEOUT_MS);

    let networkErr: unknown;
    try {
      const { params: _params, timeoutMs: _timeoutMs, signal: _signal, noRetry: _noRetry, ...fetchOptions } = options;
      response = await fetch(url, {
        ...fetchOptions,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // 타임아웃/외부 취소는 의도된 중단 — 재시도하지 않고 즉시 알린다.
        if (!timedOut && externalSignal?.aborted) throw err;
        throw new Error("요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.");
      }
      networkErr = err; // 네트워크/CORS 실패(엣지 챌린지 포함) — 서버 미도달.
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromCaller);
    }

    if (networkErr !== undefined) {
      lastNetworkErr = networkErr;
      response = undefined;
      if (attempt < maxAttempts - 1) {
        await sleep(jittered(RETRY_BACKOFF_MS[attempt]));
        continue;
      }
      throw networkErr; // 모든 시도 소진 — 마지막 네트워크 오류를 그대로 던진다.
    }

    // 응답을 받았으면(성공/4xx/5xx 무관) 그대로 처리한다. 429·503 을 재시도하면 이미 과부하·
    // 봇차단된 백엔드에 부하를 더해 악화시킨다(리트라이 스톰 → Cloudflare IP 차단 — 라이브에서 확인됨).
    // 그래서 응답 상태로는 재시도하지 않고, 네트워크 실패(서버 미도달)만 위에서 1회 재시도한다.
    break;
  }

  if (!response) {
    // 위 루프가 네트워크 실패 시 throw 하므로 이론상 도달 불가 — 타입 좁히기용 안전망.
    throw lastNetworkErr ?? new Error("요청에 실패했습니다. 잠시 후 다시 시도해 주세요.");
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    // detail 이 문자열일 때만 그대로 쓴다. FastAPI 의 요청 검증 실패(422)는 detail 을
    // **객체 배열**로 준다({loc, msg, type}...). 그걸 Error 메시지에 넣으면 화면에
    // "[object Object]" 가 뜬다 — 사용자에게는 아무 의미도 없고, 우리도 무엇이 틀렸는지
    // 알 수 없다. 배열이면 첫 항목의 msg 만 꺼내고, 그것도 없으면 상태 코드로 떨어진다.
    const message = errorMessageFrom(errorData, response.status);
    // 401 은 서버 장애가 아니라 '인증 필요' 신호 → 호출부가 구분할 수 있게 전용 타입으로 던진다.
    if (response.status === 401) {
      throw new AuthError(message);
    }
    if (response.status === 503) {
      throw new ServiceUnavailableError(message);
    }
    throw new HttpError(message, response.status);
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

  patch: (path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    request(path, { ...options, method: "PATCH", body }),

  delete: (path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    request(path, { ...options, method: "DELETE" }),

  // D5: TourAPI 마지막 동기화 시각 조회 — 홈 소형 표시·관리자 신선도 배지 공용.
  getFreshness: (): Promise<FreshnessResponse> =>
    request("/api/v1/freshness", { method: "GET" }),
};

export async function mergeGuestData(guestToken: string): Promise<void> {
  await apiClient.post("/api/v1/account/merge-guest", { guestToken });
}

export async function deleteMyAccount(): Promise<void> {
  await apiClient.delete("/api/v1/account/me");
}

// --- 가정 시각 시뮬레이터 (데모 전용, /main·/waiting·/course 공용) ---
// 문제: 심야에 서비스를 열면 백엔드가 서버 현재 시각으로 '도착 시 영업여부'를 판정해
// 모든 곳이 걸러진다("도착 시각에 문을 여는 곳이 없어요"·"표시할 장소가 없어요"·"추천할 코스를
// 찾지 못했어요"). 심사위원이 밤에 봐도 실제 결과가 나오도록, 사용자가 요일+시각을 '가정'하면
// 그 절대 시각(ISO 8601)을 recommend/course 로 실어 보내 그 시점 기준으로 계산하게 한다.
// 기본값은 'now'(실시간) — 프리셋을 고르기 전에는 기존 동작과 **완전히 동일**하다.
//
// 상태는 세 화면이 localStorage 한 키(nextspot_assumed_at)로 공유하고, 변경 시 커스텀 이벤트로
// 즉시 서로에게 알린다. 값은 절대 시각이 아니라 **프리셋 id** 를 저장한다 — 매 호출 때 '가장 가까운
// 그 요일/시각'을 다시 계산하므로 세션이 길어져도 어제 날짜가 굳지 않는다.
export const ASSUMED_TIME_STORAGE_KEY = "nextspot_assumed_at";
export const ASSUMED_TIME_EVENT = "nextspot:assumed-time";

export interface AssumedTimePreset {
  id: string;
  labelKey: string;        // i18n 키(timeSim.*)
  dow: number | null;      // JS getUTCDay 규약(0=일 … 6=토). 'now' 는 null.
  hour: number | null;     // KST 기준 시(0-23). 'now' 는 null.
}

// 프리셋: 지금(실시간) · 평일 12:00(수요일 고정) · 금 18:00 · 토 14:00 · 일 11:00.
export const ASSUMED_TIME_PRESETS: AssumedTimePreset[] = [
  { id: "now", labelKey: "timeSim.now", dow: null, hour: null },
  { id: "weekday_noon", labelKey: "timeSim.weekdayNoon", dow: 3, hour: 12 },
  { id: "fri_evening", labelKey: "timeSim.friEve", dow: 5, hour: 18 },
  { id: "sat_afternoon", labelKey: "timeSim.satAfternoon", dow: 6, hour: 14 },
  { id: "sun_morning", labelKey: "timeSim.sunMorning", dow: 0, hour: 11 },
];

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function getStoredAssumedPreset(): string {
  if (typeof window === "undefined") return "now";
  try {
    const v = window.localStorage.getItem(ASSUMED_TIME_STORAGE_KEY);
    return v && ASSUMED_TIME_PRESETS.some((p) => p.id === v) ? v : "now";
  } catch {
    return "now"; // 저장소 차단 환경 — 기본(실시간)
  }
}

export function setStoredAssumedPreset(id: string): void {
  if (typeof window === "undefined") return;
  const valid = ASSUMED_TIME_PRESETS.some((p) => p.id === id) ? id : "now";
  try {
    window.localStorage.setItem(ASSUMED_TIME_STORAGE_KEY, valid);
  } catch { /* 저장소 차단 무시 */ }
  try {
    // 같은 탭의 다른 화면(마운트된 페이지)에 즉시 알린다. storage 이벤트는 '다른 탭' 에서만
    // 발화하므로 같은 탭 동기화에는 커스텀 이벤트가 필요하다.
    window.dispatchEvent(new CustomEvent(ASSUMED_TIME_EVENT, { detail: valid }));
  } catch { /* CustomEvent 미지원 무시 */ }
}

/** 프리셋 id → 백엔드로 보낼 절대 시각(UTC ISO). 'now'·미상은 null(기존 동작 = 서버 현재 시각). */
export function assumedAtIsoForPreset(id: string): string | null {
  const preset = ASSUMED_TIME_PRESETS.find((p) => p.id === id);
  if (!preset || preset.dow === null || preset.hour === null) return null;
  // KST 벽시계로 환산: 지금(UTC)에 +9h 한 Date 의 UTC 게터가 곧 'KST 벽시계' 다.
  const kstNow = new Date(Date.now() + KST_OFFSET_MS);
  const deltaDays = (preset.dow - kstNow.getUTCDay() + 7) % 7;
  // 목표 KST 벽시계(요일+시각, 0분)의 실제 UTC instant = Date.UTC(...) − 9h.
  let utcMs =
    Date.UTC(
      kstNow.getUTCFullYear(),
      kstNow.getUTCMonth(),
      kstNow.getUTCDate() + deltaDays,
      preset.hour,
      0,
      0,
    ) - KST_OFFSET_MS;
  // 오늘이 그 요일이지만 시각이 이미 지났으면 다음 주 같은 요일로 굴린다(과거 시각 회피).
  if (utcMs <= Date.now()) utcMs += 7 * 24 * 60 * 60 * 1000;
  return new Date(utcMs).toISOString();
}

/** 현재 저장된 프리셋 기준 절대 시각(UTC ISO). 'now' 면 null. */
export function getAssumedAtIso(): string | null {
  return assumedAtIsoForPreset(getStoredAssumedPreset());
}

// --- SPOT 추천 엔진 연동 API 함수 ---

// 경주 **추정 모드**의 시설별 혼잡 추정(백엔드 congestion_estimator_service.estimate_evidence).
// 실측이 아니다 — 공영주차 실측(반경 radiusM, lotCount 곳) 0.7 + 관광 집중률 통계 0.3.
// 서버는 실측(·학습 모델 예측)이 없을 때만 싣고, 구 서버 응답에는 필드 자체가 없다.
// 화면은 반드시 lib/congestionEstimate.ts 로 검증(모양·60분 신선도)한 뒤 '추정' 라벨과 함께 그린다.
export interface CongestionEstimate {
  level: number;
  source: "estimated";
  observedAt: string | null;
  parkingLevel: number;
  tourismLevel: number | null;
  lotCount: number;
  nearestLotM: number | null;
  radiusM: number;
  // 서울 실측 보정의 흔적(백엔드 congestion_calibration_service). 전부 Optional —
  // 보정을 모르는 구 서버 응답에는 아예 없다.
  //  · rawLevel        : 보정 전 원값(보정이 꺼져 있으면 level 과 같다)
  //  · calibrated      : 이 level 에 보정이 실제로 적용됐는지
  //  · calibrationBasis: 사람이 읽는 근거 한 줄. '추정' 라벨 **옆 출처 텍스트로만** 쓴다(새 배지 금지).
  rawLevel?: number | null;
  calibrated?: boolean | null;
  calibrationBasis?: string | null;
}

// GET /api/v1/congestion/estimates — 지도 전용 추정 피드(공개, 5분 캐시).
//
// /infrastructures 에 싣지 않고 따로 받는 이유: 그 응답은 프로덕션 TTFB 가 4~6초라 웹의 4초
// 타임아웃을 자주 넘기고, 그러면 Supabase 직접 읽기 폴백이 이긴다 — 거기에는 추정이 없다.
// 별도 피드면 시설이 어느 경로(API·폴백·캐시)로 그려졌든 같은 추정을 덧씌울 수 있다.
// 구 서버는 404 → 호출부가 조용히 '추정 없음' 으로 처리한다. UUID 키는 밑줄이 없어 keysToCamel 을 통과한다.
export interface CongestionEstimatesResponse {
  available: boolean;
  reason: string | null;
  observedAt: string | null;
  radiusM: number | null;
  lotCount: number;
  estimates: Record<string, CongestionEstimate>;
}

export async function getCongestionEstimates(
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<CongestionEstimatesResponse> {
  return apiClient.get("/api/v1/congestion/estimates", {
    timeoutMs: options?.timeoutMs ?? 8000,
    signal: options?.signal,
  });
}

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
    // 실측 혼잡이 있을 때만 capacity×혼잡으로 합성 — 근거 없으면 null(잔여석 합성 금지).
    currentCount?: number | null;
    congestionLevel?: number;
    // 머천트 랭킹 연동 2단계: 활성 타임세일 할인율(0~0.5) — 타임세일이 기본 쿠폰율보다 클 때만 존재.
    timesaleRate?: number | null;
    // 30분 내 사장 좌석 확인(신선도). 과거 패턴 추정보다 우선하는 실측 신호.
    seatStatusFresh?: { level: "low" | "mid" | "full"; minutesAgo: number } | null;
    couponRate?: number | null;
    placeDataSource?: string | null;
    dataUpdatedAt?: string | null;
    availabilityEvidence?: {
      status: "open" | "closed";
      evidenceTier: "single_report" | "corroborated";
      corroboratingCount: number;
      reportedAt: string;
      expiresAt: string;
    } | null;
  };
  spotScore: number;
  breakdown: {
    preference: number;
    waitTime?: number | null;
    travelTime: number;
    travelSource?: "osm_pedestrian" | "estimated";
    incentive: number;
    // 내부 순위에 실제 반영된 시간 구성. measured_rules에서는 숫자 대기를 사용자에게 직접
    // 노출하지 않지만 비교 설명은 이 합계가 순위에 쓰였다는 사실을 투명하게 보여준다.
    rankingWaitTime?: number | null;
    // 행사 혼잡 보정(A4): 도착시점 인근 진행 중 축제로 인한 예측 혼잡 가중(0=보정 없음)과 근거 축제명
    eventBoost?: number;
    eventTitle?: string | null;
    // 장소 내부 혼잡과 분리된 주변 지역 수요(공영주차·관광 통계·행사·날씨).
    areaDemandLevel?: number | null;
    areaDemandMode?: "live" | "forecast" | "statistical" | "contextual" | null;
    areaDemandSources?: ("parking" | "parking_history" | "tourism" | "festival" | "weather")[];
    areaDemandObservedAt?: string | null;
    areaDemandRadiusM?: number | null;
    areaDemandParkingEvidence?: {
      level: number;
      mode: "live" | "forecast";
      observedAt?: string | null;
      radiusM?: number | null;
    } | null;
    areaDemandTourismEvidence?: {
      referenceName?: string | null;
      distanceM?: number | null;
      forecastDate?: string | null;
      relativeIndex?: number | null;
    } | null;
    areaDemandPenaltyMinutes?: number;
    areaDemandConfidence?: "high" | "medium" | "low" | "none";
    areaDemandRank?: number | null;
    areaDemandComparableCount?: number;
    areaDemandPercentile?: number | null;
    areaDemandDeltaVsMedian?: number | null;
    areaDemandDistinguishable?: boolean;
    delayedAreaDemandLevel?: number | null;
    delayedAreaDemandMode?: "forecast" | "statistical" | null;
    arrivalAction?: "go_now" | "wait_then_go" | "choose_calmer" | "no_clear_advantage";
    recommendedDepartureDelayMinutes?: number | null;
    tourapiRelatedRank?: number | null;
    tourapiRelatedPrior?: number | null;
    discoveryThemeMatch?: {
      source: "tourapi_related" | "facility_fact";
      value: string;
    } | null;
  };
  distanceM: number;
  reason?: string; // 백엔드 템플릿 생성 추천 사유 (snake_case reason → camel reason)
  // 추천 사유가 LLM(Solar)로 생성됐는지 템플릿인지 — LLM 동작 디버그 배지 집계용(구버전 응답엔 없음).
  reasonSource?: "llm" | "template";
  // 혼잡 3단계 근거(CONGESTION_TRUST_SPEC): measured=congestion_logs 실측(사장 확인 포함),
  // predicted=학습된 모델의 AI 예측, none=근거 없음(혼잡 정보 준비 중). 구버전 응답엔 없음.
  congestionLevel?: number | null;
  congestionSource?: "measured" | "predicted" | "none";
  congestionLogSource?: string | null; // measured 일 때 원 로그 source(user_report/seed/simulated/…)
  congestionIsStale?: boolean | null;  // measured 일 때 로그 나이>24h
  congestionTimestamp?: string | null;
  // 위 congestionLevel 이 '지금' 을 말할 자격이 있는지 — **서버 판정**이다(백엔드
  // congestion_evidence.evidence_is_current: measured 는 verified/corroborated · 30분 이내,
  // predicted 는 언제나 true, none 은 false). 화면은 다시 계산하지 않고 이 값만 읽는다.
  // false 면 congestionEstimate 가 '지금' 이 되고 이 관측은 '마지막 관측 HH:MM' 으로 남는다.
  // 구 서버 응답에는 없다(undefined) — 그때는 종전 규칙(실측이 있으면 추정을 감춘다) 그대로다.
  congestionIsCurrent?: boolean | null;
  // 추정 모드: '지금' 자격이 있는 실측·예측이 없을 때만 값이 있다
  // (측정(신선·신뢰) > 예측 > 추정 > 없음). **추가만** 한 필드라 congestionSource/congestionLevel 은
  // 건드리지 않는다 — 구 번들이 추정을 실측처럼 칠하지 않게.
  congestionEstimate?: CongestionEstimate | null;
  rank: number;
  totalCandidates: number;
  openStatusAtArrival?: "open_expected" | "closing_soon" | "closed_confirmed" | "needs_confirmation";
  informationConfidence?: "verified" | "unknown";
  eligibilityTier?:
    | "verified_open_route"
    | "verified_open_estimated_route"
    | "hours_confirmation_required_route"
    | "hours_and_route_confirmation_required";
  placeDataSource?: string | null;
  dataUpdatedAt?: string | null;
  scoringMode: "model" | "measured_rules" | "area_stats_rules" | "degraded_rules";
  modelVersion?: string | null;
  predictionSource: "registry" | "measured" | "unavailable";
}

export interface AvailabilityReportResult {
  success: boolean;
  facilityId: string;
  status: "open" | "closed";
  evidenceTier: "single_report" | "corroborated";
  corroboratingCount: number;
  reportedAt: string;
  expiresAt: string;
}

export async function reportFacilityAvailability(
  facilityId: string,
  status: "open" | "closed",
): Promise<AvailabilityReportResult> {
  return apiClient.post("/api/v1/reports/availability", { facilityId, status });
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
  userLocation: { lat: number; lng: number },
  context?: TravelContext,
  options?: {
    preferenceIntent?: string | null;
    candidateTypes?: ("restaurant" | "cafe" | "attraction" | "culture")[];
    discoveryTheme?: "silla_core" | "night_heritage" | "hanok_cafe" | "indoor_history" | "gyochon_walk";
    signal?: AbortSignal;
  },
): Promise<RecommendationResponse[]> {
  const session = await ensureAnonymousSession();
  const userId = session?.user?.id;
  if (!userId) throw new AuthError();

  const body = {
    userId,
    originalFacilityId,
    userLat: userLocation.lat,
    userLng: userLocation.lng,
    context,
    preferenceIntent: options?.preferenceIntent ?? null,
    candidateTypes: options?.candidateTypes ?? [],
    discoveryTheme: options?.discoveryTheme ?? null,
  };
  // 타임아웃 45s: POI 상세의 대안 추천은 재시작 직후 콜드 백엔드에서 기본 10s 를 넘겨
  // 서버가 성공하는데 클라가 먼저 끊었다(2026-09-21 라이브 재현 — waiting 45s·course 60s 와 동일 계열).
  const reqOpts = { signal: options?.signal, timeoutMs: 45000 };
  let res: RecommendationResponse[];
  try {
    res = await apiClient.post("/api/v1/recommendations", body, reqOpts);
  } catch (err) {
    const st = httpStatus(err);
    // 콜드/재시작 직후 일시 503·429 — 2초 뒤 딱 한 번 조용히 재시도(스톰 아님). 호출자 취소 시 제외.
    if ((st === 503 || st === 429) && !options?.signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      res = await apiClient.post("/api/v1/recommendations", body, reqOpts);
    } else {
      throw err;
    }
  }
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

export type RecommendationQuestion = "why_first" | "difference" | "family_check";
export interface RecommendationExplanation {
  answer: string;
  sourceLabels: string[];
  llmStatus: string;
}

export async function explainRecommendation(
  recommendationId: string,
  question: RecommendationQuestion,
  comparisonRecommendationIds: string[] = [],
  locale: Locale = "ko",
): Promise<RecommendationExplanation> {
  return apiClient.post(`/api/v1/recommendations/${recommendationId}/explain`, {
    question,
    comparisonRecommendationIds: comparisonRecommendationIds.slice(0, 2),
    locale,
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

/** GET /api/v1/lab/pending 항목 (keysToCamel 적용 후).
 *
 * ⚠️ **서버가 실제로 주는 키만 적는다.** 예전에는 `feedbackId`·`recommendedAt`·`spotScore` 를
 * 선언했는데 서버는 그 이름을 보낸 적이 없어 셋 다 항상 undefined 였다. 타입이 거짓이면
 * 컴파일러가 잡아 주지 못하고, 그 값으로 만든 URL 이 `/lab/undefined/reason` 이 되어
 * **거절 실험실의 모든 버튼이 404** 였다(사유 응답·건너뛰기·숨기기·직접 설명하기 전부).
 * 서버 계약은 lab.py 의 _serialize_pending 이고 test_lab.py 가 그것을 잠근다. */
export interface LabPendingItem {
  /** feedback 행의 id. 이 값이 곧 /lab/{id}/… 의 경로 조각이다. */
  id: string;
  recommendationId: string;
  facilityId: string;
  facilityName: string;
  facilityType: string;
  /** 거절이 기록된 시각(ISO). 서버 키는 created_at 이다. */
  createdAt: string;
  action?: string;
  reasonStatus?: string;
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
  limit = 5,
  context?: TravelContext,
  preferenceIntent?: string | null,
  signal?: AbortSignal,
  // 콜드스타트로 깨어나는 백엔드가 실데이터를 돌려줄 때까지 이 호출에만 더 긴 대기를 허용한다.
  // 미지정이면 전역 기본(REQUEST_TIMEOUT_MS)을 그대로 쓴다 — 전역 기본은 건드리지 않는다.
  timeoutMs?: number,
  // 데모 '가정 시각'(UTC ISO, assumedAtIsoForPreset 결과). null/미지정이면 서버 현재 시각을 쓴다
  // (기본 동작 불변). 있으면 백엔드가 이 시각 기준으로 도착 영업여부·혼잡·채점을 계산한다.
  assumedAt?: string | null,
): Promise<RecommendationResponse[]> {
  const session = await ensureAnonymousSession();
  const userId = session?.user?.id;
  if (!userId) throw new AuthError();
  const res: RecommendationResponse[] = await apiClient.post("/api/v1/recommendations/by-type", {
    userId,
    facilityType,
    userLat: userLocation.lat,
    userLng: userLocation.lng,
    excludeIds,
    limit,
    context,
    preferenceIntent,
    assumedAt: assumedAt ?? null,
  }, { signal, timeoutMs });
  dispatchReasonSourceDebug(res);
  return res;
}

// --- 자연어 선호 입력 (키워드 파싱 → 추천 반영) ---

export interface ParsePreferenceResult {
  preferredCategories: string[];
  attributes: string[];
  summary: string;       // 백엔드 한국어 요약(하위 호환) — 신 프런트는 구조화 코드로 로케일 요약을 조립
  isFallback: boolean;   // 키워드·LLM 모두 기여하지 못해 폴백했는지 (LLM 실기여 시 false)
  vectorUpdated: boolean;
  categoriesSaved: boolean;
  llmStatus?: "keyword" | "llm" | "llm_failed" | "disabled";
  // 서버가 **실제로 반영했는가.** 2xx 만 보고 '반영했어요' 라고 말하면 안 된다 —
  // 아무 선호도 못 알아들었을 때 서버는 아무것도 쓰지 않고 200 을 돌려준다(그렇게 고쳤다.
  // 예전에는 빈 결과로 학습된 벡터를 전 카테고리 평균으로 덮어썼다).
  // 구버전 백엔드는 이 필드를 안 준다 — undefined 는 '모른다' 이므로 종전대로 성공 처리한다.
  applied?: boolean;
  reason?: "no_preference_detected" | "storage_unavailable";
}

/**
 * 사용자가 자연어로 말한/적은 선호를 백엔드로 보내 구조화하고,
 * 선호 벡터와 preferred_categories 에 즉시 반영한다.
 */
export async function parsePreference(text: string): Promise<ParsePreferenceResult> {
  return apiClient.post("/api/v1/preferences/parse", { text });
}

export interface ParseTravelContextResult {
  context: Partial<TravelContext>;
  llmStatus: "keyword" | "llm" | "llm_failed" | "disabled";
  requiresConfirmation: true;
}

/** 자연어 현장 조건은 구조화만 한다. 호출부에서 사용자가 확인하기 전에는 추천에 적용하지 않는다. */
export async function parseTravelContext(text: string): Promise<ParseTravelContextResult> {
  return apiClient.post("/api/v1/travel-context/parse", { text });
}

// --- 음성 비서 1턴 해석 ---
// 로컬 전용이 아니다: 백엔드가 먼저 키워드로 판정하고(accept·next·stop·details·select·command 면
// 외부 호출 0), **분류되지 않은 발화와 filter 턴만** Upstage 로 나간다(발화 원문·현재 추천 이름·
// 후보 가게 이름 포함). 키가 없거나 차단·실패면 전송 없이 폴백한다.

export interface VoiceTurnCandidate {
  id: string;
  name: string;
  cuisine?: string[] | string | null; // 음식 종류(한식/분식/카페·디저트 등) — 메뉴/종류 매칭용
  // 공식 메뉴(TourAPI first_menu/treat_menu 결합) — 백엔드 embedding_service 의 후보 haystack
  // (name+cuisine+category+menu)가 이미 읽는 필드인데 프런트가 보낸 적이 없었다(2026-07-17 감사).
  menu?: string | null;
  // 정밀분류(features.category, Solar 태깅 배치가 채움) — 백엔드 분류 게이트(cat_of)의 입력.
  category?: string | null;
  congestion?: number | null; // 0~1, null=근거 없음(백엔드 VoiceCandidate 도 Optional — 0 합성 금지)
  distanceM?: number;
}

export interface VoiceTurnResult {
  action: string; // accept|next|reject|details|select|filter|command|stop|unknown
  targetFacilityId: string | null;
  matchIds: string[]; // filter 일 때 선호에 맞는 후보 id들('양식'→양식 식당들)
  spoken: string | null; // 백엔드 생성 한국어 응답(없으면 프런트 자체 멘트)
  // filter 매치 0건일 때 백엔드가 제안한 '유사 대안'(같은 계열) 후보 id — spoken 이
  // "…안내해드릴까요?"로 물었고, 다음 턴 accept 를 이 후보 select 로 처리한다(구버전 응답엔 없음).
  suggestionId?: string | null;
  // 이번 턴이 LLM(Solar)로 처리됐는지/키워드 폴백인지 — LLM 동작 디버그 배지용(구버전 응답엔 없음).
  llmStatus?: "keyword" | "llm" | "llm_failed" | "gated" | "disabled";
  command?: VoiceAppCommand | null;
}

export interface VoiceAppContext {
  route: 'main';
  facilityType: PlaceCategory;
  indoorRequired: boolean;
  maxWalkMinutes?: 5 | 10 | 20 | null;
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
  candidates: VoiceTurnCandidate[],
  appContext?: VoiceAppContext,
): Promise<VoiceTurnResult> {
  const res: VoiceTurnResult = await apiClient.post("/api/v1/voice/turn", {
    utterance,
    facilityType,
    currentName,
    candidates,
    appContext,
  });
  if (res.llmStatus) {
    dispatchLlmDebug({ feature: "voice", status: res.llmStatus });
  }
  return res;
}
