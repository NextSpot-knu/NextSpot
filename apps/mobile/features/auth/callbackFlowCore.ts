// 콜백 라우트의 처리 순서 — 의존성을 주입받는 순수 모듈(테스트: callbackFlow.test.ts). 계획 §7.2.
//
// 웹 원본: apps/web/app/auth/callback/page.tsx (기준 커밋 0d145a1)
// 웹과 다른 점:
//   · 웹은 detectSessionInUrl 이 code 를 몰래 교환하고 화면은 '연동 상태가 될 때까지' 폴링했다. 앱은 detectSessionInUrl 을
//     껐고(lib/core/supabase.ts) 이 흐름이 **유일한 교환 주인**이다 — exchangeOnce(code 당 한 번) 로 직접 교환한다.
//   · 처리 전체도 한 번만 돈다(single-flight). 콜백 화면이 두 번 붙어도(안드로이드 딥링크 이중 수신, 빠른 재마운트)
//     두 번째는 첫 번째의 결과를 그대로 받는다. 그러지 않으면 첫 번째가 '진행 중 흐름' 기록을 지운 뒤 두 번째가
//     '흐름 없음' 실패를 그려 성공한 로그인을 실패처럼 보이게 한다.
//   · 성공·실패와 상관없이 진행 중 흐름 기록과 받은편지함을 비운다(같은 결과를 다시 처리하지 않게).
import type { CallbackInbox, InboxEntry } from './callbackInbox';
import { decideCallbackAction, type CallbackAction } from './callbackDecision';
import type { ExchangeOutcome } from './exchangeCore';
import type { PendingFlow } from './pendingFlow';
import { CALLBACK_DEFAULT_DEST, decidePostLoginDest } from './postLoginDest';
import type { OAuthProvider, PlatformOS } from './socialPolicy';

export type CallbackFailure = 'generic' | 'already_linked';

export type CallbackResult = { kind: 'done'; dest: string } | { kind: 'failed'; reason: CallbackFailure };

export interface CallbackDeps {
  os: PlatformOS;
  /** 계정 연결 폴백(identity_already_exists 재시도). 생략하면 socialPolicy 기본값(v1 false). */
  identityLinking?: boolean;
  now: () => number;
  inbox: CallbackInbox;
  /** 화면이 붙기 직전에 들어온 딥링크(+native-intent 의 콜드 스타트)를 받으려고 잠깐 기다린다. */
  waitForEntry: (sinceMs: number, timeoutMs: number) => Promise<InboxEntry | null>;
  readPending: () => PendingFlow | null;
  clearPending: () => void;
  exchangeOnce: (code: string, flowId: string | null) => Promise<ExchangeOutcome>;
  /** identity_already_exists 폴백 — 같은 공급자로 로그인을 다시 열고, 결과가 받은편지함에 들어왔으면 true. */
  retrySignIn: (provider: OAuthProvider, next: string | null) => Promise<boolean>;
  mergeGuest: () => Promise<unknown>;
  discardGuest: () => void;
  syncProfile: () => Promise<void>;
  warn: (message: string, detail?: unknown) => void;
}

/** 콜드 스타트에서 화면보다 딥링크가 늦게 들어오는 경우를 기다리는 시간. */
export const ENTRY_WAIT_MS = 1500;
/** 폴백 재시도는 한 번만(웹 retry=1 과 같은 뜻 — 결정 함수도 막지만 여기서도 센다). */
const MAX_ROUNDS = 2;

export function createCallbackProcessor(deps: CallbackDeps) {
  let inflight: Promise<CallbackResult> | null = null;
  let last: { result: CallbackResult; at: number } | null = null;

  const fail = (reason: CallbackFailure, action: CallbackAction | null): CallbackResult => {
    deps.clearPending();
    deps.inbox.clear();
    deps.discardGuest();
    if (action) deps.warn('[auth/callback] 실패', action);
    return { kind: 'failed', reason };
  };

  const runOnce = async (): Promise<CallbackResult> => {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const pending = deps.readPending();
      const entry = pending
        ? await deps.waitForEntry(pending.startedAt, round === 0 ? ENTRY_WAIT_MS : 0)
        : deps.inbox.peek();
      const action = decideCallbackAction({
        params: entry?.params ?? null,
        receivedAt: entry?.receivedAt ?? null,
        pending,
        os: deps.os,
        identityLinking: deps.identityLinking,
      });

      if (action.kind === 'exchange' && pending) {
        const outcome = await deps.exchangeOnce(action.code, pending.flowId);
        deps.clearPending();
        deps.inbox.clear();
        if (!outcome.ok) {
          deps.discardGuest();
          deps.warn('[auth/callback] code 교환 실패', outcome.error);
          return { kind: 'failed', reason: 'generic' };
        }
        // 교환 뒤 부가 작업은 실패해도 이동은 반드시 한다(웹과 같다).
        try {
          await deps.mergeGuest();
        } catch (err) {
          deps.warn('[auth/callback] 게스트 합치기 예외 — 다음 인증 이벤트에서 다시 시도', err);
        }
        try {
          await deps.syncProfile();
        } catch (err) {
          deps.warn('[auth/callback] 프로필 동기화 예외', err);
        }
        return { kind: 'done', dest: decidePostLoginDest(pending.next, CALLBACK_DEFAULT_DEST) };
      }

      if (action.kind === 'retry_sign_in' && pending && round + 1 < MAX_ROUNDS) {
        deps.inbox.clear();
        const delivered = await deps.retrySignIn(action.provider, pending.next);
        if (delivered) continue;
        return fail('generic', action);
      }

      if (action.kind === 'fail' && (action.reason === 'no_pending' || action.reason === 'stale')) {
        // 앱이 시작하지 않은(또는 지난) 딥링크 — 다른 앱·웹페이지도 nextspot://auth/callback 을 열 수 있다.
        // 진행 중 흐름·게스트 합치기 토큰(이메일 로그인의 재시도분 포함)은 건드리지 않고 이 결과만 버린다.
        deps.inbox.clear();
        deps.warn('[auth/callback] 요청하지 않은 콜백 무시', action);
        return { kind: 'failed', reason: 'generic' };
      }
      if (action.kind === 'fail' && action.reason === 'already_linked') return fail('already_linked', action);
      return fail('generic', action);
    }
    return fail('generic', null);
  };

  return {
    /**
     * 콜백을 처리한다. 진행 중이면 같은 Promise, 막 끝났으면(30초 안) 같은 결과를 돌려준다.
     * 새 OAuth 흐름을 시작할 때 reset() 으로 기억을 지운다.
     */
    process(): Promise<CallbackResult> {
      if (inflight) return inflight;
      if (last && deps.now() - last.at < 30_000) return Promise.resolve(last.result);
      inflight = runOnce()
        .catch((err): CallbackResult => {
          deps.warn('[auth/callback] 처리 예외', err);
          return fail('generic', null);
        })
        .then((result) => {
          last = { result, at: deps.now() };
          inflight = null;
          return result;
        });
      return inflight;
    },
    reset(): void {
      last = null;
    },
  };
}
