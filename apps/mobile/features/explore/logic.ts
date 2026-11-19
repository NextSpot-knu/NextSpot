// 대안 화면(/explore/recommend)의 순수 로직 — 웹 apps/web/app/explore/recommend/page.tsx 에서 화면과 떼어 낸 부분(기준 커밋 0d145a1).
// React·RN 을 import 하지 않는다(node:assert 테스트 대상). 호출(네트워크)은 deps 로 받는다.
import type { CongestionKey } from '@/lib/congestionScale';
import { isWithinRegion, REGION } from '@/lib/region';

import { type RecommendParams, candidateTypesFor, isNamedOrigin, withTopicJosa } from './origin';
import { congestionDisplay, isBaselinePrediction, type CongestionDisplayInput } from './port/congestionEstimate';
import { displayWalkingMinutes } from './port/walking';

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** 대안 화면이 쓰는 추천 응답의 최소 모양(앱 apiClient.RecommendationResponse 가 만족한다). */
export interface AltRec extends CongestionDisplayInput {
  recommendationId: string;
  facility: {
    id: string;
    name: string;
    type: string;
    address?: string | null;
    features?: Record<string, unknown> | null;
  };
  openStatusAtArrival?: string;
  scoringMode?: string | null;
  congestionSource?: string | null;
  congestionPredictionBasis?: string | null;
}

/** by-type 대안 폴백의 대기 상한(웹과 같은 45초 — 미리 데워진 키와 겹치지 않는 차가운 계산이다). */
export const BY_TYPE_FALLBACK_TIMEOUT_MS = 45_000;

/** 합성 추천 id(mock-)는 recommendations 행이 없어 /feedback 이 404 다 — 서버 전송 전에 거른다. */
export function isSyntheticRecommendationId(id: string): boolean {
  return id.startsWith('mock-');
}

/** 추천 사유 폴백 문장 — 혼잡 근거가 없으면 '여유' 라는 혼잡 주장을 지어내지 않는다. */
export function buildFallbackReason(
  t: Translate,
  name: string,
  waitMin: number | null,
  distanceM: number,
  congestionLevel: number | null = null,
): string {
  const walk = displayWalkingMinutes(undefined, distanceM);
  if (congestionLevel === null) {
    return waitMin === null
      ? t('recommend.fallbackTravelOnly', { name, walk })
      : t('recommend.fallbackWithWait', { name, walk, wait: Math.round(waitMin) });
  }
  return waitMin === null
    ? t('recommend.fallbackMeasured', { name, walk })
    : t('recommend.fallbackWithWait', { name, walk, wait: Math.round(waitMin) });
}

/** 문장이 '지금 이만큼 붐빈다' 고 주장해도 되는 값. 아니면 null. 판정은 congestionDisplay 한 곳에서만 한다. */
export function assertableCongestionLevel(rec: CongestionDisplayInput & {
  congestionSource?: string | null;
  scoringMode?: string | null;
  congestionPredictionBasis?: string | null;
}): number | null {
  const display = congestionDisplay(rec);
  if (display.mode === 'predicted' && isBaselinePrediction(rec)) return null;
  return display.mode === 'measured' || display.mode === 'predicted' ? display.level : null;
}

/** 음식점·카페가 도착 때 영업 여부를 모르면 카카오맵 영업시간을 먼저 보여 준다. */
export function needsHoursCheck(rec: Pick<AltRec, 'openStatusAtArrival' | 'facility'>): boolean {
  return (
    rec.openStatusAtArrival === 'needs_confirmation' &&
    (rec.facility.type === 'cafe' || rec.facility.type === 'restaurant')
  );
}

/** 카카오맵 상세 주소 — 저장된 장소 주소 > 장소 id > 이름 검색. */
export function kakaoDetailsUrl(rec: Pick<AltRec, 'facility'>, addressToken = '경주'): string {
  const features = rec.facility.features;
  const placeId = String(features?.kakaoPlaceId ?? features?.kakao_place_id ?? '').trim();
  const storedUrl = String(features?.kakaoPlaceUrl ?? features?.kakao_place_url ?? '').trim();
  if (storedUrl) return storedUrl.replace(/^http:\/\/place\.map\.kakao\.com/i, 'https://place.map.kakao.com');
  if (placeId) return `https://place.map.kakao.com/${placeId}`;
  return `https://map.kakao.com/?q=${encodeURIComponent(`${rec.facility.name} ${rec.facility.address ?? addressToken}`)}`;
}

/** 서비스 지역 밖 위치는 지역 중심으로 옮긴다(웹과 같다). 옮겼는지도 알려 준다. */
export function clampToRegion(lat: number, lng: number): { lat: number; lng: number; moved: boolean } {
  if (isWithinRegion(lat, lng)) return { lat, lng, moved: false };
  return { lat: REGION.center.lat, lng: REGION.center.lng, moved: true };
}

/** 주소 좌표가 있으면 그것, 없으면 지역 중심 — 위치를 알기 전의 첫 좌표. */
export function initialCoords(p: Pick<RecommendParams, 'lat' | 'lng'>): { lat: number; lng: number } {
  return p.lat !== null && p.lng !== null ? { lat: p.lat, lng: p.lng } : { lat: REGION.center.lat, lng: REGION.center.lng };
}

// ── 대안 조회 ────────────────────────────────────────────────────────────────

