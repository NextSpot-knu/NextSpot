// 분산 코스 지도 — 웹 components/CourseMap.tsx: 내 위치 점 + 정류지 번호 원(첫 정류지 크게) + 순서 점선, 전체가 보이게 맞춤(하한 level 4).
// 지도 높이·뒤로·공유 버튼 자리는 화면(course.tsx)이 정한다. 이 컴포넌트는 지도를 못 그릴 때(키 없음·SDK 3초 초과) 부모에 알린다 —
// 부모가 지도 자리를 화면 높이의 22% 로 줄이고(웹 h-[22dvh]) 시트가 위로 겹치게 한다(G4b-05·01).
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import { COURSE_FIT_MIN_LEVEL, COURSE_FIT_PADDING, MAP_COLORS, NextSpotMap, type NextSpotMapHandle, type NextSpotMarker, type NextSpotPolyline } from '~/features/map';

import type { CourseStop } from '../types';
import type { CourseCoords } from '../useCourseLocation';

/** 웹 CourseMap.tsx:226 — 3초 안에 SDK 를 못 받으면 폴백 판. */
export const COURSE_MAP_UNAVAILABLE_MS = 3000;

export function CourseMapView({
  stops,
  userLocation,
  height,
  onUnavailable,
  onLive,
}: {
  stops: readonly CourseStop[];
  userLocation: CourseCoords;
  height: number | '100%';
  /** 지도를 못 그린다(폴백 그라데이션은 지도 래퍼가 그린다). */
  onUnavailable?: () => void;
  /** 지도가 준비됐다 — 늦게 받은 SDK 로 복구된 경우도 이쪽으로 온다. */
  onLive?: () => void;
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

  // 웹은 setBounds·setLevel 이 모두 즉시다 — 애니메이션(400ms)을 걸면 웹 빌드에서 확대 애니메이션과 맞춤이 겹쳐 한 곳 코스가 멀리 잡혔다(G4b-R01).
  useEffect(() => {
    if (!ready) return;
    const user = { latitude: userLocation.lat, longitude: userLocation.lng };
    if (valid.length === 0) {
      mapRef.current?.animateTo(user, { level: 6, duration: 0 });
      return;
    }
    mapRef.current?.fitToCoordinates(
      [user, ...valid.map((s) => ({ latitude: s.facility.latitude, longitude: s.facility.longitude }))],
      { padding: COURSE_FIT_PADDING, minLevel: COURSE_FIT_MIN_LEVEL, duration: 0 },
    );
  }, [ready, valid, userLocation.lat, userLocation.lng]);

  // 지도는 장식이다(웹 CourseMap.tsx:239 — 라벨 없음). 같은 이름의 '코스 순서 미리보기' 는 스텝퍼 하나만 갖는다(G4b-29).
  return (
    <View style={{ height, width: '100%' }}>
      <NextSpotMap
        ref={mapRef}
        muted={false}
        markers={markers}
        polylines={polylines}
        userLocation={{ latitude: userLocation.lat, longitude: userLocation.lng, variant: 'plain' }}
        initialRegion={undefined}
        unavailableTimeoutMs={COURSE_MAP_UNAVAILABLE_MS}
        onUnavailable={onUnavailable}
        onMapReady={() => {
          setReady(true);
          onLive?.();
        }}
        style={{ flex: 1 }}
      />
    </View>
  );
}
