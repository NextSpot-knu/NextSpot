// <NextSpotMap> 웹 빌드(Expo web) — 카카오 지도 JS SDK. Metro 는 웹에서 NextSpotMap.tsx 대신 이 파일을 고른다.
//
// react-native-maps 는 웹에서 돌지 않는다. 웹 앱(apps/web)이 쓰는 카카오 지도 SDK 를 같은 주소로 불러
// 같은 props · 같은 ref API(types.ts 의 NextSpotMapHandle)를 낸다. 이 파일은 react-native-maps 를 import 하지 않는다.
//
// 키: EXPO_PUBLIC_KAKAO_MAP_KEY(카카오 JS 키 — 공개 키이고 카카오 개발자 콘솔의 '웹 플랫폼 도메인'으로 제한된다).
// 키가 없으면 MAP_AVAILABLE = false → 화면은 지도 없는 대안을 그린다. 키가 있어도 SDK 를 못 받으면(도메인 미등록 등)
// 지도 자리만 남긴다.
//
// 네이티브와 다른 점:
// - 카카오는 정수 level 만 쓴다. 영역 맞춤은 한 단계 넓은 정수 level 로(kakaoWeb.kakaoCameraForFit),
//   initialRegion 은 '가운데 + 축척(level)'으로 읽는다(kakaoCameraForRegion — 웹 /main 처럼 창 크기와 상관없이 같은 level).
// - level 이 바뀌는 이동은 가운데로 옮긴 뒤 확대 애니메이션, 같은 level 은 panTo(멀면 카카오가 애니메이션 없이 옮긴다).
// - isGesture 는 dragstart·사용자 확대(zoom_start 중 우리가 부른 이동이 아닌 것)를 보고 정한다.
// - 마커는 CustomOverlay(DOM). 누를 수 있는 마커(clickable) 위에서 시작한 끌기는 지도를 움직이지 않는다(카카오 동작).

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { pinSvg } from '@/lib/map/markerSvg';
import { REGION } from '@/lib/region';
import { colors } from '~/lib/theme/tokens';

import {
  DEFAULT_KAKAO_LEVEL,
  DEFAULT_VIEW_SIZE,
  fitPaddingForInsets,
  kakaoLevelRounded,
  regionForKakaoLevel,
  regionFromCorners,
} from './geometry';
import {
  createKakaoLoader,
  kakaoAppKey,
  kakaoCameraForBand,
  kakaoCameraForFit,
  kakaoCameraForRegion,
  KAKAO_LOAD_TIMEOUT_MS,
  KAKAO_SDK_SCRIPT_ID,
  needsLevelChange,
  overlayAnchor,
  parseCssColor,
  type KakaoCamera,
  type KakaoCustomOverlay,
  type KakaoMap,
  type KakaoMapsNamespace,
  type KakaoMouseEvent,
  type KakaoOverlay,
  type KakaoPositionedOverlay,
} from './kakaoWeb';
import {
  MAP_COLORS,
  MAP_UNAVAILABLE_GRADIENT,
  numberMarkerSize,
  pinContentKey,
  USER_DOT,
  USER_HALO_CSS_GRADIENT,
} from './pins';
import type {
  EdgePadding,
  LatLng,
  MapPopover,
  MapViewport,
  NextSpotCircle,
  NextSpotMapHandle,
  NextSpotMarker,
  NextSpotPolyline,
  PinMarker,
  Region,
  UserLocationDot,
  ViewSize,
} from './types';

export interface NextSpotMapProps {
  markers?: NextSpotMarker[];
  circles?: NextSpotCircle[];
  polylines?: NextSpotPolyline[];
  userLocation?: UserLocationDot | null;
  /** 첫 영역. 없으면 황리단길 중심(lib/region) · 웹 /main 의 첫 level 4. */
  initialRegion?: Region;
  /** false 면 손으로 움직일 수 없는 미리보기 지도(추천 카드의 작은 지도). 기본 true. */
  interactive?: boolean;
  /** 채도 낮춘 지도(웹 /main 과 같은 톤). 기본 true. 코스·미리보기처럼 웹이 원색을 쓴 곳은 false. */
  muted?: boolean;
  /** 하나짜리 마커를 눌렀다(묶음 핀 제외). */
  onMarkerPress?: (marker: NextSpotMarker) => void;
  /** 같은 건물 묶음 핀을 눌렀다 — 화면이 바텀 시트 목록을 연다. */
  onGroupPress?: (marker: PinMarker) => void;
  /** 빈 지도를 눌렀다(웹 map 'click' — 선택 해제). */
  onMapPress?: (coordinate: LatLng) => void;
  /** 지도가 멈췄다(카카오 'idle'). 첫 준비 때도 한 번 불린다. */
  onRegionChangeComplete?: (viewport: MapViewport, info: { isGesture: boolean }) => void;
  /** 사용자가 지도를 만졌다(누르기·휠). 마커 탭도 포함. */
  onUserTouch?: () => void;
  /** 지도가 준비됐다. onUnavailable 뒤에 오면 늦게 받은 SDK 로 복구된 것이다(웹 /main 의 늦은 SDK 복구). */
  onMapReady?: () => void;
  /**
   * 지도를 그릴 수 없다 — 키 없음, 또는 카카오 SDK 를 unavailableTimeoutMs 안에 못 받음(웹 /main mapUnavailable · CourseMap unavailable).
   * 상태가 바뀔 때 한 번 불린다. 늦게라도 SDK 가 오면 지도를 만들고 onMapReady 가 불린다.
   */
  onUnavailable?: () => void;
  /** SDK 대기 상한(ms) — 웹 홈 8000 · 코스 3000. 기본 15000(지금 값). */
  unavailableTimeoutMs?: number;
  /** 네이티브(구글 로고 약관) 전용 — 웹 빌드(카카오)는 쓰지 않는다(웹 앱도 카카오 로고를 옮기지 않는다). */
  mapPadding?: Partial<EdgePadding>;
  /** 지도 위 말풍선 목록(같은 건물 묶음 핀 — 웹 CustomOverlay, yAnchor 1.3). 기본 없음. */
  popover?: MapPopover | null;
  /** 말풍선의 항목을 눌렀다(id). 닫기는 화면이 popover 를 null 로. */
  onPopoverPick?: (id: string) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  ref?: Ref<NextSpotMapHandle>;
}

