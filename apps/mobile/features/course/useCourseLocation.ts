// 코스 기준 위치 — 이미 허용된 앞면(foreground) 권한이 있을 때만 현재 위치를 쓴다. 권한 묻기는 이 화면에서 하지 않는다(사전 안내 없이 시스템 창을 띄우지 않는다).
// 권한이 없거나 실패하거나 서비스 지역 밖이면 경주 중심 + 안내 토스트(웹 course/page.tsx 의 위치 효과와 같은 규칙).
// 위치정보 이용 동의(features/auth/consent)가 없으면 권한을 보지도 않고 '허용 없음'과 똑같이 처리한다.
// 동의가 바뀌면(설정에서 철회·부여) 다시 정한다.
import * as Location from 'expo-location';
import { useEffect, useState } from 'react';

import { toast } from '~/components/ui';
import { decideLocationAccess, mayReadPosition } from '~/features/auth/locationAccess';
import { useLocationConsent } from '~/features/auth/useLocationConsent';
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
  const consent = useLocationConsent();
  const [coords, setCoords] = useState<CourseCoords>(REGION_CENTER);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 동의가 없으면 OS 권한을 읽지 않는다 — 중심으로 되돌리고 거부와 같은 안내.
        if (!consent) throw new Error('no consent');
        const perm = await Location.getForegroundPermissionsAsync();
        if (!mayReadPosition(decideLocationAccess(consent, perm))) throw new Error('not granted');
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (!cancelled) setCoords(coordsWithinRegion(pos.coords.latitude, pos.coords.longitude));
      } catch {
        if (cancelled) return;
        setCoords(REGION_CENTER);
        toast.info(t('map.locationFallback'));
      }
    })();
    return () => {
      cancelled = true;
    };
    // t 는 언어가 바뀌면 달라지지만 위치를 다시 묻지는 않는다 — 마운트 1회 + 동의가 바뀔 때.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consent]);
  return coords;
}
