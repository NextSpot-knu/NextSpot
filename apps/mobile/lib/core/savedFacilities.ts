// 저장 장소(북마크) — localStorage 캐시 + Supabase saved_facilities 영속화.
//
// 웹 원본: apps/web/lib/savedFacilities.ts (기준 커밋 e07ea61)
// 바꾼 것: Supabase 클라이언트를 앱 것(lib/core/supabase)으로. 저장소는 전역 localStorage(expo-sqlite).
//          규칙(원격 우선 union · 보류 삭제로 되살아남 막기 · 왕복 뒤 로컬 다시 읽기)은 같다.
//          보류 삭제는 원격 삭제 **전에** 적고 성공하면 뺀다(savedPendingCore) — 삭제가 날아가는 동안 돈 syncSaved 가
//          원격에 아직 남은 행으로 그 장소를 되살리지 않게.
import { deleteWithPending } from './savedPendingCore';
import { createPublicClient } from './supabase';

const KEY = 'nextspot_saved_facilities';
const PENDING_DELETE_KEY = 'nextspot_saved_pending_deletes';

export type SavedRecord = { id: string } & Record<string, unknown>;

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
  } catch { /* 무시 */ }
}

async function currentUserId(): Promise<string | null> {
  try {
    const { data: { user } } = await createPublicClient().auth.getUser();
    return user?.id ?? null;
  } catch {
    return null;
  }
}

function loadPendingDeletes(): string[] {
  try {
    const raw = localStorage.getItem(PENDING_DELETE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writePendingDeletes(ids: string[]): void {
  try {
    if (ids.length) localStorage.setItem(PENDING_DELETE_KEY, JSON.stringify(ids));
    else localStorage.removeItem(PENDING_DELETE_KEY);
  } catch { /* 무시 */ }
}

/** 로컬·원격·보류삭제 병합(순수): id 기준 union, 공유 id 는 원격 우선, 보류 삭제는 뺀다, 순서는 로컬 먼저. */
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

/** 원격 삭제 1건. supabase-js 는 오류를 던지지 않고 { error } 로 주므로 반환값을 본다. */
async function deleteRemote(uid: string, id: string): Promise<boolean> {
  try {
    const { error } = await createPublicClient()
      .from('saved_facilities')
      .delete()
      .eq('user_id', uid)
      .eq('facility_id', id);
    return !error;
  } catch {
    return false;
  }
}

/** 로컬 ↔ 원격 병합. 세션이 없으면 로컬 그대로. */
export async function syncSaved(): Promise<SavedRecord[]> {
  const local = loadSavedLocal();
  const uid = await currentUserId();
  if (!uid) return local;

  let remote: SavedRecord[] = [];
  try {
    const { data, error } = await createPublicClient()
      .from('saved_facilities')
      .select('data')
      .eq('user_id', uid);
    if (error) return local;
    remote = (data ?? [])
      .map((r) => (r as { data: SavedRecord }).data)
      .filter((b): b is SavedRecord => !!b && typeof b.id === 'string');
  } catch {
    return local;
  }

  // 왕복 사이에 사용자가 저장·삭제했을 수 있다 — 로컬을 다시 읽는다.
  const fresh = loadSavedLocal();
  const pending = loadPendingDeletes();
  const merged = mergeSaved(fresh, remote, pending);
  writeLocal(merged);

  if (pending.length) {
    const deleted = new Set<string>();
    for (const id of pending) {
      if (await deleteRemote(uid, id)) deleted.add(id);
    }
    // 왕복 사이에 새로 보류된 삭제가 있을 수 있다 — 다시 읽고 지운 것만 뺀다.
    writePendingDeletes(loadPendingDeletes().filter((id) => !deleted.has(id)));
  }

  const remoteIds = new Set(remote.map((b) => b.id));
  const deleting = new Set(pending);
  const localOnly = fresh.filter((b) => !remoteIds.has(b.id) && !deleting.has(b.id));
  if (localOnly.length) {
    try {
      await createPublicClient()
        .from('saved_facilities')
        .upsert(
          localOnly.map((b) => ({ user_id: uid, facility_id: b.id, data: b })),
          { onConflict: 'user_id,facility_id' },
        );
    } catch { /* 다음 동기화에서 재시도 */ }
  }
  return merged;
}

export async function saveBookmark(bookmark: SavedRecord): Promise<void> {
  const list = loadSavedLocal();
  if (!list.some((b) => b.id === bookmark.id)) {
    list.push(bookmark);
    writeLocal(list);
  }
  const pending = loadPendingDeletes();
  if (pending.includes(bookmark.id)) writePendingDeletes(pending.filter((v) => v !== bookmark.id));

  const uid = await currentUserId();
  if (!uid) return;
  try {
    await createPublicClient()
      .from('saved_facilities')
      .upsert({ user_id: uid, facility_id: bookmark.id, data: bookmark }, { onConflict: 'user_id,facility_id' });
  } catch { /* 로컬엔 남아 다음 syncSaved 에서 업로드 */ }
}

export async function removeBookmark(id: string): Promise<void> {
  writeLocal(loadSavedLocal().filter((b) => b.id !== id));
  const uid = await currentUserId();
  if (!uid) return;
  await deleteWithPending(id, {
    loadPending: loadPendingDeletes,
    writePending: writePendingDeletes,
    deleteRemote: (target) => deleteRemote(uid, target),
  });
}

export async function clearSavedAll(): Promise<void> {
  const ids = loadSavedLocal().map((b) => b.id);
  writeLocal([]);
  const uid = await currentUserId();
  if (!uid) return;
  // removeBookmark 와 같은 순서 — 보류 목록에 먼저 넣고, 전체 삭제가 성공하면 뺀다.
  writePendingDeletes([...new Set([...loadPendingDeletes(), ...ids])]);
  try {
    const { error } = await createPublicClient()
      .from('saved_facilities')
      .delete()
      .eq('user_id', uid);
    if (!error) {
      const cleared = new Set(ids);
      writePendingDeletes(loadPendingDeletes().filter((id) => !cleared.has(id)));
    }
  } catch { /* 보류 목록에 남아 다음 syncSaved 가 지운다 */ }
}
