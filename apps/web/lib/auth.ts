// OAuth 연동/로그인 유틸 — docs/OAUTH_PLAN.md F2.
//
// 무마찰 익명 세션(SessionBootstrap) 위에 카카오·구글 소셜 계정을 얹는다. 두 진입:
//   · linkOAuth : 익명 사용자를 같은 auth.users 행에 소셜 identity 로 '승격'(user_id 불변 → 데이터 승계).
//   · signInOAuth: 다른 기기/재설치에서 '기존 계정으로 로그인'(익명 세션 폐기 후 계정 세션으로 교체).
// 둘 다 OAuth 리다이렉트를 유발하며, 성공 시 브라우저가 프로바이더로 이동했다가
// /auth/callback 으로 복귀한다(PKCE code 교환은 detectSessionInUrl 이 자동 처리).

import type { Provider, User } from "@supabase/supabase-js";
import { createPublicClient } from "@/lib/supabase";

// 이번 스코프 프로바이더(카카오 주 · 구글 부). 메타/애플/네이버는 비목표(OAUTH_PLAN §7).
export type OAuthProvider = Extract<Provider, "kakao" | "google">;

// 프로바이더별 요청 scope 오버라이드.
//  · 카카오: Supabase 기본값이 account_email 을 포함하는데, 이메일 동의는 비즈 앱 전환이 필요해
//    콘솔에서 켤 수 없다 → 미설정 scope 요청 시 KOE205 로 인가가 거부된다. 사용자가 콘솔에서
//    켤 수 있는 닉네임·프로필 이미지만 요청한다(OAUTH_PLAN: 이메일 미수집).
//  · 구글: 기본 scope(email/profile)로 충분 → 오버라이드 없음(undefined 면 Supabase 기본값 사용).
const PROVIDER_SCOPES: Partial<Record<OAuthProvider, string>> = {
  kakao: "profile_nickname profile_image",
};

// 마이페이지·setup 이 UI 를 분기하기 위한 계정 상태.
//   · guest  : 익명 세션(소셜 미연동) — 연동/로그인 유도 노출.
//   · linked : 소셜 identity 연동됨 — 프로바이더 뱃지 + 로그아웃 노출.
//   · none   : 세션 자체가 없음(익명 로그인 비활성 등) — 목업 폴백 상태.
export type AuthStatus = "guest" | "linked" | "none";

export interface AuthState {
  status: AuthStatus;
  user: User | null;
  /** 연동된 소셜 프로바이더 목록(예: ['kakao']). linked 일 때만 채워진다. */
  providers: OAuthProvider[];
}

// 콜백 복귀 경로를 안전하게 만든다(오픈 리다이렉트 방지 — 앱 내부 절대경로만 허용).
function safeNext(next?: string): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/mypage";
  return next;
}

// 콜백까지 provider(와 retry 여부)를 실어 보낸다. 콜백 페이지가 identity_already_exists(이미 다른
// 사용자에 연결된 소셜 계정)를 만나면, 같은 provider 로 signInOAuth(계정 전환)를 자동 재시도하는 데 쓴다
// (회원가입/로그인을 버튼 하나로 통합 — OAUTH_PLAN D-E). retry=1 은 그 폴백에서 무한 루프를 막는 표식.
function buildRedirectTo(next: string | undefined, provider: OAuthProvider, retry = false): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const params = new URLSearchParams({ next: safeNext(next), provider });
  if (retry) params.set("retry", "1");
  return `${origin}/auth/callback?${params.toString()}`;
}

/**
 * 소셜 계정으로 '계속하기' 1단계 — 우선 현재 익명 사용자에 identity 를 연결(회원가입)한다.
 * user_id(UUID)가 유지되어 취향·쿠폰·저장·제보 등 기존 데이터가 그대로 승계된다.
 * 만약 그 소셜 계정이 이미 다른(이전) 사용자에 연결돼 있으면, OAuth 왕복 후 콜백이
 * identity_already_exists 를 받아 signInOAuth(계정 전환)로 자동 폴백한다(호출부는 이 함수만 쓰면 된다).
 *
 * @returns 리다이렉트 전에 실패하면(예: "Allow manual linking" 미설정) { error } 반환.
 *   성공 시 브라우저가 프로바이더로 이동하므로 이 Promise 는 사실상 복귀하지 않는다.
 */
