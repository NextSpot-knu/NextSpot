// 홈이 추천 카드(features/recommendation-card/RecommendationCard)에 넘기는 값을 만드는 순수 함수들.
//
// 웹 /main 은 선택한 시설을 클라이언트 Facility 로 바꿔 카드에 흩어 넘겼다. 앱은 카드가 서버 응답(SheetCandidate)을 직접 읽으므로
// 홈은 '지도 시설 + 서버 추천 항목 + 최신 추정 피드' 를 후보 하나로 합치기만 한다. 네이티브 의존이 없어 node 로 테스트한다(sheetModel.test.ts).
// (파일 이름은 옛 추천 시트 때의 것이다 — H3a 에서 시트 높이 계산(sheetCoverHeight · mapBottomInset)은 지웠다. 카드는 내용 높이다.)
import type { RecommendationResponse } from '~/lib/core/apiClient';
import type { CardFacility, CompareAnchor, SheetCandidate } from '~/features/recommendation-card';
import { anchorNowLevel } from '~/features/recommendation-card/compareHeader';
import { buildSpotComparisons, type SpotComparison, type SpotComparisonCandidate } from '~/features/explore/port/spotComparison';
import { displayWalkingMinutes } from '~/features/explore/port/walking';

import { haversineMeters } from '@/lib/map/geo';
import type { HomeFacility } from './homeModel';

/** 카드를 연 방식 — 웹 FacilityRecord.pickKind(+ 추천 1위로 자동으로 연 것). */
export type PickKind = 'recommended' | 'pin' | 'search' | 'place';

/** {시설 id: 원본 추정} — useFacilities 의 5분 추정 피드(웹 estimateById). */
export type EstimateById = Readonly<Record<string, unknown>>;

/** 지도 시설 → 카드 장소. null 은 undefined 로(카드 필드는 선택 값). */
export function cardFacilityFromHome(f: HomeFacility): CardFacility {
  return {
    id: f.id,
    name: f.name,
    type: f.type,
    latitude: f.latitude,
    longitude: f.longitude,
    capacity: f.capacity ?? undefined,
    features: f.features ?? undefined,
    address: f.address,
    phone: f.phone,
    operatingHours: (f.operatingHours ?? undefined) as CardFacility['operatingHours'],
    imageUrl: f.imageUrl,
    galleryImages: f.galleryImages,
    homepage: f.homepage,
    overview: f.overview,
    barrierFree: f.barrierFree,
    currentCount: f.currentCount,
    congestionLevel: f.congestionLevel ?? undefined,
    contentid: f.contentid,
    contenttypeid: f.contenttypeid,
  };
}

/**
 * 선택한 장소의 카드 후보. 보이는 추천 목록에 있고 직접 고른 게 아니면 서버 응답 그대로(순위 배지),
 * 검색·'place' 로 직접 골랐거나 목록 밖이면 userPicked(= '선택한 장소', '대신 갈 곳 보기').
 * 서버 항목이 있으면 사유·SPOT 은 그대로 싣는다(웹 recToSpot).
 * 혼잡 추정은 추정 피드의 **최신** 값이 응답 속 값을 이긴다(웹 page.tsx 4885-4889 — `estimateById[id] ?? 응답 값`, G3-13).
 * 목록 밖 장소도 같다.
 */
export function buildSelectedCandidate(
  facility: HomeFacility,
  kind: PickKind,
  visibleRecs: readonly RecommendationResponse[],
  origin: { lat: number; lng: number },
  estimateById: EstimateById = {},
): SheetCandidate {
  const rec = visibleRecs.find((r) => r.facility.id === facility.id);
  const fresh = estimateById[facility.id] as RecommendationResponse['congestionEstimate'] | undefined;
  const withEstimate = <T extends SheetCandidate>(c: T): T => (fresh ? { ...c, congestionEstimate: fresh } : c);
  const forced = kind === 'search' || kind === 'place';
  if (rec && !forced) return withEstimate(rec);
  const place = cardFacilityFromHome(facility);
  if (rec) return withEstimate({ ...rec, facility: { ...rec.facility, ...place }, userPicked: true });
  // 목록 밖이면 서버 거리·도보 분이 없다 — 기준점에서 직선거리를 채워 카드가 도보 분을 추정하게 한다(웹 scoreFacility).
  return withEstimate({ facility: place, userPicked: true, distanceM: haversineMeters(origin.lat, origin.lng, facility.latitude, facility.longitude) });
}

