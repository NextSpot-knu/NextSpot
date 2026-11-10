// 홈이 추천 카드 시트(features/recommendation-card)에 넘기는 값을 만드는 순수 함수들.
//
// 웹 /main 은 선택한 시설을 클라이언트 Facility 로 바꿔 카드에 흩어 넘겼다. 앱은 시트가 서버 응답(SheetCandidate)을 직접 읽으므로
// 홈은 '지도 시설 + 서버 추천 항목' 을 후보 하나로 합치기만 한다. 네이티브 의존이 없어 node 로 테스트한다(sheetModel.test.ts).
import type { RecommendationResponse } from '~/lib/core/apiClient';
import type { CardFacility, SheetCandidate } from '~/features/recommendation-card';

import { haversineMeters } from '@/lib/map/geo';
import type { HomeFacility } from './homeModel';

/** 카드를 연 방식 — 웹 FacilityRecord.pickKind(+ 추천 1위로 자동으로 연 것). */
export type PickKind = 'recommended' | 'pin' | 'search' | 'place';

/** 시트의 세 높이 이름(components/ui Sheet 의 SheetState 와 같다). */
export type SheetHeightState = 'minimized' | 'normal' | 'expanded';

/**
 * RecommendationSheet 의 스냅(27% · 52% · 90%)과 같은 비율. 가장 낮은 높이는 시트가 머리 + 첫 행동 줄을 재서 px 로 바꾸므로
 * (onPeekHeightChange) 그 값을 받았으면 minimized 비율 대신 그것을 쓴다 — sheetCoverHeight.
 */
export const SHEET_SNAP_RATIO: Record<SheetHeightState, number> = { minimized: 0.27, normal: 0.52, expanded: 0.9 };

/** 펼친 높이로 지도를 밀어 올리면 핀이 화면 밖으로 나간다 — 지도 가려진 띠는 '기본' 높이까지만 반영한다. */
const MAP_INSET_CAP = SHEET_SNAP_RATIO.normal;

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
 * 선택한 장소의 시트 후보. 보이는 추천 목록에 있고 직접 고른 게 아니면 서버 응답 그대로(순위 배지),
 * 검색·'place' 로 직접 골랐거나 목록 밖이면 userPicked(= '선택한 장소', '대신 갈 곳 보기').
 * 서버 항목이 있으면 사유·SPOT 은 그대로 싣는다(웹 recToSpot).
 */
export function buildSelectedCandidate(
  facility: HomeFacility,
  kind: PickKind,
  visibleRecs: readonly RecommendationResponse[],
  origin: { lat: number; lng: number },
): SheetCandidate {
  const rec = visibleRecs.find((r) => r.facility.id === facility.id);
  const forced = kind === 'search' || kind === 'place';
  if (rec && !forced) return rec;
  const place = cardFacilityFromHome(facility);
  if (rec) return { ...rec, facility: { ...rec.facility, ...place }, userPicked: true };
  // 목록 밖이면 서버 거리·도보 분이 없다 — 기준점에서 직선거리를 채워 카드가 도보 분을 추정하게 한다(웹 scoreFacility).
  return { facility: place, userPicked: true, distanceM: haversineMeters(origin.lat, origin.lng, facility.latitude, facility.longitude) };
}

export type SheetStatus = 'ready' | 'loading';

/** 시트가 로딩 판을 그릴 때 — 시설은 있는데 추천이 아직 오지 않았고 고른 것도 검색 중도 아닐 때(웹 '첫 추천 고르는 중'). */
export function sheetStatus(opts: { hasFacilities: boolean; recsLoaded: boolean; hasSelection: boolean; searching: boolean }): SheetStatus {
  return opts.hasFacilities && !opts.recsLoaded && !opts.hasSelection && !opts.searching ? 'loading' : 'ready';
}

/**
 * 시트가 지금 높이에서 아래를 가리는 두께(pt). 가장 낮은 높이는 시트가 잰 값(peekPx)이 있으면 그것, 없으면 27% 비율.
 */
export function sheetCoverHeight(state: SheetHeightState, containerHeight: number, peekPx?: number | null): number {
  if (!(containerHeight > 0)) return 0;
  if (state === 'minimized' && typeof peekPx === 'number' && peekPx > 0) return Math.round(Math.min(peekPx, containerHeight * MAP_INSET_CAP));
  return Math.round(containerHeight * SHEET_SNAP_RATIO[state]);
}

/**
 * 시트 높이 상태 → 지도 아래 가려진 띠(pt). 시트가 없으면 `idle`. 컨테이너 높이를 모르면 폴백. 펼침은 기본 높이까지만.
 */
export function mapBottomInset(
  state: SheetHeightState | null,
  containerHeight: number,
  fallback: number,
  idle = 16,
  peekPx?: number | null,
): number {
  if (state === null) return idle;
  if (!(containerHeight > 0)) return fallback;
  const capped: SheetHeightState = state === 'expanded' ? 'normal' : state;
  return sheetCoverHeight(capped, containerHeight, peekPx) + 16;
}
