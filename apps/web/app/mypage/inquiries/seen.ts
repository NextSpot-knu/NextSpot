// '새 답변' 배지의 읽음 표시 — 브라우저 로컬 전용.
//
// 왜 localStorage 인가: 읽음 여부를 담을 DB 컬럼이 없고, 그걸 만드는 건 이 작업의 범위가
// 아니다(마이그레이션 20260907091000 은 답변 본문만 추가한다). 읽음은 '이 기기에서 봤다'
// 정도의 약한 사실이라 로컬 저장으로 충분하다 — lib/visits.ts 가 방문 이력에 쓰는 것과
// 같은 판단이다.
//
// 그래서 이 배지가 **약속하지 않는 것**을 분명히 해 둔다:
//   · 기기를 바꾸면 이미 읽은 답변이 다시 '새 답변' 으로 보인다(과다 알림 — 안전한 방향).
//   · 저장이 막힌 브라우저(사생활 보호 모드 등)에서는 배지가 계속 뜬다.
// 반대 방향(읽지 않았는데 배지가 안 뜸)은 답변을 놓치게 만들므로, 실패는 전부
// '아직 안 읽음' 쪽으로 떨어뜨린다.

const STORAGE_KEY = 'nextspot_seen_inquiry_replies';

/** 이 기기에서 이미 본 '답변 있는 문의' 의 id 집합. 저장소 접근 실패는 빈 집합. */
function readSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === 'string')) : new Set();
  } catch {
    // 차단·손상 어느 쪽이든 '아무것도 안 읽음' 으로 둔다(배지가 뜨는 쪽 = 안전한 방향).
    return new Set();
  }
}

/** 답변을 본 것으로 기록한다(내 문의 화면을 열었을 때). */
export function markInquiryRepliesSeen(ids: readonly string[]): void {
  if (ids.length === 0) return;
  try {
    const merged = readSeen();
    for (const id of ids) merged.add(id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...merged]));
  } catch {
    /* 저장 실패는 무시 — 다음에 배지가 한 번 더 뜰 뿐이다. */
  }
}

/** 아직 이 기기에서 보지 않은 답변 건수. 배지 숫자로 쓴다. */
export function countUnseenReplies(repliedIds: readonly string[]): number {
  if (repliedIds.length === 0) return 0;
  const seen = readSeen();
  return repliedIds.filter((id) => !seen.has(id)).length;
}
