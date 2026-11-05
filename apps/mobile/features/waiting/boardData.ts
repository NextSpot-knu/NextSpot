// 대기 보드의 순수 데이터 변환 — by-type 응답 → 섹터·행. 화면(React)·네트워크가 없다(테스트: boardData.test.ts).
//
// 웹 원본: apps/web/app/waiting/page.tsx 의 BoardRow·buildSector, lib/recommender.ts 의 recToSpot·
// displayWalkingMinutes 일부, lib/congestionEstimate.ts 의 congestionDisplay(보드가 쓰는 갈래만),
// lib/photoCredit.ts 의 photoCandidates·merchantPhotoUrl. 웹 모듈은 api-client(window·CustomEvent)·process.env 를
// 끌고 와 check:shared 에 걸려 다시 썼다(PORTING.md).
import type { RecommendationResponse } from '~/lib/core/apiClient';
import { toHttpsImageUrls } from '~/lib/platform/images';
import { isClosedToday } from '@/lib/restDate';

export type BoardType = 'restaurant' | 'cafe' | 'attraction' | 'culture';
/** recommendByType 이 지원하는 4유형 — 섹터 순서. */
export const BOARD_TYPES: readonly BoardType[] = ['restaurant', 'cafe', 'attraction', 'culture'];
export const TOP_CARD_COUNT = 3;
export const PER_TYPE_LIMIT = 8;
/** 영업 미확인 등급으로 채우지 않는다(웹 BOARD_FILLS_WEAKER_TIERS — 닫은 곳이 1위에 서지 않게). */
export const BOARD_FILLS_WEAKER_TIERS = false;

export const TYPE_EMOJI: Record<string, string> = {
  restaurant: '🍴',
  cafe: '☕',
  attraction: '📸',
  culture: '🏛️',
};

// 보행 속도·우회 보정 — 백엔드 WALKING_SPEED_M_PER_MIN · ESTIMATED_ROUTE_FACTOR 와 같다(웹 lib/recommender.ts).
const WALK_M_PER_MIN = 66.67;
const ESTIMATED_ROUTE_FACTOR = 1.18;

export function estimateWalkingMinutes(distanceM: number | null | undefined): number {
  const d = typeof distanceM === 'number' && Number.isFinite(distanceM) ? Math.max(0, distanceM) : 0;
  return (d * ESTIMATED_ROUTE_FACTOR) / WALK_M_PER_MIN;
}

/** 사용자에게 보이는 도보 분 — 과소 안내하지 않게 1분 이상 올림. */
export function displayWalkingMinutes(
  routeMinutes: number | null | undefined,
  fallbackDistanceM?: number | null,
): number {
  const resolved =
    typeof routeMinutes === 'number' && Number.isFinite(routeMinutes) && routeMinutes >= 0
      ? routeMinutes
      : estimateWalkingMinutes(fallbackDistanceM);
  return Math.max(1, Math.ceil(resolved));
}

export interface BoardRow {
  facilityId: string;
  name: string;
  type: string;
  latitude?: number | null;
  longitude?: number | null;
  imageUrls: string[];
  summary: string | null;
  /** 실측·예측으로 인정된 혼잡(0~1). 추정은 여기 넣지 않는다. */
  congestionLevel: number | null;
  areaDemandLevel: number | null;
  areaDemandParkingEvidence: {
    level: number;
    mode: 'live' | 'forecast';
    observedAt?: string | null;
    radiusM?: number | null;
  } | null;
  areaDemandTourismEvidence: {
    referenceName?: string | null;
    distanceM?: number | null;
    forecastDate?: string | null;
    relativeIndex?: number | null;
  } | null;
  arrivalAction: 'go_now' | 'wait_then_go' | 'choose_calmer' | 'no_clear_advantage' | null;
  recommendedDepartureDelayMinutes: number | null;
  /** 검증 모델이 없는 응답은 null — 0분으로 바꾸지 않는다. */
  expectedWait: number | null;
  rankingWait: number | null;
  baselineWait: number | null;
  capacity: number | null;
  expectedTravel: number;
  closedToday: boolean;
  menus: string[];
  operatingHours?: Record<string, unknown> | null;
}

