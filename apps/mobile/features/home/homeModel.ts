// 홈(지도) 화면의 순수 로직 — react-native 를 모른다(테스트: homeModel.test.ts).
//
// 웹 원본(기준 커밋 0d145a1): apps/web/app/main/page.tsx — loadFacilities 의 매핑, computeDisplayFacilities 의
// 시설 선택·건물 묶음 핀 값, markerFacilities 의 편의 필터, focusFestivalOnMap, 위 TodayCalmSpots.tsx, openInstead.
// 웹 `lib/recommender`·`lib/congestionEstimate`·`lib/voice/voiceCandidates`·`lib/recommendOrigin` 은 의존 사슬에 api-client(window)
// 가 있어 check:shared 에 걸려 import 하지 못한다 — 아래에 필요한 부분만 다시 썼다(PORTING.md).
import { haversineMeters } from '@/lib/map/geo';
import { isPaintableMeasurement, pinDisplay } from '@/lib/map/markerSvg';
import { facilityMatchesSearch } from '@/lib/placeSearch';
import { isWithinRegion, REGION } from '@/lib/region';
import { parseAvailability } from '@/lib/restDate';
import { isStrollerFriendly } from '~/lib/core/strollerSupport';
import type { PlaceCategory } from '~/lib/core/travelContextTypes';
import type { PinCluster } from '~/features/map/declutter';
import type { LatLng, NextSpotCircle, NextSpotMarker, PinMarker } from '~/features/map/types';

export type { PlaceCategory };

export const CATEGORIES: readonly PlaceCategory[] = ['restaurant', 'cafe', 'attraction', 'culture'];

export interface HomeFacility {
  id: string;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
  capacity: number | null;
  features: Record<string, unknown> | null;
  address: string | null;
  phone: string | null;
  operatingHours: Record<string, unknown> | null;
  imageUrl: string | null;
  galleryImages: string[] | null;
  homepage: string | null;
  overview: string | null;
  barrierFree: boolean | null;
  contentid: string | null;
  contenttypeid: number | null;
  availabilityEvidence: unknown;
  /** 최신 혼잡 로그가 없으면 null('데이터 없음'). */
  congestionLevel: number | null;
  currentCount: number | null;
  /** 혼잡 로그 시각. */
  lastUpdated: string | null;
  source: string | null;
  isStale: boolean;
  /** 서버 판정('지금' 자격). 구 서버 응답엔 없다 — undefined. */
  congestionIsCurrent?: boolean;
}

/** GET /api/v1/infrastructures 항목 → 화면 시설. 좌표·id 가 없으면 null(핀을 만들 수 없다). */
export function mapInfrastructure(raw: unknown): HomeFacility | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, any>;
  const latitude = Number(f.latitude);
  const longitude = Number(f.longitude);
  if (!f.id || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const c = f.congestion ?? null;
  const level = c && typeof c.level === 'number' ? c.level : null;
  return {
    id: String(f.id),
    name: String(f.name ?? ''),
    type: String(f.type ?? ''),
    latitude,
    longitude,
    capacity: typeof f.capacity === 'number' ? f.capacity : null,
    features: f.features && typeof f.features === 'object' ? f.features : null,
    address: f.address ?? null,
    phone: f.phone ?? null,
    operatingHours: f.operatingHours ?? null,
    imageUrl: f.imageUrl ?? null,
    galleryImages: Array.isArray(f.galleryImages) ? f.galleryImages : null,
    homepage: f.homepage ?? null,
    overview: f.overview ?? null,
    barrierFree: f.barrierFree ?? null,
    contentid: f.contentid ?? null,
    contenttypeid: f.contenttypeid ?? null,
    availabilityEvidence: f.availabilityEvidence ?? null,
    congestionLevel: level,
    currentCount: c ? (c.currentCount ?? null) : null,
    lastUpdated: c ? (c.timestamp ?? null) : null,
    source: c ? (c.source ?? null) : null,
    isStale: c ? !!c.isStale : false,
    congestionIsCurrent: c ? (c.isCurrent ?? undefined) : undefined,
  };
}

