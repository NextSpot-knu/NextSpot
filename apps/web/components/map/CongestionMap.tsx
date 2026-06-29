"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createPublicClient } from "@/lib/supabase";
const supabase = createPublicClient();
import { FacilityWithCongestion } from "@/app/explore/map/page";
// 마커 SVG는 lib/utils 의 공용 getMarkerSvg 로 통일(예쁜 핀 + 올바른 흰색 렌더). 중복 인라인 제거.
import { getMarkerSvg } from "@/lib/utils";

interface CongestionMapProps {
  initialFacilities: FacilityWithCongestion[];
}

declare global {
  interface Window {
    kakao: any;
  }
}

const calculateWaitTime = (type: string, level: number, features: any = {}) => {
  const defaultTimes: Record<string, number> = {
    restaurant: 25,
    cafe: 12,
    attraction: 15,
    culture: 15,
  };
  const avgProcessTime = features?.average_processing_time ?? defaultTimes[type] ?? 15;

  const hour = new Date().getHours();
  let timeMultiplier = 1.0;
  if (hour >= 11 && hour < 14) {
    timeMultiplier = 1.3;
  } else if (hour >= 14 && hour < 18) {
    timeMultiplier = 1.2;
  }

  const predicted = level * avgProcessTime * timeMultiplier;
  return predicted.toFixed(1);
};

