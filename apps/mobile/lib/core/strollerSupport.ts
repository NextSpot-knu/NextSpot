// 유모차 조건('stroller', P1-6)의 배포 시차 가드 — 옛 API 가 'stroller' 를 422 로 거절하면 빼고 한 번만 다시 보낸다.
//
// 웹 원본: apps/web/lib/strollerSupport.ts + travelContext.ts isStrollerFriendly (기준 커밋 e07ea61)
// 바꾼 것: `window.sessionStorage` → 전역 sessionStorage(앱 실행 동안만 사는 대역 — lib/sessionStorage.ts).
//          웹 모듈은 window. 와 lib/visits(window.localStorage) 때문에 check:shared 에 걸려 import 하지 못한다.
//          판정 규칙(서버 facility_is_stroller_friendly 미러)은 같다.
import { parseAvailability } from '@/lib/restDate';

const SESSION_KEY = 'nextspot_stroller_unsupported_v1';
let skipsStroller = false;

function sessionStore(): Pick<Storage, 'getItem' | 'setItem'> | null {
  const store = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  return store ?? null;
}

/** 서버 facility_is_stroller_friendly 의 미러(웹 travelContext.isStrollerFriendly). 근거가 없으면 false. */
export function isStrollerFriendly(facility: { features?: Record<string, unknown> | null }): boolean {
  const features = facility.features ?? {};
  if (typeof features.stroller === 'boolean') return features.stroller;
  const raw = features.chk_babycarriage ?? features.chkBabycarriage;
  return parseAvailability(typeof raw === 'string' ? raw : null) === true;
}

export function serverSkipsStroller(): boolean {
  if (skipsStroller) return true;
  try {
    skipsStroller = sessionStore()?.getItem(SESSION_KEY) === '1';
  } catch { /* 저장소 차단 — 메모리만 */ }
  return skipsStroller;
}

export function markServerSkipsStroller(): void {
  skipsStroller = true;
  try { sessionStore()?.setItem(SESSION_KEY, '1'); } catch { /* 메모리만 */ }
}

/** 테스트 전용. */
export function resetStrollerSupportForTest(): void {
  skipsStroller = false;
}

function attributesOf(context: unknown): unknown[] | null {
  if (!context || typeof context !== 'object') return null;
  const attributes = (context as { requiredAttributes?: unknown }).requiredAttributes;
  return Array.isArray(attributes) ? attributes : null;
}

export function asksForStroller(context: unknown): boolean {
  return attributesOf(context)?.includes('stroller') ?? false;
}

export function withoutStrollerContext<T extends { context?: unknown }>(body: T): T {
  const attributes = attributesOf(body.context);
  if (!attributes || !attributes.includes('stroller')) return body;
  return {
    ...body,
    context: {
      ...(body.context as Record<string, unknown>),
      requiredAttributes: attributes.filter((attribute) => attribute !== 'stroller'),
    },
  };
}

export function withoutStrollerAttribute(attributes: unknown): unknown {
  return Array.isArray(attributes) ? attributes.filter((attribute) => attribute !== 'stroller') : attributes;
}

export function keepStrollerFriendly<T extends { facility?: { features?: Record<string, unknown> | null } | null }>(
  items: readonly T[],
): T[] {
  return items.filter((item) => !!item.facility && isStrollerFriendly(item.facility));
}

interface CourseStopLike {
  order: number;
  facility: { id: string; features?: Record<string, unknown> | null };
  alternatives?: { facility: { id: string; features?: Record<string, unknown> | null } }[];
}

interface SlotOutcomeLike {
  order: number;
  status: string;
  facilityId: string | null;
}

/** 코스 — 유모차로 못 가는 정류지를 빼고 그 자리는 '못 채운 자리'(no_candidate_of_type)로 남긴다(웹과 같은 규칙). */
export function keepStrollerFriendlyCourse<S extends CourseStopLike, O extends SlotOutcomeLike>(
  stops: readonly S[],
  outcomes: readonly O[],
): { stops: S[]; outcomes: O[] } {
  const removed = new Set(stops.filter((stop) => !isStrollerFriendly(stop.facility)).map((stop) => String(stop.facility.id)));
  const kept = stops
    .filter((stop) => !removed.has(String(stop.facility.id)))
    .map((stop, index) => ({
      ...stop,
      order: index + 1,
      ...(Array.isArray(stop.alternatives)
        ? { alternatives: stop.alternatives.filter((alternative) => isStrollerFriendly(alternative.facility)) }
        : {}),
    }) as S);
  const nextOutcomes = outcomes.map((outcome) => (
    outcome.facilityId !== null && removed.has(String(outcome.facilityId))
      ? ({ ...outcome, status: 'no_candidate_of_type', facilityId: null } as O)
      : outcome
  ));
  return { stops: kept, outcomes: nextOutcomes };
}
