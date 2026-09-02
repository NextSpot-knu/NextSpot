// 저장 장소(북마크) 저장소 — localStorage 캐시 + Supabase 영속화(계정 기준).
//
// - localStorage: 즉시 렌더/오프라인용 캐시(기존 동작 유지). 키 nextspot_saved_facilities.
// - Supabase saved_facilities: 사용자별 영속 저장(기기 변경에도 따라옴, RLS 로 격리).
// 세션(익명 포함)이 있으면 DB 와 양방향 동기화하고, 세션이 없으면(목업 폴백) localStorage 만 쓴다.

import { createPublicClient } from "@/lib/supabase";

const KEY = "nextspot_saved_facilities";
// 원격 삭제가 실패한 항목의 id. 이게 없으면 삭제가 **되살아난다** — 병합이 union 이라
// 원격에 남은 행이 다음 syncSaved 에서 그대로 돌아오기 때문이다(사용자는 지웠는데 다시 생긴다).
const PENDING_DELETE_KEY = "nextspot_saved_pending_deletes";

// 북마크 스냅샷. 프런트 페이지의 BookmarkData/SavedBookmark 와 호환(id 필수 + 임의 필드).
export type SavedRecord = { id: string } & Record<string, unknown>;

// ── localStorage 캐시(동기) ─────────────────────────────────────────
export function loadSavedLocal(): SavedRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? (arr as SavedRecord[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(list: SavedRecord[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* localStorage 차단 — 무시 */
  }
}

// 현재 인증 세션의 user_id(익명 포함). 세션 없으면 null → DB 동기화 건너뜀(localStorage 만).
async function currentUserId(): Promise<string | null> {
  try {
    const {
      data: { user },
    } = await createPublicClient().auth.getUser();
    return user?.id ?? null;
  } catch {
    return null;
  }
}

function loadPendingDeletes(): string[] {
  try {
    const raw = localStorage.getItem(PENDING_DELETE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writePendingDeletes(ids: string[]): void {
  try {
    if (ids.length) localStorage.setItem(PENDING_DELETE_KEY, JSON.stringify(ids));
    else localStorage.removeItem(PENDING_DELETE_KEY);
  } catch {
    /* localStorage 차단 — 무시 */
  }
}

/**
 * 로컬·원격·보류삭제를 합쳐 최종 목록을 만든다(순수 함수 — 테스트 가능하게 분리).
 *
 * 규칙은 셋이다:
 *   · id 기준 union, 공유 id 는 원격 스냅샷 우선(서버가 진실).
 *   · **보류 삭제 id 는 원격에 남아 있어도 뺀다.** 이게 되살아남을 막는 유일한 지점이다.
 *   · 순서는 로컬 먼저 — 화면이 갑자기 재정렬되지 않게.
 */
export function mergeSaved(
  local: SavedRecord[],
  remote: SavedRecord[],
  pendingDeletes: readonly string[] = [],
): SavedRecord[] {
  const deleted = new Set(pendingDeletes);
  const byId = new Map<string, SavedRecord>();
  for (const b of local) if (!deleted.has(b.id)) byId.set(b.id, b);
  for (const b of remote) if (!deleted.has(b.id)) byId.set(b.id, b);
  return [...byId.values()];
}

// ── 동기화: 로컬 ↔ 원격 병합 ────────────────────────────────────────
// 앱 로드/저장 페이지 진입 시 호출. 원격을 로컬로 합쳐(원격 우선) 기기 변경 복원을 처리하고,
// 로컬에만 있던 항목(오프라인 저장분)은 원격으로 올린다. 세션 없으면 로컬 그대로 반환.
export async function syncSaved(): Promise<SavedRecord[]> {
  const local = loadSavedLocal();
  const uid = await currentUserId();
  if (!uid) return local;

  let remote: SavedRecord[] = [];
  try {
    const { data, error } = await createPublicClient()
      .from("saved_facilities")
      .select("data")
      .eq("user_id", uid);
    if (error) return local; // 조회 실패 → 로컬 유지(무중단)
    remote = (data ?? [])
      .map((r) => (r as { data: SavedRecord }).data)
      .filter((b): b is SavedRecord => !!b && typeof b.id === "string");
  } catch {
    return local;
  }

  // 로컬을 **여기서 다시 읽는다.** 위의 local 은 세션 조회와 원격 select 두 번의 왕복 이전에
  // 찍은 스냅샷이라, 그 사이 사용자가 저장하거나 지운 항목이 빠져 있다. 그 낡은 값으로
  // writeLocal 하면 방금 한 저장이 조용히 사라진다(사용자에겐 저장이 씹힌 것으로 보인다).
  const fresh = loadSavedLocal();
  // 지우려다 실패했던 항목은 원격에 남아 있어도 목록에서 뺀다(되살아남 방지).
  const pending = loadPendingDeletes();
  const merged = mergeSaved(fresh, remote, pending);
  writeLocal(merged);

  // 그리고 원격 삭제를 다시 시도한다. 성공한 것만 보류 목록에서 지운다.
  if (pending.length) {
    const stillPending: string[] = [];
    for (const id of pending) {
      if (!(await deleteRemote(uid, id))) stillPending.push(id);
    }
    writePendingDeletes(stillPending);
  }

  // 로컬에만 있던 항목(오프라인 저장분)을 원격으로 업로드. 판단 근거는 위와 같은 fresh 다 —
  // 낡은 스냅샷을 쓰면 동기화 중에 저장한 항목이 업로드 대상에서 빠진다.
  const remoteIds = new Set(remote.map((b) => b.id));
  const deleting = new Set(pending);
  const localOnly = fresh.filter((b) => !remoteIds.has(b.id) && !deleting.has(b.id));
  if (localOnly.length) {
    try {
      await createPublicClient()
        .from("saved_facilities")
        .upsert(
          localOnly.map((b) => ({ user_id: uid, facility_id: b.id, data: b })),
          { onConflict: "user_id,facility_id" },
        );
    } catch {
      /* 업로드 실패 — 다음 동기화에서 재시도 */
    }
  }
  return merged;
}

// ── 개별 변경(로컬 즉시 + 원격 반영) ────────────────────────────────
export async function saveBookmark(bookmark: SavedRecord): Promise<void> {
  const list = loadSavedLocal();
  if (!list.some((b) => b.id === bookmark.id)) {
    list.push(bookmark);
    writeLocal(list); // UI 는 로컬 캐시로 즉시 일관
  }
  // 지웠다가 다시 저장하는 경우 — 보류 삭제에서 빼지 않으면 이번 저장이 동기화 때 지워진다.
  const pending = loadPendingDeletes();
  if (pending.includes(bookmark.id)) writePendingDeletes(pending.filter((v) => v !== bookmark.id));

  const uid = await currentUserId();
  if (!uid) return;
  try {
    await createPublicClient()
      .from("saved_facilities")
      .upsert({ user_id: uid, facility_id: bookmark.id, data: bookmark }, { onConflict: "user_id,facility_id" });
  } catch {
    /* 오프라인 — 로컬엔 남아 다음 syncSaved 에서 업로드됨 */
  }
}

/** 원격 삭제 1건. 성공이면 true.
 *
 * supabase-js 는 HTTP·RLS 오류에 **예외를 던지지 않고** `{ error }` 로 돌려준다. 그래서
 * try/catch 만 두면 거부당한 삭제가 성공으로 보인다 — 반환값도 같이 봐야 한다. */
async function deleteRemote(uid: string, id: string): Promise<boolean> {
  try {
    const { error } = await createPublicClient()
      .from("saved_facilities")
      .delete()
      .eq("user_id", uid)
      .eq("facility_id", id);
    return !error;
  } catch {
    return false;
  }
}

export async function removeBookmark(id: string): Promise<void> {
  writeLocal(loadSavedLocal().filter((b) => b.id !== id));
  const uid = await currentUserId();
  if (!uid) return;
  if (await deleteRemote(uid, id)) return;
  // 실패를 삼키면 원격 행이 남아 다음 syncSaved 가 북마크를 되살린다. 기록해 두고 다시 시도한다.
  const pending = loadPendingDeletes();
  if (!pending.includes(id)) writePendingDeletes([...pending, id]);
}

export async function clearSavedAll(): Promise<void> {
  const ids = loadSavedLocal().map((b) => b.id);
  writeLocal([]);
  const uid = await currentUserId();
  if (!uid) return;
  try {
    const { error } = await createPublicClient()
      .from("saved_facilities")
      .delete()
      .eq("user_id", uid);
    if (!error) return;
  } catch {
    /* 아래에서 보류 삭제로 넘긴다 */
  }
  // 전체 삭제가 실패해도 되살아나면 안 된다 — 개별 항목과 같은 경로로 재시도한다.
  writePendingDeletes([...new Set([...loadPendingDeletes(), ...ids])]);
}