export function mapInfrastructures(items: unknown): HomeFacility[] {
  if (!Array.isArray(items)) throw new Error('unexpected infrastructures payload');
  return items.map(mapInfrastructure).filter((f): f is HomeFacility => f !== null);
}

// ── 추정 피드(GET /congestion/estimates) ─────────────────────────────────

export const ESTIMATE_MAX_AGE_MS = 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface FreshEstimate {
  level: number;
  source: 'estimated';
  observedAt: string;
  [key: string]: unknown;
}

/** 웹 congestionEstimate.estimatesFromFeed — available 가 true 일 때만. */
export function estimatesFromFeed(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const p = payload as { available?: unknown; estimates?: unknown };
  if (p.available !== true) return {};
  const e = p.estimates;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return {};
  return e as Record<string, unknown>;
}

/** 60분 안에 잰 추정만 통과(웹 parseCongestionEstimate 의 신선도 판정). 나머지 필드는 그대로 둔다. */
export function freshEstimate(raw: unknown, now: Date = new Date()): FreshEstimate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.source !== 'estimated') return null;
  if (typeof r.level !== 'number' || !Number.isFinite(r.level) || r.level < 0 || r.level > 1) return null;
  if (typeof r.observedAt !== 'string' || !r.observedAt) return null;
  const ms = new Date(r.observedAt).getTime();
  if (Number.isNaN(ms)) return null;
  const age = now.getTime() - ms;
  if (age > ESTIMATE_MAX_AGE_MS || age < -FUTURE_SKEW_MS) return null;
  return { ...r, level: r.level, source: 'estimated', observedAt: r.observedAt };
}

// ── 편의 필터 · 검색 · 음식 칩 ───────────────────────────────────────────

export interface Convenience {
  accessible: boolean;
  stroller: boolean;
  parking: boolean;
  pet: boolean;
}
export const NO_CONVENIENCE: Convenience = { accessible: false, stroller: false, parking: false, pet: false };

export function hasAnyConvenience(c: Convenience): boolean {
  return c.accessible || c.stroller || c.parking || c.pet;
}

type Featured = { barrierFree?: unknown; features?: Record<string, unknown> | null };

export function isAccessible(f: Featured): boolean {
  return (f.barrierFree ?? f.features?.barrier_free ?? f.features?.barrierFree) === true;
}

/** 켜진 조건을 모두 만족하는 시설만(AND). 웹 markerFacilities. */
export function applyConvenience<T extends Featured>(list: readonly T[], c: Convenience): T[] {
  let out = [...list];
  if (c.accessible) out = out.filter((f) => isAccessible(f));
  if (c.stroller) out = out.filter((f) => isStrollerFriendly(f));
  if (c.parking) out = out.filter((f) => parseAvailability(f.features?.parking as string | null | undefined) === true);
  if (c.pet) out = out.filter((f) => parseAvailability((f.features?.chk_pet ?? f.features?.chkPet) as string | null | undefined) === true);
  return out;
}

/** 적재 데이터에 반려동물 값이 하나라도 있는가 — 없으면 🐾 칩을 숨긴다(웹과 같다). */
export function petDataExists(list: readonly Featured[]): boolean {
  return list.some((f) => parseAvailability((f.features?.chk_pet ?? f.features?.chkPet) as string | null | undefined) !== null);
}

/** 카테고리 + 검색 — 검색어가 있으면 종류와 무관하게 이름·주소·메뉴로 찾는다(웹 computeDisplayFacilities). */
export function selectByCategoryOrSearch<T extends Featured & { type: string; name: string; address: string | null }>(
  list: readonly T[],
  category: PlaceCategory,
  query: string,
): T[] {
  const q = query.trim();
  if (!q) return list.filter((f) => f.type === category);
  return list.filter((f) => facilityMatchesSearch(f, q));
}

export const SEARCH_MIN_CHARS = 2;

/** 외부 장소 검색(카카오·관광공사)을 물을 때인가 — 두 글자부터, 로컬에서 찾았으면 묻지 않는다(쿼터 보호). */
export function shouldAskExternal(query: string, localMatchCount: number): boolean {
  return query.trim().length >= SEARCH_MIN_CHARS && localMatchCount === 0;
}

