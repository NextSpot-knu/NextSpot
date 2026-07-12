'use client';

// 분산 코스 지도 — 배달 추적 화면 상단의 '경로 미리보기' 지도에 해당.
// 사용자 위치 점 + 정류지 번호 마커(1..n, 첫 정류지 강조) + 정류지를 잇는 점선을 그리고
// 전체가 보이도록 bounds 를 맞춘다. Kakao Maps SDK 는 app/layout.tsx 전역 <Script> 로 로드되므로
// 여기서는 window.kakao 폴링(app/main/page.tsx 패턴 미러) 후 초기화한다.
// 정적 export/SSR 안전: 모든 window/kakao 접근은 useEffect 내부에서만 수행.
// 키 미설정 등으로 SDK 가 끝내 뜨지 않으면 3초 타임아웃 후 null 을 반환(레이아웃은 시트가 자연히 위로).

import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    kakao: any;
  }
}

// 지도가 필요로 하는 최소 필드만 정의 — app/course/page.tsx 의 CourseStop(더 많은 필드 보유)이
// 구조적으로 이 타입을 만족하므로 별도 캐스팅 없이 그대로 전달할 수 있다.
export interface CourseMapStop {
  order: number;
  facility: {
    id: string;
    name: string;
    type: string;
    latitude: number;
    longitude: number;
  };
}

interface CourseMapProps {
  stops: CourseMapStop[];
  userLocation: { lat: number; lng: number };
}

const KAKAO_POLL_MS = 200;
const KAKAO_TIMEOUT_MS = 3000;

