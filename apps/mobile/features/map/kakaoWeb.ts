// 웹 빌드(Expo web)의 카카오 지도 JS SDK — 순수 부분. NextSpotMap.web.tsx 가 쓴다.
//
// 앱 네이티브는 react-native-maps(안드로이드 구글 · iOS 애플)를 쓰지만 웹에서는 돌지 않는다. 웹 빌드는 웹 앱(apps/web)과
// 같은 카카오 지도 JS SDK 를 쓴다(app/layout.tsx 의 script 주소 · components/CourseMap.tsx 의 오버레이 모양).
// 이 파일은 DOM·window 를 직접 만지지 않는다 — 스크립트 주입과 전역 읽기는 호출부가 deps 로 넘긴다(테스트에서 가짜로 바꾼다).
//
// 카카오 지도는 정수 level 만 쓴다(1 = 가장 가까움 · 14 = 가장 멂). geometry.ts 의 연속 level 계산을 정수로 맞춘다.

import {
  DEFAULT_VIEW_SIZE,
  fitRegion,
  kakaoLevelOf,
  regionCenteredInBand,
  type EdgePadding,
  type FitOptions,
  type LatLng,
  type Region,
  type ViewSize,
} from './geometry';
import type { BandInsets } from '@/lib/map/visibleBand';

// ── SDK 표면(이 앱이 실제로 부르는 것만) ─────────────────────────────────────────────────────────

export interface KakaoLatLng {
  getLat(): number;
  getLng(): number;
}

export interface KakaoLatLngBounds {
  getSouthWest(): KakaoLatLng;
  getNorthEast(): KakaoLatLng;
}

export interface KakaoMapOptions {
  center: KakaoLatLng;
  level?: number;
  draggable?: boolean;
  scrollwheel?: boolean;
  disableDoubleClickZoom?: boolean;
  keyboardShortcuts?: boolean;
}

export interface KakaoSetLevelOptions {
  animate?: boolean | { duration: number };
  anchor?: KakaoLatLng;
}

export interface KakaoMap {
  setCenter(latlng: KakaoLatLng): void;
  getCenter(): KakaoLatLng;
  panTo(latlng: KakaoLatLng): void;
  setLevel(level: number, options?: KakaoSetLevelOptions): void;
  getLevel(): number;
  getBounds(): KakaoLatLngBounds;
  relayout(): void;
  setDraggable(draggable: boolean): void;
  setZoomable(zoomable: boolean): void;
}

export interface KakaoOverlay {
  setMap(map: KakaoMap | null): void;
}

export interface KakaoCustomOverlayOptions {
  position: KakaoLatLng;
  content: HTMLElement | string;
  xAnchor?: number;
  yAnchor?: number;
  zIndex?: number;
  clickable?: boolean;
}

export interface KakaoCustomOverlay extends KakaoOverlay {
  setPosition(latlng: KakaoLatLng): void;
  setContent(content: HTMLElement | string): void;
  setZIndex(zIndex: number): void;
}

export interface KakaoCircleOptions {
  center: KakaoLatLng;
  radius: number;
  strokeWeight?: number;
  strokeColor?: string;
  strokeOpacity?: number;
  strokeStyle?: string;
  fillColor?: string;
  fillOpacity?: number;
  zIndex?: number;
}

export interface KakaoPolylineOptions {
  path: KakaoLatLng[];
  strokeWeight?: number;
  strokeColor?: string;
  strokeOpacity?: number;
  strokeStyle?: string;
  zIndex?: number;
}

export interface KakaoMouseEvent {
  latLng: KakaoLatLng;
}

export interface KakaoMapsNamespace {
  LatLng: new (lat: number, lng: number) => KakaoLatLng;
  Map: new (container: HTMLElement, options: KakaoMapOptions) => KakaoMap;
  CustomOverlay: new (options: KakaoCustomOverlayOptions) => KakaoCustomOverlay;
  Circle: new (options: KakaoCircleOptions) => KakaoOverlay;
  Polyline: new (options: KakaoPolylineOptions) => KakaoOverlay;
  event: {
    addListener(target: object, type: string, handler: (...args: never[]) => void): void;
    removeListener(target: object, type: string, handler: (...args: never[]) => void): void;
  };
  /** autoload=false 로 넣었으므로 이 콜백 안에서부터 Map 등을 쓸 수 있다. */
  load(callback: () => void): void;
}

