// 지도 영역(Region) 기하 — 카카오 확대 단계 ↔ RN 영역 변환, 영역 안 좌표 → 화면 점, 영역 맞춤, 보이는 띠 가운데 맞춤.
//
// 왜 필요한가: 웹(카카오 JS SDK)은 `map.getProjection().containerPointFromCoords` 로 좌표를 화면 점으로 **동기**
// 변환해 핀 간격을 쟀다. react-native-maps 의 `pointForCoordinate` 는 비동기라 핀 하나마다 다리를 건너야 한다.
// 그래서 지도가 알려 주는 영역(가운데·위경도 폭)과 지도 상자 크기만으로 웹 메르카토르 투영을 직접 계산한다.
// 공급자(구글·애플·네이버)가 모두 웹 메르카토르 타일이라 같은 식이 맞는다. 순수 모듈 — react-native 를 모른다.
//
// ── 카카오 확대 단계 ↔ RN 영역 ────────────────────────────────────────────────────────────────
// 카카오 지도 level L(1 = 가장 가까움)은 한 단계마다 축척이 2배다. level 3 의 축척 막대가 '50m', level 4 가
// '100m' 이고(웹 CourseMap 주석 I58), 해상도는 level 3 = 1m/px 이다(카카오 타일 해상도 표: level 1 = 0.25m/px, 한 단계마다 2배).
// 웹은 CSS px, 구글 안드로이드는 dp 로 256 타일을 그리므로 'px ↔ dp' 를 같은 단위로 본다 — 같은 level 이면 같은 축척이고,
// 보이는 넓이는 화면 폭만큼 다르다(웹 390px 폰 level 4 ≈ 780m, 앱 411dp 폰 ≈ 823m).
// 검증(2026-11-05, 에뮬레이터 1080×2400 · 420dpi = 411×833dp): 홈 첫 화면 level 4 → 구글 getCamera().zoom 15.953,
// 아래 식의 googleZoomForKakaoLevel(4, 35.836) = 15.953 과 맞는다(geometry.test.ts 가 이 값을 잠근다).
//   metersPerPixel(L) = 2^(L − 3)
// RN 영역은 화면 폭 W(dp)에 경도 폭 Δlng 를 담으므로
//   metersPerPixel = Δlng × 111 320 × cos(위도) / W   →   L = 3 + log2(metersPerPixel)
// 구글 확대 단계로는 z = log2(156 543.03 × cos(위도) / metersPerPixel) 이다. 경주(35.84°)에서
//   level 3 ≈ z 16.95 · level 4 ≈ z 15.95 · level 5 ≈ z 14.95 — 대략 z ≈ 20 − L.
// 웹 핀 상한(5·7·12)은 정수 level 로 갈렸으므로 RN 에서는 연속값을 반올림한 정수로 같은 규칙을 쓴다.

import { centerTargetFor, type BandInsets } from '@/lib/map/visibleBand';

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface Region extends LatLng {
  latitudeDelta: number;
  longitudeDelta: number;
}

export interface ViewSize {
  width: number;
  height: number;
}

export interface EdgePadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/** 적도에서 경도 1°의 길이(m). 위도 1°도 이 값으로 근사한다(메르카토르 지역 축척은 등방이다). */
export const METERS_PER_DEGREE = 111_320;
/** 웹 메르카토르 z=0 의 적도 해상도(m/px, 256px 타일). 구글 확대 단계 환산용. */
const GOOGLE_Z0_METERS_PER_PIXEL = 156_543.033_92;
/** 지도 상자 크기를 아직 모를 때(첫 렌더) 쓰는 휴대폰 크기(dp). */
export const DEFAULT_VIEW_SIZE: ViewSize = { width: 390, height: 720 };
/** 웹 /main 의 첫 확대 단계(app/main/page.tsx 의 기본 level 4). */
export const DEFAULT_KAKAO_LEVEL = 4;

const RAD = Math.PI / 180;
const clampLat = (lat: number) => Math.max(-85, Math.min(85, lat));
/** 위도 → 메르카토르 y(라디안 단위, 북쪽이 큼). */
export const mercatorY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (clampLat(lat) * RAD) / 2));
/** 메르카토르 y → 위도. */
export const inverseMercatorY = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD;

