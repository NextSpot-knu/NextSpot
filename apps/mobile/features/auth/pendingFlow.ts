// 진행 중인 OAuth 흐름 기록 — 순수 모듈(저장소 주입, 테스트: pendingFlow.test.ts).
//
// 왜 기기 저장소(localStorage, expo-sqlite)인가: 안드로이드는 Custom Tab 에 있는 동안 OS 가 앱 프로세스를 정리할 수 있다.
// 그러면 앱은 콜백 딥링크로 새로 뜨는데, 메모리에 있던 '누가 무엇을 시작했나' 는 사라진다. supabase-js 의 PKCE
// code_verifier 와 게스트 합치기 토큰(guestMerge)도 같은 저장소에 있어 함께 살아남는다.
// 왜 기록이 필요한가: 콜백 딥링크는 다른 앱도 보낼 수 있다. 앱이 직접 시작한 흐름이 있을 때만 교환하고, 공급자·
// 재시도 여부·목적지는 딥링크가 아니라 이 기록에서 읽는다. 10분이 지나면 버린다(공급자 로그인 화면에서 오래 머문 경우).
import type { OAuthProvider } from './socialPolicy';

export const PENDING_FLOW_KEY = 'nextspot_oauth_pending';
export const PENDING_FLOW_TTL_MS = 10 * 60 * 1000;

export interface PendingFlow {
  provider: OAuthProvider;
  /** identity_already_exists 폴백 로그인인가(웹 retry=1) — 다시 폴백하지 않는다. */
  retry: boolean;
  /** 로그인 뒤 목적지(이미 safeAppNext 로 검증한 값). 없으면 null. */
  next: string | null;
  /** supabase-js 가 이 흐름의 code_verifier 를 넣은 칸 id(signInWithOAuth 결과 data.flowId). 교환 때 그 칸만 읽게 한다 —
   *  없으면(null) supabase-js 의 '가장 최근 흐름' 칸을 읽는데, 그 사이 재설정 메일 요청 같은 다른 PKCE 흐름이 덮었을 수 있다. */
  flowId: string | null;
  startedAt: number;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function writePendingFlow(store: Store | null, flow: PendingFlow): void {
  if (!store) return;
  try {
    store.setItem(PENDING_FLOW_KEY, JSON.stringify(flow));
  } catch {
    /* 저장 실패 — 콜백이 '흐름 없음' 으로 안전하게 실패한다 */
  }
}

export function clearPendingFlow(store: Store | null): void {
  if (!store) return;
  try {
    store.removeItem(PENDING_FLOW_KEY);
  } catch {
    /* 무시 */
  }
}

/** 유효한 기록만 돌려준다. 모양이 틀리거나 만료면 지우고 null. */
export function readPendingFlow(store: Store | null, now: number): PendingFlow | null {
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(PENDING_FLOW_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingFlow>;
    const valid =
      (v.provider === 'google' || v.provider === 'kakao') &&
      typeof v.retry === 'boolean' &&
      (v.next === null || typeof v.next === 'string') &&
      (v.flowId === null || v.flowId === undefined || typeof v.flowId === 'string') &&
      typeof v.startedAt === 'number' &&
      Number.isFinite(v.startedAt) &&
      v.startedAt <= now + 60_000 && // 시계가 크게 앞선 값은 믿지 않는다
      now - v.startedAt <= PENDING_FLOW_TTL_MS;
    if (!valid) {
      clearPendingFlow(store);
      return null;
    }
    return {
      provider: v.provider as OAuthProvider,
      retry: v.retry as boolean,
      next: v.next ?? null,
      flowId: typeof v.flowId === 'string' && v.flowId ? v.flowId : null,
      startedAt: v.startedAt as number,
    };
  } catch {
    clearPendingFlow(store);
    return null;
  }
}
