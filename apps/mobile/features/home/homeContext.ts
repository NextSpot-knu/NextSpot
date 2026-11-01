// 홈 추천 요청에 싣는 조건 — 첫 설정(nextspot_setup_prefs)과 홈 칩을 합친다. 순수 모듈(테스트: homeContext.test.ts).
//
// 웹 원본(기준 커밋 0d145a1): apps/web/app/main/page.tsx ~1437-1464(첫 칩 · 음식 의도), ~2049(chipCandidates/rankContext),
// ~2155-2171(by-type 에 [...rejectedIds, ...savedIds] · 0곳이면 relaxWalkLimit 로 한 번 더), 거절 id 세션 보관
// (sessionStorage nextspot_rejected_ids). apps/web/lib/travelContext.ts 의 CUISINE_INTENT · chipRankingContext · relaxWalkLimit.
// 웹 lib/travelContext 는 lib/visits(window)를 끌고 와 check:shared 에 걸린다 — 필요한 부분만 다시 썼다(PORTING.md).
import type { CuisinePreference, PlaceCategory, RequiredAttribute, TravelContext } from '~/lib/core/travelContextTypes';

import { CATEGORIES } from './homeModel';

/** 이번 세션에 '다시 안 볼래요' 한 장소 — 웹과 같은 키(sessionStorage). */
export const REJECTED_IDS_KEY = 'nextspot_rejected_ids';

/** 첫 설정의 음식 취향 → 추천 점수에 넘길 의도 문자열(웹 CUISINE_INTENT 와 같다). */
export const CUISINE_INTENT: Record<CuisinePreference, string> = {
  '한식': '한식',
  '분식·국밥': '분식 국밥 김밥',
  '양식': '양식',
  '카페·디저트': '카페 디저트',
};

export interface HomeFilterSeed {
  category: PlaceCategory;
  accessible: boolean;
  stroller: boolean;
  indoor: boolean;
}

/** 홈에 처음 들어올 때의 칩 — 첫 설정에서 고른 첫 장소 유형(없으면 음식점)과 꼭 맞아야 하는 조건. */
export function homeFilterSeed(stored: TravelContext): HomeFilterSeed {
  const first = stored.categories.find((c) => (CATEGORIES as readonly string[]).includes(c));
  const attrs = new Set(stored.requiredAttributes);
  return {
    category: first ?? 'restaurant',
    accessible: attrs.has('accessible'),
    stroller: attrs.has('stroller'),
    indoor: attrs.has('indoor'),
  };
}

/**
 * 서버에 보낼 조건 — 저장된 도보·여행 시간·음식·방문 제외는 그대로, 꼭 맞아야 하는 조건은 지금 칩 상태로(칩은 첫 설정으로
 * 시작하고 사용자가 끌 수 있다). 칩이 이미 유형을 정했으므로 categories 는 비운다(웹 chipRankingContext).
 */
export function homeRequestContext(
  stored: TravelContext,
  chips: { accessible: boolean; stroller: boolean; indoor: boolean },
): TravelContext {
  const requiredAttributes: RequiredAttribute[] = [];
  if (chips.accessible) requiredAttributes.push('accessible');
  if (chips.stroller) requiredAttributes.push('stroller');
  if (chips.indoor) requiredAttributes.push('indoor');
  return { ...stored, categories: [], requiredAttributes };
}

/** 도보 제한이 0곳을 만들었을 때 한 번만 넓혀 볼 조건. 도보 제한을 고르지 않았으면 null(웹 relaxWalkLimit). */
export function relaxWalkLimit(context: TravelContext): TravelContext | null {
  if (context.maxWalkMinutes === undefined) return null;
  const { maxWalkMinutes: _dropped, ...rest } = context;
  return rest;
}

/** 첫 설정 음식 취향의 의도 문자열. 고르지 않았으면 null — 의도를 지어내지 않는다. */
export function cuisineIntentOf(stored: TravelContext): string | null {
  return stored.cuisine ? CUISINE_INTENT[stored.cuisine] ?? null : null;
}

/** 서버에서 빼 달라고 보낼 id — 이번 세션 거절 + 저장(킵)한 곳. 웹 `[...rejectedIds, ...savedIds]`(중복은 한 번). */
export function buildExcludeIds(rejected: Iterable<string>, saved: Iterable<string>): string[] {
  return [...new Set([...rejected, ...saved])];
}

/** 세션 저장소의 거절 id 를 읽는다. 모양이 틀리면 빈 집합. */
export function parseRejectedIds(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const v: unknown = JSON.parse(raw);
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function serializeRejectedIds(ids: Iterable<string>): string {
  return JSON.stringify([...ids]);
}