/** 카카오 level → m/px. */
export function kakaoMetersPerPixel(level: number): number {
  return 2 ** (level - 3);
}

/** m/px → 카카오 level(연속값). */
export function kakaoLevelForMetersPerPixel(metersPerPixel: number): number {
  return 3 + Math.log2(metersPerPixel);
}

/** 영역의 가로 해상도(m/px). */
export function metersPerPixel(region: Region, size: ViewSize): number {
  const width = Math.max(1, size.width);
  return (region.longitudeDelta * METERS_PER_DEGREE * Math.cos(region.latitude * RAD)) / width;
}

/** 영역 → 카카오 level 연속값. */
export function kakaoLevelOf(region: Region, size: ViewSize): number {
  return kakaoLevelForMetersPerPixel(metersPerPixel(region, size));
}

/** 영역 → 정수 카카오 level(웹의 map.getLevel() 자리). 핀 상한 규칙이 이 값을 본다. */
export function kakaoLevelRounded(region: Region, size: ViewSize): number {
  return Math.round(kakaoLevelOf(region, size));
}

/** 카카오 level → 같은 축척의 구글 확대 단계(문서·디버그용). */
export function googleZoomForKakaoLevel(level: number, latitude: number): number {
  return Math.log2((GOOGLE_Z0_METERS_PER_PIXEL * Math.cos(latitude * RAD)) / kakaoMetersPerPixel(level));
}

/** 경도 1라디안이 화면 몇 dp 인가(메르카토르 y 도 같은 축척). */
function pixelsPerRadian(mpp: number, latitude: number): number {
  return (METERS_PER_DEGREE * Math.cos(latitude * RAD)) / RAD / mpp;
}

/** 가운데·해상도·크기 → 영역. 위도 폭은 메르카토르로 펴서 구한다. */
function regionFrom(center: LatLng, k: number, size: ViewSize): Region {
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  const cy = mercatorY(center.latitude);
  const north = inverseMercatorY(cy + height / 2 / k);
  const south = inverseMercatorY(cy - height / 2 / k);
  return {
    latitude: center.latitude,
    longitude: center.longitude,
    latitudeDelta: north - south,
    longitudeDelta: width / k / RAD,
  };
}

/** 가운데 + 카카오 level → 그 축척으로 상자를 채우는 영역. */
export function regionForKakaoLevel(center: LatLng, level: number, size: ViewSize = DEFAULT_VIEW_SIZE): Region {
  return regionFrom(center, pixelsPerRadian(kakaoMetersPerPixel(level), center.latitude), size);
}

export interface RegionBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/** 영역 → 경계. RN 의 영역은 가운데 ± 폭/2 다(안드로이드가 LatLngBounds 를 이렇게 만든다). */
export function regionBounds(region: Region): RegionBounds {
  return {
    north: region.latitude + region.latitudeDelta / 2,
    south: region.latitude - region.latitudeDelta / 2,
    east: region.longitude + region.longitudeDelta / 2,
    west: region.longitude - region.longitudeDelta / 2,
  };
}

/** 북동·남서 모서리 → 영역(react-native-maps getMapBoundaries 결과 변환). */
export function regionFromCorners(northEast: LatLng, southWest: LatLng): Region {
  return {
    latitude: (northEast.latitude + southWest.latitude) / 2,
    longitude: (northEast.longitude + southWest.longitude) / 2,
    latitudeDelta: Math.abs(northEast.latitude - southWest.latitude),
    longitudeDelta: Math.abs(northEast.longitude - southWest.longitude),
  };
}

/** 좌표가 영역(경계 포함) 안인가 — 웹 bounds.contain 자리. */
export function isInRegion(coord: LatLng, region: Region): boolean {
  const b = regionBounds(region);
  return coord.latitude >= b.south && coord.latitude <= b.north
    && coord.longitude >= b.west && coord.longitude <= b.east;
}

