// OAuth 플로우의 순수 판정 로직 — docs/OAUTH_PLAN.md F2/F3.
//
// 왜 분리했나: 이 세 함수는 OAuth 왕복에서 **틀리면 조용히 위험해지는** 부분인데
// (오픈 리다이렉트, 계정 상태 오판), 원래는 lib/auth.ts 안의 비공개 함수라 테스트가 불가능했다.
// Supabase 클라이언트에 손대지 않는 순수 함수만 여기로 빼서 회귀 테스트로 잠근다
// (lib/anonymousSession.ts 의 의존성 주입 패턴과 같은 의도 — 부작용은 호출부에 남긴다).
//
// 동작은 분리 전과 동일하다. auth.ts 는 이 모듈을 가져다 쓰기만 한다.

import type { User } from "@supabase/supabase-js";

// 이번 스코프 프로바이더(카카오 주 · 구글 부). 메타/애플/네이버는 비목표(OAUTH_PLAN §7).
export type OAuthProvider = "kakao" | "google";

// 마이페이지·setup 이 UI 를 분기하기 위한 계정 상태.
//   · guest  : 익명 세션(소셜 미연동) — 연동/로그인 유도 노출.
//   · linked : 소셜 연동됐거나 자체 회원 — 프로바이더 뱃지 + 로그아웃 노출.
//   · none   : 세션 자체가 없음(익명 로그인 비활성 등) — 목업 폴백 상태.
export type AuthStatus = "guest" | "linked" | "none";

export interface AuthState {
  status: AuthStatus;
  user: User | null;
  /** 연동된 소셜 프로바이더 목록(예: ['kakao']). 자체 회원만이면 빈 배열이다. */
  providers: OAuthProvider[];
}

/**
 * 콜백 복귀 경로를 안전하게 만든다 — **오픈 리다이렉트 방지**.
 *
 * `next` 는 URL 쿼리에서 오므로 공격자가 통제할 수 있다. 앱 내부 절대경로만 허용한다:
 *   · `/` 로 시작하지 않으면 거부(`https://evil.com`, `javascript:` 등)
 *   · `//` 로 시작해도 거부 — 브라우저가 `//evil.com` 을 **프로토콜 상대 URL**(외부 도메인)로 해석한다.
 * 거부되면 기본 복귀지 `/mypage` 로 보낸다.
 */
export function safeNext(next?: string): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/mypage";
  return next;
}

/**
 * OAuth 프로바이더에서 돌아올 콜백 URL.
 *
 * 콜백까지 provider(와 retry 여부)를 실어 보낸다. 콜백 페이지가 identity_already_exists
 * (이미 다른 사용자에 연결된 소셜 계정)를 만나면, 같은 provider 로 signInOAuth(계정 전환)를
 * 자동 재시도하는 데 쓴다. `retry` 는 그 폴백에서 **무한 루프를 막는 표식**이다.
 *
 * origin 은 주입받는다(테스트 가능성 + SSR 안전 — 프리렌더 시점에는 window 가 없다).
 */
export function buildRedirectTo(
  origin: string,
  next: string | undefined,
  provider: OAuthProvider,
  retry = false,
): string {
  const params = new URLSearchParams({ next: safeNext(next), provider });
  if (retry) params.set("retry", "1");
  return `${origin}/auth/callback?${params.toString()}`;
}

/**
 * 세션 사용자로부터 계정 상태를 판정한다.
 *
 * · 소셜 identity(email/phone 이 아닌 OAuth 프로바이더)만 providers 로 추린다.
 * · `is_anonymous === false` 이거나 소셜 identity 가 있으면 연동 계정으로 본다.
 *   (자체 이메일 회원은 소셜 identity 가 없지만 익명이 아니므로 linked 다 — 로그아웃 버튼이 필요하다.)
 * · `is_anonymous` 가 undefined 인 구 토큰은 소셜 identity 유무로만 판정한다(보수적으로 guest).
 */
export function deriveAuthState(user: User | null | undefined): AuthState {
  if (!user) return { status: "none", user: null, providers: [] };
  const providers = (user.identities ?? [])
    .map((i) => i.provider)
    .filter((p): p is OAuthProvider => p === "kakao" || p === "google");
  const isLinked = user.is_anonymous === false || providers.length > 0;
  return { status: isLinked ? "linked" : "guest", user, providers };
}


// ── 프로필 동기화 판정 ──────────────────────────────────────────────────────

/** public.users 에서 읽어 온 현재 프로필(동기화 판단에 필요한 세 칼럼). */
export interface StoredProfile {
  nickname: string | null;
  avatar_url: string | null;
  /** 'user' 면 사용자가 직접 지정한 이름이다 — 덮어쓰면 안 된다. */
  nickname_source: 'provider' | 'user' | null;
}

/** public.users 에 적용할 변경. 빈 객체면 쓸 것이 없다는 뜻이다. */
export interface ProfilePatch {
  nickname?: string;
  nickname_source?: 'provider';
  avatar_url?: string;
}

/**
 * 소셜 로그인 후 public.users 에 무엇을 쓸지 정한다.
 *
 * 원래 규칙은 "NULL 인 칼럼만 채운다" 였다. 사용자가 마이페이지에서 정한 이름을 로그인마다
 * 덮어쓰지 않으려는 의도였는데, 그 대가로 **프로바이더에서 이름을 바꿔도 앱에는 첫 가입
 * 때 값이 영영 남았다**(카카오가 '오윤성' 을 주는데 화면엔 '윤성1', 2026-09-02).
 *
 * 이제 두 경우를 nickname_source 로 가른다:
 *   · 'user'  — 사용자가 직접 지정. 프로바이더 이름이 뭐든 건드리지 않는다.
 *   · 그 외   — 비어 있거나 프로바이더 유래. 최신 값으로 맞춘다.
 *
 * 아바타는 사용자가 지정할 경로가 없어(업로드 기능 없음) 항상 프로바이더 유래다 —
 * 달라지면 그냥 맞춘다.
 *
 * 닉네임 중복은 신경 쓰지 않는다. 유일성 제약이 없고, 닉네임으로 사용자를 찾는 코드도 없다.
 */
export function resolveProfileSync(
  meta: { name: string | null; avatar: string | null },
  profile: StoredProfile | null,
): ProfilePatch {
  const patch: ProfilePatch = {};

  const userChoseTheName = profile?.nickname_source === 'user';
  if (meta.name && !userChoseTheName && profile?.nickname !== meta.name) {
    patch.nickname = meta.name;
    // 갱신할 때마다 출처를 다시 찍는다 — 컬럼이 없던 시절의 행(NULL)도 이걸로 정리된다.
    patch.nickname_source = 'provider';
  }

  if (meta.avatar && profile?.avatar_url !== meta.avatar) {
    patch.avatar_url = meta.avatar;
  }

  return patch;
}
