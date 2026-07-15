'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import dynamic from 'next/dynamic';
import { User, Search, Mic, X, Utensils, MapPin, Building2, Coffee, ChevronDown, ChevronUp } from 'lucide-react';
import { createPublicClient } from '@/lib/supabase';
import { getMarkerSvg } from '@/lib/utils';
import { scoreFacility, compareSpot, rankFacilities, recToSpot, haversineMeters, cuisineMatch, rescoreWithPreference, filterReachable, type Spot } from '@/lib/recommender';
import { REGION, isWithinRegion } from '@/lib/region';
import { recommendByType, rejectRecommendation, voiceTurn, apiClient } from '@/lib/api-client';
// 히트맵 blob 의 색·크기 규칙(마커/배지 임계와 일관) 공용 헬퍼 — 중복 정의 금지, 그대로 재사용.
import { getHeatGradient, getHeatRadius } from '@/lib/heatmap';
// D5: TourAPI 동기화 신선도 상대시간 — lib/freshness 단일 소스 재사용(중복 정의 금지).
import { relativeParts } from '@/lib/freshness';
import { useVoiceAssistant } from '@/lib/useVoiceAssistant';
import { useSpeechSearch } from '@/lib/useSpeechSearch';
import VoiceAssistantOrb from '@/components/VoiceAssistantOrb';
import { recordPendingVisit } from '@/lib/visits';
import { useT } from '@/lib/i18n/I18nProvider';
// T2: 휴무 원문 파서(오늘 휴무 확정만 배제) + 가능/불가능 텍스트 파서(주차·반려동물 필터) — 공용 단일 소스.
import { isClosedToday, parseAvailability } from '@/lib/restDate';

const RecommendationCard = dynamic(
  () => import('@/components/RecommendationCard').then((m) => m.RecommendationCard),
  { ssr: false },
);
const FestivalBanner = dynamic(() => import('@/components/FestivalBanner'), { ssr: false });
const TodayCalmSpots = dynamic(() => import('@/components/TodayCalmSpots'), { ssr: false });
const VisitCheckCard = dynamic(() => import('@/components/VisitCheckCard'), { ssr: false });

const supabase = createPublicClient();

// ── 이 페이지가 다루는 앱 도메인 데이터의 로컬 타입 ──
// (Kakao Maps SDK 객체(map/marker/overlay/LatLng 등)는 의도적으로 any 유지 — SDK 타이핑 미도입.)

// features JSONB 중 이 페이지가 읽는 키만 명시(그 외 키는 unknown 인덱스로 통과).
interface FacilityFeatures {
  cuisine_tags?: string[] | string;
  cuisine?: string[] | string;
  [key: string]: unknown;
}

// Supabase congestion_logs 행(이 페이지가 select 하는 컬럼만).
interface CongestionLog {
  facility_id: string;
  congestion_level: number;
  current_count: number;
  timestamp: string;
}

// loadFacilities 의 mapped 형태가 원본. spot/reason/apiRank/totalCandidates 는
// 추천 파이프라인(백엔드 by-type·rankFacilities·랭킹 effect)이 이후에 덧붙이는 선택 필드.
interface FacilityRecord {
  id: string;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
  capacity: number;
  features: FacilityFeatures | null;
  baseCongestion: number | null; // 혼잡 로그 없으면 null('데이터 없음' 표시)
  congestionLevel: number | null;
  currentCount: number | null;
  lastUpdated: string | null;
  spot?: Spot;
  reason?: string;
  apiRank?: number;
  totalCandidates?: number;
}

// 개별 시설 vs 그룹(모음) 마커 — isGroup 판별식 union(expandGroups/마커 클릭 분기용).
interface SingleFacility extends FacilityRecord {
  isGroup?: false;
  subFacilities?: undefined;
}
interface FacilityGroup extends FacilityRecord {
  isGroup: true;
  subFacilities: Facility[];
}
type Facility = SingleFacility | FacilityGroup;

// '관심 없음' 직후 거절 이유를 나중에 알려줄 수 있다는 안내(lab.hint)를 처음 몇 번만 노출하기 위한 카운터.
// 매번 띄우면 거절 흐름을 방해하므로 상한을 둔다.
const LAB_HINT_KEY = 'nextspot_lab_hint_shown';
const LAB_HINT_MAX_SHOWS = 2;

// localStorage 'nextspot_saved_facilities' 항목 — handlePutOff 가 저장하는 형태(읽기는 id만 사용).
interface SavedBookmark {
  id: string;
  name: string;
  category: string;
  // 저장 페이지의 라이브 혼잡 재조회(매칭)·카카오맵 길찾기 링크용 좌표(구버전 북마크엔 없을 수 있음).
  latitude?: number;
  longitude?: number;
  trafficStatus: string;
  waitTime: string;
  spot: Spot;
  reason: string;
}

// TourAPI 실시간 키워드 폴백(2위 실시간 키워드 게이트웨이) — GET /api/v1/search/keyword 응답 1건.
// 적재 전 POI 라 지도 마커는 없다(행 목록 전용). 필드명은 백엔드 간이 페이로드와 1:1(camelCase 변환 없음).
interface LiveSearchItem {
  contentid: string;
  title: string;
  addr1?: string | null;
  mapx?: number | null;
  mapy?: number | null;
  contenttypeid?: number | null;
  firstimage?: string | null;
}