/** 좌표 → 지도 상자 안 점(dp, 왼쪽 위 원점) — 웹 containerPointFromCoords 자리. */
export function projectToView(coord: LatLng, region: Region, size: ViewSize): ScreenPoint {
  const b = regionBounds(region);
  const top = mercatorY(b.north);
  const bottom = mercatorY(b.south);
  const span = top - bottom || Number.EPSILON;
  return {
    x: ((coord.longitude - b.west) / (region.longitudeDelta || Number.EPSILON)) * size.width,
    y: ((top - mercatorY(coord.latitude)) / span) * size.height,
  };
}

/** 지도 상자 안 점 → 좌표(projectToView 의 역). */
export function unprojectFromView(point: ScreenPoint, region: Region, size: ViewSize): LatLng {
  const b = regionBounds(region);
  const top = mercatorY(b.north);
  const bottom = mercatorY(b.south);
  return {
    latitude: inverseMercatorY(top - (point.y / Math.max(1, size.height)) * (top - bottom)),
    longitude: b.west + (point.x / Math.max(1, size.width)) * region.longitudeDelta,
  };
}

export interface FitOptions {
  /**
   * 이보다 더 확대하지 않는다(카카오 level 하한). 점 하나뿐이거나 수십 m 안에 몰려 있으면 영역이 손톱만해져
   * 지나치게 확대된다. 웹 CourseMap 은 4, /main 검색은 3 을 썼다. 기본 3.
   */
  minLevel?: number;
  /** 이보다 더 축소하지 않는다(카카오 level 상한). 기본 14. */
  maxLevel?: number;
}

export const FIT_MIN_LEVEL = 3;
export const FIT_MAX_LEVEL = 14;

/**
 * 좌표들이 패딩을 뺀 안쪽 상자에 다 들어오는 영역 — 웹 map.setBounds(bounds, top, right, bottom, left) 자리.
 * 공급자의 fitToCoordinates 대신 이것을 쓰는 이유: 안드로이드 edgePadding 단위(px/dp)가 공급자마다 다르고,
 * 확대 하한(CourseMap 의 level 4)을 한 번에 걸 수 있고, 네이버로 바꿔도 같은 결과가 나온다.
 */
export function fitRegion(
  coords: readonly LatLng[],
  size: ViewSize,
  padding: Partial<EdgePadding> = {},
  options: FitOptions = {},
): Region | null {
  const points = coords.filter((c) => Number.isFinite(c.latitude) && Number.isFinite(c.longitude));
  if (points.length === 0) return null;
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  // 패딩이 상자를 다 먹으면 두 쪽을 같은 비율로 줄여 안쪽 상자를 최소 1/4 은 남긴다(웹 visibleBand 와 같은 생각).
  const squeeze = (a: number, b: number, total: number): [number, number] => {
    const near = Math.max(0, Number.isFinite(a) ? a : 0);
    const far = Math.max(0, Number.isFinite(b) ? b : 0);
    const room = total * 0.75;
    if (near + far <= room) return [near, far];
    const s = room / (near + far);
    return [near * s, far * s];
  };
  const [padTop, padBottom] = squeeze(padding.top ?? 0, padding.bottom ?? 0, height);
  const [padLeft, padRight] = squeeze(padding.left ?? 0, padding.right ?? 0, width);
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const midLat = (minLat + maxLat) / 2;
  const spanX = (maxLng - minLng) * RAD;
  const spanY = mercatorY(maxLat) - mercatorY(minLat);
  const kFit = Math.min(spanX > 0 ? innerW / spanX : Infinity, spanY > 0 ? innerH / spanY : Infinity);
  const mppFit = Number.isFinite(kFit) ? (METERS_PER_DEGREE * Math.cos(midLat * RAD)) / RAD / kFit : 0;
  const minLevel = options.minLevel ?? FIT_MIN_LEVEL;
  const maxLevel = options.maxLevel ?? FIT_MAX_LEVEL;
  const fitLevel = mppFit > 0 ? kakaoLevelForMetersPerPixel(mppFit) : -Infinity;
  const level = Math.min(maxLevel, Math.max(minLevel, fitLevel));
  const k = pixelsPerRadian(kakaoMetersPerPixel(level), midLat);
  // 내용의 가운데를 안쪽 상자의 가운데에 놓는다 → 지도 가운데는 그만큼 반대로 민다.
  const innerCx = padLeft + innerW / 2;
  const innerCy = padTop + innerH / 2;
  const contentX = ((minLng + maxLng) / 2) * RAD;
  const contentY = (mercatorY(minLat) + mercatorY(maxLat)) / 2;
  const centerX = contentX + (width / 2 - innerCx) / k;
  const centerY = contentY - (height / 2 - innerCy) / k;
  return regionFrom({ latitude: inverseMercatorY(centerY), longitude: centerX / RAD }, k, size);
}