export default function CourseMap({ stops, userLocation }: CourseMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerOverlaysRef = useRef<any[]>([]);
  const userDotRef = useRef<any>(null);
  const polylineRef = useRef<any>(null);

  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  // 1) Kakao SDK 폴링 → 지도 최초 1회 생성. 이후 중심/마커 갱신은 아래 draw effect 가 담당한다
  //    (userLocation 변화마다 지도를 재생성하지 않음 — 깜빡임 방지).
  useEffect(() => {
    if (unavailable || mapRef.current) return;
    let cancelled = false;
    const startedAt = Date.now();

    const interval = setInterval(() => {
      if (cancelled) return;

      if (typeof window !== 'undefined' && window.kakao && window.kakao.maps && containerRef.current) {
        clearInterval(interval);
        try {
          window.kakao.maps.load(() => {
            if (cancelled || !containerRef.current || mapRef.current) return;
            const kakao = window.kakao;
            const map = new kakao.maps.Map(containerRef.current, {
              center: new kakao.maps.LatLng(userLocation.lat, userLocation.lng),
              level: 6,
            });
            mapRef.current = map;
            setReady(true);
          });
        } catch (err) {
          console.warn('코스 지도 초기화 실패:', err);
          setUnavailable(true);
        }
        return;
      }

      if (Date.now() - startedAt > KAKAO_TIMEOUT_MS) {
        clearInterval(interval);
        setUnavailable(true);
      }
    }, KAKAO_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unavailable]);

  // 2) 정류지/사용자 위치 변경 시 마커·점·폴리라인을 정리 후 재그리기 + bounds 로 전체가 보이게.
  useEffect(() => {
    if (!ready || !mapRef.current || typeof window === 'undefined' || !window.kakao) return;
    const kakao = window.kakao;
    const map = mapRef.current;

    // 이전 오버레이 정리(잔상 방지) — 항상 먼저 비운다.
    markerOverlaysRef.current.forEach((o) => o.setMap(null));
    markerOverlaysRef.current = [];
    if (userDotRef.current) {
      userDotRef.current.setMap(null);
      userDotRef.current = null;
    }
    if (polylineRef.current) {
      polylineRef.current.setMap(null);
      polylineRef.current = null;
    }

    const bounds = new kakao.maps.LatLngBounds();

    // 사용자 위치 점
    const userDotEl = document.createElement('div');
    userDotEl.style.width = '14px';
    userDotEl.style.height = '14px';
    userDotEl.style.borderRadius = '9999px';
    userDotEl.style.background = '#2b2320'; // muk
    userDotEl.style.border = '3px solid #ffffff';
    userDotEl.style.boxShadow = '0 0 0 4px rgba(43,35,32,0.15)';
    const userPos = new kakao.maps.LatLng(userLocation.lat, userLocation.lng);
    const userDot = new kakao.maps.CustomOverlay({
      position: userPos,
      content: userDotEl,
      xAnchor: 0.5,
      yAnchor: 0.5,
      zIndex: 40,
    });
    userDot.setMap(map);
    userDotRef.current = userDot;
    bounds.extend(userPos);

    // 정류지 번호 마커(골드 원 + 흰 숫자) — 첫 정류지만 살짝 크게.
    const path: any[] = [];
    stops.forEach((stop, idx) => {
      const { latitude, longitude, name } = stop.facility;
      if (typeof latitude !== 'number' || typeof longitude !== 'number') return;
      const pos = new kakao.maps.LatLng(latitude, longitude);
      const isFirst = idx === 0;
      const size = isFirst ? 34 : 28;

      const el = document.createElement('div');
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.borderRadius = '9999px';
      el.style.background = '#c19a3e'; // gold
      el.style.border = '2px solid #ffffff';
      el.style.boxShadow = '0 2px 8px rgba(193,154,62,0.45)';
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.style.color = '#ffffff';
      el.style.fontWeight = '800';
      el.style.fontSize = isFirst ? '14px' : '12px';
      el.style.fontFamily = 'inherit';
      el.title = name;
      el.textContent = String(stop.order ?? idx + 1);

      const overlay = new kakao.maps.CustomOverlay({
        position: pos,
        content: el,
        xAnchor: 0.5,
        yAnchor: 0.5,
        zIndex: isFirst ? 60 : 50,
      });
      overlay.setMap(map);
      markerOverlaysRef.current.push(overlay);
      bounds.extend(pos);
      path.push(pos);
    });

    // 정류지들을 잇는 점선(순서 방향성 표시).
    if (path.length >= 2) {
      const polyline = new kakao.maps.Polyline({
        path,
        strokeWeight: 3,
        strokeColor: '#c19a3e',
        strokeOpacity: 0.85,
        strokeStyle: 'shortdash',
      });
      polyline.setMap(map);
      polylineRef.current = polyline;
    }

    // 전체가 보이도록 bounds 맞춤. 점이 사용자 위치 하나뿐이면(정류지 없음) 과도한 확대를 피해
    // 중심 이동 + 고정 레벨로 대체한다.
    if (path.length > 0) {
      map.setBounds(bounds, 80, 40, 40, 40);
      // 정류지 1곳이 사용자 위치와 수십 m 거리면 bounds 가 손톱만해져 지나치게 확대된다 → 레벨 하한.
      if (map.getLevel() < 3) map.setLevel(3);
    } else {
      map.setCenter(userPos);
      map.setLevel(6);
    }
  }, [ready, stops, userLocation.lat, userLocation.lng]);

  // 3) 언마운트 정리.
  useEffect(() => {
    return () => {
      markerOverlaysRef.current.forEach((o) => o.setMap(null));
      markerOverlaysRef.current = [];
      if (userDotRef.current) userDotRef.current.setMap(null);
      if (polylineRef.current) polylineRef.current.setMap(null);
      userDotRef.current = null;
      polylineRef.current = null;
      mapRef.current = null;
    };
  }, []);

  // 4) 늦은 SDK 자동 복구 — 느린 네트워크에서 3초 타임아웃 직후 SDK 가 로드되는 경계 케이스를 구제한다.
  //    unavailable 이 풀리면 폴링 effect([unavailable] 의존)가 다시 돌며 지도를 초기화한다.
  //    복구는 컴포넌트 수명당 3회 상한 — 초기화가 '항상 throw' 하는 병리적 환경에서
  //    복구→재실패 플립플롭이 무한 반복되지 않게(카운터는 ref: effect 재장전 시 리셋 방지).
  const recoverAttemptsRef = useRef(0);
  useEffect(() => {
    if (!unavailable || recoverAttemptsRef.current >= 3) return;
    const retry = setInterval(() => {
      if (typeof window !== 'undefined' && window.kakao && window.kakao.maps) {
        recoverAttemptsRef.current += 1;
        clearInterval(retry);
        setUnavailable(false);
      }
    }, 5000);
    return () => clearInterval(retry);
  }, [unavailable]);

  // SDK 부재(키 미설정 등) 폴백 — null 로 접으면 위에 절대배치된 뒤로가기/공유 플로팅 버튼이
  // 바텀시트 헤더 위로 겹쳐 올라오므로, 낮은 장식 영역을 유지해 버튼의 자리를 보존한다.
  if (unavailable) {
    return (
      <div
        className="h-[22dvh] w-full bg-gradient-to-b from-hanji-deep/70 via-hanji-deep/40 to-hanji"
        aria-hidden
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className={`h-[38dvh] md:h-[42dvh] w-full ${ready ? '' : 'bg-hanji-deep animate-pulse'}`}
      aria-hidden={!ready}
    />
  );
}