export interface CuisineChip {
  id: string;
  kw: string;
  emoji: string;
}

/** 웹 voice/voiceCandidates.CUISINE_CHIPS 의 id·키워드·이모지(별칭은 음성 전용이라 뺐다). */
export const CUISINE_CHIPS: readonly CuisineChip[] = [
  { id: 'korean', kw: '한식', emoji: '🍚' },
  { id: 'meat', kw: '고기', emoji: '🥩' },
  { id: 'gukbap', kw: '국밥', emoji: '🍲' },
  { id: 'chicken', kw: '치킨', emoji: '🍗' },
  { id: 'western', kw: '피자', emoji: '🍕' },
  { id: 'chinese', kw: '중식', emoji: '🥟' },
  { id: 'japanese', kw: '일식', emoji: '🍣' },
  { id: 'bunsik', kw: '분식', emoji: '🍢' },
];

// 웹 recommender.CUISINE_INTENT_MAP 중 칩이 쓰는 그룹(순서가 구체성 — 앞이 우선).
const CUISINE_GROUPS: { keys: string[]; tags: string[] }[] = [
  { keys: ['국밥', '해장', '돼지국밥'], tags: ['국밥'] },
  { keys: ['피자', '파스타', '스테이크', '양식', '햄버거', '버거', '리조또', '스파게티'], tags: ['양식', '피자', '햄버거'] },
  { keys: ['치킨', '통닭', '닭강정'], tags: ['치킨'] },
  { keys: ['중식', '짜장', '짬뽕', '탕수육', '마라'], tags: ['중식', '중국요리'] },
  { keys: ['초밥', '스시', '사시미', '돈까스', '우동', '라멘', '일식'], tags: ['일식', '돈까스,우동'] },
  { keys: ['분식', '떡볶이', '김밥', '토스트', '라볶이'], tags: ['분식', '간식'] },
  { keys: ['갈비'], tags: ['갈비', '육류,고기'] },
  { keys: ['고기', '육류', '삼겹', '목살', '소고기', '돼지', '숯불', '구이', '한우'], tags: ['육류,고기', '갈비', '삼겹살'] },
  { keys: ['한식', '백반', '가정식', '집밥', '한정식'], tags: ['한식', '한정식'] },
];
const CAT3_CUISINE: Record<string, string> = { A05020100: '한식', A05020200: '양식', A05020300: '일식', A05020400: '중식' };
const BAR_TAGS = ['술집', '호프', '오뎅바', '실내포장마차', '일본식주점', '호프,요리주점', '포차', '선술집'];

function cuisineTokens(f: Featured): string[] {
  const features = f.features;
  const raw = features?.cuisineTags ?? features?.cuisine_tags ?? features?.cuisine;
  const tags = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
  const cat3 = features?.cat3;
  if (typeof cat3 === 'string' && CAT3_CUISINE[cat3]) tags.push(CAT3_CUISINE[cat3]);
  return tags;
}

/** 술집 태그가 붙은 시설인가(웹 isBarFacility) — 음식 칩 후보에서 뺀다. */
export function isBar(f: Featured): boolean {
  return cuisineTokens(f).some((t) => BAR_TAGS.includes(t));
}

/**
 * 음식 칩 소속 판정 — 웹 cuisineMatch ≥ 0.8(태그 일치 · 공식 메뉴 · 상호명)의 단순판.
 * 같은 한식 대분류의 약한 일치(0.45)와 술집은 칩 소속이 아니다.
 */
