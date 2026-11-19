// 지역 묶음(pack) — 화면이 '지금 지역' 에서 꺼내 쓰는 값 한 벌: 중심 · 경계 · 위치 프리셋 · 주소 토큰 · 켜 둔 기능.
//
// · 경주 묶음(GYEONGJU_PACK)은 lib/region.ts 의 REGION 값을 **그대로 참조**한다. region.ts 는 바꾸지 않는다 —
//   경주 화면이 쓰는 좌표·프리셋은 오늘과 같은 객체다.
// · 내부 지역 묶음은 번들에 없다. 내부 계정만 부르는 GET /api/v1/internal/regions 응답으로 **실행 중에** 만든다
//   (buildInternalPack). 그래서 정적 번들에는 내부 지역의 이름·좌표·구역 id 가 한 글자도 들어가지 않는다
//   (regionPacks.test.ts 의 번들 내용 검사가 잠근다).
// · 기능 표(features)는 내부 지역 전용이 아니라 '공개 지역이 아닌 곳' 의 일반 규칙이다. 날씨·축제·주차·발견·외부 검색·
//   추정·일괄 예측·지역 수요 예보는 경주 데이터로만 만든 기능이라 끈다. 혼잡 제보·자리 제보·자리 현황·타임세일은 공개
//   혼잡 기록(congestion_logs)과 사장님 기능이 경주 전용이라 끈다. 공유는 받는 사람이 내부 지역을 볼 수 없으니 끈다.
//   대신 구역 혼잡(zoneLayer)을 켠다.
import { REGION } from './region';
import { PUBLIC_REGION_ID } from './regionRuntime';
import type { Locale } from './i18n/config';
import type { InternalRegionView } from './api-client';

export interface RegionFeatures {
  /** 날씨 위젯 */
  weather: boolean;
  /** 축제 배너 */
  festival: boolean;
  /** 공영주차 표시·필터 */
  parking: boolean;
  /** 발견(경주 테마) 카드 */
  discovery: boolean;
  /** 외부(TourAPI·카카오) 장소 검색과 적재 */
  externalSearch: boolean;
  /** 주차 실측 기반 혼잡 추정(GET /congestion/estimates) */
  estimates: boolean;
  /** 일괄 혼잡 예측(predict batch) */
  predictBatch: boolean;
  /** 혼잡 제보 버튼 */
  crowdReports: boolean;
  /** 자리(좌석) 제보 */
  availabilityReports: boolean;
  /** 사장님 자리 현황 방송 */
  seatStatus: boolean;
  /** 사장님 타임세일 */
  timesale: boolean;
  /** Supabase 직접 읽기 폴백(지도·신선도·추천 출발지) — 공개 지역 행만 읽히므로 다른 지역에서는 끈다 */
  supabaseFallback: boolean;
  /** 지역 수요 예보 곡선 */
  areaDemandForecast: boolean;
  /** 공유 링크 */
  share: boolean;
  /** 구역 혼잡 오버레이(내부 지역의 근거) */
  zoneLayer: boolean;
}

export interface RegionBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface RegionPreset {
  /** 화면이 쓰는 번호(경주 REGION.presets 와 같은 형식 — 1부터) */
  id: number;
  name: string;
  lat: number;
  lng: number;
  /** 서버가 준 프리셋 id(내부 지역만) */
  key?: string;
}

export interface RegionPack {
  /** 지역 id — 경주는 'gyeongju', 내부 지역은 서버가 준 id */
  id: string;
  /** 기본(한국어) 이름 */
  name: string;
  /** 로케일별 이름(내부 지역만 — 경주는 i18n 키 region.name.gyeongju 를 쓴다) */
  names: Readonly<Record<Locale, string>> | null;
  center: { readonly lat: number; readonly lng: number };
  bounds: Readonly<RegionBounds>;
  presets: readonly RegionPreset[];
  /** 카카오 주소 검사에 쓰는 지역 토큰 */
  addressToken: string;
  features: Readonly<RegionFeatures>;
  /** 서버가 센 활성 장소 수(내부 지역만) */
  facilityCount: number | null;
  /** 서버가 센 구역 수(내부 지역만) */
  zoneCount: number | null;
}

