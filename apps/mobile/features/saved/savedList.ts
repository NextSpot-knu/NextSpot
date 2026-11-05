// 저장 목록의 순수 로직 — 웹 apps/web/app/saved/page.tsx 의 정렬·분류·타임라인 계산·상세 카드 입력 만들기를 React 없이 옮겼다
// (테스트: savedList.test.ts). 저장소(로컬 + Supabase 동기화)는 lib/core/savedFacilities.
import type { SheetCandidate } from '~/features/recommendation-card';
import { displayWalkingMinutes } from '~/features/waiting/boardData';

/** 저장 당시의 Spot 중 목록이 읽는 필드(웹 lib/recommender.ts Spot 의 부분). */
export interface SavedSpot {
  score: number;
  timeToService: number;
  preferencePercent: number;
  expectedTravel: number;
}

export interface SavedBookmark {
  id: string;
  name: string;
  /** 저장 당시 한국어 라벨('음식점'|'카페'|'관광지'|'문화시설') — 표시는 category.* 키로 번역한다. */
  category: string;
  /** unknown = 저장 시점에 혼잡 근거 없음 — '한산(blue)'으로 합성하지 않는다. */
  trafficStatus: 'orange' | 'yellow' | 'green' | 'blue' | 'unknown';
  waitTime: string | null;
  waitEvidence?: 'verified_model';
  congestionLevel?: number | null;
  latitude?: number;
  longitude?: number;
  address?: string | null;
  phone?: string | null;
  features?: Record<string, unknown> | null;
  spot?: SavedSpot;
  reason?: string;
  /** 저장 당시의 실제 recommendations 행 id(있을 때만). */
  recommendationId?: string;
}

/** 저장된 카테고리(한국어 라벨) → i18n category 키. */
export const CATEGORY_LABEL_TO_KEY: Record<string, string> = {
  음식점: 'restaurant',
  카페: 'cafe',
  관광지: 'attraction',
  문화시설: 'culture',
};

export type FacilityKind = 'restaurant' | 'cafe' | 'attraction' | 'culture';

/** 라벨 → 시설 종류. 모르는 라벨은 restaurant(웹과 같다). */
export function facilityTypeOf(category: string): FacilityKind {
  return (CATEGORY_LABEL_TO_KEY[category] as FacilityKind | undefined) ?? 'restaurant';
}

/** 점수 높은 순 → 이용까지 짧은 순 → 선호 높은 순 → 이동 짧은 순 → 이름. spot 이 없으면 이름. */
export function compareBookmarks(a: SavedBookmark, b: SavedBookmark): number {
  if (!a.spot || !b.spot) return (a.name || '').localeCompare(b.name || '', 'ko-KR');
  if (b.spot.score !== a.spot.score) return b.spot.score - a.spot.score;
  if (a.spot.timeToService !== b.spot.timeToService) return a.spot.timeToService - b.spot.timeToService;
  if (b.spot.preferencePercent !== a.spot.preferencePercent) return b.spot.preferencePercent - a.spot.preferencePercent;
  if (a.spot.expectedTravel !== b.spot.expectedTravel) return a.spot.expectedTravel - b.spot.expectedTravel;
  return (a.name || '').localeCompare(b.name || '', 'ko-KR');
}

export function sortBookmarks(list: readonly SavedBookmark[]): SavedBookmark[] {
  return [...list].sort(compareBookmarks);
}

/** 서버에 기록된 실제 추천만 피드백 대상 — mock-(데모 폴백)은 DB 행이 없어 404 다. */
export function isRealRecommendationId(id: string | undefined): id is string {
  return !!id && !id.startsWith('mock-');
}

export interface CategoryView {
  counts: Record<string, number>;
  /** 저장이 있는 분류만(칩 노출용). */
  available: string[];
  /** 선택했던 분류가 삭제로 0 이 되면 '전체'로 복귀. */
  effective: string;
  visible: SavedBookmark[];
}

export function categoryView(bookmarks: readonly SavedBookmark[], active: string): CategoryView {
  const counts = bookmarks.reduce<Record<string, number>>((acc, b) => {
    acc[b.category] = (acc[b.category] || 0) + 1;
    return acc;
  }, {});
  const available = Object.keys(CATEGORY_LABEL_TO_KEY).filter((c) => counts[c]);
  const effective = active !== 'all' && !counts[active] ? 'all' : active;
  const visible = effective === 'all' ? [...bookmarks] : bookmarks.filter((b) => b.category === effective);
  return { counts, available, effective, visible };
}

export interface Timeline {
  travelMins: number;
  waitMins: number | null;
  /** 이동 + 대기(분). */
  timeToService: number;
  arrival: Date;
  /** 대기를 검증 모델이 냈을 때만(없으면 이용 시작 시각을 지어내지 않는다). */
  service: Date | null;
}

