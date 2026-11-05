// 여정 루프 — '수락(길안내 시작) → 도착 확인 → 방문 확인(혼잡 → 👍/👎) → 방문 이력'의 저장과 상태 기계.
//
// 웹 원본: apps/web/lib/visits.ts(기준 커밋 0d145a1). window.localStorage 를 쓰는 웹 파일은 check:shared 에 걸려 다시 썼다.
// 같은 것: 저장 키 3개(nextspot_pending_visit · nextspot_visit_history · nextspot_active_trip) · 값 모양 · 30분 규칙 · 두 키를 함께 지우는 dismiss.
// 다른 것: 전역 localStorage(expo-sqlite) · 지역 필드 없음(앱 v1 은 경주만 — 웹이 쓴 region 이 붙은 값이 있어도 무시하고 읽는다)
//   · window 이벤트 대신 tripEvents.
// 저장소는 인자로 받는다(기본 전역 localStorage) — 테스트는 메모리 대역을 넣는다.
import type { ObservedCongestion, OutcomeRating } from '~/lib/core/recommendationOutcomes';
import { createEmitter } from '~/lib/core/events';

const PENDING_KEY = 'nextspot_pending_visit';
const HISTORY_KEY = 'nextspot_visit_history';
const ACTIVE_TRIP_KEY = 'nextspot_active_trip';

/** 수락 후 이 시간이 지나야 '다녀오셨나요?' 를 묻는다. */
export const DUE_AFTER_MS = 30 * 60 * 1000;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PendingVisit {
  facilityId: string;
  name: string;
  type: string;
  lat: number | null;
  lng: number | null;
  acceptedAt: number;
  recommendationId?: string;
}

export interface ActiveTrip extends PendingVisit {
  version: 1;
  walkMinutes?: number;
  status: 'navigating' | 'arrived';
  context?: Record<string, unknown>;
  navigationMode?: 'walk' | 'car';
}

export interface VisitHistoryEntry {
  facilityId: string;
  name: string;
  type: string;
  visitedAt: number;
  rating: OutcomeRating | null;
}

/**
 * 여정이 바뀌었다는 알림(웹 'nextspot:trip-navigating' · 'nextspot:trip-arrived'). 카드들이 저장소를 다시 읽는다.
 * 'trip-cleared' 는 앱 전용 — 방문 확인을 끝까지 마쳐(completeVisit) 여정이 지워졌다. 진행 중 여행 카드만 듣는다
 * (방문 확인 카드는 '고마워요' 단계를 보여 주는 중이라 다시 읽으면 안 된다).
 */
export const tripEvents = createEmitter<{ 'trip-navigating': undefined; 'trip-arrived': undefined; 'trip-cleared': undefined }>();

function defaultStore(): KeyValueStore | null {
  try {
    return (globalThis as { localStorage?: KeyValueStore }).localStorage ?? null;
  } catch {
    return null;
  }
}

function safeGet(store: KeyValueStore | null, key: string): string | null {
  try { return store?.getItem(key) ?? null; } catch { return null; }
}
function safeSet(store: KeyValueStore | null, key: string, value: string): void {
  try { store?.setItem(key, value); } catch { /* 저장이 막혀도 여정을 막지 않는다 */ }
}
function safeRemove(store: KeyValueStore | null, key: string): void {
  try { store?.removeItem(key); } catch { /* 무시 */ }
}

export interface TripFacility {
  id: string;
  name?: string;
  type?: string;
  latitude?: number | null;
  longitude?: number | null;
}

export function recordPendingVisit(fac: TripFacility, now = Date.now(), store = defaultStore()): void {
  if (!fac || !fac.id) return;
  const pending: PendingVisit = {
    facilityId: String(fac.id),
    name: fac.name ?? '',
    type: fac.type ?? '',
    lat: typeof fac.latitude === 'number' ? fac.latitude : null,
    lng: typeof fac.longitude === 'number' ? fac.longitude : null,
    acceptedAt: now,
  };
  safeSet(store, PENDING_KEY, JSON.stringify(pending));
}

export function getPendingVisit(store = defaultStore()): PendingVisit | null {
  const raw = safeGet(store, PENDING_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (p && typeof p.facilityId === 'string' && typeof p.acceptedAt === 'number') return p as PendingVisit;
  } catch { /* 손상된 값 */ }
  return null;
}

export function recordActiveTrip(
  fac: TripFacility,
  options?: { recommendationId?: string; walkMinutes?: number; context?: Record<string, unknown>; navigationMode?: 'walk' | 'car' },
  now = Date.now(),
  store = defaultStore(),
): void {
  recordPendingVisit(fac, now, store);
  const pending = getPendingVisit(store);
  if (!pending) return;
  const trip: ActiveTrip = {
    ...pending,
    version: 1,
    status: 'navigating',
    recommendationId: options?.recommendationId,
    walkMinutes: options?.walkMinutes,
    context: options?.context,
    navigationMode: options?.navigationMode ?? 'walk',
  };
  safeSet(store, ACTIVE_TRIP_KEY, JSON.stringify(trip));
  tripEvents.emit('trip-navigating', undefined);
}

export function getActiveTrip(store = defaultStore()): ActiveTrip | null {
  const raw = safeGet(store, ACTIVE_TRIP_KEY);
  if (raw) {
    try {
      const trip = JSON.parse(raw) as ActiveTrip;
      if (trip?.version === 1 && typeof trip.facilityId === 'string') return trip;
    } catch { /* 옛 값으로 이어간다 */ }
  }
  const legacy = getPendingVisit(store);
  if (!legacy) return null;
  const migrated: ActiveTrip = { ...legacy, version: 1, status: 'navigating' };
  safeSet(store, ACTIVE_TRIP_KEY, JSON.stringify(migrated));
  return migrated;
}

