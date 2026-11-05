// 마이페이지의 기기·서버 동작 — 로그아웃 · 계정(게스트 포함) 삭제 · 프로필 읽기·저장 · 구글 계속하기 · 저장 데이터 초기화.
// 웹 원본: apps/web/app/mypage/page.tsx · settings/page.tsx · components/AccountSection.tsx (기준 커밋 0d145a1).
// 순서 규칙은 accountCore.ts(테스트 대상), 여기는 앱 모듈(supabase·apiClient·localStorage)에 묶는 얇은 층.
import type { User } from '@supabase/supabase-js';

import { deleteMyAccount } from '~/lib/core/apiClient';
import { ensureAnonymousSession } from '~/lib/core/anonymousSession';
import { runOAuthSession } from '~/features/auth/oauthSession';
import { discardCapturedGuestData } from '~/lib/core/guestMerge';
import { clearSavedAll } from '~/lib/core/savedFacilities';
import { createPublicClient } from '~/lib/core/supabase';
import { clearUserScopedData } from '~/lib/core/userData';

import { countJsonArray, pickDisplayName, runAccountDeletion, type OAuthProvider } from './accountCore';

const store = (): Storage | null => (globalThis as { localStorage?: Storage }).localStorage ?? null;

function readKey(key: string): string | null {
  try { return store()?.getItem(key) ?? null; } catch { return null; }
}

export interface Profile {
  /** null = 이름이 없는 게스트(문구는 렌더 때 현재 언어로). */
  name: string | null;
  email: string;
  /** 이메일 없는 소셜 계정이 연결된 곳. */
  linkedProvider: OAuthProvider | null;
  /** 연결된 소셜 프로바이더들(AccountSection 의 '연결됨' 뱃지). */
  providers: OAuthProvider[];
  /** 익명이 아닌 계정인가(세션 기준) — 게스트에게는 로그아웃·가입 계정 삭제를 보이지 않는다. */
  isMember: boolean;
  saved: number;
  visited: number;
  avatar: string | null;
}

/** supabase user → 계정 상태(웹 lib/oauthFlow.deriveAuthState 와 같은 판정). */
export function deriveMember(user: User | null | undefined): { isMember: boolean; providers: OAuthProvider[] } {
  if (!user) return { isMember: false, providers: [] };
  const providers = (user.identities ?? [])
    .map((i) => i.provider)
    .filter((p): p is OAuthProvider => p === 'kakao' || p === 'google');
  return { isMember: user.is_anonymous === false || providers.length > 0, providers };
}

/** 프로필·통계 읽기. 세션을 못 읽어도 게스트로 계속한다(던지지 않는다). */
export async function loadProfile(): Promise<Profile> {
  let email = '';
  let remoteNickname: string | null = null;
  let avatar: string | null = null;
  let member = { isMember: false, providers: [] as OAuthProvider[] };
  try {
    const supabase = createPublicClient();
    const { data: { user } } = await supabase.auth.getUser();
    member = deriveMember(user);
    if (user?.email) email = user.email;
    if (user) {
      const { data: row } = await supabase.from('users').select('nickname, avatar_url').eq('id', user.id).single();
      if (row?.nickname) remoteNickname = row.nickname as string;
      if (row?.avatar_url) avatar = row.avatar_url as string;
    }
  } catch (err) {
    console.warn('[mypage] 프로필 조회 실패', err);
  }
  const name = pickDisplayName({ remoteNickname, email, storedName: remoteNickname ? null : readKey('nextspot_display_name') });
  return {
    name,
    email,
    linkedProvider: !email && member.providers[0] ? member.providers[0] : null,
    providers: member.providers,
    isMember: member.isMember,
    saved: countJsonArray(readKey('nextspot_saved_facilities')),
    visited: countJsonArray(readKey('nextspot_visit_history')),
    avatar,
  };
}

/** 표시 이름 저장 — 원격(public.users)에 먼저 쓰고 성공한 뒤에 기기 캐시를 갱신한다(웹과 같다). 실패하면 던진다. */
export async function saveNickname(nickname: string): Promise<void> {
  const supabase = createPublicClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    // nickname_source='user' — 없으면 다음 소셜 로그인에서 프로바이더 이름으로 덮인다.
    const { error } = await supabase.from('users').update({ nickname, nickname_source: 'user' }).eq('id', user.id);
    if (error) throw error;
  }
  try { store()?.setItem('nextspot_display_name', nickname); } catch { /* 캐시 실패는 저장 실패가 아니다 */ }
}

/** 로그아웃 — 세션 종료 + 이 기기의 개인 데이터 삭제. 새 게스트 세션은 SessionBootstrap 이 SIGNED_OUT 에서 만든다. */
export async function signOutAndClear(): Promise<void> {
  try {
    await createPublicClient().auth.signOut();
  } catch (err) {
    console.warn('[mypage] 로그아웃 실패', err);
  } finally {
    clearUserScopedData();
  }
}

/** 계정 삭제(가입 계정) · '내 데이터 삭제'(게스트) — 같은 API(DELETE /api/v1/account/me). 서버가 실패하면 'failed', 아무것도 지우지 않는다. */
export function deleteAccountOrGuestData(): Promise<'ok' | 'failed'> {
  return runAccountDeletion({
    deleteOnServer: () => deleteMyAccount(),
    signOutLocal: async () => { await createPublicClient().auth.signOut({ scope: 'local' }); },
    clearLocalData: () => {
      discardCapturedGuestData();
      clearUserScopedData();
    },
    startGuestSession: async () => { await ensureAnonymousSession(); },
  });
}

/** 저장 목록(서버·기기) + 첫 설정 초기화(웹 '데이터 초기화'). */
export async function resetSavedAndPrefs(): Promise<void> {
  await clearSavedAll();
  try { store()?.removeItem('nextspot_setup_prefs'); } catch { /* 저장소 차단 */ }
}

/**
 * 소셜로 계속하기 — OAuth 는 로그인 화면과 같은 입구(features/auth/oauthSession.runOAuthSession) 하나로만 연다.
 * 그 입구가 '진행 중 로그인' 기록을 남겨야 콜백 라우트(코드 교환의 유일한 주인)가 결과를 받아들인다(계획 §7.2).
 * 따로 signInWithOAuth 를 부르면 콜백이 요청하지 않은 링크로 보고 버린다 — socialPolicy.test 가 이 규칙을 지킨다.
 * delivered = 결과가 들어왔으니 호출부가 /auth/callback 으로 보낸다.
 */
export async function continueWithProvider(provider: OAuthProvider): Promise<{ error: string | null; delivered: boolean }> {
  const result = await runOAuthSession(provider, '/mypage');
  if (result.status === 'delivered') return { error: null, delivered: true };
  if (result.status === 'error') return { error: result.error, delivered: false };
  return { error: null, delivered: false };
}