const DEFAULT_DURATION_MS = 400;
/** 마커 탭이 지도 탭으로도 오는 경우를 거른다(네이티브와 같은 값). */
const MARKER_TAP_GUARD_MS = 350;
const LABEL_HEIGHT = 28;
const STYLE_ELEMENT_ID = 'nextspot-kakao-map-style';
const MUTED_CLASS = 'nextspot-kakao-muted';
const MAP_CLASS = 'nextspot-kakao-map';
const USER_GLOW_CLASS = 'nextspot-user-glow';
const USER_PULSE_KEYFRAMES = 'nextspot-user-pulse';
const POPOVER_CLASS = 'nextspot-map-popover';
/** 지도 DOM 은 NativeWind 클래스를 못 쓰므로 토큰 값으로. */
const LINE = colors.line;
const HANJI_DEEP = colors['hanji-deep'];
const GOLD_DEEP = colors['gold-deep'];
/** 웹 검색 이름표 zIndex · 묶음 말풍선 zIndex(page.tsx). */
const SEARCH_LABEL_Z = 80;
const POPOVER_Z = 50;

export const DEFAULT_INITIAL_REGION: Region = regionForKakaoLevel(
  { latitude: REGION.center.lat, longitude: REGION.center.lng },
  DEFAULT_KAKAO_LEVEL,
  DEFAULT_VIEW_SIZE,
);

// Expo 는 `process.env.EXPO_PUBLIC_X` 를 점 표기 그대로 쓸 때만 번들 시점에 값으로 바꿔 넣는다.
const KAKAO_APP_KEY = kakaoAppKey(process.env.EXPO_PUBLIC_KAKAO_MAP_KEY);

/** 웹은 카카오 JS 키가 있어야 지도를 그린다. */
export const MAP_AVAILABLE = KAKAO_APP_KEY !== null;

type KakaoGlobal = { kakao?: { maps?: KakaoMapsNamespace } };