export function markTripArrived(store = defaultStore()): ActiveTrip | null {
  const trip = getActiveTrip(store);
  if (!trip) return null;
  const arrived: ActiveTrip = { ...trip, status: 'arrived' };
  safeSet(store, ACTIVE_TRIP_KEY, JSON.stringify(arrived));
  return arrived;
}

/**
 * '도착했어요' — 저장된 여정이 지금 카드가 보여 주는 바로 그 여정(같은 장소 · 같은 수락 시각)이고 아직 길안내 중일 때만
 * 도착으로 바꾼다. 아니면(이미 방문 확인으로 끝났거나 다른 여정으로 바뀜) 아무것도 바꾸지 않고 null — 화면은 도착 결과 보고를
 * 다시 보내지 않고 카드를 다시 읽는다.
 */
export function markTripArrivedIf(
  expected: { facilityId: string; acceptedAt: number },
  store = defaultStore(),
): ActiveTrip | null {
  const raw = safeGet(store, ACTIVE_TRIP_KEY);
  if (!raw) return null;
  let trip: ActiveTrip;
  try { trip = JSON.parse(raw) as ActiveTrip; } catch { return null; }
  if (trip?.version !== 1 || trip.status !== 'navigating') return null;
  if (trip.facilityId !== expected.facilityId || trip.acceptedAt !== expected.acceptedAt) return null;
  return markTripArrived(store);
}

export function clearActiveTrip(store = defaultStore()): void {
  safeRemove(store, ACTIVE_TRIP_KEY);
}

export function clearPendingVisit(store = defaultStore()): void {
  safeRemove(store, PENDING_KEY);
}

/** '아직이요/닫기' — 두 키를 반드시 함께 지운다(한쪽만 지우면 두 카드의 상태가 어긋난다. 웹 visits.ts 주석 참고). */
export function dismissVisitCheck(store = defaultStore()): void {
  clearPendingVisit(store);
  clearActiveTrip(store);
}

/** 노출 판정만 뗀 순수 함수 — '도착' 을 누른 여정은 30분 대기를 건너뛴다. */
export function isVisitCheckDue(acceptedAt: number, tripStatus: ActiveTrip['status'] | null | undefined, now: number): boolean {
  if (tripStatus === 'arrived') return true;
  return now - acceptedAt >= DUE_AFTER_MS;
}

export function getDueVisit(now = Date.now(), store = defaultStore()): PendingVisit | null {
  const pending = getPendingVisit(store);
  if (!pending) return null;
  const active = getActiveTrip(store);
  if (!isVisitCheckDue(pending.acceptedAt, active?.status, now)) return null;
  return { ...pending, recommendationId: active?.recommendationId };
}

export function getVisitHistory(store = defaultStore()): VisitHistoryEntry[] {
  const raw = safeGet(store, HISTORY_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as VisitHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function completeVisit(
  entry: { facilityId: string; name: string; type: string; rating?: OutcomeRating | null },
  now = Date.now(),
  store = defaultStore(),
): void {
  const history = getVisitHistory(store);
  history.push({ facilityId: entry.facilityId, name: entry.name, type: entry.type, visitedAt: now, rating: entry.rating ?? null });
  safeSet(store, HISTORY_KEY, JSON.stringify(history));
  clearPendingVisit(store);
  clearActiveTrip(store);
  tripEvents.emit('trip-cleared', undefined);
}

// ── 방문 확인 단계 기계 ────────────────────────────────────────────────────────

export type VisitStage = 'ask' | 'congestion' | 'feedback' | 'completed';
export type VisitEvent = 'confirm' | 'pick_congestion' | 'skip_congestion' | 'rate';

/** 혼잡 제보가 꺼진 지역은 혼잡 단계를 건너뛴다(앱 v1 은 경주만이라 항상 true — 웹 규칙을 그대로 둔다). */
export function visitSteps(asksCrowd: boolean): readonly VisitStage[] {
  return asksCrowd ? ['ask', 'congestion', 'feedback'] : ['ask', 'feedback'];
}

export function nextVisitStage(stage: VisitStage, event: VisitEvent, asksCrowd: boolean): VisitStage {
  if (stage === 'ask' && event === 'confirm') return asksCrowd ? 'congestion' : 'feedback';
  if (stage === 'congestion' && (event === 'pick_congestion' || event === 'skip_congestion')) return 'feedback';
  if (stage === 'feedback' && event === 'rate') return 'completed';
  return stage;
}

/** 체감 혼잡·평가를 서버 결과 보고(rated)의 필드로. 혼잡 제보가 꺼진 지역에서는 남은 값도 싣지 않는다. */
export function ratedOutcomeFields(
  rating: OutcomeRating,
  observed: ObservedCongestion | null,
  asksCrowd: boolean,
): { rating: OutcomeRating; observedCongestion?: ObservedCongestion } {
  const answer = asksCrowd ? observed : null;
  return answer ? { rating, observedCongestion: answer } : { rating };
}

/** 게스트(익명 세션) 판정 — 계정을 아직 모르면(조회 전·실패) 게스트로 본다. 과장보다 덜 말하는 쪽이다. */
export function isGuestAccount(account: { isAnonymous?: boolean } | null | undefined): boolean {
  return !account || account.isAnonymous === true;
}

/** 이 장소의 혼잡 제보 라벨(서버 계약은 한국어 3값) → 카드가 바로 그리는 혼잡도. 웹 RecommendationCard 의 setLocalReport 와 같은 값. */
export type ReportLevel = '한산' | '보통' | '혼잡';
export function localReportLevel(level: ReportLevel): number {
  return level === '한산' ? 0.2 : level === '보통' ? 0.5 : 0.8;
}
