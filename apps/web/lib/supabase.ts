import { createClient, SupabaseClient } from "@supabase/supabase-js";

let publicClient: SupabaseClient | null = null;

// 정적 export(브라우저 전용) 앱이라 service_role 클라이언트는 두지 않는다.
// (NEXT_PUBLIC 이 아닌 SUPABASE_SERVICE_ROLE_KEY 는 브라우저에서 어차피 undefined 이고,
//  service_role 키가 클라이언트 번들에 들어가면 치명적 유출이다.) 관리 작업은 인증된 세션 + RLS,
//  또는 백엔드(FastAPI 의 service_role) 경유로 처리한다.

// 데모 안정성: 백엔드(Supabase)가 느리거나 응답이 없을 때 요청이 무한히 매달려 페이지가
// "무한 로딩" 되는 것을 막기 위해, 모든 REST 요청에 타임아웃을 건다. 초과 시 요청을 abort →
// reject 되어 각 페이지의 폴백(데모 데이터/에러 표시)으로 빠르게 전환된다.
const REQUEST_TIMEOUT_MS = 6000;

function timeoutFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // 브라우저/Node18+ 모두 AbortController 보유. 정적 export 프리렌더 시점에는 호출되지 않는다.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // 외부에서 전달된 signal(예: supabase .abortSignal())도 함께 존중한다.
  const external = init?.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Client-side public client (respects RLS)
export function createPublicClient() {
  if (!publicClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://your-supabase-project.supabase.co";
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "your-supabase-anon-key";
    publicClient = createClient(url, key, {
      // 관리자 앱은 Supabase 인증 세션을 쓰지 않으므로(로컬 비밀번호 세션) 세션 저장/토큰 자동갱신
      // 타이머를 끈다 — 불필요한 연결·무게 감소.
      auth: { persistSession: false, autoRefreshToken: false },
      // 모든 REST 호출에 타임아웃 적용(무한 로딩 방지).
      global: { fetch: timeoutFetch },
    });
  }
  return publicClient;
}
