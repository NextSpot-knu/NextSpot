// 유모차 조건('stroller', P1-6)의 배포 시차 가드.
//
// 웹(Vercel)은 main 에 합쳐지는 순간 뜨고 API(Render)는 사람이 배포해야 뜬다. 그 사이의 옛 API 는 여행 조건의
// required_attributes 에 'stroller' 가 오면 요청 전체를 422 로 거절한다 — 👶 를 켠 사람은 지도 추천이 로컬 폴백으로
// 떨어지고, 대안 화면은 오류, 코스는 실패, 이용 기록(context_applied)도 버려진다. 그래서:
//   · 422 가 오면 'stroller' 를 빼고 **한 번만** 다시 보낸다. 그게 통하면 이 세션은 처음부터 뺀다(sessionStorage).
//     빼도 실패하면 422 의 원인이 유모차가 아니었다 — 표시하지 않고 원래 오류를 그대로 둔다.
//   · 서버가 걸러 주지 못한 유모차 조건은 화면이 같은 판정(isStrollerFriendly — 서버 facility_is_stroller_friendly
//     미러)으로 거른다. 조건을 말없이 버리지 않는다 — 켠 사람에게 유모차로 못 가는 곳을 보여 주지 않는다.
// 새 API 가 뜨면 422 가 오지 않으므로 이 경로는 아무 일도 하지 않는다(새 세션부터 서버가 거른다).

import { isStrollerFriendly } from './travelContext';

const SESSION_KEY = 'nextspot_stroller_unsupported_v1';
let skipsStroller = false;

/** 이 세션의 서버가 'stroller' 조건을 모른다고 이미 확인했는가. */
export function serverSkipsStroller(): boolean {
  if (skipsStroller) return true;
  try {
    skipsStroller = typeof window !== 'undefined' && window.sessionStorage.getItem(SESSION_KEY) === '1';
  } catch { /* 저장소 차단 — 이 탭의 메모리만 쓴다 */ }
  return skipsStroller;
}

export function markServerSkipsStroller(): void {
  skipsStroller = true;
  try { window.sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* 저장소 차단 — 메모리만 */ }
}

/** 테스트 전용 — 모듈 상태를 처음으로 되돌린다. */
export function resetStrollerSupportForTest(): void {
  skipsStroller = false;
}

function attributesOf(context: unknown): unknown[] | null {
  if (!context || typeof context !== 'object') return null;
  const attributes = (context as { requiredAttributes?: unknown }).requiredAttributes;
  return Array.isArray(attributes) ? attributes : null;
}

/** 여행 조건(camelCase)이 유모차를 요구하는가. */
export function asksForStroller(context: unknown): boolean {
  return attributesOf(context)?.includes('stroller') ?? false;
}

/** 요청 본문에서 유모차 조건만 뺀 사본. 본문·조건 객체는 바꾸지 않는다. */
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

/** 이용 기록(context_applied)의 required_attributes 에서 유모차를 뺀다 — 서버가 모르는 세션에서만 부른다. */
export function withoutStrollerAttribute(attributes: unknown): unknown {
  return Array.isArray(attributes) ? attributes.filter((attribute) => attribute !== 'stroller') : attributes;
}

/** 추천 카드 목록 — 서버가 유모차 조건 없이 고른 결과를 같은 판정으로 거른다. */
export function keepStrollerFriendly<T extends { facility?: { features?: Record<string, unknown> | null } | null }>(
  items: readonly T[],
): T[] {
  return items.filter((item) => !!item.facility && isStrollerFriendly(item.facility));
}

interface CourseStopLike {
  order: number;
  facility: { id: string; features?: Record<string, unknown> | null };
  // 서버는 차점 후보에 시설 요약(id·이름·종류·좌표)만 싣는다 — features 가 없으니 유모차 근거도 없다(fail-closed로 빠진다).
  alternatives?: { facility: { id: string; features?: Record<string, unknown> | null } }[];
}

interface SlotOutcomeLike {
  order: number;
  status: string;
  facilityId: string | null;
}

/**
 * 코스 — 유모차로 못 가는 정류지를 빼고, 그 자리는 '못 채운 자리'(no_candidate_of_type)로 남긴다. 목록에서 말없이
 * 사라지면 자리가 왜 빠졌는지 모른다(코스 화면의 DroppedSlotRow 가 '조건을 넓히면…' 을 말한다). 남은 정류지의 방문
 * 순서(order)는 채운 것만으로 1..n 다시 매긴다(서버 응답과 같은 규칙). 갈아끼울 차점 후보도 같은 조건으로 거른다 —
 * 서버가 후보에 features 를 싣지 않아 이 경로(옛 API)에서는 사실상 모두 빠진다. 근거 없는 곳을 유모차 후보로 내밀지 않는다.
 * 뒤 정류지의 도착 시각은 서버가 뺀 정류지를 거쳐 잰 값이라 실제보다 늦게 보일 수 있다 — 이르게 말하지는 않는다.
 */
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
