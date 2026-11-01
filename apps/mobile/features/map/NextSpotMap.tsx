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
// - 내 위치는 showsUserLocation 이 아니라 직접 그린 점이다(경주 밖이면 화면이 위치를 황리단길 중심으로 옮긴다).

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { Platform, StyleSheet, Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import MapView, { Circle, Marker, Polyline, type MapPressEvent, type Region as RNRegion } from 'react-native-maps';
import { SvgXml } from 'react-native-svg';

import { REGION } from '@/lib/region';

import {
  circleRing,
  DEFAULT_KAKAO_LEVEL,
  DEFAULT_VIEW_SIZE,
  fitPaddingForInsets,
  fitRegion,
  kakaoLevelRounded,
  regionCenteredInBand,
  regionForKakaoLevel,
  regionFromCorners,
} from './geometry';
import { GOOGLE_MUTED_STYLE, MAP_COLORS, markerAnchor, numberMarkerSize, pinContentKey, pinXml, USER_DOT } from './pins';
import type {
  LatLng,
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
  onMapReady?: () => void;
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
  style,
  testID,
  ref,
}: NextSpotMapProps) {
  const mapRef = useRef<MapView>(null);
  const regionRef = useRef<Region>(initialRegion);
  const sizeRef = useRef<ViewSize | null>(null);
  const lastMarkerTapRef = useRef(0);
  const readyRef = useRef(false);

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
    mapRef.current?.animateToRegion(region, Math.max(0, duration));
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
  }), [moveTo, viewport]);

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    const prev = sizeRef.current;
    sizeRef.current = { width, height };
    // 상자 크기가 처음 정해지거나 바뀌면 핀 겹침을 다시 계산하도록 알린다.
    if (readyRef.current && (!prev || prev.width !== width || prev.height !== height)) emitViewport(false);
  }, [emitViewport]);

  const handleReady = useCallback(() => {
    readyRef.current = true;
    onMapReady?.();
    // 첫 'idle' — 실제로 보이는 영역을 읽어 알린다(애플 지도는 첫 onRegionChangeComplete 를 안 줄 수 있다).
    const map = mapRef.current;
    if (!map) return;
    map.getMapBoundaries()
      .then(({ northEast, southWest }) => {
        if (northEast && southWest) regionRef.current = regionFromCorners(northEast, southWest);
        emitViewport(false);
      })
      .catch(() => emitViewport(false));
  }, [emitViewport, onMapReady]);

  const handleRegionComplete = useCallback((region: RNRegion, details?: { isGesture?: boolean }) => {
    regionRef.current = region;
    emitViewport(details?.isGesture === true);
  }, [emitViewport]);

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

  const isIOS = Platform.OS === 'ios';

  return (
    <View style={[styles.root, style]} onLayout={handleLayout} onTouchStart={onUserTouch} testID={testID}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        // 안드로이드 = 구글(기본) · iOS = 애플(기본, 키 없음). 공급자를 고정하지 않는다.
        customMapStyle={muted && !isIOS ? GOOGLE_MUTED_STYLE : undefined}
        mapType={muted && isIOS ? 'mutedStandard' : 'standard'}
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

function TrackedMarker({
  coordinate,
  contentKey,
  anchorKind,
  height,
  zIndex,
  title,
  onPress,
  children,
}: {
  coordinate: LatLng;
  contentKey: string;
  anchorKind: 'bottom' | 'center' | 'above';
  height: number;
  zIndex: number;
  title?: string;
  onPress?: () => void;
  children: ReactNode;
}) {
  const tracks = useSettledTracking(contentKey);
  const { anchor, centerOffset } = markerAnchor(anchorKind, height);
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
          <View style={[styles.label, { backgroundColor: marker.color }]}>
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

function UserDot({ location }: { location: UserLocationDot }) {
  const coordinate = { latitude: location.latitude, longitude: location.longitude };
  if (location.variant === 'plain') {
    const { core, border, outer } = USER_DOT.plain;
    return (
      <TrackedMarker coordinate={coordinate} contentKey="plain" anchorKind="center" height={outer} zIndex={40}>
        <View style={[styles.center, { width: outer, height: outer, borderRadius: outer / 2, backgroundColor: 'rgba(43,35,32,0.15)' }]}>
          <View style={{ width: core + border * 2, height: core + border * 2, borderRadius: core, backgroundColor: MAP_COLORS.muk, borderWidth: border, borderColor: MAP_COLORS.white }} />
        </View>
      </TrackedMarker>
    );
  }
  const { outer, ring, core } = USER_DOT.halo;
  return (
    <TrackedMarker coordinate={coordinate} contentKey="halo" anchorKind="center" height={outer} zIndex={10}>
      <View style={[styles.center, { width: outer, height: outer, borderRadius: outer / 2, backgroundColor: 'rgba(193,154,62,0.28)' }]}>
        <View style={[styles.center, styles.userRing, { width: ring, height: ring, borderRadius: ring / 2 }]}>
          <View style={{ width: core, height: core, borderRadius: core / 2, backgroundColor: MAP_COLORS.gold }} />
        </View>
      </View>
    </TrackedMarker>
  );
}

const LABEL_HEIGHT = 28;

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
  userRing: {
    backgroundColor: MAP_COLORS.white,
    shadowColor: MAP_COLORS.muk,
    shadowOpacity: 0.25,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 0 },
    elevation: 3,
  },
});
