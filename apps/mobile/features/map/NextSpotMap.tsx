// <NextSpotMap> — 앱의 유일한 지도 컴포넌트(docs/MOBILE_APP_PLAN.md §6.1).
//
// 화면은 이 파일과 ./types·./geometry·./declutter 만 쓰고 react-native-maps 를 직접 import 하지 않는다.
// 공급자는 안드로이드 = 구글(키 필요), iOS = 애플 지도(키 없음). 네이버로 바꿀 때는 이 폴더 안에서만 고친다.
//
// 웹(카카오)과 다른 점:
// - 좌표→화면 변환이 비동기라 핀 겹침 계산은 영역(Region) + 상자 크기로 직접 한다(declutter.ts). 이 컴포넌트는
//   onRegionChangeComplete 로 { region, size, level } 을 알려 주고, 화면이 declutterPins 로 그릴 핀을 고른다.
// - 영역 맞춤·가운데 맞춤은 공급자 fitToCoordinates 대신 geometry.fitRegion·regionCenteredInBand 로 영역을 계산해
//   animateToRegion 한다(안드로이드 edgePadding 단위 차이를 피하고, 확대 하한을 한 번에 건다).
// - 내 위치는 showsUserLocation 이 아니라 직접 그린 점이다(화면이 넘긴 좌표에만 — 거부·경주 밖이면 화면이 넘기지 않는다).
// - mapPadding(구글 로고가 카드·시트 밑에 숨지 않게 — 약관): 구글은 패딩 안쪽 사각형 기준으로 카메라를 움직이고 영역을 알려 주므로,
//   이 래퍼가 주고받는 영역을 '상자 전체' 기준으로 바꿔 화면 계산(띠 가운데 맞춤·핀 겹침)은 패딩과 무관하게 둔다(geometry 의 패딩 함수).
// - 묶음 핀 말풍선(popover)은 지도 위 RN View — pointForCoordinate 로 자리를 잡고 지도가 움직이면 따라간다.

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import MapView, { Circle, Marker, Polyline, type MapPressEvent, type Region as RNRegion } from 'react-native-maps';
import Constants from 'expo-constants';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle as SvgCircle, Defs, RadialGradient, Stop, SvgXml } from 'react-native-svg';

import { REGION } from '@/lib/region';
import { colors, fontFamilies } from '~/lib/theme/tokens';
import { Text as AppText } from '~/components/ui/Text';

import {
  circleRing,
  DEFAULT_KAKAO_LEVEL,
  DEFAULT_VIEW_SIZE,
  fitPaddingForInsets,
  fitRegion,
  kakaoLevelRounded,
  normalizePadding,
  regionCenteredInBand,
  regionForKakaoLevel,
  regionFromCorners,
  regionInsidePadding,
  regionOutsidePadding,
  type EdgePadding,
  type ScreenPoint,
} from './geometry';
import { isMapAvailable } from './mapAvailability';
import {
  DEFAULT_PIN,
  DEFAULT_PIN_XML,
  GOOGLE_MUTED_STYLE,
  MAP_COLORS,
  MAP_UNAVAILABLE_GRADIENT,
  markerAnchor,
  numberMarkerSize,
  pinContentKey,
  pinXml,
  SEARCH_LABEL_HEIGHT,
  SEARCH_LABEL_SHADOW_PAD,
  searchLabelAnchor,
  USER_DOT,
  userHaloStops,
  type MarkerAnchorKind,
} from './pins';
import type {
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
  /** 지도가 멈췄다(웹 'idle'). 첫 준비 때도 한 번 불린다. isGesture 는 구글에서만 참이 될 수 있다. */
  onRegionChangeComplete?: (viewport: MapViewport, info: { isGesture: boolean }) => void;
  /** 사용자가 지도를 만졌다(웹 dragstart·zoom_start·click — 음성 안내 끊기 등). 마커 탭도 포함. */
  onUserTouch?: () => void;
  /** 지도가 준비됐다. onUnavailable 뒤에 오면 복구된 것이다(웹 빌드의 늦은 SDK). */
  onMapReady?: () => void;
  /**
   * 지도를 그릴 수 없다(웹 /main 의 mapUnavailable · CourseMap 의 unavailable). 상태가 바뀔 때 한 번 불린다.
   * 네이티브가 알 수 있는 실패는 키 없음(MAP_AVAILABLE=false)뿐이다(검토 R1 — 구글은 키·네트워크 실패를 콜백으로 알리지 않는다).
   * 웹 빌드는 키 없음 + 카카오 SDK 를 unavailableTimeoutMs 안에 못 받음.
   */
  onUnavailable?: () => void;
  /** 웹 빌드의 SDK 대기 상한(ms) — 웹 홈 8000 · 코스 3000. 기본 15000(지금 값). 네이티브는 쓰지 않는다. */
  unavailableTimeoutMs?: number;
  /**
   * 지도 가장자리 중 카드·시트·막대가 덮는 두께(dp). 안드로이드 구글은 로고·저작권을 그 안쪽으로 올린다(약관 — 숨기면 안 된다),
   * iOS 애플은 법적 표시·로고만 옮긴다. 카메라 API·onRegionChangeComplete 는 계속 '상자 전체' 기준이다. 웹 빌드(카카오)는 쓰지 않는다.
   * 기본 없음.
   */
  mapPadding?: Partial<EdgePadding>;
  /** 지도 위 말풍선 목록(같은 건물 묶음 핀 — 웹 CustomOverlay). 기본 없음. */
  popover?: MapPopover | null;
  /** 말풍선의 항목을 눌렀다(id). 닫기는 화면이 popover 를 null 로. */
  onPopoverPick?: (id: string) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  ref?: Ref<NextSpotMapHandle>;
}

