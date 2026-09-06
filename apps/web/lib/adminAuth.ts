// 관리자 대시보드 인증 — **Supabase 계정 + users.role** 로 통일됐다.
//
// 예전에는 이 파일이 `NEXT_PUBLIC_ADMIN_PASSWORD` 와 문자열을 비교해 localStorage 플래그를
// 세우고, 공유 토큰(`NEXT_PUBLIC_ADMIN_API_TOKEN`)을 X-Admin-Authorization 으로 보냈다.
// 정적 export 라 둘 다 번들에 그대로 박혔고, 검사가 브라우저에서 일어나 콘솔에서
// `localStorage.setItem(...)` 한 줄이면 통과했다 — 실제 보안 경계가 아니었다.
// 게다가 토큰을 바꾸면 **모든 관리자가 동시에** 튕겼고 개인별 회수는 불가능했다.
//
// 이제 관리자는 앱 일반 로그인(/login — 이메일/비밀번호 또는 소셜)을 쓰고, 권한은
// `users.role ∈ {admin, developer}` 로 판정한다. 프런트 판정은 lib/account.tsx 의
// `canEnterAdminConsole` 하나이고, 실제 차단은 백엔드가 매 요청 수행한다
// (app/core/authz.py `require_role("admin")`).
//
// 이 파일에 남은 것은 관리자 화면의 **로그아웃** 하나뿐이다 — 관광객 세션과 같은 세션이므로
// Supabase signOut 을 그대로 부른다(예전처럼 localStorage 키만 지우면 서버 세션이 남는다).

import { createPublicClient } from "@/lib/supabase";

// 구 비밀번호 세션 키. 남아 있으면 지우기만 한다(권한으로 쓰지 않는다).
const LEGACY_SESSION_KEY = "nextspot_admin_session";

/** 관리자 화면 로그아웃 — 실제 Supabase 세션을 종료한다. */
export async function signOutAdmin(): Promise<void> {
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(LEGACY_SESSION_KEY);
    } catch {
      /* localStorage 차단 환경 — 무시 */
    }
  }
  try {
    await createPublicClient().auth.signOut();
  } catch {
    // 네트워크 실패로 서버 세션 폐기가 안 되더라도 화면은 로그인으로 보낸다(호출부 책임).
  }
}
