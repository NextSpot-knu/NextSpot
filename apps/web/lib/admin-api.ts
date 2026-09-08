// 관리자 API 클라이언트 — FastAPI /api/v1/admin/* (require_role(ROLE_ADMIN) 가드 — Supabase JWT + users.role) 호출 전용.
//
// 배경(WS-A-6): 관리자 화면이 anon 키로 facilities/system_settings/inquiries 를 직접 쓰던 경로는
// RLS 강화 이후 전부 거부된다(이전에도 0행 갱신 무음 실패). 쓰기/민감 읽기는 이 헬퍼를 통해
// 백엔드(service_role)로만 보낸다.
//
// lib/api-client.ts 와 달리 snake_case ↔ camelCase 변환을 하지 않는다 — 관리자 화면들은
// Supabase 직조회 시절부터 snake_case 필드(user_name, maintenance_mode 등)를 그대로 쓰고 있어,
// 원형 JSON 을 반환해야 페이지 수정이 최소화된다.

import { createPublicClient } from "./supabase";
import type { AdminFailureKind } from "./adminApiFailure";

const BASE_URL = process.env.NEXT_PUBLIC_FASTAPI_URL || "http://localhost:8000";
const REQUEST_TIMEOUT_MS = 8000;

/**
 * 관리자 API 실패 — **상태 코드를 버리지 않는 에러**.
 *
 * 예전에는 전부 맨 `new Error(detail)` 이었다. 그래서 호출부는 "다시 로그인하면 되는 401",
 * "권한 자체가 없는 403", "다시 누르면 되는 타임아웃", "우리가 고쳐야 하는 500" 을
 * **구분할 방법이 없었다** — 관리자 화면에는 서버 원문 한 줄만 떴고, 그걸 읽고 할 수 있는
 * 일이 없었다. lib/api-client.ts 가 관광객 앱에서 같은 이유로 HttpError(status) 를 둔다.
 *
 * 사람이 읽을 문장은 여기서 만들지 않는다 — lib/adminApiFailure.ts 의 순수 판정이 맡고
 * 테스트가 그것을 잠근다.
 */
export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly kind: AdminFailureKind,
    /** 서버가 준 HTTP 상태. 응답을 못 받은 실패(세션 없음·타임아웃·연결 실패)는 null —
     *  0 으로 채우면 화면이 'HTTP 0' 이라는 있지도 않은 코드를 보여준다. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

/** 에러에 실린 HTTP 상태(없으면 null). 다른 곳에서 던진 에러도 status 가 숫자면 인정한다. */
export function adminApiStatus(err: unknown): number | null {
  if (err instanceof AdminApiError) return err.status;
  if (typeof err === "object" && err !== null) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) return status;
  }
  return null;
}

/** 에러의 실패 종류(모르면 null). */
export function adminApiKind(err: unknown): AdminFailureKind | null {
  return err instanceof AdminApiError ? err.kind : null;
}

async function adminRequest(path: string, options: RequestInit = {}): Promise<any> {
  // 인증은 Supabase JWT 하나로 통일했다(RBAC P2-2). 백엔드가 이 토큰에서 users.role 을 읽어
  // admin/developer 인지 매 요청 확인한다 — 프런트 판정을 우회해도 API 는 403 을 돌려준다.
  const { data: { session } } = await createPublicClient().auth.getSession();
  if (!session?.access_token) {
    // 요청을 보내지도 못했다. 상태 코드는 없지만 관리자가 할 일은 401 과 같으므로
    // kind 로 그 사실을 넘긴다(없는 401 을 지어내지 않는다).
    throw new AdminApiError("관리자 세션이 없습니다. 다시 로그인해 주세요.", "no-session");
  }

  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${session.access_token}`);
  // 프록시 경유 배포에서 Authorization 이 덮이는 경우 대비(api-client 와 동일 관례).
  headers.set("X-Supabase-Authorization", `Bearer ${session.access_token}`);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, { ...options, headers, signal: controller.signal });
  } catch (err) {
    // 여기서 잡지 않으면 abort 가 **DOMException 그대로** 호출부까지 올라간다. DOMException 은
    // Error 를 상속하지 않아서 lib/errors.ts 의 errorMessage() 가 undefined 를 돌려주고,
    // 화면에는 사유 없는 '알 수 없는 오류' 만 남는다 — 배포 API 는 Render 무료 플랜이라
    // 15분 유휴 후 콜드 스타트가 8초를 넘기는 게 정상 동작이다. 그 흔한 실패가 가장
    // 아무것도 알려주지 않는 문구로 표시돼 왔다. (lib/api-client.ts 가 같은 자리에서 같은 처리를 한다.)
    if (timedOut) {
      throw new AdminApiError("요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.", "timeout");
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new AdminApiError(`관리자 API 에 연결하지 못했습니다: ${reason}`, "network");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    // 상태 코드를 함께 싣는다. 이게 없으면 401(재로그인)·403(권한 없음)·500(서버 장애)이
    // 호출부에서 전부 같은 문자열 한 줄로 뭉개진다.
    throw new AdminApiError(
      errorData.detail || `관리자 API 오류 (HTTP ${response.status})`,
      "http",
      response.status,
    );
  }
  return response.json();
}

// --- 오늘의 브리핑(P0-2) — GET /api/v1/admin/dashboard/briefing ---
// 백엔드(briefing_service)가 대시보드 집계를 Solar 로 1~2문장 프로즈화한 결과.
// briefing=null(스킵/폐기/장애/키 미설정)이면 프런트는 카드 자체를 렌더하지 않는다(무해 폴백).
export interface DashboardBriefing {
  briefing: string | null;
  llmStatus: string; // "llm" | "rejected" | "llm_failed" | "disabled" | "skipped" (관찰 필드)
}

// LLM 동작 디버그 배지 — lib/api-client.ts 가 발행하는 'nextspot:llm-debug' CustomEvent 와
// 동일 메커니즘(components/LlmDebugToast.tsx 가 구독). 정적 export SSR 안전을 위해 window
// 가드 + 어떤 예외도 조용히 무시(디버그 배지는 절대 주 기능을 방해하지 않는다).
function dispatchBriefingLlmDebug(status: string): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent("nextspot:llm-debug", { detail: { feature: "briefing", status } })
    );
  } catch {
    // CustomEvent 미지원 등 — 무시
  }
}

/** 오늘의 브리핑 조회 — 응답 파싱 직후 디버그 이벤트를 중앙 발행(api-client 관례 미러). */
export async function getDashboardBriefing(): Promise<DashboardBriefing> {
  const data: DashboardBriefing = await adminRequest("/api/v1/admin/dashboard/briefing", {
    method: "GET",
  });
  if (data && typeof data.llmStatus === "string") {
    dispatchBriefingLlmDebug(data.llmStatus);
  }
  return data;
}

export const adminApi = {
  get: (path: string) => adminRequest(path, { method: "GET" }),
  post: (path: string, body?: unknown) =>
    adminRequest(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: (path: string, body?: unknown) =>
    adminRequest(path, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: (path: string, body?: unknown) =>
    adminRequest(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) }),
  delete: (path: string) => adminRequest(path, { method: "DELETE" }),
};
