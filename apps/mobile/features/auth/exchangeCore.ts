// code 교환을 code 하나당 한 번만 — 순수 모듈(테스트: exchangeCore.test.ts). 계획 §7.2.
//
// 왜: PKCE code 는 일회용이고 교환하면 기기의 code_verifier 도 지워진다. 같은 code 를 두 번 교환하면 두 번째는
// 반드시 실패하는데(verifier 없음 · invalid_grant), 그 실패가 이미 성공한 로그인을 '실패' 화면으로 덮거나 게스트
// 합치기를 다시 돌린다. 안드로이드는 같은 딥링크가 WebBrowser 결과와 라우터 양쪽으로 들어오고, 콜백 화면이 두 번 붙을
// 수도 있다. 그래서 교환은 이 함수 하나로만 하고:
//   · 진행 중인 같은 code 요청은 같은 Promise 를 돌려준다(single-flight).
//   · 끝난 code 는 결과를 기억해 다시 서버에 보내지 않는다(성공이면 성공, 실패면 실패를 그대로).
//   · 예외(네트워크 등)도 결과로 바꿔 기억한다 — 같은 code 로 다시 보내 봐야 verifier 가 이미 지워져 성공할 수 없다.
// 기억은 앱 프로세스 동안만이다. 프로세스가 새로 뜨면 verifier 도 이미 지워졌으므로 다시 보내도 실패할 뿐 해가 없다.

export interface ExchangeOutcome {
  ok: boolean;
  /** 실패 원인(로그용). 화면에는 보이지 않는다. */
  error: string | null;
}

export type ExchangeFn = (code: string, flowId: string | null) => Promise<{ error: { message?: string } | null }>;

export interface CodeExchanger {
  /** flowId 는 처음 부를 때의 값만 쓴다(같은 code 의 두 번째 호출은 기억한 결과를 돌려준다). */
  exchangeOnce(code: string, flowId?: string | null): Promise<ExchangeOutcome>;
  /** 이 code 가 이미 교환을 시작했는가. */
  has(code: string): boolean;
}

/** 기억할 code 수 상한(오래된 것부터 버린다) — 한 프로세스에서 로그인은 몇 번 안 된다. */
export const MAX_REMEMBERED_CODES = 20;

export function createCodeExchanger(exchange: ExchangeFn): CodeExchanger {
  const results = new Map<string, Promise<ExchangeOutcome>>();

  const run = async (code: string, flowId: string | null): Promise<ExchangeOutcome> => {
    try {
      const { error } = await exchange(code, flowId);
      return error ? { ok: false, error: error.message ?? 'exchange failed' } : { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  return {
    exchangeOnce(code: string, flowId: string | null = null) {
      const existing = results.get(code);
      if (existing) return existing;
      const promise = run(code, flowId);
      results.set(code, promise);
      while (results.size > MAX_REMEMBERED_CODES) {
        const oldest = results.keys().next().value;
        if (oldest === undefined) break;
        results.delete(oldest);
      }
      return promise;
    },
    has(code: string) {
      return results.has(code);
    },
  };
}