/**
 * 지도 축척은 그대로(또는 level 로) 두고, target 이 '보이는 띠'(톱바·시트 등을 뺀 곳)의 가운데에 오는 영역.
 * 웹 centerOnFreeArea·panToVisible 과 같은 계산 — lib/map/visibleBand.centerTargetFor 를 그대로 쓴다.
 */
export function regionCenteredInBand(
  target: LatLng,
  size: ViewSize,
  insets: Partial<BandInsets>,
  scale: { region: Region } | { level: number },
): Region {
  const mpp = 'level' in scale ? kakaoMetersPerPixel(scale.level) : metersPerPixel(scale.region, size);
  const k = pixelsPerRadian(mpp, target.latitude);
  const mid = { x: size.width / 2, y: size.height / 2 };
  // target 을 상자 가운데에 놓았다고 보고, 띠 가운데로 보내려면 지도 가운데를 어디로 옮길지 구한다.
  const moved = centerTargetFor(mid, size.width, size.height, insets);
  const dx = moved.x - mid.x;
  const dy = moved.y - mid.y;
  const center = {
    latitude: inverseMercatorY(mercatorY(target.latitude) - dy / k),
    longitude: target.longitude + dx / k / RAD,
  };
  return regionFrom(center, k, size);
}

/**
 * 웹 /main fitAttributePins 의 패딩 규칙 — 가리는 두께(insets)에 여백 16 을 더하되, 위는 지도 높이의 절반,
 * 아래는 40% 를 넘지 않는다. 왼쪽은 24 고정, 오른쪽은 가림이 없으면 8.
 */
export function fitPaddingForInsets(insets: Partial<BandInsets>, size: ViewSize): EdgePadding {
  const h = Math.max(0, size.height);
  return {
    top: Math.min(Math.max(0, insets.top ?? 0), Math.round(h * 0.5)) + 16,
    right: (Math.max(0, insets.right ?? 0) || 8) + 16,
    bottom: Math.min(Math.max(0, insets.bottom ?? 0), Math.round(h * 0.4)) + 16,
    left: 24,
  };
}

/** 웹 CourseMap 의 영역 맞춤 패딩(setBounds(bounds, 80, 40, 40, 40)) 과 확대 하한(level 4). */
export const COURSE_FIT_PADDING: EdgePadding = { top: 80, right: 40, bottom: 40, left: 40 };
export const COURSE_FIT_MIN_LEVEL = 4;

/**
 * 원 둘레를 점 n 개로 — 안드로이드 Circle 은 점선을 못 그려서(react-native-maps 1.27: lineDashPattern 은
 * iOS 애플 지도만) 점선 테두리를 Polyline 으로 그린다. 첫 점을 끝에 한 번 더 넣어 닫는다.
 */
export function circleRing(center: LatLng, radiusM: number, segments = 72): LatLng[] {
  const n = Math.max(8, Math.floor(segments));
  const dLat = radiusM / METERS_PER_DEGREE;
  const dLng = radiusM / (METERS_PER_DEGREE * Math.cos(center.latitude * RAD));
  const ring: LatLng[] = [];
  for (let i = 0; i <= n; i += 1) {
    const a = (2 * Math.PI * (i % n)) / n;
    ring.push({ latitude: center.latitude + dLat * Math.sin(a), longitude: center.longitude + dLng * Math.cos(a) });
  }
  return ring;
}
