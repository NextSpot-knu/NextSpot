// OAuth 연동/로그인 유틸 — docs/archive/OAUTH_PLAN.md F2.
//
// 무마찰 익명 세션(SessionBootstrap) 위에 카카오·구글 소셜 계정을 얹는다. 두 진입:
//   · linkOAuth : 익명 사용자를 같은 auth.users 행에 소셜 identity 로 '승격'(user_id 불변 → 데이터 승계).
//   · signInOAuth: 다른 기기/재설치에서 '기존 계정으로 로그인'(익명 세션 폐기 후 계정 세션으로 교체).
// 둘 다 OAuth 리다이렉트를 유발하며, 성공 시 브라우저가 프로바이더로 이동했다가
// /auth/callback 으로 복귀한다(PKCE code 교환은 detectSessionInUrl 이 자동 처리).

import type { User } from "@supabase/supabase-js";
// OAuth 순수 판정 로직은 lib/oauthFlow.ts 로 분리해 회귀 테스트로 잠갔다(oauthFlow.test.ts).
import {
  buildRedirectTo as buildRedirectToWithOrigin,
  deriveAuthState,
  resolveProfileSync,
  type AuthState,
  type AuthStatus,
  type OAuthProvider,
  type StoredProfile,
} from "@/lib/oauthFlow";

export type { AuthState, AuthStatus, OAuthProvider };
import { createPublicClient } from "@/lib/supabase";
import { mergeGuestData } from "@/lib/api-client";
import { classifySignUpError, type SignUpFailReason } from "@/lib/authErrors";

const GUEST_MERGE_KEY = "nextspot_guest_merge";

export function discardCapturedGuestData(): void {
  if (typeof window !== "undefined") sessionStorage.removeItem(GUEST_MERGE_KEY);
}

async function captureGuestSession(): Promise<void> {
  if (typeof window === "undefined") return;
  const { data: { session } } = await createPublicClient().auth.getSession();
  if (session?.user?.is_anonymous && session.access_token) {
    sessionStorage.setItem(GUEST_MERGE_KEY, JSON.stringify({ token: session.access_token, uid: session.user.id }));
  }
}

export async function mergeCapturedGuestData(): Promise<boolean> {
  if (typeof window === "undefined") return true;
  const raw = sessionStorage.getItem(GUEST_MERGE_KEY);
  if (!raw) return true;
  try {
    const captured = JSON.parse(raw) as { token?: string; uid?: string };
    const { data: { session } } = await createPublicClient().auth.getSession();
    if (captured.token && captured.uid && session?.user.id && captured.uid !== session.user.id) {
      await mergeGuestData(captured.token);
      discardCapturedGuestData();
      return true;
    }
    // linkIdentity 승격은 uid가 그대로라 DB 이동이 필요 없다. OAuth 교환 전 아직 익명 상태면
    // 콜백 완료 이벤트에서 다시 판정할 수 있도록 캡처를 보존한다.
    if (captured.uid === session?.user.id && session?.user.is_anonymous) return false;
    discardCapturedGuestData();
    return true;
  } catch (err) {
    // 원자 RPC가 실패하면 캡처를 지우지 않는다. 다음 인증 이벤트/재시도에서 전체를 다시 병합한다.
    console.warn("[auth] 게스트 데이터 병합 재시도 예정:", err);
    return false;
  }
}

// scope 는 여기서 지정하지 않는다 — Supabase 대시보드가 단일 출처다.
//
// 2026-08-27 실측: options.scopes 로 넘긴 값은 대시보드 설정을 **대체하지 않고 뒤에 덧붙는다**.
//   대시보드 'account_email profile_image profile_nickname'
//   + 코드 'profile_nickname profile_image'
//   → 최종 'account_email profile_image profile_nickname profile_nickname profile_image'
// 즉 코드로 account_email 을 뺄 수 없고, 중복만 생기며, 주석이 실제 동작과 어긋나 오해를 만든다.
// (이전 주석은 "이메일 미수집" 이라고 적혀 있었지만 실제로는 account_email 이 요청되고 있었다.)
//
// 정책: 카카오는 닉네임·프로필 이미지만 받는다(이메일 미수집 — OAUTH_PLAN §6-A).
// 그 강제는 **대시보드 Authentication → Sign In / Providers → Kakao → Scopes** 에서 한다.