export function matchesCuisineChip(f: Featured & { name: string; type: string }, chip: Pick<CuisineChip, 'kw'>): boolean {
  if (f.type !== 'restaurant' || isBar(f)) return false;
  const kw = chip.kw.toLowerCase();
  const target = new Set<string>();
  for (const g of CUISINE_GROUPS) if (g.keys.some((k) => kw.includes(k.toLowerCase()))) g.tags.forEach((t) => target.add(t));
  if (target.size === 0) return false;
  if (cuisineTokens(f).some((t) => target.has(t))) return true;
  const menu = [f.features?.first_menu ?? f.features?.firstMenu]
    .filter((v): v is string => typeof v === 'string')
    .flatMap((s) => s.split(/[,/\s]+/).filter((x) => x.length >= 2));
  const firstGroup = (token: string) => CUISINE_GROUPS.find((g) => g.keys.some((k) => token.includes(k)));
  if (menu.some((m) => firstGroup(m)?.tags.some((t) => target.has(t)))) return true;
  return !!firstGroup(f.name)?.tags.some((t) => target.has(t));
}

// ── 순서 · 거리 ──────────────────────────────────────────────────────────

export function distanceM(a: LatLng, b: LatLng): number {
  return haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude);
}

/** 웹 recommender.displayWalkingMinutes — 직선거리에 우회 1.18, 66.67m/분, 올림 1분 이상. */
export function walkingMinutes(distM: number): number {
  const d = Number.isFinite(distM) ? Math.max(0, distM) : 0;
  return Math.max(1, Math.ceil((d * 1.18) / 66.67));
}

/** 핀 놓을 순서 — 서버 상위 추천(순위) 먼저, 그다음 내 위치에서 가까운 순(웹은 SPOT 미러 점수순). */
export function orderForPins<T extends { id: string; latitude: number; longitude: number }>(
  list: readonly T[],
  rankById: ReadonlyMap<string, number>,
  origin: { lat: number; lng: number },
): T[] {
  const d = (f: T) => haversineMeters(origin.lat, origin.lng, f.latitude, f.longitude);
  return [...list].sort((a, b) => (rankById.get(a.id) ?? 99) - (rankById.get(b.id) ?? 99) || d(a) - d(b));
}

// ── 핀 ───────────────────────────────────────────────────────────────────

export interface PinContext {
  rankById: ReadonlyMap<string, number>;
  selectedId: string | null;
  activeGroupId: string | null;
  busyAt: number;
  now: Date;
  /** 같은 건물 묶음 핀의 접근성 이름 — t('map.placesInBuilding', { count }). */
  groupName: (count: number) => string;
}

/** 놓기로 한 묶음(declutterPins 결과) → 지도 핀. 묶음 값은 웹과 같다: 24시간 안에 잰 구성원 중 가장 붐비는 곳의 값. */
export function buildPinMarkers(clusters: readonly PinCluster<HomeFacility>[], ctx: PinContext): PinMarker[] {
  return clusters.map((cluster) => {
    const members = cluster.members;
    const isGroup = members.length > 1;
    const anchor = cluster.anchor;
    let level: number | null;
    let observedAt: string | null;
    let source: string | null;
    let rank: number | null;
    if (!isGroup) {
      level = anchor.congestionLevel;
      observedAt = anchor.lastUpdated;
      source = anchor.source;
      rank = ctx.rankById.get(anchor.id) ?? null;
    } else {
      const painted = members
        .filter((m) => isPaintableMeasurement({ level: m.congestionLevel, observedAt: m.lastUpdated, source: m.source }, ctx.now))
        .sort((a, b) => (b.congestionLevel ?? 0) - (a.congestionLevel ?? 0))[0];
      level = painted ? painted.congestionLevel : null;
      observedAt = painted ? painted.lastUpdated : null;
      source = painted ? painted.source : null;
      const ranks = members.map((m) => ctx.rankById.get(m.id)).filter((r): r is number => typeof r === 'number');
      rank = ranks.length > 0 ? Math.min(...ranks) : null;
    }
    const selected = isGroup ? ctx.activeGroupId === cluster.key : ctx.selectedId === anchor.id;
    const pin = pinDisplay({ type: anchor.type, level, observedAt, source, rank, selected, phone: true, busyAt: ctx.busyAt, now: ctx.now });
    return {
      kind: 'pin' as const,
      id: cluster.key,
      coordinate: { latitude: anchor.latitude, longitude: anchor.longitude },
      title: isGroup ? ctx.groupName(members.length) : anchor.name,
      zIndex: pin.zIndex,
      pin,
      placeType: anchor.type,
      selected,
      groupIds: isGroup ? members.map((m) => m.id) : undefined,
      data: cluster,
    };
  });
}