/**
 * 비교 헤더의 기준 명소('A 대신 B', G3-13) — 웹 anchorContextFor(page.tsx 2624-2655)의 테마 없는 경우.
 * 이름 = 관광 근거의 referenceName, 등급 = 그 명소 시설 자신의 '지금' 혼잡(anchorNowLevel — 카드가 후보를 칠하는 규칙과 같다,
 * 추정은 피드 최신값 우선), 거리 = 서버가 준 관광 근거 거리. 이름이 없으면 null(카드는 혜택 문장으로).
 * 가정 시각(+N·프리셋, timeShifted)이면 '지금' 등급은 그 시각의 값이 아니라 쓰지 않는다(웹 assumedPreset === 'now' && cardHours === 0).
 * ✨ 경주 테마(F2)가 켜지면 discovery/discoveryModel 의 discoveryCompareAnchor 가 대신한다.
 */
export function compareAnchorFor(
  candidate: SheetCandidate | null,
  facilities: readonly HomeFacility[],
  estimateById: EstimateById = {},
  now: Date = new Date(),
  timeShifted = false,
): CompareAnchor | null {
  const tourism = candidate?.breakdown?.areaDemandTourismEvidence;
  const name = tourism?.referenceName ?? null;
  if (!name) return null;
  const anchor = facilities.find((f) => f.name === name);
  const level = anchor && !timeShifted
    ? anchorNowLevel(
        {
          congestionLevel: anchor.congestionLevel,
          congestionSource: null,
          congestionIsCurrent: anchor.congestionIsCurrent,
          congestionTimestamp: anchor.lastUpdated,
          congestionEstimate: estimateById[anchor.id] ?? null,
        },
        now,
      )
    : null;
  return { name, distanceM: tourism?.distanceM ?? null, level };
}

/**
 * 보이는 상위 3곳을 1위와 비교할 재료(웹 spotComparisonById, page.tsx 1118-1144) — 시설 id 별.
 * 문장은 HomeScreen 이 formatSpotComparison(t, …) 으로 만든다(문구는 화면 몫). 거절·저장은 visibleRecs 에서 이미 빠졌다.
 */
export function spotComparisonsById(visibleRecs: readonly RecommendationResponse[]): Map<string, SpotComparison> {
  const top: SpotComparisonCandidate[] = visibleRecs.slice(0, 3).map((r, index) => ({
    id: String(r.facility.id),
    rank: index + 1,
    preference: r.breakdown?.preference ?? 0,
    travelMinutes: typeof r.breakdown?.travelTime === 'number' ? r.breakdown.travelTime : displayWalkingMinutes(undefined, r.distanceM),
    scoringMode: r.scoringMode,
    rankingWaitMinutes: r.breakdown?.rankingWaitTime ?? r.breakdown?.waitTime,
    areaDemandPenaltyMinutes: r.breakdown?.areaDemandPenaltyMinutes,
    areaDemandParkingEvidence: r.breakdown?.areaDemandParkingEvidence,
    areaDemandTourismEvidence: r.breakdown?.areaDemandTourismEvidence,
    couponRate: r.facility.couponRate,
  }));
  return new Map(buildSpotComparisons(top).map((c) => [c.id, c]));
}

/**
 * 카드의 '추천 이유'(1위 대비) — 비교 문장의 순위가 카드의 목록 순위와 같을 때만(웹 :4788-4791, I05 j).
 * 직접 고른 곳(userPicked)은 목록 순위가 없어 넘기지 않는다.
 */
export function comparisonFor<T extends { rank: number }>(
  comparisons: ReadonlyMap<string, T>,
  candidate: SheetCandidate | null,
  visibleRecs: readonly RecommendationResponse[],
): T | null {
  if (!candidate || candidate.userPicked) return null;
  const id = String(candidate.facility.id);
  const index = visibleRecs.findIndex((r) => String(r.facility.id) === id);
  const comparison = comparisons.get(id);
  return comparison && index >= 0 && comparison.rank === index + 1 ? comparison : null;
}

export type CardStatus = 'ready' | 'loading' | 'error';

/**
 * 카드 자리의 상태 — 고른 장소가 없고 검색 중이 아닐 때만 의미가 있다.
 *  - loading: 시설은 있는데 추천이 아직 오지 않았다(웹 '첫 추천 고르는 중' 스켈레톤, G3-25).
 *  - error: 추천 요청이 실패했다(G3-26 — 화면 안 SPOT 미러로 점수를 지어내지 않고 같은 자리의 오류 판 + 다시 시도).
 * 0곳(서버가 빈 목록)은 ready — 제안 상자(G3-27)가 맡는다.
 */
export function cardStatus(opts: {
  hasFacilities: boolean;
  recsLoaded: boolean;
  recsFailed: boolean;
  hasSelection: boolean;
  searching: boolean;
}): CardStatus {
  if (!opts.hasFacilities || opts.hasSelection || opts.searching) return 'ready';
  if (opts.recsFailed) return 'error';
  return opts.recsLoaded ? 'ready' : 'loading';
}
