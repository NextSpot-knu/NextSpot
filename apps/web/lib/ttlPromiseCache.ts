// 한 화면 안에서 같은 조회를 여러 번 부를 때 쓰는 짧은 수명 캐시 — 결과(Promise)를 ttlMs 동안 나눠 쓴다.
//
// 왜: 장소 관리(/admin/infrastructure)는 시설 목록을 조용히 다시 불러올 때마다 추정 피드(/congestion/estimates,
// 서버 5분 캐시)를 함께 쓴다. 예전에는 첫 응답을 화면 수명 내내 붙들어서 ① 새 관측과 오래된 추정이 짝지어졌고
// ② 첫 조회가 한 번 실패하면 빈 결과가 끝까지 남아 다시 묻지 않았다. 그래서
//   · ttlMs 가 지나면 새로 묻는다,
//   · 실패한(거부된) 조회는 담아 두지 않는다 — 다음 호출이 다시 묻는다.
// 실패를 무엇으로 보일지는 호출부가 정한다(이 캐시는 거부를 그대로 넘긴다).

export function ttlPromiseCache<T>(load: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T> {
  let entry: { promise: Promise<T>; at: number } | null = null;
  return () => {
    if (entry && now() - entry.at < ttlMs) return entry.promise;
    const mine = { at: now(), promise: load() };
    entry = mine;
    mine.promise.catch(() => {
      if (entry === mine) entry = null;
    });
    return mine.promise;
  };
}
