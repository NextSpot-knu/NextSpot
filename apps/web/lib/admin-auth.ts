// 관리자 인증 — 데모/프로토타입용 단일 비밀번호 진입(동기, 로컬 세션).
//
// 배경: 이전에는 Firebase Authentication(REST) 이메일/비밀번호 경로를 썼으나
//       NEXT_PUBLIC_FIREBASE_API_KEY 가 설정된 적이 없어 실제로 동작하지 않았다.
//       데모 진입을 위해 비밀번호 한 개(`admin`)로 통일하고, 비동기 Firebase 경로를
//       제거해 레이아웃 가드의 타이밍 레이스 가능성도 함께 없앴다.
//
// ⚠️ 보안 주의: 이 방식은 클라이언트 측 데모 게이트일 뿐 실제 보안 경계가 아니다.
//    비밀번호가 번들에 포함되며, 누구나 우회할 수 있다. 진짜 권한이 필요한 백엔드
//    작업은 서버에서 별도로 인증·인가를 검증해야 한다.

const STORAGE_KEY = "nextspot_admin_session";
// 데모 기본값은 유지하되 빌드 타임 env 로 오버라이드 가능(정적 export 라 NEXT_PUBLIC_* 는 번들에 포함됨 —
// 즉 이 게이트는 여전히 데모 수준이다. 진짜 권한 검증은 백엔드 require_admin(ADMIN_API_TOKEN)이 수행).
const ADMIN_PASSWORD = process.env.NEXT_PUBLIC_ADMIN_PASSWORD || "admin";
// 백엔드 apps/api ADMIN_API_TOKEN 과 동일한 값이어야 관리자 API(simulate-peak, admin CRUD)가 동작한다.
const SESSION_TOKEN = process.env.NEXT_PUBLIC_ADMIN_API_TOKEN || "nextspot-admin-local";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

/** 비밀번호로 로그인. 일치하면 세션을 저장하고 true, 아니면 false. */
export function signInWithPassword(password: string): boolean {
  if (password !== ADMIN_PASSWORD) return false;
  if (hasWindow()) {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* localStorage 차단(시크릿 등) 환경 — 무시 */
    }
  }
  return true;
}

/** 로그아웃 — 관리자 세션 제거. */
export function signOutAdmin(): void {
  if (!hasWindow()) return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 무시 */
  }
}

/** 현재 관리자 세션 여부(동기). 레이아웃 가드가 이 값으로 라우트 접근을 판정한다. */
export function isAdminAuthed(): boolean {
  if (!hasWindow()) return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** 백엔드 호출용 토큰. 세션이 있으면 고정 데모 토큰, 없으면 null. */
export function getAdminToken(): string | null {
  return isAdminAuthed() ? SESSION_TOKEN : null;
}
