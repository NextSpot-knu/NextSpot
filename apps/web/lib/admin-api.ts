// 관리자 API 클라이언트 — FastAPI /api/v1/admin/* (require_admin 가드) 호출 전용.
//
// 배경(WS-A-6): 관리자 화면이 anon 키로 facilities/system_settings/inquiries 를 직접 쓰던 경로는
// RLS 강화 이후 전부 거부된다(이전에도 0행 갱신 무음 실패). 쓰기/민감 읽기는 이 헬퍼를 통해
// 백엔드(service_role)로만 보낸다.
//
// lib/api-client.ts 와 달리 snake_case ↔ camelCase 변환을 하지 않는다 — 관리자 화면들은
// Supabase 직조회 시절부터 snake_case 필드(user_name, maintenance_mode 등)를 그대로 쓰고 있어,
// 원형 JSON 을 반환해야 페이지 수정이 최소화된다.

import { getAdminToken } from "./admin-auth";

const BASE_URL = process.env.NEXT_PUBLIC_FASTAPI_URL || "http://localhost:8000";
const REQUEST_TIMEOUT_MS = 8000;

async function adminRequest(path: string, options: RequestInit = {}): Promise<any> {
  const token = getAdminToken();
  if (!token) {
    throw new Error("관리자 세션이 없습니다. 다시 로그인해 주세요.");
  }

  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  // 백엔드 require_admin 은 X-Admin-Authorization 만 읽는다(일반 Authorization 폴백 제거됨).
  headers.set("X-Admin-Authorization", `Bearer ${token}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, { ...options, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `관리자 API 오류 (HTTP ${response.status})`);
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
