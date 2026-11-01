// 게스트 데이터 합치기의 순수 부분 — 저장소·시계·세션·병합 호출을 주입받는다(테스트: guestMergeCore.test.ts).
// 연결은 guestMerge.ts. 규칙(웹 apps/web/lib/auth.ts, 기준 커밋 e07ea61)과 앱에서 바꾼 것은 그 파일 머리말에 있다.

export const GUEST_MERGE_KEY = 'nextspot_guest_merge';
/**
 * 잡아 둔 게스트 토큰을 믿는 시간. Supabase 접근 토큰 기본 수명(1시간)과 같다 — 그 뒤에는 서버가 어차피 거절한다.
 * 로그인 화면에서 앱이 내려가 OS 가 프로세스를 정리해도(소셜 로그인 · 메일 확인) 이 안에 돌아오면 합친다.
 */
export const GUEST_MERGE_TTL_MS = 60 * 60 * 1000;

export interface CapturedGuest {
  token: string;
  uid: string;
  /** 잡은 시각(ms). */
  at: number;
}

export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface SessionLike {
  access_token?: string;
  user?: { id?: string; is_anonymous?: boolean } | null;
}

export interface GuestMergeDeps {
  store(): KeyValueStore | null;
  now(): number;
  getSession(): Promise<SessionLike | null>;
  /** 서버에 게스트 토큰으로 데이터를 옮겨 달라고 한다(POST /account/merge-guest). */
  merge(guestToken: string): Promise<unknown>;
  /** 이 오류가 '나중에 다시 하면 될' 실패인가(웹 shouldRetryGuestMerge). */
  shouldRetry(err: unknown): boolean;
  warn?(message: string, err?: unknown): void;
}

/** 저장된 값을 읽는다. 모양이 틀렸거나 TTL 이 지났으면 null(+ 지운다). */
export function readCaptured(store: KeyValueStore | null, now: number): CapturedGuest | null {
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(GUEST_MERGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CapturedGuest>;
    if (
      typeof parsed.token === 'string' &&
      parsed.token &&
      typeof parsed.uid === 'string' &&
      parsed.uid &&
      typeof parsed.at === 'number' &&
      now - parsed.at >= 0 &&
      now - parsed.at < GUEST_MERGE_TTL_MS
    ) {
      return { token: parsed.token, uid: parsed.uid, at: parsed.at };
    }
  } catch {
    /* 깨진 값 — 아래에서 지운다 */
  }
  try {
    store.removeItem(GUEST_MERGE_KEY);
  } catch {
    /* 무시 */
  }
  return null;
}

export function createGuestMerge(deps: GuestMergeDeps) {
  let inflight: Promise<boolean> | null = null;

  function discard(): void {
    try {
      deps.store()?.removeItem(GUEST_MERGE_KEY);
    } catch {
      /* 무시 */
    }
  }

  /** 로그인(계정 전환) 직전에 부른다 — 지금이 익명 세션이면 그 토큰·uid·시각을 잡아 둔다. */
  async function capture(): Promise<void> {
    const session = await deps.getSession();
    if (session?.user?.is_anonymous && session.access_token && session.user.id) {
      const value: CapturedGuest = { token: session.access_token, uid: session.user.id, at: deps.now() };
      try {
        deps.store()?.setItem(GUEST_MERGE_KEY, JSON.stringify(value));
      } catch {
        /* 저장 실패 — 합치기를 못 할 뿐 로그인은 막지 않는다 */
      }
    }
  }

  async function run(): Promise<boolean> {
    const captured = readCaptured(deps.store(), deps.now());
    if (!captured) return true;
    try {
      const session = await deps.getSession();
      const uid = session?.user?.id;
      if (uid && captured.uid !== uid) {
        await deps.merge(captured.token);
        discard();
        return true;
      }
      // linkIdentity 승격은 uid 가 그대로다. 아직 익명이면 교환 완료 이벤트에서 다시 판정하도록 남긴다.
      if (captured.uid === uid && session?.user?.is_anonymous) return false;
      discard();
      return true;
    } catch (err) {
      if (!deps.shouldRetry(err)) {
        deps.warn?.('[auth] 게스트 데이터 병합 불가 — 캡처 폐기:', err);
        discard();
        return true;
      }
      deps.warn?.('[auth] 게스트 데이터 병합 재시도 예정:', err);
      return false;
    }
  }

  /**
   * 잡아 둔 게스트 데이터를 지금 계정으로 합친다. true = 할 일이 끝났다(합쳤거나 필요 없거나 영구 실패로 버렸다),
   * false = 다음 인증 이벤트에서 다시 해야 한다(아직 익명이거나 일시 실패).
   * 동시에 여러 번 불려도(인증 이벤트 연속 · 콜백 라우트와 SessionBootstrap) 서버 호출은 한 번 — 같은 약속을 돌려준다.
   */
  function mergeCaptured(): Promise<boolean> {
    if (!inflight) {
      inflight = run().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  return { capture, mergeCaptured, discard };
}
