// 게스트 데이터 합치기 — 게스트가 기존 계정으로 로그인하면(uid 가 바뀐다) 잡아 둔 게스트 토큰으로 서버가 데이터를 옮긴다.
//
// 웹 원본: apps/web/lib/auth.ts 의 captureGuestSession · mergeCapturedGuestData · discardCapturedGuestData (기준 커밋 e07ea61)
// 웹 auth.ts 는 window.location·authCaptcha·oauthFlow(supabase-js) 를 끌고 와 import 하지 못한다. 이 셋만 옮겼다.
// 바꾼 것:
//   · 저장소: 웹은 sessionStorage(탭 동안). 앱은 localStorage(expo-sqlite) — 소셜 로그인·메일 확인 중에 OS 가 앱 프로세스를
//     정리하면 메모리 대역(sessionStorage)은 사라져 게스트 데이터를 잃는다. 대신 잡은 시각을 함께 적고 1시간(게스트 접근
//     토큰 수명)이 지나면 버린다. 합쳤거나 영구 실패면 바로 지운다.
//   · 동시 호출은 하나로 모은다(single-flight) — 인증 이벤트가 연달아 오면 같은 병합을 두 번 보내지 않게.
//   · `typeof window` 가드를 뺐다(앱에는 프리렌더가 없다).
// 로그인 화면(다음 단계)이 로그인 직전에 captureGuestSession() 을, 콜백 라우트·SessionBootstrap 이 mergeCapturedGuestData() 를 부른다.
import { shouldRetryGuestMerge } from '@/lib/authErrors';

import { mergeGuestData } from './apiClient';
import { createGuestMerge } from './guestMergeCore';
import { createPublicClient } from './supabase';

const guestMerge = createGuestMerge({
  store: () => (globalThis as { localStorage?: Storage }).localStorage ?? null,
  now: () => Date.now(),
  getSession: async () => (await createPublicClient().auth.getSession()).data.session,
  merge: (token) => mergeGuestData(token),
  shouldRetry: shouldRetryGuestMerge,
  warn: (message, err) => console.warn(message, err),
});

export function discardCapturedGuestData(): void {
  guestMerge.discard();
}

/** 로그인(계정 전환) 직전에 부른다 — 지금이 익명 세션이면 그 토큰·uid 를 잡아 둔다. */
export function captureGuestSession(): Promise<void> {
  return guestMerge.capture();
}

/**
 * 잡아 둔 게스트 데이터를 지금 계정으로 합친다. true = 할 일이 끝났다(합쳤거나 필요 없거나 영구 실패로 버렸다),
 * false = 다음 인증 이벤트에서 다시 해야 한다(아직 익명이거나 일시 실패). 동시에 불리면 한 번만 보낸다.
 */
export function mergeCapturedGuestData(): Promise<boolean> {
  return guestMerge.mergeCaptured();
}