const loadKakaoMaps = createKakaoLoader({
  readNamespace: () => (typeof window === 'undefined' ? undefined : (window as unknown as KakaoGlobal).kakao?.maps),
  injectScript(src, onLoad, onError) {
    if (typeof document === 'undefined') {
      onError();
      return;
    }
    // 이 함수는 namespace 가 없을 때만 불린다. 남아 있는 태그는 실패했거나 시간 초과로 버린 시도라
    // load·error 가 다시 오지 않으므로 지우고 새로 넣는다(재시도가 실제로 네트워크를 타게).
    document.getElementById(KAKAO_SDK_SCRIPT_ID)?.remove();
    const script = document.createElement('script');
    script.id = KAKAO_SDK_SCRIPT_ID;
    script.async = true;
    script.src = src;
    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener(
      'error',
      () => {
        script.remove();
        onError();
      },
      { once: true },
    );
    document.head.appendChild(script);
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

/**
 * 지도 안 전용 규칙 두 가지.
 * - max-width 풀기: Tailwind preflight(global.css 의 `@tailwind base`)가 모든 img 에 `max-width:100%` 를 건다.
 *   카카오 CustomOverlay 의 부모 상자는 너비가 0 이라 핀 img 가 0px 로 접혀 마커가 안 보였다(카카오 안내도 지도 안 img 는 max-width:none).
 * - 채도 낮춤: 웹 globals.css 의 /main 규칙(saturate 55% · brightness 103%). 우리 핀(data: URI)은 빠진다.
 */
function ensureMapStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ELEMENT_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ELEMENT_ID;
  el.textContent =
    `.${MAP_CLASS} img { max-width: none; }\n` +
    `.${MUTED_CLASS} img:not([src^="data:"]) { filter: saturate(55%) brightness(103%); }\n` +
    // 내 위치 금빛 맥박 — 웹 /main 의 pulse-user-marker 와 같은 값. 동작 줄이기면 멈춘다(정적 번짐).
    `@keyframes ${USER_PULSE_KEYFRAMES} { 0% { transform: scale(0.3); opacity: 1; } 100% { transform: scale(1.6); opacity: 0; } }\n` +
    `.${USER_GLOW_CLASS} { animation: ${USER_PULSE_KEYFRAMES} 1.2s infinite cubic-bezier(0.2, 0, 0.2, 1); }\n` +
    `@media (prefers-reduced-motion: reduce) { .${USER_GLOW_CLASS} { animation: none; } }\n` +
    // 묶음 말풍선 — 웹 no-scrollbar · 가게 줄 hover:bg-hanji-deep
    `.${POPOVER_CLASS} { scrollbar-width: none; }\n` +
    `.${POPOVER_CLASS}::-webkit-scrollbar { display: none; }\n` +
    `.${POPOVER_CLASS} button:hover { background: ${HANJI_DEEP}; }`;
  document.head.appendChild(el);
}

interface Callbacks {
  interactive: boolean;
  onMarkerPress?: NextSpotMapProps['onMarkerPress'];
  onGroupPress?: NextSpotMapProps['onGroupPress'];
  onMapPress?: NextSpotMapProps['onMapPress'];
  onRegionChangeComplete?: NextSpotMapProps['onRegionChangeComplete'];
  onUserTouch?: NextSpotMapProps['onUserTouch'];
  onMapReady?: NextSpotMapProps['onMapReady'];
  onUnavailable?: NextSpotMapProps['onUnavailable'];
  onPopoverPick?: NextSpotMapProps['onPopoverPick'];
}

interface MarkerEntry {
  overlay: KakaoPositionedOverlay;
  key: string;
  marker: NextSpotMarker;
}

export function NextSpotMap({
  markers = [],
  circles = [],
  polylines = [],
  userLocation = null,
  initialRegion = DEFAULT_INITIAL_REGION,
  interactive = true,
  muted = true,
  onMarkerPress,
  onGroupPress,
  onMapPress,
  onRegionChangeComplete,
  onUserTouch,
  onMapReady,
  onUnavailable,
  unavailableTimeoutMs = KAKAO_LOAD_TIMEOUT_MS,
  popover = null,
  onPopoverPick,
  style,
  testID,
  ref,
}: NextSpotMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<KakaoMap | null>(null);
  const nsRef = useRef<KakaoMapsNamespace | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  /** SDK 를 못 받아 다시 시도한 횟수 — 바뀌면 지도 만들기 effect 가 다시 돈다. */
  const [loadAttempt, setLoadAttempt] = useState(0);
  const regionRef = useRef<Region>(initialRegion);
  const initialRegionRef = useRef<Region>(initialRegion);
  const sizeRef = useRef<ViewSize | null>(null);
  const lastMarkerTapRef = useRef(0);
  const gestureRef = useRef(false);
  const programmaticRef = useRef(false);
  /**
   * 마지막으로 요청한 level(아직 도착 전이면). `map.getLevel()` 은 확대 애니메이션 중에 시작 level 을 돌려줘서,
   * 그 사이에 온 다음 카메라 요청이 '이동만' 하고 앞 요청의 level 로 끝났다(코스 확대 경합 — 검토 R2 G4b-R01).
   * 지도가 그 level 에 닿거나(idle) 사용자가 확대를 바꾸면 비운다.
   */
  const targetLevelRef = useRef<number | null>(null);
  /** 지도 준비 전에 부른 카메라 요청 — 준비되면 실제 상자 크기로 다시 계산해 적용한다. */
  const pendingCameraRef = useRef<(() => void) | null>(null);
  const markerEntriesRef = useRef(new Map<string, MarkerEntry>());
  const timeoutRef = useRef(unavailableTimeoutMs);
  timeoutRef.current = unavailableTimeoutMs;

  const cbRef = useRef<Callbacks>({ interactive });
  cbRef.current = {
    interactive,
    onMarkerPress,
    onGroupPress,
    onMapPress,
    onRegionChangeComplete,
    onUserTouch,
    onMapReady,
    onUnavailable,
    onPopoverPick,
  };

  const currentSize = useCallback((): ViewSize | null => {
    const size = sizeRef.current;
    if (size && size.width > 0 && size.height > 0) return size;
    const el = containerRef.current;
    if (el && el.clientWidth > 0 && el.clientHeight > 0) return { width: el.clientWidth, height: el.clientHeight };
    return null;
  }, []);

  const viewport = useCallback((): MapViewport | null => {
    const size = currentSize();
    if (!size) return null;
    const region = regionRef.current;
    return { region, size, level: mapRef.current?.getLevel() ?? kakaoLevelRounded(region, size) };
  }, [currentSize]);

  const syncRegionFromMap = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      const b = map.getBounds();
      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      regionRef.current = regionFromCorners(
        { latitude: ne.getLat(), longitude: ne.getLng() },
        { latitude: sw.getLat(), longitude: sw.getLng() },
      );
    } catch {
      // 상자 크기가 0 이면 경계를 못 구한다 — 마지막 영역을 그대로 둔다.
    }
  }, []);

  const emitViewport = useCallback((isGesture: boolean) => {
    const v = viewport();
    if (v) cbRef.current.onRegionChangeComplete?.(v, { isGesture });
  }, [viewport]);

  const applyCamera = useCallback((camera: KakaoCamera, duration: number) => {
    const map = mapRef.current;
    const ns = nsRef.current;
    if (!map || !ns) return;
    const size = currentSize() ?? DEFAULT_VIEW_SIZE;
    regionRef.current = regionForKakaoLevel(camera.center, camera.level, size);
    programmaticRef.current = true;
    const target = new ns.LatLng(camera.center.latitude, camera.center.longitude);
    const animate = duration > 0;
    if (needsLevelChange(targetLevelRef.current, map.getLevel(), camera.level)) {
      targetLevelRef.current = camera.level;
      map.setCenter(target);
      map.setLevel(camera.level, animate ? { animate: { duration } } : undefined);
    } else if (animate) {
      map.panTo(target);
    } else {
      map.setCenter(target);
    }
  }, [currentSize]);

  /** 지금(또는 가는 중인) level — 확대 애니메이션 중에도 마지막 요청 level. */
  const currentLevel = useCallback((): number => {
    const size = currentSize() ?? DEFAULT_VIEW_SIZE;
    return targetLevelRef.current ?? mapRef.current?.getLevel() ?? kakaoLevelRounded(regionRef.current, size);
  }, [currentSize]);

  useImperativeHandle(ref, (): NextSpotMapHandle => ({
    fitToCoordinates(coordinates, options = {}) {
      const run = () => {
        const size = currentSize() ?? DEFAULT_VIEW_SIZE;
        const padding = options.padding ?? (options.insets ? fitPaddingForInsets(options.insets, size) : undefined);
        const camera = kakaoCameraForFit(coordinates, size, padding, { minLevel: options.minLevel, maxLevel: options.maxLevel });
        if (camera) applyCamera(camera, options.duration ?? DEFAULT_DURATION_MS);
      };
      if (mapRef.current) run();
      else pendingCameraRef.current = run;
    },
    animateTo(target, options = {}) {
      if (!Number.isFinite(target.latitude) || !Number.isFinite(target.longitude)) return;
      const run = () => {
        const size = currentSize() ?? DEFAULT_VIEW_SIZE;
        const level = options.level ?? currentLevel();
        applyCamera(kakaoCameraForBand(target, size, options.insets ?? {}, level), options.duration ?? DEFAULT_DURATION_MS);
      };
      if (mapRef.current) run();
      else pendingCameraRef.current = run;
    },
    getRegion: () => regionRef.current,
    getViewport: viewport,
    async pointForCoordinate(coordinate) {
      const map = mapRef.current;
      const ns = nsRef.current;
      if (!map || !ns || !Number.isFinite(coordinate.latitude) || !Number.isFinite(coordinate.longitude)) return null;
      try {
        const pt = map.getProjection().containerPointFromCoords(new ns.LatLng(coordinate.latitude, coordinate.longitude));
        return { x: pt.x, y: pt.y };
      } catch {
        return null;
      }
    },
  }), [applyCamera, currentLevel, currentSize, viewport]);

  // ── 지도 만들기(한 번) ──
  useEffect(() => {
    if (!MAP_AVAILABLE || !KAKAO_APP_KEY) return undefined;
    let cancelled = false;
    let detach: (() => void) | null = null;
    // 웹처럼 정해진 시간 안에 SDK 가 없으면 '지도 없음'으로 그린다(홈 8초 · 코스 3초). 받는 일은 계속해서
    // 늦게라도 오면 지도를 만든다(웹 /main·CourseMap 의 늦은 SDK 복구).
    const timer = setTimeout(() => {
      if (!cancelled && !mapRef.current) setFailed(true);
    }, Math.max(0, timeoutRef.current));
    loadKakaoMaps(KAKAO_APP_KEY)
      .then((ns) => {
        clearTimeout(timer);
        const container = containerRef.current;
        if (cancelled || !container) return;
        ensureMapStyle();
        const camera = kakaoCameraForRegion(initialRegionRef.current);
        const interactiveNow = cbRef.current.interactive;
        const map = new ns.Map(container, {
          center: new ns.LatLng(camera.center.latitude, camera.center.longitude),
          level: camera.level,
          draggable: interactiveNow,
          scrollwheel: interactiveNow,
          disableDoubleClickZoom: !interactiveNow,
          keyboardShortcuts: false,
        });
        nsRef.current = ns;
        mapRef.current = map;
        targetLevelRef.current = null;

        const onIdle = () => {
          syncRegionFromMap();
          if (targetLevelRef.current !== null && map.getLevel() === targetLevelRef.current) targetLevelRef.current = null;
          const isGesture = gestureRef.current;
          gestureRef.current = false;
          programmaticRef.current = false;
          emitViewport(isGesture);
        };
        const onClick = (e: KakaoMouseEvent) => {
          const cb = cbRef.current;
          if (!cb.interactive || !cb.onMapPress) return;
          if (Date.now() - lastMarkerTapRef.current < MARKER_TAP_GUARD_MS) return;
          cb.onMapPress({ latitude: e.latLng.getLat(), longitude: e.latLng.getLng() });
        };
        const onDragStart = () => { gestureRef.current = true; };
        const onZoomStart = () => {
          if (programmaticRef.current) return;
          gestureRef.current = true;
          // 사용자가 확대를 바꿨다 — 우리가 요청했던 level 은 더 이상 목표가 아니다.
          targetLevelRef.current = null;
        };
        ns.event.addListener(map, 'idle', onIdle);
        ns.event.addListener(map, 'click', onClick as (...args: never[]) => void);
        ns.event.addListener(map, 'dragstart', onDragStart);
        ns.event.addListener(map, 'zoom_start', onZoomStart);
        detach = () => {
          ns.event.removeListener(map, 'idle', onIdle);
          ns.event.removeListener(map, 'click', onClick as (...args: never[]) => void);
          ns.event.removeListener(map, 'dragstart', onDragStart);
          ns.event.removeListener(map, 'zoom_start', onZoomStart);
        };

        const pending = pendingCameraRef.current;
        pendingCameraRef.current = null;
        if (pending) pending();
        setFailed(false);
        setReady(true);
        cbRef.current.onMapReady?.();
        // 첫 'idle' — 실제로 보이는 영역을 읽어 알린다.
        syncRegionFromMap();
        emitViewport(false);
      })
      .catch(() => {
        clearTimeout(timer);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      detach?.();
      for (const entry of markerEntriesRef.current.values()) entry.overlay.setMap(null);
      markerEntriesRef.current.clear();
      mapRef.current = null;
      nsRef.current = null;
      targetLevelRef.current = null;
    };
  }, [emitViewport, syncRegionFromMap, loadAttempt]);

  // 지도 없음 알림 — 키가 없거나 SDK 를 시간 안에 못 받았을 때, 상태가 바뀔 때마다 한 번.
  const unavailable = !MAP_AVAILABLE || (failed && !ready);
  useEffect(() => {
    if (unavailable) cbRef.current.onUnavailable?.();
  }, [unavailable]);

  // SDK 를 못 받았으면(네트워크·시간 초과) 다시 온라인이 되거나 탭으로 돌아올 때 다시 시도한다 —
  // 오래 켜 두는 웹에서 한 번의 실패로 세션 내내 빈 지도가 남지 않게.
  useEffect(() => {
    if (!failed || ready || typeof window === 'undefined') return undefined;
    const retry = () => {
      if (document.visibilityState === 'hidden') return;
      setFailed(false);
      setLoadAttempt((n) => n + 1);
    };
    window.addEventListener('online', retry);
    window.addEventListener('focus', retry);
    document.addEventListener('visibilitychange', retry);
    return () => {
      window.removeEventListener('online', retry);
      window.removeEventListener('focus', retry);
      document.removeEventListener('visibilitychange', retry);
    };
  }, [failed, ready]);

  // 손 조작 켜고 끄기(처음 값은 지도 만들 때 넣었다).
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setDraggable(interactive);
    map.setZoomable(interactive);
  }, [ready, interactive]);

  // 사용자가 지도를 만졌다 — 카카오가 이벤트를 삼키기 전에 잡으려고 캡처 단계에서 듣는다.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const touch = () => cbRef.current.onUserTouch?.();
    el.addEventListener('pointerdown', touch, true);
    el.addEventListener('wheel', touch, { capture: true, passive: true });
    return () => {
      el.removeEventListener('pointerdown', touch, true);
      el.removeEventListener('wheel', touch, true);
    };
  }, []);

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    const prev = sizeRef.current;
    sizeRef.current = { width, height };
    if (prev && prev.width === width && prev.height === height) return;
    const map = mapRef.current;
    if (!map) return;
    // 상자 크기가 바뀌면 카카오에 알리고(가운데는 지킨다) 핀 겹침을 다시 계산하도록 알린다.
    const center = map.getCenter();
    map.relayout();
    map.setCenter(center);
    syncRegionFromMap();
    emitViewport(false);
  }, [emitViewport, syncRegionFromMap]);

  // ── 마커(키별로 맞춰 고친다 — 내용이 같으면 위치·zIndex 만 바꾼다) ──
  useEffect(() => {
    const map = mapRef.current;
    const ns = nsRef.current;
    if (!ready || !map || !ns) return;
    const entries = markerEntriesRef.current;
    const seen = new Set<string>();
    for (const marker of markers) {
      if (!Number.isFinite(marker.coordinate.latitude) || !Number.isFinite(marker.coordinate.longitude)) continue;
      seen.add(marker.id);
      const key = `${markerContentKey(marker)}|${interactive ? 'i' : 'n'}`;
      const position = new ns.LatLng(marker.coordinate.latitude, marker.coordinate.longitude);
      const zIndex = markerZIndex(marker);
      const existing = entries.get(marker.id);
      if (existing && existing.key === key) {
        existing.marker = marker;
        existing.overlay.setPosition(position);
        existing.overlay.setZIndex(zIndex);
        continue;
      }
      // 내용(또는 앵커·누를 수 있음)이 바뀌었으면 오버레이를 새로 만든다 — 앵커·clickable 은 만들 때만 정해진다.
      existing?.overlay.setMap(null);
      const entry = { key, marker } as MarkerEntry;
      if (marker.kind === 'default') {
        // 카카오 기본 마커 그대로(웹 대안 화면 미니맵 `new kakao.maps.Marker({ position })`).
        const kakaoMarker = new ns.Marker({ position, zIndex, clickable: interactive, title: marker.title });
        if (interactive) ns.event.addListener(kakaoMarker, 'click', () => handleMarkerTap(entry));
        entry.overlay = kakaoMarker;
      } else {
        const searchLabel = marker.kind === 'label' && marker.variant === 'search';
        // 검색 이름표는 웹처럼 누를 수 없다(clickable:false) — 아래 핀을 가리지 않게 눌림을 지나 보낸다.
        const tappable = interactive && !searchLabel;
        const el = buildMarkerElement(marker, tappable, () => handleMarkerTap(entry));
        entry.overlay = new ns.CustomOverlay({
          position,
          content: el,
          ...overlayAnchor(markerAnchorKind(marker)),
          zIndex,
          clickable: tappable,
        });
      }
      entry.overlay.setMap(map);
      entries.set(marker.id, entry);
    }
    for (const [id, entry] of entries) {
      if (seen.has(id)) continue;
      entry.overlay.setMap(null);
      entries.delete(id);
    }

    function handleMarkerTap(entry: MarkerEntry) {
      const cb = cbRef.current;
      if (!cb.interactive) return;
      lastMarkerTapRef.current = Date.now();
      const m = entry.marker;
      if (m.kind === 'pin' && m.groupIds && m.groupIds.length > 1) cb.onGroupPress?.(m);
      else cb.onMarkerPress?.(m);
    }
  }, [ready, markers, interactive]);

  // ── 내 위치 점 ──
  const userLat = userLocation?.latitude;
  const userLng = userLocation?.longitude;
  const userVariant = userLocation?.variant === 'plain' ? 'plain' : 'halo';
  useEffect(() => {
    const map = mapRef.current;
    const ns = nsRef.current;
    if (!ready || !map || !ns || userLat === undefined || userLng === undefined) return undefined;
    if (!Number.isFinite(userLat) || !Number.isFinite(userLng)) return undefined;
    const overlay = new ns.CustomOverlay({
      position: new ns.LatLng(userLat, userLng),
      content: buildUserDot(userVariant),
      xAnchor: 0.5,
      yAnchor: 0.5,
      zIndex: userVariant === 'plain' ? 40 : 10,
      clickable: false,
    });
    overlay.setMap(map);
    return () => overlay.setMap(null);
  }, [ready, userLat, userLng, userVariant]);

  // ── 묶음 말풍선(웹 CustomOverlay — yAnchor 1.3 · zIndex 50 · clickable) ──
  const popoverRef = useRef(popover);
  popoverRef.current = popover;
  const popoverKey = popover
    ? `${popover.coordinate.latitude}|${popover.coordinate.longitude}|${popover.title}|${popover.items.map((i) => `${i.id}:${i.label}`).join('|')}`
    : '';
  useEffect(() => {
    const map = mapRef.current;
    const ns = nsRef.current;
    const p = popoverRef.current;
    if (!ready || !map || !ns || !p || !popoverKey) return undefined;
    if (!Number.isFinite(p.coordinate.latitude) || !Number.isFinite(p.coordinate.longitude)) return undefined;
    const overlay = new ns.CustomOverlay({
      position: new ns.LatLng(p.coordinate.latitude, p.coordinate.longitude),
      content: buildPopoverElement(p, (id) => {
        lastMarkerTapRef.current = Date.now();
        cbRef.current.onPopoverPick?.(id);
      }),
      ...overlayAnchor('popover'),
      zIndex: POPOVER_Z,
      clickable: true,
    });
    overlay.setMap(map);
    return () => overlay.setMap(null);
  }, [ready, popoverKey]);

  // ── 원 ──
  useEffect(() => {
    const map = mapRef.current;
    const ns = nsRef.current;
    if (!ready || !map || !ns) return undefined;
    const overlays: KakaoOverlay[] = [];
    for (const c of circles) {
      if (!Number.isFinite(c.center.latitude) || !Number.isFinite(c.center.longitude) || !(c.radiusM > 0)) continue;
      const stroke = parseCssColor(c.strokeColor);
      const fill = parseCssColor(c.fillColor);
      const circle = new ns.Circle({
        center: new ns.LatLng(c.center.latitude, c.center.longitude),
        radius: c.radiusM,
        strokeWeight: c.strokeWidth ?? 2,
        strokeColor: stroke.color,
        strokeOpacity: stroke.opacity,
        strokeStyle: c.dashed ? 'dashed' : 'solid',
        fillColor: fill.color,
        fillOpacity: fill.opacity,
        zIndex: c.zIndex ?? 1,
      });
      circle.setMap(map);
      overlays.push(circle);
    }
    return () => { for (const o of overlays) o.setMap(null); };
  }, [ready, circles]);

  // ── 선 ──
  useEffect(() => {
    const map = mapRef.current;
    const ns = nsRef.current;
    if (!ready || !map || !ns) return undefined;
    const overlays: KakaoOverlay[] = [];
    for (const p of polylines) {
      const path = p.coordinates
        .filter((c) => Number.isFinite(c.latitude) && Number.isFinite(c.longitude))
        .map((c) => new ns.LatLng(c.latitude, c.longitude));
      if (path.length < 2) continue;
      const stroke = parseCssColor(p.strokeColor);
      const line = new ns.Polyline({
        path,
        strokeWeight: p.strokeWidth ?? 3,
        strokeColor: stroke.color,
        strokeOpacity: stroke.opacity,
        // 웹 CourseMap 의 코스 순서선과 같은 'shortdash'.
        strokeStyle: p.dashed ? 'shortdash' : 'solid',
        zIndex: p.zIndex ?? 2,
      });
      line.setMap(map);
      overlays.push(line);
    }
    return () => { for (const o of overlays) o.setMap(null); };
  }, [ready, polylines]);

  if (!MAP_AVAILABLE) {
    // 지도 없이도 화면의 나머지(카드·칩·목록)는 쓸 수 있게 자리만 둔다 — 웹 폴백과 같은 한지 그라데이션.
    return (
      <View style={[styles.root, style]} testID={testID}>
        <div aria-hidden style={UNAVAILABLE_FILL} />
      </View>
    );
  }

  return (
    <View
      style={[styles.root, style, !ready && !unavailable && { backgroundColor: MAP_COLORS.unavailable }]}
      onLayout={handleLayout}
      testID={testID}
    >
      {unavailable ? <div aria-hidden style={UNAVAILABLE_FILL} /> : null}
      <div
        ref={containerRef}
        className={muted ? `${MAP_CLASS} ${MUTED_CLASS}` : MAP_CLASS}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
    </View>
  );
}

