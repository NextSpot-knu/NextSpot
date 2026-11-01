// 코스 기준 위치 — 이미 허용된 앞면(foreground) 권한이 있을 때만 현재 위치를 쓴다. 권한 묻기는 이 화면에서 하지 않는다(사전 안내 없이 시스템 창을 띄우지 않는다).
// 권한이 없거나 실패하거나 서비스 지역 밖이면 경주 중심 + 안내 토스트(웹 course/page.tsx 의 위치 효과와 같은 규칙).
import * as Location from 'expo-location';
import { useEffect, useState } from 'react';

import { toast } from '~/components/ui';
import { useT } from '~/lib/i18n/I18nProvider';
import { REGION, isWithinRegion } from '@/lib/region';

export interface CourseCoords {
  lat: number;
  lng: number;
}

export const REGION_CENTER: CourseCoords = { lat: REGION.center.lat, lng: REGION.center.lng };

/** 위치 → 코스 기준점. 지역 밖이면 중심. 순수 함수(테스트용). */
export function coordsWithinRegion(lat: number, lng: number): CourseCoords {
  return isWithinRegion(lat, lng) ? { lat, lng } : REGION_CENTER;
}

export function useCourseLocation(): CourseCoords {
  const t = useT();
  const [coords, setCoords] = useState<CourseCoords>(REGION_CENTER);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (!perm.granted) throw new Error('not granted');
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (!cancelled) setCoords(coordsWithinRegion(pos.coords.latitude, pos.coords.longitude));
      } catch {
        if (!cancelled) toast.info(t('map.locationFallback'));
      }
    })();
    return () => {
      cancelled = true;
    };
    // t 는 언어가 바뀌면 달라지지만 위치를 다시 묻지는 않는다 — 마운트 1회.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return coords;
}
