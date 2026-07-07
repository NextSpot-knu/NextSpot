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