// 콜백 URL 조립 — origin 만 여기서 주입하고 규칙은 oauthFlow 가 갖는다(SSR 안전 가드 포함).
function buildRedirectTo(next: string | undefined, provider: OAuthProvider, retry = false): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return buildRedirectToWithOrigin(origin, next, provider, retry);
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
      options: { redirectTo: buildRedirectTo(next, provider) },
    });
    return { error: error?.message ?? null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 소셜 계정으로 로그인(계정 전환). 현재 익명 세션은 폐기되고 해당 계정 세션으로 교체된다.
 * 그 소셜 계정이 처음이면 새 계정이 만들어진다(로그인/회원가입 통합).
 *
 * 호출부 둘:
 *   · /login 의 'SNS 계속하기' — 로그인 의도라 처음부터 이 경로(프로바이더 1회 왕복).
 *   · /auth/callback 의 identity_already_exists 자동 폴백 — linkOAuth 가 실패했을 때.
 *
 * 게스트 데이터: uid 가 바뀌므로 captureGuestSession() 으로 익명 토큰을 sessionStorage 에 잡아두고,
 * 콜백의 mergeCapturedGuestData() 가 POST /account/merge-guest 로 원자 병합한다.
 * (OAUTH_PLAN D-E 는 '병합하지 않는다' 였으나 ff4cc5a 에서 승계로 바뀌었다 — 이 주석이 정본이다.)
 *
 * redirectTo 의 retry=1 은 '콜백에서 다시 폴백하지 말 것' 표식이다. signInWithOAuth 는
 * identity_already_exists 를 내지 않으므로 이 경로에서는 무해하며, 폴백 무한 루프를 원천 차단한다.
 */
export async function signInOAuth(
  provider: OAuthProvider,
  next?: string,
): Promise<{ error: string | null }> {
  try {
    const supabase = createPublicClient();
    await captureGuestSession();
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      // retry=1: 이건 이미 '폴백 로그인'이므로 콜백이 또 폴백을 걸지 않게 표식한다.
      options: { redirectTo: buildRedirectTo(next, provider, true) },
    });
    if (error) discardCapturedGuestData();
    return { error: error?.message ?? null };
  } catch (err) {
    discardCapturedGuestData();
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

    return deriveAuthState(user);
  } catch {
    return { status: "none", user: null, providers: [] };
  }
}

/**
 * 소셜 로그인 직후 public.users 프로필을 프로바이더 값과 맞춘다.
 *
 * 두 가지 일을 한다:
 *   1) 백필 — linkIdentity 는 auth.users 를 UPDATE 하므로 handle_new_user(AFTER INSERT)
 *      트리거를 타지 않는다. 그 경로의 프로필은 여기서 채운다.
 *   2) 갱신 — 프로바이더에서 이름·사진을 바꾸면 다음 로그인에 반영한다.
 *
 * 예전 이름은 backfillProfileAfterLink 였고 실제로 '비어 있으면 채우기'만 했다. 그래서
 * 카카오 닉네임을 바꿔도 앱에는 첫 가입 때 값이 영영 남았다(2026-09-02). 무엇을 덮어써도
 * 되는지는 nickname_source 가 정하고, 그 판정은 lib/oauthFlow.ts 에 순수 함수로 있다.
 *
 * /auth/callback 의 finish() 가 **모든 소셜 로그인마다** 부른다(연동·재로그인 공통).
 */
