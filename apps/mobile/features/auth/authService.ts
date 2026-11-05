// 이메일 로그인·가입·재설정 메일·프로필 맞추기 — 앱 Supabase 클라이언트에 묶인 쪽.
//
// 웹 원본: apps/web/lib/auth.ts 의 signInWithEmail · signUpWithEmail · requestPasswordReset · syncProfileFromProvider
//          (기준 커밋 0d145a1)
// 바꾼 것:
//   · CAPTCHA 없음(계획 §7.6 — 앱 출시 전까지 Supabase CAPTCHA 를 켜지 않는다). runWithCaptcha·captchaOption 을 뺐다.
//   · window.location.origin 대신 운영 웹 주소(WEB_ORIGIN). 재설정 메일 링크는 **웹에서** 끝난다(아래 requestPasswordReset).
//   · 게스트 합치기 capture/merge/discard 는 lib/core/guestMerge(앱 저장소·single-flight)를 쓴다.
//   · 오류 분류는 웹 순수 모듈 @/lib/authErrors 를 그대로 쓴다.
import {
  classifySignInError,
  classifySignUpError,
  type SignInFailReason,
  type SignUpFailReason,
} from '@/lib/authErrors';

import { captureGuestSession, discardCapturedGuestData, mergeCapturedGuestData } from '~/lib/core/guestMerge';
import { createPublicClient } from '~/lib/core/supabase';
import { WEB_ORIGIN } from '~/lib/platform/shareUrls';

import { readProviderMeta, resolveProfileSync, type StoredProfile } from './profileSync';

export type { SignInFailReason, SignUpFailReason } from '@/lib/authErrors';

/**
 * 이메일/비밀번호 로그인. 게스트였으면 로그인 직전에 게스트 토큰을 잡아 두고, 성공하면 새 계정으로 합친다
 * (uid 가 바뀌는 계정 전환 — 서버 POST /account/merge-guest).
 */
export async function signInWithEmail(
  email: string,
  password: string,
): Promise<{ error: string | null; reason: SignInFailReason | null }> {
  try {
    const supabase = createPublicClient();
    await captureGuestSession();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error) {
      await mergeCapturedGuestData();
      return { error: null, reason: null };
    }
    discardCapturedGuestData();
    return { error: error.message, reason: classifySignInError(error) };
  } catch (err) {
    discardCapturedGuestData();
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, reason: classifySignInError({ message }) };
  }
}

/**
 * 이메일/비밀번호 가입.
 * - 지금 게스트(익명) 세션이면 updateUser 로 정회원 전환 → uid 유지 → 저장·취향 데이터가 그대로 이어진다.
 * - 세션이 없으면 signUp 으로 새로 만든다.
 * needsConfirmation: 메일 확인(Confirm email)이 켜져 있어 아직 세션이 없거나 익명 그대로일 때 true.
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
      const { error } = await supabase.auth.updateUser({ email, password, ...(meta ? { data: meta } : {}) });
      if (error) return { error: error.message, reason: classifySignUpError(error), needsConfirmation: false };
      // 전환은 UPDATE 라 handle_new_user 트리거를 타지 않는다 — 닉네임을 직접 채운다.
      await syncProfileFromProvider();
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
    return { error: null, reason: null, needsConfirmation: !data.session };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, reason: classifySignUpError({ message }), needsConfirmation: false };
  }
}

/** 재설정 메일의 복귀 주소 — 웹과 같은 값(웹 콜백 → /auth/reset-password). 운영 허용 목록에 이미 있다. */
export const PASSWORD_RESET_REDIRECT = `${WEB_ORIGIN}/auth/callback?next=${encodeURIComponent('/auth/reset-password')}`;

/**
 * 비밀번호 재설정 메일을 보낸다. **새 비밀번호 입력은 앱이 아니라 웹에서 한다.**
 * 메일 링크는 웹 주소로 열린다. 앱 클라이언트는 PKCE 라 링크 code 의 짝(code_verifier)이 이 기기 앱 안에만 있어,
 * 지금 메일 템플릿(?code=)으로는 웹에서 교환이 실패한다(계획 §7.2 H4). 메일 템플릿을 token_hash 꼴로 바꾸고 웹
 * /auth/confirm(verifyOtp)을 더하면(별도 작업) 어느 기기에서 열어도 된다. 화면은 이 사실을 안내한다.
 */
export async function requestPasswordReset(email: string): Promise<{ error: string | null }> {
  try {
    const { error } = await createPublicClient().auth.resetPasswordForEmail(email, {
      redirectTo: PASSWORD_RESET_REDIRECT,
    });
    return { error: error?.message ?? null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 로그인·전환 직후 public.users 의 이름·사진을 공급자 값에 맞춘다(웹과 같은 규칙 — profileSync.ts).
 * 실패해도 로그인은 계속한다.
 */
export async function syncProfileFromProvider(): Promise<void> {
  try {
    const supabase = createPublicClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const meta = readProviderMeta(user.user_metadata as Record<string, unknown> | undefined);
    if (!meta.name && !meta.avatar) return;
    const { data: profile } = await supabase
      .from('users')
      .select('nickname, avatar_url, nickname_source')
      .eq('id', user.id)
      .single();
    const patch = resolveProfileSync(meta, (profile as StoredProfile | null) ?? null);
    if (Object.keys(patch).length === 0) return;
    await supabase.from('users').update(patch).eq('id', user.id);
  } catch (err) {
    console.warn('[auth] 프로필 동기화 건너뜀:', err);
  }
}