const DEFAULT_DURATION_MS = 400;
/** 마커가 처음 그려진 뒤 이만큼 지나면 tracksViewChanges 를 끈다(안드로이드는 마커 뷰를 비트맵으로 굳힌다). */
const TRACK_SETTLE_MS = 600;
/** iOS 에서 마커 탭이 지도 탭으로도 오는 경우를 거른다. */
const MARKER_TAP_GUARD_MS = 350;

export const DEFAULT_INITIAL_REGION: Region = regionForKakaoLevel(
  { latitude: REGION.center.lat, longitude: REGION.center.lng },
  DEFAULT_KAKAO_LEVEL,
  DEFAULT_VIEW_SIZE,
);

/**
 * 안드로이드 구글 지도는 키가 없으면 MapView 를 여는 순간 앱이 죽는다("API key not found") — 키 없는 빌드는 지도를 그리지 않는다.
 * 키 유무는 extra.googleMapsConfigured 로 읽는다(android.config 는 배포 빌드에서 지워진다 — ./mapAvailability).
 */
export const MAP_AVAILABLE = isMapAvailable(Platform.OS, Constants.expoConfig?.extra);

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
  mapPadding,
  popover = null,
  onPopoverPick,
  style,
  testID,
  ref,
}: NextSpotMapProps) {
  const mapRef = useRef<MapView>(null);
  /** 마지막으로 알려진 영역 — 늘 '상자 전체' 기준(패딩과 무관). */
  const regionRef = useRef<Region>(initialRegion);
  const sizeRef = useRef<ViewSize | null>(null);
  const lastMarkerTapRef = useRef(0);
  const readyRef = useRef(false);
  const [mapReady, setMapReady] = useState(false);

  const isIOS = Platform.OS === 'ios';
  const isAndroid = Platform.OS === 'android';

  // ── 패딩(구글 로고 약관) ──
  const padding = useMemo(
    () => normalizePadding({ top: mapPadding?.top, right: mapPadding?.right, bottom: mapPadding?.bottom, left: mapPadding?.left }),
    [mapPadding?.top, mapPadding?.right, mapPadding?.bottom, mapPadding?.left],
  );
  const paddingKey = padding ? `${padding.top}|${padding.right}|${padding.bottom}|${padding.left}` : '';
  const paddingRef = useRef(padding);
  paddingRef.current = padding;
  /**
   * 구글이 알려 주는 영역(getVisibleRegion)이 패딩 안쪽 기준인가. 카메라 이동이 안쪽 기준인 것은 문서에 있지만, 읽어 오는 영역은
   * 문서에 없어 첫 이벤트 때 pointForCoordinate 로 한 번 잰다(null = 아직 모름 → 안쪽으로 본다).
   */
  const providerPaddedRef = useRef<boolean | null>(null);
  const probingRef = useRef(false);
  /** 공급자가 마지막으로 알려 준 영역 그대로(재고 나서 다시 바꿀 때 쓴다). */
  const rawRegionRef = useRef<Region | null>(null);

  const activePadding = useCallback((): { padding: EdgePadding; size: ViewSize } | null => {
    const p = paddingRef.current;
    const size = sizeRef.current;
    if (!isAndroid || !p || !size || size.width <= 0 || size.height <= 0) return null;
    return { padding: p, size };
  }, [isAndroid]);

  /** 상자 전체 영역 → 공급자에 보낼 영역(구글은 패딩 안쪽 사각형에 맞춘다). */
  const toProvider = useCallback((full: Region): Region => {
    const a = activePadding();
    return a ? regionInsidePadding(full, a.size, a.padding) : full;
  }, [activePadding]);

  /** 공급자가 알려 준 영역 → 상자 전체 영역. */
  const fromProvider = useCallback((raw: Region): Region => {
    const a = activePadding();
    if (!a || providerPaddedRef.current === false) return raw;
    return regionOutsidePadding(raw, a.size, a.padding);
  }, [activePadding]);

  const viewport = useCallback((): MapViewport | null => {
    const size = sizeRef.current;
    if (!size || size.width <= 0 || size.height <= 0) return null;
    const region = regionRef.current;
    return { region, size, level: kakaoLevelRounded(region, size) };
  }, []);

  const emitViewport = useCallback((isGesture: boolean) => {
    const v = viewport();
    if (v) onRegionChangeComplete?.(v, { isGesture });
  }, [onRegionChangeComplete, viewport]);

  const moveTo = useCallback((region: Region, duration: number) => {
    regionRef.current = region;
    mapRef.current?.animateToRegion(toProvider(region), Math.max(0, duration));
  }, [toProvider]);

  const pointFor = useCallback(async (coordinate: LatLng): Promise<ScreenPoint | null> => {
    const map = mapRef.current;
    if (!map || !Number.isFinite(coordinate.latitude) || !Number.isFinite(coordinate.longitude)) return null;
    try {
      const pt = await map.pointForCoordinate(coordinate);
      return Number.isFinite(pt.x) && Number.isFinite(pt.y) ? { x: pt.x, y: pt.y } : null;
    } catch {
      return null;
    }
  }, []);

  useImperativeHandle(ref, (): NextSpotMapHandle => ({
    fitToCoordinates(coordinates, options = {}) {
      const size = sizeRef.current ?? DEFAULT_VIEW_SIZE;
      const padding = options.padding ?? (options.insets ? fitPaddingForInsets(options.insets, size) : undefined);
      const region = fitRegion(coordinates, size, padding, { minLevel: options.minLevel, maxLevel: options.maxLevel });
      if (region) moveTo(region, options.duration ?? DEFAULT_DURATION_MS);
    },
    animateTo(target, options = {}) {
      if (!Number.isFinite(target.latitude) || !Number.isFinite(target.longitude)) return;
      const size = sizeRef.current ?? DEFAULT_VIEW_SIZE;
      const scale = options.level !== undefined ? { level: options.level } : { region: regionRef.current };
      moveTo(regionCenteredInBand(target, size, options.insets ?? {}, scale), options.duration ?? DEFAULT_DURATION_MS);
    },
    getRegion: () => regionRef.current,
    getViewport: viewport,
    pointForCoordinate: pointFor,
  }), [moveTo, pointFor, viewport]);

  /**
   * 패딩이 있을 때 한 번: 구글이 알려 준 영역의 북동·남서 모서리가 화면 어디에 오는지 재서, 영역이 패딩 안쪽 기준인지 정한다.
   * 다르게 봤었다면 마지막 영역을 다시 바꿔 알린다.
   */
  const probeProviderPadding = useCallback((raw: Region) => {
    const a = activePadding();
    const map = mapRef.current;
    if (!a || !map || providerPaddedRef.current !== null || probingRef.current) return;
    probingRef.current = true;
    const ne = { latitude: raw.latitude + raw.latitudeDelta / 2, longitude: raw.longitude + raw.longitudeDelta / 2 };
    const sw = { latitude: raw.latitude - raw.latitudeDelta / 2, longitude: raw.longitude - raw.longitudeDelta / 2 };
    Promise.all([map.pointForCoordinate(ne), map.pointForCoordinate(sw)])
      .then(([pne, psw]) => {
        const { padding: p, size } = a;
        const err = (pts: [number, number, number, number]) =>
          Math.abs(pne.x - pts[0]) + Math.abs(pne.y - pts[1]) + Math.abs(psw.x - pts[2]) + Math.abs(psw.y - pts[3]);
        const padded = err([size.width - p.right, p.top, p.left, size.height - p.bottom]);
        const full = err([size.width, 0, 0, size.height]);
        const wasAssumedPadded = providerPaddedRef.current !== false;
        providerPaddedRef.current = padded <= full;
        if (wasAssumedPadded !== providerPaddedRef.current && rawRegionRef.current) {
          regionRef.current = fromProvider(rawRegionRef.current);
          emitViewport(false);
        }
      })
      .catch(() => {})
      .finally(() => {
        probingRef.current = false;
      });
  }, [activePadding, emitViewport, fromProvider]);

  // ── 말풍선(popover) 자리 ──
  const popoverRef = useRef(popover);
  popoverRef.current = popover;
  const popoverKey = popover
    ? `${popover.coordinate.latitude}|${popover.coordinate.longitude}|${popover.title}|${popover.items.map((i) => `${i.id}:${i.label}`).join('|')}`
    : '';
  const [popoverPoint, setPopoverPoint] = useState<ScreenPoint | null>(null);
  const pointBusyRef = useRef(false);
  const pointDirtyRef = useRef(false);
  const refreshPopoverRef = useRef<() => void>(() => {});
  refreshPopoverRef.current = () => {
    const p = popoverRef.current;
    if (!p || !readyRef.current) return;
    if (pointBusyRef.current) {
      pointDirtyRef.current = true;
      return;
    }
    pointBusyRef.current = true;
    const target = p.coordinate;
    pointFor(target)
      .then((pt) => {
        const now = popoverRef.current;
        if (pt && now && now.coordinate.latitude === target.latitude && now.coordinate.longitude === target.longitude) {
          setPopoverPoint((prev) => (prev && prev.x === pt.x && prev.y === pt.y ? prev : pt));
        }
      })
      .finally(() => {
        pointBusyRef.current = false;
        if (pointDirtyRef.current) {
          pointDirtyRef.current = false;
          refreshPopoverRef.current();
        }
      });
  };
  useEffect(() => {
    setPopoverPoint(null);
    if (popoverKey && mapReady) refreshPopoverRef.current();
  }, [popoverKey, mapReady]);
  const handleRegionChange = useCallback(() => refreshPopoverRef.current(), []);

  // ── 지도 없음 알림 ──
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;
  useEffect(() => {
    if (!MAP_AVAILABLE) onUnavailableRef.current?.();
  }, []);

  // 패딩이 바뀌면 구글은 패딩 안쪽 가운데를 지킨다 — 상자 전체에서 보던 영역을 그대로 다시 맞춘다(지도가 밀리지 않게).
  const appliedPaddingKeyRef = useRef(paddingKey);
  useEffect(() => {
    if (appliedPaddingKeyRef.current === paddingKey) return;
    appliedPaddingKeyRef.current = paddingKey;
    if (readyRef.current) moveTo(regionRef.current, 0);
  }, [paddingKey, moveTo]);

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    const prev = sizeRef.current;
    sizeRef.current = { width, height };
    // 상자 크기가 처음 정해지거나 바뀌면 핀 겹침을 다시 계산하도록 알린다.
    if (readyRef.current && (!prev || prev.width !== width || prev.height !== height)) emitViewport(false);
  }, [emitViewport]);

  const handleReady = useCallback(() => {
    readyRef.current = true;
    setMapReady(true);
    onMapReady?.();
    const map = mapRef.current;
    if (!map) return;
    if (activePadding()) {
      // 첫 영역은 패딩이 걸리기 전에 놓였을 수 있다 — 상자 전체 기준 첫 영역으로 다시 맞춘다(뒤따르는 'idle' 이 영역을 알린다).
      moveTo(regionRef.current, 0);
      return;
    }
    // 첫 'idle' — 실제로 보이는 영역을 읽어 알린다(애플 지도는 첫 onRegionChangeComplete 를 안 줄 수 있다).
    map.getMapBoundaries()
      .then(({ northEast, southWest }) => {
        if (northEast && southWest) regionRef.current = regionFromCorners(northEast, southWest);
        emitViewport(false);
      })
      .catch(() => emitViewport(false));
  }, [activePadding, emitViewport, moveTo, onMapReady]);

  const handleRegionComplete = useCallback((region: RNRegion, details?: { isGesture?: boolean }) => {
    rawRegionRef.current = region;
    regionRef.current = fromProvider(region);
    emitViewport(details?.isGesture === true);
    probeProviderPadding(region);
    if (popoverRef.current) refreshPopoverRef.current();
  }, [emitViewport, fromProvider, probeProviderPadding]);

  const handleMapPress = useCallback((e: MapPressEvent) => {
    if (!onMapPress) return;
    if (e.nativeEvent.action === 'marker-press') return;
    if (Date.now() - lastMarkerTapRef.current < MARKER_TAP_GUARD_MS) return;
    onMapPress(e.nativeEvent.coordinate);
  }, [onMapPress]);

  const handleMarkerPress = useCallback((marker: NextSpotMarker) => {
    lastMarkerTapRef.current = Date.now();
    if (marker.kind === 'pin' && marker.groupIds && marker.groupIds.length > 1) onGroupPress?.(marker);
    else onMarkerPress?.(marker);
  }, [onGroupPress, onMarkerPress]);

  if (!MAP_AVAILABLE) {
    // 지도 없이도 화면의 나머지(카드·칩·목록)는 쓸 수 있게 자리만 둔다 — 웹 폴백과 같은 한지 그라데이션.
    return (
      <View style={[styles.root, style]} testID={testID}>
        <LinearGradient
          colors={MAP_UNAVAILABLE_GRADIENT}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      </View>
    );
  }

  return (
    <View style={[styles.root, style]} onLayout={handleLayout} onTouchStart={onUserTouch} testID={testID}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        // 안드로이드 = 구글(기본) · iOS = 애플(기본, 키 없음). 공급자를 고정하지 않는다.
        customMapStyle={muted && !isIOS ? GOOGLE_MUTED_STYLE : undefined}
        mapType={muted && isIOS ? 'mutedStandard' : 'standard'}
        // 구글은 로고·저작권을 패딩 안쪽으로 올린다(카메라도 안쪽 기준 — toProvider·fromProvider 가 맞춘다).
        // 애플은 카메라를 건드리지 않게 법적 표시만 옮긴다.
        mapPadding={isAndroid && padding ? padding : undefined}
        legalLabelInsets={isIOS && padding ? padding : undefined}
        scrollEnabled={interactive}
        zoomEnabled={interactive}
        rotateEnabled={false}
        pitchEnabled={false}
        toolbarEnabled={false}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        showsIndoors={false}
        moveOnMarkerPress={false}
        onMapReady={handleReady}
        onRegionChange={popover ? handleRegionChange : undefined}
        onRegionChangeComplete={handleRegionComplete}
        onPress={interactive ? handleMapPress : undefined}
      >
        {circles.map((c) => <CircleOverlay key={c.id} circle={c} />)}
        {polylines.map((p) => (
          <Polyline
            key={p.id}
            coordinates={p.coordinates}
            strokeColor={p.strokeColor}
            strokeWidth={p.strokeWidth ?? 3}
            lineDashPattern={p.dashed ? [8, 6] : undefined}
            zIndex={p.zIndex ?? 2}
          />
        ))}
        {userLocation ? <UserDot location={userLocation} /> : null}
        {markers.map((m) => (
          <MarkerView key={m.id} marker={m} onPress={interactive ? handleMarkerPress : undefined} />
        ))}
      </MapView>
      {popover ? <PopoverView popover={popover} point={popoverPoint} onPick={onPopoverPick} /> : null}
    </View>
  );
}

