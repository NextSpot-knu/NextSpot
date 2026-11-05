// 지도 래퍼 눈 확인용 — 에뮬레이터에 붙여 핀 모양(등급·빈 핀·순위 고리·예측 점선·선택·묶음), 코스 번호·점선,
// 축제 600m 점선 원·라벨, 내 위치 점, 핀 겹침 줄이기(확대·축소하며 핀 수가 5·7·12 로 바뀌는지)를 본다.
// 개발용이다 — 화면 라우트에는 붙이지 않는다. 문구는 고정 영어(i18n 밖).

import { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { pinDisplay } from '@/lib/map/markerSvg';
import { REGION } from '@/lib/region';

import { declutterPins, type DeclutterItem } from './declutter';
import { COURSE_FIT_MIN_LEVEL, COURSE_FIT_PADDING } from './geometry';
import { NextSpotMap } from './NextSpotMap';
import { MAP_COLORS } from './pins';
import type { MapViewport, NextSpotMapHandle, NextSpotMarker, NextSpotPolyline } from './types';

interface SmokePlace extends DeclutterItem {
  id: string;
  name: string;
  type: string;
  level: number | null;
  rank: number | null;
  forecast?: number;
}

const ADDR = '경북 경주시 포석로 1080';

function smokePlaces(): SmokePlace[] {
  const out: SmokePlace[] = [];
  const types = ['restaurant', 'cafe', 'attraction', 'culture', 'parking'];
  // 황리단길 중심 둘레 6×6 격자(약 90m 간격) — 확대 단계별 상한·간격 확인용.
  for (let i = 0; i < 36; i += 1) {
    const dx = ((i % 6) - 2.5) * 0.001;
    const dy = (Math.floor(i / 6) - 2.5) * 0.0008;
    out.push({
      id: `p${i}`,
      name: `Place ${i}`,
      type: types[i % types.length],
      latitude: REGION.center.lat + dy,
      longitude: REGION.center.lng + dx,
      level: i % 4 === 0 ? null : (i % 10) / 10,
      rank: i < 5 ? i + 1 : null,
      forecast: i === 1 ? 0.1 : undefined,
      address: null,
    });
  }
  // 같은 건물 두 곳 — 묶음 핀 하나로 보여야 한다.
  out.unshift(
    { id: 'b1', name: 'Same building A', type: 'cafe', latitude: 35.8371, longitude: 129.2101, level: 0.8, rank: null, address: ADDR },
    { id: 'b2', name: 'Same building B', type: 'restaurant', latitude: 35.83712, longitude: 129.21015, level: 0.3, rank: null, address: ADDR },
  );
  return out;
}

const COURSE = REGION.presets.slice(1, 5).map((p) => ({ latitude: p.lat, longitude: p.lng }));

export function MapSmoke() {
  const mapRef = useRef<NextSpotMapHandle>(null);
  const places = useMemo(smokePlaces, []);
  const [viewport, setViewport] = useState<MapViewport | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState('—');
  const [forecastMode, setForecastMode] = useState(false);

  const markers = useMemo<NextSpotMarker[]>(() => {
    const now = new Date();
    const observedAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const pins: NextSpotMarker[] = declutterPins(places, viewport).map((cluster) => {
      const f = cluster.anchor;
      const isGroup = cluster.members.length > 1;
      const level = isGroup ? Math.max(...cluster.members.map((m) => m.level ?? 0)) : f.level;
      const pin = pinDisplay({
        type: f.type,
        level,
        observedAt,
        rank: f.rank,
        forecastMode,
        forecastLevel: forecastMode && f.rank ? (f.forecast ?? 0.6) : null,
        selected: selected === cluster.key,
        phone: true,
        now,
      });
      return {
        kind: 'pin',
        id: cluster.key,
        coordinate: { latitude: f.latitude, longitude: f.longitude },
        title: isGroup ? `${cluster.members.length} places` : f.name,
        pin,
        placeType: f.type,
        selected: selected === cluster.key,
        groupIds: isGroup ? cluster.members.map((m) => m.id) : undefined,
      };
    });
    const course: NextSpotMarker[] = COURSE.map((c, i) => ({
      kind: 'number', id: `stop${i}`, coordinate: c, label: i + 1, emphasized: i === 0,
    }));
    const festival: NextSpotMarker[] = [
      { kind: 'label', id: 'fest-label', coordinate: { latitude: 35.8296, longitude: 129.2156 }, text: '🏮 Festival area', color: MAP_COLORS.festivalOngoing },
      { kind: 'dot', id: 'fest-dot', coordinate: { latitude: 35.8348, longitude: 129.2265 }, color: MAP_COLORS.festivalUpcoming },
      { kind: 'label', id: 'fest-pin-label', coordinate: { latitude: 35.8348, longitude: 129.2265 }, text: '🏮 Pinned festival', color: MAP_COLORS.festivalUpcoming, above: true },
    ];
    return [...pins, ...course, ...festival];
  }, [places, viewport, selected, forecastMode]);

  const polylines = useMemo<NextSpotPolyline[]>(() => [
    { id: 'course', coordinates: COURSE, strokeColor: MAP_COLORS.gold, strokeWidth: 3, dashed: true },
  ], []);

  return (
    <View style={styles.root}>
      <NextSpotMap
        ref={mapRef}
        style={styles.map}
        markers={markers}
        polylines={polylines}
        circles={[{
          id: 'festival', center: { latitude: 35.8296, longitude: 129.2156 }, radiusM: 600,
          strokeColor: MAP_COLORS.festivalOngoing, fillColor: 'rgba(193,85,59,0.18)', dashed: true,
        }]}
        userLocation={{ latitude: REGION.center.lat, longitude: REGION.center.lng }}
        onRegionChangeComplete={(v, info) => {
          setViewport(v);
          setLastEvent(`idle level=${v.level} gesture=${info.isGesture}`);
        }}
        onMarkerPress={(m) => { setSelected(m.id); setLastEvent(`marker ${m.id}`); }}
        onGroupPress={(m) => { setSelected(m.id); setLastEvent(`group ${m.groupIds?.join(',')}`); }}
        onMapPress={(c) => { setSelected(null); setLastEvent(`map ${c.latitude.toFixed(4)},${c.longitude.toFixed(4)}`); }}
      />
      <View style={styles.bar}>
        <Text style={styles.status}>{lastEvent}</Text>
        <View style={styles.row}>
          <SmokeButton label="Fit course" onPress={() => mapRef.current?.fitToCoordinates(COURSE, { padding: COURSE_FIT_PADDING, minLevel: COURSE_FIT_MIN_LEVEL })} />
          <SmokeButton label="Center (band)" onPress={() => mapRef.current?.animateTo({ latitude: REGION.center.lat, longitude: REGION.center.lng }, { insets: { top: 120, bottom: 260 }, level: 4 })} />
          <SmokeButton label={forecastMode ? 'Now' : 'Forecast'} onPress={() => setForecastMode((v) => !v)} />
        </View>
      </View>
      <View style={styles.mini}>
        <NextSpotMap
          interactive={false}
          muted={false}
          initialRegion={{ latitude: REGION.center.lat, longitude: REGION.center.lng, latitudeDelta: 0.004, longitudeDelta: 0.004 }}
          markers={[{
            kind: 'pin', id: 'mini', coordinate: { latitude: REGION.center.lat, longitude: REGION.center.lng },
            pin: pinDisplay({ type: 'cafe', level: null, phone: true }), placeType: 'cafe',
          }]}
          style={StyleSheet.absoluteFill}
        />
      </View>
    </View>
  );
}

function SmokeButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.button}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  map: { flex: 1 },
  bar: { position: 'absolute', left: 12, right: 12, top: 48, gap: 6 },
  status: { backgroundColor: 'rgba(255,255,255,0.9)', padding: 6, borderRadius: 8, fontSize: 12 },
  row: { flexDirection: 'row', gap: 6 },
  button: { backgroundColor: MAP_COLORS.muk, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8 },
  buttonText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  mini: { position: 'absolute', right: 12, bottom: 32, width: 160, height: 96, borderRadius: 12, overflow: 'hidden' },
});

export default MapSmoke;
