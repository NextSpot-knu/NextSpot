// 분산 코스 지도 — 웹 components/CourseMap.tsx: 내 위치 점 + 정류지 번호 원(첫 정류지 크게) + 순서 점선, 전체가 보이게 맞춤(하한 level 4).
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import { COURSE_FIT_MIN_LEVEL, COURSE_FIT_PADDING, MAP_COLORS, NextSpotMap, type NextSpotMapHandle, type NextSpotMarker, type NextSpotPolyline } from '~/features/map';

import type { CourseStop } from '../types';
import type { CourseCoords } from '../useCourseLocation';

export function CourseMapView({
  stops,
  userLocation,
  height,
  accessibilityLabel,
}: {
  stops: readonly CourseStop[];
  userLocation: CourseCoords;
  height: number | '100%';
  accessibilityLabel: string;
}) {
  const mapRef = useRef<NextSpotMapHandle>(null);
  const [ready, setReady] = useState(false);

  const valid = useMemo(
    () => stops.filter((s) => Number.isFinite(s.facility.latitude) && Number.isFinite(s.facility.longitude)),
    [stops],
  );
  const markers = useMemo<NextSpotMarker[]>(
    () =>
      valid.map((s, idx) => ({
        kind: 'number',
        id: `course-${s.facility.id}`,
        coordinate: { latitude: s.facility.latitude, longitude: s.facility.longitude },
        label: s.order ?? idx + 1,
        emphasized: idx === 0,
        title: s.facility.name,
        zIndex: idx === 0 ? 60 : 50,
      })),
    [valid],
  );
  const polylines = useMemo<NextSpotPolyline[]>(
    () =>
      valid.length >= 2
        ? [
            {
              id: 'course-path',
              coordinates: valid.map((s) => ({ latitude: s.facility.latitude, longitude: s.facility.longitude })),
              strokeColor: MAP_COLORS.gold,
              strokeWidth: 3,
              dashed: true,
            },
          ]
        : [],
    [valid],
  );

  useEffect(() => {
    if (!ready) return;
    const user = { latitude: userLocation.lat, longitude: userLocation.lng };
    if (valid.length === 0) {
      mapRef.current?.animateTo(user, { level: 6 });
      return;
    }
    mapRef.current?.fitToCoordinates(
      [user, ...valid.map((s) => ({ latitude: s.facility.latitude, longitude: s.facility.longitude }))],
      { padding: COURSE_FIT_PADDING, minLevel: COURSE_FIT_MIN_LEVEL },
    );
  }, [ready, valid, userLocation.lat, userLocation.lng]);

  return (
    <View style={{ height, width: '100%' }} accessible accessibilityLabel={accessibilityLabel}>
      <NextSpotMap
        ref={mapRef}
        muted={false}
        markers={markers}
        polylines={polylines}
        userLocation={{ latitude: userLocation.lat, longitude: userLocation.lng, variant: 'plain' }}
        initialRegion={undefined}
        onMapReady={() => setReady(true)}
        style={{ flex: 1 }}
      />
    </View>
  );
}