export default function CongestionMap({ initialFacilities }: CongestionMapProps) {
  const router = useRouter();

  const [facilities, setFacilities] = useState<FacilityWithCongestion[]>(initialFacilities);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [isSimulation, setIsSimulation] = useState(false);
  const [selectedFacility, setSelectedFacility] = useState<FacilityWithCongestion | null>(null);
  const [isBottomSheetOpen, setIsBottomSheetOpen] = useState(false);

  // Filters State
  const [filterType, setFilterType] = useState<string>("all");
  const [onlyRelaxed, setOnlyRelaxed] = useState<boolean>(false);

  // Location State
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);

  // Sync state with updated initialFacilities from SSR
  useEffect(() => {
    setFacilities(initialFacilities);
  }, [initialFacilities]);

  // Map references
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const clustererRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const userMarkerRef = useRef<any>(null);

  // Projection helper: maps lat/lng of Gyeongju Hwangnidan-gil area to percentage grid coords
  const getCoordinatesOnGrid = (lat: number, lng: number) => {
    const minLat = 35.8250;
    const maxLat = 35.8480;
    const minLng = 129.2000;
    const maxLng = 129.2320;

    const y = 100 - ((lat - minLat) / (maxLat - minLat)) * 100;
    const x = ((lng - minLng) / (maxLng - minLng)) * 100;
    return { x: `${x}%`, y: `${y}%` };
  };

  // Dynamically load Kakao Maps SDK Script
  useEffect(() => {
    const appKey = process.env.NEXT_PUBLIC_KAKAO_MAPS_APP_KEY || process.env.NEXT_PUBLIC_KAKAO_API_KEY || process.env.NEXT_PUBLIC_KAKAO_MAP_KEY || "";
    const isMock = !appKey || appKey.includes("mock") || appKey.includes("your-");

    if (isMock) {
      setIsSimulation(true);
      setMapLoaded(true);
      setUserLocation({ lat: 35.8362, lng: 129.2095 });
      return;
    }

    const scriptId = "kakao-maps-sdk";
    let script = document.getElementById(scriptId) as HTMLScriptElement;

    if (!script) {
      script = document.createElement("script");
      script.id = scriptId;
      script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${appKey}&autoload=false&libraries=services,clusterer`;
      script.async = true;

      script.onload = () => {
        if (window.kakao && window.kakao.maps) {
          window.kakao.maps.load(() => {
            setMapLoaded(true);
          });
        } else {
          setMapError(true);
        }
      };

      script.onerror = () => {
        setMapError(true);
      };

      document.head.appendChild(script);
    } else {
      if (window.kakao && window.kakao.maps) {
        window.kakao.maps.load(() => {
          setMapLoaded(true);
        });
      } else {
        const checkInterval = setInterval(() => {
          if (window.kakao && window.kakao.maps) {
            window.kakao.maps.load(() => {
              setMapLoaded(true);
              clearInterval(checkInterval);
            });
          }
        }, 100);
        setTimeout(() => clearInterval(checkInterval), 5000);
      }
    }
  }, []);

  // Initialize Map
  useEffect(() => {
    if (!mapLoaded || !mapContainerRef.current || isSimulation) return;

    const kakao = window.kakao;
    const defaultCenter = new kakao.maps.LatLng(35.8362, 129.2095);

    const mapOptions = {
      center: defaultCenter,
      level: 4,
    };

    const map = new kakao.maps.Map(mapContainerRef.current, mapOptions);
    mapRef.current = map;

    const zoomControl = new kakao.maps.ZoomControl();
    map.addControl(zoomControl, kakao.maps.ControlPosition.RIGHT);

    const clusterer = new kakao.maps.MarkerClusterer({
      map: map,
      averageCenter: true,
      minLevel: 5,
      styles: [
        {
          width: "48px",
          height: "48px",
          background: "rgba(59, 130, 246, 0.9)",
          borderRadius: "50%",
          color: "#ffffff",
          textAlign: "center",
          lineHeight: "48px",
          fontWeight: "bold",
          fontSize: "14px",
          border: "2px solid #ffffff",
          boxShadow: "0 0 10px rgba(59, 130, 246, 0.5)",
        },
      ],
    });
    clustererRef.current = clusterer;

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          let lat = position.coords.latitude;
          let lng = position.coords.longitude;

          // Check if coordinates are outside Gyeongju Hwangnidan-gil boundaries
          const isWithinGyeongju = lat >= 35.82 && lat <= 35.85 && lng >= 129.19 && lng <= 129.24;
          if (!isWithinGyeongju) {
            lat = 35.8362;
            lng = 129.2095;
            console.log("User is outside Gyeongju. Mocking location to Hwangnidan-gil:", lat, lng);
          }

          setUserLocation({ lat, lng });
          map.setCenter(new kakao.maps.LatLng(lat, lng));
        },
        (err) => {
          console.warn("Geolocation access denied or failed. Fallback to default center.", err);
        }
      );
    }
  }, [mapLoaded, isSimulation]);

  // Handle User Location Marker
  useEffect(() => {
    if (!mapLoaded || !mapRef.current || !userLocation || isSimulation) return;
    const kakao = window.kakao;

    if (userMarkerRef.current) {
      userMarkerRef.current.setMap(null);
    }

    const userSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30">
        <circle cx="15" cy="15" r="12" fill="%233b82f6" fill-opacity="0.25" stroke="%233b82f6" stroke-width="2"/>
        <circle cx="15" cy="15" r="6" fill="%233b82f6" stroke="%23ffffff" stroke-width="2"/>
      </svg>
    `;

    const userImage = new kakao.maps.MarkerImage(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(userSvg.trim())}`,
      new kakao.maps.Size(30, 30),
      { offset: new kakao.maps.Point(15, 15) }
    );

    const userMarker = new kakao.maps.Marker({
      position: new kakao.maps.LatLng(userLocation.lat, userLocation.lng),
      image: userImage,
      title: "현재 내 위치",
    });

    userMarker.setMap(mapRef.current);
    userMarkerRef.current = userMarker;
  }, [userLocation, mapLoaded, isSimulation]);

  // Synchronize Markers (Filters & State Updates)
  useEffect(() => {
    if (!mapLoaded || !mapRef.current || !clustererRef.current || isSimulation) return;
    const kakao = window.kakao;

    clustererRef.current.clear();
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    const filtered = facilities.filter((f) => {
      if (filterType !== "all" && f.type !== filterType) return false;
      if (onlyRelaxed && f.congestionLevel >= 0.25) return false;
      return true;
    });

    const newMarkers = filtered.map((f) => {
      const isPrivateParking = false; // 관광 POI엔 사내주차 개념이 없어 표준 마커 사용
      // 마커 크기 반응형(좁은 화면=작게, 넓은 화면=크게)
      const isNarrow = typeof window !== "undefined" && window.innerWidth < 640;
      const nW = isNarrow ? 40 : 48, nH = isNarrow ? 51 : 61, sq = isNarrow ? 38 : 46;
      const size = isPrivateParking ? new kakao.maps.Size(sq, sq) : new kakao.maps.Size(nW, nH);
      const offset = isPrivateParking ? new kakao.maps.Point(sq / 2, sq / 2) : new kakao.maps.Point(nW / 2, nH);

      const markerImage = new kakao.maps.MarkerImage(
        getMarkerSvg(f.type, f.congestionLevel, f.features),
        size,
        { offset }
      );

      const marker = new kakao.maps.Marker({
        position: new kakao.maps.LatLng(f.latitude, f.longitude),
        image: markerImage,
        title: f.name,
      });

      kakao.maps.event.addListener(marker, "click", () => {
        setSelectedFacility(f);
        setIsBottomSheetOpen(true);
        mapRef.current.panTo(new kakao.maps.LatLng(f.latitude, f.longitude));
      });

      return marker;
    });

    markersRef.current = newMarkers;
    clustererRef.current.addMarkers(newMarkers);
  }, [facilities, filterType, onlyRelaxed, mapLoaded, isSimulation]);

  // Supabase Realtime Subscription for congestion logs
  useEffect(() => {
    const channel = supabase
      .channel("realtime-congestion")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "congestion_logs",
        },
        (payload) => {
          const newLog = payload.new as {
            facility_id: string;
            congestion_level: number;
            current_count: number;
            timestamp: string;
          };

          setFacilities((prev) =>
            prev.map((f) => {
              if (f.id === newLog.facility_id) {
                return {
                  ...f,
                  congestionLevel: newLog.congestion_level,
                  currentCount: newLog.current_count,
                  lastUpdated: newLog.timestamp,
                };
              }
              return f;
            })
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const activeSelectedFacility = selectedFacility
    ? facilities.find((f) => f.id === selectedFacility.id) || selectedFacility
    : null;

  const getCongestionBadge = (level: number) => {
    if (level >= 0.75) {
      return {
        text: "혼잡",
        colorClass: "text-orange-400 bg-orange-500/10 border-orange-500/20",
        barClass: "bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.6)]",
      };
    } else if (level >= 0.50) {
      return {
        text: "보통",
        colorClass: "text-amber-400 bg-amber-500/10 border-amber-500/20",
        barClass: "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]",
      };
    } else if (level >= 0.25) {
      return {
        text: "여유",
        colorClass: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
        barClass: "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]",
      };
    } else {
      return {
        text: "한산",
        colorClass: "text-blue-400 bg-blue-500/10 border-blue-500/20",
        barClass: "bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.6)]",
      };
    }
  };

  const getTypeName = (type: string) => {
    switch (type) {
      case "restaurant":
        return "음식점 🍴";
      case "cafe":
        return "카페 ☕";
      case "attraction":
        return "관광지 📸";
      case "culture":
        return "문화시설 🏛️";
      default:
        return "장소 📍";
    }
  };

  const handleFindAlternative = () => {
    if (!activeSelectedFacility) return;
    let url = `/explore/recommend?facilityId=${activeSelectedFacility.id}`;
    if (userLocation) {
      url += `&lat=${userLocation.lat}&lng=${userLocation.lng}`;
    }
    router.push(url);
  };

  const filterChips = [
    { label: "전체", value: "all" },
    { label: "음식점 🍴", value: "restaurant" },
    { label: "카페 ☕", value: "cafe" },
    { label: "관광지 📸", value: "attraction" },
    { label: "문화시설 🏛️", value: "culture" },
  ];

  const filteredFacilities = facilities.filter((f) => {
    if (filterType !== "all" && f.type !== filterType) return false;
    if (onlyRelaxed && f.congestionLevel >= 0.25) return false;
    return true;
  });

  if (mapError) {
    const handleSwitchToSimulation = () => {
      setIsSimulation(true);
      setMapLoaded(true);
      setUserLocation({ lat: 35.8366, lng: 129.2099 });
      setMapError(false);
    };

    return (
      <div className="flex flex-col items-center justify-center h-screen bg-[#0a0f1e] text-slate-300 p-6">
        <div className="glass-panel p-8 rounded-3xl max-w-md w-full border border-rose-500/30 text-center space-y-4">
          <div className="text-4xl text-rose-500">⚠️</div>
          <h2 className="text-xl font-bold text-slate-100">지도를 불러올 수 없습니다</h2>
          <p className="text-sm text-slate-400 leading-relaxed text-left">
            <strong>원인 가능성:</strong><br />
            1. 카카오 디벨로퍼스 콘솔의 [내 애플리케이션] &gt; [플랫폼] &gt; [Web]에 현재 접속 주소(예: <code>http://localhost:3000</code>)가 등록되어 있지 않은 경우<br />
            2. 입력한 API 키가 올바르지 않은 경우
          </p>
          <div className="space-y-2 pt-2">
            <button
              onClick={() => window.location.reload()}
              className="w-full py-3 bg-gradient-to-r from-rose-500 to-amber-600 rounded-xl font-semibold text-sm transition-all duration-300 hover:opacity-90 shadow-lg shadow-rose-500/20"
            >
              다시 시도
            </button>
            <button
              onClick={handleSwitchToSimulation}
              className="w-full py-3 bg-white/5 border border-white/10 rounded-xl font-semibold text-sm text-slate-300 hover:text-white hover:bg-white/10 transition-all duration-200"
            >
              디지털 트윈 모드(시뮬레이션)로 계속하기
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-screen overflow-hidden bg-[#0a0f1e]">
      {/* Map Container (Swaps between simulated Twin grid and real Kakao Map) */}
      {isSimulation ? (
        <div className="relative w-full h-full bg-[#070b19] overflow-hidden select-none">
          {/* Tech Grid Pattern */}
          <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff03_1px,transparent_1px),linear-gradient(to_bottom,#ffffff03_1px,transparent_1px)] bg-[size:32px_32px]" />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,#1e293b20,transparent_75%)]" />

          {/* Road outlines */}
          <div className="absolute w-[80%] h-1 bg-slate-800/30 rotate-12 top-[35%] left-[10%] rounded-full" />
          <div className="absolute w-[70%] h-1 bg-slate-800/30 -rotate-45 top-[25%] left-[20%] rounded-full" />
          <div className="absolute w-[95%] h-1 bg-slate-800/30 rotate-3 bottom-[45%] left-[2%] rounded-full" />
          <div className="absolute w-[40%] h-[30%] bg-emerald-500/5 rounded-full filter blur-3xl top-[15%] left-[15%]" />
          <div className="absolute w-[30%] h-[20%] bg-sky-500/5 rounded-full filter blur-3xl bottom-[20%] right-[10%]" />

          {/* Technical Info Label */}
          <div className="absolute bottom-6 left-6 text-[9px] text-slate-500 font-mono space-y-0.5 z-10 pointer-events-none">
            <div>SYSTEM: SIMULATED GYEONGJU TOURISM DIGITAL TWIN</div>
            <div>COORDINATES IN USE: GYEONGJU HWANGNIDAN-GIL SEED CLUSTER</div>
            <div>KAKAOMAPS: BYPASSED (SIMULATOR MODE ACTIVE)</div>
          </div>

          {/* User Location Radar Pulse */}
          {userLocation && (() => {
            const pos = getCoordinatesOnGrid(userLocation.lat, userLocation.lng);
            return (
              <div
                className="absolute -translate-x-1/2 -translate-y-1/2 z-10 pointer-events-none"
                style={{ left: pos.x, top: pos.y }}
              >
                <span className="absolute inline-flex h-8 w-8 rounded-full bg-blue-500/35 animate-ping" />
                <span className="relative inline-flex rounded-full h-4 w-4 bg-blue-500 border-2 border-white shadow-[0_0_10px_rgba(59,130,246,0.8)]" />
              </div>
            );
          })()}

          {/* Simulated Markers */}
          {filteredFacilities.map((f) => {
            const pos = getCoordinatesOnGrid(f.latitude, f.longitude);
            const markerSvg = getMarkerSvg(f.type, f.congestionLevel, f.features);
            const isPrivateParking = false; // 관광 POI엔 사내주차 개념이 없어 표준 마커 사용
            const translateClass = isPrivateParking ? "-translate-x-1/2 -translate-y-1/2" : "-translate-x-1/2 -translate-y-[85%]";

            return (
              <button
                key={f.id}
                onClick={() => {
                  setSelectedFacility(f);
                  setIsBottomSheetOpen(true);
                }}
                className={`absolute z-20 transition-all duration-300 hover:scale-110 hover:brightness-110 active:scale-95 focus:outline-none ${translateClass}`}
                style={{ left: pos.x, top: pos.y }}
              >
                <img
                  src={markerSvg}
                  alt={f.name}
                  className={`${isPrivateParking ? 'w-9 h-9' : 'w-9 h-[46px]'} drop-shadow-[0_6px_10px_rgba(0,0,0,0.6)]`}
                />
              </button>
            );
          })}
        </div>
      ) : (
        <div ref={mapContainerRef} className="w-full h-full" style={{ zIndex: 0 }} />
      )}


      {/* Floating Header */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-2 bg-slate-900/85 backdrop-blur-md px-4 py-2.5 rounded-2xl border border-white/10 shadow-xl">
        <span className="text-sm font-extrabold tracking-tight">
          <span className="gradient-text">NextSpot</span> Map
        </span>
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse ml-1" />
        <span className="text-[10px] text-emerald-400 font-bold uppercase tracking-wider">Live</span>
      </div>

      {/* Floating Filter Controls */}
      <div className="absolute top-4 right-4 z-10 flex flex-col items-end gap-3 max-w-[90vw]">
        {/* Type Filter selector */}
        <div className="flex flex-wrap justify-end gap-1.5 bg-slate-900/85 backdrop-blur-md p-1.5 rounded-2xl border border-white/10 shadow-xl">
          {filterChips.map((chip) => (
            <button
              key={chip.value}
              onClick={() => setFilterType(chip.value)}
              className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-xl text-xs font-semibold transition-all duration-200 ${
                filterType === chip.value
                  ? "bg-gradient-to-r from-sky-500 to-purple-600 text-white shadow-md shadow-blue-500/25"
                  : "text-slate-300 hover:text-white hover:bg-white/5"
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>

        {/* Relaxed Filter Toggle */}
        <button
          onClick={() => setOnlyRelaxed((prev) => !prev)}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl border text-xs font-semibold transition-all duration-250 shadow-xl bg-slate-900/85 backdrop-blur-md ${
            onlyRelaxed
              ? "border-emerald-500/50 text-emerald-400 shadow-emerald-500/10"
              : "border-white/10 text-slate-300 hover:text-white hover:bg-white/5"
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              onlyRelaxed ? "bg-emerald-500 animate-ping" : "bg-slate-500"
            }`}
          />
          한산한 곳만 보기 (25% 미만)
        </button>
      </div>

      {/* Dynamic Bottom Sheet */}
      {isBottomSheetOpen && activeSelectedFacility && (
        <div className="absolute bottom-0 left-0 right-0 z-20 p-4 md:p-6 bg-gradient-to-t from-[#050814] to-[#0d132a]/95 border-t border-white/10 backdrop-blur-lg rounded-t-3xl shadow-2xl transition-all duration-300 animate-in slide-in-from-bottom">
          <div className="max-w-2xl mx-auto space-y-5">
            {/* Sheet Handle & Close */}
            <div className="flex justify-between items-center pb-2">
              <div className="w-12 h-1 bg-white/15 rounded-full mx-auto absolute left-1/2 -translate-x-1/2 top-3 hidden md:block" />
              <div className="space-y-0.5">
                <span className="text-xs font-bold text-sky-400 uppercase tracking-wider">
                  {getTypeName(activeSelectedFacility.type)}
                </span>
                <h3 className="text-xl font-bold text-slate-100">{activeSelectedFacility.name}</h3>
              </div>
              <button
                onClick={() => setIsBottomSheetOpen(false)}
                className="p-1.5 rounded-full bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-all duration-200"
              >
                ✕
              </button>
            </div>

            {/* Congestion Meter */}
            {(() => {
              const badge = getCongestionBadge(activeSelectedFacility.congestionLevel);
              const percentage = Math.round(activeSelectedFacility.congestionLevel * 100);
              return (
                <div className="bg-white/5 border border-white/5 p-4 rounded-2xl space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-slate-400">실시간 혼잡 비율</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full border font-bold ${badge.colorClass}`}>
                      {badge.text} ({percentage}%)
                    </span>
                  </div>
                  <div className="w-full bg-white/5 h-2.5 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${badge.barClass}`}
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              );
            })()}

            {/* Stats Grid */}
            <div className="grid grid-cols-3 gap-3">
              {/* Wait Time */}
              <div className="glass-panel p-3.5 rounded-2xl flex flex-col justify-between">
                <span className="text-[10px] text-slate-400 font-medium">예측 대기 시간</span>
                <span className="text-lg font-extrabold text-amber-400 mt-1">
                  {calculateWaitTime(
                    activeSelectedFacility.type,
                    activeSelectedFacility.congestionLevel,
                    activeSelectedFacility.features
                  )}
                  <span className="text-xs font-medium text-slate-300 ml-0.5">분</span>
                </span>
              </div>

              {/* Occupancy Count */}
              <div className="glass-panel p-3.5 rounded-2xl flex flex-col justify-between">
                <span className="text-[10px] text-slate-400 font-medium">현재 이용 현황</span>
                <span className="text-lg font-extrabold text-emerald-400 mt-1">
                  {activeSelectedFacility.currentCount}
                  <span className="text-xs font-medium text-slate-400 ml-0.5">/ {activeSelectedFacility.capacity}명</span>
                </span>
              </div>

              {/* Operating Hours */}
              <div className="glass-panel p-3.5 rounded-2xl flex flex-col justify-between">
                <span className="text-[10px] text-slate-400 font-medium">운영 시간</span>
                <span className="text-xs font-bold text-slate-200 truncate mt-1.5">
                  {activeSelectedFacility.operatingHours?.open || "09:00"} ~ {activeSelectedFacility.operatingHours?.close || "22:00"}
                </span>
              </div>
            </div>

            {/* Feature Pills */}
            {activeSelectedFacility.features && Object.keys(activeSelectedFacility.features).length > 0 && (
              <div className="flex flex-wrap gap-1.5 py-1">
                {Object.entries(activeSelectedFacility.features).map(([key, val]) => {
                  if (typeof val === "boolean" && val) {
                    return (
                      <span
                        key={key}
                        className="text-[10px] bg-sky-500/10 border border-sky-500/20 text-sky-300 px-2 py-0.5 rounded-md font-semibold"
                      >
                        ✓ {key}
                      </span>
                    );
                  }
                  if (typeof val === "string" && key !== "average_processing_time") {
                    return (
                      <span
                        key={key}
                        className="text-[10px] bg-purple-500/10 border border-purple-500/20 text-purple-300 px-2 py-0.5 rounded-md font-semibold"
                      >
                        {key}: {val}
                      </span>
                    );
                  }
                  return null;
                })}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <button
                onClick={handleFindAlternative}
                className="flex-1 py-3 bg-gradient-to-r from-sky-500 to-purple-600 rounded-xl font-bold text-sm transition-all duration-300 hover:opacity-90 hover:shadow-lg hover:shadow-sky-500/25 active:scale-[0.98] text-center"
              >
                ⚡ TTTV AI 대안 추천 탐색
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
