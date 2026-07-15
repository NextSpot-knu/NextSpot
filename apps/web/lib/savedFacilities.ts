// 저장 장소(북마크) 저장소 — localStorage 캐시 + Supabase 영속화(계정 기준).
//
// - localStorage: 즉시 렌더/오프라인용 캐시(기존 동작 유지). 키 nextspot_saved_facilities.
// - Supabase saved_facilities: 사용자별 영속 저장(기기 변경에도 따라옴, RLS 로 격리).
// 세션(익명 포함)이 있으면 DB 와 양방향 동기화하고, 세션이 없으면(목업 폴백) localStorage 만 쓴다.

import { createPublicClient } from "@/lib/supabase";

const KEY = "nextspot_saved_facilities";

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

  // 병합(id 기준 union, 공유 id 는 원격 스냅샷 우선 = 서버가 진실).
  const byId = new Map<string, SavedRecord>();
  for (const b of local) byId.set(b.id, b);
  for (const b of remote) byId.set(b.id, b);
  const merged = [...byId.values()];
  writeLocal(merged);

  // 로컬에만 있던 항목(오프라인 저장분)을 원격으로 업로드.
  const remoteIds = new Set(remote.map((b) => b.id));
  const localOnly = local.filter((b) => !remoteIds.has(b.id));
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

export async function removeBookmark(id: string): Promise<void> {
  writeLocal(loadSavedLocal().filter((b) => b.id !== id));
  const uid = await currentUserId();
  if (!uid) return;
  try {
    await createPublicClient().from("saved_facilities").delete().eq("user_id", uid).eq("facility_id", id);
  } catch {
    /* noop */
  }
}

export async function clearSavedAll(): Promise<void> {
  writeLocal([]);
  const uid = await currentUserId();
  if (!uid) return;
  try {
    await createPublicClient().from("saved_facilities").delete().eq("user_id", uid);
  } catch {
    /* noop */
  }
}