/** 웹 `bg-gradient-to-b from-hanji-deep/70 via-hanji-deep/40 to-hanji`. */
const UNAVAILABLE_FILL = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundImage: `linear-gradient(to bottom, ${MAP_UNAVAILABLE_GRADIENT[0]} 0%, ${MAP_UNAVAILABLE_GRADIENT[1]} 50%, ${MAP_UNAVAILABLE_GRADIENT[2]} 100%)`,
} as const;

export default NextSpotMap;

// ── 마커 DOM ─────────────────────────────────────────────────────────────────────────────────

function markerAnchorKind(marker: NextSpotMarker): 'bottom' | 'center' | 'above' | 'search' {
  if (marker.kind === 'pin') return 'bottom';
  if (marker.kind === 'label' && marker.variant === 'search') return 'search';
  if (marker.kind === 'label' && marker.above) return 'above';
  return 'center';
}

function markerZIndex(marker: NextSpotMarker): number {
  switch (marker.kind) {
    case 'pin': return marker.zIndex ?? marker.pin.zIndex;
    case 'number': return marker.zIndex ?? (marker.emphasized ? 60 : 50);
    case 'dot': return marker.zIndex ?? 59;
    case 'label': return marker.zIndex ?? (marker.variant === 'search' ? SEARCH_LABEL_Z : 60);
    case 'default': return marker.zIndex ?? 0;
    default: return 0;
  }
}

