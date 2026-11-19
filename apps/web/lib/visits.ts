// 방문 여정 로컬 스토어 — '수락(길안내 시작) → 30분 뒤 다녀오셨나요? 확인 → 방문 이력' 루프.
// 정적 export 앱이라 서버 없이 localStorage 로만 처리한다(무세션 데모에서도 동작). 모든 접근은 방어적:
// 저장이 막힌 환경(시크릿 모드 등)·파싱 실패에서도 예외를 던지지 않고 안전한 기본값으로 수렴한다.
//
// 지역(S3): 대기 방문·진행 중 여정은 **수락한 때의 지역**을 함께 적는다(region). 공개 지역(경주)은 적지 않는다 —
// 경주 저장 모양이 오늘과 같고, 이 변경 전에 저장된 값(region 없음)도 경주로 읽힌다. 화면은 지금 지역과 같은
// 지역의 여정만 보여 준다(visitMatchesRegion) — 내부 지역 여정이 경주 화면에 뜨거나, 그 답이 다른 지역으로 가지 않게.
import { getActiveRegion, isPublicRegion, PUBLIC_REGION_ID } from './regionRuntime';

const PENDING_KEY = 'nextspot_pending_visit';
const HISTORY_KEY = 'nextspot_visit_history';
const ACTIVE_TRIP_KEY = 'nextspot_active_trip';

// 수락 후 이 시간이 지나야 '다녀오셨나요?' 확인을 노출한다(도착·이용에 걸리는 최소 여유).
// 테스트에서 경계값(정확히 30분)을 상수 재입력 없이 검증하려고 export 한다.
export const DUE_AFTER_MS = 30 * 60 * 1000;

export interface PendingVisit {
  facilityId: string;
  name: string;
  type: string;
  lat: number | null;
  lng: number | null;
  acceptedAt: number; // epoch ms
  recommendationId?: string;
  /** 수락한 때의 지역 — 공개 지역(경주)이면 없다(없으면 경주). */
  region?: string;
}

/** 저장된 방문·여정의 지역. 지역이 없으면(경주 또는 이 필드 전에 저장된 값) 공개 지역. */
export function visitRegion(visit: { region?: unknown } | null | undefined): string {
  const region = visit?.region;
  return typeof region === 'string' && region.trim() ? region.trim() : PUBLIC_REGION_ID;
}

/** 저장된 방문·여정이 지금 보는 지역의 것인가. */
export function visitMatchesRegion(visit: { region?: unknown } | null | undefined, regionId: string | null | undefined): boolean {
  return visitRegion(visit) === (isPublicRegion(regionId) ? PUBLIC_REGION_ID : String(regionId));
}

/** 저장할 지역 필드 — 공개 지역이면 빈 조각(저장 모양이 오늘과 같다). */
function regionField(regionId: string): { region?: string } {
  return isPublicRegion(regionId) ? {} : { region: regionId };
}

