// 내 위치 — 앱을 쓰는 동안(foreground)만. 계획 §6.2 의 흐름:
//   ② 홈에 처음 들어오면 안내(버튼 하나 '계속') → 그 버튼이 시스템 창(requestForegroundPermissionsAsync)을 연다.
//   ③ 거부하면 황리단길 중심 + 홈 알약(map.locationFallback). 다시 켜기는 마이>설정(D3 ① — 배너·'내 위치' 버튼 없음).
//   ④ 대략적 위치(정확도 > 1km)면 황리단길 중심 + 같은 알약. ⑤ 경주 밖이면 중심 + 한 번 안내.
//   ⑥ 위치는 홈을 열 때 한 번 읽는다(계속 추적하지 않는다). 앱이 다시 앞으로 올 때 다시 볼지는 locationPolicy 가 정한다 —
//      안드로이드 '위치 정확도' 창이 닫힐 때마다 다시 읽어 창이 끝없이 뜨던 고리를 막는다. 최근 위치가 있으면 그것을 먼저 쓴다.
//   ① 위치정보 이용 동의(features/auth/consent)가 없으면 OS 권한을 보지도 묻지도 않는다 — 거부와 똑같이 황리단길 중심,
//      사전 안내 없음. 설정에서 동의를 바꾸면 구독으로 바로 따라간다.
// 웹 원본(0d145a1): apps/web/app/main/page.tsx 의 navigator.geolocation 블록. 판정은 homeModel.resolveUserLocation.
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { decideLocationAccess, mayReadPosition } from '~/features/auth/locationAccess';
import { useLocationConsent } from '~/features/auth/useLocationConsent';

import { REGION } from '@/lib/region';

import { resolveUserLocation, type LocationNotice, type ResolvedLocation } from './homeModel';
import {
  LAST_KNOWN_MAX_AGE_MS,
  LAST_KNOWN_REQUIRED_ACCURACY_M,
  shouldRecheckOnForeground,
} from './locationPolicy';

/** 'no-consent' — 위치정보 이용 동의가 없다. 화면은 'denied' 와 같이 다룬다. */
export type LocationStatus = 'checking' | 'needs-primer' | 'granted' | 'denied' | 'no-consent';

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
}

const CENTER: { lat: number; lng: number } = { lat: REGION.center.lat, lng: REGION.center.lng };

export function useUserLocation(): UserLocationState {
  const consent = useLocationConsent();
  const consentRef = useRef(consent);
  consentRef.current = consent;
  const [status, setStatus] = useState<LocationStatus>('checking');
  const [location, setLocation] = useState(CENTER);
  const [known, setKnown] = useState(false);
  const [notice, setNotice] = useState<LocationNotice>(null);
  const [readFailed, setReadFailed] = useState(false);
  const aliveRef = useRef(true);
  const readingRef = useRef<Promise<ResolvedLocation | null> | null>(null);
  const lastReadAttemptRef = useRef<number | null>(null);
  // AppState 구독은 한 번만 건다 — 지금 상태는 ref 로 본다.
  const snapshotRef = useRef({ status, notice, readFailed });
  snapshotRef.current = { status, notice, readFailed };

  /** 한 번 읽는다. 이미 읽는 중이면 그 읽기를 함께 기다린다. 읽어서 반영했으면 그 결과, 실패·버렸으면 null. */
  const readPosition = useCallback((): Promise<ResolvedLocation | null> => {
    if (readingRef.current) return readingRef.current;
    const run = (async (): Promise<ResolvedLocation | null> => {
      lastReadAttemptRef.current = Date.now();
      try {
        // 최근에 알려진 위치가 충분히 정확하면 그것으로(시스템 창 없이 바로). 없으면 새로 읽는다.
        const lastKnown = await Location.getLastKnownPositionAsync({
          maxAge: LAST_KNOWN_MAX_AGE_MS,
          requiredAccuracy: LAST_KNOWN_REQUIRED_ACCURACY_M,
        }).catch(() => null);
        const position = lastKnown ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
        // 읽는 동안 동의가 철회됐으면 버린다.
        if (!aliveRef.current || !consentRef.current) return null;
        const resolved = resolveUserLocation(position.coords);
        setLocation(resolved.location);
        setKnown(resolved.known);
        setNotice(resolved.notice);
        setReadFailed(false);
        return resolved;
      } catch {
        if (aliveRef.current) setReadFailed(true);
        return null;
      } finally {
        readingRef.current = null;
      }
    })();
    readingRef.current = run;
    return run;
  }, []);

  const toCenter = useCallback((next: 'denied' | 'no-consent') => {
    setStatus(next);
    setLocation(CENTER);
    setKnown(false);
    setNotice(null);
    setReadFailed(false);
  }, []);

  const applyPermission = useCallback(async (permission: Location.LocationPermissionResponse | null) => {
    if (!aliveRef.current) return;
    // 동의는 권한 창이 떠 있는 동안 바뀔 수도 있으니 결과를 받은 뒤 다시 본다.
    const access = decideLocationAccess(consentRef.current, permission);
    if (mayReadPosition(access)) {
      setStatus('granted');
      await readPosition();
    } else if (access === 'needs-primer') {
      setStatus('needs-primer');
    } else {
      toCenter(access === 'no-consent' ? 'no-consent' : 'denied');
    }
  }, [readPosition, toCenter]);

  const check = useCallback(async () => {
    // 동의가 없으면 OS 권한을 읽지도 않는다.
    if (!consentRef.current) {
      if (aliveRef.current) toCenter('no-consent');
      return;
    }
    try {
      await applyPermission(await Location.getForegroundPermissionsAsync());
    } catch {
      if (aliveRef.current) await applyPermission(null);
    }
  }, [applyPermission, toCenter]);

  useEffect(() => {
    aliveRef.current = true;
    void check();
    // 설정 앱에서 돌아오면 권한이 바뀌었을 수 있다 — 거부·사전 안내·동의 없음(그리고 쿨다운이 지난 대략적 위치)에서만
    // 다시 본다. 허용 상태에서 돌아올 때마다 읽으면 안드로이드 정확도 창이 닫힐 때마다 다시 떠 끝없이 돈다.
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const snap = snapshotRef.current;
      if (shouldRecheckOnForeground({ ...snap, lastReadAttemptAt: lastReadAttemptRef.current, now: Date.now() })) void check();
    });
    return () => {
      aliveRef.current = false;
      sub.remove();
    };
  }, [check]);

  // 설정에서 동의를 철회·부여하면 다시 판정한다(첫 렌더는 위 효과가 이미 본다).
  const firstConsentRef = useRef(true);
  useEffect(() => {
    if (firstConsentRef.current) {
      firstConsentRef.current = false;
      return;
    }
    void check();
  }, [consent, check]);

  const continueFromPrimer = useCallback(() => {
    // 사전 안내는 동의가 있을 때만 뜨지만, 그 사이 철회됐으면 시스템 창을 열지 않는다.
    if (!consentRef.current) {
      toCenter('no-consent');
      return;
    }
    void (async () => {
      try {
        await applyPermission(await Location.requestForegroundPermissionsAsync());
      } catch {
        if (aliveRef.current) setStatus('denied');
      }
    })();
  }, [applyPermission, toCenter]);

  return { location, known, status, notice, readFailed, continueFromPrimer };
}