export async function linkOAuth(
  provider: OAuthProvider,
  next?: string,
): Promise<{ error: string | null }> {
  try {
    const supabase = createPublicClient();
    const { error } = await supabase.auth.linkIdentity({
      provider,
      options: { redirectTo: buildRedirectTo(next, provider), scopes: PROVIDER_SCOPES[provider] },
    });
    return { error: error?.message ?? null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 기존 소셜 계정으로 로그인(계정 전환). 현재 익명 세션은 폐기되고 기존 계정 세션으로 교체된다.
 * 주로 콜백의 identity_already_exists 자동 폴백에서 호출된다(사용자는 '계속하기' 버튼만 누른다).
 * 기기 B 익명 사용자의 데이터는 병합하지 않는다(OAUTH_PLAN D-E — orphan 방치).
 */
export async function signInOAuth(
  provider: OAuthProvider,
  next?: string,
): Promise<{ error: string | null }> {
  try {
    const supabase = createPublicClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      // retry=1: 이건 이미 '폴백 로그인'이므로 콜백이 또 폴백을 걸지 않게 표식한다.
      options: { redirectTo: buildRedirectTo(next, provider, true), scopes: PROVIDER_SCOPES[provider] },
    });
    return { error: error?.message ?? null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** 현재 세션의 계정 상태를 판별한다(마이페이지/ setup UI 분기용). */
export async function getAuthState(): Promise<AuthState> {
  try {
    const supabase = createPublicClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return { status: "none", user: null, providers: [] };

    // 소셜 identity(email/phone 이 아닌 OAuth 프로바이더)만 추린다.
    const providers = (user.identities ?? [])
      .map((i) => i.provider)
      .filter((p): p is OAuthProvider => p === "kakao" || p === "google");

    // is_anonymous 가 명시적으로 false 이거나 소셜 identity 가 있으면 연동 계정으로 본다.
    const isLinked = user.is_anonymous === false || providers.length > 0;
    return { status: isLinked ? "linked" : "guest", user, providers };
  } catch {
    return { status: "none", user: null, providers: [] };
  }
}

/**
 * 승격(linkIdentity) 직후 public.users 프로필 백필.
 * linkIdentity 는 auth.users 를 UPDATE 하므로 handle_new_user(AFTER INSERT) 트리거를 타지 않는다.
 * 따라서 프로바이더 메타(name/avatar)를 public.users 로 옮기는 것은 프런트가 1회 수행한다.
 * 기존 값(사용자가 직접 지정한 nickname 등)을 덮어쓰지 않도록 NULL 인 컬럼만 채운다.
 */
export async function backfillProfileAfterLink(): Promise<void> {
  try {
    const supabase = createPublicClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const meta = user.user_metadata ?? {};
    const metaName = (meta.full_name || meta.name || null) as string | null;
    const metaAvatar = (meta.avatar_url || meta.picture || null) as string | null;
    if (!metaName && !metaAvatar) return;

    const { data: profile } = await supabase
      .from("users")
      .select("nickname, avatar_url")
      .eq("id", user.id)
      .single();

    const patch: { nickname?: string; avatar_url?: string } = {};
    if (metaName && !profile?.nickname) patch.nickname = metaName;
    if (metaAvatar && !profile?.avatar_url) patch.avatar_url = metaAvatar;
    if (Object.keys(patch).length === 0) return;

    await supabase.from("users").update(patch).eq("id", user.id);
  } catch (err) {
    // 백필 실패는 치명적이지 않다(마이페이지가 세션 메타로도 이름/아바타를 표시할 수 있음).
    console.warn("[auth] 프로필 백필 건너뜀:", err);
  }
}

// ── 앱 자체 회원(이메일/비밀번호) — docs/AUTH_MEMBERSHIP_PLAN.md ──────────

/** 이메일/비밀번호 로그인. 성공 시 세션이 해당 회원으로 교체된다(호출부가 데이터 격리·이동 처리). */
export async function signInWithEmail(
  email: string,
  password: string,
): Promise<{ error: string | null }> {
  try {
    const supabase = createPublicClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 이메일/비밀번호 회원가입.
 * - 현재 익명(게스트) 세션이면 updateUser 로 '정회원 전환'한다 → uid 유지 → 저장·취향 데이터 승계.
 * - 세션이 없으면 signUp 으로 신규 생성한다.
 * @returns needsConfirmation: 이메일 인증(Confirm email) ON 이라 세션이 아직 없을 때 true.
 */
export async function signUpWithEmail(
  email: string,
  password: string,
  nickname?: string,
): Promise<{ error: string | null; needsConfirmation: boolean }> {
  try {
    const supabase = createPublicClient();
    const meta = nickname?.trim() ? { full_name: nickname.trim() } : undefined;

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user?.is_anonymous) {
      // 게스트 → 정회원 전환(uid 유지). data 로 닉네임 메타도 함께 심는다.
      const { error } = await supabase.auth.updateUser({ email, password, ...(meta ? { data: meta } : {}) });
      if (error) return { error: error.message, needsConfirmation: false };
      // 전환은 UPDATE 라 handle_new_user 트리거를 안 타므로 public.users.nickname 을 직접 백필한다.
      await backfillProfileAfterLink();
      // Confirm email ON 이면 이메일 확정 전까지 아직 익명 상태일 수 있다 → 확인 안내.
      const {
        data: { user: after },
      } = await supabase.auth.getUser();
      return { error: null, needsConfirmation: !!after?.is_anonymous };
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: meta ? { data: meta } : undefined,
    });
    if (error) return { error: error.message, needsConfirmation: false };
    // 세션이 없으면 Confirm email ON — 확인 메일 후 로그인 필요.
    return { error: null, needsConfirmation: !data.session };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), needsConfirmation: false };
  }
}
