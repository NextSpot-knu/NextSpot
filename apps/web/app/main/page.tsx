'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Script from 'next/script';
import { Home, Bookmark, User, Search, Mic, X, Utensils, MapPin, Building2, Coffee, Sparkles, ChevronDown, ChevronUp } from 'lucide-react';
import { RecommendationCard } from '@/components/RecommendationCard';
import { createPublicClient } from '@/lib/supabase';
import { getMarkerSvg } from '@/lib/utils';
import { scoreFacility, compareSpot, rankFacilities, recToSpot, haversineMeters, cuisineMatch, rescoreWithPreference, filterReachable } from '@/lib/recommender';
import { findLandmark } from '@/lib/landmarks';
import { REGION, isWithinRegion } from '@/lib/region';
import { recommendByType, voiceTurn, apiClient } from '@/lib/api-client';
// 히트맵 blob 의 색·크기 규칙(마커/배지 임계와 일관) 공용 헬퍼 — 중복 정의 금지, 그대로 재사용.
import { getHeatGradient, getHeatRadius } from '@/lib/heatmap';
import { useVoiceAssistant } from '@/lib/useVoiceAssistant';
import { useSpeechSearch } from '@/lib/useSpeechSearch';
import VoiceAssistantOrb from '@/components/VoiceAssistantOrb';
import { useT } from '@/lib/i18n/I18nProvider';

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
  // 히트맵 CustomOverlay blob 배열 — 토글 off / 데이터·필터·예측 변경 / 언마운트 시 정리(cleanup)용.
  const heatmapOverlaysRef = useRef<any[]>([]);

  const [activeTab, setActiveTab] = useState('Home');
  const [activeFilter, setActiveFilter] = useState('음식점'); // 첫 접속 시 음식점 세션을 먼저 표시(탭 순서와 일치)
  const [searchQuery, setSearchQuery] = useState(''); // 로컬 시설명 검색(마커 필터). TourAPI 의미검색 연동은 범위 밖.
  const [facilities, setFacilities] = useState<any[]>([]);
  // 시설 로드 상태(데모 사고 방지선): 로딩 스피너·재시도·전체 빈 상태 안내 렌더용.
  const [isLoadingFacilities, setIsLoadingFacilities] = useState(true);
  const [facilitiesLoadError, setFacilitiesLoadError] = useState(false);
  const [facilitiesReloadNonce, setFacilitiesReloadNonce] = useState(0); // '다시 시도' 트리거(로드 effect 재실행)
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

  // 히트맵 레이어 on/off — 혼잡 핀과 별개의 열지도 오버레이(CongestionMap 에서 이식). 기본 꺼짐.
  const [showHeatmap, setShowHeatmap] = useState(false);
  // ♿ 배리어프리 필터 on/off — 켜지면 features.barrier_free 가 truthy 인(휠체어 등 무장애) 시설만 마커·히트맵에 표시. 기본 꺼짐.
  const [showBarrierFree, setShowBarrierFree] = useState(false);
  // 예측 타임슬라이더 상태 — 0=지금(실측), 1~3=+N시간 후 AI 예측. predictionMap 은 시설별 예측 혼잡도.
  const [hoursAhead, setHoursAhead] = useState(0);
  const [predictionMap, setPredictionMap] = useState<Record<string, { level: number; anchored: boolean }> | null>(null);
  const [predictionLoading, setPredictionLoading] = useState(false);
  // 슬라이더 썸 위치(0~3) — 드래그 중엔 이 값만 즉시 갱신하고, 놓을 때(onPointerUp/onKeyUp) handleTimeShift 로
  // 커밋한다(드래그 스텝마다 예측 호출이 폭주하지 않도록). 예측 성공/실패로 hoursAhead 가 바뀌면 썸을 재동기화.
  const [sliderPos, setSliderPos] = useState(0);
  useEffect(() => { setSliderPos(hoursAhead); }, [hoursAhead]);

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
  const t = useT();

  // 지도 검색바 음성 받아쓰기(STT) — 마이크 탭 → 한 발화를 검색어로 넣어 기존 마커 필터(searchQuery)를 그대로 재사용.
  // 미지원 브라우저면 supported=false → 마이크는 아래에서 '준비 중' 비활성으로 유지(정적 export/SSR 안전).
  const speechSearch = useSpeechSearch((text) => setSearchQuery(text));

  const appKey = process.env.NEXT_PUBLIC_KAKAO_MAPS_APP_KEY || process.env.NEXT_PUBLIC_KAKAO_API_KEY || process.env.NEXT_PUBLIC_KAKAO_MAP_KEY || "";

  // Load facilities from Supabase
  useEffect(() => {
    async function loadFacilities() {
      setIsLoadingFacilities(true);
      setFacilitiesLoadError(false);

      // 1순위: 백엔드 /infrastructures — 시설별 '최신' 혼잡을 서버가 결정적으로 조인(시설별 limit-1)해 내려준다.
      //   기존 supabase 경로(최근 3000행을 받아 클라이언트 dedup)는 로그가 잦은 시설이 캡을 채우면
      //   다른 시설이 congestion=null 로 조용히 누락되는 문제가 있었다 → 서버 조인이 이를 해소하고 전송량도 줄인다.
      try {
        const items = await apiClient.get("/api/v1/infrastructures");
        if (!Array.isArray(items)) throw new Error("unexpected infrastructures payload");
        const mapped = items.map((f: any) => {
          const level = f.congestion ? f.congestion.level : null; // 혼잡 로그 없는 시설은 null(데이터 없음)
          return {
            id: f.id,
            name: f.name,
            type: f.type,
            latitude: f.latitude,
            longitude: f.longitude,
            capacity: f.capacity,
            features: f.features,
            baseCongestion: level,
            congestionLevel: level,
            currentCount: f.congestion ? f.congestion.currentCount : null,
            lastUpdated: f.congestion ? f.congestion.timestamp : null,
          };
        });
        setFacilities(mapped);
        setIsLoadingFacilities(false);
        return;
      } catch (apiErr) {
        // 백엔드 미기동/네트워크 실패 → anon supabase 직접 조회로 폴백(회귀 없이 지도 렌더 유지).
        console.warn("시설 로드(백엔드 /infrastructures) 실패 — supabase 폴백:", apiErr);
      }

      // 2순위 폴백: anon supabase 직접 조회. 독립적인 두 쿼리를 병렬(Promise.all)로 — 직렬 await 제거.
      try {
        const [facRes, logRes] = await Promise.all([
          supabase
            .from("facilities")
            .select("id, name, type, latitude, longitude, capacity, operating_hours, features")
            .limit(2000),
          supabase
            .from("congestion_logs")
            .select("facility_id, congestion_level, current_count, timestamp")
            .order("timestamp", { ascending: false })
            .limit(3000),
        ]);

        if (facRes.error) {
          console.warn("Failed to load facilities:", facRes.error);
          setFacilitiesLoadError(true); // 백엔드/Supabase 모두 다운 → 빈 지도 대신 재시도 안내 표시
          setIsLoadingFacilities(false);
          return;
        }
        if (logRes.error) console.warn("Failed to load congestion logs:", logRes.error);

        const latestLogsMap: Record<string, any> = {};
        const logs = logRes.data;
        if (logs && logs.length > 0) {
          for (const log of logs) {
            if (!latestLogsMap[log.facility_id]) {
              latestLogsMap[log.facility_id] = log;
            }
          }
        }

        const mapped = (facRes.data || []).map((f: any) => {
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
        setIsLoadingFacilities(false);
      } catch (err) {
        console.warn("Error loading facilities:", err);
        setFacilitiesLoadError(true);
        setIsLoadingFacilities(false);
      }
    }

    loadFacilities();
  }, [facilitiesReloadNonce]);

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
  const [noRecommendation, setNoRecommendation] = useState(false); // 현재 카테고리 추천 후보 0건 여부(빈 상태 안내용)
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number }>({ ...REGION.center });
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

          // 서비스 지역(지오펜스) 밖이면 지역 중심점으로 모킹 — 경계/중심은 lib/region.ts 단일 소스
          if (!isWithinRegion(lat, lng)) {
            lat = REGION.center.lat;
            lng = REGION.center.lng;
            console.log(`User is outside ${REGION.name}. Mocking location to region center:`, lat, lng);
          }

          setUserLocation({ lat, lng });
        },
        (error) => {
          console.warn("Geolocation failed, using default:", error);
          // 위치 권한 거부/실패 시 조용히 경주 중심으로 폴백하면 거리·도보시간이 이유 없이 어긋나 보인다.
          // 흐름을 막지 않는 가벼운 토스트로 '경주 중심 기준'임을 알린다.
          showToast(t('map.locationFallback'));
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
        <!-- Glow (신라 금빛 펄스) -->
        <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; border-radius: 50%; background: radial-gradient(circle, rgba(193,154,62,0.6) 0%, rgba(193,154,62,0.2) 50%, rgba(193,154,62,0) 80%); animation: pulse-user-marker 1.2s infinite cubic-bezier(0.2, 0, 0.2, 1);"></div>
        <!-- White Border (Thick) -->
        <div style="position: absolute; top: 50%; left: 50%; width: 28px; height: 28px; margin-top: -14px; margin-left: -14px; background: #ffffff; border-radius: 50%; box-shadow: 0 0 10px rgba(43,35,32,0.25);"></div>
        <!-- Core (금빛 점) -->
        <div style="position: absolute; top: 50%; left: 50%; width: 14px; height: 14px; margin-top: -7px; margin-left: -7px; background: #c19a3e; border-radius: 50%;"></div>
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
        console.warn("Failed to load saved IDs from localStorage:", e);
      }


      try {
        const rejected = sessionStorage.getItem('nextspot_rejected_ids');
        if (rejected) {
          setRejectedIds(new Set(JSON.parse(rejected)));
        }
      } catch (e) {
        console.warn("Failed to load rejected IDs from sessionStorage:", e);
      }

      try {
        const savedFilter = sessionStorage.getItem('nextspot_active_filter');
        if (savedFilter) {
          setActiveFilter(savedFilter);
        }
      } catch (e) {
        console.warn("Failed to load active filter from sessionStorage:", e);
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

  // 표시 시설 선택(카테고리 필터 + 이름 검색 + 줌 레벨별 밀집도 상한)을 한 곳에 모은 헬퍼.
  // 마커 동기화 effect 와 히트맵 effect 가 '동일한 시설 집합'을 그리도록(열지도=마커 정직성) 공용 사용한다.
  // (기존 마커 effect 의 인라인 계산을 그대로 옮긴 것 — 동작 불변, source 만 파라미터화.)
  const computeDisplayFacilities = (source: any[]) => {
    const filterMap: Record<string, string> = { '음식점': 'restaurant', '카페': 'cafe', '관광지': 'attraction', '문화시설': 'culture' };
    const targetType = filterMap[activeFilter];
    const q = searchQuery.trim().toLowerCase();
    const filtered = source.filter(f => f.type === targetType && (q === '' || String(f.name ?? '').toLowerCase().includes(q)));
    const densityCap = mapLevel <= 3 ? 200 : mapLevel <= 4 ? 60 : mapLevel <= 5 ? 30 : mapLevel <= 6 ? 14 : 6;
    const scored = filtered.map(f => ({ ...f, spot: calculateSPOT(f) }));
    scored.sort(compareFacilities);
    return scored.slice(0, densityCap);
  };

  // 예측 모드 여부 — 예측 데이터 수신 성공 시에만 true(실패 시 '지금' 모드 유지 → 지도가 깨지지 않음).
  const isForecast = hoursAhead > 0 && predictionMap !== null;

  // 마커/히트맵 소스: '지금'은 실측 facilities 그대로, 예측 모드에선 congestionLevel 만 예측값으로 치환한
  // 파생 목록. 원본 facilities 는 불변 → '지금'으로 복귀 시 즉시 실측 표시, 추천/카드 로직에 영향 없음.
  // (예측 대상은 실 시설. 그룹/데모 합성 시설은 predictionMap 에 없어 그대로 유지된다.)
  const markerFacilities = useMemo(() => {
    const src = (!isForecast || !predictionMap)
      ? facilities
      : facilities.map((f) => {
          const pred = predictionMap[f.id];
          return pred ? { ...f, congestionLevel: pred.level } : f;
        });
    // ♿ 배리어프리 필터: 켜지면 features.barrier_free 가 truthy 인 시설만 남긴다.
    // 마커·히트맵 공용 소스에서 한 번만 걸러 두 레이어가 항상 동일 집합을 그린다.
    // (추천/카드 로직은 원본 facilities 를 쓰므로 필터의 영향을 받지 않는다 — 지도 표시만 좁힘.)
    return showBarrierFree ? src.filter((f) => !!(f?.barrier_free ?? f?.features?.barrier_free)) : src;
  }, [facilities, predictionMap, isForecast, showBarrierFree]);

  // 타임슬라이더 전환: 지금(0)=실측 복귀, +N시간=백엔드 배치 예측으로 마커·히트맵 재채색.
  // 실패 시 예측을 적용하지 않고 '지금' 모드를 유지(토스트 안내) — 회귀 없이 안전.
  const handleTimeShift = async (n: number) => {
    if (n === hoursAhead || predictionLoading) return;
    if (n === 0) {
      setHoursAhead(0);
      setPredictionMap(null); // 실측 표시 복귀
      return;
    }
    setPredictionLoading(true);
    try {
      // 주의: predict 라우터는 /api/v1 이 아닌 /predict 프리픽스(main.py) 아래에 있다.
      // apiClient 가 body 를 snake_case(hours_ahead)로, 응답을 camelCase 로 변환한다.
      const res = await apiClient.post('/predict/batch', { hoursAhead: n });
      const map: Record<string, { level: number; anchored: boolean }> = {};
      for (const p of res?.predictions ?? []) {
        map[p.facilityId] = { level: p.predictedCongestion, anchored: p.anchored !== false };
      }
      setPredictionMap(map);
      setHoursAhead(n);
    } catch (err) {
      console.warn('혼잡 예측 조회 실패 — 실측(지금) 모드를 유지합니다.', err);
      showToast(t('map.predictFail'));
    } finally {
      setPredictionLoading(false);
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
      setNoRecommendation(true); // (b) 후보 0건 → 카드 자리에 빈 상태 안내
      return;
    }
    setNoRecommendation(false); // 후보 존재 확인 → 이전 카테고리의 빈 상태 안내 즉시 해제(async 지연 중 오표시 방지)

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
          setNoRecommendation(true); // (b) 랭킹 결과 0건 → 빈 상태 안내
          return;
        }
        setNoRecommendation(false); // 후보 있음 → 안내 숨김
        const top = all[0];
        setSelectedFacility(top);
        if (mapInstanceRef.current && typeof top.latitude === 'number') {
          panToVisible(top.latitude, top.longitude);
        }
      } catch (err) {
        console.warn("Error in recommendation synchronization effect:", err);
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

    let greeting = t('map.greetingDefault');
    if (fac.type === "restaurant") greeting = t('map.greetingRestaurant');
    else if (fac.type === "cafe") greeting = t('map.greetingCafe');
    else if (fac.type === "attraction" || fac.type === "culture") greeting = t('map.greetingView');

    showToast(`${greeting}${t('map.greetingSuffix')}`);

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
        console.warn("PC 길안내 자동 시작 실패(좌표변환 에러):", err);
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
      setNoRecommendation(true); // (b) 후보 소진 → 빈 상태 안내
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
      console.warn("Failed to save bookmark:", e);
    }

    showToast(t('map.savedToast', { name: fac.name }));
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
      setNoRecommendation(true); // (b) 후보 소진 → 빈 상태 안내
    }
    // ★ Force card open so the next recommendation is visible

    setRejectedIds(prev => {
      const next = new Set(prev);
      next.add(fac.id);
      if (typeof window !== 'undefined') {
        try {
          sessionStorage.setItem('nextspot_rejected_ids', JSON.stringify(Array.from(next)));
        } catch (e) {
          console.warn("Failed to save rejected IDs to sessionStorage:", e);
        }
      }
      return next;
    });
    
    showToast(t('map.rejectToast', { name: fac.name }));
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
    if (pool.length <= 1) { showToast(t('map.noMoreRec')); return; }
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
        showToast(t('map.voiceNoMatch')); // 빈 결과 → 필터 미적용(현재 카드 유지)
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
        let centerLat = REGION.center.lat as number;
        let centerLng = REGION.center.lng as number;
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
    if (!mapLoaded || !mapInstanceRef.current || markerFacilities.length === 0) return;
    const kakao = window.kakao;

    // Clear old markers
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    // 표시 시설 선택(카테고리 필터 + 이름 검색 + 줌 밀집도 상한)을 computeDisplayFacilities 로 통일.
    // markerFacilities 는 '지금'=실측, 예측 모드=예측 혼잡도가 반영된 파생 목록 → 마커가 자동 재채색된다.
    const displayFacilities = computeDisplayFacilities(markerFacilities);

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
          content.className = 'bg-white/90 backdrop-blur border border-line rounded-2xl p-2 shadow-[0_2px_14px_rgba(43,35,32,0.1)] flex flex-col gap-1 min-w-[180px] max-w-[280px] max-h-[260px] overflow-y-auto no-scrollbar pointer-events-auto';

          const titleEl = document.createElement('div');
          titleEl.className = 'text-[10px] text-gold font-bold px-2 py-1 mb-1 border-b border-line tracking-wider';
          titleEl.innerText = f.name;
          content.appendChild(titleEl);

          f.subFacilities.forEach((sub: any) => {
            const btn = document.createElement('button');
            btn.className = 'text-left text-muk text-xs px-3 py-2.5 hover:bg-hanji-deep rounded-xl transition-colors font-semibold whitespace-normal break-keep leading-snug cursor-pointer';
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
    // markerFacilities 를 dep 으로 둬 예측(hoursAhead) 전환 시에도 마커가 예측 혼잡도로 재채색된다.
  }, [markerFacilities, activeFilter, mapLoaded, selectedFacility?.id, activeGroupId, mapLevel, searchQuery]);

  // 히트맵 레이어 (실 카카오맵) — 혼잡 핀과 별개의 CustomOverlay blob(CongestionMap 에서 이식).
  // showHeatmap 이 켜졌을 때만, 마커와 '동일한 표시 시설 집합'(computeDisplayFacilities)에
  // 혼잡도 색 radial-gradient 원을 얹는다. clickable=false + 낮은 zIndex 로 마커 클릭/상호작용을
  // 방해하지 않으며, ref 로 오버레이를 관리해 토글 off / 데이터·필터·예측 변경 / 언마운트 시 정리한다.
  // (main 은 실 카카오맵 모드만 지원 → 시뮬레이션 blob 은 해당 없음.)
  useEffect(() => {
    if (!mapLoaded || !mapInstanceRef.current || typeof window === 'undefined' || !window.kakao) return;
    const kakao = window.kakao;

    // 이전 오버레이 제거(잔상 방지) — 토글 off / 데이터·필터·예측 변경 모두 커버.
    heatmapOverlaysRef.current.forEach((o) => o.setMap(null));
    heatmapOverlaysRef.current = [];

    if (!showHeatmap) return;

    // 혼잡 로그 없는 시설(congestionLevel === null)은 열지도에서 제외 — '데이터 없음'을 색으로 합성하지 않음(정직성).
    const displayFacilities = computeDisplayFacilities(markerFacilities).filter(
      (f) => typeof f.congestionLevel === 'number' && typeof f.latitude === 'number' && typeof f.longitude === 'number'
    );

    const overlays = displayFacilities.map((f) => {
      const size = getHeatRadius(f.congestionLevel);
      const blob = document.createElement('div');
      blob.style.width = `${size}px`;
      blob.style.height = `${size}px`;
      blob.style.borderRadius = '50%';
      blob.style.background = getHeatGradient(f.congestionLevel);
      blob.style.mixBlendMode = 'screen'; // 겹칠수록 가산 합성되어 번지는 열지도 효과
      blob.style.pointerEvents = 'none';

      const overlay = new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(f.latitude, f.longitude),
        content: blob,
        xAnchor: 0.5, // 시설 좌표를 blob 중앙에 정렬
        yAnchor: 0.5,
        clickable: false, // 클릭은 아래 마커로 통과(마커 상호작용 회귀 방지)
        zIndex: 0, // 마커(zIndex 1/100)·사용자 위치(zIndex 10) 아래 — 핀이 blob 위에 보이도록
      });
      overlay.setMap(mapInstanceRef.current);
      return overlay;
    });

    heatmapOverlaysRef.current = overlays;

    return () => {
      heatmapOverlaysRef.current.forEach((o) => o.setMap(null));
      heatmapOverlaysRef.current = [];
    };
  }, [markerFacilities, activeFilter, mapLoaded, mapLevel, searchQuery, showHeatmap]);

  const filters = [
    { id: '음식점', key: 'restaurant', icon: Utensils },
    { id: '카페', key: 'cafe', icon: Coffee },
    { id: '관광지', key: 'attraction', icon: MapPin },
    { id: '문화시설', key: 'culture', icon: Building2 },
  ];

  const handleTabClick = (tabId: string) => {
    setActiveTab(tabId);
    if (tabId === 'Home') router.push('/main');
    if (tabId === 'Saved') router.push('/saved');
    if (tabId === 'MyPage') router.push('/mypage');
  };

  // (c) 검색 결과 유무 — 현재 카테고리에서 이름 일치 마커가 0건이면 '빈 지도' 혼란을 막기 위해 안내를 띄운다.
  const _filterTypeMap: Record<string, string> = { '음식점': 'restaurant', '카페': 'cafe', '관광지': 'attraction', '문화시설': 'culture' };
  const searchActive = searchQuery.trim() !== '';
  const searchMatchCount = searchActive
    ? facilities.filter(f => f.type === _filterTypeMap[activeFilter] && String(f.name ?? '').toLowerCase().includes(searchQuery.trim().toLowerCase())).length
    : 0;
  // ♿ 배리어프리 필터가 켜졌는데 현재 카테고리에 무장애 시설이 0건이면 '빈 지도' 혼란을 막기 위해 안내(검색 빈 상태와 동일 패턴).
  const barrierFreeMatchCount = showBarrierFree
    ? facilities.filter(f => f.type === _filterTypeMap[activeFilter] && !!(f?.barrier_free ?? f?.features?.barrier_free)).length
    : 0;

  return (
    <div className="relative w-full h-[100dvh] overflow-hidden flex flex-col">

      {/* Map Container — 자연스러운 라이트 카카오맵(한지 톤). 타일 다크 반전(map-dark-tiles) 제거 →
          경주 관광 밝은 지도. 마커/오버레이는 data: URI 이미지라 본래의 선명한 색으로 표시된다. */}
      <div
        ref={mapContainerRef}
        className="w-full h-full absolute inset-0 z-0"
      />

      {/* Top Layer: Search & Filters — 다크 오버레이 그라디언트 제거(플로팅 패널 자체 배경으로 가독성 확보) */}
      <div className="absolute top-0 w-full z-20 pt-12 pb-4 px-4 flex flex-col gap-4 pointer-events-none">
        
        {/* Search Bar — (c) 로컬 시설명 검색(마커 필터). 음성 검색(Mic)은 브라우저 STT 로 받아쓰기 → 검색어 주입.
            (Web Speech 미지원 브라우저에선 '준비 중' 비활성으로 graceful 폴백.) */}
        <div className="flex items-center bg-white/90 backdrop-blur rounded-full px-4 py-3 border border-line shadow-[0_2px_14px_rgba(43,35,32,0.06)] pointer-events-auto">
          <Search size={20} className="text-muk-soft mr-3" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('map.searchPlaceholder')}
            className="flex-1 bg-transparent text-muk outline-none placeholder:text-muk-soft text-sm"
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              title={t('map.searchClear')}
              aria-label={t('map.searchClear')}
              className="ml-3 rounded-full text-muk-soft hover:text-muk transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
            >
              <X size={18} />
            </button>
          ) : speechSearch.supported ? (
            // 음성 검색 마이크 — 탭하면 STT 로 한 발화를 받아 검색어에 넣는다(듣는 중 다시 탭하면 취소).
            // 듣는 중엔 신라 금빛 펄스 + '듣고 있어요…' 배지로 상태를 노출한다.
            <button
              type="button"
              onClick={() => speechSearch.start()}
              title={speechSearch.listening ? t('map.voiceSearchListening') : t('map.voiceSearchStart')}
              aria-label={speechSearch.listening ? t('map.voiceSearchListening') : t('map.voiceSearchStart')}
              aria-pressed={speechSearch.listening}
              className={`ml-3 flex items-center gap-1 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${speechSearch.listening ? 'text-gold animate-pulse' : 'text-muk-soft hover:text-muk'}`}
            >
              <Mic size={18} />
              {speechSearch.listening && (
                <span className="text-[10px] font-medium whitespace-nowrap">{t('map.voiceSearchListening')}</span>
              )}
            </button>
          ) : (
            // STT 미지원 브라우저: 죽은 컨트롤 오해를 막기 위해 '준비 중' 비활성 표기(모바일엔 title 툴팁이 안 뜨므로 텍스트 배지 + opacity 로 명확히).
            <span title={t('map.voiceSearchSoon')} aria-disabled="true" className="ml-3 flex items-center gap-1 cursor-not-allowed opacity-40 select-none">
              <Mic size={18} className="text-muk-soft" />
              <span className="text-[10px] font-medium text-muk-soft whitespace-nowrap">{t('map.soon')}</span>
            </span>
          )}
          <div className="w-8 h-8 rounded-full bg-gold/15 ml-4 flex items-center justify-center border border-gold/40">
            <User size={16} className="text-gold" />
          </div>
        </div>

        {/* (c) 검색 결과 없음 안내 — 입력값은 있으나 현재 카테고리에 일치 장소가 없을 때 */}
        {searchActive && searchMatchCount === 0 && (
          <div className="pointer-events-auto px-2 -mt-1">
            <span className="inline-block text-muk text-xs bg-white/90 border border-line rounded-full px-3 py-1 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
              {t('map.searchNoResult', { q: searchQuery.trim() })}
            </span>
          </div>
        )}

        {/* ♿ 배리어프리 필터 결과 없음 안내 — 검색 빈 상태와 동일 톤(검색 안내가 우선일 땐 중복 표시하지 않음) */}
        {showBarrierFree && barrierFreeMatchCount === 0 && !(searchActive && searchMatchCount === 0) && (
          <div className="pointer-events-auto px-2 -mt-1">
            <span className="inline-block text-muk text-xs bg-white/90 border border-line rounded-full px-3 py-1 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
              ♿ {t('map.barrierFreeNone')}
            </span>
          </div>
        )}

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
                className={`flex shrink-0 items-center whitespace-nowrap rounded-full border px-3.5 py-2 transition-all fractal-glass shadow-[0_2px_14px_rgba(43,35,32,0.06)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 sm:px-4 sm:py-2 ${
                  isActive
                    ? 'bg-gold/15 border-gold text-muk'
                    : 'bg-white/80 border-line text-muk-soft hover:bg-white hover:text-muk'
                }`}
              >
                <Icon size={15} className={`mr-1.5 sm:mr-2 ${isActive ? 'text-gold' : 'text-muk-soft'}`} />
                <span className="text-[13px] font-medium sm:text-sm">{t(`category.${filter.key}`)}</span>
              </button>
            );
          })}
        </div>

        {/* 지도 레이어 컨트롤 — 🔥 히트맵 토글 + 예측 타임슬라이더(지금·+1h·+2h·+3h).
            CongestionMap 의 두 기능을 정본 지도에 통합. 예측 모드는 정직성 배지로 실측과 구분한다.
            (하단은 추천 카드/탭바가 차지하므로, 항상 보이고 충돌 없는 상단 컨트롤 영역에 배치.) */}
        <div className="flex flex-wrap items-center gap-2 pointer-events-auto">
          {/* 히트맵 토글 */}
          <button
            type="button"
            onClick={() => setShowHeatmap((prev) => !prev)}
            aria-pressed={showHeatmap}
            className={`flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-[13px] font-medium transition-all fractal-glass shadow-[0_2px_14px_rgba(43,35,32,0.06)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 sm:px-4 sm:py-2 sm:text-sm ${
              showHeatmap
                ? 'bg-terracotta/15 border-terracotta text-muk'
                : 'bg-white/80 border-line text-muk-soft hover:bg-white hover:text-muk'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${showHeatmap ? 'bg-terracotta animate-pulse' : 'bg-muk-soft/40'}`} />
            🔥 {t('map.heatmap')}
          </button>

          {/* ♿ 배리어프리 토글 — 켜지면 features.barrier_free 시설만 지도에 표시(무장애 여행 동선용) */}
          <button
            type="button"
            onClick={() => setShowBarrierFree((prev) => !prev)}
            aria-pressed={showBarrierFree}
            className={`flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-[13px] font-medium transition-all fractal-glass shadow-[0_2px_14px_rgba(43,35,32,0.06)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 sm:px-4 sm:py-2 sm:text-sm ${
              showBarrierFree
                ? 'bg-jade/15 border-jade text-muk'
                : 'bg-white/80 border-line text-muk-soft hover:bg-white hover:text-muk'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${showBarrierFree ? 'bg-jade animate-pulse' : 'bg-muk-soft/40'}`} />
            ♿ {t('map.barrierFree')}
          </button>

          {/* 예측 정직성 배지 — 실측(Live)과 혼동 방지 */}
          {isForecast && (
            <span className="shrink-0 px-3 py-1 rounded-full text-[11px] font-bold bg-jade border border-jade/50 text-white shadow-[0_2px_10px_rgba(43,35,32,0.12)] whitespace-nowrap">
              🔮 {t('map.forecastBadge', { h: hoursAhead })}
            </span>
          )}

          {/* 예측 타임슬라이더(바) — 지금(0)~+3h 를 하나의 슬라이더로. 드래그 중엔 썸만 이동하고
              놓을 때(onPointerUp/onKeyUp) 예측을 커밋한다(스텝마다 /predict/batch 호출 폭주 방지). */}
          <div
            className={`flex shrink-0 items-center gap-3 rounded-full border py-1.5 pl-3.5 pr-4 fractal-glass bg-white/80 shadow-[0_2px_14px_rgba(43,35,32,0.06)] transition-colors ${
              isForecast ? 'border-jade/50' : 'border-line'
            } ${predictionLoading ? 'opacity-60' : ''}`}
          >
            <span
              className={`shrink-0 w-9 text-center text-xs font-bold tabular-nums ${
                sliderPos === 0 ? 'text-gold-deep' : 'text-jade'
              }`}
            >
              {sliderPos === 0 ? t('map.now') : `+${sliderPos}h`}
            </span>
            <input
              type="range"
              min={0}
              max={3}
              step={1}
              value={sliderPos}
              disabled={predictionLoading}
              aria-label={t('map.sliderAria')}
              aria-valuetext={sliderPos === 0 ? t('map.sliderValueNow') : t('map.sliderValueAhead', { h: sliderPos })}
              onChange={(e) => setSliderPos(Number(e.target.value))}
              onPointerUp={() => handleTimeShift(sliderPos)}
              onKeyUp={() => handleTimeShift(sliderPos)}
              className={`w-24 cursor-pointer disabled:cursor-wait sm:w-32 ${isForecast ? 'accent-jade' : 'accent-gold'}`}
            />
            <span className="shrink-0 text-[10px] font-medium text-muk-soft">+3h</span>
          </div>
        </div>
      </div>

      {/* (a) 시설 로드 상태 안내 — 로딩 스피너 / 로드 실패 재시도 / 전체 빈 상태 (데모 사고 방지선) */}
      {isLoadingFacilities && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 pointer-events-none">
          <div className="w-10 h-10 rounded-full border-2 border-line border-t-gold animate-spin" />
          <span className="text-muk text-sm font-medium">{t('map.loadingRec')}</span>
        </div>
      )}

      {!isLoadingFacilities && facilitiesLoadError && (
        <div className="absolute inset-0 z-30 flex items-center justify-center px-6 pointer-events-none">
          <div className="bg-white border border-line rounded-2xl px-6 py-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)] flex flex-col items-center gap-3 max-w-xs text-center pointer-events-auto">
            <span className="text-2xl">⚠️</span>
            <p className="text-muk text-sm font-semibold">{t('map.loadErrorTitle')}</p>
            <p className="text-muk-soft text-xs leading-relaxed">{t('map.loadErrorBody')}</p>
            <button
              type="button"
              onClick={() => setFacilitiesReloadNonce(n => n + 1)}
              className="mt-1 px-4 py-2 rounded-full bg-gold hover:bg-gold-deep text-white text-sm font-bold transition-colors"
            >
              {t('common.retry')}
            </button>
          </div>
        </div>
      )}

      {!isLoadingFacilities && !facilitiesLoadError && facilities.length === 0 && (
        <div className="absolute inset-0 z-30 flex items-center justify-center px-6 pointer-events-none">
          <div className="bg-white border border-line rounded-2xl px-6 py-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)] flex flex-col items-center gap-2 max-w-xs text-center">
            <span className="text-2xl">🗺️</span>
            <p className="text-muk text-sm font-semibold">{t('map.emptyTitle')}</p>
            <p className="text-muk-soft text-xs leading-relaxed">{t('map.emptyBody')}</p>
          </div>
        </div>
      )}

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
            <div className="absolute bottom-[calc(80px+env(safe-area-inset-bottom))] w-full z-20 px-4 transition-all duration-300">
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
          console.warn("Error rendering RecommendationCard IIFE:", err);
          return null;
        }
      })()}

      {/* (b) 현재 카테고리 추천 후보 0건 — 카드가 조용히 사라지는 대신 안내 표시 */}
      {!isLoadingFacilities && !facilitiesLoadError && facilities.length > 0 && !selectedFacility && noRecommendation && (
        <div className="absolute bottom-[calc(80px+env(safe-area-inset-bottom))] w-full z-20 px-4">
          <div className="bg-white border border-line rounded-2xl px-5 py-4 shadow-[0_2px_14px_rgba(43,35,32,0.06)] flex flex-col items-center gap-1.5 text-center">
            <span className="text-xl">🧭</span>
            <p className="text-muk text-sm font-semibold">{t('map.noRecTitle')}</p>
            <p className="text-muk-soft text-xs leading-relaxed">{t('map.noRecBody')}</p>
          </div>
        </div>
      )}

      {/* Test Mock Sidebar (Right Side) — 개발/QA 전용 데모 컨트롤(위치·시간 모킹).
          실제 관광객에게 내부 도구가 노출되지 않도록 NEXT_PUBLIC_DEMO_CONTROLS==='1' 일 때만 렌더.
          (정적 export: NEXT_PUBLIC_* 는 빌드 시 인라인 → 트리셰이킹 가능.)
          시간 모킹이 유일한 mockHour 트리거이므로, 이 패널을 감추면 일반 사용자에겐 mockHour 가
          항상 null → 지도는 실측/'데이터 없음' 혼잡도만 표시된다(합성 id-해시 혼잡 주입 불가). */}
      {process.env.NEXT_PUBLIC_DEMO_CONTROLS === '1' && (
      <div className="absolute right-4 top-[170px] z-20 flex flex-col gap-3 pointer-events-auto">
        {/* Location Mock */}
        <div className="bg-white/90 backdrop-blur border border-line rounded-2xl shadow-[0_2px_14px_rgba(43,35,32,0.06)] flex flex-col overflow-hidden transition-all duration-300">
          <div
            className="px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-hanji-deep active:bg-hanji-deep transition-colors"
            onClick={() => setIsMockLocationMinimized(!isMockLocationMinimized)}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-terracotta">📍</span>
              {!isMockLocationMinimized && (
                <span className="text-[10px] text-muk-soft font-bold tracking-wider">
                  위치 모킹
                </span>
              )}
            </div>
            {isMockLocationMinimized ? (
              <ChevronDown size={14} className="text-muk-soft" />
            ) : (
              <ChevronUp size={14} className="text-muk-soft ml-2" />
            )}
          </div>

          {!isMockLocationMinimized && (
            <div className="px-3 pb-3 border-t border-line">
              <div className="grid grid-cols-1 gap-1.5 w-36 mt-2">
                {REGION.presets.map((loc) => {
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
                          ? 'bg-gold text-white border border-gold-deep shadow-sm'
                          : 'bg-hanji border border-line text-muk-soft hover:bg-hanji-deep'
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
        <div className="bg-white/90 backdrop-blur border border-line rounded-2xl shadow-[0_2px_14px_rgba(43,35,32,0.06)] flex flex-col overflow-hidden transition-all duration-300">
          <div
            className="px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-hanji-deep active:bg-hanji-deep transition-colors"
            onClick={() => setIsMockTimeMinimized(!isMockTimeMinimized)}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-jade">🕒</span>
              {!isMockTimeMinimized && (
                <span className="text-[10px] text-muk-soft font-bold tracking-wider">
                  시간 모킹
                </span>
              )}
            </div>
            {isMockTimeMinimized ? (
              <ChevronDown size={14} className="text-muk-soft" />
            ) : (
              <ChevronUp size={14} className="text-muk-soft ml-2" />
            )}
          </div>

          {!isMockTimeMinimized && (
            <div className="px-3 pb-3 border-t border-line">
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
                          ? 'bg-gold text-white border border-gold-deep shadow-sm'
                          : 'bg-hanji border border-line text-muk-soft hover:bg-hanji-deep'
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
      )}





      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-[350px] left-1/2 z-50 pointer-events-none flex justify-center w-full max-w-sm px-4 animate-toast">
          <div className="bg-muk/90 backdrop-blur-md text-hanji text-xs sm:text-sm px-5 py-3 rounded-full shadow-[0_2px_14px_rgba(43,35,32,0.14)] text-center font-medium break-keep w-max max-w-full">
            {toastMessage}
          </div>
        </div>
      )}
    </div>
  );
}