// ── 지금 한산 ────────────────────────────────────────────────────────────

export interface CalmSpot {
  id: string;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
  congestionLevel: number;
  distM: number;
}

/** 웹 TodayCalmSpots — level<0.3 · '지금' 판정 통과 · 취향 종류 우선 → 더 한산 → 가까운 순, 상위 3. */
export function calmSpots(
  facilities: readonly HomeFacility[],
  origin: { lat: number; lng: number },
  preferredTypes: readonly string[] = [],
): CalmSpot[] {
  const list: CalmSpot[] = [];
  for (const f of facilities) {
    if (typeof f.congestionLevel !== 'number' || f.congestionIsCurrent === false || f.congestionLevel >= 0.3) continue;
    list.push({
      id: f.id, name: f.name, type: f.type, latitude: f.latitude, longitude: f.longitude,
      congestionLevel: f.congestionLevel,
      distM: haversineMeters(origin.lat, origin.lng, f.latitude, f.longitude),
    });
  }
  list.sort((a, b) => {
    const ap = preferredTypes.includes(a.type) ? 0 : 1;
    const bp = preferredTypes.includes(b.type) ? 0 : 1;
    return ap - bp || a.congestionLevel - b.congestionLevel || a.distM - b.distM;
  });
  return list.slice(0, 3);
}

/** 카드 상단 혼잡 pill 과 같은 경계(한산<0.25 / 여유). */
export function calmKey(level: number): 'quiet' | 'relaxed' {
  return level >= 0.25 ? 'relaxed' : 'quiet';
}

// ── 축제 ─────────────────────────────────────────────────────────────────

export const FESTIVAL_RADIUS_M = 600;
const FESTIVAL_ONGOING = '#c1553b';
const FESTIVAL_UPCOMING = '#c19a3e';

/** 주소가 '동·일원' 같은 넓은 지역 단위인가 — 웹 isAreaLevelAddress. */
export function isAreaLevelAddress(addr?: string | null): boolean {
  if (!addr) return false;
  if (/(일원|일대|전역|일부|주변|인근|곳곳)/.test(addr)) return true;
  const tail = addr.replace(/(경상북도|경북|경주시)/g, '');
  return !/\d/.test(tail);
}

export interface FestivalFocusInput {
  contentId: string;
  title: string;
  latitude?: number | null;
  longitude?: number | null;
  address?: string | null;
  isOngoing?: boolean;
}

export interface FestivalFocus {
  area: boolean;
  color: string;
  center: LatLng;
  markers: NextSpotMarker[];
  circles: NextSpotCircle[];
}

/** 축제를 지도에 표시 — 넓은 지역이면 600m 점선 원 + 가운데 라벨, 구체 주소면 정확 지점 점 + 위 말풍선(웹 focusFestivalOnMap). */
export function festivalFocus(ev: FestivalFocusInput, areaLabel: string, pointLabel: string): FestivalFocus | null {
  if (typeof ev.latitude !== 'number' || typeof ev.longitude !== 'number') return null;
  if (!Number.isFinite(ev.latitude) || !Number.isFinite(ev.longitude)) return null;
  const color = ev.isOngoing ? FESTIVAL_ONGOING : FESTIVAL_UPCOMING;
  const area = isAreaLevelAddress(ev.address);
  const center = { latitude: ev.latitude, longitude: ev.longitude };
  const markers: NextSpotMarker[] = [
    { kind: 'label', id: `festival-label-${ev.contentId}`, coordinate: center, text: area ? areaLabel : pointLabel, color, above: !area, zIndex: 60 },
  ];
  if (!area) markers.push({ kind: 'dot', id: `festival-dot-${ev.contentId}`, coordinate: center, color, size: 12, zIndex: 59 });
  const circles: NextSpotCircle[] = area
    ? [{ id: `festival-circle-${ev.contentId}`, center, radiusM: FESTIVAL_RADIUS_M, strokeColor: color, fillColor: `${color}2e`, strokeWidth: 2, dashed: true }]
    : [];
  return { area, color, center, markers, circles };
}