/** 공개 지역(경주)은 오늘 있는 기능을 전부 켠 채 둔다. 구역 오버레이만 없다. */
export const GYEONGJU_FEATURES: Readonly<RegionFeatures> = Object.freeze({
  weather: true,
  festival: true,
  parking: true,
  discovery: true,
  externalSearch: true,
  estimates: true,
  predictBatch: true,
  crowdReports: true,
  availabilityReports: true,
  seatStatus: true,
  timesale: true,
  supabaseFallback: true,
  areaDemandForecast: true,
  share: true,
  zoneLayer: false,
});

/** 공개 지역이 아닌 곳의 기능 표 — 경주 전용 기능과 공유는 끄고 구역 오버레이만 켠다. */
export const INTERNAL_PACK_FEATURES: Readonly<RegionFeatures> = Object.freeze({
  weather: false,
  festival: false,
  parking: false,
  discovery: false,
  externalSearch: false,
  estimates: false,
  predictBatch: false,
  crowdReports: false,
  availabilityReports: false,
  seatStatus: false,
  timesale: false,
  supabaseFallback: false,
  areaDemandForecast: false,
  share: false,
  zoneLayer: true,
});

/** 경주 묶음 — lib/region.ts 의 REGION 객체를 그대로 가리킨다(복사하지 않는다). */
export const GYEONGJU_PACK: RegionPack = Object.freeze({
  id: PUBLIC_REGION_ID,
  name: REGION.name,
  names: null,
  center: REGION.center,
  bounds: REGION.bounds,
  presets: REGION.presets,
  addressToken: '경주',
  features: GYEONGJU_FEATURES,
  facilityCount: null,
  zoneCount: null,
});

const LOCALE_KEYS: readonly Locale[] = ['ko', 'en', 'ja', 'zh'];

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 서버 응답(InternalRegionView, keysToCamel 을 거친 camelCase)으로 지역 묶음을 만든다.
 * 좌표가 숫자가 아니거나 경계가 뒤집혔거나 중심이 경계 밖이면 null — 그런 지역은 고를 수 없게 한다.
 */
export function buildInternalPack(view: InternalRegionView | null | undefined): RegionPack | null {
  if (!view || typeof view !== 'object') return null;
  const id = text(view.id);
  if (!id || id === PUBLIC_REGION_ID) return null;
  const b = view.bounds;
  const c = view.center;
  if (!b || !c) return null;
  if (![b.minLat, b.maxLat, b.minLng, b.maxLng, c.lat, c.lng].every(finite)) return null;
  if (b.minLat >= b.maxLat || b.minLng >= b.maxLng) return null;
  const bounds: RegionBounds = { minLat: b.minLat, maxLat: b.maxLat, minLng: b.minLng, maxLng: b.maxLng };
  const center = { lat: c.lat, lng: c.lng };
  if (!withinBounds(bounds, center.lat, center.lng)) return null;

  const rawNames = (view.names ?? {}) as Partial<Record<Locale, unknown>>;
  const fallbackName = text(rawNames.ko) || id;
  const names = Object.freeze(
    Object.fromEntries(LOCALE_KEYS.map((locale) => [locale, text(rawNames[locale]) || fallbackName])) as Record<Locale, string>,
  );

  const presets: RegionPreset[] = [];
  for (const preset of Array.isArray(view.presets) ? view.presets : []) {
    if (!preset || !finite(preset.lat) || !finite(preset.lng)) continue;
    if (!withinBounds(bounds, preset.lat, preset.lng)) continue;
    presets.push(
      Object.freeze({
        id: presets.length + 1,
        name: text(preset.name) || String(presets.length + 1),
        lat: preset.lat,
        lng: preset.lng,
        key: text(preset.id) || undefined,
      }),
    );
  }

  return Object.freeze({
    id,
    name: names.ko,
    names,
    center: Object.freeze(center),
    bounds: Object.freeze(bounds),
    presets: Object.freeze(presets),
    addressToken: text(view.addressToken),
    features: INTERNAL_PACK_FEATURES,
    facilityCount: finite(view.facilityCount) ? view.facilityCount : null,
    zoneCount: finite(view.zoneCount) ? view.zoneCount : null,
  });
}