export interface ActiveTrip extends PendingVisit {
  version: 1;
  recommendationId?: string;
  walkMinutes?: number;
  status: 'navigating' | 'arrived';
  context?: Record<string, unknown>;
  navigationMode?: 'walk' | 'car';
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
    ...regionField(getActiveRegion()),
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

export function recordActiveTrip(fac: {
  id: string; name?: string; type?: string; latitude?: number | null; longitude?: number | null;
}, options?: { recommendationId?: string; walkMinutes?: number; context?: Record<string, unknown>; navigationMode?: 'walk' | 'car' }): void {
  recordPendingVisit(fac);
  const pending = getPendingVisit();
  if (!pending) return;
  safeSet(ACTIVE_TRIP_KEY, JSON.stringify({
    ...pending, version: 1, status: 'navigating',
    recommendationId: options?.recommendationId,
    walkMinutes: options?.walkMinutes,
    context: options?.context,
    navigationMode: options?.navigationMode ?? 'walk',
  } satisfies ActiveTrip));
}

export function getActiveTrip(): ActiveTrip | null {
  const raw = safeGet(ACTIVE_TRIP_KEY);
  if (raw) {
    try {
      const trip = JSON.parse(raw) as ActiveTrip;
      if (trip?.version === 1 && typeof trip.facilityId === 'string') return trip;
    } catch { /* fall through to legacy migration */ }
  }
  const legacy = getPendingVisit();
  if (!legacy) return null;
  const migrated: ActiveTrip = { ...legacy, version: 1, status: 'navigating' };
  safeSet(ACTIVE_TRIP_KEY, JSON.stringify(migrated));
  return migrated;
}

export function markTripArrived(): ActiveTrip | null {
  const trip = getActiveTrip();
  if (!trip) return null;
  const arrived: ActiveTrip = { ...trip, status: 'arrived' };
  safeSet(ACTIVE_TRIP_KEY, JSON.stringify(arrived));
  return arrived;
}

export function markTripNavigating(): ActiveTrip | null {
  const trip = getActiveTrip();
  if (!trip) return null;
  const navigating: ActiveTrip = { ...trip, status: 'navigating' };
  safeSet(ACTIVE_TRIP_KEY, JSON.stringify(navigating));
  return navigating;
}

export function clearActiveTrip(): void { safeRemove(ACTIVE_TRIP_KEY); }

export function clearPendingVisit(): void {
  safeRemove(PENDING_KEY);
}

// '아직이요/닫기' — 방문 확인 루프를 완전히 종료한다(탭을 다시 열어도 재노출 없음).
// 두 키를 반드시 함께 지운다. 한쪽만 지우면 두 카드의 상태가 어긋난다:
//  · PENDING_KEY 만 지우면(= clearPendingVisit 단독) ACTIVE_TRIP_KEY 가 남아
//    ActiveJourneyCard 가 getActiveTrip() 으로 여정을 계속 띄운다 — 사용자는 '다녀왔냐'는
//    물음만 닫았는데 진행 중 여정 카드는 그대로 보게 된다.
//  · ACTIVE_TRIP_KEY 만 지우면 getActiveTrip() 의 legacy 마이그레이션이 남은 pending 을
//    읽어 여정을 되살려 놓는다.
// 다시 수락하면 recordActiveTrip 이 두 키를 새로 써서 새 루프가 시작된다.
export function dismissVisitCheck(): void {
  clearPendingVisit();
  clearActiveTrip();
}

/**
 * 내부 지역에서 수락한 대기 방문 · 여정을 지운다(경주 것은 그대로). 내부 지역을 더는 볼 수 없게 됐을 때(역할 변경 ·
 * 서버 거절 — RegionProvider 의 흔적 지우기) 부른다: 그 기록에는 내부 지역 장소 이름 · 좌표가 들어 있고, 지역이 맞지
 * 않아 화면에도 다시 뜨지 않으니 남겨 둘 이유가 없다. 지웠으면 true.
 */
export function clearInternalRegionVisits(): boolean {
  const rawTrip = safeGet(ACTIVE_TRIP_KEY);
  let tripRegion: string = PUBLIC_REGION_ID;
  if (rawTrip) {
    try { tripRegion = visitRegion(JSON.parse(rawTrip)); } catch { /* 손상된 값 — 지역을 모르면 경주로 본다 */ }
  }
  const internal = !isPublicRegion(visitRegion(getPendingVisit())) || !isPublicRegion(tripRegion);
  if (internal) dismissVisitCheck();
  return internal;
}

// 노출 판정만 떼어낸 순수 함수 — localStorage 와 Date.now() 에 묶여 있으면 경계값
// (정확히 30분, 도착 직후, 아직 이른 시각)을 재현할 수 없다. lib/visits.test.ts 가 직접 검증한다.
export function isVisitCheckDue(
  acceptedAt: number,
  tripStatus: ActiveTrip['status'] | null | undefined,
  now: number,
): boolean {
  // '도착' 을 누른 순간은 30분 대기를 건너뛴다 — 사용자가 이미 현장에 있다고 말한 것이다.
  if (tripStatus === 'arrived') return true;
  return now - acceptedAt >= DUE_AFTER_MS;
}

// 노출 대상 방문 확인 — 대기 중이고(pending) 노출 조건을 만족하면 반환, 아니면 null.
// (pending 자체가 '미처리' 마커 — 확정은 completeVisit, 닫기는 dismissVisitCheck 가
//  지우므로 별도 플래그가 필요 없다.)
// regionId 를 주면 그 지역에서 수락한 방문만 돌려준다(다른 지역의 대기 방문은 지우지 않고 그 지역으로 돌아갈 때까지 둔다).
export function getDueVisit(regionId?: string): PendingVisit | null {
  const pending = getPendingVisit();
  if (!pending) return null;
  if (regionId !== undefined && !visitMatchesRegion(pending, regionId)) return null;
  const active = getActiveTrip();
  if (!isVisitCheckDue(pending.acceptedAt, active?.status, Date.now())) return null;
  return { ...pending, recommendationId: active?.recommendationId };
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
  clearActiveTrip();
}

// 마이페이지 통계용 — 방문 이력 길이(실데이터).
export function getVisitCount(): number {
  return getVisitHistory().length;
}
