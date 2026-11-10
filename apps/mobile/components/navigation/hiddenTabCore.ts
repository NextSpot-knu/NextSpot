// 숨은 탭 경로(explore/map 등)에서 다른 탭으로 '바꿔치기'할 때의 탭 상태 — 순수 계산(hiddenTabCore.test.ts).
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