// 지역별로 마지막에 만든 묶음 — 값이 같으면 그 객체를 다시 쓴다(internPack).
const internedPacks = new Map<string, { key: string; pack: RegionPack }>();

/**
 * 값이 같은 묶음은 같은 객체로 돌려준다. RegionProvider 는 5분마다·탭 복귀 때 서버에 다시 묻고 그 답으로 묶음을 새로 만든다 —
 * 값이 그대로여도 객체가 바뀌면 `pack` 에 걸린 화면 효과가 전부 다시 돈다(/course 가 탭에 돌아올 때마다 위치를 다시 묻고
 * 위치 안내 토스트를 다시 띄웠다). 값(JSON)이 같으면 이전 객체를 쓰고, 달라졌을 때만 새 객체를 쓴다.
 */
export function internPack(pack: RegionPack): RegionPack {
  const key = JSON.stringify(pack);
  const hit = internedPacks.get(pack.id);
  if (hit && hit.key === key) return hit.pack;
  internedPacks.set(pack.id, { key, pack });
  return pack;
}

function withinBounds(bounds: RegionBounds, lat: number, lng: number): boolean {
  return lat >= bounds.minLat && lat <= bounds.maxLat && lng >= bounds.minLng && lng <= bounds.maxLng;
}

/** 좌표가 경계 안인가(isWithinPack 의 경계만 받는 판). */
export function isWithinBounds(bounds: Readonly<RegionBounds>, lat: number, lng: number): boolean {
  if (!finite(lat) || !finite(lng)) return false;
  return withinBounds(bounds, lat, lng);
}

/** 좌표가 묶음의 경계 안인가 — 경주 묶음이면 lib/region.ts isWithinRegion 과 같은 판정. */
export function isWithinPack(pack: RegionPack, lat: number, lng: number): boolean {
  if (!finite(lat) || !finite(lng)) return false;
  return withinBounds(pack.bounds, lat, lng);
}

/** 화면에 쓸 지역 이름. 내부 지역은 로케일별 이름, 없으면 기본 이름. 경주는 호출부가 i18n 키를 쓴다. */
export function packDisplayName(pack: RegionPack, locale: Locale): string {
  return pack.names?.[locale] || pack.name;
}

/**
 * 기기 캐시 키에 지역을 붙인다. 경주는 키를 **그대로** 돌려준다(오늘 저장된 캐시를 그대로 읽는다).
 * 다른 지역은 `${base}__${id}` — 두 지역의 캐시가 섞이지 않고, purgeRegionCaches 가 한 번에 지울 수 있다.
 */
export function regionCacheKey(base: string, id: string | null | undefined): string {
  if (!id || id === PUBLIC_REGION_ID) return base;
  return `${base}__${id}`;
}

/** 내부 지역 캐시 키의 모양: nextspot 으로 시작하고 `__<지역 id>` 로 끝난다(경주 접미사는 없다). */
const REGION_SUFFIXED_KEY = /^nextspot.*__([a-z][a-z0-9_-]{0,31})$/;

/** 키가 공개 지역이 아닌 지역의 캐시 키인가. */
export function isRegionSuffixedKey(key: string): boolean {
  const match = REGION_SUFFIXED_KEY.exec(key);
  return !!match && match[1] !== PUBLIC_REGION_ID;
}

type StorageLike = Pick<Storage, 'length' | 'key' | 'removeItem'>;

/**
 * 저장소에서 내부 지역 캐시를 모두 지운다(경주 캐시·기기 설정은 건드리지 않는다). 지운 개수를 돌려준다.
 * 내부 계정이 아니게 됐거나(로그아웃·역할 변경) 서버가 지역을 거절했을 때 RegionProvider · userData 가 부른다.
 */
export function purgeRegionCaches(storage: StorageLike | null | undefined): number {
  if (!storage) return 0;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && isRegionSuffixedKey(key)) doomed.push(key);
    }
    for (const key of doomed) storage.removeItem(key);
    return doomed.length;
  } catch {
    return 0; // 저장소 차단 환경 — 지울 것도 없다
  }
}
