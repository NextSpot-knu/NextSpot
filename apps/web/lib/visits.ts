// 방문 여정 로컬 스토어 — '수락(길안내 시작) → 30분 뒤 다녀오셨나요? 확인 → 방문 이력' 루프.
// 정적 export 앱이라 서버 없이 localStorage 로만 처리한다(무세션 데모에서도 동작). 모든 접근은 방어적:
// 저장이 막힌 환경(시크릿 모드 등)·파싱 실패에서도 예외를 던지지 않고 안전한 기본값으로 수렴한다.

const PENDING_KEY = 'nextspot_pending_visit';
const HISTORY_KEY = 'nextspot_visit_history';

// 수락 후 이 시간이 지나야 '다녀오셨나요?' 확인을 노출한다(도착·이용에 걸리는 최소 여유).
const DUE_AFTER_MS = 30 * 60 * 1000;

export interface PendingVisit {
  facilityId: string;
  name: string;
  type: string;
  lat: number | null;
  lng: number | null;
  acceptedAt: number; // epoch ms
}

export interface VisitHistoryEntry {
  facilityId: string;
  name: string;
  type: string;
  visitedAt: number;              // 방문 확인을 처리한 시각(epoch ms)
  rating: 'up' | 'down' | null;   // 👍 좋았어요 / 👎 별로 / 무응답
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function safeGet(key: string): string | null {
  if (!isBrowser()) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 저장 차단 환경 — 조용히 무시(여정 차단 금지) */
  }
}

function safeRemove(key: string): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* noop */
  }
}

// 수락 시점 기록 — 카카오맵 길안내를 연 직후 main handleAccept 에서 호출한다(fire-and-forget).
// 좌표는 없을 수 있어(그룹/합성 시설) null 허용. 같은 시설을 다시 수락하면 최신 수락 시각으로 덮어쓴다.
export function recordPendingVisit(fac: {
  id: string;
  name?: string;
  type?: string;
  latitude?: number | null;
  longitude?: number | null;
}): void {
  if (!fac || !fac.id) return;
  const pending: PendingVisit = {
    facilityId: String(fac.id),
    name: fac.name ?? '',
    type: fac.type ?? '',
    lat: typeof fac.latitude === 'number' ? fac.latitude : null,
    lng: typeof fac.longitude === 'number' ? fac.longitude : null,
    acceptedAt: Date.now(),
  };
  safeSet(PENDING_KEY, JSON.stringify(pending));
}

export function getPendingVisit(): PendingVisit | null {
  const raw = safeGet(PENDING_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (p && typeof p.facilityId === 'string' && typeof p.acceptedAt === 'number') {
      return p as PendingVisit;
    }
  } catch {
    /* 손상된 값 — 아래에서 null */
  }
  return null;
}

export function clearPendingVisit(): void {
  safeRemove(PENDING_KEY);
}

// 노출 대상 방문 확인 — 대기 중이고(pending) 수락 후 30분이 지났으면 반환, 아니면 null.
// (pending 자체가 '미처리' 마커 — 처리/닫기 시 clearPendingVisit 로 지우므로 별도 플래그가 필요 없다.)
export function getDueVisit(): PendingVisit | null {
  const pending = getPendingVisit();
  if (!pending) return null;
  if (Date.now() - pending.acceptedAt < DUE_AFTER_MS) return null;
  return pending;
}

export function getVisitHistory(): VisitHistoryEntry[] {
  const raw = safeGet(HISTORY_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as VisitHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

// 방문 확인을 '예'로 처리 — 이력 배열에 적립하고 대기(pending)를 클리어한다.
export function completeVisit(entry: {
  facilityId: string;
  name: string;
  type: string;
  rating?: 'up' | 'down' | null;
}): void {
  const history = getVisitHistory();
  history.push({
    facilityId: entry.facilityId,
    name: entry.name,
    type: entry.type,
    visitedAt: Date.now(),
    rating: entry.rating ?? null,
  });
  safeSet(HISTORY_KEY, JSON.stringify(history));
  clearPendingVisit();
}

// 마이페이지 통계용 — 방문 이력 길이(실데이터).
export function getVisitCount(): number {
  return getVisitHistory().length;
}
