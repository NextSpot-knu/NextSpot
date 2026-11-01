// 저장 해제의 원격 삭제 순서 — 순수 모듈(의존성 주입, 테스트: savedPendingCore.test.ts). 쓰는 곳: savedFacilities.removeBookmark.
//
// 왜 순서가 중요한가: 예전에는 원격 삭제가 **실패한 뒤에야** 보류 삭제 목록에 넣었다. 삭제 요청이 날아가는 동안 다른 곳
// (저장 탭 포커스 · 홈)이 syncSaved 를 돌리면, 원격에는 아직 그 행이 있고 보류 목록에는 없어서 병합이 그 장소를 로컬에
// 되살렸다. 그래서 보류 목록에 **먼저** 넣고, 원격 삭제가 성공하면 뺀다. 실패하면 남겨 다음 syncSaved 가 다시 지운다.

export interface PendingDeleteDeps {
  loadPending(): string[];
  writePending(ids: string[]): void;
  deleteRemote(id: string): Promise<boolean>;
}

/** 보류 목록에 넣고 → 원격 삭제 → 성공하면 보류 목록에서 뺀다. 원격 삭제 성공 여부를 돌려준다. */
export async function deleteWithPending(id: string, deps: PendingDeleteDeps): Promise<boolean> {
  const before = deps.loadPending();
  if (!before.includes(id)) deps.writePending([...before, id]);
  let ok = false;
  try {
    ok = await deps.deleteRemote(id);
  } catch {
    ok = false;
  }
  // 왕복 사이에 다른 곳이 목록을 바꿨을 수 있다 — 다시 읽고 이 id 만 뺀다.
  if (ok) deps.writePending(deps.loadPending().filter((v) => v !== id));
  return ok;
}
