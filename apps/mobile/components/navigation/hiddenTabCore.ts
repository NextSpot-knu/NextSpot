// 탭 기록(backBehavior="history") 다루기 — 순수 계산(hiddenTabCore.test.ts).
// 1) 숨은 탭 경로(explore/map 등)에서 다른 탭으로 '바꿔치기'할 때의 탭 상태(tabStateLeaving).
// 2) 콜드 딥링크에서 홈을 기록 맨 앞에 까는 TabRouter 덮개(withHomeFirstInHistory · homeFirstTabRouter).
//
// 왜 필요한가: 탭 내비게이터는 backBehavior="history" 다(D13(c) — 하드웨어 뒤로 = 이전 화면). 탭 안에서 router.replace 는
// JUMP_TO 가 되어 떠나는 경로가 탭 기록에 남는다. 그 경로가 포커스마다 홈으로 보내는 화면(웹 /explore/map → /main)이면
// 홈에서 뒤로 → 그 경로 → 다시 홈 … 으로 뒤로 키가 갇힌다. 그래서 떠나는 경로를 기록에서 빼고 목적 탭으로 옮긴 상태를 만든다
// (웹 router.replace 처럼 그 주소가 기록에 남지 않는다).

export type TabHistoryEntry = { type: string; key?: string };
export type TabStateLike = {
  index: number;
  routes: readonly { key: string; name: string }[];
  history?: readonly TabHistoryEntry[];
};

/** fromKey 경로를 기록에서 지우고 toName 탭을 포커스한 상태. toName 이 없으면 null. */
export function tabStateLeaving<S extends TabStateLike>(state: S, fromKey: string, toName: string): S | null {
  const toIndex = state.routes.findIndex((r) => r.name === toName);
  if (toIndex < 0) return null;
  const toKey = state.routes[toIndex].key;
  const history = (state.history ?? []).filter((h) => !(h.type === 'route' && (h.key === fromKey || h.key === toKey)));
  return { ...state, index: toIndex, history: [...history, { type: 'route', key: toKey }] };
}

/**
 * 콜드 스타트(딥링크·알림으로 /saved · /explore/recommend · /mypage/coupons 등에 바로 열림)에서 홈을 탭 기록 맨 앞에 깐다.
 * backBehavior="history" 의 첫 상태는 포커스된 경로 하나만 기록하므로(TabRouter getRouteHistory) 하드웨어 뒤로가 곧바로
 * 앱을 닫는다 — B6 전(루트 Stack + initialRouteName '(tabs)')처럼 뒤로 = 홈이 되게. 기록이 이미 둘 이상이면(앱 안에서
 * 오간 뒤) 손대지 않는다. homeName 탭이 없거나 이미 포커스·기록에 있으면 그대로.
 */
export function withHomeFirstInHistory<S extends TabStateLike>(state: S, homeName = 'index'): S {
  const home = state.routes.find((r) => r.name === homeName);
  const focused = state.routes[state.index];
  if (!home || !focused || focused.key === home.key) return state;
  const history = state.history ?? [];
  if (history.length > 1 || history.some((h) => h.type === 'route' && h.key === home.key)) return state;
  return { ...state, history: [{ type: 'route', key: home.key }, ...history] };
}

type StateRouter<S> = {
  getInitialState: (options: never) => S;
  getRehydratedState: (partialState: never, options: never) => S;
};

/**
 * 탭 내비게이터 UNSTABLE_router — 첫 상태(getInitialState·딥링크 getRehydratedState)에만 withHomeFirstInHistory 를 건다.
 * 앱 안의 이동(getStateForAction)은 TabRouter 그대로다.
 */
export function homeFirstTabRouter<S extends TabStateLike, R extends StateRouter<S>>(original: R): Partial<R> {
  const getInitialState = (options: Parameters<R['getInitialState']>[0]) =>
    withHomeFirstInHistory(original.getInitialState(options));
  const getRehydratedState = (
    partialState: Parameters<R['getRehydratedState']>[0],
    options: Parameters<R['getRehydratedState']>[1],
  ) => withHomeFirstInHistory(original.getRehydratedState(partialState, options));
  return { getInitialState, getRehydratedState } as unknown as Partial<R>;
}
