// 게스트 데이터 합치기 — 게스트가 기존 계정으로 로그인하면(uid 가 바뀐다) 잡아 둔 게스트 토큰으로 서버가 데이터를 옮긴다.
//
// 웹 원본: apps/web/lib/auth.ts 의 captureGuestSession · mergeCapturedGuestData · discardCapturedGuestData (기준 커밋 e07ea61)
// 웹 auth.ts 는 window.location·authCaptcha·oauthFlow(supabase-js) 를 끌고 와 import 하지 못한다. 이 셋만 옮겼다.
// 바꾼 것: `typeof window` 가드를 뺐다(앱에는 프리렌더가 없다). 저장소는 전역 sessionStorage — 앱 실행 동안만 사는
//          메모리 대역이다(lib/sessionStorage.ts). 웹도 탭을 닫으면 사라지는 값이라 뜻은 같다. 로그인 화면(다음 단계)이
//          로그인 직전에 captureGuestSession() 을, 콜백 라우트·SessionBootstrap 이 mergeCapturedGuestData() 를 부른다.
import { shouldRetryGuestMerge } from '@/lib/authErrors';

import { mergeGuestData } from './apiClient';
import { createPublicClient } from './supabase';

const GUEST_MERGE_KEY = 'nextspot_guest_merge';

function store(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
}

export function discardCapturedGuestData(): void {
  try { store()?.removeItem(GUEST_MERGE_KEY); } catch { /* 무시 */ }
}

/** 로그인(계정 전환) 직전에 부른다 — 지금이 익명 세션이면 그 토큰·uid 를 잡아 둔다. */
export async function captureGuestSession(): Promise<void> {
  const { data: { session } } = await createPublicClient().auth.getSession();
  if (session?.user?.is_anonymous && session.access_token) {
    store()?.setItem(GUEST_MERGE_KEY, JSON.stringify({ token: session.access_token, uid: session.user.id }));
  }
}

/**
 * 잡아 둔 게스트 데이터를 지금 계정으로 합친다. true = 할 일이 끝났다(합쳤거나 필요 없거나 영구 실패로 버렸다),
 * false = 다음 인증 이벤트에서 다시 해야 한다(아직 익명이거나 일시 실패).
 */
export async function mergeCapturedGuestData(): Promise<boolean> {
  const raw = store()?.getItem(GUEST_MERGE_KEY);
  if (!raw) return true;
  try {
    const captured = JSON.parse(raw) as { token?: string; uid?: string };
    const { data: { session } } = await createPublicClient().auth.getSession();
    if (captured.token && captured.uid && session?.user.id && captured.uid !== session.user.id) {
      await mergeGuestData(captured.token);
      discardCapturedGuestData();
      return true;
    }
    // linkIdentity 승격은 uid 가 그대로다. 아직 익명이면 교환 완료 이벤트에서 다시 판정하도록 남긴다.
    if (captured.uid === session?.user.id && session?.user.is_anonymous) return false;
    discardCapturedGuestData();
    return true;
  } catch (err) {
    if (!shouldRetryGuestMerge(err)) {
      console.warn('[auth] 게스트 데이터 병합 불가 — 캡처 폐기:', err);
      discardCapturedGuestData();
      return true;
    }
    console.warn('[auth] 게스트 데이터 병합 재시도 예정:', err);
    return false;
  }
}