/** 내용이 바뀌었는지 가리는 키 — 같으면 DOM 을 다시 만들지 않는다. 앵커는 오버레이를 만들 때 정해지므로 함께 넣는다. */
function markerContentKey(marker: NextSpotMarker): string {
  switch (marker.kind) {
    case 'pin':
      return `pin|${pinContentKey(marker.pin, marker.placeType, { selected: marker.selected, dark: marker.dark })}|${marker.title ?? ''}`;
    case 'number':
      return `number|${marker.label}|${marker.emphasized ? 1 : 0}|${marker.title ?? ''}`;
    case 'dot':
      return `dot|${marker.color}|${marker.size ?? 12}|${marker.title ?? ''}`;
    case 'label':
      return `label|${marker.variant ?? 'festival'}|${marker.text}|${marker.color ?? ''}|${marker.above ? 1 : 0}`;
    case 'default':
      return `default|${marker.title ?? ''}`;
    default:
      return 'unknown';
  }
}

function setStyle(el: HTMLElement, style: Partial<CSSStyleDeclaration>) {
  Object.assign(el.style, style);
}

function buildMarkerElement(marker: NextSpotMarker, interactive: boolean, onTap: () => void): HTMLElement {
  const el = document.createElement('div');
  setStyle(el, { boxSizing: 'border-box', userSelect: 'none', fontFamily: 'inherit' });
  const title = marker.kind === 'label' ? (marker.title ?? marker.text) : marker.title;
  if (title) {
    el.title = title;
    el.setAttribute('aria-label', title);
  }
  if (interactive) {
    el.style.cursor = 'pointer';
    el.setAttribute('role', 'button');
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      onTap();
    });
  } else {
    el.style.pointerEvents = 'none';
  }

  switch (marker.kind) {
    case 'pin': {
      const img = document.createElement('img');
      img.src = pinSvg(marker.pin, marker.placeType, { selected: marker.selected, dark: marker.dark });
      img.width = marker.pin.width;
      img.height = marker.pin.height;
      img.alt = '';
      img.draggable = false;
      setStyle(img, { display: 'block', width: `${marker.pin.width}px`, height: `${marker.pin.height}px` });
      el.appendChild(img);
      break;
    }
    case 'number': {
      const { size, fontSize } = numberMarkerSize(marker.emphasized);
      setStyle(el, {
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: '9999px',
        background: MAP_COLORS.gold,
        border: `2px solid ${MAP_COLORS.white}`,
        boxShadow: '0 2px 8px rgba(193,154,62,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: MAP_COLORS.white,
        fontWeight: '800',
        fontSize: `${fontSize}px`,
        lineHeight: '1',
      });
      el.textContent = String(marker.label);
      break;
    }
    case 'dot': {
      const size = (marker.size ?? 12) + 4;
      setStyle(el, {
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: '9999px',
        background: marker.color,
        border: `2px solid ${MAP_COLORS.white}`,
        boxShadow: '0 2px 8px rgba(43,35,32,0.3)',
      });
      break;
    }
    case 'label': {
      if (marker.variant === 'search') {
        // 웹 /main 검색 이름표: rounded-full border border-gold/50 bg-white/95 px-2.5 py-1 text-[11px] font-bold text-muk
        // shadow-[0_2px_10px_rgba(43,35,32,0.14)] whitespace-nowrap(줄 높이는 웹 본문 1.5 를 물려받는다 — 16.5).
        setStyle(el, {
          borderRadius: '9999px',
          border: '1px solid rgba(193,154,62,0.5)',
          background: 'rgba(255,255,255,0.95)',
          padding: '4px 10px',
          color: MAP_COLORS.muk,
          fontSize: '11px',
          lineHeight: '16.5px',
          fontWeight: '700',
          whiteSpace: 'nowrap',
          boxShadow: '0 2px 10px rgba(43,35,32,0.14)',
        });
        el.textContent = marker.text;
        break;
      }
      setStyle(el, {
        height: `${LABEL_HEIGHT}px`,
        lineHeight: `${LABEL_HEIGHT - 4}px`,
        padding: '0 12px',
        maxWidth: '240px',
        borderRadius: `${LABEL_HEIGHT / 2}px`,
        border: `2px solid ${MAP_COLORS.white}`,
        background: marker.color ?? MAP_COLORS.gold,
        color: MAP_COLORS.white,
        fontSize: '11px',
        fontWeight: '700',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        boxShadow: '0 4px 14px rgba(43,35,32,0.28)',
      });
      el.textContent = marker.text;
      break;
    }
    default:
      break;
  }
  return el;
}