// 술집(bar)이 음식점(restaurant)으로 적재되면 '음식점' 추천을 오염시킨다(데이터 한계).
// cuisine_tags 로 술집을 식별해 음식점 추천 후보에서만 제외(지도 마커로는 계속 표시 — 삭제 아님).
const _BAR_TAGS_MAIN = ['술집', '호프', '오뎅바', '실내포장마차', '일본식주점', '호프,요리주점', '포차', '선술집'];
function isBarFacility(f: Facility): boolean {
  const raw = f?.features?.cuisine_tags ?? f?.features?.cuisine;
  const tags = Array.isArray(raw) ? raw.map((x) => String(x)) : (typeof raw === 'string' ? [raw] : []);
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
  // 축제 포커스 오버레이(핀/영역 원 + 라벨) 배열 — 새 축제 선택·지도 클릭·언마운트 시 정리.
  const festivalOverlayRef = useRef<any[]>([]);

  const [activeFilter, setActiveFilter] = useState('음식점'); // 첫 접속 시 음식점 세션을 먼저 표시(탭 순서와 일치)
  const [searchQuery, setSearchQuery] = useState(''); // 로컬 시설명 검색(마커 필터). TourAPI 의미검색 연동은 범위 밖.
  // TourAPI 실시간 키워드 폴백(2위 실시간 키워드 게이트웨이) — 로컬 검색 0건일 때만 GET /search/keyword 조회.
  // 지도 이동/마커 추가는 하지 않는다(적재 전 POI — 행 목록으로만 노출, [다음 배치 추가 요청]으로 큐잉).
  const [liveSearchItems, setLiveSearchItems] = useState<LiveSearchItem[]>([]);
  const [liveSearchLoading, setLiveSearchLoading] = useState(false);
  const [requestedIngestIds, setRequestedIngestIds] = useState<Set<string>>(new Set());
  const [facilities, setFacilities] = useState<any[]>([]);
  // 시설 로드 상태(데모 사고 방지선): 로딩 스피너·재시도·전체 빈 상태 안내 렌더용.
  const [isLoadingFacilities, setIsLoadingFacilities] = useState(true);
  const [facilitiesLoadError, setFacilitiesLoadError] = useState(false);
  const [facilitiesReloadNonce, setFacilitiesReloadNonce] = useState(0); // '다시 시도' 트리거(로드 effect 재실행)
  const [selectedFacility, setSelectedFacility] = useState<any>(null);
  // 음성 선호 필터(예: '양식 먹고 싶어'→양식 식당 id들). null이면 필터 없음.
  // 백엔드 분류기가 실시간으로 추천 풀을 좁혀 그 안에서 SPOT로 재랭킹한다.
  // state = 카드/핸들러 렌더용, ref = 추천 effect가 dep 없이 최신값을 읽기 위함(필터 변경 시 더블셋 방지).
  const [voiceFilterIds, setVoiceFilterIds] = useState<Set<string> | null>(null);
  const voiceFilterIdsRef = useRef<Set<string> | null>(null);
  const applyVoiceFilter = (s: Set<string> | null) => { voiceFilterIdsRef.current = s; setVoiceFilterIds(s); };
  // 세부 음식분류 칩(치킨/피자·양식/국밥 등) — 음성 필터와 동일 경로(applyVoiceFilter+cuisineIntent)를 탄다.
  const [cuisineChip, setCuisineChip] = useState<string | null>(null);
  // 음식 의도(음성 발화 '고기/국밥/피자' 또는 온보딩 food 선호). 선호 일치율을 음식종류 매칭으로 산출하는 데 쓴다.
  const cuisineIntentRef = useRef<string | null>(null);
  // 랜드마크 상대거리 정렬 기준점(예: '첨성대 가까운 카페' → 첨성대 좌표). null이면 사용자 위치 기준.
  const rankingOriginRef = useRef<{ lat: number; lng: number } | null>(null);
  // 그룹(모음) 마커 하이라이트 id — 카드 선택(selectedFacility)과 분리해 마커 확대/색상변경만 적용
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  // 카카오 SDK 가 끝내 뜨지 않을 때(키 미설정·네트워크 차단 등) 무한 검은 화면 대신 폴백 UI를 보여주기 위한 상태.
  const [mapUnavailable, setMapUnavailable] = useState(false);
  const [mapLevel, setMapLevel] = useState(4); // 지도 줌 레벨(작을수록 확대) — 줌별 마커 밀집도 제어
  const [isMockLocationMinimized, setIsMockLocationMinimized] = useState(true);
  const [isMockTimeMinimized, setIsMockTimeMinimized] = useState(true);
  const [mockHour, setMockHour] = useState<number | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // 히트맵 레이어 on/off — 혼잡 핀과 별개의 열지도 오버레이(CongestionMap 에서 이식). 기본 꺼짐.
  const [showHeatmap, setShowHeatmap] = useState(false);
  // ♿ 배리어프리 필터 on/off — 켜지면 features.barrier_free 가 truthy 인(휠체어 등 무장애) 시설만 마커·히트맵에 표시. 기본 꺼짐.
  const [showBarrierFree, setShowBarrierFree] = useState(false);
  // 🅿 주차 가능 필터 on/off — 켜지면 features.parking 이 '가능'으로 파싱되는 시설만 마커·히트맵에 표시.
  // 🐾 반려동물 동반 필터 on/off — 켜지면 features.chk_pet 이 '가능'으로 파싱되는 시설만. 둘 다 배리어프리와 동일 패턴(AND 조합 가능).
  const [showParkingFilter, setShowParkingFilter] = useState(false);
  const [showPetFilter, setShowPetFilter] = useState(false);
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
  // 인식 실패 시 무음으로 꺼지지 않도록 토스트로 안내(권한 거부/그 외 실패를 구분).
  const speechSearch = useSpeechSearch(
    (text) => setSearchQuery(text),
    (kind) => showToast(kind === 'denied' ? t('map.sttMicDenied') : t('map.sttFailed'))
  );

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
            // TourAPI 상세(A2) — 전부 nullable, 카드가 '있을 때만' 조건부 렌더('지어내지 않기').
            operatingHours: f.operatingHours ?? null,
            imageUrl: f.imageUrl ?? null,
            address: f.address ?? null,
            phone: f.phone ?? null,
            homepage: f.homepage ?? null,
            overview: f.overview ?? null,
            barrierFree: f.barrierFree ?? null,
            baseCongestion: level,
            congestionLevel: level,
            currentCount: f.congestion ? f.congestion.currentCount : null,
            lastUpdated: f.congestion ? f.congestion.timestamp : null,
            // 신선도 정직화(계약 5): 혼잡 출처(user_report 등)와 24h 초과 여부를 카드로 전달.
            source: f.congestion ? (f.congestion.source ?? null) : null,
            isStale: f.congestion ? !!f.congestion.isStale : false,
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
            .select("id, name, type, latitude, longitude, capacity, operating_hours, features, address, image_url, phone, homepage, overview, barrier_free")
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

        const latestLogsMap: Record<string, CongestionLog | undefined> = {};
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
            // TourAPI 상세(A2) — snake→camel 매핑. 1순위 API 경로와 동일한 필드 집합 유지.
            operatingHours: f.operating_hours ?? null,
            imageUrl: f.image_url ?? null,
            address: f.address ?? null,
            phone: f.phone ?? null,
            homepage: f.homepage ?? null,
            overview: f.overview ?? null,
            barrierFree: f.barrier_free ?? null,
            baseCongestion: baseCongestion,
            congestionLevel: baseCongestion,
            currentCount: latestLog ? latestLog.current_count : null,
            lastUpdated: latestLog ? latestLog.timestamp : null,
            // 폴백 경로엔 source 컬럼이 없어 null. isStale 은 로그 나이>24h 로 직접 산출(계약 5와 동일 정의).
            source: null,
            isStale: latestLog
              ? Date.now() - new Date(latestLog.timestamp).getTime() > 24 * 60 * 60 * 1000
              : false,
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

  // D5: TourAPI 마지막 동기화 시각 — 페이지 레벨 소형 표시용. 값이 전혀 없으면 렌더하지 않는다
  // (관광객 화면에 '이력 없음'을 노출하는 대신 숨김 — 없는 걸 있는 척만 안 하면 되는 정직성 원칙).
  const [tourapiSyncAt, setTourapiSyncAt] = useState<string | null>(null);
  useEffect(() => {
    let active = true; // 언마운트 이후 setState 방지 가드
    (async () => {
      try {
        const res = await apiClient.getFreshness();
        if (!active) return;
        if (res?.lastTourapiSync) setTourapiSyncAt(res.lastTourapiSync);
        return; // 백엔드가 응답했으면(이력 없음 포함) 그 판정을 신뢰 — 폴백 안 함
      } catch {
        // 백엔드 미기동/네트워크 실패 → anon supabase 로 TourAPI 적재분(contentid 존재)의
        // updated_at 최대 1건을 추정(estimate) 폴백으로 사용한다.
      }
      try {
        const { data, error } = await supabase
          .from('facilities')
          .select('updated_at')
          .not('contentid', 'is', null)
          .order('updated_at', { ascending: false })
          .limit(1);
        if (!active) return;
        const ts = !error && data && data.length > 0 ? (data[0] as any).updated_at : null;
        if (ts) setTourapiSyncAt(ts);
      } catch {
        /* 폴백도 실패 — 표시하지 않음(숨김) */
      }
    })();
    return () => { active = false; };
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
  const [noRecommendation, setNoRecommendation] = useState(false); // 현재 카테고리 추천 후보 0건 여부(빈 상태 안내용)
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number }>({ ...REGION.center });
  const [preferredCategories, setPreferredCategories] = useState<string[]>([]);

  // Load user profile & current location
  useEffect(() => {
    async function loadUser() {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        const { data: profile } = await supabase
          .from("users")
          .select("preferred_categories")
          .eq("id", session.user.id)
          .single();
        if (profile?.preferred_categories) {
          setPreferredCategories(profile.preferred_categories);
        }
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
          const parsed: SavedBookmark[] = JSON.parse(saved);
          const ids = new Set<string>(parsed.map((item) => item.id));
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
  const spotMemoRef = useRef(new Map<string, { signature: string; spot: Spot }>());
  const calculateSPOT = (facility: Facility) => {
    const origin = rankingOriginRef.current ?? userLocation;
    const signature = [
      facility.id, facility.latitude, facility.longitude, facility.congestionLevel,
      origin?.lat, origin?.lng, preferredCategories.join(','), mockHour, cuisineIntentRef.current,
    ].join('|');
    const cached = spotMemoRef.current.get(facility.id);
    if (cached?.signature === signature) return cached.spot;
    const spot = scoreFacility(facility, {
      userLocation: origin, preferredCategories, mockHour, cuisineIntent: cuisineIntentRef.current,
    });
    spotMemoRef.current.set(facility.id, { signature, spot });
    // 데이터 재적재가 반복돼도 세션 동안 캐시가 무한히 자라지 않게 현재 시설 규모 수준으로 제한한다.
    if (spotMemoRef.current.size > Math.max(200, facilities.length * 2)) spotMemoRef.current.clear();
    return spot;
  };

  const compareFacilities = compareSpot;

  // 모음(그룹)은 추천/카드 랭킹에서 내부 sub로 펼친다 — 그룹 자체는 카드로 띄우지 않고
  // 모음 안에서 '가장 최적의 개별 장소'를 추천한다(지도 마커는 그대로 모음으로 유지).
  const expandGroups = (list: Facility[]) =>
    list.flatMap((f) => (f.isGroup && Array.isArray(f.subFacilities)) ? f.subFacilities : [f]);

  // 선택 마커가 하단 카드에 가리지 않도록 지도 위쪽 가시영역으로 패닝(지도 중심을 마커보다 아래로 둔다).
  const panToVisible = (lat: number, lng: number) => {
    const map = mapInstanceRef.current;
    if (!map || typeof window === 'undefined' || !window.kakao) return;
    // 위도만 가드하고 호출하는 곳이 많아, 여기서 경도까지 유한수 검증한다(LatLng(lat, undefined)=NaN 이동 방지).
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const latlng = new window.kakao.maps.LatLng(lat, lng);
    try {
      const proj = map.getProjection();
      const pt = proj.containerPointFromCoords(latlng);
      const h = mapContainerRef.current?.clientHeight || 0;
      const target = proj.coordsFromContainerPoint(
        new window.kakao.maps.Point(pt.x, pt.y + Math.round(h * 0.22))
      );
      map.panTo(target);
    } catch {
      map.panTo(latlng);
    }
  };

  // 축제 포커스 오버레이 정리 — 새 축제 선택·지도 클릭·언마운트 시 호출.
  const clearFestivalOverlay = () => {
    festivalOverlayRef.current.forEach((o) => { try { o.setMap(null); } catch { /* noop */ } });
    festivalOverlayRef.current = [];
  };

  // 주소가 '구체적 지번/도로명'인지, '동·일원 등 넓은 지역 단위'인지 판별.
  // 넓은 지역이면 정확한 핀 대신 색상 영역(원)으로 대략 범위를 보여준다(행정경계 폴리곤은 오프라인 부재).
  const isAreaLevelAddress = (addr?: string | null): boolean => {
    if (!addr) return false; // 주소 없으면 좌표 그대로 핀
    // '일원/일대/전역/주변/인근/곳곳' 은 넓은 범위 신호. 또한 시·군·구·동까지만 있고 번지(숫자)가 없으면 지역 단위.
    if (/(일원|일대|전역|일부|주변|인근|곳곳)/.test(addr)) return true;
    const tail = addr.replace(/(경상북도|경북|경주시)/g, '');
    return !/\d/.test(tail); // 남은 주소에 숫자(도로·건물번호)가 없으면 지역 단위로 간주
  };

  // 축제 카드에서 '지도에 표시'를 누르면 해당 위치를 지도에 핀(구체 주소) 또는 색상 영역(넓은 지역)으로 강조.
  const focusFestivalOnMap = (ev: { title: string; latitude?: number | null; longitude?: number | null; address?: string | null; isOngoing?: boolean }) => {
    const map = mapInstanceRef.current;
    if (!map || typeof window === 'undefined' || !window.kakao) return;
    if (typeof ev.latitude !== 'number' || typeof ev.longitude !== 'number') {
      showToast(`'${ev.title}'의 좌표 정보가 없어 지도에 표시할 수 없어요.`);
      return;
    }
    clearFestivalOverlay();
    if (activeOverlayRef.current) { activeOverlayRef.current.setMap(null); activeOverlayRef.current = null; }

    const pos = new window.kakao.maps.LatLng(ev.latitude, ev.longitude);
    // 진행 중=주칠(terracotta), 예정=신라금(gold). 지역/핀 공통 색.
    const color = ev.isOngoing ? '#c1553b' : '#c19a3e';
    const area = isAreaLevelAddress(ev.address);

    if (area) {
      // 넓은 지역: 반투명 색상 원으로 대략 범위 표시(반경 600m — 동 단위 근사, 실경계 아님).
      const circle = new window.kakao.maps.Circle({
        center: pos,
        radius: 600,
        strokeWeight: 2,
        strokeColor: color,
        strokeOpacity: 0.9,
        strokeStyle: 'dashed',
        fillColor: color,
        fillOpacity: 0.18,
      });
      circle.setMap(map);
      festivalOverlayRef.current.push(circle);
    }

    // 라벨 겸 핀 — 🏮 + 축제명. 지역이면 '일원' 꼬리표를 붙여 근사 범위임을 알린다.
    const el = document.createElement('div');
    el.className = 'pointer-events-none flex items-center gap-1 whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] font-bold text-white shadow-[0_4px_14px_rgba(43,35,32,0.28)]';
    el.style.background = color;
    el.style.border = '2px solid #fff';
    el.innerText = area ? `🏮 ${ev.title} 일원` : `🏮 ${ev.title}`;
    const label = new window.kakao.maps.CustomOverlay({
      position: pos,
      content: el,
      yAnchor: area ? 0.5 : 1.35, // 지역이면 원 중심, 핀이면 좌표 위에 말풍선
      zIndex: 60,
    });
    label.setMap(map);
    festivalOverlayRef.current.push(label);

    // 구체 주소(핀)면 정확 지점에 작은 점 마커도 찍어 위치를 분명히 한다.
    if (!area) {
      const dot = document.createElement('div');
      dot.className = 'rounded-full';
      dot.style.width = '12px'; dot.style.height = '12px';
      dot.style.background = color; dot.style.border = '2px solid #fff';
      dot.style.boxShadow = '0 2px 8px rgba(43,35,32,0.3)';
      const dotOverlay = new window.kakao.maps.CustomOverlay({ position: pos, content: dot, yAnchor: 0.5, zIndex: 59 });
      dotOverlay.setMap(map);
      festivalOverlayRef.current.push(dotOverlay);
    }

    // 지역이면 원이 다 보이게 살짝 축소, 핀이면 확대해 위치를 명확히.
    map.setLevel(area ? 5 : 4);
    panToVisible(ev.latitude, ev.longitude);
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

  // 예측 정직화(⑤): 배지에 anchored 소비. 하나라도 실측 앵커가 없으면(anchored false) 배지에 '추정' 꼬리표.
  const forecastAnchored = !isForecast || !predictionMap
    ? true
    : Object.values(predictionMap).every((p) => p.anchored);

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
    // ♿ 배리어프리 필터: 켜지면 barrier_free 가 truthy 인 시설만 남긴다(TourAPI 적재분은 정규 컬럼
    // barrierFree, 수동 시드는 features.barrier_free — 둘 다 확인). 마커·히트맵 공용 소스에서
    // 한 번만 걸러 두 레이어가 항상 동일 집합을 그린다.
    // (추천/카드 로직은 원본 facilities 를 쓰므로 필터의 영향을 받지 않는다 — 지도 표시만 좁힘.)
    let out = src;
    if (showBarrierFree) out = out.filter((f) => !!(f?.barrierFree ?? f?.barrier_free ?? f?.features?.barrier_free));
    // 🅿🐾 주차·반려동물 필터: 순차 .filter() 체이닝이라 배리어프리와도 자연히 AND 조합된다.
    // 관광지 위주로 적재된 필드라 커버리지가 낮다 — 후보가 확 줄거나 0이어도 숨기지 않고 그대로 보여준다(정직성).
    // (parking 은 밑줄이 없어 camelCase 변환 영향이 없지만, chk_pet 은 apiClient 경유 시 chkPet 으로 바뀌므로 둘 다 확인.)
    if (showParkingFilter) out = out.filter((f) => parseAvailability(f?.features?.parking as string | null | undefined) === true);
    if (showPetFilter) out = out.filter((f) => parseAvailability((f?.features?.chk_pet ?? f?.features?.chkPet) as string | null | undefined) === true);
    return out;
  }, [facilities, predictionMap, isForecast, showBarrierFree, showParkingFilter, showPetFilter]);

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

    const typeOk = (f: Facility) => f.type === targetType && !(targetType === 'restaurant' && isBarFacility(f)); // 식당 추천에서 술집 제외
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

    const isDemo = (f: Facility) => f.isGroup || String(f.id).startsWith('dummy-');
    const realCands = candidates.filter(f => !isDemo(f));
    // 모음은 sub로 펼쳐 개별 장소를 랭킹(모음 자체는 카드로 안 띄움). 펼친 sub도 거절/저장 제외.
    const demoCands = expandGroups(candidates.filter(isDemo))
      .filter((f) => !rejectedIds.has(f.id) && !savedIds.has(f.id));
    const liveMode = mockHour === null; // 시간대 시뮬이 켜지면 데모(목업) 모드로 일관 처리
    rankingOriginRef.current = null; // 랜드마크 기준점 리셋(카테고리 전환 시)
    const scoreOpts = { userLocation: rankingOriginRef.current ?? userLocation, preferredCategories, mockHour, cuisineIntent: cuisineIntentRef.current };

    let cancelled = false;
    (async () => {
      try {
        let all: Facility[];
        const vfilter = voiceFilterIdsRef.current; // ref로 최신 필터를 읽음(이 effect는 voiceFilterIds를 dep로 안 둠)
        if (vfilter) {
          // 음성 선호 필터(예: '양식'): 후보를 백엔드가 고른 id들로 좁혀 클라 미러로 SPOT 재랭킹(실시간).
          // (필터 변경 직후 첫 카드는 onFilter가 동기로 직접 set하므로 여기선 이후 재실행 케이스만 처리.)
          const filtered = expandGroups(candidates)
            .filter((f) => vfilter.has(f.id) && !rejectedIds.has(f.id) && !savedIds.has(f.id));
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
                  const base: any = byId.get(r.facility.id);
                  const spot = recToSpot(r);
                  // r.facility(camel)의 TourAPI 상세 필드를 병합 — 응답에 없으면 목록 로드 값(base) 폴백.
                  // (기존 {...base, spot, reason} 은 r.facility 페이로드를 통째로 버려 상세가 유실됐다.)
                  const rf = r.facility;
                  return {
                    ...base,
                    operatingHours: rf.operatingHours ?? base?.operatingHours ?? null,
                    imageUrl: rf.imageUrl ?? base?.imageUrl ?? null,
                    address: rf.address ?? base?.address ?? null,
                    phone: rf.phone ?? base?.phone ?? null,
                    homepage: rf.homepage ?? base?.homepage ?? null,
                    overview: rf.overview ?? base?.overview ?? null,
                    barrierFree: rf.barrierFree ?? base?.barrierFree ?? null,
                    // 머천트 연동(2단계): 타임세일·좌석 확인 배지용 — allowlist 병합이라 명시적으로 전달해야 카드에 도달한다.
                    timesaleRate: (rf as any).timesaleRate ?? (rf as any).timesale_rate ?? null,
                    seatStatusFresh: (rf as any).seatStatusFresh ?? (rf as any).seat_status_fresh ?? null,
                    spot,
                    reason: r.reason || "", // 백엔드 템플릿 사유만
                  };
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
  const handleAccept = (fac: Facility) => {
    if (!fac) return;

    // 수락 기록(계약 1) — 여정 차단 금지: fire-and-forget. 성공 응답에 coupon_issued 면 쿠폰함 토스트.
    // 실패(백엔드 다운/미인증)는 조용히 무시하고 길안내는 그대로 진행한다.
    apiClient
      .post('/api/v1/recommendations/accept', { facilityId: fac.id })
      .then((res: any) => {
        if (res?.couponIssued) {
          const rate = Math.round((res.couponRate ?? 0) * 100);
          showToast(t('map.couponIssued', { rate }));
        }
      })
      .catch(() => { /* 조용히 무시(여정 차단 금지) */ });
    // 방문 확인 루프용 대기 기록(수락 후 30분 뒤 '다녀오셨나요?' 배너). 카카오맵 오픈 로직은 아래 그대로 유지.
    try { recordPendingVisit(fac); } catch { /* localStorage 차단 환경 무시 */ }

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
      } catch { /* noop */ }
    }

    const nextSavedIds = new Set(savedIds);
    nextSavedIds.add(fac.id);
    const voicePass = (f: Facility) => !voiceFilterIds || voiceFilterIds.has(f.id); // 음성 선호 필터 유지

    // rankedFacilities (백엔드 순위) 기준 탐색: 방금 저장한 항목 제외
    let nextCandidates = rankedFacilities.filter(voicePass).filter((f) => !nextSavedIds.has(f.id));
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
      const bookmarks: SavedBookmark[] = existing ? JSON.parse(existing) : [];
      
      const spot = fac.spot || calculateSPOT(fac);
      if (!bookmarks.some((b) => b.id === fac.id)) {
        bookmarks.push({
          id: fac.id,
          name: fac.name,
          category: fac.type === 'restaurant' ? '음식점' : fac.type === 'cafe' ? '카페' : fac.type === 'attraction' ? '관광지' : '문화시설',
          // 저장 페이지의 라이브 혼잡 재조회(매칭)·카카오맵 길찾기 링크에 좌표가 필요하므로 함께 저장한다.
          latitude: fac.latitude,
          longitude: fac.longitude,
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

  const handleReject = (fac: Facility) => {
    if (!fac) return;

    // 서버 적재는 fire-and-forget: 다음 추천 즉시 표시 계약을 네트워크 상태와 분리한다.
    void rejectRecommendation(fac.id).catch(() => { /* 거절 UX는 저장 실패로 끊지 않는다. */ });
    
    // Clear selection from sessionStorage immediately to prevent restoration logic from sticking to this item
    if (typeof window !== 'undefined') {
      try {
        sessionStorage.removeItem('nextspot_selected_facility_id');
      } catch { /* noop */ }
    }

    const filterMap: Record<string, string> = {
      '음식점': 'restaurant', '카페': 'cafe', '관광지': 'attraction', '문화시설': 'culture'
    };
    const targetType = filterMap[activeFilter];

    // Next candidates: exclude already-rejected (prev rejectedIds + current fac) and saved
    const nextRejectedIds = new Set(rejectedIds);
    nextRejectedIds.add(fac.id);
    const voicePass = (f: Facility) => !voiceFilterIds || voiceFilterIds.has(f.id); // 음성 선호 필터 유지

    // 다음 추천은 첫 추천과 동일한 점수 체계 유지를 위해 백엔드 랭킹(rankedFacilities)에서 소비한다
    // (기존: 클라 calculateSPOT 재계산 → 거절 시 점수 체계가 몰래 바뀌던 문제).
    let nextCandidates = rankedFacilities
      .filter((f) => voicePass(f) && !nextRejectedIds.has(f.id) && !savedIds.has(f.id));

    // 랭킹 리스트가 소진된 경우에만 클라 미러(calculateSPOT)로 폴백 — 전체 후보 루프백(음성 필터는 유지)
    if (nextCandidates.length === 0) {
      nextCandidates = expandGroups(facilities.filter(f => f.type === targetType))
        .filter(voicePass)
        .map((f) => ({ ...f, spot: calculateSPOT(f) }))
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
    maybeShowLabHint();
  };

  // 거절 안내 힌트(lab.hint) — 처음 LAB_HINT_MAX_SHOWS 회만, 비차단으로 노출.
  // 브라우즈 거절은 source='browse' 추천 이력으로 서버 실험실에 보내며 성과 집계에서는 제외된다.
  // 저장 요청과 무관하게 현재 세션 후보 제외(rejectedIds)는 즉시 유지한다.
  // 페이지 로컬 showToast 대신 전역 sonner 를 쓰는 이유: showToast 는 단일 슬롯이라 방금 띄운
  // map.rejectToast('~를 제외했어요')를 덮어써 거절 확인 자체가 사라진다.
  const maybeShowLabHint = () => {
    if (typeof window === 'undefined') return;
    try {
      const shown = Number(localStorage.getItem(LAB_HINT_KEY)) || 0;
      if (shown >= LAB_HINT_MAX_SHOWS) return;
      localStorage.setItem(LAB_HINT_KEY, String(shown + 1));
    } catch {
      return; // localStorage 차단 → 노출 횟수를 셀 수 없으므로 아예 띄우지 않는다(무한 반복 방지).
    }
    toast.info(t('lab.hint'));
  };

  // 음성 '다음/별로': 폐기(rejectedIds)하지 않고 '안정 랭킹'에서 다음 순위로만 이동(우선순위만 낮춤).
  // 거절한 시설은 풀에 그대로 남아 순위 유지·재방문 가능. 끝이면 처음으로 순환.
  const handleAdvanceRank = (fac: Facility) => {
    if (!fac) return;
    const voicePass = (f: Facility) => !voiceFilterIds || voiceFilterIds.has(f.id);
    const pool = expandGroups(facilities.filter(f => f.type === fac.type))
      .filter((f) => voicePass(f) && !rejectedIds.has(f.id) && !savedIds.has(f.id))
      .map((f) => ({ ...f, spot: calculateSPOT(f) }))
      .sort(compareFacilities);
    if (pool.length <= 1) { showToast(t('map.noMoreRec')); return; }
    const curIdx = pool.findIndex(f => f.id === fac.id);
    const next = pool[curIdx < 0 ? 0 : (curIdx + 1) % pool.length]; // 폐기 안 함 — 순위 순서대로 다음, 끝이면 처음
    setSelectedFacility(next);
    if (mapInstanceRef.current && typeof next.latitude === 'number') panToVisible(next.latitude, next.longitude);
  };

  // ── 음성 비서: 현재 추천 카드를 백엔드 사유로 TTS 안내 + STT 응답 위임 ──
  // 수락(응/가자)→handleAccept(길안내), 다음/별로→handleReject(폐기+다음), 자세히→상세 재안내, 그만→종료.
  const voice = useVoiceAssistant<Facility>({
    getName: (f) => f?.name ?? '이 장소',
    getReason: (f) => f?.reason || '', // 백엔드 템플릿 사유만(없으면 이름만 안내) — 하드코딩 제거
    // 백엔드가 spoken으로 실데이터 상세를 주는 게 우선. 이건 백엔드 불가 시 폴백 — 종류/혼잡/도보로 구성.
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
    // 백엔드가 선호('양식 먹고 싶어' 등)에 맞춰 고른 시설로 전환. spoken을 사유로 부여 → notifyItem이 읽어줌.
    onSelect: (id, spoken) => {
      const target = expandGroups(facilities).find((f) => f.id === id);
      if (!target) return;
      setSelectedFacility(spoken ? { ...target, reason: spoken } : target);
      if (mapInstanceRef.current && typeof target.latitude === 'number') panToVisible(target.latitude, target.longitude);
    },
    // 백엔드가 선호로 후보를 좁힘(예: '양식 먹고 싶어'→양식 식당 id들). 추천 풀을 실시간 필터링해 재랭킹.
    // 동기로 필터 내 #1을 직접 set(첫 카드는 백엔드 spoken을 사유로) → effect 더블셋/spoken 경합 없음.
    onFilter: (matchIds, spoken) => {
      const set = new Set(matchIds);
      const pool = expandGroups(facilities)
        .filter((f) => set.has(f.id) && !rejectedIds.has(f.id) && !savedIds.has(f.id));
      if (pool.length === 0) {
        showToast(t('map.voiceNoMatch')); // 빈 결과 → 필터 미적용(현재 카드 유지)
        return;
      }
      applyVoiceFilter(set); // ref+state 동시 갱신(effect는 이후 재실행 시 ref로 읽음)
      const ranked = pool.map((f) => ({ ...f, spot: calculateSPOT(f) })).sort(compareFacilities);
      setSelectedFacility(spoken ? { ...ranked[0], reason: spoken } : ranked[0]);
      if (mapInstanceRef.current && typeof ranked[0].latitude === 'number') panToVisible(ranked[0].latitude, ranked[0].longitude);
    },
    // 사용자 발화를 백엔드 키워드 분류기(/api/v1/voice/turn)로 해석. 현재 타입 후보 목록(이름/혼잡/거리)을 동봉.
    interpret: async (utterance, f) => {
      const filterMap: Record<string, string> = { '음식점': 'restaurant', '카페': 'cafe', '관광지': 'attraction', '문화시설': 'culture' };
      const type = f?.type || filterMap[activeFilter] || 'restaurant';

      rankingOriginRef.current = null; // 식당/일반 경로는 사용자 위치 기준 정렬
      const cands = expandGroups(facilities)
        .filter((x) => x.type === type && !(type === 'restaurant' && isBarFacility(x)) && !rejectedIds.has(x.id) && !savedIds.has(x.id)) // 식당이면 술집 제외
        .map((x) => ({
          id: x.id,
          name: x.name,
          cuisine: x.features?.cuisine_tags ?? x.features?.cuisine ?? null, // 백엔드가 양식/짜장면 등 매칭에 사용
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

  // 카드가 새로 뜨면(세션 활성 상태) 백엔드 사유를 자동 발화, 카드가 사라지면 정지.
  // deps에 reason 포함 — 같은 시설이라도 mockHour/혼잡 변화로 사유가 바뀌면 새로 안내(id만 보면 놓침).
  useEffect(() => {
    // Notify the voice assistant about the current recommendation context (for interruption/correction)
    voice.notifyItem(selectedFacility ? selectedFacility : null);
  }, [selectedFacility?.id, selectedFacility?.reason]);

  // Initialize map if Kakao Maps script is already loaded
  // 8초 내 SDK 가 안 뜨면(키 미설정·네트워크 차단 등) 폴링을 멈추고 mapUnavailable 로 폴백 —
  // 무한 검은 화면 대신 아래 폴백 UI(한지 톤 배경 + 안내 칩)를 보여준다(CourseMap.tsx 패턴 미러).
  useEffect(() => {
    if (mapUnavailable || mapInstanceRef.current) return;
    const startedAt = Date.now();
    const initInterval = setInterval(() => {
      if (typeof window !== "undefined" && window.kakao && window.kakao.maps && mapContainerRef.current) {
        clearInterval(initInterval);
        initMap();
        return;
      }
      if (Date.now() - startedAt > 8000) {
        clearInterval(initInterval);
        setMapUnavailable(true);
      }
    }, 200);

    return () => clearInterval(initInterval);
  }, [mapUnavailable]);

  // 늦은 SDK 자동 복구 — 타임아웃 직후 SDK 가 뒤늦게 로드되는 경계 케이스를 구제한다(5초 간격, 최대 3회 상한).
  // mapUnavailable 이 풀리면 위 폴링 effect([mapUnavailable] 의존)가 다시 돌며 지도를 초기화한다.
  // 복구 카운터는 ref: effect 재장전 시 리셋되지 않게 해 '항상 실패'하는 환경에서 무한 플립플롭을 막는다.
  const mapRecoverAttemptsRef = useRef(0);
  useEffect(() => {
    if (!mapUnavailable || mapRecoverAttemptsRef.current >= 3) return;
    const retry = setInterval(() => {
      if (typeof window !== 'undefined' && window.kakao && window.kakao.maps) {
        mapRecoverAttemptsRef.current += 1;
        clearInterval(retry);
        setMapUnavailable(false);
      }
    }, 5000);
    return () => clearInterval(retry);
  }, [mapUnavailable]);

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
          clearFestivalOverlay(); // 축제 핀/영역도 함께 정리
          setActiveGroupId(null);
          setSelectedFacility(null);
        });

        // 음성 비서 활성 중 지도 영역을 터치(탭/드래그/줌)하면 즉시 정지 —
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
    if (!mapLoaded || !mapInstanceRef.current) return;
    const kakao = window.kakao;

    // Clear old markers — 표시 집합이 0이 되어도(예: 배리어프리 0건) 반드시 먼저 정리해 잔상이 남지 않게 한다.
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    // 그릴 시설이 없으면 정리만 하고 종료(마커 잔상 방지 — 이전엔 length===0 조기 return 이 정리보다 앞서 있었음).
    if (markerFacilities.length === 0) return;

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
        if (activeOverlayRef.current) {
          activeOverlayRef.current.setMap(null);
          activeOverlayRef.current = null;
        }
        // 축제 핀/영역이 떠 있으면 함께 정리한다(마커 클릭은 지도 click 이벤트를 발생시키지 않아
        // 지도 click 핸들러의 정리 로직이 실행되지 않으므로, 여기서도 명시적으로 지운다).
        clearFestivalOverlay();

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

  // 세부 음식분류 칩 — kw 는 lib/recommender.cuisineMatch 의 의도 키워드(라벨은 i18n cuisine.*).
  // 음식점 카테고리에서만 노출. TourAPI POI 는 cat3 매핑, 시드는 cuisine_tags/상호명으로 매칭된다.
  const cuisineChips = [
    { id: 'korean', kw: '한식', emoji: '🍚' },
    { id: 'meat', kw: '고기', emoji: '🥩' },
    { id: 'gukbap', kw: '국밥', emoji: '🍲' },
    { id: 'chicken', kw: '치킨', emoji: '🍗' },
    { id: 'western', kw: '피자', emoji: '🍕' },
    { id: 'chinese', kw: '중식', emoji: '🥟' },
    { id: 'japanese', kw: '일식', emoji: '🍣' },
    { id: 'bunsik', kw: '분식', emoji: '🍢' },
  ];

  // 칩 선택 — 음성 필터(onFilter)와 동일 경로: 매칭 id 집합 → applyVoiceFilter(마커·추천 풀 공통 필터)
  // + cuisineIntent(선호%를 음식 매칭도로 재산정) + 필터 내 SPOT #1 즉시 선택. null = 해제.
  const selectCuisineChip = (chip: { id: string; kw: string } | null) => {
    if (!chip || cuisineChip === chip.id) {
      setCuisineChip(null);
      cuisineIntentRef.current = null;
      applyVoiceFilter(null);
      return;
    }
    // 0.8 = 태그 정확 일치(0.95)·상호명 일치(0.85)만 칩 소속으로 인정. 같은 한식 대분류 약한 매칭(0.45)은
    // 선호% 산정용 등급이지 분류 소속이 아니다 — 밀면집 등 한식 전반이 고기·구이/국밥 칩에 뜨던 오염 방지.
    const pool = expandGroups(facilities).filter(
      (f: any) =>
        f.type === 'restaurant' &&
        (cuisineMatch(f, chip.kw) ?? 0) >= 0.8 &&
        !rejectedIds.has(f.id) &&
        !savedIds.has(f.id) &&
        // 오늘 휴무가 '확정'된 곳만 제외(정직한 추천) — 판정 불가(null)는 배제하지 않고 그대로 포함.
        // apiClient 응답은 features 내부 키까지 camelCase 로 변환하므로(keysToCamel 재귀 적용) 두 표기 모두 확인.
        isClosedToday((f.features?.rest_date_raw ?? f.features?.restDateRaw) as string | null | undefined) !== true,
    );
    if (pool.length === 0) {
      showToast(t('cuisine.noMatch'));
      return;
    }
    setCuisineChip(chip.id);
    cuisineIntentRef.current = chip.kw;
    applyVoiceFilter(new Set(pool.map((f: any) => f.id)));
    const ranked = pool.map((f: any) => ({ ...f, spot: calculateSPOT(f) })).sort(compareFacilities);
    setSelectedFacility(ranked[0]);
    if (mapInstanceRef.current && typeof ranked[0].latitude === 'number') panToVisible(ranked[0].latitude, ranked[0].longitude);
  };

  // (c) 검색 결과 유무 — 현재 카테고리에서 이름 일치 마커가 0건이면 '빈 지도' 혼란을 막기 위해 안내를 띄운다.
  const _filterTypeMap: Record<string, string> = { '음식점': 'restaurant', '카페': 'cafe', '관광지': 'attraction', '문화시설': 'culture' };
  const searchActive = searchQuery.trim() !== '';
  // 빈 상태 배지 4종을 각각 facilities.filter로 재순회하지 않고, 관련 상태가 바뀔 때 한 번만 집계한다.
  const { searchMatchCount, barrierFreeMatchCount, parkingMatchCount, petMatchCount } = useMemo(() => {
    const targetType = _filterTypeMap[activeFilter];
    const query = searchQuery.trim().toLowerCase();
    let search = 0, barrier = 0, parking = 0, pet = 0;
    for (const f of facilities) {
      if (f.type !== targetType) continue;
      if (query && String(f.name ?? '').toLowerCase().includes(query)) search += 1;
      if (f?.barrierFree ?? f?.barrier_free ?? f?.features?.barrier_free) barrier += 1;
      if (parseAvailability(f?.features?.parking as string | null | undefined) === true) parking += 1;
      if (parseAvailability((f?.features?.chk_pet ?? f?.features?.chkPet) as string | null | undefined) === true) pet += 1;
    }
    return {
      searchMatchCount: searchActive ? search : 0,
      barrierFreeMatchCount: showBarrierFree ? barrier : 0,
      parkingMatchCount: showParkingFilter ? parking : 0,
      petMatchCount: showPetFilter ? pet : 0,
    };
  }, [facilities, activeFilter, searchQuery, searchActive, showBarrierFree, showParkingFilter, showPetFilter]);

  // TourAPI 실시간 키워드 폴백 — 검색 활성 + 로컬 매칭 0건일 때만, 500ms 디바운스 후 조회.
  // 백엔드 미배선/키 미설정 등 어떤 실패든 빈 목록으로 흡수(무해 폴백 — 기존 배너만 유지되고 이 섹션은 그냥 안 뜬다).
  useEffect(() => {
    if (!(searchActive && searchMatchCount === 0)) {
      setLiveSearchItems([]);
      setLiveSearchLoading(false);
      return;
    }
    const q = searchQuery.trim();
    setLiveSearchLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await apiClient.get('/api/v1/search/keyword', { params: { q } });
        setLiveSearchItems(Array.isArray(res?.items) ? res.items : []);
      } catch (err) {
        console.warn('TourAPI 실시간 검색 실패 — 무해 폴백(빈 목록):', err);
        setLiveSearchItems([]);
      } finally {
        setLiveSearchLoading(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [searchActive, searchMatchCount, searchQuery]);

  // '다음 배치 추가 요청' 버튼 — POST /search/ingest-request 로 큐잉만 한다(즉시 적재 아님, 관리자 승인 후 반영).
  const requestLiveIngest = async (item: LiveSearchItem) => {
    try {
      await apiClient.post('/api/v1/search/ingest-request', {
        contentid: item.contentid,
        name: item.title,
        contentTypeId: item.contenttypeid ?? null,
      });
      setRequestedIngestIds(prev => new Set(prev).add(item.contentid));
      showToast(t('map.liveSearchRequested'));
    } catch (err: any) {
      console.warn('적재 요청 실패:', err);
      showToast(err?.message || '요청에 실패했어요. 잠시 후 다시 시도해 주세요.');
    }
  };

  return (
    <div className="relative w-full h-[100dvh] overflow-hidden flex flex-col">

      {/* Map Container — 자연스러운 라이트 카카오맵(한지 톤). 타일 다크 반전(map-dark-tiles) 제거 →
          경주 관광 밝은 지도. 마커/오버레이는 data: URI 이미지라 본래의 선명한 색으로 표시된다. */}
      <div
        ref={mapContainerRef}
        className={`w-full h-full absolute inset-0 z-0${mapUnavailable ? ' bg-gradient-to-b from-hanji-deep/70 via-hanji-deep/40 to-hanji' : ''}`}
      />

      {/* Top Layer: Search & Filters — 다크 오버레이 그라디언트 제거(플로팅 패널 자체 배경으로 가독성 확보) */}
      <div className="absolute top-0 w-full z-20 pt-12 md:pt-5 pb-4 px-4 flex flex-col gap-4 pointer-events-none">

        {/* 지도 SDK 로드 실패(8초 타임아웃) 안내 칩 — 검색/배리어프리 빈 상태 칩과 동일 스타일 재사용.
            추천 카드 등 나머지 UI 는 지도 유무와 무관하게 계속 동작한다. */}
        {mapUnavailable && (
          <div className="flex justify-center pointer-events-auto">
            <span className="inline-block text-muk text-xs bg-white/90 border border-line rounded-full px-3 py-1 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
              {t('map.loadFailed')}
            </span>
          </div>
        )}

        {/* PC(md+)는 구글맵스식 톱바 — 컴팩트 검색바(≈1/4폭)를 왼쪽에, 카테고리 칩·지도 레이어
            컨트롤을 그 오른쪽에 나란히 배치한다. 모바일은 기존 세로 스택 그대로. */}
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:gap-4">

        {/* 왼쪽 열: 검색바 + 검색 상태 안내 */}
        <div className="flex flex-col gap-2 md:w-1/4 md:min-w-[300px] md:max-w-[400px] md:shrink-0">

        {/* Search Bar — (c) 로컬 시설명 검색(마커 필터). 음성 검색(Mic)은 브라우저 STT 로 받아쓰기 → 검색어 주입.
            (Web Speech 미지원 브라우저에선 '준비 중' 비활성으로 graceful 폴백.) */}
        <div className="flex items-center bg-white/90 backdrop-blur rounded-full px-4 py-3 md:py-2.5 border border-line shadow-[0_2px_14px_rgba(43,35,32,0.06)] pointer-events-auto">
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

        {/* TourAPI 실시간 검색 폴백 — 적재 85곳 밖 POI 를 큐잉 요청까지 이어준다(지도 마커/이동 없음, 행만).
            로딩 중이거나 결과가 있을 때만 렌더(무응답/미가용은 조용히 숨김 — 위 검색 결과 없음 배너로 충분). */}
        {searchActive && searchMatchCount === 0 && (liveSearchLoading || liveSearchItems.length > 0) && (
          <div className="pointer-events-auto rounded-2xl bg-white/95 backdrop-blur border border-line shadow-[0_2px_14px_rgba(43,35,32,0.06)] overflow-hidden">
            <div className="px-3 py-2 text-xs font-semibold text-muk border-b border-line/70 flex items-center gap-1.5">
              <Search size={12} className="text-gold" />
              {t('map.liveSearchTitle')}
            </div>
            {liveSearchLoading ? (
              <div className="px-3 py-3 flex items-center gap-2 text-xs text-muk-soft">
                <span className="inline-block w-3 h-3 rounded-full border-2 border-gold/40 border-t-gold animate-spin" />
                {t('map.liveSearchTitle')}…
              </div>
            ) : (
              <ul className="max-h-64 overflow-y-auto divide-y divide-line/60">
                {liveSearchItems.map((item) => {
                  const requested = requestedIngestIds.has(item.contentid);
                  return (
                    <li key={item.contentid} className="px-3 py-2.5 flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-muk truncate">{item.title}</p>
                        {item.addr1 && <p className="text-[11px] text-muk-soft truncate">{item.addr1}</p>}
                        <span className="inline-block mt-1 text-[10px] font-medium text-muk-soft bg-line/60 rounded-full px-2 py-0.5">
                          {t('map.liveSearchPending')}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => requestLiveIngest(item)}
                        disabled={requested}
                        title={requested ? t('map.liveSearchRequestedBadge') : t('map.liveSearchRequest')}
                        className={`shrink-0 text-[11px] font-semibold rounded-full px-2.5 py-1.5 border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
                          requested
                            ? 'text-muk-soft border-line bg-line/40 cursor-default'
                            : 'text-gold border-gold/50 hover:bg-gold/10'
                        }`}
                      >
                        {requested ? t('map.liveSearchRequestedBadge') : t('map.liveSearchRequest')}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
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

        {/* 🅿 주차 필터 결과 없음 안내 — 배리어프리·검색과 동일 톤(신규 i18n 키 없이 searchNoResult 재사용). */}
        {showParkingFilter && parkingMatchCount === 0 && !(searchActive && searchMatchCount === 0) && !(showBarrierFree && barrierFreeMatchCount === 0) && (
          <div className="pointer-events-auto px-2 -mt-1">
            <span className="inline-block text-muk text-xs bg-white/90 border border-line rounded-full px-3 py-1 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
              🅿 {t('map.searchNoResult', { q: t('map.filterParking') })}
            </span>
          </div>
        )}

        {/* 🐾 반려동물 필터 결과 없음 안내 — 위와 동일 패턴. */}
        {showPetFilter && petMatchCount === 0 && !(searchActive && searchMatchCount === 0) && !(showBarrierFree && barrierFreeMatchCount === 0) && !(showParkingFilter && parkingMatchCount === 0) && (
          <div className="pointer-events-auto px-2 -mt-1">
            <span className="inline-block text-muk text-xs bg-white/90 border border-line rounded-full px-3 py-1 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
              🐾 {t('map.searchNoResult', { q: t('map.filterPet') })}
            </span>
          </div>
        )}

        </div>{/* /왼쪽 열(검색) */}

        {/* 오른쪽 열(모바일은 아래): 카테고리 칩 + 지도 레이어 컨트롤 */}
        <div className="flex flex-col gap-4 md:flex-1 md:min-w-0 md:gap-2.5">

        {/* Filter Chips — PC 에선 스크롤 대신 줄바꿈(구글맵스 칩 행 관례) */}
        <div className="flex gap-3 overflow-x-auto no-scrollbar pointer-events-auto md:flex-wrap md:overflow-visible md:gap-2">
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
                  setCuisineChip(null);   // 세부분류 칩도 함께 해제(음식점 외 카테고리로 새지 않게)
                  cuisineIntentRef.current = null;
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

        {/* 세부 음식분류 칩(치킨/피자·양식/국밥 등) — 음식점 카테고리에서만. 재탭 시 해제. */}
        {activeFilter === '음식점' && (
          <div className="flex gap-2 overflow-x-auto no-scrollbar pointer-events-auto md:flex-wrap md:overflow-visible">
            {cuisineChips.map((chip) => {
              const on = cuisineChip === chip.id;
              return (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => selectCuisineChip(chip)}
                  aria-pressed={on}
                  className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-all shadow-[0_1px_8px_rgba(43,35,32,0.05)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 sm:px-3 sm:py-1.5 sm:text-xs ${
                    on
                      ? 'bg-terracotta/15 border-terracotta text-terracotta'
                      : 'bg-white/75 border-line text-muk-soft hover:bg-white hover:text-muk'
                  }`}
                >
                  <span aria-hidden>{chip.emoji}</span>
                  {t(`cuisine.${chip.id}`)}
                </button>
              );
            })}
          </div>
        )}

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

          {/* 🅿 주차 가능 필터 — 켜지면 features.parking 이 '가능'으로 파싱되는 시설만 지도에 표시. 배리어프리와 동일 패턴(AND 조합). */}
          <button
            type="button"
            onClick={() => setShowParkingFilter((prev) => !prev)}
            aria-pressed={showParkingFilter}
            className={`flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-[13px] font-medium transition-all fractal-glass shadow-[0_2px_14px_rgba(43,35,32,0.06)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 sm:px-4 sm:py-2 sm:text-sm ${
              showParkingFilter
                ? 'bg-jade/15 border-jade text-muk'
                : 'bg-white/80 border-line text-muk-soft hover:bg-white hover:text-muk'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${showParkingFilter ? 'bg-jade animate-pulse' : 'bg-muk-soft/40'}`} />
            🅿 {t('map.filterParking')}
          </button>

          {/* 🐾 반려동물 동반 필터 — 켜지면 features.chk_pet 이 '가능'으로 파싱되는 시설만 지도에 표시. 배리어프리와 동일 패턴(AND 조합).
              커버리지 게이트: 현재 적재 데이터에 chk_pet 값이 하나도 없으면(실측 0/85) 항상 빈 지도가 되는
              칩이라 숨긴다 — TourAPI 재적재로 값이 생기는 즉시 자동 노출. */}
          {facilities.some((f: any) => parseAvailability((f?.features?.chk_pet ?? f?.features?.chkPet) as string | null | undefined) !== null) && (
          <button
            type="button"
            onClick={() => setShowPetFilter((prev) => !prev)}
            aria-pressed={showPetFilter}
            className={`flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-[13px] font-medium transition-all fractal-glass shadow-[0_2px_14px_rgba(43,35,32,0.06)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 sm:px-4 sm:py-2 sm:text-sm ${
              showPetFilter
                ? 'bg-jade/15 border-jade text-muk'
                : 'bg-white/80 border-line text-muk-soft hover:bg-white hover:text-muk'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${showPetFilter ? 'bg-jade animate-pulse' : 'bg-muk-soft/40'}`} />
            🐾 {t('map.filterPet')}
          </button>
          )}

          {/* ⏱ 대기 보드 진입 칩 — /waiting(스마트 줄서기 보드, 정보형)로 이동. 이 칩은 토글이 아니라
              단순 내비게이션이라 aria-pressed 없이 다른 칩과 동일 문법(pill + fractal-glass)만 맞춘다. */}
          <button
            type="button"
            onClick={() => router.push('/waiting')}
            className="flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-[13px] font-medium transition-all fractal-glass shadow-[0_2px_14px_rgba(43,35,32,0.06)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 sm:px-4 sm:py-2 sm:text-sm bg-white/80 border-line text-muk-soft hover:bg-white hover:text-muk"
          >
            ⏱ {t('waiting.entryChip')}
          </button>

          {/* 🏮 경주 축제 칩 — TourAPI 실시간 축제/행사(GET /api/v1/events). 0건·백엔드 다운이면 스스로 숨는다.
              축제 선택 시 지도에 핀(구체 주소) 또는 색상 영역(동·일원 등 넓은 지역)으로 표시. */}
          <FestivalBanner onFocus={focusFestivalOnMap} />

          {/* 🍃 지금 한산 — 현재 여유로운 곳 TOP3(level<0.3, 취향 우선). 탭 시 시트 닫고 해당 시설 선택+패닝.
              0곳이면 칩 자체를 숨긴다. onFocus 에서 전체 facility 를 id 로 되찾아 카드가 온전한 정보를 갖게 한다. */}
          <TodayCalmSpots
            facilities={facilities}
            userLocation={userLocation}
            onFocus={(f) => {
              const full = facilities.find((x) => x.id === f.id) || f;
              setActiveGroupId(null);
              setSelectedFacility(full);
              if (mapInstanceRef.current && typeof full.latitude === 'number') panToVisible(full.latitude, full.longitude);
            }}
          />

          {/* 예측 정직성 배지 — 실측(Live)과 혼동 방지. anchored false 면 '추정' 꼬리표로 실측 앵커 부재를 알린다. */}
          {isForecast && (
            <span className="shrink-0 px-3 py-1 rounded-full text-[11px] font-bold bg-jade border border-jade/50 text-white shadow-[0_2px_10px_rgba(43,35,32,0.12)] whitespace-nowrap">
              🔮 {t('map.forecastBadge', { h: hoursAhead })}{!forecastAnchored ? ` · ${t('map.forecastEstimateTag')}` : ''}
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

          {/* D5: TourAPI 동기화 신선도 — 소형 정보 표시(비대화형). 동기화 이력이 전혀 없으면
              렌더하지 않는다(관광객 화면 정직성 — 없는 걸 있는 척하지 않음). */}
          {tourapiSyncAt && (() => {
            const parts = relativeParts(tourapiSyncAt);
            if (!parts) return null; // 파싱 불가 — 신선한 것으로 위장하지 않고 숨김
            const rel =
              parts.unit === 'now' ? t('freshness.justNow')
              : parts.unit === 'min' ? t('freshness.minAgo', { n: parts.value })
              : parts.unit === 'hour' ? t('freshness.hourAgo', { n: parts.value })
              : t('freshness.dayAgo', { n: parts.value });
            return (
              <span className="shrink-0 px-2.5 py-1 rounded-full text-[10px] font-medium bg-white/70 border border-line text-muk-soft whitespace-nowrap pointer-events-none">
                🛰️ {t('freshness.tourapiSync', { rel })}
              </span>
            );
          })()}
        </div>

        </div>{/* /오른쪽 열(칩·컨트롤) */}
        </div>{/* /구글맵스식 톱바 행 */}
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
              .filter((f) => (!voiceFilterIds || voiceFilterIds.has(f.id)) && !rejectedIds.has(f.id) && !savedIds.has(f.id));
            const activeScored = activeCandidates.map(f => ({
              ...f,
              spot: calculateSPOT(f)
            })).sort(compareFacilities);

            const rankIndex = activeScored.findIndex(f => f.id === selectedFacility.id);
            rank = rankIndex !== -1 ? rankIndex + 1 : undefined;
            totalCandidates = activeScored.length;
          }

          const spot = selectedFacility.spot || calculateSPOT(selectedFacility);
          // 사유: 자동 추천된 실 시설은 백엔드 템플릿 사유, 마커 직접 클릭/데모는 미러 사유로 폴백
          const reason = selectedFacility.reason || ""; // 백엔드 템플릿 사유만(하드코딩 제거)
          // 추천 카드 배치 — 모바일: 하단 전폭 시트. PC(md+): 우측 세로 도킹 패널(구글맵스 상세 패널 관례).
          // 전폭 하단 카드가 데스크톱에서 과하게 커 보이는 문제를 해결한다. 상단 톱바(검색·칩) 아래
          // (top-24)부터 하단(bottom-6)까지 세로로 앉히고, 펼침으로 길어지면 패널 내부에서 스크롤한다.
          return (
            // pointer-events-none(컨테이너): bottom 고정 absolute 라 카드가 높으면 박스 상단이 세부 음식 칩
            // 행까지 자라 칩 탭을 통째로 가로챘다(elementFromPoint 실측). 상호작용 자식(카드·오브)만 auto.
            <div className="absolute z-20 px-4 transition-all duration-300 bottom-[calc(80px+env(safe-area-inset-bottom))] w-full md:bottom-6 md:top-24 md:left-auto md:right-4 md:w-[370px] md:px-0 md:overflow-y-auto md:overscroll-contain no-scrollbar pointer-events-none">
              {voice.ttsSupported && (
                // pointer-events-none: 이 행은 전폭 스트립이라 카드가 높을 때 세부 음식 칩 위를 덮어
                // 칩 탭을 가로챘다(실측). 오브 자체는 루트에 pointer-events-auto 라 계속 탭 가능.
                <div className="flex justify-end mb-2 pr-1 md:pr-0 pointer-events-none">
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
              {/* 카드만 pointer-events 복원 — 컨테이너는 none(위 주석 참조) */}
              <div className="pointer-events-auto">
              <RecommendationCard
                title={selectedFacility.name}
                reason={reason}
                onAccept={() => handleAccept(selectedFacility)}
                onReject={() => handleReject(selectedFacility)}
                onPutOff={() => handlePutOff(selectedFacility)}
                spotScore={spot.score}
                preferencePercent={spot.preferencePercent}
                expectedWait={spot.expectedWait}
                expectedTravel={spot.expectedTravel}
                timeToService={spot.timeToService}
                eventBoost={spot.eventBoost}
                eventTitle={spot.eventTitle}
                facilityType={selectedFacility.type}
                facility={selectedFacility}
                rank={rank}
                totalCandidates={totalCandidates}
                mockHour={mockHour}
                dataSource={{
                  source: selectedFacility.source ?? null,
                  lastUpdated: selectedFacility.lastUpdated ?? null,
                  isStale: !!selectedFacility.isStale,
                }}
              />
              </div>
            </div>
          );
        } catch (err) {
          console.warn("Error rendering RecommendationCard IIFE:", err);
          return null;
        }
      })()}

      {/* (b) 현재 카테고리 추천 후보 0건 — 카드가 조용히 사라지는 대신 안내 표시 */}
      {!isLoadingFacilities && !facilitiesLoadError && facilities.length > 0 && !selectedFacility && noRecommendation && (
        <div className="absolute z-20 px-4 bottom-[calc(80px+env(safe-area-inset-bottom))] w-full md:bottom-auto md:top-24 md:left-auto md:right-4 md:w-[370px] md:px-0">
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





      {/* 방문 확인 루프 배너 — 수락 후 30분 경과한 대기 방문이 있으면 스스로 노출(없으면 null). body 포털이라 위치 무관. */}
      <VisitCheckCard showToast={showToast} />

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
