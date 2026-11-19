// API 요청 엔진 — React Native·Supabase 를 import 하지 않는 순수 부분(node 테스트가 fetch 를 바꿔 끼워 검사한다).
//
// 웹 원본: apps/web/lib/api-client.ts 의 오류 클래스 · errorMessageFrom · request()  (기준 커밋 e07ea61)
// 바꾼 것:
//   · `err instanceof DOMException && err.name === 'AbortError'` → isAbortError(이름 검사). RN 의 fetch 는 DOMException 을
//     보장하지 않는다(폴리필에 따라 Error 에 name 만 붙는다).
//   · 모든 요청에 `X-NextSpot-Client: ios|android` 를 싣는다(계획 §7.5 — 사용 기록 구분 · 앱 요청의 LLM 재작성 끄기).
//   · 지역 헤더(X-NextSpot-Region)는 싣지 않는다 — 앱 v1 은 경주만 본다(계획 §3.3).
//   · fetch·토큰·시계·난수를 주입받는다(테스트용). 동작(10초 타임아웃 · 응답 전 네트워크 실패만 1회 재시도 ·
//     401/503/그 밖 HTTP 오류 분류 · camel↔snake 변환)은 웹과 같다.
import { keysToCamel, keysToSnake } from '@/lib/caseTransform';

// ── 오류 타입 ─────────────────────────────────────────────────────────────

/** 인증 필요(HTTP 401) — 서버 장애와 구분한다. 호출부는 isAuthError() 로 가려 '다시 시도' 대신 안내를 보여 준다. */
export class AuthError extends Error {
  readonly status = 401;
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'AuthError';
  }
}

export function isAuthError(err: unknown): err is AuthError {
  return (
    err instanceof AuthError ||
    (typeof err === 'object' && err !== null && (err as { status?: number }).status === 401)
  );
}

/** FastAPI 오류 본문에서 사람이 읽을 메시지를 꺼낸다(422 의 배열 detail 포함). */
export function errorMessageFrom(body: unknown, status: number): string {
  const fallback = `HTTP error! status: ${status}`;
  if (typeof body !== 'object' || body === null) return fallback;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail)) {
    const first = detail.find(
      (d) => typeof d === 'object' && d !== null && typeof (d as { msg?: unknown }).msg === 'string',
    ) as { msg?: string } | undefined;
    if (first?.msg) return first.msg;
  }
  return fallback;
}

/** 그 밖의 HTTP 오류. 상태 코드를 버리지 않는다 — '다시 하면 될 실패' 와 '영구 실패' 를 호출부가 가른다. */
export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HttpError';
  }
}

/** 클라이언트 타임아웃으로 끊은 요청. 메시지는 웹과 같다(메시지로 분류하는 소비자를 위해). */
export class RequestTimeoutError extends Error {
  constructor() {
    super('요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.');
    this.name = 'RequestTimeoutError';
  }
}

export function isRequestTimeout(err: unknown): boolean {
  return err instanceof RequestTimeoutError;
}

/** 에러에 실린 HTTP 상태 코드(없으면 undefined). */
export function httpStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/** 일시적 서버 의존성 장애(HTTP 503). */
export class ServiceUnavailableError extends Error {
  readonly status = 503;
  constructor(message = 'Service temporarily unavailable') {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}

export function isServiceUnavailable(err: unknown): err is ServiceUnavailableError {
  return (
    err instanceof ServiceUnavailableError ||
    (typeof err === 'object' && err !== null && (err as { status?: number }).status === 503)
  );
}

/** 중단(타임아웃·호출자 취소)으로 끝난 fetch 인가. DOMException 이 없는 RN 에서도 이름으로 가른다. */
export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

// ── 헤더 ──────────────────────────────────────────────────────────────────

export type ClientPlatform = 'ios' | 'android';

/** 서버가 앱 요청을 가르는 헤더. 값은 ios · android(웹은 보내지 않는다). */
export const CLIENT_HEADER = 'X-NextSpot-Client';

/** RN Platform.OS → 헤더 값. ios·android 가 아니면(웹 미리보기 등) android 로 두지 않고 null — 헤더를 싣지 않는다. */
export function clientPlatformFrom(os: string | null | undefined): ClientPlatform | null {
  return os === 'ios' || os === 'android' ? os : null;
}

/**
 * 요청 헤더를 만든다. Authorization 을 덮어쓰는 프록시 뒤에 놓일 경우를 대비해 Supabase JWT 를
 * X-Supabase-Authorization 으로도 함께 싣는다(웹과 같다 — 백엔드 get_current_user 가 둘 다 본다).
 */
export function buildRequestHeaders(
  init: HeadersInit | undefined,
  token: string | null | undefined,
  platform: ClientPlatform | null,
): Headers {
  const headers = new Headers(init);
  headers.set('Content-Type', 'application/json');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-Supabase-Authorization', `Bearer ${token}`);
  }
  if (platform) headers.set(CLIENT_HEADER, platform);
  return headers;
}