function buildUserDot(variant: 'halo' | 'plain'): HTMLElement {
  const outerEl = document.createElement('div');
  const inner = document.createElement('div');
  setStyle(outerEl, { display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '9999px', pointerEvents: 'none' });
  if (variant === 'plain') {
    const { core, border, outer } = USER_DOT.plain;
    setStyle(outerEl, { width: `${outer}px`, height: `${outer}px`, background: 'rgba(43,35,32,0.15)' });
    const d = core + border * 2;
    setStyle(inner, {
      boxSizing: 'border-box',
      width: `${d}px`,
      height: `${d}px`,
      borderRadius: '9999px',
      background: MAP_COLORS.muk,
      border: `${border}px solid ${MAP_COLORS.white}`,
    });
    outerEl.appendChild(inner);
    return outerEl;
  }
  // 웹 /main user-loc-marker: 100 상자 · 금빛 번짐(맥박 1.2초) · 흰 원 28(그림자) · 금 점 14.
  const { outer, ring, core } = USER_DOT.halo;
  setStyle(outerEl, { position: 'relative', width: `${outer}px`, height: `${outer}px` });
  const glow = document.createElement('div');
  glow.className = USER_GLOW_CLASS;
  setStyle(glow, { position: 'absolute', top: '0', left: '0', right: '0', bottom: '0', borderRadius: '50%', background: USER_HALO_CSS_GRADIENT });
  setStyle(inner, {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: `${ring}px`,
    height: `${ring}px`,
    borderRadius: '9999px',
    background: MAP_COLORS.white,
    boxShadow: '0 0 10px rgba(43,35,32,0.25)',
  });
  const dot = document.createElement('div');
  setStyle(dot, { width: `${core}px`, height: `${core}px`, borderRadius: '9999px', background: MAP_COLORS.gold });
  inner.appendChild(dot);
  outerEl.appendChild(glow);
  outerEl.appendChild(inner);
  return outerEl;
}