export default NextSpotMap;

// ── 오버레이 ──────────────────────────────────────────────────────────────────

function CircleOverlay({ circle }: { circle: NextSpotCircle }) {
  const ring = useMemo(
    () => (circle.dashed ? circleRing(circle.center, circle.radiusM) : null),
    [circle.center, circle.radiusM, circle.dashed],
  );
  const width = circle.strokeWidth ?? 2;
  return (
    <>
      <Circle
        center={circle.center}
        radius={circle.radiusM}
        fillColor={circle.fillColor}
        // 점선은 원 위에 Polyline 고리로 그린다(안드로이드 Circle 은 점선을 지원하지 않는다).
        strokeColor={ring ? 'transparent' : circle.strokeColor}
        strokeWidth={ring ? 0 : width}
        zIndex={circle.zIndex ?? 1}
      />
      {ring ? (
        <Polyline
          coordinates={ring}
          strokeColor={circle.strokeColor}
          strokeWidth={width}
          lineDashPattern={[8, 6]}
          zIndex={(circle.zIndex ?? 1) + 1}
        />
      ) : null}
    </>
  );
}

/** 처음 한 번(그리고 contentKey 가 바뀔 때만) 마커 뷰를 다시 찍고, 그 뒤엔 tracksViewChanges 를 끈다. */
function useSettledTracking(contentKey: string): boolean {
  const [tracks, setTracks] = useState(true);
  useEffect(() => {
    setTracks(true);
    const timer = setTimeout(() => setTracks(false), TRACK_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [contentKey]);
  return tracks;
}

type AnchorSpec = ReturnType<typeof markerAnchor>;

function TrackedMarker({
  coordinate,
  contentKey,
  anchorKind,
  anchorSpec,
  height,
  zIndex,
  title,
  onPress,
  children,
}: {
  coordinate: LatLng;
  contentKey: string;
  anchorKind: MarkerAnchorKind;
  /** 주면 anchorKind 대신 이 앵커(그림자 여백을 두른 그림 등). */
  anchorSpec?: AnchorSpec;
  height: number;
  zIndex: number;
  title?: string;
  onPress?: () => void;
  children: ReactNode;
}) {
  const tracks = useSettledTracking(contentKey);
  const { anchor, centerOffset } = anchorSpec ?? markerAnchor(anchorKind, height);
  return (
    <Marker
      coordinate={coordinate}
      anchor={anchor}
      centerOffset={centerOffset}
      zIndex={zIndex}
      tracksViewChanges={tracks}
      accessibilityLabel={title}
      tappable={!!onPress}
      stopPropagation
      onPress={onPress}
    >
      {children}
    </Marker>
  );
}

const SEARCH_ANCHOR = searchLabelAnchor(SEARCH_LABEL_SHADOW_PAD);

function MarkerView({ marker, onPress }: { marker: NextSpotMarker; onPress?: (m: NextSpotMarker) => void }) {
  const press = onPress ? () => onPress(marker) : undefined;
  switch (marker.kind) {
    case 'pin': {
      const opts = { selected: marker.selected, dark: marker.dark };
      const key = pinContentKey(marker.pin, marker.placeType, opts);
      return (
        <TrackedMarker
          coordinate={marker.coordinate}
          contentKey={key}
          anchorKind="bottom"
          height={marker.pin.height}
          zIndex={marker.zIndex ?? marker.pin.zIndex}
          title={marker.title}
          onPress={press}
        >
          <PinGraphic xml={pinXml(marker.pin, marker.placeType, opts)} width={marker.pin.width} height={marker.pin.height} />
        </TrackedMarker>
      );
    }
    case 'default':
      // 카카오 기본 마커(웹 대안 화면 미니맵) — 같은 29×42 · 기준점 (14, 39).
      return (
        <TrackedMarker
          coordinate={marker.coordinate}
          contentKey="default"
          anchorKind="defaultPin"
          height={DEFAULT_PIN.height}
          zIndex={marker.zIndex ?? 0}
          title={marker.title}
          onPress={press}
        >
          <PinGraphic xml={DEFAULT_PIN_XML} width={DEFAULT_PIN.width} height={DEFAULT_PIN.height} />
        </TrackedMarker>
      );
    case 'number': {
      const { size, fontSize } = numberMarkerSize(marker.emphasized);
      return (
        <TrackedMarker
          coordinate={marker.coordinate}
          contentKey={`${marker.label}|${size}`}
          anchorKind="center"
          height={size}
          zIndex={marker.zIndex ?? (marker.emphasized ? 60 : 50)}
          title={marker.title}
          onPress={press}
        >
          <View style={[styles.number, { width: size, height: size, borderRadius: size / 2 }]}>
            <Text style={[styles.numberText, { fontSize }]} allowFontScaling={false}>{String(marker.label)}</Text>
          </View>
        </TrackedMarker>
      );
    }
    case 'dot': {
      const size = marker.size ?? 12;
      return (
        <TrackedMarker
          coordinate={marker.coordinate}
          contentKey={`${marker.color}|${size}`}
          anchorKind="center"
          height={size + 4}
          zIndex={marker.zIndex ?? 59}
          title={marker.title}
          onPress={press}
        >
          <View style={[styles.dot, { width: size + 4, height: size + 4, borderRadius: (size + 4) / 2, backgroundColor: marker.color }]} />
        </TrackedMarker>
      );
    }
    case 'label':
      if (marker.variant === 'search') {
        // 웹 검색 이름표 — 누를 수 없다(clickable:false). 그림자가 잘리지 않게 투명 여백을 두르고 앵커를 그만큼 옮긴다.
        return (
          <TrackedMarker
            coordinate={marker.coordinate}
            contentKey={`search|${marker.text}`}
            anchorKind="search"
            anchorSpec={SEARCH_ANCHOR}
            height={SEARCH_LABEL_HEIGHT}
            zIndex={marker.zIndex ?? 80}
            title={marker.title ?? marker.text}
          >
            <View style={styles.searchLabelPad}>
              <View style={styles.searchLabel}>
                <Text style={styles.searchLabelText} numberOfLines={1} allowFontScaling={false}>{marker.text}</Text>
              </View>
            </View>
          </TrackedMarker>
        );
      }
      return (
        <TrackedMarker
          coordinate={marker.coordinate}
          contentKey={`${marker.text}|${marker.color}|${marker.above ? 1 : 0}`}
          anchorKind={marker.above ? 'above' : 'center'}
          height={LABEL_HEIGHT}
          zIndex={marker.zIndex ?? 60}
          title={marker.title ?? marker.text}
          onPress={press}
        >
          <View style={[styles.label, { backgroundColor: marker.color ?? MAP_COLORS.gold }]}>
            <Text style={styles.labelText} numberOfLines={1} allowFontScaling={false}>{marker.text}</Text>
          </View>
        </TrackedMarker>
      );
    default:
      return null;
  }
}

function PinGraphic({ xml, width, height }: { xml: string; width: number; height: number }) {
  // 같은 XML 이면 다시 파싱하지 않는다.
  return useMemo(() => <SvgXml xml={xml} width={width} height={height} />, [xml, width, height]);
}

const HALO_STOPS = userHaloStops();

/** 웹 금빛 번짐(radial-gradient)의 정적 판 — 맥박은 없다(구글 마커는 비트맵으로 굳는다). */
function HaloGlow({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
      <Defs>
        <RadialGradient id="nextspotUserHalo" cx="50%" cy="50%" r="50%">
          {HALO_STOPS.map((s) => (
            <Stop key={s.offset} offset={s.offset} stopColor={MAP_COLORS.gold} stopOpacity={s.opacity} />
          ))}
        </RadialGradient>
      </Defs>
      <SvgCircle cx={size / 2} cy={size / 2} r={size / 2} fill="url(#nextspotUserHalo)" />
    </Svg>
  );
}

function UserDot({ location }: { location: UserLocationDot }) {
  const coordinate = { latitude: location.latitude, longitude: location.longitude };
  if (location.variant === 'plain') {
    // 웹 CourseMap: 14 상자(border-box)에 흰 테 3 → 먹 8, 바깥 번짐 4(0 0 0 4px 먹 .15). RN 도 테두리가 상자 안이다.
    const { core, border, outer } = USER_DOT.plain;
    const d = core + border * 2;
    return (
      <TrackedMarker coordinate={coordinate} contentKey="plain" anchorKind="center" height={outer} zIndex={40}>
        <View style={[styles.center, { width: outer, height: outer, borderRadius: outer / 2, backgroundColor: 'rgba(43,35,32,0.15)' }]}>
          <View style={{ width: d, height: d, borderRadius: d / 2, backgroundColor: MAP_COLORS.muk, borderWidth: border, borderColor: MAP_COLORS.white }} />
        </View>
      </TrackedMarker>
    );
  }
  const { outer, ring, core } = USER_DOT.halo;
  return (
    <TrackedMarker coordinate={coordinate} contentKey="halo" anchorKind="center" height={outer} zIndex={10}>
      <View style={[styles.center, { width: outer, height: outer }]}>
        <HaloGlow size={outer} />
        <View style={[styles.center, styles.userRing, { width: ring, height: ring, borderRadius: ring / 2 }]}>
          <View style={{ width: core, height: core, borderRadius: core / 2, backgroundColor: MAP_COLORS.gold }} />
        </View>
      </View>
    </TrackedMarker>
  );
}

/**
 * 같은 건물 묶음 말풍선 — 웹 /main CustomOverlay(yAnchor 1.3) 모양 그대로:
 * 흰 90% · 테 line · 둥근 16 · 안쪽 8 · 그림자 0 2 14 먹 .1 · 세로 간격 4 · 폭 180~280 · 높이 ≤260(넘치면 스크롤).
 * 머리 11px bold 금 진(자간 .05em, 아래 줄) · 가게 줄 12px semibold 먹(py 10 · px 12 · 둥근 12 · 누르면 hanji-deep).
 * 자리는 transform 으로만 옮긴다(left·top 을 바꾸면 폭 측정이 흔들린다). 웹 backdrop-blur 는 네이티브에 없다.
 */
function PopoverView({ popover, point, onPick }: { popover: MapPopover; point: ScreenPoint | null; onPick?: (id: string) => void }) {
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
  }, []);
  const visible = point !== null && box !== null;
  const tx = visible ? point.x - box.width / 2 : 0;
  const ty = visible ? point.y - box.height * POPOVER_Y_ANCHOR : 0;
  return (
    <View
      onLayout={handleLayout}
      pointerEvents={visible ? 'auto' : 'none'}
      style={[styles.popover, { opacity: visible ? 1 : 0, transform: [{ translateX: tx }, { translateY: ty }] }]}
    >
      <AppText className="text-[11px] font-bold text-gold-deep" style={styles.popoverTitle} accessibilityRole="header">
        {popover.title}
      </AppText>
      <ScrollView style={styles.popoverList} contentContainerStyle={styles.popoverListContent} showsVerticalScrollIndicator={false} nestedScrollEnabled>
        {popover.items.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            onPress={() => onPick?.(item.id)}
            style={({ pressed }) => [styles.popoverItem, pressed && styles.popoverItemPressed]}
          >
            <AppText className="text-[12px] font-semibold text-muk" style={styles.popoverItemText}>{item.label}</AppText>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const LABEL_HEIGHT = 28;
/** 웹 묶음 말풍선 yAnchor — 좌표가 말풍선 위끝에서 높이의 1.3배 아래. */
const POPOVER_Y_ANCHOR = 1.3;

const styles = StyleSheet.create({
  root: { overflow: 'hidden' },
  center: { alignItems: 'center', justifyContent: 'center' },
  number: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: MAP_COLORS.gold,
    borderWidth: 2,
    borderColor: MAP_COLORS.white,
  },
  numberText: { color: MAP_COLORS.white, fontWeight: '800' },
  dot: { borderWidth: 2, borderColor: MAP_COLORS.white },
  label: {
    height: LABEL_HEIGHT,
    paddingHorizontal: 12,
    borderRadius: LABEL_HEIGHT / 2,
    borderWidth: 2,
    borderColor: MAP_COLORS.white,
    alignItems: 'center',
    justifyContent: 'center',
    maxWidth: 240,
  },
  labelText: { color: MAP_COLORS.white, fontSize: 11, fontWeight: '700' },
  // 웹 검색 이름표: rounded-full border-gold/50 bg-white/95 px-2.5 py-1 text-[11px] font-bold text-muk shadow-[0_2px_10px_rgba(43,35,32,0.14)]
  searchLabelPad: { padding: SEARCH_LABEL_SHADOW_PAD },
  searchLabel: {
    borderRadius: 9999,
    borderWidth: 1,
    borderColor: 'rgba(193, 154, 62, 0.5)',
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    boxShadow: '0px 2px 10px rgba(43, 35, 32, 0.14)',
  },
  searchLabelText: { color: MAP_COLORS.muk, fontSize: 11, lineHeight: 16.5, fontFamily: fontFamilies.bold },
  // 웹 흰 원: 0 0 10px 먹 .25
  userRing: {
    backgroundColor: MAP_COLORS.white,
    boxShadow: '0px 0px 10px rgba(43, 35, 32, 0.25)',
  },
  popover: {
    position: 'absolute',
    left: 0,
    top: 0,
    zIndex: 50,
    minWidth: 180,
    maxWidth: 280,
    maxHeight: 260,
    padding: 8,
    gap: 4,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    boxShadow: '0px 2px 14px rgba(43, 35, 32, 0.1)',
  },
  popoverTitle: {
    lineHeight: 16.5,
    letterSpacing: 0.55,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  popoverList: { flexGrow: 0, flexShrink: 1 },
  popoverListContent: { gap: 4 },
  popoverItem: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12 },
  popoverItemPressed: { backgroundColor: colors['hanji-deep'] },
  popoverItemText: { lineHeight: 16.5 },
});