/** URL + 쿼리(키는 snake_case 로). */
export function buildUrl(baseUrl: string, path: string, params?: Record<string, string>): string {
  let url = `${baseUrl}${path}`;
  if (params) {
    const query = new URLSearchParams(keysToSnake(params) as Record<string, string>);
    url += `?${query.toString()}`;
  }
  return url;
}

/** 그대로 보내야 하는 본문(FormData·Blob·URLSearchParams·ArrayBuffer). 평문 객체만 JSON 으로 바꾼다. */
export function isRawBody(body: unknown): boolean {
  return (
    (typeof FormData !== 'undefined' && body instanceof FormData) ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ||
    (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body)))
  );
}

/** 요청 본문 직렬화 — 평문 객체는 snake_case 로 바꿔 JSON 문자열로, 나머지는 그대로. */
export function serializeBody(body: unknown): BodyInit | null | undefined {
  if (body && typeof body === 'object' && !isRawBody(body)) return JSON.stringify(keysToSnake(body));
  return body as BodyInit | null | undefined;
}

// ── 요청 ──────────────────────────────────────────────────────────────────

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  params?: Record<string, string>;
  timeoutMs?: number;
  /** 평문 객체를 주면 snake_case 변환 후 JSON 직렬화한다(FormData 등 BodyInit 은 그대로). */
  body?: unknown;
  /** true 면 네트워크 실패에도 재시도하지 않는다. */
  noRetry?: boolean;
}

/** 기본 타임아웃(웹과 같다). */
export const REQUEST_TIMEOUT_MS = 10000;
/**
 * 재시도 백오프(ms) — 배열 길이 = 최대 재시도 횟수. **응답 전 네트워크 실패만** 다시 보낸다(서버 미도달이라 안전).
 * 응답을 받았으면 429·503 이라도 다시 보내지 않는다(리트라이 스톰 → Cloudflare 차단, 웹 B4).
 */
export const RETRY_BACKOFF_MS: readonly number[] = [700];

export interface RequesterDeps {
  baseUrl: string;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  getAccessToken: () => Promise<string | null | undefined>;
  platform: ClientPlatform | null;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

// 반환 any 는 웹 request() 의 계약(호출부가 res.xxx 로 바로 읽는다)을 그대로 따른다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Requester = (path: string, options?: RequestOptions) => Promise<any>;

export function createRequester(deps: RequesterDeps): Requester {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;
  const jittered = (ms: number) => ms + Math.floor(random() * 250);

  return async function request(path, options = {}) {
    const token = await deps.getAccessToken();
    const headers = buildRequestHeaders(options.headers, token, deps.platform);
    const url = buildUrl(deps.baseUrl, path, options.params);
    const raw = isRawBody(options.body);
    const body = serializeBody(options.body);
    const externalSignal = options.signal ?? undefined;

    const canRetry = !options.noRetry && !raw;
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
        const {
          params: _params,
          timeoutMs: _timeoutMs,
          signal: _signal,
          noRetry: _noRetry,
          body: _body,
          headers: _headers,
          ...fetchOptions
        } = options;
        response = await deps.fetch(url, { ...fetchOptions, headers, body, signal: controller.signal });
      } catch (err) {
        if (isAbortError(err)) {
          // 타임아웃·호출자 취소는 의도된 중단 — 재시도하지 않는다. 호출자 취소는 원래 오류 그대로.
          if (!timedOut && externalSignal?.aborted) throw err;
          throw new RequestTimeoutError();
        }
        networkErr = err;
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
        throw networkErr;
      }
      break;
    }

    if (!response) {
      throw lastNetworkErr ?? new Error('요청에 실패했습니다. 잠시 후 다시 시도해 주세요.');
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const message = errorMessageFrom(errorData, response.status);
      if (response.status === 401) throw new AuthError(message);
      if (response.status === 503) throw new ServiceUnavailableError(message);
      throw new HttpError(message, response.status);
    }

    const data = await response.json();
    return keysToCamel(data);
  };
}