// ── 키 · 스크립트 ────────────────────────────────────────────────────────────────────────────

/** 웹 app/layout.tsx 와 같은 script id — 같은 페이지에 두 번 넣지 않는다. */
export const KAKAO_SDK_SCRIPT_ID = 'kakao-maps-sdk';
/** SDK 를 받고 kakao.maps.load 가 끝날 때까지 기다리는 상한(ms). 넘기면 지도 없이 그린다. */
export const KAKAO_LOAD_TIMEOUT_MS = 15_000;

/** EXPO_PUBLIC_KAKAO_MAP_KEY → 쓸 수 있는 키(공백 제거) 또는 null. 카카오 JS 키는 공개 키다(도메인으로 제한). */
export function kakaoAppKey(raw: string | undefined | null): string | null {
  const key = typeof raw === 'string' ? raw.trim() : '';
  return key.length > 0 ? key : null;
}

/** 웹 app/layout.tsx 와 같은 SDK 주소(autoload=false — kakao.maps.load 로 초기화한다). */
export function kakaoSdkUrl(appKey: string): string {
  return `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&autoload=false&libraries=services,clusterer`;
}

export interface KakaoLoaderDeps {
  /** 지금 전역에 있는 kakao.maps(없으면 undefined). */
  readNamespace(): KakaoMapsNamespace | undefined;
  /** 스크립트를 넣는다(같은 id 가 있으면 그 태그에 붙는다). 끝나면 onLoad, 실패하면 onError. */
  injectScript(src: string, onLoad: () => void, onError: () => void): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * SDK 를 한 번만 받는 loader 를 만든다. 성공한 약속은 계속 재사용하고, 실패하면 다음 호출에서 다시 시도한다.
 * 키가 도메인에 등록되지 않았거나 네트워크가 막히면 load 콜백이 오지 않을 수 있어 timeoutMs 로 끊는다.
 */
export function createKakaoLoader(deps: KakaoLoaderDeps, timeoutMs = KAKAO_LOAD_TIMEOUT_MS) {
  let pending: Promise<KakaoMapsNamespace> | null = null;
  return function loadKakaoMaps(appKey: string): Promise<KakaoMapsNamespace> {
    if (pending) return pending;
    const attempt = new Promise<KakaoMapsNamespace>((resolve, reject) => {
      let settled = false;
      const timer = deps.setTimeout(() => finish(new Error('kakao maps sdk timed out')), timeoutMs);
      function finish(error: Error | null, ns?: KakaoMapsNamespace) {
        if (settled) return;
        settled = true;
        deps.clearTimeout(timer);
        if (error || !ns) reject(error ?? new Error('kakao maps sdk missing'));
        else resolve(ns);
      }
      function init() {
        const ns = deps.readNamespace();
        if (!ns || typeof ns.load !== 'function') {
          finish(new Error('kakao maps sdk missing'));
          return;
        }
        try {
          ns.load(() => finish(null, ns));
        } catch (e) {
          finish(e instanceof Error ? e : new Error(String(e)));
        }
      }
      const existing = deps.readNamespace();
      if (existing && typeof existing.load === 'function') init();
      else deps.injectScript(kakaoSdkUrl(appKey), init, () => finish(new Error('kakao maps sdk failed to load')));
    });
    pending = attempt;
    attempt.catch(() => {
      if (pending === attempt) pending = null;
    });
    return attempt;
  };
}

// ── 색 ──────────────────────────────────────────────────────────────────────────────────────

/**
 * CSS 색 → 카카오 도형 색(#rrggbb) + 불투명도. 카카오 Circle·Polyline 은 색과 투명도를 따로 받는데,
 * 앱 화면은 'rgba(193,85,59,0.18)' 처럼 한 문자열로 넘긴다. 모르는 형식은 그대로 두고 불투명도 1.
 */
export function parseCssColor(input: string): { color: string; opacity: number } {
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return { color: '#000000', opacity: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = h.split('').map((c) => c + c);
      return { color: `#${r}${g}${b}`, opacity: a ? parseInt(a, 16) / 255 : 1 };
    }
    if (h.length === 6) return { color: `#${h}`, opacity: 1 };
    if (h.length === 8) return { color: `#${h.slice(0, 6)}`, opacity: parseInt(h.slice(6), 16) / 255 };
    return { color: input, opacity: 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(s);
  if (fn) {
    const channel = (v: string) => Math.max(0, Math.min(255, Math.round(Number(v))));
    const toHex = (v: string) => channel(v).toString(16).padStart(2, '0');
    let opacity = 1;
    if (fn[4] !== undefined) {
      opacity = fn[4].endsWith('%') ? Number(fn[4].slice(0, -1)) / 100 : Number(fn[4]);
      opacity = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
    }
    return { color: `#${toHex(fn[1])}${toHex(fn[2])}${toHex(fn[3])}`, opacity };
  }
  return { color: input, opacity: 1 };
}

// ── 카메라(정수 level) ──────────────────────────────────────────────────────────────────────

export const KAKAO_MIN_LEVEL = 1;
export const KAKAO_MAX_LEVEL = 14;

export function clampKakaoLevel(level: number): number {
  if (!Number.isFinite(level)) return KAKAO_MAX_LEVEL;
  return Math.max(KAKAO_MIN_LEVEL, Math.min(KAKAO_MAX_LEVEL, Math.round(level)));
}

export interface KakaoCamera {
  center: LatLng;
  level: number;
}

/**
 * 첫 영역 → 카카오 카메라. 화면들은 initialRegion 을 regionForKakaoLevel(가운데, level)(기본 상자 크기)로 만든다 —
 * 즉 '가운데 + 축척'이다. 웹은 그 축척(level)을 상자 크기와 상관없이 그대로 쓴다(웹 /main 이 창 크기와 상관없이 level 4 였듯이).
 */
export function kakaoCameraForRegion(region: Region): KakaoCamera {
  return {
    center: { latitude: region.latitude, longitude: region.longitude },
    level: clampKakaoLevel(kakaoLevelOf(region, DEFAULT_VIEW_SIZE)),
  };
}

/**
 * 좌표들이 패딩을 뺀 안쪽에 다 들어오는 카카오 카메라 — 웹 map.setBounds(bounds, …) + 하한 level 자리.
 * geometry.fitRegion 의 연속 level 을 한 단계 올림(넓게)한 정수로 바꾸고, 그 level 로 가운데를 다시 계산한다
 * (패딩이 비대칭이면 가운데 밀림이 축척에 따라 달라진다).
 */
export function kakaoCameraForFit(
  coords: readonly LatLng[],
  size: ViewSize,
  padding: Partial<EdgePadding> | undefined,
  options: FitOptions = {},
): KakaoCamera | null {
  const loose = fitRegion(coords, size, padding, options);
  if (!loose) return null;
  const level = clampKakaoLevel(Math.ceil(kakaoLevelOf(loose, size) - 1e-6));
  const exact = fitRegion(coords, size, padding, { minLevel: level, maxLevel: level });
  const region = exact ?? loose;
  return { center: { latitude: region.latitude, longitude: region.longitude }, level };
}

/** target 이 '보이는 띠'의 가운데에 오는 카카오 카메라(웹 panToVisible·centerOnFreeArea). */
export function kakaoCameraForBand(
  target: LatLng,
  size: ViewSize,
  insets: Partial<BandInsets>,
  level: number,
): KakaoCamera {
  const lv = clampKakaoLevel(level);
  const region = regionCenteredInBand(target, size, insets, { level: lv });
  return { center: { latitude: region.latitude, longitude: region.longitude }, level: lv };
}

/** 마커 앵커 → 카카오 CustomOverlay xAnchor·yAnchor(pins.markerAnchor 와 같은 규칙 — 핀은 아래 끝, 라벨 위는 1.35). */
export function overlayAnchor(kind: 'bottom' | 'center' | 'above'): { xAnchor: number; yAnchor: number } {
  if (kind === 'bottom') return { xAnchor: 0.5, yAnchor: 1 };
  if (kind === 'above') return { xAnchor: 0.5, yAnchor: 1.35 };
  return { xAnchor: 0.5, yAnchor: 0.5 };
}
