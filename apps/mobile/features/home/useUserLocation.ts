// 내 위치 — 앱을 쓰는 동안(foreground)만. 계획 §6.2 의 흐름:
//   ② 홈에 처음 들어오면 안내(버튼 하나 '계속') → 그 버튼이 시스템 창(requestForegroundPermissionsAsync)을 연다.
//   ③ 거부하면 황리단길 중심 + 닫을 수 있는 배너(누르면 설정 앱).
//   ④ 대략적 위치(정확도 > 1km)면 황리단길 중심 + 안내. ⑤ 경주 밖이면 중심 + 한 번 안내.
//   ⑥ 위치는 홈을 열 때 한 번 읽는다(계속 추적하지 않는다).
// 웹 원본(0d145a1): apps/web/app/main/page.tsx 의 navigator.geolocation 블록. 판정은 homeModel.resolveUserLocation.
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking } from 'react-native';

import { REGION } from '@/lib/region';

import { resolveUserLocation, type LocationNotice } from './homeModel';

export type LocationStatus = 'checking' | 'needs-primer' | 'granted' | 'denied';

export interface UserLocationState {
  location: { lat: number; lng: number };
  known: boolean;
  status: LocationStatus;
  /** 경주 밖 · 대략적 위치 — 안내 문구를 고른다. */
  notice: LocationNotice;
  /** 허용했지만 위치를 못 읽었다(웹 map.locationFallback). */
  readFailed: boolean;
  /** 안내 화면의 '계속' — 시스템 권한 창을 연다. */
  continueFromPrimer: () => void;
  /** 설정 앱으로(거부 배너 · 대략적 위치 배너). */
  openSettings: () => void;
}

const CENTER: { lat: number; lng: number } = { lat: REGION.center.lat, lng: REGION.center.lng };

export function useUserLocation(): UserLocationState {
  const [status, setStatus] = useState<LocationStatus>('checking');
  const [location, setLocation] = useState(CENTER);
  const [known, setKnown] = useState(false);
  const [notice, setNotice] = useState<LocationNotice>(null);
  const [readFailed, setReadFailed] = useState(false);
  const aliveRef = useRef(true);
  const readingRef = useRef(false);

  const readPosition = useCallback(async () => {
    if (readingRef.current) return;
    readingRef.current = true;
    try {
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if (!aliveRef.current) return;
      const resolved = resolveUserLocation(position.coords);
      setLocation(resolved.location);
      setKnown(resolved.known);
      setNotice(resolved.notice);
      setReadFailed(false);
    } catch {
      if (aliveRef.current) setReadFailed(true);
    } finally {
      readingRef.current = false;
    }
  }, []);

  const applyPermission = useCallback(async (permission: Location.LocationPermissionResponse) => {
    if (!aliveRef.current) return;
    if (permission.granted) {
      setStatus('granted');
      await readPosition();
    } else if (permission.status === Location.PermissionStatus.UNDETERMINED && permission.canAskAgain) {
      setStatus('needs-primer');
    } else {
      setStatus('denied');
      setLocation(CENTER);
      setKnown(false);
      setNotice(null);
    }
  }, [readPosition]);

  const check = useCallback(async () => {
    try {
      await applyPermission(await Location.getForegroundPermissionsAsync());
    } catch {
      if (aliveRef.current) setStatus('denied');
    }
  }, [applyPermission]);

  useEffect(() => {
    aliveRef.current = true;
    void check();
    // 설정 앱에서 돌아오면 권한이 바뀌었을 수 있다 — 거부·대략적 위치 상태에서만 다시 본다(추적이 아니라 1회 읽기).
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void check();
    });
    return () => {
      aliveRef.current = false;
      sub.remove();
    };
  }, [check]);

  const continueFromPrimer = useCallback(() => {
    void (async () => {
      try {
        await applyPermission(await Location.requestForegroundPermissionsAsync());
      } catch {
        if (aliveRef.current) setStatus('denied');
      }
    })();
  }, [applyPermission]);

  const openSettings = useCallback(() => {
    void Linking.openSettings().catch(() => undefined);
  }, []);

  return { location, known, status, notice, readFailed, continueFromPrimer, openSettings };
}