export interface Sector {
  type: string;
  rows: BoardRow[];
}

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * '지금' 자격이 있는 실측·예측만 센다(웹 congestionDisplay 의 measured/predicted 갈래). 추정(estimated)과 근거 없음은 null —
 * 보드는 추정 혼잡을 별도 피드(estimates)로 받는다. 서버가 '지금이 아니다'(congestionIsCurrent=false)라고 한
 * 실측은 이 보드의 대기 입력으로 쓰지 않는다.
 */
export function boardMeasuredLevel(
  rec: Pick<
    RecommendationResponse,
    'congestionLevel' | 'congestionSource' | 'congestionIsCurrent' | 'congestionTimestamp' | 'congestionEstimate'
  >,
  now: Date = new Date(),
): number | null {
  const level = finiteNumber(rec.congestionLevel);
  if (level === null) return null;
  if (rec.congestionSource === 'predicted') return level;
  if (rec.congestionIsCurrent !== false) return level;
  // 서버가 '지금이 아니다'라고 한 실측: 신선한 추정이 있으면 추정이 이기고(여기서는 null),
  // 없으면 24시간 안쪽 관측만 그대로 쓴다(웹 congestionDisplay 와 같다).
  if (hasFreshEstimate(rec.congestionEstimate, now)) return null;
  return withinMs(rec.congestionTimestamp, now, LAST_OBSERVED_MAX_AGE_MS) ? level : null;
}

const ESTIMATE_MAX_AGE_MS = 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const LAST_OBSERVED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function withinMs(iso: string | null | undefined, now: Date, maxAge: number): boolean {
  if (!iso) return false;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return false;
  const age = now.getTime() - ms;
  return age <= maxAge && age >= -FUTURE_SKEW_MS;
}

function hasFreshEstimate(raw: unknown, now: Date): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  const level = finiteNumber(r.level);
  return (
    r.source === 'estimated' &&
    level !== null && level >= 0 && level <= 1 &&
    typeof r.observedAt === 'string' &&
    withinMs(r.observedAt, now, ESTIMATE_MAX_AGE_MS)
  );
}

/** 추정 피드 한 건 → 혼잡(0~1). 모양이 어긋나거나 60분을 넘겼으면 null(웹 parseCongestionEstimate 의 핵심). */
export function estimateLevelOf(raw: unknown, now: Date = new Date()): number | null {
  return hasFreshEstimate(raw, now) ? (raw as { level: number }).level : null;
}

/** 소개글 — 비-ko 로케일이면 배치 번역(features.overview_i18n)을 먼저. 없으면 주소. */
export function overviewOf(rec: RecommendationResponse, locale: string): string | null {
  const features = rec.facility.features ?? {};
  const i18n = (features.overviewI18n ?? features.overview_i18n) as Record<string, string> | null | undefined;
  const translated = locale !== 'ko' ? i18n?.[locale] : undefined;
  const text = (translated || rec.facility.overview)?.trim();
  return text || rec.facility.address?.trim() || null;
}

/** 대표·취급 메뉴를 합쳐 최대 5개(없는 메뉴를 지어내지 않는다). */
export function menusOf(features: Record<string, unknown> | null | undefined): string[] {
  const f = features ?? {};
  const first = f.first_menu ?? f.firstMenu;
  const treat = f.treat_menu ?? f.treatMenu;
  return Array.from(
    new Set(
      [first, treat]
        .filter((v): v is string => typeof v === 'string')
        .flatMap((v) => v.split(/[,/\n·]+/).map((s) => s.trim()).filter(Boolean)),
    ),
  ).slice(0, 5);
}