export interface FetchDeps<R> {
  /** 원래 장소 둘레 개인화 대안(웹 getRecommendations). */
  getRecommendations(candidateTypes: readonly string[]): Promise<R[]>;
  /** 같은 SPOT 엔진의 by-type 경로(웹 byTypeFallback). */
  byType(): Promise<R[]>;
  isTimeout(err: unknown): boolean;
  sleep(ms: number): Promise<void>;
  /** 이 호출이 이미 낡았는가(언마운트·새 요청) — 참이면 즉시 null 로 끝낸다. */
  cancelled(): boolean;
  warn?(message: string, err?: unknown): void;
}

/** 같은 종류부터 묻고 비면 종류 없이 한 번 더 묻는다(웹 fetchAlternatives). DB 에 없는 장소는 처음부터 by-type. */
export async function fetchAlternatives<R>(
  deps: Pick<FetchDeps<R>, 'getRecommendations' | 'byType'>,
  params: Pick<RecommendParams, 'facilityId' | 'name' | 'type'>,
): Promise<R[]> {
  if (isNamedOrigin(params)) return deps.byType();
  const candidateTypes = candidateTypesFor(params.type);
  if (candidateTypes.length > 0) {
    const typed = await deps.getRecommendations(candidateTypes);
    if (typed.length > 0) return typed;
  }
  return deps.getRecommendations([]);
}

/**
 * 첫 조회 한 번의 전체 흐름(웹 checkHistoryAndFetch 의 조회 부분).
 *  · 시간 초과(45초) → 같은 POST 를 다시 보내지 않고 by-type 으로.
 *  · 그 밖의 실패 → 2.5초 뒤 1회 재시도, 또 실패하면 by-type.
 *  · 개인화가 비어 오면 by-type 으로 한 번 더(실패하면 빈 결과 그대로).
 * 취소되면 null. by-type 폴백까지 실패하면 throw — 호출자가 loadFailed 로 말한다.
 */
export async function loadAlternativesFlow<R>(
  deps: FetchDeps<R>,
  params: Pick<RecommendParams, 'facilityId' | 'name' | 'type'>,
): Promise<R[] | null> {
  let list: R[];
  let triedByType = isNamedOrigin(params);
  try {
    list = await fetchAlternatives(deps, params);
  } catch (firstErr) {
    if (deps.cancelled()) return null;
    if (deps.isTimeout(firstErr)) {
      deps.warn?.('추천 시간 초과 — 같은 요청을 다시 보내지 않고 by-type 엔진 폴백', firstErr);
      triedByType = true;
      list = await deps.byType();
    } else {
      deps.warn?.('추천 1차 실패 — 2.5초 후 1회 재시도', firstErr);
      await deps.sleep(2500);
      if (deps.cancelled()) return null;
      try {
        list = await fetchAlternatives(deps, params);
      } catch (secondErr) {
        if (deps.cancelled()) return null;
        deps.warn?.('추천 2차 실패 — by-type 엔진 폴백', secondErr);
        triedByType = true;
        list = await deps.byType();
      }
    }
  }
  if (deps.cancelled()) return null;
  if (list.length === 0 && !triedByType) {
    try {
      list = await deps.byType();
    } catch (fallbackErr) {
      deps.warn?.('빈 추천 뒤 by-type 대안 조회 실패 — 빈 결과로 둔다', fallbackErr);
    }
    if (deps.cancelled()) return null;
  }
  return list;
}

// ── 머리글 ───────────────────────────────────────────────────────────────────

export type OriginGrade = { key: CongestionKey; estimated: boolean } | null;

export function originPillTone(grade: OriginGrade): 'busy' | 'calm' | null {
  if (grade?.key === 'busy') return 'busy';
  return grade?.key === 'quiet' || grade?.key === 'relaxed' ? 'calm' : null;
}

export interface HeaderInput {
  originName: string | null;
  noAlternatives: boolean;
  walkFromPlace: boolean;
  loading: boolean;
  count: number;
}

export type HeaderTitleSpec =
  | { key: 'recommend.heroTitle' }
  | { key: 'literal'; text: string }
  | { key: 'recommend.headerFrom'; vars: { name: string } }
  | { key: 'recommend.headerInstead'; count: number; vars: { name: string; n: number } }
  | { key: 'recommend.headerInsteadPending'; vars: { name: string } };

/** 제목 한 줄이 무엇을 보여 주는지 말한다. 대안이 없으면 결과를 약속하지 않고 이름만. */
export function headerTitleSpec(h: HeaderInput): HeaderTitleSpec {
  if (!h.originName) return { key: 'recommend.heroTitle' };
  if (h.noAlternatives) return { key: 'literal', text: h.originName };
  if (h.walkFromPlace) return { key: 'recommend.headerFrom', vars: { name: h.originName } };
  if (!h.loading && h.count > 0) {
    return { key: 'recommend.headerInstead', count: h.count, vars: { name: h.originName, n: h.count } };
  }
  return { key: 'recommend.headerInsteadPending', vars: { name: h.originName } };
}

export function originSubject(name: string | null, locale: string): string {
  if (!name) return '';
  return locale === 'ko' ? withTopicJosa(name) : name;
}

export function typeLabelKey(type: string): string {
  return type === 'restaurant' || type === 'cafe' || type === 'attraction' || type === 'culture'
    ? `category.${type}`
    : 'course.typeFallback';
}
