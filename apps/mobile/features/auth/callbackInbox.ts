// 인증 복귀 딥링크 받은편지함 — 앱 안에서 하나(모듈 싱글턴). 순수 모듈(테스트: callbackInbox.test.ts).
//
// 딥링크가 들어오는 길은 셋이다.
//   ① iOS: ASWebAuthenticationSession 이 openAuthSessionAsync 의 결과(url)로만 돌려준다(라우터는 모른다).
//   ② 안드로이드(앱이 살아 있음): Custom Tab 이 nextspot://auth/callback 을 열면 Linking 'url' 이벤트가
//      WebBrowser(결과 success)와 Expo Router(+native-intent, initial=false) 양쪽에 간다. 그리고 WebBrowser 는
//      '앱이 다시 앞으로 왔다(AppState)' 와 경주해서 성공인데도 dismiss 를 돌려줄 수 있다.
//   ③ 안드로이드(로그인 중 OS 가 프로세스를 정리함): 앱이 그 딥링크로 새로 뜬다(+native-intent, initial=true).
// 셋 다 여기로 넣고(deliver), 콜백 라우트 하나만 꺼내 교환한다. 같은 URL·같은 code 는 한 번만 받는다.
// 딥링크 원문(code)은 라우터 경로·기록에 남기지 않는다 — +native-intent 는 쿼리 없는 '/auth/callback' 으로만 보낸다.
import { isAuthCallbackUrl, parseAuthCallback, type AuthCallbackParams } from './redirect';

export interface InboxEntry {
  params: AuthCallbackParams;
  receivedAt: number;
}

type Listener = (entry: InboxEntry) => void;

export interface CallbackInbox {
  /** 콜백 딥링크를 넣는다. 새로 받았으면 true(콜백이 아니거나, 지금 든 것과 같은 결과면 false). */
  deliver(url: string): boolean;
  /** 지금 든 결과(꺼내지 않는다). */
  peek(): InboxEntry | null;
  /** 비운다 — 새 OAuth 흐름을 시작할 때와 콜백이 처리를 끝냈을 때. */
  clear(): void;
  /** 새 결과가 들어오면 알린다. 해제 함수를 돌려준다. */
  subscribe(listener: Listener): () => void;
}

function sameResult(a: AuthCallbackParams, b: AuthCallbackParams): boolean {
  if (a.code || b.code) return a.code === b.code;
  return a.error === b.error && a.errorCode === b.errorCode && a.errorDescription === b.errorDescription;
}

export function createCallbackInbox(now: () => number = () => Date.now()): CallbackInbox {
  let current: InboxEntry | null = null;
  /** 이미 받은 code — 비운 뒤에 같은 code 가 늦게(안드로이드 두 번째 길) 들어와도 다시 받지 않는다. */
  const seenCodes = new Set<string>();
  const listeners = new Set<Listener>();

  return {
    deliver(url) {
      if (!isAuthCallbackUrl(url)) return false;
      const params = parseAuthCallback(url);
      if (params.code && seenCodes.has(params.code)) return false;
      if (current && sameResult(current.params, params)) return false;
      if (params.code) seenCodes.add(params.code);
      current = { params, receivedAt: now() };
      const entry = current;
      for (const listener of [...listeners]) {
        try {
          listener(entry);
        } catch {
          /* 듣는 쪽 오류가 받기를 막지 않게 */
        }
      }
      return true;
    },
    peek() {
      return current;
    },
    clear() {
      current = null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** 앱 전체가 쓰는 받은편지함 하나. +native-intent · 로그인 화면 · 콜백 라우트가 같은 것을 본다. */
export const authCallbackInbox: CallbackInbox = createCallbackInbox();

/**
 * 결과가 들어올 때까지 최대 timeoutMs 기다린다(이미 있으면 바로). 안드로이드에서 WebBrowser 가 dismiss 로 먼저
 * 끝나도 뒤따라오는 딥링크를 받기 위해 쓴다. sinceMs 보다 오래된 결과는 무시한다.
 */
export function waitForCallback(
  inbox: CallbackInbox,
  sinceMs: number,
  timeoutMs: number,
  setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
): Promise<InboxEntry | null> {
  const existing = inbox.peek();
  if (existing && existing.receivedAt >= sinceMs) return Promise.resolve(existing);
  if (timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (entry: InboxEntry | null) => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimer(timer);
      resolve(entry);
    };
    const timer = setTimer(() => finish(null), timeoutMs);
    unsubscribe = inbox.subscribe((entry) => {
      if (entry.receivedAt >= sinceMs) finish(entry);
    });
  });
}