/**
 * 사진 후보. Wikimedia·경주시 사진은 작가·라이선스 출처 줄을 같이 붙여야 해서(웹 photoCredit) 앱 v1 의 보드 카드에는
 * 올리지 않는다 — TourAPI 사진(+사장님 사진은 앱에 공개 버킷 주소가 없어 제외)만. 모두 https 로 맞춘다.
 */
export function photoUrlsOf(rec: Pick<RecommendationResponse['facility'], 'imageUrl' | 'galleryImages'>): string[] {
  const gallery = Array.isArray(rec.galleryImages) ? rec.galleryImages : [];
  return toHttpsImageUrls([rec.imageUrl, ...gallery]).filter((url) => !needsCredit(url));
}

function needsCredit(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'wikimedia.org' || host.endsWith('.wikimedia.org') ||
      host === 'gyeongju.go.kr' || host.endsWith('.gyeongju.go.kr')
    );
  } catch {
    return true;
  }
}

export function rowFromRecommendation(rec: RecommendationResponse, locale: string): BoardRow {
  const b: Partial<RecommendationResponse['breakdown']> = rec.breakdown ?? {};
  const features = rec.facility.features ?? null;
  const restDateRaw = (features?.rest_date_raw ?? features?.restDateRaw) as string | null | undefined;
  const travel = typeof b.travelTime === 'number' ? b.travelTime : estimateWalkingMinutes(rec.distanceM);
  const baselineRaw =
    (b as Record<string, unknown>).industryBaselineWaitTime ?? (b as Record<string, unknown>).industry_baseline_wait_time;
  return {
    facilityId: rec.facility.id,
    name: rec.facility.name,
    type: rec.facility.type,
    latitude: finiteNumber(rec.facility.latitude),
    longitude: finiteNumber(rec.facility.longitude),
    imageUrls: photoUrlsOf(rec.facility),
    summary: overviewOf(rec, locale),
    congestionLevel: boardMeasuredLevel(rec),
    areaDemandLevel: finiteNumber(b.areaDemandLevel),
    areaDemandParkingEvidence: b.areaDemandParkingEvidence ?? null,
    areaDemandTourismEvidence: b.areaDemandTourismEvidence ?? null,
    arrivalAction: b.arrivalAction ?? null,
    recommendedDepartureDelayMinutes: finiteNumber(b.recommendedDepartureDelayMinutes),
    expectedWait: finiteNumber(b.waitTime),
    rankingWait: finiteNumber(b.rankingWaitTime),
    baselineWait: finiteNumber(baselineRaw),
    capacity: finiteNumber(rec.facility.capacity),
    expectedTravel: Math.round(travel * 10) / 10,
    // 휴무 '확정'만 — 모름·영업 확정은 평소처럼(과판정 금지).
    closedToday: isClosedToday(restDateRaw) === true,
    menus: menusOf(features),
    operatingHours: rec.facility.operatingHours ?? null,
  };
}

/** 대기 짧은 순(모르면 뒤) · 오늘 휴무 확정은 항상 맨 뒤. 입력을 바꾸지 않는다. */
export function sortRows(rows: readonly BoardRow[]): BoardRow[] {
  return [...rows].sort((a, b) => {
    if (a.closedToday !== b.closedToday) return a.closedToday ? 1 : -1;
    if (a.expectedWait === null && b.expectedWait === null) return 0;
    if (a.expectedWait === null) return 1;
    if (b.expectedWait === null) return -1;
    return a.expectedWait - b.expectedWait;
  });
}

/** 한 유형의 응답 → 섹터. 빈 유형은 null(섹터를 숨긴다). */
export function buildSector(type: string, recs: readonly RecommendationResponse[], locale: string): Sector | null {
  const rows = sortRows(recs.map((rec) => rowFromRecommendation(rec, locale)));
  return rows.length > 0 ? { type, rows } : null;
}