/** 지금 출발했을 때의 출발·도착·이용 시각. 대기는 검증 모델(waitEvidence)이 낸 분만 쓴다. */
export function timelineOf(bookmark: SavedBookmark, now: Date): Timeline {
  const travelMins = bookmark.spot?.expectedTravel ?? 0;
  const verified = bookmark.waitEvidence === 'verified_model';
  const parsed = bookmark.waitTime ? Number.parseFloat(bookmark.waitTime) : Number.NaN;
  const waitMins = verified && Number.isFinite(parsed) ? parsed : null;
  const arrival = new Date(now.getTime() + travelMins * 60000);
  return {
    travelMins,
    waitMins,
    timeToService: travelMins + (waitMins ?? 0),
    arrival,
    service: waitMins !== null ? new Date(arrival.getTime() + waitMins * 60000) : null,
  };
}

/** 'HH:MM'(24시간). */
export function clockText(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 혼잡 신호등 → 글자 키(색만으로 구분하지 않는다). 근거 없는 카드(unknown)는 null. */
export function trafficLabelKey(status: SavedBookmark['trafficStatus']): 'congestion.busy' | 'congestion.moderate' | 'congestion.relaxed' | 'congestion.quiet' | null {
  switch (status) {
    case 'orange': return 'congestion.busy';
    case 'yellow': return 'congestion.moderate';
    case 'green': return 'congestion.relaxed';
    case 'blue': return 'congestion.quiet';
    default: return null;
  }
}

/**
 * 상세 카드(추천 카드 시트)가 받는 값 — 웹 saved/page.tsx 가 RecommendationCard 에 넘기던 props 와 같다.
 * reason 은 화면이 번역해 넘긴다(t('recommend.fallbackTravelOnly', { name, walk })) — walk 는 여기서 계산.
 */
export interface SavedCardInput {
  title: string;
  matchPercentage: number;
  walkMinutes: number;
  spotScore?: number;
  preferencePercent?: number;
  expectedWait?: number;
  expectedTravel: number;
  timeToService: number;
  facilityType: FacilityKind;
  facility: {
    id: string;
    name: string;
    latitude: number | null;
    longitude: number | null;
    address: string | null;
    phone: string | null;
    features: Record<string, unknown> | null;
    congestionLevel: number | null;
  };
}

export function savedCardInput(b: SavedBookmark): SavedCardInput {
  const verifiedWait =
    b.waitEvidence === 'verified_model' && b.waitTime ? Number.parseFloat(b.waitTime) : undefined;
  const wait = verifiedWait !== undefined && Number.isFinite(verifiedWait) ? verifiedWait : undefined;
  const travel = b.spot?.expectedTravel ?? 0;
  return {
    title: b.name,
    matchPercentage: 100,
    walkMinutes: displayWalkingMinutes(b.spot?.expectedTravel),
    spotScore: b.spot?.score,
    preferencePercent: b.spot?.preferencePercent,
    expectedWait: wait,
    expectedTravel: travel,
    timeToService: travel + (wait ?? 0),
    facilityType: facilityTypeOf(b.category),
    facility: {
      id: b.id,
      name: b.name,
      latitude: b.latitude ?? null,
      longitude: b.longitude ?? null,
      address: b.address ?? null,
      phone: b.phone ?? null,
      features: b.features ?? null,
      congestionLevel: typeof b.congestionLevel === 'number' ? b.congestionLevel : null,
    },
  };
}

/**
 * 저장 장소 → 추천 카드 시트 후보. 저장 당시 spot(점수·선호·이동)이 있으면 그대로 싣고, 없으면 장소만(점수 줄이 안 그려진다).
 * 대기는 저장 당시 학습 모델이 잰 값(verified_model)일 때만 싣는다 — savedCardInput 과 같은 규칙. reason 은 저장 당시 문장.
 * 좌표가 없으면 NaN — 길안내 링크가 이름 검색으로 돌아간다(저장 화면의 directions 와 같은 폴백).
 */
export function candidateFromBookmark(b: SavedBookmark): SheetCandidate {
  const input = savedCardInput(b);
  const spot = b.spot;
  const candidate: SheetCandidate = {
    recommendationId: isRealRecommendationId(b.recommendationId) ? b.recommendationId : undefined,
    reason: b.reason,
    facility: {
      id: b.id,
      name: b.name,
      type: input.facilityType,
      latitude: b.latitude ?? Number.NaN,
      longitude: b.longitude ?? Number.NaN,
      address: b.address ?? null,
      phone: b.phone ?? null,
      features: b.features ?? null,
      congestionLevel: typeof b.congestionLevel === 'number' ? b.congestionLevel : undefined,
    },
  };
  if (spot) {
    candidate.spotScore = spot.score;
    candidate.breakdown = {
      preference: spot.preferencePercent / 100,
      travelTime: spot.expectedTravel,
      incentive: 0,
      ...(input.expectedWait !== undefined ? { waitTime: input.expectedWait } : {}),
    };
  }
  return candidate;
}