// ── '대신 갈 곳 보기' ────────────────────────────────────────────────────

/** 웹 recommendOrigin.candidateTypesFor — 대안을 고를 수 있는 종류. */
export function canSeeInstead(type: string | null | undefined): boolean {
  return type === 'restaurant' || type === 'cafe' || type === 'attraction' || type === 'culture';
}

export interface InsteadOrigin {
  facilityId?: string | null;
  name?: string | null;
  type: string;
  latitude?: number | null;
  longitude?: number | null;
}

/** 웹 buildRecommendHref(from 'pick') — 내 위치를 알면 거기서, 모르면 그 장소에서 잰다. */
export function buildInsteadHref(row: InsteadOrigin, user: { lat: number; lng: number } | null): string {
  const placeKnown = typeof row.latitude === 'number' && Number.isFinite(row.latitude)
    && typeof row.longitude === 'number' && Number.isFinite(row.longitude);
  const lat = user ? user.lat : placeKnown ? (row.latitude as number) : REGION.center.lat;
  const lng = user ? user.lng : placeKnown ? (row.longitude as number) : REGION.center.lng;
  const params = new URLSearchParams();
  if (row.facilityId) params.set('facilityId', row.facilityId);
  else if (row.name) params.set('name', row.name);
  params.set('lat', String(lat));
  params.set('lng', String(lng));
  params.set('type', row.type);
  params.set('from', 'pick');
  if (!user && placeKnown) params.set('walk', 'place');
  return `/explore/recommend?${params.toString()}`;
}

// ── 위치 ─────────────────────────────────────────────────────────────────

/** 이보다 부정확한 위치(대략적 위치만 허용)는 황리단길 중심 기준으로 둔다(계획 §6.2 ④). */
export const COARSE_ACCURACY_M = 1000;

export type LocationNotice = 'outOfRegion' | 'coarse' | null;

export interface ResolvedLocation {
  location: { lat: number; lng: number };
  /** 정말 내 위치인가 — 지역 중심으로 바꾼 값이면 false('대신 갈 곳 보기' 가 어디서 잴지 정한다). */
  known: boolean;
  notice: LocationNotice;
}

/** 기기 좌표 → 앱이 쓰는 위치. 경주 밖이면 중심으로 옮기고, 정확도가 1km 보다 나쁘면 중심 + 안내. */
export function resolveUserLocation(coords: { latitude: number; longitude: number; accuracy?: number | null }): ResolvedLocation {
  const center = { lat: REGION.center.lat, lng: REGION.center.lng };
  const { latitude, longitude, accuracy } = coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { location: center, known: false, notice: null };
  if (!isWithinRegion(latitude, longitude)) return { location: center, known: false, notice: 'outOfRegion' };
  if (typeof accuracy === 'number' && accuracy > COARSE_ACCURACY_M) return { location: center, known: false, notice: 'coarse' };
  return { location: { lat: latitude, lng: longitude }, known: true, notice: null };
}

// ── 지도 위 여정 카드(진행 중 여행 · 방문 확인) ─────────────────────────────

/** 홈 지도 위에 얹는 여정 카드 — 한 번에 하나만. */
export type TripOverlayCard = 'visit' | 'journey' | null;

/**
 * 카드 판별 최소 높이(dp) — 이보다 좁으면 그 판을 쓰지 않는다. 접은 판의 답 버튼이 스크롤 밑으로 숨지 않게 판마다 따로 잰다
 * (411×833dp 에뮬레이터 onLayout 실측 58 · 110 · 146dp + 여유 4 — 글자 크기를 키우면 넘치는 만큼 스크롤된다).
 *   journeyCompact — 진행 중 여행 한 줄(이름 + 도착했어요 + 펼치기)
 *   visitCompact   — 방문 확인 두 줄(질문 + 아직이요·네)
 *   visitFull      — 방문 확인 원래 판(단계 점 · 설명 포함)
 */
