// 내 문의 — 응답 읽기 · '새 답변' 읽음 기록. 웹 apps/web/app/mypage/inquiries/{page.tsx,seen.ts} 의 순수 부분(기준 커밋 0d145a1).
// 읽음은 이 기기에만 남는다(웹과 같은 한계: 기기를 바꾸면 이미 읽은 답이 다시 '새 답변'). 실패는 전부 '안 읽음' 쪽으로 떨어뜨린다.

export interface InquiryItem {
  id: string;
  type: string | null;
  title: string | null;
  content: string | null;
  status: 'new' | 'in_progress' | 'resolved';
  createdAt: string | null;
  /** 관리자 답변 본문. null = 아직 답변 없음(공백뿐인 답도 없음). */
  replyBody: string | null;
  repliedAt: string | null;
}

/** GET /api/v1/inquiries/mine 응답({ items }) → 항목들. */
export function readInquiries(data: unknown): InquiryItem[] {
  const items = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.map((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const status = row.status === 'resolved' || row.status === 'in_progress' ? row.status : 'new';
    return {
      id: String(row.id),
      type: typeof row.type === 'string' ? row.type : null,
      title: typeof row.title === 'string' ? row.title : null,
      content: typeof row.content === 'string' ? row.content : null,
      status,
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
      replyBody: typeof row.replyBody === 'string' && row.replyBody.trim() ? row.replyBody : null,
      repliedAt: typeof row.repliedAt === 'string' ? row.repliedAt : null,
    };
  });
}

export const SEEN_REPLIES_KEY = 'nextspot_seen_inquiry_replies';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStore(): Store | null {
  return (globalThis as { localStorage?: Storage }).localStorage ?? null;
}

function readSeen(store: Store | null): Set<string> {
  if (!store) return new Set();
  try {
    const raw = store.getItem(SEEN_REPLIES_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

/** 답변을 본 것으로 기록한다(내 문의 화면을 열었을 때). */
export function markInquiryRepliesSeen(ids: readonly string[], store: Store | null = defaultStore()): void {
  if (ids.length === 0 || !store) return;
  try {
    const merged = readSeen(store);
    for (const id of ids) merged.add(id);
    store.setItem(SEEN_REPLIES_KEY, JSON.stringify([...merged]));
  } catch { /* 저장 실패 — 배지가 한 번 더 뜰 뿐 */ }
}

/** 아직 이 기기에서 보지 않은 답변 건수(배지 숫자). */
export function countUnseenReplies(repliedIdList: readonly string[], store: Store | null = defaultStore()): number {
  if (repliedIdList.length === 0) return 0;
  const seen = readSeen(store);
  return repliedIdList.filter((id) => !seen.has(id)).length;
}

/** 목록에서 답변이 달린 문의 id 들. */
export function repliedIds(items: readonly InquiryItem[]): string[] {
  return items.filter((item) => item.replyBody).map((item) => item.id);
}
