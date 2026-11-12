// 대안을 물을 좌표 — 웹 page.tsx 의 '주소 좌표 → 브라우저 위치 → 지역 중심' 순서(기준 커밋 0d145a1).
//
// 주소에 lat/lng 가 있으면(대기 보드·고른 장소) 그 값 그대로. 없으면 expo-location 포그라운드 위치를 쓰되
// **권한을 새로 묻지 않는다**(이미 허용된 때만 — 사전 안내 없이 시스템 창을 띄우지 않는다). 허용이 없거나 실패하면
// 지역 중심으로 두고 웹과 같은 안내 토스트를 한 번 띄운다. 서비스 지역 밖이면 지역 중심으로 옮긴다.
// 위치정보 이용 동의(features/auth/consent)가 없으면 권한을 보지도 않고 '허용 없음'과 똑같이 지역 중심 + 토스트.
// 동의가 바뀌면(설정에서 철회·부여) 다시 정한다.
import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';

import { toast } from '~/components/ui';
import { decideLocationAccess, mayReadPosition } from '~/features/auth/locationAccess';
import { useLocationConsent } from '~/features/auth/useLocationConsent';
import type { TFunc } from '~/lib/i18n/I18nProvider';

import { clampToRegion, initialCoords } from './logic';
import type { RecommendParams } from './origin';

const FIX_TIMEOUT_MS = 8000;

export interface RecommendLocation {
  coords: { lat: number; lng: number };
  /** 좌표가 확정됐다 — 이 전에는 추천을 묻지 않는다(중심 좌표로 한 번 묻고 다시 묻는 낭비를 막는다). */
  ready: boolean;
  /** 지금 좌표가 내 위치인가(주소 좌표나 지역 중심이 아니라). 공유·지도에는 쓰지 않는다. */
  isUserLocation: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('location-timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function useRecommendLocation(params: Pick<RecommendParams, 'lat' | 'lng'>, t: TFunc): RecommendLocation {
  const fromParams = params.lat !== null && params.lng !== null;
  const [state, setState] = useState<RecommendLocation>(() => ({
    coords: initialCoords(params),
    ready: fromParams,
    isUserLocation: false,
  }));
  const tRef = useRef(t);
  tRef.current = t;
  const consent = useLocationConsent();

  useEffect(() => {
    if (params.lat !== null && params.lng !== null) {
      setState({ coords: { lat: params.lat, lng: params.lng }, ready: true, isUserLocation: false });
      return;
    }
    let alive = true;
    const fallback = (notify: boolean) => {
      if (!alive) return;
      setState({ coords: initialCoords({ lat: null, lng: null }), ready: true, isUserLocation: false });
      // 위치 실패 시 조용히 안내 — 거리·도보 시간이 지역 중심 기준임을 알린다(무음 폴백 방지).
      if (notify) toast.info(tRef.current('map.locationFallback'));
    };
    void (async () => {
      try {
        // 동의가 없으면 OS 권한을 읽지 않는다(시스템 창도 없다).
        if (!consent) return fallback(true);
        const perm = await Location.getForegroundPermissionsAsync();
        if (!mayReadPosition(decideLocationAccess(consent, perm))) return fallback(true);
        const pos = await withTimeout(
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
          FIX_TIMEOUT_MS,
        );
        if (!alive) return;
        const clamped = clampToRegion(pos.coords.latitude, pos.coords.longitude);
        setState({ coords: { lat: clamped.lat, lng: clamped.lng }, ready: true, isUserLocation: !clamped.moved });
      } catch {
        fallback(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [params.lat, params.lng, consent]);

  return state;
}
