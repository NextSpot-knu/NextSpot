'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Script from 'next/script';
import { Home, Bookmark, User, Search, Mic, Utensils, MapPin, Building2, Coffee, Sparkles, ChevronDown, ChevronUp } from 'lucide-react';
import { RecommendationCard } from '@/components/RecommendationCard';
import { createPublicClient } from '@/lib/supabase';
import { getMarkerSvg } from '@/lib/utils';
import { scoreFacility, compareSpot, rankFacilities, recToSpot, haversineMeters, cuisineMatch, rescoreWithPreference, filterReachable } from '@/lib/recommender';
import { findLandmark } from '@/lib/landmarks';
import { recommendByType, voiceTurn } from '@/lib/api-client';
import { useVoiceAssistant } from '@/lib/useVoiceAssistant';
import VoiceAssistantOrb from '@/components/VoiceAssistantOrb';

const supabase = createPublicClient();

// 술집(bar)이 음식점(restaurant)으로 적재되면 '음식점' 추천을 오염시킨다(데이터 한계).
// cuisine_tags 로 술집을 식별해 음식점 추천 후보에서만 제외(지도 마커로는 계속 표시 — 삭제 아님).
const _BAR_TAGS_MAIN = ['술집', '호프', '오뎅바', '실내포장마차', '일본식주점', '호프,요리주점', '포차', '선술집'];
function isBarFacility(f: any): boolean {
  const raw = f?.features?.cuisine_tags ?? f?.features?.cuisine;
  const tags = Array.isArray(raw) ? raw.map((x: any) => String(x)) : (typeof raw === 'string' ? [raw] : []);
  return tags.some((t: string) => _BAR_TAGS_MAIN.includes(t));
}

declare global {
  interface Window {
    kakao: any;
  }
}