/**
 * 같은 건물 묶음 말풍선 — 웹 /main(`page.tsx` isGroup 분기) DOM 을 값으로:
 * bg-white/90 backdrop-blur border-line rounded-2xl p-2 shadow-[0_2px_14px_rgba(43,35,32,0.1)] flex-col gap-1
 * min-w-180 max-w-280 max-h-260 overflow-y-auto no-scrollbar. 머리 11px gold-deep bold px-2 py-1 mb-1 border-b tracking-wider,
 * 가게 버튼 12px semibold 먹 px-3 py-2.5 rounded-xl leading-snug break-keep(누르면 웹처럼 선택).
 */
function buildPopoverElement(popover: MapPopover, onPick: (id: string) => void): HTMLElement {
  const root = document.createElement('div');
  root.className = POPOVER_CLASS;
  setStyle(root, {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: '180px',
    maxWidth: '280px',
    maxHeight: '260px',
    overflowY: 'auto',
    padding: '8px',
    borderRadius: '16px',
    border: `1px solid ${LINE}`,
    background: 'rgba(255,255,255,0.9)',
    backdropFilter: 'blur(8px)',
    boxShadow: '0 2px 14px rgba(43,35,32,0.1)',
    fontFamily: 'inherit',
    pointerEvents: 'auto',
  });
  root.style.setProperty('-webkit-backdrop-filter', 'blur(8px)');

  const title = document.createElement('div');
  setStyle(title, {
    fontSize: '11px',
    lineHeight: '16.5px',
    fontWeight: '700',
    color: GOLD_DEEP,
    padding: '4px 8px',
    marginBottom: '4px',
    borderBottom: `1px solid ${LINE}`,
    letterSpacing: '0.05em',
  });
  title.textContent = popover.title;
  root.appendChild(title);

  for (const item of popover.items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    setStyle(btn, {
      display: 'block',
      textAlign: 'left',
      color: MAP_COLORS.muk,
      fontSize: '12px',
      lineHeight: '16.5px',
      fontWeight: '600',
      fontFamily: 'inherit',
      padding: '10px 12px',
      borderRadius: '12px',
      border: '0',
      background: 'transparent',
      whiteSpace: 'normal',
      wordBreak: 'keep-all',
      cursor: 'pointer',
      transition: 'background-color 150ms',
    });
    btn.textContent = item.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onPick(item.id);
    });
    root.appendChild(btn);
  }
  return root;
}

const styles = StyleSheet.create({
  root: { overflow: 'hidden' },
});