export async function syncProfileFromProvider(): Promise<void> {
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
      .select("nickname, avatar_url, nickname_source")
      .eq("id", user.id)
      .single();

    const patch = resolveProfileSync(
      { name: metaName, avatar: metaAvatar },
      (profile as StoredProfile | null) ?? null,
    );
    if (Object.keys(patch).length === 0) return;

    await supabase.from("users").update(patch).eq("id", user.id);
  } catch (err) {
    // 동기화 실패는 치명적이지 않다(마이페이지가 세션 메타로도 이름/아바타를 표시할 수 있음).
    console.warn("[auth] 프로필 동기화 건너뜀:", err);
  }
}

// ── 앱 자체 회원(이메일/비밀번호) — docs/archive/AUTH_MEMBERSHIP_PLAN.md ──────────

/** 이메일/비밀번호 로그인. 성공 시 세션이 해당 회원으로 교체된다(호출부가 데이터 격리·이동 처리). */
export async function signInWithEmail(
  email: string,
  password: string,
): Promise<{ error: string | null }> {
  try {
    const supabase = createPublicClient();
    await captureGuestSession();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error) await mergeCapturedGuestData();
    else discardCapturedGuestData();
    return { error: error?.message ?? null };
  } catch (err) {
    discardCapturedGuestData();
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 이메일/비밀번호 회원가입.
 * - 현재 익명(게스트) 세션이면 updateUser 로 '정회원 전환'한다 → uid 유지 → 저장·취향 데이터 승계.
 * - 세션이 없으면 signUp 으로 신규 생성한다.
 * @returns needsConfirmation: 이메일 인증(Confirm email) ON 이라 세션이 아직 없을 때 true.
 *   reason: 실패 원인 분류(email_exists/weak_password/unknown) — 화면이 안내 문구를 고르는 데 쓴다.
 */
export async function signUpWithEmail(
  email: string,
  password: string,
  nickname?: string,
): Promise<{ error: string | null; reason: SignUpFailReason | null; needsConfirmation: boolean }> {
  try {
    const supabase = createPublicClient();
    const meta = nickname?.trim() ? { full_name: nickname.trim() } : undefined;

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user?.is_anonymous) {
      // 게스트 → 정회원 전환(uid 유지). data 로 닉네임 메타도 함께 심는다.
      const { error } = await supabase.auth.updateUser({ email, password, ...(meta ? { data: meta } : {}) });
      if (error) return { error: error.message, reason: classifySignUpError(error), needsConfirmation: false };
      // 전환은 UPDATE 라 handle_new_user 트리거를 안 타므로 public.users.nickname 을 직접 백필한다.
      await syncProfileFromProvider();
      // Confirm email ON 이면 이메일 확정 전까지 아직 익명 상태일 수 있다 → 확인 안내.
      const {
        data: { user: after },
      } = await supabase.auth.getUser();
      return { error: null, reason: null, needsConfirmation: !!after?.is_anonymous };
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: meta ? { data: meta } : undefined,
    });
    if (error) return { error: error.message, reason: classifySignUpError(error), needsConfirmation: false };
    // 세션이 없으면 Confirm email ON — 확인 메일 후 로그인 필요.
    return { error: null, reason: null, needsConfirmation: !data.session };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, reason: classifySignUpError({ message }), needsConfirmation: false };
  }
}

/** 비밀번호 재설정 메일을 보낸다. 링크는 정적 export 호환 클라이언트 페이지로 돌아온다. */
export async function requestPasswordReset(email: string): Promise<{ error: string | null }> {
  try {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    // 이미 운영 허용 목록에 등록된 OAuth 콜백을 재사용한다. 별도 reset-password URL 설정 없이
    // PKCE 복구 세션을 확립한 뒤 callback의 안전한 next 처리로 입력 화면에 이동한다.
    const params = new URLSearchParams({ next: "/auth/reset-password" });
    const { error } = await createPublicClient().auth.resetPasswordForEmail(email, {
      redirectTo: `${origin}/auth/callback?${params.toString()}`,
    });
    return { error: error?.message ?? null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** 복구 링크로 만들어진 세션에서 새 비밀번호를 저장한다. */
export async function updatePassword(password: string): Promise<{ error: string | null }> {
  try {
    const { error } = await createPublicClient().auth.updateUser({ password });
    return { error: error?.message ?? null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