export default function MainPage() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const userMarkerRef = useRef<any>(null);
  const activeOverlayRef = useRef<any>(null);

  const [activeTab, setActiveTab] = useState('Home');
  const [activeFilter, setActiveFilter] = useState('음식점'); // 첫 접속 시 음식점 세션을 먼저 표시(탭 순서와 일치)
  const [facilities, setFacilities] = useState<any[]>([]);
  const [selectedFacility, setSelectedFacility] = useState<any>(null);
  // 음성 선호 필터(예: '양식 먹고 싶어'→양식 식당 id들). null이면 필터 없음.
  // Gemini가 실시간으로 추천 풀을 좁혀 그 안에서 SPOT로 재랭킹한다.
  // state = 카드/핸들러 렌더용, ref = 추천 effect가 dep 없이 최신값을 읽기 위함(필터 변경 시 더블셋 방지).
  const [voiceFilterIds, setVoiceFilterIds] = useState<Set<string> | null>(null);
  const voiceFilterIdsRef = useRef<Set<string> | null>(null);
  const applyVoiceFilter = (s: Set<string> | null) => { voiceFilterIdsRef.current = s; setVoiceFilterIds(s); };
  // 음식 의도(음성 발화 '고기/국밥/피자' 또는 온보딩 food 선호). 선호 일치율을 음식종류 매칭으로 산출하는 데 쓴다.
  const cuisineIntentRef = useRef<string | null>(null);
  // 랜드마크 상대거리 정렬 기준점(예: '첨성대 가까운 카페' → 첨성대 좌표). null이면 사용자 위치 기준.
  const rankingOriginRef = useRef<{ lat: number; lng: number } | null>(null);
  // 그룹(모음) 마커 하이라이트 id — 카드 선택(selectedFacility)과 분리해 마커 확대/색상변경만 적용
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapLevel, setMapLevel] = useState(4); // 지도 줌 레벨(작을수록 확대) — 줌별 마커 밀집도 제어
  const [isMockLocationMinimized, setIsMockLocationMinimized] = useState(true);
  const [isMockTimeMinimized, setIsMockTimeMinimized] = useState(true);
  const [mockHour, setMockHour] = useState<number | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
  };

  useEffect(() => {
    if (toastMessage) {
      const timer = setTimeout(() => {
        setToastMessage(null);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [toastMessage]);

  const router = useRouter();

  const appKey = process.env.NEXT_PUBLIC_KAKAO_MAPS_APP_KEY || process.env.NEXT_PUBLIC_KAKAO_API_KEY || process.env.NEXT_PUBLIC_KAKAO_MAP_KEY || "";

  // Load facilities from Supabase
  useEffect(() => {
    async function loadFacilities() {
      try {
        // Fetch facilities (limit 2000)
        const { data: facilitiesData, error: facError } = await supabase
          .from("facilities")
          .select("id, name, type, latitude, longitude, capacity, operating_hours, features")
          .limit(2000);

        if (facError) {
          console.warn("Failed to load facilities:", facError);
          return;
        }

        // Fetch only recent logs (limit 3000) to get the latest per facility
        const { data: logs, error: logsError } = await supabase
          .from("congestion_logs")
          .select("facility_id, congestion_level, current_count, timestamp")
          .order("timestamp", { ascending: false })
          .limit(3000);

        if (logsError) {
          console.warn("Failed to load congestion logs:", logsError);
        }

        const latestLogsMap: Record<string, any> = {};
        if (logs && logs.length > 0) {
          for (const log of logs) {
            if (!latestLogsMap[log.facility_id]) {
              latestLogsMap[log.facility_id] = log;
            }
          }
        }

        const mapped = facilitiesData.map((f: any) => {
          const latestLog = latestLogsMap[f.id];
          // 혼잡 로그가 없는 시설은 값을 합성(id 해시)하지 않고 null 로 둔다 —
          // 마커/카드가 '데이터 없음'(회색·—) 상태로 표시하도록 소비측에서 null 을 처리한다.
          const baseCongestion = latestLog ? latestLog.congestion_level : null;

          return {
            id: f.id,
            name: f.name,
            type: f.type,
            latitude: f.latitude,
            longitude: f.longitude,
            capacity: f.capacity,
            features: f.features,
            baseCongestion: baseCongestion,
            congestionLevel: baseCongestion,
            currentCount: latestLog ? latestLog.current_count : null,
            lastUpdated: latestLog ? latestLog.timestamp : null,
          };
        });

        setFacilities(mapped);
      } catch (err) {
        console.error("Error loading facilities:", err);
      }
    }

    loadFacilities();
  }, []);

  // Apply mock hour congestion scaling
  useEffect(() => {
    if (facilities.length === 0) return;
    
    setFacilities(prev => prev.map(f => {
      let currentCongestion = f.baseCongestion !== undefined ? f.baseCongestion : f.congestionLevel;
      if (mockHour !== null) {
        let hash2 = 0;
        for (let i = 0; i < f.id.length; i++) hash2 = Math.imul(31, hash2) + f.id.charCodeAt(f.id.length - 1 - i);
        const pop = Math.abs(hash2 % 100) / 100; // deterministic popularity (0.0~1.0)

        if (mockHour === 12.5) { // 점심 피크
          if (f.type === 'restaurant') {
            currentCongestion = pop > 0.6 ? (0.7 + pop * 0.3) : (pop + 0.2);
          } else if (f.type === 'attraction') {
            currentCongestion = pop > 0.8 ? (0.6 + pop * 0.4) : (pop * 0.8);
          } else {
            currentCongestion = pop * 0.5;
          }
        } else if (mockHour === 18.5) { // 저녁 피크
          if (f.type === 'attraction') {
            currentCongestion = pop > 0.5 ? (0.6 + pop * 0.4) : (pop + 0.1);
          } else if (f.type === 'restaurant') {
            currentCongestion = pop > 0.7 ? (0.6 + pop * 0.4) : (pop * 0.6);
          } else if (f.type === 'cafe') {
            currentCongestion = pop > 0.6 ? (0.5 + pop * 0.5) : (pop * 0.7);
          } else {
            currentCongestion = pop * 0.5;
          }
        }
      }
      // 로그 없는 시설(null)은 라이브 모드에서 null 유지 — '데이터 없음' 표시.
      // (mockHour 피크는 명시적 '시간 모킹' 시뮬레이션이라 합성 혼잡도를 그대로 사용한다.)
      return { ...f, congestionLevel: currentCongestion == null ? null : Math.min(1.0, currentCongestion) };
    }));
  }, [mockHour]);

  const [rankedFacilities, setRankedFacilities] = useState<any[]>([]);
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number }>({ lat: 35.8362, lng: 129.2095 });
  const [preferredCategories, setPreferredCategories] = useState<string[]>([]);
  const [userId, setUserId] = useState<string | null>(null);

  // Load user profile & current location
  useEffect(() => {
    async function loadUser() {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        setUserId(session.user.id);
        const { data: profile } = await supabase
          .from("users")
          .select("preferred_categories")
          .eq("id", session.user.id)
          .single();
        if (profile?.preferred_categories) {
          setPreferredCategories(profile.preferred_categories);
        }
      } else {
        setUserId("a2222222-2222-2222-2222-222222222222"); // Fallback mock user ID
      }
    }
    loadUser();

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          let lat = position.coords.latitude;
          let lng = position.coords.longitude;

          // Check if coordinates are outside Gyeongju Hwangnidan-gil boundaries
          const isWithinGyeongju = lat >= 35.82 && lat <= 35.85 && lng >= 129.19 && lng <= 129.24;
          if (!isWithinGyeongju) {
            lat = 35.8362; // Hwangnidan-gil center
            lng = 129.2095;
            console.log("User is outside Gyeongju. Mocking location to Hwangnidan-gil:", lat, lng);
          }

          setUserLocation({ lat, lng });
        },
        (error) => {
          console.warn("Geolocation failed, using default:", error);
        }
      );
    }
  }, []);

  // Synchronize User Location Marker on Map
  useEffect(() => {
    if (!mapLoaded || !mapInstanceRef.current || !userLocation) return;
    const kakao = window.kakao;

    if (userMarkerRef.current) {
      userMarkerRef.current.setMap(null);
    }

    const content = `
      <style>
        @keyframes pulse-user-marker {
          0% { transform: scale(0.3); opacity: 1; }
          100% { transform: scale(1.6); opacity: 0; }
        }
      </style>
      <div class="user-loc-marker" style="position: relative; width: 100px; height: 100px; pointer-events: none; filter: none; -webkit-filter: none;">
        <!-- Glow (푸른빛 펄스) -->
        <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; border-radius: 50%; background: radial-gradient(circle, rgba(59,130,246,0.6) 0%, rgba(59,130,246,0.2) 50%, rgba(59,130,246,0) 80%); animation: pulse-user-marker 1.2s infinite cubic-bezier(0.2, 0, 0.2, 1);"></div>
        <!-- White Border (Thick) -->
        <div style="position: absolute; top: 50%; left: 50%; width: 28px; height: 28px; margin-top: -14px; margin-left: -14px; background: #ffffff; border-radius: 50%; box-shadow: 0 0 10px rgba(0,0,0,0.3);"></div>
        <!-- Core (Blue dot) -->
        <div style="position: absolute; top: 50%; left: 50%; width: 14px; height: 14px; margin-top: -7px; margin-left: -7px; background: #3b82f6; border-radius: 50%;"></div>
      </div>
    `;

    const userMarker = new kakao.maps.CustomOverlay({
      position: new kakao.maps.LatLng(userLocation.lat, userLocation.lng),
      content: content,
      zIndex: 10
    });

    userMarker.setMap(mapInstanceRef.current);
    userMarkerRef.current = userMarker;
  }, [userLocation, mapLoaded]);

  // (selected facility ID sessionStorage sync removed – no longer used)


  // Load saved IDs, rejected IDs, and active filter from storage on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('nextspot_saved_facilities');
        if (saved) {
          const parsed = JSON.parse(saved);
          const ids = new Set<string>(parsed.map((item: any) => item.id));
          setSavedIds(ids);
        }
      } catch (e) {
        console.error("Failed to load saved IDs from localStorage:", e);
      }


      try {
        const rejected = sessionStorage.getItem('nextspot_rejected_ids');
        if (rejected) {
          setRejectedIds(new Set(JSON.parse(rejected)));
        }
      } catch (e) {
        console.error("Failed to load rejected IDs from sessionStorage:", e);
      }

      try {
        const savedFilter = sessionStorage.getItem('nextspot_active_filter');
        if (savedFilter) {
          setActiveFilter(savedFilter);
        }
      } catch (e) {
        console.error("Failed to load active filter from sessionStorage:", e);
      }
    }
  }, []);

  // 온보딩(setup)에서 고른 음식 선호를 '음식 의도' 기본값으로 로드(음성 발화가 있으면 그쪽이 덮어씀).
  useEffect(() => {
    try {
      const raw = localStorage.getItem('nextspot_setup_prefs');
      if (raw) {
        const food = String(JSON.parse(raw)?.food || '').trim();
        if (food) cuisineIntentRef.current = food === '분식·국밥' ? '분식 국밥 김밥' : food === '카페·디저트' ? '카페 디저트' : food;
      }
    } catch { /* noop */ }
  }, []);

  // 추천 점수·정렬·사유 로직은 lib/recommender(백엔드 SPOT 미러)로 분리.
  // CATEGORY_VECTORS·점수 계산·거리(haversine)는 모듈에 있고, 아래는 호출부 유지를 위한 얇은 위임 래퍼다.
  const calculateSPOT = (facility: any) =>
    scoreFacility(facility, { userLocation: rankingOriginRef.current ?? userLocation, preferredCategories, mockHour, cuisineIntent: cuisineIntentRef.current });

  const compareFacilities = compareSpot;

  // 모음(그룹)은 추천/카드 랭킹에서 내부 sub로 펼친다 — 그룹 자체는 카드로 띄우지 않고
  // 모음 안에서 '가장 최적의 개별 장소'를 추천한다(지도 마커는 그대로 모음으로 유지).
  const expandGroups = (list: any[]) =>
    list.flatMap((f: any) => (f.isGroup && Array.isArray(f.subFacilities)) ? f.subFacilities : [f]);

  // 선택 마커가 하단 카드에 가리지 않도록 지도 위쪽 가시영역으로 패닝(지도 중심을 마커보다 아래로 둔다).
  const panToVisible = (lat: number, lng: number) => {
    const map = mapInstanceRef.current;
    if (!map || typeof window === 'undefined' || !window.kakao) return;
    const latlng = new window.kakao.maps.LatLng(lat, lng);
    try {
      const proj = map.getProjection();
      const pt = proj.containerPointFromCoords(latlng);
      const h = mapContainerRef.current?.clientHeight || 0;
      const target = proj.coordsFromContainerPoint(
        new window.kakao.maps.Point(pt.x, pt.y + Math.round(h * 0.22))
      );
      map.panTo(target);
    } catch (e) {
      map.panTo(latlng);
    }
  };

  // AI 추천 동기화: 실 DB 시설은 백엔드(/recommendations/by-type) 랭킹 + Gemini 사유,
  // 합성 그룹·시간대 시뮬(mockHour) 등 데모는 lib/recommender 미러(사유 포함)로 처리해 합친 뒤 #1을 표시.
  // (백엔드는 합성 시설/mockHour 를 모르므로 데모는 분리해 클라 미러로 점수를 매긴다.)
  useEffect(() => {
    if (facilities.length === 0) return;

    const filterMap: Record<string, string> = {
      '음식점': 'restaurant',
      '카페': 'cafe',
      '관광지': 'attraction',
      '문화시설': 'culture'
    };
    const targetType = filterMap[activeFilter];

    const typeOk = (f: any) => f.type === targetType && !(targetType === 'restaurant' && isBarFacility(f)); // 식당 추천에서 술집 제외
    let candidates = facilities.filter(
      f => typeOk(f) && !rejectedIds.has(f.id) && !savedIds.has(f.id)
    );
    if (candidates.length === 0) {
      candidates = facilities.filter(typeOk);
    }
    if (candidates.length === 0) {
      setSelectedFacility(null);
      return;
    }

    const isDemo = (f: any) => f.isGroup || String(f.id).startsWith('dummy-');
    const realCands = candidates.filter(f => !isDemo(f));
    // 모음은 sub로 펼쳐 개별 장소를 랭킹(모음 자체는 카드로 안 띄움). 펼친 sub도 거절/저장 제외.
    const demoCands = expandGroups(candidates.filter(isDemo))
      .filter((f: any) => !rejectedIds.has(f.id) && !savedIds.has(f.id));
    const liveMode = mockHour === null; // 시간대 시뮬이 켜지면 데모(목업) 모드로 일관 처리
    rankingOriginRef.current = null; // 랜드마크 기준점 리셋(카테고리 전환 시)
    const scoreOpts = { userLocation: rankingOriginRef.current ?? userLocation, preferredCategories, mockHour, cuisineIntent: cuisineIntentRef.current };

    let cancelled = false;
    (async () => {
      try {
        let all: any[];
        const vfilter = voiceFilterIdsRef.current; // ref로 최신 필터를 읽음(이 effect는 voiceFilterIds를 dep로 안 둠)
        if (vfilter) {
          // 음성 선호 필터(예: '양식'): 후보를 Gemini가 고른 id들로 좁혀 클라 미러로 SPOT 재랭킹(실시간).
          // (필터 변경 직후 첫 카드는 onFilter가 동기로 직접 set하므로 여기선 이후 재실행 케이스만 처리.)
          const filtered = expandGroups(candidates)
            .filter((f: any) => vfilter.has(f.id) && !rejectedIds.has(f.id) && !savedIds.has(f.id));
          all = rankFacilities(filtered, scoreOpts);
        } else {
          let realRanked: any[] = [];
          if (liveMode && realCands.length > 0) {
            try {
              // 백엔드에는 rejectedIds와 savedIds를 제외하고 요청
              const recs = await recommendByType(targetType, userLocation, [...rejectedIds, ...savedIds]);
              const byId = new Map(realCands.map(f => [f.id, f]));
              realRanked = recs
                .filter(r => byId.has(r.facility.id))
                .map(r => {
                  const base = byId.get(r.facility.id);
                  const spot = recToSpot(r);
                  return { ...base, spot, reason: r.reason || "" }; // 백엔드 Gemini 사유만
                });
              // 음식 의도(음성/온보딩)가 있으면 선호%·점수를 음식종류 매칭으로 재산출해 표시·랭킹을 의도와 일치시킨다.
              // (백엔드 선호는 시설타입 4종 벡터라 식당별로 고정 → 의도가 있을 땐 미러로 음식종류 반영. 사유는 백엔드 유지.)
              if (cuisineIntentRef.current) {
                // 백엔드 SPOT(예측 대기·이동·incentive) 보존 + 선호항만 cuisineMatch 로 교체해 재점수.
                // 비식당/미인식(cm=null)은 백엔드 spot 그대로 유지 → 통째 재계산이 사유·수치를 어긋나게 하던 문제 해소.
                realRanked = realRanked
                  .map(f => {
                    const cm = cuisineMatch(f, cuisineIntentRef.current);
                    return cm !== null ? { ...f, spot: rescoreWithPreference(f.spot, cm, f) } : f;
                  })
                  .sort(compareSpot);
              }
            } catch (e) {
              console.warn("by-type 추천 실패 → 목업 미러로 폴백:", e);
              realRanked = [];
            }
          }
          // 백엔드 미가용/데모 모드: 실 후보도 클라 미러로 랭킹(동일 가중치). 도보 비현실 거리는 제외(가까운 순 폴백).
          if (realRanked.length === 0 && realCands.length > 0) {
            realRanked = rankFacilities(filterReachable(realCands, userLocation), scoreOpts);
          }
          // 합성/데모 시설은 항상 클라 미러로 점수 부여
          const demoRanked = rankFacilities(demoCands, scoreOpts);
          all = [...realRanked, ...demoRanked].sort(compareSpot);
          all.forEach((f, i) => { 
            f.apiRank = i + 1; 
            f.totalCandidates = all.length; 
          });
        }

        if (cancelled) return;
        setRankedFacilities(all);
        if (all.length === 0) {
          setSelectedFacility(null);
          return;
        }
        const top = all[0];
        setSelectedFacility(top);
        if (mapInstanceRef.current && typeof top.latitude === 'number') {
          panToVisible(top.latitude, top.longitude);
        }
      } catch (err) {
        console.error("Error in recommendation synchronization effect:", err);
      }
    })();

    return () => { cancelled = true; };
    // voiceFilterIds 는 dep로 두지 않는다(필터 변경은 onFilter가 직접 처리; effect는 ref로 최신값 읽음 → 더블셋/경합 방지).
    // rejectedIds, savedIds 도 dep에서 제외하여 거절/저장 시 불필요한 백엔드 API 재호출(점수/순위 리셋 현상)을 방지.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facilities, activeFilter, userLocation, preferredCategories, mockHour]);

  // Action Button Handlers
  const handleAccept = (fac: any) => {
    if (!fac) return;

    let greeting = "즐거운 시간 되세요!";
    if (fac.type === "restaurant") greeting = "맛있게 드세요!";
    else if (fac.type === "cafe") greeting = "여유로운 시간 되세요!";
    else if (fac.type === "attraction" || fac.type === "culture") greeting = "즐거운 관람 되세요!";
    
    showToast(`${greeting} 다음 추천이 더 정확해집니다 🎯`);

    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    
    if (isMobile) {
      // 모바일 기기: 카카오맵 앱 전용 스킴 (즉시 자동차 길안내 시작)
      const destUrl = `kakaomap://route?sp=${userLocation.lat},${userLocation.lng}&ep=${fac.latitude},${fac.longitude}&by=CAR`;
      window.location.href = destUrl;
    } else {
      // PC 환경: 카카오맵 웹 스킴에서 자동 길찾기(자동차 기준)를 위해 WGS84 -> WCONGNAMUL 변환 API 호출
      const newWindow = window.open('', '_blank'); // 팝업 차단 방지를 위해 미리 띄움
      
      // 키는 env 전용 — 하드코딩 폴백 금지(커밋된 키는 유출로 간주, 로테이션 대상).
      const restApiKey = process.env.NEXT_PUBLIC_KAKAO_REST_API_KEY;
      if (!restApiKey) {
        // 키 미설정: 좌표 변환(transcoord) 없이 텍스트 채우기 방식 길찾기로 폴백(아래 catch 와 동일 경로).
        const destUrl = `https://map.kakao.com/?sName=${encodeURIComponent("현재 위치")}&eName=${encodeURIComponent(fac.name)}&sY=${userLocation.lat}&sX=${userLocation.lng}&eY=${fac.latitude}&eX=${fac.longitude}`;
        if (newWindow) newWindow.location.href = destUrl; else window.location.href = destUrl;
        return;
      }
      const headers = { 'Authorization': `KakaoAK ${restApiKey}` };
      
      const urlStart = `https://dapi.kakao.com/v2/local/geo/transcoord.json?x=${userLocation.lng}&y=${userLocation.lat}&input_coord=WGS84&output_coord=WCONGNAMUL`;
      const urlEnd = `https://dapi.kakao.com/v2/local/geo/transcoord.json?x=${fac.longitude}&y=${fac.latitude}&input_coord=WGS84&output_coord=WCONGNAMUL`;

      Promise.all([
        fetch(urlStart, { headers }).then(r => r.json()),
        fetch(urlEnd, { headers }).then(r => r.json())
      ]).then(([startData, endData]) => {
        if (startData.documents?.length > 0 && endData.documents?.length > 0) {
          const sX = startData.documents[0].x;
          const sY = startData.documents[0].y;
          const eX = endData.documents[0].x;
          const eY = endData.documents[0].y;
          // target=car 와 rt 파라미터를 사용하여 즉시 길안내 화면 렌더링
          const destUrl = `https://map.kakao.com/?map_type=TYPE_MAP&target=car&rt=${sX},${sY},${eX},${eY}&rt1=${encodeURIComponent("현재 위치")}&rt2=${encodeURIComponent(fac.name)}`;
          if (newWindow) newWindow.location.href = destUrl; else window.location.href = destUrl;
        } else {
          throw new Error("좌표 변환 실패");
        }
      }).catch(err => {
        console.error("PC 길안내 자동 시작 실패(좌표변환 에러):", err);
        // 실패 시 기존 텍스트 채우기 방식으로 폴백
        const destUrl = `https://map.kakao.com/?sName=${encodeURIComponent("현재 위치")}&eName=${encodeURIComponent(fac.name)}&sY=${userLocation.lat}&sX=${userLocation.lng}&eY=${fac.latitude}&eX=${fac.longitude}`;
        if (newWindow) newWindow.location.href = destUrl; else window.location.href = destUrl;
      });
    }
  };

  const handlePutOff = (fac: any) => {
    if (!fac) return;
    
    // Clear selection from sessionStorage immediately to prevent restoration logic from sticking to this item
    if (typeof window !== 'undefined') {
      try {
        sessionStorage.removeItem('nextspot_selected_facility_id');
      } catch (e) {}
    }

    const filterMap: Record<string, string> = {
      '음식점': 'restaurant', '카페': 'cafe', '관광지': 'attraction', '문화시설': 'culture'
    };
    const targetType = filterMap[activeFilter];

    const nextSavedIds = new Set(savedIds);
    nextSavedIds.add(fac.id);
    const voicePass = (f: any) => !voiceFilterIds || voiceFilterIds.has(f.id); // 음성 선호 필터 유지

    // rankedFacilities (백엔드 순위) 기준 탐색: 방금 저장한 항목 제외
    let nextCandidates = rankedFacilities.filter(voicePass).filter((f: any) => !nextSavedIds.has(f.id));
    // 모두 소진되면 음성 필터만 유지해 루프백
    if (nextCandidates.length === 0) {
      nextCandidates = rankedFacilities.filter(voicePass);
    }

    if (nextCandidates.length > 0) {
      setSelectedFacility(nextCandidates[0]);
      if (mapInstanceRef.current && typeof nextCandidates[0].latitude === 'number') {
        panToVisible(nextCandidates[0].latitude, nextCandidates[0].longitude);
      }
    } else {
      setSelectedFacility(null);
    }

    setSavedIds(prev => {
      const next = new Set(prev);
      next.add(fac.id);
      return next;
    });

    try {
      const existing = localStorage.getItem('nextspot_saved_facilities');
      const bookmarks = existing ? JSON.parse(existing) : [];
      
      const spot = fac.spot || calculateSPOT(fac);
      if (!bookmarks.some((b: any) => b.id === fac.id)) {
        bookmarks.push({
          id: fac.id,
          name: fac.name,
          category: fac.type === 'restaurant' ? '음식점' : fac.type === 'cafe' ? '카페' : fac.type === 'attraction' ? '관광지' : '문화시설',
          trafficStatus: fac.congestionLevel >= 0.75 ? 'orange' : fac.congestionLevel >= 0.50 ? 'yellow' : fac.congestionLevel >= 0.25 ? 'green' : 'blue',
          waitTime: `${spot?.expectedWait || 0}분`,
          spot: spot,
          reason: fac.reason || ""
        });
        localStorage.setItem('nextspot_saved_facilities', JSON.stringify(bookmarks));
      }
    } catch (e) {
      console.error("Failed to save bookmark:", e);
    }

    showToast(`'${fac.name}'이(가) Saved 탭에 저장되었습니다! 다음 추천을 불러옵니다.`);
  };

  const handleReject = (fac: any) => {
    if (!fac) return;
    
    // Clear selection from sessionStorage immediately to prevent restoration logic from sticking to this item
    if (typeof window !== 'undefined') {
      try {
        sessionStorage.removeItem('nextspot_selected_facility_id');
      } catch (e) {}
    }

    const filterMap: Record<string, string> = {
      '음식점': 'restaurant', '카페': 'cafe', '관광지': 'attraction', '문화시설': 'culture'
    };
    const targetType = filterMap[activeFilter];

    // Next candidates: exclude already-rejected (prev rejectedIds + current fac) and saved
    const nextRejectedIds = new Set(rejectedIds);
    nextRejectedIds.add(fac.id);
    const voicePass = (f: any) => !voiceFilterIds || voiceFilterIds.has(f.id); // 음성 선호 필터 유지

    // 다음 추천은 첫 추천과 동일한 점수 체계 유지를 위해 백엔드 랭킹(rankedFacilities)에서 소비한다
    // (기존: 클라 calculateSPOT 재계산 → 거절 시 점수 체계가 몰래 바뀌던 문제).
    let nextCandidates = rankedFacilities
      .filter((f: any) => voicePass(f) && !nextRejectedIds.has(f.id) && !savedIds.has(f.id));

    // 랭킹 리스트가 소진된 경우에만 클라 미러(calculateSPOT)로 폴백 — 전체 후보 루프백(음성 필터는 유지)
    if (nextCandidates.length === 0) {
      nextCandidates = expandGroups(facilities.filter(f => f.type === targetType))
        .filter(voicePass)
        .map((f: any) => ({ ...f, spot: calculateSPOT(f) }))
        .sort(compareFacilities);
    }

    if (nextCandidates.length > 0) {
      setSelectedFacility(nextCandidates[0]);
      if (mapInstanceRef.current && typeof nextCandidates[0].latitude === 'number') {
        panToVisible(nextCandidates[0].latitude, nextCandidates[0].longitude);
      }
    } else {
      setSelectedFacility(null);
    }
    // ★ Force card open so the next recommendation is visible

    setRejectedIds(prev => {
      const next = new Set(prev);
      next.add(fac.id);
      if (typeof window !== 'undefined') {
        try {
          sessionStorage.setItem('nextspot_rejected_ids', JSON.stringify(Array.from(next)));
        } catch (e) {
          console.error("Failed to save rejected IDs to sessionStorage:", e);
        }
      }
      return next;
    });
    
    showToast(`'${fac.name}' 추천을 폐기했습니다. 다음 추천을 불러옵니다.`);
  };

  // 음성 '다음/별로': 폐기(rejectedIds)하지 않고 '안정 랭킹'에서 다음 순위로만 이동(우선순위만 낮춤).
  // 거절한 시설은 풀에 그대로 남아 순위 유지·재방문 가능. 끝이면 처음으로 순환.
  const handleAdvanceRank = (fac: any) => {
    if (!fac) return;
    const voicePass = (f: any) => !voiceFilterIds || voiceFilterIds.has(f.id);
    const pool = expandGroups(facilities.filter(f => f.type === fac.type))
      .filter((f: any) => voicePass(f) && !rejectedIds.has(f.id) && !savedIds.has(f.id))
      .map((f: any) => ({ ...f, spot: calculateSPOT(f) }))
      .sort(compareFacilities);
    if (pool.length <= 1) { showToast('다른 추천이 없어요.'); return; }
    const curIdx = pool.findIndex(f => f.id === fac.id);
    const next = pool[curIdx < 0 ? 0 : (curIdx + 1) % pool.length]; // 폐기 안 함 — 순위 순서대로 다음, 끝이면 처음
    setSelectedFacility(next);
    if (mapInstanceRef.current && typeof next.latitude === 'number') panToVisible(next.latitude, next.longitude);
  };

  // ── 음성 비서: 현재 추천 카드를 Gemini 사유로 TTS 안내 + STT 응답 위임 ──
  // 수락(응/가자)→handleAccept(길안내), 다음/별로→handleReject(폐기+다음), 자세히→상세 재안내, 그만→종료.
  const voice = useVoiceAssistant<any>({
    getName: (f) => f?.name ?? '이 장소',
    getReason: (f) => f?.reason || '', // 백엔드 Gemini 사유만(없으면 이름만 안내) — 하드코딩 제거
    // Gemini가 spoken으로 실데이터 상세를 주는 게 우선. 이건 Gemini 불가 시 폴백 — 종류/혼잡/도보로 구성.
    getDetail: (f) => {
      const t = f?.spot || calculateSPOT(f);
      const parts: string[] = [];
      const tags = f?.features?.cuisine_tags;
      const kind = Array.isArray(tags) ? tags.join(', ') : (typeof tags === 'string' ? tags : null);
      if (kind) parts.push(`${kind} 쪽`);
      if (typeof f?.congestionLevel === 'number') parts.push(`혼잡도 ${Math.round(f.congestionLevel * 100)}%`);
      if (t?.expectedTravel != null) parts.push(`도보 ${t.expectedTravel}분`);
      else if (t?.expectedWait != null) parts.push(`예상 대기 ${t.expectedWait}분`);
      return parts.length
        ? `${f?.name ?? '이 장소'}는 ${parts.join(', ')}이에요. 여기로 안내할까요?`
        : `${f?.name ?? '이 장소'}, 여기로 안내할까요?`;
    },
    onAccept: (f) => handleAccept(f),
    onNext: (f) => handleAdvanceRank(f), // 음성 '다음/별로' → 폐기 안 하고 다음 순위로(우선순위만 낮춤)
    // Gemini가 선호('양식 먹고 싶어' 등)에 맞춰 고른 시설로 전환. spoken을 사유로 부여 → notifyItem이 읽어줌.
    onSelect: (id, spoken) => {
      const target = expandGroups(facilities).find((f: any) => f.id === id);
      if (!target) return;
      setSelectedFacility(spoken ? { ...target, reason: spoken } : target);
      if (mapInstanceRef.current && typeof target.latitude === 'number') panToVisible(target.latitude, target.longitude);
    },
    // Gemini가 선호로 후보를 좁힘(예: '양식 먹고 싶어'→양식 식당 id들). 추천 풀을 실시간 필터링해 재랭킹.
    // 동기로 필터 내 #1을 직접 set(첫 카드는 Gemini spoken을 사유로) → effect 더블셋/spoken 경합 없음.
    onFilter: (matchIds, spoken) => {
      const set = new Set(matchIds);
      const pool = expandGroups(facilities)
        .filter((f: any) => set.has(f.id) && !rejectedIds.has(f.id) && !savedIds.has(f.id));
      if (pool.length === 0) {
        showToast('음성 선호에 맞는 추천을 찾지 못했어요.'); // 빈 결과 → 필터 미적용(현재 카드 유지)
        return;
      }
      applyVoiceFilter(set); // ref+state 동시 갱신(effect는 이후 재실행 시 ref로 읽음)
      const ranked = pool.map((f: any) => ({ ...f, spot: calculateSPOT(f) })).sort(compareFacilities);
      setSelectedFacility(spoken ? { ...ranked[0], reason: spoken } : ranked[0]);
      if (mapInstanceRef.current && typeof ranked[0].latitude === 'number') panToVisible(ranked[0].latitude, ranked[0].longitude);
    },
    // 사용자 발화를 백엔드 Vertex Gemini(/api/v1/voice/turn)로 해석. 현재 타입 후보 목록(이름/혼잡/거리)을 동봉.
    interpret: async (utterance, f) => {
      const filterMap: Record<string, string> = { '음식점': 'restaurant', '카페': 'cafe', '관광지': 'attraction', '문화시설': 'culture' };
      const type = f?.type || filterMap[activeFilter] || 'restaurant';

      rankingOriginRef.current = null; // 식당/일반 경로는 사용자 위치 기준 정렬
      const cands = expandGroups(facilities)
        .filter((x: any) => x.type === type && !(type === 'restaurant' && isBarFacility(x)) && !rejectedIds.has(x.id) && !savedIds.has(x.id)) // 식당이면 술집 제외
        .map((x: any) => ({
          id: x.id,
          name: x.name,
          cuisine: x.features?.cuisine_tags ?? x.features?.cuisine ?? null, // Gemini가 양식/짜장면 등 매칭에 사용
          congestion: x.congestionLevel ?? 0,
          distanceM: haversineMeters(userLocation.lat, userLocation.lng, x.latitude, x.longitude),
        }))
        .sort((a, b) => a.distanceM - b.distanceM) // 가까운 순 — 전문점(고기/국밥/피자)이 상위 N 밖으로 밀려 누락되지 않게
        .slice(0, 30);                              // 의미검색 도달 후보 폭(백엔드 입력 상한 30). 분류별(중식 등) 후보 포함 확률↑
      const res = await voiceTurn(utterance, type, f?.name ?? null, cands);
      // 음식 선호 발화(filter)는 '식당'일 때만 음식 의도로 저장(주차/회의/휴게 선호% 오염 방지).
      if (res.action === 'filter' && type === 'restaurant') cuisineIntentRef.current = utterance;
      return { action: res.action, targetId: res.targetFacilityId, matchIds: res.matchIds, spoken: res.spoken };
    },
  });

  // 한 번만 등록되는 Kakao 지도 이벤트 콜백이 항상 '현재' voice(stop/active)를 참조하도록 ref 미러링.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  // 카드가 새로 뜨면(세션 활성 상태) Gemini 사유를 자동 발화, 카드가 사라지면 정지.
  // deps에 reason 포함 — 같은 시설이라도 mockHour/혼잡 변화로 사유가 바뀌면 새로 안내(id만 보면 놓침).
  useEffect(() => {
    // Notify the voice assistant about the current recommendation context (for interruption/correction)
    voice.notifyItem(selectedFacility ? selectedFacility : null);
  }, [selectedFacility?.id, selectedFacility?.reason]);

  // Initialize map if Kakao Maps script is already loaded
  useEffect(() => {
    const initInterval = setInterval(() => {
      if (typeof window !== "undefined" && window.kakao && window.kakao.maps && mapContainerRef.current) {
        clearInterval(initInterval);
        initMap();
      }
    }, 200);

    return () => clearInterval(initInterval);
  }, []);

  // Initialize Kakao Map
  const initMap = () => {
    if (mapInstanceRef.current) return;
    if (window.kakao && window.kakao.maps && mapContainerRef.current) {
      window.kakao.maps.load(() => {
        let centerLat = 35.8362;
        let centerLng = 129.2095;
        let level = 4;

        if (typeof window !== 'undefined') {
          const savedLat = sessionStorage.getItem('nextspot_map_center_lat');
          const savedLng = sessionStorage.getItem('nextspot_map_center_lng');
          const savedLevel = sessionStorage.getItem('nextspot_map_level');
          
          if (savedLat && savedLng) {
            const parsedLat = parseFloat(savedLat);
            const parsedLng = parseFloat(savedLng);
            if (!isNaN(parsedLat) && !isNaN(parsedLng)) {
              centerLat = parsedLat;
              centerLng = parsedLng;
            }
          }
          if (savedLevel) {
            const parsedLevel = parseInt(savedLevel, 10);
            if (!isNaN(parsedLevel)) {
              level = parsedLevel;
            }
          }
        }

        const options = {
          center: new window.kakao.maps.LatLng(centerLat, centerLng),
          level: level,
        };
        const map = new window.kakao.maps.Map(mapContainerRef.current, options);
        mapInstanceRef.current = map;
        setMapLoaded(true);

        // Save center and level on map idle
        setMapLevel(map.getLevel());
        window.kakao.maps.event.addListener(map, 'idle', () => {
          const center = map.getCenter();
          const lvl = map.getLevel();
          setMapLevel(lvl); // 줌 변경 시 마커 밀집도 재계산 트리거
          sessionStorage.setItem('nextspot_map_center_lat', center.getLat().toString());
          sessionStorage.setItem('nextspot_map_center_lng', center.getLng().toString());
          sessionStorage.setItem('nextspot_map_level', lvl.toString());
        });

        // 빈 지도(마커 외) 클릭 시 그룹 팝업 닫기 + 그룹 하이라이트 해제 + 추천 카드 선택해제 — 일반 지도앱 UX
        window.kakao.maps.event.addListener(map, 'click', () => {
          if (activeOverlayRef.current) {
            activeOverlayRef.current.setMap(null);
            activeOverlayRef.current = null;
          }
          setActiveGroupId(null);
          setSelectedFacility(null);
        });

        // 음성 비서(Gemini) 활성 중 지도 영역을 터치(탭/드래그/줌)하면 즉시 정지 —
        // 사용자가 지도를 보려는 의도이므로 안내가 끼어들지 않게 한다. (panTo 등 프로그램 이동은
        // dragstart/zoom_start/click 을 발생시키지 않아 음성 선택·필터 시 오작동하지 않음.)
        const stopVoiceOnMapTouch = () => {
          if (voiceRef.current?.active) voiceRef.current.stop();
        };
        window.kakao.maps.event.addListener(map, 'click', stopVoiceOnMapTouch);
        window.kakao.maps.event.addListener(map, 'dragstart', stopVoiceOnMapTouch);
        window.kakao.maps.event.addListener(map, 'zoom_start', stopVoiceOnMapTouch);
      });
    }
  };

  // Synchronize Markers (Filters & Facilities updates)
  useEffect(() => {
    if (!mapLoaded || !mapInstanceRef.current || facilities.length === 0) return;
    const kakao = window.kakao;

    // Clear old markers
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    // Map active filter label to DB type name
    const filterMap: Record<string, string> = {
      '음식점': 'restaurant',
      '카페': 'cafe',
      '관광지': 'attraction',
      '문화시설': 'culture'
    };
    const targetType = filterMap[activeFilter];

    const filtered = facilities.filter(f => f.type === targetType);

    // 줌 레벨별 마커 밀집도 — 시중 지도앱처럼 멀리 볼수록(레벨↑) 핵심 장소만, 확대할수록(레벨↓) 더 많이 표시.
    // Kakao level은 작을수록 확대. SPOT 상위 순으로 잘라 '대표 장소'를 우선 노출한다(브라우저 프리징도 방지).
    const densityCap = mapLevel <= 3 ? 200 : mapLevel <= 4 ? 60 : mapLevel <= 5 ? 30 : mapLevel <= 6 ? 14 : 6;
    const scoredFacilities = filtered.map(f => ({ ...f, spot: calculateSPOT(f) }));
    scoredFacilities.sort(compareFacilities);
    const displayFacilities = scoredFacilities.slice(0, densityCap);

    // 마커 크기: 평소엔 작게, 선택 시엔 확대(뒤쪽 펄스/이펙트 없이 크기만 키움). 화면 폭에 따라 반응형.
    const isNarrow = typeof window !== 'undefined' && window.innerWidth < 640;
    const baseW = isNarrow ? 28 : 34;
    const baseH = isNarrow ? 36 : 44;
    const selW = isNarrow ? 40 : 50;
    const selH = isNarrow ? 52 : 64;

    const newMarkers = displayFacilities.map((f) => {
      // 관광 POI는 모두 핀 마커(바닥 앵커).
      // 그룹 마커는 activeGroupId 로, 개별 마커는 selectedFacility 로 선택 판정 → 둘 다 진한 색 + 확대
      const isSel = f.isGroup
        ? activeGroupId === f.id
        : (!!selectedFacility && f.id === selectedFacility.id);
      const w = isSel ? selW : baseW;
      const h = isSel ? selH : baseH;
      const markerImage = new kakao.maps.MarkerImage(
        getMarkerSvg(f.type, f.congestionLevel, f.features, isSel),
        new kakao.maps.Size(w, h),
        { offset: new kakao.maps.Point(w / 2, h) }
      );

      const marker = new kakao.maps.Marker({
        position: new kakao.maps.LatLng(f.latitude, f.longitude),
        image: markerImage,
        title: f.name,
      });
      marker.setZIndex(isSel ? 100 : 1); // 선택된 마커를 위로

      kakao.maps.event.addListener(marker, "click", () => {
        console.log("Marker clicked:", f.name);
        
        if (activeOverlayRef.current) {
          activeOverlayRef.current.setMap(null);
          activeOverlayRef.current = null;
        }

        if (f.isGroup) {
          // 그룹 마커 자체를 하이라이트(확대+색) — 카드는 띄우지 않음(개별 선택 해제)
          setActiveGroupId(f.id);
          setSelectedFacility(null);
          const content = document.createElement('div');
          content.className = 'bg-[#111622]/95 backdrop-blur-xl border border-white/20 rounded-2xl p-2 shadow-2xl flex flex-col gap-1 min-w-[180px] max-w-[280px] max-h-[260px] overflow-y-auto no-scrollbar pointer-events-auto';

          const titleEl = document.createElement('div');
          titleEl.className = 'text-[10px] text-blue-400 font-bold px-2 py-1 mb-1 border-b border-white/10 uppercase tracking-wider';
          titleEl.innerText = f.name;
          content.appendChild(titleEl);

          f.subFacilities.forEach((sub: any) => {
            const btn = document.createElement('button');
            btn.className = 'text-left text-white text-xs px-3 py-2.5 hover:bg-white/10 rounded-xl transition-colors font-semibold whitespace-normal break-keep leading-snug cursor-pointer';
            btn.innerText = sub.name;
            btn.onclick = () => {
              setActiveGroupId(null);
              setSelectedFacility(sub);
              setSelectedFacility(sub);
              if (activeOverlayRef.current) {
                activeOverlayRef.current.setMap(null);
                activeOverlayRef.current = null;
              }
            };
            content.appendChild(btn);
          });

          const overlay = new window.kakao.maps.CustomOverlay({
            position: marker.getPosition(),
            content: content,
            yAnchor: 1.3,
            zIndex: 50,
            clickable: true // 팝업 내부 버튼 클릭이 지도로 새지 않게(목록 선택 시 하단 카드 표시)
          });
          
          overlay.setMap(mapInstanceRef.current);
          activeOverlayRef.current = overlay;
          mapInstanceRef.current.panTo(marker.getPosition());
        } else {
          setActiveGroupId(null);
          setSelectedFacility(f);
          setSelectedFacility(f);
          panToVisible(f.latitude, f.longitude);
        }
      });

      marker.setMap(mapInstanceRef.current);
      return marker;
    });

    markersRef.current = newMarkers;
    // selectedFacility 변경 시에도 재렌더해 선택 마커만 진한 색으로 갱신(기존 마커는 effect 시작부에서 정리)
  }, [facilities, activeFilter, mapLoaded, selectedFacility?.id, activeGroupId, mapLevel]);

  const filters = [
    { id: '음식점', icon: Utensils },
    { id: '카페', icon: Coffee },
    { id: '관광지', icon: MapPin },
    { id: '문화시설', icon: Building2 },
  ];

  const handleTabClick = (tabId: string) => {
    setActiveTab(tabId);
    if (tabId === 'Home') router.push('/main');
    if (tabId === 'Saved') router.push('/saved');
    if (tabId === 'MyPage') router.push('/mypage');
  };

  return (
    <div className="relative w-full h-screen overflow-hidden flex flex-col">

      {/* Map Container — 다크 필터는 globals.css 의 .map-dark-tiles 로 '타일 이미지(http)'에만 적용.
          마커/오버레이는 data: URI 이미지라 필터 제외 → 본래의 선명한 색으로 표시(필터 우회). */}
      <div
        ref={mapContainerRef}
        className="w-full h-full absolute inset-0 z-0 map-dark-tiles"
      />

      {/* Top Layer: Search & Filters */}
      <div className="absolute top-0 w-full z-20 pt-12 pb-4 px-4 bg-gradient-to-b from-black/80 to-transparent flex flex-col gap-4 pointer-events-none">
        
        {/* Search Bar */}
        <div className="flex items-center bg-[#131a28]/90 backdrop-blur-xl rounded-full px-4 py-3 border border-white/10 shadow-lg pointer-events-auto">
          <Search size={20} className="text-gray-400 mr-3" />
          <input 
            type="text" 
            placeholder="Search facilities, spots" 
            className="flex-1 bg-transparent text-white outline-none placeholder:text-gray-500 text-sm"
          />
          <Mic size={20} className="text-gray-400 ml-3" />
          <div className="w-8 h-8 rounded-full bg-blue-500/20 ml-4 flex items-center justify-center border border-blue-400/50">
            <User size={16} className="text-cyan-300" />
          </div>
        </div>

        {/* Filter Chips */}
        <div className="flex gap-3 overflow-x-auto no-scrollbar pointer-events-auto">
          {filters.map((filter) => {
            const Icon = filter.icon;
            const isActive = activeFilter === filter.id;
            return (
              <button
                key={filter.id}
                onClick={() => {
                  setActiveFilter(filter.id);
                  setActiveGroupId(null);
                  applyVoiceFilter(null); // 카테고리 전환 시 음성 선호 필터(예: 양식) 해제(ref+state)
                  // 필터(섹션) 전환 시 열려있던 모둠 팝업도 닫기
                  if (activeOverlayRef.current) {
                    activeOverlayRef.current.setMap(null);
                    activeOverlayRef.current = null;
                  }
                  if (typeof window !== 'undefined') {
                    sessionStorage.setItem('nextspot_active_filter', filter.id);
                  }
                }}
                className={`flex shrink-0 items-center whitespace-nowrap rounded-full border px-3 py-1.5 transition-all fractal-glass sm:px-4 sm:py-2 ${
                  isActive
                    ? 'bg-blue-600/30 border-blue-400 text-white shadow-[0_0_15px_rgba(59,130,246,0.3)] text-shadow-sm'
                    : 'border-white/10 text-gray-400 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon size={15} className={`mr-1.5 drop-shadow-md sm:mr-2 ${isActive ? 'text-blue-300' : 'text-gray-400'}`} />
                <span className={`text-[13px] font-medium sm:text-sm ${isActive ? 'text-shadow-sm' : ''}`}>{filter.id}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* AI Recommendation Card (Floating Bottom Sheet) */}
      {selectedFacility && (() => {
        try {
          const targetType = selectedFacility.type;
          let rank = selectedFacility.apiRank;
          let totalCandidates = selectedFacility.totalCandidates;
          
          if (!rank) {
            const activeCandidates = expandGroups(facilities.filter(f => f.type === targetType))
              .filter((f: any) => (!voiceFilterIds || voiceFilterIds.has(f.id)) && !rejectedIds.has(f.id) && !savedIds.has(f.id));
            const activeScored = activeCandidates.map(f => ({
              ...f,
              spot: calculateSPOT(f)
            })).sort(compareFacilities);

            const rankIndex = activeScored.findIndex(f => f.id === selectedFacility.id);
            rank = rankIndex !== -1 ? rankIndex + 1 : undefined;
            totalCandidates = activeScored.length;
          }

          const spot = selectedFacility.spot || calculateSPOT(selectedFacility);
          // 사유: 자동 추천된 실 시설은 백엔드 Gemini 사유, 마커 직접 클릭/데모는 미러 사유로 폴백
          const reason = selectedFacility.reason || ""; // 백엔드 Gemini 사유만(하드코딩 제거)
          return (
            <div className="absolute bottom-[90px] w-full z-20 px-4 transition-all duration-300">
              {voice.ttsSupported && (
                <div className="flex justify-end mb-2 pr-1">
                  <VoiceAssistantOrb
                    active={voice.active}
                    voiceState={voice.voiceState}
                    liveTranscript={voice.liveTranscript}
                    caption={voice.caption}
                    sttSupported={voice.sttSupported}
                    onOrb={voice.onOrbClick}
                  />
                </div>
              )}
              <RecommendationCard
                title={selectedFacility.name}
                reason={reason}
                description={
                  // 혼잡 로그 없는 시설 — 합성값 대신 '데이터 없음' 표기
                  typeof selectedFacility.congestionLevel === 'number'
                    ? `실시간 혼잡도: ${selectedFacility.congestionLevel >= 0.75 ? '혼잡' : selectedFacility.congestionLevel >= 0.5 ? '보통' : selectedFacility.congestionLevel >= 0.25 ? '여유' : '한산'} · 수용현황: ${selectedFacility.currentCount ?? '—'}/${selectedFacility.capacity}명`
                    : '실시간 혼잡도: 데이터 없음'
                }
                onAccept={() => handleAccept(selectedFacility)}
                onReject={() => handleReject(selectedFacility)}
                onPutOff={() => handlePutOff(selectedFacility)}
                spotScore={spot.score}
                preferencePercent={spot.preferencePercent}
                expectedWait={spot.expectedWait}
                expectedTravel={spot.expectedTravel}
                timeToService={spot.timeToService}
                facilityType={selectedFacility.type}
                facility={selectedFacility}
                rank={rank}
                totalCandidates={totalCandidates}
                mockHour={mockHour}
              />
            </div>
          );
        } catch (err) {
          console.error("Error rendering RecommendationCard IIFE:", err);
          return null;
        }
      })()}

      {/* Test Mock Sidebar (Right Side) */}
      <div className="absolute right-4 top-[170px] z-20 flex flex-col gap-3 pointer-events-auto">
        {/* Location Mock */}
        <div className="bg-[#111622]/90 backdrop-blur-xl border border-white/10 rounded-2xl shadow-lg flex flex-col overflow-hidden transition-all duration-300">
          <div 
            className="px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-white/5 active:bg-white/10 transition-colors"
            onClick={() => setIsMockLocationMinimized(!isMockLocationMinimized)}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-cyan-400">📍</span>
              {!isMockLocationMinimized && (
                <span className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider">
                  위치 모킹
                </span>
              )}
            </div>
            {isMockLocationMinimized ? (
              <ChevronDown size={14} className="text-gray-400" />
            ) : (
              <ChevronUp size={14} className="text-gray-400 ml-2" />
            )}
          </div>
          
          {!isMockLocationMinimized && (
            <div className="px-3 pb-3 border-t border-white/5">
              <div className="grid grid-cols-1 gap-1.5 w-36 mt-2">
                {[
                  { id: 1, name: '황리단길', lat: 35.8362, lng: 129.2095 },
                  { id: 2, name: '대릉원', lat: 35.8389, lng: 129.2099 },
                  { id: 3, name: '첨성대', lat: 35.8347, lng: 129.2189 },
                  { id: 4, name: '동궁과 월지', lat: 35.8348, lng: 129.2265 },
                  { id: 5, name: '황남빵 본점', lat: 35.8389, lng: 129.2117 },
                  { id: 6, name: '교촌마을', lat: 35.8296, lng: 129.2156 }
                ].map((loc) => {
                  const isCurrent = Math.abs(userLocation.lat - loc.lat) < 0.0001 && Math.abs(userLocation.lng - loc.lng) < 0.0001;
                  return (
                    <button
                      key={loc.id}
                      onClick={() => {
                        setUserLocation({ lat: loc.lat, lng: loc.lng });
                        if (mapInstanceRef.current) {
                          mapInstanceRef.current.setCenter(new window.kakao.maps.LatLng(loc.lat, loc.lng));
                        }
                        if (typeof window !== 'undefined') {
                          sessionStorage.removeItem('nextspot_selected_facility_id');
                        }
                        showToast(`현재 위치를 '${loc.name}'(으)로 이동했어요.`);
                      }}
                      className={`py-1.5 px-2 rounded-lg text-xs font-bold transition-all ${
                        isCurrent
                          ? 'bg-blue-600 text-white border border-blue-400 shadow-md shadow-blue-500/25'
                          : 'bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10'
                      }`}
                    >
                      {loc.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Time Mock */}
        <div className="bg-[#111622]/90 backdrop-blur-xl border border-white/10 rounded-2xl shadow-lg flex flex-col overflow-hidden transition-all duration-300">
          <div 
            className="px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-white/5 active:bg-white/10 transition-colors"
            onClick={() => setIsMockTimeMinimized(!isMockTimeMinimized)}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-purple-400">🕒</span>
              {!isMockTimeMinimized && (
                <span className="text-[10px] text-purple-400 font-bold uppercase tracking-wider">
                  시간 모킹
                </span>
              )}
            </div>
            {isMockTimeMinimized ? (
              <ChevronDown size={14} className="text-gray-400" />
            ) : (
              <ChevronUp size={14} className="text-gray-400 ml-2" />
            )}
          </div>
          
          {!isMockTimeMinimized && (
            <div className="px-3 pb-3 border-t border-white/5">
              <div className="grid grid-cols-1 gap-1.5 w-32 mt-2">
                {[
                  { name: "현재 시간", value: null },
                  { name: "점심 피크", value: 12.5 },
                  { name: "저녁 피크", value: 18.5 }
                ].map((timeOption) => {
                  const isCurrent = mockHour === timeOption.value;
                  return (
                    <button
                      key={timeOption.name}
                      onClick={() => {
                        setMockHour(timeOption.value);
                        showToast(`가상 시간이 '${timeOption.name}'(으)로 설정되었습니다.`);
                      }}
                      className={`py-1.5 px-2 rounded-lg text-xs font-bold transition-all ${
                        isCurrent
                          ? 'bg-purple-600 text-white border border-purple-400 shadow-md shadow-purple-500/25'
                          : 'bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10'
                      }`}
                    >
                      {timeOption.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>





      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-[350px] left-1/2 z-50 pointer-events-none flex justify-center w-full max-w-sm px-4 animate-toast">
          <div className="bg-black/85 backdrop-blur-md text-white text-xs sm:text-sm px-5 py-3 rounded-full shadow-lg text-center font-medium break-keep w-max max-w-full">
            {toastMessage}
          </div>
        </div>
      )}
    </div>
  );
}