export const TRIP_CARD_HEIGHT = { journeyCompact: 62, visitCompact: 114, visitFull: 150 } as const;

export interface TripOverlayInput {
  /** 방문 확인 카드가 그릴 것이 있다(때가 된 방문 — 답하는 중 · 고마워요 단계 포함). 카드가 알려 준다. */
  visitActive: boolean;
  /** 진행 중 여행 카드가 그릴 것이 있다(길안내 중, '아직 가는 중'으로 닫지 않음). 카드가 알려 준다. */
  journeyActive: boolean;
  /** 검색 결과 판이 위를 차지하고 있다. */
  searching: boolean;
  /** 위 칩 줄 아래부터 아래 시트·배너·키보드 위까지 남은 높이(dp). */
  room: number;
}

export interface TripOverlay {
  /** 보여 줄 카드. 둘 다 늘 붙여 두고(답하던 단계·입력이 사라지지 않게) 이것만 보인다. */
  card: TripOverlayCard;
  /** 지금은 자리가 없어 감춘다(검색 판 · 시트를 올림 · 키보드). 카드는 붙어 있다 — 감추기만. */
  hidden: boolean;
  /** 접은 판(한두 줄)으로 그린다 — 지도를 가리지 않게. */
  compact: boolean;
}

/**
 * 여정 카드 고르기. 웹 /main 은 진행 중 여행(위)과 방문 확인(아래, 추천 카드 위 z-55)을 함께 띄웠지만, 두 카드는 같은 여정이다
 * (recordActiveTrip 이 대기 방문도 같이 쓴다). 그래서 앱 휴대폰 화면에서는 하나만 보인다:
 *  1. 방문 확인이 때가 되면 그것이 먼저다 — 웹도 이 카드를 가장 위 층(z-55)에 띄웠고, 답('네'·'아직이요')이 여정까지 끝낸다.
 *     '도착했어요'를 누르면 바로 이 카드로 넘어간다.
 *  2. 아니면 길안내 중인 여정. 홈에서는 늘 접은 판(이름 + '도착했어요')으로 시작하고 눌러야 펼친다.
 *  3. 검색 결과 판이 열려 있거나, 남은 높이가 그 카드의 접은 판보다 작으면 감춘다(시트가 내려오면 다시 보인다).
 *     방문 확인은 자리가 넉넉할 때만 원래 판. 펼친 카드도 남은 높이 안에서 스크롤되므로 시트와 겹치지 않는다.
 */
export function pickTripOverlay(input: TripOverlayInput): TripOverlay {
  const card: TripOverlayCard = input.visitActive ? 'visit' : input.journeyActive ? 'journey' : null;
  const room = Number.isFinite(input.room) ? input.room : 0;
  if (!card) return { card: null, hidden: true, compact: true };
  const min = card === 'visit' ? TRIP_CARD_HEIGHT.visitCompact : TRIP_CARD_HEIGHT.journeyCompact;
  const hidden = input.searching || room < min;
  return { card, hidden, compact: card === 'journey' || room < TRIP_CARD_HEIGHT.visitFull };
}

/** 카드가 쓸 수 있는 높이 — 위 칩 줄 아래(top)부터 아래에서 가린 두께(bottomCover) 위까지, 사이 여백 8씩. */
export function tripOverlayRoom(containerHeight: number, top: number, bottomCover: number): number {
  if (!(containerHeight > 0)) return 0;
  return Math.max(0, Math.round(containerHeight - top - bottomCover - 8));
}

/**
 * 홈 지도 위 열(검색·칩 줄 · 여정 카드 · 추천 시트)의 폭 상한(dp). 휴대폰(≈360–430dp)은 꽉 차고, 폴더블을 펼친 화면(≈750dp)·
 * 태블릿에서는 가운데 열로 좁혀 양옆 지도가 보이게 한다. 웹 /main 은 lg(1024px) 아래에서 카드가 화면 폭을 따라가지만,
 * 앱 시트는 폭이 넓으면 한 줄이 길어져 읽기 어렵다.
 */
export const HOME_PANEL_MAX_WIDTH = 560;
