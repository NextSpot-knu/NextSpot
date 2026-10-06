'use client';

import { useEffect, useReducer, useRef, useState, useMemo, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import { Search, Mic, X, Utensils, MapPin, Building2, Coffee, Car, ChevronDown, ChevronUp, SlidersHorizontal, Clock3 } from 'lucide-react';
import { createPublicClient } from '@/lib/supabase';
import { isPaintableMeasurement, pinDisplay, pinSvg } from '@/lib/map/markerSvg';
import { centerTargetFor, type BandInsets } from '@/lib/map/visibleBand';
import { scoreFacility, compareSpot, displayWalkingMinutes, rankFacilities, rankFacilitiesDegraded, recToSpot, haversineMeters, filterReachable, isBarFacility, type Spot } from '@/lib/recommender';
import { REGION, isWithinRegion } from '@/lib/region';
import { cleanGalleryImages, loadMapFacilitiesFromSupabase } from '@/lib/mapFacilityFallback';
import { getRecommendations, recommendByType, rejectRecommendation, voiceTurn, apiClient, getCongestionEstimates, type CongestionEstimate, ASSUMED_TIME_PRESETS, ASSUMED_TIME_EVENT, assumedAtIsoForPreset, getStoredAssumedPreset, setStoredAssumedPreset, prefetchDemoHotPaths } from '@/lib/api-client';
import {
  displayableEstimate,
  estimatesFromFeed,
  measurementIsCurrentFallback,
  parseCongestionEstimate,
  revalidateIsCurrent,
} from '@/lib/congestionEstimate';
import { sessionAreaDemandCurve } from '@/lib/areaDemandCurve';
import { isPredictModelTrained } from '@/lib/predictModel';
import {
  STRIP_NOW,
  clampForecastHours,
  forecastHeadlineLevel,
  relativeAssumedAtIso,
  resolveStripForecast,
  stripHours,
  stripReducer,
  type ForecastHours,
  type ModelPredictions,
} from '@/lib/forecastStrip';
// 히트맵 blob 의 색·크기 규칙(마커/배지 임계와 일관) 공용 헬퍼 — 중복 정의 금지, 그대로 재사용.
import { getHeatGradient, getHeatRadius } from '@/lib/map/heatmap';
import { useVoiceAssistant } from '@/lib/voice/useVoiceAssistant';
import { useSpeechSearch } from '@/lib/voice/useSpeechSearch';
import { speechLangFor } from '@/lib/voice/speechLocale';
import { classifyIntent } from '@/lib/voice/voiceIntent';
import { buildCardSentence, buildVoiceReason } from '@/lib/voice/voiceReason';
import { CUISINE_CHIPS, cuisineChipForUtterance, cuisineChipPool, voiceCandidatePayload, type CuisineChip } from '@/lib/voice/voiceCandidates';
import { VoiceCaptionBar, VoicePill } from '@/components/VoiceSlot';
import { DESKTOP_PANEL_CLASS, desktopPanelReservePx } from '@/lib/mainPanelLayout';
import { hasFinalConsonant, pickFirstViewCategory } from '@/lib/firstViewCategory';
import { usePhoneViewport } from '@/lib/usePhoneViewport';
import type { CardCondition } from '@/components/RecommendationCard';
import { recordActiveTrip } from '@/lib/visits';
import { queueRecommendationOutcome } from '@/lib/recommendationOutcomes';
import { openDrivingDirections, openWalkingDirections } from '@/lib/navigation';
import { track } from '@/lib/analytics';
import { loadSavedLocal, syncSaved, saveBookmark, type SavedRecord } from '@/lib/savedFacilities';
import { useI18n } from '@/lib/i18n/I18nProvider';
// T2: 휴무 원문 파서(오늘 휴무 확정만 배제) + 가능/불가능 텍스트 파서(주차·반려동물 필터) — 공용 단일 소스.
import { getArrivalOpenStatus, isClosedToday, isRecommendationOpen, parseAvailability } from '@/lib/restDate';
import { chipCandidates, EMPTY_TRAVEL_CONTEXT, loadTravelContext, matchesTravelContext, relaxWalkLimit, saveTravelContext, type CuisinePreference, type PlaceCategory, type TravelContext, CUISINE_INTENT } from '@/lib/travelContext';
import { buildVoiceCommandTransition, type VoiceAppCommand } from '@/lib/voice/voiceCommands';
import { facilityMatchesSearch } from '@/lib/placeSearch';
import { congestionKey } from '@/lib/congestionScale';
import { useBusyThreshold } from '@/components/shell/PublicSettingsProvider';
import { errorMessage } from '@/lib/errors';
import NextSpotMascot from '@/components/NextSpotMascot';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { SourceCredit } from '@/components/SourceCredit';
import ForecastTimeStrip from '@/components/main/ForecastTimeStrip';
import { buildSpotComparisons, formatSpotComparison } from '@/lib/spotComparison';
import { anchorNowLevel, candidateAreaCrowdLevel, chooseCompareHeadline, resolveAnchorCrowd, resolveCandidateCrowd } from '@/lib/compareHeader';
import { cardTimes } from '@/lib/cardTimes';
import {
  DISCOVERY_THEMES,
  findDiscoveryAnchor,
  getDiscoveryTheme,
  type DiscoveryTheme,
  type DiscoveryThemeId,
} from '@/lib/gyeongjuDiscovery';

const RecommendationCard = dynamic(
  () => import('@/components/RecommendationCard').then((m) => m.RecommendationCard),
  { ssr: false },
);
const FestivalBanner = dynamic(() => import('@/components/main/FestivalBanner'), { ssr: false });
const WeatherChip = dynamic(() => import('@/components/main/WeatherChip'), { ssr: false });
const RestroomChip = dynamic(() => import('@/components/main/RestroomChip'), { ssr: false });
const TodayCalmSpots = dynamic(() => import('@/components/main/TodayCalmSpots'), { ssr: false });
const VisitCheckCard = dynamic(() => import('@/components/main/VisitCheckCard'), { ssr: false });
const ActiveJourneyCard = dynamic(() => import('@/components/main/ActiveJourneyCard'), { ssr: false });

const supabase = createPublicClient();

// ── 이 페이지가 다루는 앱 도메인 데이터의 로컬 타입 ──
// (Kakao Maps SDK 객체(map/marker/overlay/LatLng 등)는 의도적으로 any 유지 — SDK 타이핑 미도입.)

// features JSONB 중 이 페이지가 읽는 키만 명시(그 외 키는 unknown 인덱스로 통과).
interface FacilityFeatures {
  cuisine_tags?: string[] | string;
  cuisine?: string[] | string;
  category?: string; // 정밀분류(tag_cuisines.py 배치가 채움) — 음성 후보에 실어 백엔드 분류 게이트 입력
  [key: string]: unknown;
}

// Supabase congestion_logs 행(이 페이지가 select 하는 컬럼만).
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
  address?: string | null;
  phone?: string | null;
  operatingHours?: { open?: string; closed?: string; [key: string]: unknown } | null;
  imageUrl?: string | null;
  galleryImages?: string[] | null;
  homepage?: string | null;
  overview?: string | null;
  barrierFree?: boolean | null;
  // TourAPI 원문 식별자 — 상세 카드의 '실시간 정보 새로고침'(GET /infrastructures/live-detail/{contentid})용.
  // 값이 없는 행(수동 시드·Kakao 발굴)은 카드가 그 버튼을 그리지 않는다(추가만).
  contentid?: string | null;
  contenttypeid?: number | null;
  lastUpdated: string | null;
  source?: string | null;
  congestionSource?: 'measured' | 'predicted' | 'none';
  congestionLogSource?: string | null;
  congestionIsStale?: boolean | null;
  isStale?: boolean;
  congestionTimestamp?: string | null;
  // 서버 판정 — 위 congestionLevel 이 '지금' 을 말할 자격이 있는가(백엔드 CongestionInfo.is_current /
  // RecommendItem.congestion_is_current). 화면은 다시 계산하지 않는다(lib/congestionEstimate.ts 머리말).
  // 지도 마커는 이 값을 보지 않는다 — 마커는 언제나 실측만 칠한다.
  congestionIsCurrent?: boolean | null;
  // 추정 모드(주차 실측 + 관광 통계, 실측 아님). congestionLevel/baseCongestion 과 **따로** 둔다 —
  // 그 두 필드는 클라 미러 점수(scoreFacility)·히트맵·저장·음성 후보가 '관측' 으로 읽는 자리라, 섞이면
  // 추정이 실측 등급으로 순위를 얻는다. 그릴 때마다 displayableEstimate 로 신선도(60분)를 다시 본다.
  // 지도 시설에는 **저장하지 않는다**(24시간 캐시에 60분짜리 값을 넣지 않게) — 추천 응답이 실어 준
  // 값만 여기 들고, 지도는 별도 피드(estimateById)를 그릴 때 덧씌운다.
  congestionEstimate?: CongestionEstimate | null;
  dataUpdatedAt?: string | null;
  informationConfidence?: 'verified' | 'unknown';
  eligibilityTier?:
    | 'verified_open_route'
    | 'verified_open_estimated_route'
    | 'hours_confirmation_required_route'
    | 'hours_and_route_confirmation_required';
  availabilityEvidence?: {
    status: 'open' | 'closed';
    evidenceTier: 'single_report' | 'corroborated';
    corroboratingCount: number;
    reportedAt: string;
    expiresAt: string;
  } | null;
  openStatusAtArrival?: 'open_expected' | 'closing_soon' | 'closed_confirmed' | 'needs_confirmation';
  spot?: Spot;
  reason?: string;
  apiRank?: number;
  totalCandidates?: number;
  recommendationId?: string;
  scoringMode?: 'model' | 'measured_rules' | 'area_stats_rules' | 'degraded_rules';
  couponRate?: number | null;
  timesaleRate?: number | null;
  discoveryThemeMatch?: {
    source: 'tourapi_related' | 'facility_fact';
    value: string;
  } | null;
  /** 서버(음성 분류기)가 이 장소를 고르며 만든 문장 — 한국어 화면에서만 그대로 읽는다(계획 B2 · I46). */
  voiceSpoken?: string;
  /** 사용자가 직접 연 카드 — search·place 면 목록에 있어도 머리 배지가 '선택한 장소'. */
  pickKind?: 'pin' | 'search' | 'place';
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
// 재계산 스켈레톤의 경과 시간 계산용. 컴포넌트 본문에서 Date.now() 를 직접 부르면
// react-hooks/purity 가 '렌더 중 불순 호출'로 본다(실제 호출은 이벤트 핸들러·타이머에서만 일어난다).
function recalcClockMs(): number {
  return Date.now();
}

// 추천 요청 타임아웃. 프리티어 콜드스타트가 깨어날 여유를 준다(10초 전역 타임아웃이면 빈 미러로 떨어진다).
const RECOMMENDATION_TIMEOUT_MS = 20_000;
// 테마 칩(✨) 재계산은 by-type 이 아니라 getRecommendations(POI 대안 경로)를 타고, 그 요청은
// lib/api-client 가 45s 로 끊는다 — 비상 종료는 둘 중 긴 쪽을 기준으로 잡는다.
const THEME_RECOMMENDATION_TIMEOUT_MS = 45_000;
// 재계산 스켈레톤의 비상 종료 시각. **가장 긴 요청 타임아웃보다 뒤**여야 한다 — 먼저 끊으면 아직
// 날아오는 중인 응답을 두고 스켈레톤을 걷게 되고, 곧 도착할 카드가 안내 없이 바뀐다.
const RECALC_EMERGENCY_MS = Math.max(RECOMMENDATION_TIMEOUT_MS, THEME_RECOMMENDATION_TIMEOUT_MS) + 2_000;

const LAB_HINT_KEY = 'nextspot_lab_hint_shown';
const LAB_HINT_MAX_SHOWS = 2;

// 온보딩 음식 취향 → 문구 키 · 음식 칩(카페·디저트는 음식점 칩이 아니다).
const SETUP_FOOD_KEY: Record<CuisinePreference, string> = {
  '한식': 'setup.foodKorean',
  '분식·국밥': 'setup.foodSnack',
  '양식': 'setup.foodWestern',
  '카페·디저트': 'setup.foodDessert',
};
const SETUP_CUISINE_CHIP: Partial<Record<CuisinePreference, string>> = {
  '한식': 'korean',
  '분식·국밥': 'bunsik',
  '양식': 'western',
};

// 경주 밖 위치를 황리단길로 바꿨다는 안내 — 세션에 한 번만(위치가 다시 잡힐 때마다 반복하지 않는다).
const OUT_OF_REGION_NOTICE_KEY = 'nextspot_out_of_region_notice';

// 추천을 내는 칩 4종(주차장 제외) — 화면 id 와 시설 유형.
const CATEGORY_FILTERS: { id: string; type: PlaceCategory }[] = [
  { id: '음식점', type: 'restaurant' },
  { id: '카페', type: 'cafe' },
  { id: '관광지', type: 'attraction' },
  { id: '문화시설', type: 'culture' },
];

// localStorage 'nextspot_saved_facilities' 항목 — handlePutOff 가 저장하는 형태(읽기는 id만 사용).
interface SavedBookmark {
  id: string;
  name: string;
  category: string;
  // 저장 페이지의 라이브 혼잡 재조회(매칭)·카카오맵 길찾기 링크용 좌표(구버전 북마크엔 없을 수 있음).
  latitude?: number;
  longitude?: number;
  address?: string | null;
  phone?: string | null;
  features?: FacilityFeatures | null;
  trafficStatus: string;
  congestionLevel?: number | null;
  // 검증 모델의 대기시간만 저장한다. degraded/지역수요 규칙에서는 null.
  waitTime: string | null;
  waitEvidence?: 'verified_model';
  spot: Spot;
  reason: string;
  // 저장 당시의 실제 recommendations 행 id. 저장 화면이 '저장 해제' 피드백을 서버로 보낼 때
  // 쓴다(apps/web/app/saved/page.tsx). 이 필드가 없어서 그 신호가 영영 전송되지 않았다.
  recommendationId?: string;
}

const FACILITY_CACHE_KEY = 'nextspot_facilities_cache_v3';
const FACILITY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function loadFacilityCache(): Facility[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(FACILITY_CACHE_KEY) || 'null') as {
      savedAt?: number;
      facilities?: Facility[];
    } | null;
    if (!parsed?.savedAt || !Array.isArray(parsed.facilities)) return null;
    if (Date.now() - parsed.savedAt > FACILITY_CACHE_MAX_AGE_MS) return null;
    // 30분짜리 판정을 24시간 캐시가 그대로 되살리지 않게 나이로 다시 본다. 이 캐시가 첫 화면을
    // 그리는데, 5시간 전 'is_current: true' 를 믿으면 그 낡은 관측이 방금 받은 추정을 가린다.
    return parsed.facilities.map((f) => ({
      ...f,
      congestionIsCurrent: revalidateIsCurrent(
        f.congestionIsCurrent,
        f.congestionTimestamp ?? f.lastUpdated,
      ),
    }));
  } catch {
    return null;
  }
}

function saveFacilityCache(facilities: Facility[]): void {
  try {
    localStorage.setItem(FACILITY_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), facilities }));
  } catch {
    // 저장 공간 차단/부족은 최신 네트워크 경로에 영향을 주지 않는다.
  }
}

// 장소 검색 결과 1건 — GET /api/v1/search/places(Kakao 장소 검색) 응답.
// 백엔드는 place_id/place_url/category_name 으로 주고, api-client 의 keysToCamel 이 camelCase 로 바꿔 준다
// (예전 주석은 엔드포인트 이름도 틀렸고 '변환 없음' 이라고 적혀 있었다 — 둘 다 사실이 아니다).
// 적재 전 POI 라 지도 마커는 없다(행 목록 전용).
interface PlaceSearchItem {
  placeId: string;
  name: string;
  type?: 'cafe' | 'restaurant' | null;
  latitude: number;
  longitude: number;
  address: string;
  phone?: string | null;
  placeUrl?: string | null;
  categoryName?: string | null;
}

// 관광공사(TourAPI) 키워드 검색 결과 1건 — GET /api/v1/search/keyword 응답.
//
// **우리 데이터가 아니다.** 지도 검색(로컬 facilities)도 Kakao 장소 검색도 0건일 때만 부르고,
// 결과는 출처를 명시한 별도 블록으로만 그린다. 이 목록과 위 두 목록을 한 덩어리로 섞으면
// 사용자는 어떤 줄이 우리가 아는 장소인지 구분할 수 없다.
//
// 백엔드는 TourAPI 원문 필드명을 그대로 쓰고(contentid/addr1/mapx/mapy), keysToCamel 은
// 밑줄이 없는 이 이름들을 바꾸지 않는다.
interface TourApiSearchItem {
  contentid: string;
  title: string;
  addr1?: string | null;
  mapx?: number | null;
  mapy?: number | null;
  contenttypeid?: number | null;
  firstimage?: string | null;
}

interface ParkingLot {
  id: string;
  name: string;
  type: 'parking';
  latitude: number;
  longitude: number;
  distanceM: number;
  totalSpaces: number | null;
  availableSpaces: number | null;
  occupancy: number | null;
  live: boolean;
  observedAt: string | null;
  source: string | null;
  capacity: number;
  congestionLevel: number | null;
  features: FacilityFeatures;
}

// 술집(bar)이 음식점(restaurant)으로 적재되면 '음식점' 추천을 오염시킨다(데이터 한계).
// 음식 태그로 술집을 식별해 음식점 추천 후보에서만 제외한다(지도 마커로는 계속 표시 — 삭제 아님).
// 판정은 lib/recommender.isBarFacility — camelCase(cuisineTags)도 읽는다(계획 B2 · I09: apiClient 를 거친
// 시설은 cuisineTags 라 예전 판정은 늘 '술집 아님' 이었다).

// 첫 카드를 기다리는 최대 시간 — 이 안에 서버 답이 오면 그 1위를 바로 띄우고, 넘기면 즉시 계산한 카드를 띄운다
// (계획 B2 · I34: 카드가 1~4초 뒤 다른 곳으로 바뀌던 것을 막는다).
const FIRST_PICK_WAIT_MS = 3500;
// 카드를 연 뒤 취향 프로필 알림은 한 세션에 한 번(매번 띄우면 도보 길안내·관심 없어요마다 알림이 쌓인다).
const PROFILE_TOAST_KEY = 'nextspot_profile_toast_shown';

// (window.kakao 타입은 types/kakao-maps.d.ts 가 전역으로 선언한다 — 파일마다 declare global 로
//  중복 선언하던 `kakao: any` 를 걷어냈다.)


export default function MainPage() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const topBarRef = useRef<HTMLDivElement>(null); // 상단 검색·칩 오버레이 — 초기 중심 보정에서 높이를 잰다
  // 데스크톱 툴바 판(카테고리 · 지도 레이어 · 출처 칩 두 줄) — 추천 열(카드 · 제안 카드)을 그 아래 끝에 둔다. 판 높이는
  // 언어·폭에 따라 바뀌어 고정 top 이면 출처 칩을 덮었다(10-06 실측) — 재서 --panel-top 으로 넘긴다.
  const chipColumnRef = useRef<HTMLDivElement>(null);
  const [toolbarClearPx, setToolbarClearPx] = useState<number | null>(null);
  useEffect(() => {
    const column = chipColumnRef.current;
    const bar = topBarRef.current;
    if (!column || !bar || typeof ResizeObserver === 'undefined') return;
    const measure = () => setToolbarClearPx(Math.round(column.getBoundingClientRect().bottom - bar.getBoundingClientRect().top) + 12);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => observer.disconnect();
  }, []);
  // 언어·시계 묶음(데스크톱 오른쪽 위) — 그 폭만큼 툴바 첫 줄을 비운다(둘째 줄은 그 밑까지 쓴다).
  const topClusterRef = useRef<HTMLDivElement>(null);
  const [topClusterPx, setTopClusterPx] = useState<number | null>(null);
  useEffect(() => {
    const cluster = topClusterRef.current;
    if (!cluster || typeof ResizeObserver === 'undefined') return;
    const measure = () => setTopClusterPx(Math.round(cluster.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(cluster);
    return () => observer.disconnect();
  }, []);
  // 지도 띠 계산용 — 검색 줄(검색창 + 날씨·첫 방문 줄), 혼잡 예측 줄, 휴대폰 카드 열.
  const searchRowRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [recPanelEl, setRecPanelEl] = useState<HTMLDivElement | null>(null);
  const [recPanelHeight, setRecPanelHeight] = useState(0);
  useEffect(() => {
    if (!recPanelEl || typeof ResizeObserver === 'undefined') return;
    const measure = () => setRecPanelHeight(Math.round(recPanelEl.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(recPanelEl);
    return () => observer.disconnect();
  }, [recPanelEl]);
  const mapInstanceRef = useRef<kakao.maps.Map | null>(null);
  const markersRef = useRef<kakao.maps.Marker[]>([]);
  const searchMatchLabelsRef = useRef<kakao.maps.CustomOverlay[]>([]);
  const userMarkerRef = useRef<kakao.maps.CustomOverlay | null>(null);
  const activeOverlayRef = useRef<kakao.maps.CustomOverlay | null>(null);
  const searchResultMarkerRef = useRef<kakao.maps.Marker | null>(null);
  const searchResultLabelRef = useRef<kakao.maps.CustomOverlay | null>(null);
  const placeSearchSequenceRef = useRef(0);
  // 카테고리·위치가 바뀌면 이전 추천 응답은 더 이상 화면에 쓸 수 없다. 최신 요청만 남겨
  // 모바일의 제한된 연결과 브라우저 파싱 자원을 낭비하지 않는다.
  const recommendationAbortRef = useRef<AbortController | null>(null);
  // 추천 요청 세대 카운터 — abort() 만으로는 구세대 응답을 막지 못한다. 응답이 이미 도착해
  // await 가 풀린 뒤(콜백이 마이크로태스크 큐에서 대기 중)에 abort 하면 아무 일도 일어나지 않고,
  // 그 구세대 결과가 그대로 setState 까지 흘러간다. 세대가 어긋나면 화면에 쓰지 않는다
  // (같은 저장소 app/course/page.tsx 의 fetchGenRef 와 같은 모양).
  const recommendationGenRef = useRef(0);
  // 히트맵 CustomOverlay blob 배열 — 토글 off / 데이터·필터·예측 변경 / 언마운트 시 정리(cleanup)용.
  const heatmapOverlaysRef = useRef<kakao.maps.Overlay[]>([]);
  // 축제 포커스 오버레이(핀/영역 원 + 라벨) 배열 — 새 축제 선택·지도 클릭·언마운트 시 정리.
  const festivalOverlayRef = useRef<kakao.maps.Overlay[]>([]);

  // 첫 렌더는 서버 렌더와 같은 기본값(음식점) — 저장된 온보딩 칩은 마운트 뒤에 읽는다(아래 저장소 effect).
  // 렌더 중에 localStorage 를 읽으면 서버 HTML 과 달라 하이드레이션 오류가 났다(10-07 검토 — ♿ 저장 상태도 같은 원인).
  const [activeFilter, setActiveFilter] = useState<string>('음식점');
  const [searchQuery, setSearchQuery] = useState(''); // 상호·주소·검증 메뉴/업종/소개 검색 + Kakao 0건 폴백.
  // 로컬 검색이 0건일 때만 GET /api/v1/search/places 로 장소를 찾는다(적재 전 POI —
  // 행 목록 + '지도에서 보기' 임시 마커까지만, 상세 카드는 없다).
  // 여기서도 0건이면 관광공사 폴백(tourApiItems)으로 한 단계 더 내려가고, 그 줄에만
  // [다음 배치 추가 요청] 버튼이 붙는다(contentid 가 있어야 승인 큐가 단건 적재할 수 있다).
  const [liveSearchItems, setLiveSearchItems] = useState<PlaceSearchItem[]>([]);
  const [liveSearchLoading, setLiveSearchLoading] = useState(false);
  // Kakao 장소 검색까지 0건일 때만 부르는 관광공사(TourAPI) 키워드 폴백 — 별도 출처 블록.
  const [tourApiItems, setTourApiItems] = useState<TourApiSearchItem[]>([]);
  const [tourApiLoading, setTourApiLoading] = useState(false);
  // 폴백을 실제로 물어봤는가. '아직 안 물어봄' 과 '물어봤는데 0건' 은 다른 사실이라
  // 하나로 뭉개면 '어디에도 없는 장소' 안내를 조회 전에 띄우게 된다.
  const [tourApiAsked, setTourApiAsked] = useState(false);
  // 적재 요청을 이미 보낸 contentid. 같은 줄을 두 번 누르게 두면 백엔드 IP 리밋(분당 3회)만 태운다.
  const [ingestRequested, setIngestRequested] = useState<Set<string>>(new Set());
  const [ingestPendingId, setIngestPendingId] = useState<string | null>(null);
  const [facilities, setFacilities] = useState<any[]>([]);
  const [parkingLots, setParkingLots] = useState<ParkingLot[]>([]);
  // 🔥 히트맵 전용 공영주차 실측 스냅샷(주차장 탭의 parkingLots 와 독립 — 탭을 바꿔도 열지도가 비지 않는다).
  const [heatParkingLots, setHeatParkingLots] = useState<ParkingLot[]>([]);
  const heatParkingAskedRef = useRef(false);
  const [parkingLoading, setParkingLoading] = useState(false);
  const [parkingLoadError, setParkingLoadError] = useState(false);
  const [parkingReloadNonce, setParkingReloadNonce] = useState(0);
  const [selectedParkingLot, setSelectedParkingLot] = useState<ParkingLot | null>(null);
  // 시설 로드 상태(데모 사고 방지선): 로딩 스피너·재시도·전체 빈 상태 안내 렌더용.
  const [isLoadingFacilities, setIsLoadingFacilities] = useState(true);
  const [facilitiesLoadError, setFacilitiesLoadError] = useState(false);
  const [facilitiesReloadNonce, setFacilitiesReloadNonce] = useState(0); // '다시 시도' 트리거(로드 effect 재실행)
  const [selectedFacility, setSelectedFacility] = useState<any>(null);
  // 지금 화면의 카드 — 추천 effect 가 '서버가 같은 곳을 확인했는지' 를 렌더를 기다리지 않고 본다(계획 B2 · I34).
  const selectedFacilityRef = useRef<any>(null);
  useEffect(() => { selectedFacilityRef.current = selectedFacility; }, [selectedFacility]);
  // 첫 카드를 고르는 중(스켈레톤) — 서버 답을 최대 FIRST_PICK_WAIT_MS 기다린다.
  const [pickingFirst, setPickingFirst] = useState(false);
  // 사용자가 직접 고른 카드(핀 · 검색 · ?place= 링크). 같은 칩에 있는 동안 추천 effect 가 다시 돌아도 이 카드를
  // 바꾸지 않는다(시설 목록 갱신 · 조건 변경 때 카드가 손 밑에서 바뀌지 않게). kind 가 search·place 면 목록에
  // 있어도 머리 배지는 '선택한 장소' 다(교차 레인 계약 2).
  const userPickRef = useRef<{ id: string; filter: string; kind: 'pin' | 'search' | 'place' } | null>(null);
  // 밤의 첫 화면(계획 B2 잔여 항목) — 처음 열린 칩에 지금 추천할 곳이 없으면 한 번만 다른 칩으로 옮긴다.
  // 사용자가 칩·테마·음식 칩을 직접 고르면 꺼진다.
  const firstViewPendingRef = useRef(true);
  // /main?place=<id> — 시설 목록이 오면 그 장소를 카드로 연다.
  const pendingPlaceRef = useRef<string | null>(null);
  // /main?focus=forecast|voice — 소개 화면 바로가기로 들어왔을 때 그 기능에 고리를 둘러 찾기 쉽게(교차 레인 계약 1).
  const [focusRing, setFocusRing] = useState<'forecast' | 'voice' | null>(null);
  // 휴대폰: 음성 비서를 켜면 카드를 미리보기로 접는다(자막이 카드 위에 뜬다).
  const [peekRequest, setPeekRequest] = useState(0);
  const isPhone = usePhoneViewport();
  // 추정 모드 피드(GET /congestion/estimates) — {facilityId: 원본 추정}. 시설 목록과 **따로** 둔다.
  // 시설은 API·Supabase 폴백·24시간 localStorage 캐시 중 어느 경로로도 그려질 수 있는데, 추정은
  // 60분이면 만료되는 '지금' 값이라 그 어느 저장소에도 섞으면 안 된다. 그릴 때 덧씌운다.
  const [estimateById, setEstimateById] = useState<Record<string, unknown>>({});
  // 마지막으로 피드를 확인한 시각. 5분마다 바뀌어 지도 파생값을 다시 계산하게 한다 — 그래야
  // 오래 열어 둔 탭에서 60분 지난 점선 핀이 남지 않는다(값이 안 바뀌어도 만료는 다시 판정한다).
  const [estimateClock, setEstimateClock] = useState(() => Date.now());
  // 지금 이 일대(경주 시내) 추정 혼잡 — 추정 피드 값들의 가운데값. 칠한 핀이 없을 때 시간 줄이 칩 하나로 말한다(계획 B3).
  const areaNowLevel = useMemo(() => {
    const at = new Date(estimateClock);
    const levels = Object.values(estimateById)
      .map((raw) => parseCongestionEstimate(raw, at)?.level)
      .filter((level): level is number => typeof level === 'number')
      .sort((a, b) => a - b);
    if (levels.length === 0) return null;
    const mid = Math.floor(levels.length / 2);
    return levels.length % 2 ? levels[mid] : (levels[mid - 1] + levels[mid]) / 2;
  }, [estimateById, estimateClock]);
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
  const [mapViewportVersion, setMapViewportVersion] = useState(0);
  const [isMockLocationMinimized, setIsMockLocationMinimized] = useState(true);
  const [isMockTimeMinimized, setIsMockTimeMinimized] = useState(true);
  const [mockHour, setMockHour] = useState<number | null>(null);
  // 데모 '가정 시각' 프리셋 — /waiting·/course 와 localStorage 한 키로 공유하고 이벤트로 동기화한다.
  // mockHour(클라 전용 합성 혼잡 시뮬)와 별개다: 이 값은 백엔드 recommend 로 실려 도착 영업여부·
  // 도착시점 혼잡·채점을 그 시각 기준으로 계산하게 한다. 초기값 'now'(정적 export 안전).
  const [assumedPreset, setAssumedPreset] = useState<string>("now");
  useEffect(() => {
    setAssumedPreset(getStoredAssumedPreset());
    const sync = () => setAssumedPreset(getStoredAssumedPreset());
    window.addEventListener(ASSUMED_TIME_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(ASSUMED_TIME_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [outOfRegionNotice, setOutOfRegionNotice] = useState(false);
  const [travelContext, setTravelContext] = useState<TravelContext>(EMPTY_TRAVEL_CONTEXT);
  const [showMobileTools, setShowMobileTools] = useState(false);
  const [showDiscoveryThemes, setShowDiscoveryThemes] = useState(false);
  const [activeDiscovery, setActiveDiscovery] = useState<{
    themeId: DiscoveryThemeId;
    anchorId: string;
    anchorName: string;
  } | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);

  // 히트맵 레이어 on/off — 혼잡 핀과 별개의 열지도 오버레이(CongestionMap 에서 이식). 기본 꺼짐.
  const [showHeatmap, setShowHeatmap] = useState(false);
  // ♿ 무장애 필터는 공통 여행 조건과 단일화한다. 명시적으로 검증된 시설만 후보와 지도에 남긴다.
  const showBarrierFree = travelContext.requiredAttributes.includes('accessible');
  const toggleBarrierFree = () => {
    const requiredAttributes = showBarrierFree
      ? travelContext.requiredAttributes.filter((attribute) => attribute !== 'accessible')
      : [...new Set([...travelContext.requiredAttributes, 'accessible' as const])];
    const next = { ...travelContext, requiredAttributes };
    setTravelContext(next);
    saveTravelContext(next);
    track('context_applied', {
      categories: next.categories,
      max_walk_minutes: next.maxWalkMinutes ?? null,
      available_minutes: next.availableMinutes ?? null,
      required_attributes: next.requiredAttributes,
      exclude_visited: next.excludeVisited,
    });
  };
  // 🅿 주차 가능 필터 on/off — 켜지면 features.parking 이 '가능'으로 파싱되는 시설만 마커·히트맵에 표시.
  // 🐾 반려동물 동반 필터 on/off — 켜지면 features.chk_pet 이 '가능'으로 파싱되는 시설만. 둘 다 배리어프리와 동일 패턴(AND 조합 가능).
  const [showParkingFilter, setShowParkingFilter] = useState(false);
  const [showPetFilter, setShowPetFilter] = useState(false);
  // '🔮 혼잡 예측' 시간 줄(계획 B3) — 지금 · +1 · +2 · +3시간. 이 화면의 상태로만 산다(저장·공유하지 않는다 —
  // lib/forecastStrip.ts 머리말). cardHours 는 고른 칸(받는 중 포함): 카드는 고르는 즉시 그 시각 기준으로 다시 고른다.
  const [strip, dispatchStrip] = useReducer(stripReducer, STRIP_NOW);
  const cardHours = stripHours(strip);
  const stripForecast = strip.status === 'forecast' ? strip.forecast : null;
  const forecastMode = stripForecast !== null;
  // 휴대폰 카드가 미리보기인가(펼치면 시간 줄을 감춘다 — 펼친 카드가 검색창 아래까지 올라온다).
  const [cardPeek, setCardPeek] = useState(true);
  // 지도에 등급이 칠해진 핀 수(마커 effect 가 센다) — 범례를 보일지 정한다.
  const [gradedPinCount, setGradedPinCount] = useState(0);
  // 창 폭 — 데스크톱 추천 패널이 가리는 폭(시간 줄 자리 · 지도 띠)을 다시 잰다.
  const [viewportWidth, setViewportWidth] = useState(0);
  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

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
  const { locale, t } = useI18n();
  // '혼잡' 등급 경계 — 운영자 설정(GET /system/public-settings). 못 받으면 0.75(기존 값).
  const busyAt = useBusyThreshold();
  const [currentClock, setCurrentClock] = useState<Date | null>(null);

  // ── 3-a/3-b 재계산 피드백 ───────────────────────────────────────────────────
  // 🕒 시간대 셀렉트와 ✨ 테마 칩은 예전에도 추천을 다시 요청하고 있었지만, 화면이 아무 말도
  // 하지 않아 '눌러도 아무 일 없는 버튼'으로 보였다. 이제 누르는 즉시 카드 자리에 스켈레톤을
  // 깔고(= 1초 안에 눈에 보이는 변화), 결과가 도착하면 카드가 다시 나타나며 토스트로 무엇을
  // 기준으로 다시 계산했는지 말한다. 결과가 같아도 그 사실("이 시간대에도 같은 추천이 유효해요")
  // 을 말한다 — 침묵은 고장과 구분되지 않는다.
  const [recalcLabel, setRecalcLabel] = useState<string | null>(null);
  const recalcRef = useRef<{ label: string; prevTopId: string | null; startedAt: number } | null>(null);
  const recalcTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startRecalc = (label: string, prevTopId: string | null) => {
    if (recalcTimerRef.current) {
      clearTimeout(recalcTimerRef.current);
      recalcTimerRef.current = null;
    }
    recalcRef.current = { label, prevTopId, startedAt: recalcClockMs() };
    setRecalcLabel(label);
  };

  // 스켈레톤을 걷고 토스트를 띄운다. 너무 빨리 끝나면(캐시 히트) 깜빡임만 남으므로
  // 최소 420ms 는 보여 준다 — '눌렀다 → 다시 계산했다'가 한 동작으로 읽히게.
  const finishRecalc = (topId: string | null) => {
    const pending = recalcRef.current;
    if (!pending) return;
    recalcRef.current = null;
    const same = pending.prevTopId !== null && topId !== null && String(topId) === String(pending.prevTopId);
    const delay = Math.max(0, 420 - (recalcClockMs() - pending.startedAt));
    if (recalcTimerRef.current) clearTimeout(recalcTimerRef.current);
    recalcTimerRef.current = setTimeout(() => {
      recalcTimerRef.current = null;
      setRecalcLabel(null);
      showToast(same ? t('assume.sameResult') : t('assume.recalculated', { label: pending.label }));
    }, delay);
  };

  // 스켈레톤만 걷고 **아무 말도 하지 않는다**. 결과를 받지 못한 채 끝내는 경로라
  // '같은 추천이 유효해요'/'다시 계산했어요'를 말할 자격이 없다 — 둘 다 응답을 비교해야 나오는 문장이다.
  // recalcRef 가 이미 비어 있어도 끝까지 간다 — finishRecalc 가 토스트를 예약해 둔 420ms 사이에 불리면
  // 그 예약도 함께 걷어야 한다(주차장 분기처럼 결과를 보여 주지 않는 화면에서 '다시 계산했어요'가 뜨지 않게).
  const abandonRecalc = () => {
    recalcRef.current = null;
    if (recalcTimerRef.current) {
      clearTimeout(recalcTimerRef.current);
      recalcTimerRef.current = null;
    }
    setRecalcLabel(null);
  };

  // 비상 종료 — 재계산이 스스로 끝났다고 말하지 않는 경로(effect 조기 반환 등)를 대비해
  // 스켈레톤을 영원히 띄워 두지 않는다. 심사 화면에서 '멈춘 로딩'은 죽은 버튼보다 나쁘다.
  // 시한은 추천 요청 타임아웃 뒤(RECALC_EMERGENCY_MS) — 그 전에는 아직 응답이 오는 중이다.
  useEffect(() => {
    if (!recalcLabel) return;
    const timer = setTimeout(abandonRecalc, RECALC_EMERGENCY_MS);
    return () => clearTimeout(timer);
  }, [recalcLabel]);

  useEffect(() => () => {
    if (recalcTimerRef.current) clearTimeout(recalcTimerRef.current);
  }, []);

  // 영업 여부와 도착 시각을 판단하는 기준과 맞춰 경주 현지 시각(KST)을 보여준다.
  // 최초 SSR에는 렌더하지 않아 하이드레이션 차이를 막고, 이후 30초마다 분 경계를 갱신한다.
  useEffect(() => {
    const updateClock = () => setCurrentClock(new Date());
    updateClock();
    const timer = window.setInterval(updateClock, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const clockLabels = useMemo(() => {
    if (!currentClock) return null;
    const localeCode = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', zh: 'zh-CN' }[locale];
    const options = { timeZone: 'Asia/Seoul' } as const;
    return {
      date: new Intl.DateTimeFormat(localeCode, {
        ...options,
        month: 'long',
        day: 'numeric',
        weekday: 'long',
      }).format(currentClock),
      time: new Intl.DateTimeFormat(localeCode, {
        ...options,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(currentClock),
    };
  }, [currentClock, locale]);

  // 지도 검색바 음성 받아쓰기(STT) — 마이크 탭 → 한 발화를 검색어로 넣어 기존 마커 필터(searchQuery)를 그대로 재사용.
  // 미지원 브라우저면 supported=false → 마이크는 아래에서 '준비 중' 비활성으로 유지(정적 export/SSR 안전).
  // 인식 실패 시 무음으로 꺼지지 않도록 토스트로 안내(권한 거부/그 외 실패를 구분).
  const speechSearch = useSpeechSearch(
    (text) => setSearchQuery(text),
    (kind) => showToast(kind === 'denied' ? t('map.sttMicDenied') : t('map.sttFailed')),
    // 화면 언어로 받아쓰고(I21), 검색 마이크를 켜면 음성 비서를 끈다 — 두 마이크가 동시에 듣지 않게(I84).
    { lang: speechLangFor(locale), onStart: () => voiceRef.current?.stop() },
  );
  const speechSearchRef = useRef(speechSearch);
  speechSearchRef.current = speechSearch;

  // (Kakao SDK 스크립트는 app/layout.tsx 가 전역으로 로드한다 — 이 페이지가 직접 주입하던
  //  시절의 appKey 지역변수는 그 배선이 layout 으로 옮겨간 뒤 쓰이지 않아 제거했다.)

  // Load facilities from Supabase
  useEffect(() => {
    async function loadFacilities() {
      setIsLoadingFacilities(true);
      setFacilitiesLoadError(false);
      const cached = loadFacilityCache();
      if (cached?.length) {
        setFacilities(cached);
        setIsLoadingFacilities(false);
      }

      // 1순위: 백엔드 /infrastructures — 시설별 '최신' 혼잡을 서버가 결정적으로 조인(시설별 limit-1)해 내려준다.
      //   기존 supabase 경로(최근 3000행을 받아 클라이언트 dedup)는 로그가 잦은 시설이 캡을 채우면
      //   다른 시설이 congestion=null 로 조용히 누락되는 문제가 있었다 → 서버 조인이 이를 해소하고 전송량도 줄인다.
      try {
        // 백엔드 응답을 기다리는 상한. 넘기면 아래 Supabase 직접 읽기로 폴백한다.
        //
        // 2.5초였는데 실측 응답이 2.4~3.5초라 **평소에도 폴백이 이겼다.** 그 폴백에는 바로 위
        // 주석이 적어 둔 결함이 있다 — 로그가 잦은 시설이 캡을 채우면 다른 시설이
        // congestion=null 로 조용히 누락된다. 즉 정확도가 낮은 경로로 상시 돌고 있었다.
        //
        // 4초로 올린다. 재방문에는 위 캐시가 이미 그려져 있어 체감 지연은 첫 방문에만 생기고,
        // 대신 시설별 최신 혼잡을 서버가 결정적으로 조인한 정확한 값을 받는다.
        const items = await apiClient.get("/api/v1/infrastructures", {
          timeoutMs: 4000,
          params: {
            minLat: String(REGION.bounds.minLat),
            maxLat: String(REGION.bounds.maxLat),
            minLng: String(REGION.bounds.minLng),
            maxLng: String(REGION.bounds.maxLng),
          },
        });
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
            galleryImages: Array.isArray(f.galleryImages) ? f.galleryImages : null, // detailImage2 — 카드 사진 폴백용
            address: f.address ?? null,
            phone: f.phone ?? null,
            homepage: f.homepage ?? null,
            overview: f.overview ?? null,
            barrierFree: f.barrierFree ?? null,
            // TourAPI 식별자 — 밑줄이 없어 keysToCamel 이 그대로 통과시킨다(contentid/contenttypeid).
            contentid: f.contentid ?? null,
            contenttypeid: f.contenttypeid ?? null,
            availabilityEvidence: f.availabilityEvidence ?? null,
            baseCongestion: level,
            congestionLevel: level,
            currentCount: f.congestion ? f.congestion.currentCount : null,
            lastUpdated: f.congestion ? f.congestion.timestamp : null,
            // 신선도 정직화(계약 5): 혼잡 출처(user_report 등)와 24h 초과 여부를 카드로 전달.
            source: f.congestion ? (f.congestion.source ?? null) : null,
            isStale: f.congestion ? !!f.congestion.isStale : false,
            // 서버가 '지금' 이라고 판정한 관측만 추정을 이긴다. 필드가 없는 구 서버 응답은
            // undefined 로 남아 종전 동작(실측이 이긴다) 그대로다 — 값을 지어내지 않는다.
            congestionIsCurrent: f.congestion ? f.congestion.isCurrent ?? undefined : undefined,
          };
        });
        setFacilities(mapped);
        saveFacilityCache(mapped);
        setIsLoadingFacilities(false);
        return;
      } catch (apiErr) {
        // 백엔드 미기동/네트워크 실패 → anon supabase 직접 조회로 폴백(회귀 없이 지도 렌더 유지).
        console.warn("시설 로드(백엔드 /infrastructures) 실패 — supabase 폴백:", apiErr);
      }

      // 2순위 폴백: anon supabase 직접 조회 — 활성 시설만 id 순서 페이지로, 혼잡은 서버와 같은
      // 시설별 최신 RPC(lib/mapFacilityFallback.ts). 시설 조회 실패는 throw → 아래 catch 가 안내한다.
      // RPC 만 실패하면 지도는 그대로 그리고 혼잡만 '데이터 없음' 으로 둔다.
      try {
        const { rows, latestBy } = await loadMapFacilitiesFromSupabase(supabase, REGION.bounds);

        const mapped = rows.map((f: any) => {
          const latestLog = latestBy[f.id];
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
            // detailImage2 — 카드 사진 폴백용. API 의 _clean_gallery_images 처럼 빈 문자열을 걸러 내고, 비면 null.
            galleryImages: cleanGalleryImages(f.gallery_images),
            address: f.address ?? null,
            phone: f.phone ?? null,
            homepage: f.homepage ?? null,
            overview: f.overview ?? null,
            barrierFree: f.barrier_free ?? null,
            // TourAPI 식별자(컬럼명에 밑줄 없음) — API 경로와 동일 필드 집합 유지.
            contentid: f.contentid ?? null,
            contenttypeid: f.contenttypeid ?? null,
            baseCongestion: baseCongestion,
            congestionLevel: baseCongestion,
            // 방문객·사장 정성 제보의 capacity 환산값을 실제 인원으로 노출하지 않는다.
            currentCount: latestLog?.source === 'traffic_cctv' ? latestLog.current_count : null,
            lastUpdated: latestLog ? latestLog.timestamp : null,
            source: latestLog?.source ?? null,
            isStale: latestLog
              ? Date.now() - new Date(latestLog.timestamp).getTime() > 24 * 60 * 60 * 1000
              : false,
            // 이 경로에는 서버 판정이 없다(Supabase 직접 읽기). 그대로 두면 undefined 가 되어
            // **가장 흔한 프로덕션 경로에서만** 낡은 실측이 계속 신선한 추정을 가린다.
            // 그래서 백엔드 규칙의 미러로 여기서 한 번 판정한다(패리티 테스트가 잠근다).
            // 위 쿼리가 이미 evidence_tier 를 받아 오고 있었는데 쓰이지 않고 있었다.
            congestionIsCurrent: latestLog
              ? measurementIsCurrentFallback(latestLog.evidence_tier, latestLog.timestamp)
              : undefined,
          };
        });

        setFacilities(mapped);
        saveFacilityCache(mapped);
        setIsLoadingFacilities(false);
      } catch (err) {
        console.warn("Error loading facilities:", err);
        setFacilitiesLoadError(!cached?.length);
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

  // 추정 피드 — 시설 로드와 병렬로, 보이는 동안 5분마다 다시 받는다(서버 추정 캐시 5분·스냅샷 10분).
  // 실패·404(구 서버)·타임아웃은 조용히 넘긴다: 추정은 부가 정보라 지도를 막을 이유가 없고,
  // 직전 값은 남겨 두되 60분 만료는 그릴 때 다시 판정하므로 낡은 값이 '지금' 으로 팔리지 않는다.
  useEffect(() => {
    let active = true;
    let inflight: AbortController | null = null;
    const load = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      try {
        const feed = await getCongestionEstimates({ timeoutMs: 8000, signal: controller.signal });
        if (active) setEstimateById(estimatesFromFeed(feed));
      } catch {
        // 404(구 서버)·타임아웃·네트워크 — '추정 없음' 과 같다. 직전 값은 만료 판정에 맡긴다.
      } finally {
        if (active && inflight === controller) setEstimateClock(Date.now());
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 5 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      inflight?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
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
  // 검색 effect 처럼 목록을 dep 으로 두면 안 되는 곳이 지금 목록을 읽는다(목록이 바뀔 때마다 외부 검색을 다시 부르지 않게).
  const rankedFacilitiesRef = useRef<any[]>(rankedFacilities);
  rankedFacilitiesRef.current = rankedFacilities;
  const [noRecommendation, setNoRecommendation] = useState(false); // 현재 카테고리 추천 후보 0건 여부(빈 상태 안내용)
  // 후보 소진의 원인이 '남은 곳 전부 오늘 휴무'일 때 true — 빈 상태 문구를 구분(데이터 부족/엔진 실패로 오해 방지).
  const [noOpenTodayOnly, setNoOpenTodayOnly] = useState(false);
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  // 거절/저장은 추천 effect 를 다시 돌리지 않는다(그 effect 의 dep 주석 참조 — 점수/순위 리셋 방지).
  // 그래서 이미 나가 있던 요청은 '사용자가 방금 치운 곳' 을 모르는 채 계산된 목록을 들고 돌아온다.
  // 응답을 화면에 쓰기 전에 '요청이 나간 뒤 생긴 판단' 만 걷어내야 방금 누른 '관심 없음'·'저장'이
  // 되살아나지 않는다(추천 effect 의 dismissedSinceRequest). effect 클로저의 state 는 요청 시점에
  // 멈춰 있으므로, '지금 이 순간'의 값은 ref 로 따로 들고 다닌다.
  const rejectedIdsRef = useRef(rejectedIds);
  const savedIdsRef = useRef(savedIds);
  useEffect(() => { rejectedIdsRef.current = rejectedIds; }, [rejectedIds]);
  useEffect(() => { savedIdsRef.current = savedIds; }, [savedIds]);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number }>({ ...REGION.center });
  const [preferredCategories, setPreferredCategories] = useState<string[]>([]);

  // 의도 선반영 프리페치 — 심사위원이 /main 에 머무는 동안 대기 보드·분산 코스 요청을 미리 발사해
  // 서버 응답 캐시(단일비행)를 데운다. 메인 스레드가 한가해진 뒤(requestIdleCallback, 폴백 4s)
  // 한 번만 발사 — 이후 탭 진입 첫 요청이 캐시 히트로 즉시 뜬다. 실패는 전부 조용히 무시된다.
  useEffect(() => {
    let cancelled = false;
    let idleId: number | undefined;
    const fire = () => { if (!cancelled) prefetchDemoHotPaths(); };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const timer = setTimeout(() => {
      if (typeof w.requestIdleCallback === 'function') {
        idleId = w.requestIdleCallback(fire, { timeout: 3000 });
      } else {
        fire();
      }
    }, 4000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (idleId !== undefined && typeof w.cancelIdleCallback === 'function') w.cancelIdleCallback(idleId);
    };
  }, []);

  // 현재 살아 있는 SPOT 순위 Top 3를 1위와 비교한다. UI용 역할을 강제 배정하지 않고
  // 관광객이 체감하는 차이(취향 일치·도보 분·줄과 붐빔 전망·실제 쿠폰)만 문장으로 만든다.
  const spotComparisonById = useMemo(() => {
    const top = rankedFacilities
      .filter((facility) => !rejectedIds.has(facility.id) && !savedIds.has(facility.id))
      .slice(0, 3);
    const comparisons = buildSpotComparisons(top.map((facility, index) => {
      const spot = facility.spot as Spot | undefined;
      return {
        id: String(facility.id),
        rank: index + 1,
        preference: (spot?.preferencePercent ?? 0) / 100,
        travelMinutes: spot?.expectedTravel ?? 1,
        // 줄·붐빔 비교는 같은 종류의 근거끼리만 한다(lib/spotComparison.ts) — 근거 종류를 함께 넘긴다.
        scoringMode: spot?.scoringMode ?? facility.scoringMode,
        rankingWaitMinutes: spot?.rankingWaitTime,
        areaDemandPenaltyMinutes: spot?.areaDemandPenaltyMinutes,
        areaDemandParkingEvidence: spot?.areaDemandParkingEvidence,
        areaDemandTourismEvidence: spot?.areaDemandTourismEvidence,
        couponRate: facility.couponRate,
      };
    }));
    return new Map(comparisons.map((comparison) => [
      comparison.id,
      { rank: comparison.rank, text: formatSpotComparison(t, comparison) },
    ]));
  }, [rankedFacilities, rejectedIds, savedIds, t]);

  // 지도 핀의 순위(서버 상위 추천 1~5위, 관심 없음·저장 제외) — 금색 고리 + 숫자(계획 B3).
  const pinRankById = useMemo(() => {
    const ranks = new Map<string, number>();
    (rankedFacilities as Facility[])
      .filter((f) => !rejectedIds.has(f.id) && !savedIds.has(f.id))
      .slice(0, 5)
      .forEach((f, index) => ranks.set(String(f.id), index + 1));
    return ranks;
  }, [rankedFacilities, rejectedIds, savedIds]);

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
            // 도보 N분이 어디서 잰 값인지 모르면 '내 위치' 의 거리로 읽힌다 — 세션에 한 번만 알린다.
            let noticed = false;
            try {
              noticed = sessionStorage.getItem(OUT_OF_REGION_NOTICE_KEY) === '1';
              sessionStorage.setItem(OUT_OF_REGION_NOTICE_KEY, '1');
            } catch { /* 저장소 차단 — 이번 한 번은 알린다 */ }
            if (!noticed) setOutOfRegionNotice(true);
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

  // 경주 밖 안내 — 위치 콜백은 마운트 때의 t(첫 렌더는 늘 ko)를 쥐고 있어 거기서 문장을 만들면 en 화면에
  // 한국어가 뜬다. 여기서 지금 로케일로 만들고, 토스트가 떠 있는 동안 언어가 바뀌면 그 언어로 다시 띄운다.
  useEffect(() => {
    if (!outOfRegionNotice) return;
    showToast(t('map.outOfRegionStart'));
    const timer = setTimeout(() => setOutOfRegionNotice(false), 3000);
    return () => clearTimeout(timer);
  }, [outOfRegionNotice, t]);

  // 주차장 탭은 장소 DB가 아니라 경주시 ITS의 공식 위치·실시간 잔여면을 직접 사용한다.
  useEffect(() => {
    if (activeFilter !== '주차장') return;
    let active = true;
    setParkingLoading(true);
    setParkingLoadError(false);
    apiClient.get('/api/v1/area-demand/parking-lots', {
      params: {
        lat: String(userLocation.lat),
        lng: String(userLocation.lng),
        radiusM: '5000',
      },
      timeoutMs: 6000,
    }).then((response) => {
      if (!active) return;
      const lots = Array.isArray(response?.lots) ? response.lots : [];
      const mapped = lots.map((lot: any) => ({
        id: String(lot.id ?? ''),
        name: String(lot.name ?? ''),
        type: 'parking' as const,
        latitude: Number(lot.latitude),
        longitude: Number(lot.longitude),
        distanceM: Number(lot.distanceM ?? 0),
        totalSpaces: typeof lot.totalSpaces === 'number' ? lot.totalSpaces : null,
        availableSpaces: typeof lot.availableSpaces === 'number' ? lot.availableSpaces : null,
        occupancy: typeof lot.occupancy === 'number' ? lot.occupancy : null,
        live: lot.live === true,
        observedAt: lot.observedAt ?? null,
        source: lot.source ?? null,
        capacity: typeof lot.totalSpaces === 'number' ? lot.totalSpaces : 0,
        congestionLevel: typeof lot.occupancy === 'number' ? lot.occupancy : null,
        features: { officialParking: true },
      })).filter((lot: ParkingLot) => lot.id && lot.name && Number.isFinite(lot.latitude) && Number.isFinite(lot.longitude));
      setParkingLots(mapped);
      setSelectedParkingLot((current) => current
        ? mapped.find((lot: ParkingLot) => lot.id === current.id) ?? mapped[0] ?? null
        : mapped[0] ?? null);
    }).catch((error) => {
      console.warn('공식 주차장 조회 실패:', error);
      if (active) {
        setParkingLots([]);
        setSelectedParkingLot(null);
        setParkingLoadError(true);
      }
    }).finally(() => {
      if (active) setParkingLoading(false);
    });
    return () => { active = false; };
  }, [activeFilter, userLocation.lat, userLocation.lng, parkingReloadNonce]);

  // 🔥 히트맵용 공영주차 실측 — 경주시 ITS 실시간 잔여면(GET /area-demand/parking-lots, 공개 GET).
  // 시설 실측 로그는 드물어 열지도가 '점 몇 개'로만 보였는데, 공영주차 점유율은 도심 전역에
  // 흩어진 **실측** 좌표라 같은 정직성 기준을 지키면서 구역을 칠할 수 있다(주차장 탭이 이미 쓰는 자료).
  // 토글을 처음 켤 때 한 번만 받는다 — 꺼져 있으면 호출하지 않는다.
  useEffect(() => {
    if (!showHeatmap || heatParkingAskedRef.current) return;
    // 이 플래그는 '이미 받았다'가 아니라 **중복 호출을 막는 잠금**이다. 받지 못한 채로 잠가 두면
    // 첫 호출이 실패하거나 응답 전에 토글이 꺼졌을 때 주차 레이어가 세션 내내 되살아나지 못한다.
    heatParkingAskedRef.current = true;
    let active = true;
    let applied = false;
    apiClient.get('/api/v1/area-demand/parking-lots', {
      params: { lat: String(userLocation.lat), lng: String(userLocation.lng), radiusM: '6000' },
      timeoutMs: 6000,
    }).then((response) => {
      if (!active) return;
      const lots = Array.isArray(response?.lots) ? response.lots : [];
      setHeatParkingLots(lots
        .filter((lot: ParkingLot) => typeof lot?.occupancy === 'number'
          && Number.isFinite(Number(lot?.latitude)) && Number.isFinite(Number(lot?.longitude)))
        .map((lot: ParkingLot) => ({ ...lot, latitude: Number(lot.latitude), longitude: Number(lot.longitude) })));
      applied = true;
    }).catch(() => {
      // 열지도는 부가 레이어다 — 실패하면 시설 실측만으로 그린다(조용히).
      // 다만 잠금은 푼다: 다음에 토글을 다시 켜면 한 번 더 시도한다. 이 effect 가 이미 정리됐다면
      // (토글을 껐다 켜서 새 요청이 나간 뒤) 그 잠금은 새 요청의 것이라 건드리지 않는다.
      if (active) heatParkingAskedRef.current = false;
    });
    return () => {
      active = false;
      // 응답을 화면에 반영하지 못한 채 토글이 꺼졌다 — 잠금을 풀어 다시 켰을 때 재시도되게 한다.
      if (!applied) heatParkingAskedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHeatmap]);

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
        const localList = loadSavedLocal();
        setSavedIds(new Set<string>(localList.map((item) => item.id)));
      } catch (e) {
        console.warn("Failed to load saved IDs from localStorage:", e);
      }
      // 로그인 사용자면 Supabase 저장 목록과 동기화해 savedIds 갱신(기기 변경 시 복원).
      void syncSaved()
        .then((list) => setSavedIds(new Set<string>(list.map((item) => item.id))))
        .catch(() => {});


      try {
        const rejected = sessionStorage.getItem('nextspot_rejected_ids');
        if (rejected) {
          setRejectedIds(new Set(JSON.parse(rejected)));
        }
      } catch (e) {
        console.warn("Failed to load rejected IDs from sessionStorage:", e);
      }

      // 온보딩 조건과 첫 칩 — 저장된 첫 카테고리, 이번 세션에 고른 칩이 있으면 그 칩(밤의 첫 화면 자동 전환은 하지 않는다).
      const storedContext = loadTravelContext();
      setTravelContext(storedContext);
      const firstCategory = storedContext.categories[0];
      let initialFilter: string = firstCategory
        ? ({ restaurant: '음식점', cafe: '카페', attraction: '관광지', culture: '문화시설' } as const)[firstCategory]
        : '음식점';
      try {
        const savedFilter = sessionStorage.getItem('nextspot_active_filter');
        if (savedFilter) {
          initialFilter = savedFilter;
          firstViewPendingRef.current = false;
        }
      } catch (e) {
        console.warn("Failed to load active filter from sessionStorage:", e);
      }
      setActiveFilter(initialFilter);
    }
  }, []);

  // 온보딩(setup)에서 고른 음식 선호를 '음식 의도' 기본값으로 로드(음성 발화가 있으면 그쪽이 덮어씀).
  //
  // 예전에는 저장 형태를 여기서 직접 파싱해 v1 의 `food` 필드를 읽었다. v2 재작성 뒤 그 필드가
  // 사라져 이 기본값이 통째로 죽어 있었고(온보딩에서 음식을 물어보지도 않았다), 그래서 온보딩만
  // 마친 사용자는 음식 의도 없이 추천을 받았다. 질문과 필드를 되살리면서 매핑도 저장 형태를
  // 아는 모듈(lib/travelContext)로 옮겼다 — v1·v2 판단이 한 곳에만 있게 된다.
  useEffect(() => {
    const { cuisine } = loadTravelContext();
    if (cuisine) cuisineIntentRef.current = CUISINE_INTENT[cuisine];
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

  const activateDiscoveryTheme = (theme: DiscoveryTheme) => {
    const anchor = findDiscoveryAnchor(expandGroups(facilities), theme);
    if (!anchor) {
      showToast(t('discovery.noAnchor'));
      return;
    }
    // 칩을 누른 즉시 카드 자리에 스켈레톤 — 결과가 와야만 뭔가 바뀌면 그 사이 몇 초는 '죽은 칩'이다.
    startRecalc(t(`discovery.theme.${theme.id}`), selectedFacility?.id != null ? String(selectedFacility.id) : null);
    firstViewPendingRef.current = false;
    userPickRef.current = null;
    recommendationAbortRef.current?.abort();
    applyVoiceFilter(null);
    setCuisineChip(null);
    cuisineIntentRef.current = theme.preferenceIntent;
    setActiveGroupId(null);
    setSelectedParkingLot(null);
    setActiveFilter(theme.filterId);
    setActiveDiscovery({ themeId: theme.id, anchorId: anchor.id, anchorName: anchor.name });
    setDiscoveryLoading(true);
    setRankedFacilities([]);
    setSelectedFacility(null);
    setNoRecommendation(false);
    setShowDiscoveryThemes(false);
    try {
      sessionStorage.setItem('nextspot_active_filter', theme.filterId);
    } catch { /* storage unavailable */ }
    track('gyeongju_theme_selected', {
      theme_id: theme.id,
      reference_facility_id: anchor.id,
      candidate_type: theme.candidateType,
    });
  };

  const clearDiscoveryTheme = () => {
    recommendationAbortRef.current?.abort();
    setActiveDiscovery(null);
    setDiscoveryLoading(false);
    cuisineIntentRef.current = null;
    setRankedFacilities([]);
    setSelectedFacility(null);
    setNoRecommendation(false);
  };

  // 지도에서 실제로 보이는 띠(계획 B3 · lib/map/visibleBand.ts) — 위는 검색 줄·칩 줄(데스크톱은 툴바), 오른쪽은 데스크톱
  // 추천 패널, 아래는 혼잡 예측 줄과(휴대폰) 카드 미리보기·하단 탭. 카드 패널 폭은 카드가 뜨기 전이어도 곧 그 자리를
  // 차지하므로 처음부터 비워 둔다. 고른 핀·첫 화면의 내 위치는 이 띠의 가운데로 간다.
  const mapInsets = (): BandInsets => {
    const container = mapContainerRef.current;
    if (!container || typeof window === 'undefined') return { top: 0, right: 0, bottom: 0, left: 0 };
    const box = container.getBoundingClientRect();
    const bottomOf = (el: Element | null | undefined) => {
      const r = el?.getBoundingClientRect();
      return r && r.height > 0 ? r.bottom : null;
    };
    const topOf = (el: Element | null | undefined) => {
      const r = el?.getBoundingClientRect();
      return r && r.height > 0 ? r.top : null;
    };
    const headerBottom = Math.max(box.top, bottomOf(searchRowRef.current) ?? box.top, bottomOf(chipColumnRef.current) ?? box.top);
    const phone = window.innerWidth < 768;
    let bottomEdge = box.bottom;
    const stripTop = topOf(stripRef.current);
    if (stripTop !== null) bottomEdge = Math.min(bottomEdge, stripTop);
    if (phone) {
      const nav = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tourist-nav-clearance')) || 0;
      bottomEdge = Math.min(bottomEdge, box.bottom - nav);
      const panelTop = topOf(recPanelEl);
      if (panelTop !== null) bottomEdge = Math.min(bottomEdge, panelTop);
    }
    return {
      top: Math.max(0, headerBottom - box.top + 8),
      right: desktopPanelReservePx(),
      bottom: Math.max(0, box.bottom - bottomEdge + 8),
      left: 0,
    };
  };

  // 지도 중심을 그 띠의 가운데로 맞춘다 — 첫 진입·위치 이동. 투영이 실패해도 지도는 반드시 그 자리로 간다.
  const centerOnFreeArea = (lat: number, lng: number) => {
    const map = mapInstanceRef.current;
    if (!map || typeof window === 'undefined' || !window.kakao) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const latlng = new window.kakao.maps.LatLng(lat, lng);
    try {
      map.setCenter(latlng);
      const proj = map.getProjection();
      const pt = proj.containerPointFromCoords(latlng);
      const container = mapContainerRef.current;
      const target = centerTargetFor(pt, container?.clientWidth ?? 0, container?.clientHeight ?? 0, mapInsets());
      map.setCenter(proj.coordsFromContainerPoint(new window.kakao.maps.Point(target.x, target.y)));
    } catch {
      map.setCenter(latlng); // 투영 실패 — 무보정 중심이라도 반드시 이동한다
    }
  };

  // 고른 장소를 보이는 띠의 가운데로 옮긴다(카드·톱바·예측 줄에 가리지 않게).
  const panToVisible = (lat: number, lng: number) => {
    const map = mapInstanceRef.current;
    if (!map || typeof window === 'undefined' || !window.kakao) return;
    // 위도만 가드하고 호출하는 곳이 많아, 여기서 경도까지 유한수 검증한다(LatLng(lat, undefined)=NaN 이동 방지).
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const latlng = new window.kakao.maps.LatLng(lat, lng);
    try {
      const proj = map.getProjection();
      const pt = proj.containerPointFromCoords(latlng);
      const container = mapContainerRef.current;
      const target = centerTargetFor(pt, container?.clientWidth ?? 0, container?.clientHeight ?? 0, mapInsets());
      map.panTo(proj.coordsFromContainerPoint(new window.kakao.maps.Point(target.x, target.y)));
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
    // 좌표가 없는 행사는 지도에 찍을 자리가 없다 — 조용히 넘어간다(카드 정보는 그대로 남는다).
    if (typeof ev.latitude !== 'number' || typeof ev.longitude !== 'number') return;
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
    const filterMap: Record<string, string> = { '음식점': 'restaurant', '카페': 'cafe', '관광지': 'attraction', '문화시설': 'culture', '주차장': 'parking' };
    const targetType = filterMap[activeFilter];
    const q = searchQuery.trim();
    const filtered = source.filter((f) => {
      if (!q) return f.type === targetType;
      return facilityMatchesSearch(f, q);
    });
    const scored = filtered.map(f => ({ ...f, spot: calculateSPOT(f) }));
    // 서버 상위 추천(순위 핀)을 먼저 — 밀집도 상한(7곳)과 간격 규칙에서 추천한 곳이 빠지지 않게(계획 B3).
    const rankOf = (f: Facility) => pinRankById.get(String(f.id)) ?? 99;
    scored.sort((a, b) => rankOf(a) - rankOf(b) || compareFacilities(a, b));
    const map = mapInstanceRef.current;
    if (!map || !window.kakao?.maps) return scored.slice(0, q ? 12 : 7);
    try {
      const bounds = map.getBounds();
      const projection = map.getProjection();
      const visible = scored.filter((facility) => bounds.contain(
        new window.kakao.maps.LatLng(facility.latitude, facility.longitude)
      ));
      // 같은 건물/필지의 점포를 서로 다른 정밀 위치인 것처럼 겹쳐 찍지 않는다. Kakao가 같은
      // 주소·거의 같은 좌표를 주는 멀티테넌트 점포는 한 핀으로 묶고 클릭 목록에서 선택한다.
      const buildingClusters: typeof visible[] = [];
      const normalizedAddress = (value: unknown) => String(value ?? '').replace(/\s+/g, '').trim();
      for (const facility of visible) {
        const address = normalizedAddress(facility.address);
        const cluster = buildingClusters.find((members) => {
          const anchor = members[0];
          const distanceM = haversineMeters(
            anchor.latitude, anchor.longitude, facility.latitude, facility.longitude,
          );
          // 행정동처럼 뭉뚱그린 주소가 같은 먼 관광지나 8m 이내의 옆 건물을 오묶지 않는다.
          return address.length >= 8
            && normalizedAddress(anchor.address) === address
            && distanceM <= 30;
        });
        if (cluster) cluster.push(facility);
        else buildingClusters.push([facility]);
      }
      const pinCandidates = buildingClusters.map((members) => {
        if (members.length === 1) return members[0];
        const levels = members.map((item) => item.congestionLevel)
          .filter((value): value is number => typeof value === 'number');
        // 핀에 칠할 값은 지금(24시간 안쪽) 잰 구성원 중 가장 붐비는 곳의 것 — 그 값의 관측 시각과 함께 싣는다.
        const paintNow = new Date();
        const painted = members
          .filter((item) => isPaintableMeasurement({ level: item.congestionLevel, observedAt: item.congestionTimestamp ?? item.lastUpdated, source: item.congestionSource ?? item.source }, paintNow))
          .sort((a, b) => (b.congestionLevel ?? 0) - (a.congestionLevel ?? 0))[0];
        const memberRanks = members.map((item) => pinRankById.get(String(item.id))).filter((rank): rank is number => typeof rank === 'number');
        return {
          ...members[0],
          id: `building:${members.map((item) => item.id).sort().join(',')}`,
          pinLevel: painted ? painted.congestionLevel : null,
          pinObservedAt: painted ? (painted.congestionTimestamp ?? painted.lastUpdated ?? null) : null,
          pinRank: memberRanks.length > 0 ? Math.min(...memberRanks) : null,
          name: t('map.placesInBuilding', { count: members.length }),
          // 평균점을 만들지 않고 출처가 있는 대표 레코드의 실제 좌표를 유지한다.
          latitude: members[0].latitude,
          longitude: members[0].longitude,
          congestionLevel: levels.length > 0 ? Math.max(...levels) : null,
          // 그룹에는 '지금' 판정을 싣지 않는다(undefined = 모름 → 종전 규칙: 실측이 이긴다).
          //
          // 위 congestionLevel 은 **여러 구성원의 최댓값**인데 ...members[0] 로 딸려 온 판정과
          // 관측 시각은 그중 한 곳의 것이다. 그대로 두면 A 가게의 시각을 B 가게의 값에 붙여
          // '마지막 관측 HH:MM' 을 그리게 된다 — 없는 관측을 만드는 것과 같다. 건물 묶음은
          // 지도 클러스터 개념이라 여기서는 보수적으로 종전 동작을 쓴다.
          congestionIsCurrent: undefined,
          // 실측이 하나라도 있으면 그룹은 실측으로 칠한다. 없을 때만 구성원 추정 중 가장 붐비는 값을
          // 쓴다(실측과 같은 '최댓값' 규칙 — 같은 건물이면 같은 격자라 값도 거의 같다).
          congestionEstimate: levels.length > 0
            ? null
            : members
              .map((item) => displayableEstimate(item))
              .filter((e): e is CongestionEstimate => e !== null)
              .sort((a, b) => b.level - a.level)[0] ?? null,
          isGroup: true,
          subFacilities: members,
        } as FacilityGroup;
      });
      const spaced: typeof scored = [];
      const points: { x: number; y: number }[] = [];
      const minimumGapPx = q ? 40 : 52;
      const markerLimit = q ? 12 : map.getLevel() <= 3 ? 12 : map.getLevel() >= 5 ? 5 : 7;
      for (const facility of pinCandidates) {
        const point = projection.containerPointFromCoords(
          new window.kakao.maps.LatLng(facility.latitude, facility.longitude)
        );
        if (points.every((other) => Math.hypot(point.x - other.x, point.y - other.y) >= minimumGapPx)) {
          spaced.push(facility);
          points.push({ x: point.x, y: point.y });
        }
        if (spaced.length >= markerLimit) break;
      }
      return spaced;
    } catch {
      return scored.slice(0, q ? 12 : 7);
    }
  };

  // 마커/히트맵 소스: 지도 시설 그대로(실측). 예측(+N시간)은 이 목록을 바꾸지 않는다 — 핀이 pinDisplay 로 따로
  // 칠한다(계획 B3). 원본 facilities 는 불변 → 추천/카드 로직에 영향 없음.
  const markerFacilities = useMemo(() => {
    if (activeFilter === '주차장') return parkingLots;
    const src = facilities;
    // ♿ 배리어프리 필터: 켜지면 barrier_free 가 명시적 true 인 시설만 남긴다(TourAPI 적재분은 정규 컬럼
    // barrierFree, 수동 시드는 features.barrier_free — 둘 다 확인). 마커·히트맵 공용 소스에서
    // 한 번만 걸러 두 레이어가 항상 동일 집합을 그린다.
    // 추천은 같은 travelContext.requiredAttributes 를 서버에 보내므로 지도와 후보 자격이 일치한다.
    // 추정 덧씌우기 — 실측 level 이 있는 시설에는 붙이지 않는다(측정이 이긴다). 이 시각 기준으로
    // 60분이 지난 값도 여기서 떨어진다(estimateClock 이 5분마다 이 파생을 다시 돌린다).
    // 주차장 탭은 위에서 이미 반환했다 — 주차장 자체에는 추정이 없다.
    const estimateNow = new Date(estimateClock);
    const withEstimates = Object.keys(estimateById).length === 0
      ? src
      : src.map((f) => {
          if (typeof f.congestionLevel === 'number') return f;
          const estimate = parseCongestionEstimate(estimateById[f.id], estimateNow);
          return estimate ? { ...f, congestionEstimate: estimate } : f;
        });
    let out = withEstimates;
    if (showBarrierFree) out = out.filter((f) => (f?.barrierFree ?? f?.barrier_free ?? f?.features?.barrier_free) === true);
    // 🅿🐾 주차·반려동물 필터: 순차 .filter() 체이닝이라 배리어프리와도 자연히 AND 조합된다.
    // 관광지 위주로 적재된 필드라 커버리지가 낮다 — 후보가 확 줄거나 0이어도 숨기지 않고 그대로 보여준다(정직성).
    // (parking 은 밑줄이 없어 camelCase 변환 영향이 없지만, chk_pet 은 apiClient 경유 시 chkPet 으로 바뀌므로 둘 다 확인.)
    if (showParkingFilter) out = out.filter((f) => parseAvailability(f?.features?.parking as string | null | undefined) === true);
    if (showPetFilter) out = out.filter((f) => parseAvailability((f?.features?.chk_pet ?? f?.features?.chkPet) as string | null | undefined) === true);
    return out;
  }, [activeFilter, facilities, parkingLots, showBarrierFree, showParkingFilter, showPetFilter, estimateById, estimateClock]);

  // '🔮 혼잡 예측' 칸 고르기(계획 B3 · I01). +N: 예측(모델 → 세션 권역 곡선)을 받는 동안 카드는 곧바로 지금+N시간
  // 기준으로 다시 고른다(cardHours). 예측이 없으면 알림 한 줄과 함께 지금으로 돌아간다(카드도 지금 기준으로 돌아온다).
  // 요일 프리셋이 걸려 있었으면 푼다 — 줄은 한 번에 하나의 시각만 말한다.
  const stripRequestRef = useRef<number>(0);
  const selectForecastHours = (value: number) => {
    const hours = clampForecastHours(value);
    const presetActive = assumedPreset !== 'now';
    if (hours === cardHours && !presetActive) return;
    const prevTop = selectedFacility?.id != null ? String(selectedFacility.id) : null;
    if (presetActive) setStoredAssumedPreset('now');
    dispatchStrip({ type: 'select', hours });
    stripRequestRef.current = hours;
    startRecalc(hours === 0 ? t('forecast.now') : t('forecast.ahead', { h: hours }), prevTop);
    if (hours === 0) return;
    const requested: ForecastHours = hours;
    void resolveStripForecast(requested, {
      modelTrained: () => isPredictModelTrained(),
      // 주의: predict 라우터는 /api/v1 이 아닌 /predict 프리픽스(main.py) 아래에 있다.
      batch: async (h) => {
        const res = await apiClient.post('/predict/batch', { hoursAhead: h });
        const predictions: ModelPredictions = {};
        for (const p of res?.predictions ?? []) {
          if (typeof p?.predictedCongestion === 'number') {
            predictions[String(p.facilityId)] = { level: p.predictedCongestion, anchored: p.anchored !== false };
          }
        }
        return predictions;
      },
      areaCurve: () => sessionAreaDemandCurve(),
    }, Date.now()).then((forecast) => {
      dispatchStrip({ type: 'resolved', hours: requested, forecast });
      if (!forecast && stripRequestRef.current === requested) {
        // 지금으로 돌아간다 — 그 사이 '…기준으로 다시 계산했어요' 가 예약돼 있으면 거두고 이 한 줄만 말한다.
        stripRequestRef.current = 0;
        abandonRecalc();
        showToast(t('map.predictFail'));
      }
    });
  };

  // '다른 시간 ▾' — 요일 프리셋(/waiting·/course 와 나누는 값). 상대 시각(+N)은 비운다.
  const selectAssumedPreset = (id: string) => {
    if (id === assumedPreset && strip.status === 'now') return;
    startRecalc(
      t(ASSUMED_TIME_PRESETS.find((p) => p.id === id)?.labelKey ?? 'timeSim.now'),
      selectedFacility?.id != null ? String(selectedFacility.id) : null,
    );
    stripRequestRef.current = 0;
    dispatchStrip({ type: 'reset' });
    setStoredAssumedPreset(id);
  };

  // AI 추천 동기화: 실 DB 시설은 백엔드(/recommendations/by-type) 랭킹 + 서버 사유(템플릿 + LLM 다듬기),
  // 합성 그룹·시간대 시뮬(mockHour) 등 데모는 lib/recommender 미러(사유 포함)로 처리해 합친 뒤 #1을 표시.
  // (백엔드는 합성 시설/mockHour 를 모르므로 데모는 분리해 클라 미러로 점수를 매긴다.)
  useEffect(() => {
    // 첫 카드 스켈레톤은 이 실행이 다시 켤 때만 남는다(같은 effect 안의 setState 는 한 번에 그려진다).
    setPickingFirst(false);
    // 이 두 갈래는 요청을 아예 보내지 않는다 — 비상 타이머(요청 타임아웃 뒤)를 기다리지 말고
    // 그 자리에서 스켈레톤을 걷는다. 말할 결과가 없으니 토스트도 띄우지 않는다.
    if (activeFilter === '주차장') {
      setSelectedFacility(null);
      setRankedFacilities([]);
      setNoRecommendation(false);
      abandonRecalc();
      return;
    }
    if (facilities.length === 0) {
      abandonRecalc();
      return;
    }

    // 요청은 '보낼 때'의 제외 목록으로 계산된다. 응답을 기다리는 동안 누른 '관심 없음'·'저장'은
    // 이 effect 를 다시 돌리지 않으므로(아래 dep 주석), 결과를 화면에 쓰기 전에 **그 사이에 생긴
    // 판단만** 걷어낸다. 요청 시점에 이미 제외돼 있던 것은 건드리지 않는다 — 후보가 전부 소진되면
    // 아래에서 일부러 전체로 되돌려(loopback) 다시 보여주는 설계라, 그것까지 지우면 소진 이후
    // 화면이 영구히 비어 버린다. rejectedIds/savedIds 는 이 effect 가 돌 때의 값(= 요청 시점),
    // ref 는 지금 이 순간의 값이다(선언부 주석).
    const dismissedSinceRequest = (f: Facility) =>
      (rejectedIdsRef.current.has(f.id) && !rejectedIds.has(f.id))
      || (savedIdsRef.current.has(f.id) && !savedIds.has(f.id));

    // 경주 테마는 유명 장소 자체를 추천하는 모드가 아니다. 선택한 명소를 원본(reference)으로
    // 보내 TourAPI 연관성·도착 영업 가능성·보행 경로를 통과한 같은 유형의 대안을 서버 SPOT으로
    // 다시 매긴다. 일반 by-type 요청과 섞이면 늦게 온 응답이 카드를 덮으므로 이 분기를 독립시킨다.
    if (activeDiscovery) {
      const theme = getDiscoveryTheme(activeDiscovery.themeId);
      let cancelled = false;
      recommendationAbortRef.current?.abort();
      const recommendationController = new AbortController();
      recommendationAbortRef.current = recommendationController;
      // 테마 분기와 by-type 분기는 같은 카운터를 쓴다 — 둘 사이를 오갈 때도 늦게 온 쪽이 이기면 안 된다.
      const gen = ++recommendationGenRef.current;
      setDiscoveryLoading(true);

      (async () => {
        try {
          const recs = await getRecommendations(
            activeDiscovery.anchorId,
            userLocation,
            { ...travelContext, categories: [theme.candidateType] },
            {
              preferenceIntent: theme.preferenceIntent,
              candidateTypes: [theme.candidateType],
              discoveryTheme: theme.id,
              signal: recommendationController.signal,
            },
          );
          if (cancelled || gen !== recommendationGenRef.current) return; // 이후 요청이 이미 나갔다 — 구세대 응답 폐기
          const byId = new Map(expandGroups(facilities).map((facility) => [facility.id, facility]));
          const ranked = recs.map((rec) => {
            const rf = rec.facility;
            const base = byId.get(rf.id) as Facility | undefined;
            return {
              ...(base ?? rf),
              features: (rf.features ?? base?.features ?? null) as FacilityFeatures | null,
              operatingHours: rf.operatingHours ?? base?.operatingHours ?? null,
              imageUrl: rf.imageUrl ?? base?.imageUrl ?? null,
              galleryImages: rf.galleryImages ?? base?.galleryImages ?? null,
              address: rf.address ?? base?.address ?? null,
              phone: rf.phone ?? base?.phone ?? null,
              homepage: rf.homepage ?? base?.homepage ?? null,
              overview: rf.overview ?? base?.overview ?? null,
              barrierFree: rf.barrierFree ?? base?.barrierFree ?? null,
              congestionLevel: rec.congestionSource !== 'none' ? (rec.congestionLevel ?? null) : null,
              currentCount: rec.congestionSource === 'measured' ? (rf.currentCount ?? null) : null,
              recommendationId: rec.recommendationId,
              openStatusAtArrival: rec.openStatusAtArrival,
              informationConfidence: rec.informationConfidence,
              eligibilityTier: rec.eligibilityTier,
              availabilityEvidence: rf.availabilityEvidence ?? base?.availabilityEvidence ?? null,
              congestionSource: rec.congestionSource,
              congestionLogSource: rec.congestionLogSource,
              congestionIsStale: rec.congestionIsStale,
              congestionTimestamp: rec.congestionTimestamp,
              // 서버 판정('지금' 자격). 구 서버는 undefined → 카드가 종전 규칙으로 동작한다.
              congestionIsCurrent: rec.congestionIsCurrent,
              // 새 서버는 추천 응답에 직접 싣는다(null = 실측·예측이 있어 추정을 보이지 않는다).
              // 구 서버는 필드가 없어 undefined → 지도(/infrastructures)가 받은 추정을 그대로 쓴다.
              // 새 서버는 추천 응답에 직접 싣는다(null = 실측·예측이 있어 추정을 보이지 않는다).
              // 구 서버는 필드가 없고 추정 피드도 404 라 어느 쪽이든 null 이다.
              // 선택 카드와 동일하게 추정 피드(estimateById) 최신값을 우선 덧씌운다(모든 랭킹 카드에 배지).
              congestionEstimate: (estimateById[rf.id] as CongestionEstimate | undefined) ?? rec.congestionEstimate ?? null,
              dataUpdatedAt: rec.dataUpdatedAt,
              scoringMode: rec.scoringMode,
              apiRank: rec.rank,
              totalCandidates: rec.totalCandidates,
              discoveryThemeMatch: rec.breakdown.discoveryThemeMatch ?? null,
              spot: recToSpot(rec),
              reason: rec.reason || '',
            } as Facility;
          });
          // 응답이 도착하는 사이에 누른 '관심 없음'·'저장'을 반영한다(dismissedSinceRequest 주석).
          const visible = ranked.filter((f) => !dismissedSinceRequest(f));
          setRankedFacilities(visible);
          setDiscoveryLoading(false);
          if (visible.length === 0) {
            setSelectedFacility(null);
            setNoOpenTodayOnly(false);
            setNoRecommendation(true);
            // '서버가 대안을 못 찾았다' 와 '내가 전부 치웠다' 는 다른 사실이다 — 전자일 때만 그렇게 말한다.
            if (ranked.length === 0) showToast(t('discovery.noAlternatives', { anchor: activeDiscovery.anchorName }));
            recalcRef.current = null; // 이 경우의 안내는 위 토스트가 대신한다(토스트 두 개 금지)
            setRecalcLabel(null);
            return;
          }
          setNoRecommendation(false);
          setSelectedFacility(visible[0]);
          finishRecalc(String(visible[0].id));
          if (mapInstanceRef.current) panToVisible(visible[0].latitude, visible[0].longitude);
        } catch (error) {
          if (cancelled || gen !== recommendationGenRef.current) return; // 구세대 실패로 최신 화면을 덮지 않는다
          if (error instanceof DOMException && error.name === 'AbortError') return;
          console.warn('경주 테마 대안 추천 실패:', error);
          setDiscoveryLoading(false);
          setSelectedFacility(null);
          setNoOpenTodayOnly(false);
          setNoRecommendation(true);
          finishRecalc(null);
        }
      })();

      return () => {
        cancelled = true;
        recommendationController.abort();
        if (recommendationAbortRef.current === recommendationController) {
          recommendationAbortRef.current = null;
        }
      };
    }

    const filterMap: Record<string, string> = {
      '음식점': 'restaurant',
      '카페': 'cafe',
      '관광지': 'attraction',
      '문화시설': 'culture'
    };
    const targetType = filterMap[activeFilter];

    const typeOk = (f: Facility) => f.type === targetType && !(targetType === 'restaurant' && isBarFacility(f)); // 식당 추천에서 술집 제외
    // 칩이 유형을 정했으므로 온보딩 카테고리로 다른 칩을 막지 않는다. 도보 제한이 칩을 비우면 한 번만
    // 넓힌다 — 카드가 실제 도보 분을 말한다. 서버에도 같은 조건(rankContext)을 보낸다.
    const { context: rankContext, items: contextEligible } = chipCandidates(
      facilities.filter(typeOk),
      travelContext,
      (context) => (f: Facility) => matchesTravelContext(f, context, userLocation, haversineMeters),
    );
    let candidates = contextEligible.filter(f => !rejectedIds.has(f.id) && !savedIds.has(f.id));
    if (candidates.length === 0) {
      candidates = contextEligible;
    }
    if (candidates.length === 0) {
      setSelectedFacility(null);
      setNoOpenTodayOnly(false); // 이 경로는 유형 자체가 0건 — 휴무 소진과 구분
      setNoRecommendation(true); // (b) 후보 0건 → 카드 자리에 빈 상태 안내
      finishRecalc(null);
      maybeSwitchFirstView(targetType as PlaceCategory);
      return;
    }
    setNoRecommendation(false); // 후보 존재 확인 → 이전 카테고리의 빈 상태 안내 즉시 해제(async 지연 중 오표시 방지)

    const isDemo = (f: Facility) => f.isGroup || String(f.id).startsWith('dummy-');
    const realCands = candidates.filter(f => !isDemo(f));
    // 서버 응답 전 즉시 카드와 API 장애 폴백은 영업 확인 후보로만 제한한다. 서버는 별도로
    // 가장 강한 영업·경로 tier를 선택하며, 약한 후보로 요청 개수를 억지로 채우지 않는다.
    const verifiedCandidates = candidates.filter((f) =>
      isRecommendationOpen(f.type, (f as any).operatingHours)
    );
    const verifiedRealCands = verifiedCandidates.filter(f => !isDemo(f));
    // 모음은 sub로 펼쳐 개별 장소를 랭킹(모음 자체는 카드로 안 띄움). 펼친 sub도 거절/저장 제외.
    const demoCands = expandGroups(verifiedCandidates.filter(isDemo))
      .filter((f) => !rejectedIds.has(f.id) && !savedIds.has(f.id));
    const liveMode = mockHour === null; // 시간대 시뮬이 켜지면 데모(목업) 모드로 일관 처리
    rankingOriginRef.current = null; // 랜드마크 기준점 리셋(카테고리 전환 시)
    const scoreOpts = { userLocation: rankingOriginRef.current ?? userLocation, preferredCategories, mockHour, cuisineIntent: cuisineIntentRef.current };

    let cancelled = false;
    recommendationAbortRef.current?.abort();
    const recommendationController = new AbortController();
    recommendationAbortRef.current = recommendationController;
    const gen = ++recommendationGenRef.current;
    // 즉시 계산한 순위(취향·추정 도보·혜택만 쓰는 정직한 degraded 결과). 예전에는 이 카드를 먼저 띄우고 1~4초 뒤
    // 서버 1위로 바꿨다 — 읽던 카드가 손 밑에서 다른 곳으로 바뀌었다(I34). 이제는 서버 답을 최대
    // FIRST_PICK_WAIT_MS 기다리며 스켈레톤('지금 덜 붐비는 가까운 곳을 고르고 있어요…')을 보이고, 그 안에 오면 서버
    // 1위를 바로, 넘기면 이 카드를 띄운다. 서버가 실패하거나 0곳을 주면 이 카드를 곧바로 띄운다(레드팀 수정).
    let immediate: Facility[] = [];
    if (!voiceFilterIdsRef.current && liveMode) {
      const immediateReal = rankFacilitiesDegraded(
        filterReachable(verifiedRealCands, userLocation),
        scoreOpts,
      ).map((facility) => ({ ...facility, scoringMode: 'degraded_rules' as const }));
      const immediateDemo = rankFacilities(demoCands, scoreOpts);
      immediate = [...immediateReal, ...immediateDemo].sort(compareSpot);
      immediate.forEach((facility, index) => {
        facility.apiRank = index + 1;
        facility.totalCandidates = immediate.length;
      });
    }
    // 사용자가 이 칩에서 직접 고른 카드는 그대로 둔다(목록만 새로 받는다).
    const userPick = userPickRef.current && userPickRef.current.filter === activeFilter ? userPickRef.current : null;
    // 이미 이 칩의 카드가 떠 있으면(시설 목록 갱신 · 조건 변경으로 다시 도는 경우) 스켈레톤으로 지우지 않는다.
    const shownNow = selectedFacilityRef.current as Facility | null;
    const showingThisChip = !!shownNow && shownNow.type === targetType;
    const willAskServer = !voiceFilterIdsRef.current && liveMode && realCands.length > 0;
    let firstPickTimer: ReturnType<typeof setTimeout> | null = null;
    if (willAskServer && !userPick && !showingThisChip) {
      setSelectedFacility(null);
      setPickingFirst(true);
      firstPickTimer = setTimeout(() => {
        firstPickTimer = null;
        if (cancelled || gen !== recommendationGenRef.current || immediate.length === 0) return;
        setRankedFacilities(immediate);
        // 기다리는 사이 사용자가 핀·검색으로 직접 고른 카드가 있으면 그 카드를 그대로 둔다.
        if (userPickRef.current?.filter !== activeFilter) setSelectedFacility(immediate[0]);
        setPickingFirst(false);
      }, FIRST_PICK_WAIT_MS);
    } else if (!willAskServer && immediate.length > 0) {
      setRankedFacilities(immediate);
      if (!userPick) setSelectedFacility(immediate[0]);
    }
    (async () => {
      try {
        let all: Facility[];
        const vfilter = voiceFilterIdsRef.current; // ref로 최신 필터를 읽음(이 effect는 voiceFilterIds를 dep로 안 둠)
        if (vfilter) {
          // 음성 선호 필터(예: '양식'): 후보를 백엔드가 고른 id들로 좁혀 클라 미러로 SPOT 재랭킹(실시간).
          // (필터 변경 직후 첫 카드는 onFilter가 동기로 직접 set하므로 여기선 이후 재실행 케이스만 처리.)
          const filtered = expandGroups(verifiedCandidates)
            .filter((f) => vfilter.has(f.id) && !rejectedIds.has(f.id) && !savedIds.has(f.id) && !dismissedSinceRequest(f));
          all = rankFacilities(filtered, scoreOpts);
          all.forEach((f, i) => {
            f.apiRank = i + 1;
            f.totalCandidates = all.length;
          });
        } else {
          let realRanked: any[] = [];
          let recommendationApiFailed = false;
          if (liveMode && realCands.length > 0) {
            try {
              // 백엔드에는 rejectedIds와 savedIds를 제외하고 요청
              const requestByType = (context: typeof rankContext) => recommendByType(
                targetType,
                userLocation,
                [...rejectedIds, ...savedIds],
                5,
                context,
                cuisineIntentRef.current,
                recommendationController.signal,
                // 재계산 스켈레톤의 비상 종료(RECALC_EMERGENCY_MS)가 이 값을 기준으로 잡힌다.
                RECOMMENDATION_TIMEOUT_MS,
                // 가정 시각 — 혼잡 예측 +N시간이면 지금+N시간(이 화면의 상태로만), 아니면 요일 프리셋(있으면).
                // 둘 다 없으면 null = 서버 현재 시각(기존 동작).
                cardHours > 0 ? relativeAssumedAtIso(Date.now(), cardHours) : assumedAtIsoForPreset(assumedPreset),
              );
              let recs = await requestByType(rankContext);
              // 서버는 실제 걷는 길로 도보 제한을 잰다 — 직선거리로는 남았어도 0곳일 수 있다. 그때 한 번만 넓힌다.
              const relaxedContext = recs.length === 0 ? relaxWalkLimit(rankContext) : null;
              if (relaxedContext) recs = await requestByType(relaxedContext);
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
                    // 모델이 없어도 최신 현장 관측(measured)은 숨기지 않는다. degraded_rules는
                    // 점수에서 혼잡/대기를 제외한다는 뜻이지, 실제 제보를 폐기한다는 뜻이 아니다.
                    congestionLevel: r.congestionSource !== 'none' ? (r.congestionLevel ?? null) : null,
                    currentCount: r.congestionSource === 'measured' ? (rf.currentCount ?? null) : null,
                    // 머천트 연동(2단계): 타임세일·좌석 확인 배지용 — allowlist 병합이라 명시적으로 전달해야 카드에 도달한다.
                    timesaleRate: (rf as any).timesaleRate ?? (rf as any).timesale_rate ?? null,
                    seatStatusFresh: (rf as any).seatStatusFresh ?? (rf as any).seat_status_fresh ?? null,
                    recommendationId: r.recommendationId,
                    openStatusAtArrival: r.openStatusAtArrival,
                    informationConfidence: r.informationConfidence,
                    eligibilityTier: r.eligibilityTier,
                    availabilityEvidence: rf.availabilityEvidence ?? base?.availabilityEvidence ?? null,
                    congestionSource: r.congestionSource,
                    congestionLogSource: r.congestionLogSource,
                    congestionIsStale: r.congestionIsStale,
                    congestionTimestamp: r.congestionTimestamp,
                    congestionIsCurrent: r.congestionIsCurrent,
                    // 선택 카드와 동일한 덧씌우기: 추정 피드(estimateById) 최신값을 우선하고, 없으면
                    // 응답이 실어 준 추정으로 폴백한다 → 웜 응답에서 상위 카드뿐 아니라 모든 랭킹 카드에 '추정' 배지가 뜬다.
                    congestionEstimate: (estimateById[rf.id] as CongestionEstimate | undefined) ?? r.congestionEstimate ?? null,
                    dataUpdatedAt: r.dataUpdatedAt,
                    scoringMode: r.scoringMode,
                    spot,
                    reason: r.reason || "", // 백엔드 템플릿 사유만
                  };
                });
            } catch (e) {
              if (!(e instanceof DOMException && e.name === 'AbortError')) {
                console.warn("by-type 추천 실패 → 영업 확인 후보만 로컬 폴백:", e);
                recommendationApiFailed = true;
              }
              realRanked = [];
            }
          }
          // API가 정상적으로 빈 배열을 반환했다면 서버의 fail-closed 판정을 존중한다. 네트워크 장애일
          // 때만 도착 후 30분 이상 영업이 확인된 로컬 후보로 제한해 폴백한다.
          if (recommendationApiFailed && verifiedRealCands.length > 0) {
            realRanked = rankFacilitiesDegraded(filterReachable(verifiedRealCands, userLocation), scoreOpts);
          }
          // 합성/데모 시설은 항상 클라 미러로 점수 부여
          const demoRanked = rankFacilities(demoCands, scoreOpts);
          // 순위를 매기기 **전에** 제외한다 — 화면에 못 뜰 항목이 자리를 차지하면 apiRank·totalCandidates
          // ('N곳 중 M번째')가 사용자가 보는 목록과 어긋난다.
          all = [...realRanked, ...demoRanked].filter((f) => !dismissedSinceRequest(f)).sort(compareSpot);
          all.forEach((f, i) => {
            f.apiRank = i + 1;
            f.totalCandidates = all.length;
          });
        }

        if (cancelled || gen !== recommendationGenRef.current) return; // 이후 요청이 이미 나갔다 — 구세대 응답 폐기
        if (firstPickTimer) { clearTimeout(firstPickTimer); firstPickTimer = null; }
        // 서버가 0곳을 줬거나 실패했는데 즉시 계산한 카드가 있으면 그 카드를 곧바로 띄운다(빈 카드 대신).
        if (all.length === 0 && !vfilter && immediate.length > 0) all = immediate;
        setRankedFacilities(all);
        setPickingFirst(false);
        // 응답을 기다리는 사이 사용자가 직접 고른 카드(핀 · 검색 · 링크)가 생겼을 수 있다 — 지금 값으로 다시 본다.
        const pickNow = userPickRef.current && userPickRef.current.filter === activeFilter ? userPickRef.current : null;
        if (all.length === 0) {
          if (pickNow) { finishRecalc(pickNow.id); return; }
          setSelectedFacility(null);
          setNoOpenTodayOnly(false); // 랭킹 0건 — 휴무 소진과 구분
          setNoRecommendation(true); // (b) 랭킹 결과 0건 → 빈 상태 안내
          finishRecalc(null);
          // ♿ 가 켜져 있는데 서버가 이 칩에 0곳을 줬다(클라이언트는 셌다) — 빈 지도로 두지 않고 클라이언트 0곳일 때처럼
          // 무장애 핀으로 지도를 맞춘다(제안 카드가 '지도에 N곳' 을 말한다).
          if (rankContext.requiredAttributes.includes('accessible')) fitBarrierFreePins(targetType as PlaceCategory);
          maybeSwitchFirstView(targetType as PlaceCategory);
          return;
        }
        firstViewPendingRef.current = false;
        setNoRecommendation(false); // 후보 있음 → 안내 숨김
        if (pickNow) {
          // 직접 고른 카드는 그대로 — 목록에 있으면 서버 값(사유·근거)으로만 채운다(연 방식 표시는 유지).
          const listed = all.find((f) => String(f.id) === pickNow.id);
          if (listed) setSelectedFacility({ ...listed, pickKind: pickNow.kind });
          finishRecalc(pickNow.id);
          return;
        }
        const top = all[0];
        const current = selectedFacilityRef.current as Facility | null;
        setSelectedFacility(top);
        finishRecalc(String(top.id));
        // 서버가 지금 카드와 같은 곳을 확인했으면 지도를 다시 움직이지 않는다(숫자도 다시 굴리지 않는다 —
        // 카드의 useCountUp rollOnChange:false). 다른 곳이면 그곳으로 옮긴다.
        const sameAsShown = !!current && String(current.id) === String(top.id);
        if (!sameAsShown && mapInstanceRef.current && typeof top.latitude === 'number') {
          panToVisible(top.latitude, top.longitude);
        }
      } catch (err) {
        console.warn("Error in recommendation synchronization effect:", err);
        if (!cancelled && gen === recommendationGenRef.current) setPickingFirst(false);
        finishRecalc(null);
      }
    })();

    return () => {
      cancelled = true;
      if (firstPickTimer) clearTimeout(firstPickTimer);
      recommendationController.abort();
      if (recommendationAbortRef.current === recommendationController) {
        recommendationAbortRef.current = null;
      }
    };
    // voiceFilterIds 는 dep로 두지 않는다(필터 변경은 onFilter가 직접 처리; effect는 ref로 최신값 읽음 → 더블셋/경합 방지).
    // rejectedIds, savedIds 도 dep에서 제외하여 거절/저장 시 불필요한 백엔드 API 재호출(점수/순위 리셋 현상)을 방지.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facilities, activeFilter, userLocation, preferredCategories, mockHour, travelContext, activeDiscovery, assumedPreset, cardHours]);

  // Action Button Handlers
  const handleAccept = (fac: Facility, navigationMode: 'walk' | 'car' = 'walk') => {
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
    const spot = fac.spot || calculateSPOT(fac);
    try {
      recordActiveTrip(fac, { recommendationId: (fac as any).recommendationId, walkMinutes: spot.expectedTravel, context: travelContext as unknown as Record<string, unknown>, navigationMode });
      queueRecommendationOutcome(fac.recommendationId, 'navigation_started');
      track('navigation_started', { facility_type: fac.type, navigation_mode: navigationMode, walk_minutes: Math.round(spot.expectedTravel) });
    } catch { /* localStorage 차단 환경 무시 */ }

    let greeting = t('map.greetingDefault');
    if (fac.type === "restaurant") greeting = t('map.greetingRestaurant');
    else if (fac.type === "cafe") greeting = t('map.greetingCafe');
    else if (fac.type === "attraction" || fac.type === "culture") greeting = t('map.greetingView');

    showToast(greeting);

    if (navigationMode === 'walk') {
      showToast(t('trip.selectWalking'));
      openWalkingDirections(fac);
    } else {
      showToast(t('trip.driveBasisHint'));
      openDrivingDirections(fac);
    }
    showProfileToast();
  };

  // '취향 프로필에 반영했어요 · 보기' — 도보 길안내·관심 없어요가 마이페이지 취향 프로필로 이어진다는 것을 한 번
  // 보여 준다(계획 B2 · F2 ⑤). 한 세션에 한 번만 — 누를 때마다 알림이 쌓이지 않게. 띄웠으면 true.
  const showProfileToast = (): boolean => {
    try {
      if (sessionStorage.getItem(PROFILE_TOAST_KEY) === '1') return false;
      sessionStorage.setItem(PROFILE_TOAST_KEY, '1');
    } catch {
      return false;
    }
    toast(t('card.profileToast'), {
      action: { label: t('card.profileToastView'), onClick: () => router.push('/mypage') },
    });
    return true;
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
    // 이미 나가 있는 추천 요청이 돌아왔을 때 이 판단을 알고 있어야 한다. setSavedIds 는 렌더를
    // 기다리는 예약이라, 응답이 그보다 먼저 도착하는 경합을 막지 못한다 — ref 는 지금 바로 갱신한다.
    // (nextSavedIds 가 아니라 ref 기준으로 더한다: 한 프레임에 두 번 눌러도 앞의 판단을 잃지 않는다.)
    savedIdsRef.current = new Set(savedIdsRef.current).add(fac.id);
    const voicePass = (f: Facility) => !voiceFilterIds || voiceFilterIds.has(f.id); // 음성 선호 필터 유지

    // rankedFacilities (백엔드 순위) 기준 탐색: 방금 저장한 항목 제외
    let nextCandidates = rankedFacilities.filter(voicePass).filter((f) => !nextSavedIds.has(f.id));
    // 모두 소진되면 음성 필터만 유지해 루프백
    if (nextCandidates.length === 0) {
      nextCandidates = rankedFacilities.filter(voicePass);
    }

    userPickRef.current = null;
    if (nextCandidates.length > 0) {
      setSelectedFacility(nextCandidates[0]);
      if (mapInstanceRef.current && typeof nextCandidates[0].latitude === 'number') {
        panToVisible(nextCandidates[0].latitude, nextCandidates[0].longitude);
      }
    } else {
      setSelectedFacility(null);
      setNoOpenTodayOnly(false); // 저장 경로 소진 — 휴무 소진과 구분
      setNoRecommendation(true); // (b) 후보 소진 → 빈 상태 안내
    }

    setSavedIds(prev => {
      const next = new Set(prev);
      next.add(fac.id);
      return next;
    });

    try {
      const spot = fac.spot || calculateSPOT(fac);
      const bookmark: SavedBookmark = {
        id: fac.id,
        // 저장 당시의 실제 recommendations 행 id. rankedFacilities 가 이미 들고 있는데
        // 여기서만 빠뜨려서, 저장 해제 피드백이 서버로 영영 가지 않았다(id 가 undefined 라
        // isRealRecommendationId 검사에 닿기도 전에 죽었다). by-type 이 합성 id 를 주던
        // 시절의 전제가 주석으로만 남아 있었고 코드는 그 전제를 그대로 따르고 있었다.
        recommendationId: fac.recommendationId,
        name: fac.name,
        category: fac.type === 'restaurant' ? '음식점' : fac.type === 'cafe' ? '카페' : fac.type === 'attraction' ? '관광지' : '문화시설',
        // 저장 페이지의 라이브 혼잡 재조회(매칭)·카카오맵 길찾기 링크에 좌표가 필요하므로 함께 저장한다.
        latitude: fac.latitude,
        longitude: fac.longitude,
        address: fac.address ?? null,
        phone: fac.phone ?? null,
        features: fac.features ?? null,
        // 혼잡 근거 없음(null)은 '한산(blue)'으로 합성하지 않고 unknown 으로 저장(CONGESTION_TRUST_SPEC).
        // 등급 경계는 운영자 설정(busyAt)을 따른다 — 저장 시점의 등급이 화면 배지와 어긋나면 안 된다.
        trafficStatus: typeof fac.congestionLevel !== 'number'
          ? 'unknown'
          : ({ busy: 'orange', moderate: 'yellow', relaxed: 'green', quiet: 'blue' } as const)[
              congestionKey(fac.congestionLevel, busyAt)
            ],
        congestionLevel: typeof fac.congestionLevel === 'number' ? fac.congestionLevel : null,
        waitTime:
          fac.scoringMode === 'model' && fac.congestionSource !== 'none'
            ? `${spot.expectedWait}분`
            : null,
        waitEvidence:
          fac.scoringMode === 'model' && fac.congestionSource !== 'none'
            ? 'verified_model'
            : undefined,
        spot: spot,
        reason: fac.reason || ""
      };
      // 로컬 캐시 즉시 반영 + Supabase 영속화(중복 id 는 내부에서 무시).
      void saveBookmark(bookmark as unknown as SavedRecord);
    } catch (e) {
      console.warn("Failed to save bookmark:", e);
    }

    showToast(t('map.savedToast'));
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
    // handlePutOff 와 같은 이유로 ref 를 즉시 갱신한다(도착 중인 응답이 방금 거절한 곳을 되살리지 못하게).
    rejectedIdsRef.current = new Set(rejectedIdsRef.current).add(fac.id);
    const voicePass = (f: Facility) => !voiceFilterIds || voiceFilterIds.has(f.id); // 음성 선호 필터 유지
    // 오늘 휴무 '확정' 시설은 다음 추천 후보에서 제외(문 닫은 집 추천 사고 방지 — 음식 칩 풀과 동일 조건).
    // 판정 불가(null)는 배제하지 않는다(정직성: 과판정 금지). camel/snake 이중 표기 방어(keysToCamel 재귀).
    const openToday = (f: Facility) =>
      isClosedToday((f.features?.rest_date_raw ?? f.features?.restDateRaw) as string | null | undefined) !== true;

    // 다음 추천은 첫 추천과 동일한 점수 체계 유지를 위해 백엔드 랭킹(rankedFacilities)에서 소비한다
    // (기존: 클라 calculateSPOT 재계산 → 거절 시 점수 체계가 몰래 바뀌던 문제).
    let nextCandidates = rankedFacilities
      .filter((f) => voicePass(f) && openToday(f) && !nextRejectedIds.has(f.id) && !savedIds.has(f.id));

    // 랭킹 리스트가 소진된 경우에만 클라 미러(calculateSPOT)로 폴백(음성 필터 유지). 이미 관심 없음·저장한 곳은
    // 되살리지 않는다 — 예전 루프백은 방금 치운 곳을 다시 보여 줬다(계획 B2 · I23).
    if (nextCandidates.length === 0) {
      nextCandidates = expandGroups(facilities.filter(f => f.type === targetType))
        .filter((f) => voicePass(f) && openToday(f) && !nextRejectedIds.has(f.id) && !savedIds.has(f.id))
        .map((f) => ({ ...f, spot: calculateSPOT(f) }))
        .sort(compareFacilities);
    }

    userPickRef.current = null;
    if (nextCandidates.length > 0) {
      setSelectedFacility(nextCandidates[0]);
      if (mapInstanceRef.current && typeof nextCandidates[0].latitude === 'number') {
        panToVisible(nextCandidates[0].latitude, nextCandidates[0].longitude);
      }
    } else {
      setSelectedFacility(null);
      // 소진 원인 구분 — 휴무 필터를 빼면 후보가 남아 있고 그 전부가 오늘 휴무 확정이면
      // '장소가 없어서'가 아니라 '오늘 다 쉬어서'다. 빈 상태 문구로 정직하게 설명(Codex 리뷰 P2).
      const remainderIgnoringClosed = expandGroups(facilities.filter(f => f.type === targetType))
        .filter((f) => voicePass(f) && !nextRejectedIds.has(f.id) && !savedIds.has(f.id));
      setNoOpenTodayOnly(
        remainderIgnoringClosed.length > 0 && remainderIgnoringClosed.every((f) => !openToday(f))
      );
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

    // '다른 곳을 보여드릴게요' 는 정말 다음 장소가 뜰 때만. 남은 곳이 없으면 카드가 닫히는 것(과 고를 칩이 있으면
    // 제안 카드)이 답이다 — 지키지 못할 약속도, '없어요' 같은 빈 말도 하지 않는다.
    if (nextCandidates.length > 0) showToast(t('map.rejectToast'));
    if (!showProfileToast()) maybeShowLabHint();
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

  // 음성 '다음/별로': 폐기(rejectedIds)하지 않고 보이는 추천 목록(서버 상위 5곳)에서 다음 순위로만 이동한다 —
  // 베스트 추천 → 2번째 → 3번째 → 다음 후보 … 끝이면 처음으로(계획 B2 · I23). 예전에는 모든 장소를 클라이언트
  // 점수로 다시 매긴 목록을 걸어 '추천 14순위 · 대안 428개 중' 으로 뛰었다. 목록이 비었을 때만 그 목록을 쓴다.
  const handleAdvanceRank = (fac: Facility) => {
    if (!fac) return;
    const voicePass = (f: Facility) => !voiceFilterIds || voiceFilterIds.has(f.id);
    const listed = (rankedFacilities as Facility[])
      .filter((f) => voicePass(f) && !rejectedIds.has(f.id) && !savedIds.has(f.id));
    if (listed.length > 0) {
      if (listed.length === 1 && String(listed[0].id) === String(fac.id)) { showToast(t('map.noMoreRec')); return; }
      const at = listed.findIndex((f) => String(f.id) === String(fac.id));
      const nextListed = listed[at < 0 ? 0 : (at + 1) % listed.length];
      userPickRef.current = null;
      setSelectedFacility(nextListed);
      if (mapInstanceRef.current && typeof nextListed.latitude === 'number') panToVisible(nextListed.latitude, nextListed.longitude);
      return;
    }
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

  // 카드 첫 줄의 기준 명소(A) — 카드와 음성이 같은 값을 쓴다. 테마 칩이 켜져 있으면 그 테마의 대표 랜드마크,
  // 아니면 관광 근거의 referenceName(= "…기준 · 후보와 184m"). 그 명소 자체의 '지금' 혼잡은 후보 카드와 같은
  // 규칙(anchorNowLevel)으로만 읽는다. 가정 시각(프리셋)이면 지금 값은 그 시각의 값이 아니라 쓰지 않는다(I10).
  const anchorContextFor = (target: Facility, spot: Spot) => {
    const anchorName: string | null = activeDiscovery?.anchorName
      ?? spot.areaDemandTourismEvidence?.referenceName
      ?? null;
    const anchorFacility = anchorName
      ? expandGroups(facilities).find((f) =>
          (activeDiscovery ? f?.id === activeDiscovery.anchorId : false) || f?.name === anchorName)
      : undefined;
    const anchorLevel: number | null = anchorFacility && assumedPreset === 'now' && cardHours === 0
      ? anchorNowLevel({
          congestionLevel: anchorFacility.congestionLevel,
          congestionSource: anchorFacility.congestionSource ?? null,
          congestionIsCurrent: anchorFacility.congestionIsCurrent,
          // 지도 시설의 lastUpdated 는 혼잡 로그 시각이다(loadFacilities) — 카드의 congestionTimestamp 와 같은 값.
          congestionTimestamp: anchorFacility.congestionTimestamp ?? anchorFacility.lastUpdated,
          congestionEstimate: (estimateById[anchorFacility.id] as CongestionEstimate | undefined)
            ?? anchorFacility.congestionEstimate
            ?? null,
        })
      : null;
    // 기준 명소까지 거리 — 100m 안쪽(같은 자리)이면 화살표를 쓰지 않는다. 테마면 두 좌표 사이, 아니면 서버가 준 거리.
    const anchorDistanceM: number | null = activeDiscovery?.anchorName
      ? (anchorFacility
          && typeof anchorFacility.latitude === 'number' && typeof anchorFacility.longitude === 'number'
          && typeof target.latitude === 'number' && typeof target.longitude === 'number'
          ? haversineMeters(anchorFacility.latitude, anchorFacility.longitude, target.latitude, target.longitude)
          : null)
      : spot.areaDemandTourismEvidence?.distanceM ?? null;
    return { anchorName, anchorLevel, anchorDistanceM };
  };

  // 음성 비서가 카드마다 읽는 이유(계획 B2 · I46) — 카드가 보여 주는 값으로: 이름 한 번 · 걸어서 N분 · 취향 %,
  // '대신' 은 카드 첫 줄이 화살표일 때만, '지금 여유로운 편이에요' 는 그곳 등급이 한산·여유일 때만.
  const voiceReasonFor = (f: Facility): string => {
    const spot = f.spot || calculateSPOT(f);
    const { anchorName, anchorLevel, anchorDistanceM } = anchorContextFor(f, spot);
    const anchor = resolveAnchorCrowd({
      estimateLevel: anchorLevel,
      parkingLevel: spot.areaDemandParkingEvidence?.level,
      tourismRelativeIndex: spot.areaDemandTourismEvidence?.relativeIndex,
      busyAt,
    });
    const measuredNow = typeof f.congestionLevel === 'number' && f.congestionIsCurrent !== false && f.congestionSource !== 'predicted'
      ? f.congestionLevel
      : null;
    const estimate = displayableEstimate({
      congestionLevel: f.congestionLevel,
      congestionSource: f.congestionSource ?? null,
      congestionIsCurrent: f.congestionIsCurrent,
      congestionTimestamp: f.congestionTimestamp ?? f.lastUpdated,
      congestionEstimate: (estimateById[f.id] as CongestionEstimate | undefined) ?? f.congestionEstimate ?? null,
    });
    const ownGrade = resolveCandidateCrowd({ congestionLevel: measuredNow, estimateLevel: estimate?.level, busyAt });
    const candidateGrade = resolveCandidateCrowd({
      congestionLevel: measuredNow,
      estimateLevel: estimate?.level,
      areaDemandLevel: candidateAreaCrowdLevel({
        areaDemandLevel: spot.areaDemandLevel,
        parking: spot.areaDemandParkingEvidence,
        tourism: spot.areaDemandTourismEvidence,
      }),
      busyAt,
    });
    const headline = chooseCompareHeadline({
      anchorName,
      anchorDistanceM,
      candidateName: f.name,
      anchorGrade: anchor.grade,
      anchorBasis: anchor.basis,
      candidateGrade,
    });
    return buildVoiceReason(t, {
      name: f.name,
      walkMin: displayWalkingMinutes(spot.expectedTravel),
      preferencePercent: spot.preferencePercent,
      insteadOf: headline.kind === 'compare' ? anchorName : null,
      crowdGrade: ownGrade,
    });
  };

  // 음성으로 고른 음식 칩(onFilter 에서 칩과 같은 경로로 적용한다 — I09).
  const pendingVoiceChipRef = useRef<CuisineChip | null>(null);

  // ── 음성 비서: 현재 추천 카드를 관광객 말로 TTS 안내 + STT 응답 위임 ──
  // 수락(응/가자)→handleAccept(길안내), 다음/별로→서버 목록의 다음 순위, 자세히→상세 재안내, 그만→종료.
  // 화면 언어로 말하고 듣는다(I21) — 서버의 응답 문장은 한국어라 한국어 화면에서만 그대로 읽는다.
  const voice = useVoiceAssistant<Facility>({
    lang: speechLangFor(locale),
    useServerSpoken: locale === 'ko',
    messages: {
      reprompt: t('recommend.voiceReprompt'),
      acceptAck: t('recommend.voiceGuiding'),
      end: t('recommend.voiceEnd'),
      similar: t('voice.similar'),
      noMatch: t('voice.noMatchMenu'),
      applied: t('voice.applied'),
      keepGoing: t('voice.keepGoing'),
      closing: t('voice.closing'),
      greet: t('voice.greet'),
    },
    cardSentence: (name, reason) => buildCardSentence(t, name, reason),
    // 비서를 켜면 검색 마이크를 끄고(두 마이크가 동시에 듣지 않게), 휴대폰은 카드를 미리보기로 접는다(자막 자리).
    onSessionStart: () => {
      speechSearchRef.current.stop();
      if (isPhone) setPeekRequest((n) => n + 1);
    },
    getName: (f) => f?.name ?? '',
    // 서버가 고르며 만든 한국어 문장(voiceSpoken)은 한국어 화면에서만, 그 밖에는 카드 값으로 만든 이유.
    getReason: (f) => (locale === 'ko' && f?.voiceSpoken) || (f ? voiceReasonFor(f) : ''),
    // '자세히' — 서버가 상세 문장을 못 줄 때의 폴백. 카드와 같은 분(도보 올림 · 검증된 대기)만 말한다.
    getDetail: (f) => {
      const spot = f?.spot || calculateSPOT(f);
      const travel = displayWalkingMinutes(spot?.expectedTravel);
      const pref = Math.round(spot?.preferencePercent ?? 0);
      const verifiedWait = f?.scoringMode === 'model' && f?.congestionSource !== 'none'
        ? cardTimes(spot?.expectedTravel, spot?.expectedWait, null).waitMin
        : null;
      return verifiedWait !== null
        ? t('recommend.voiceDetail', { wait: verifiedWait, travel, pref })
        : t('recommend.voiceDetailNoWait', { travel, pref });
    },
    onAccept: (f) => handleAccept(f),
    onNext: (f) => handleAdvanceRank(f), // 음성 '다음/별로' → 폐기 안 하고 서버 목록의 다음 순위로
    // 백엔드가 선호에 맞춰 고른 시설로 전환. 그 문장(spoken)은 voiceSpoken 으로 따로 둔다 — 카드의 사유를 덮지 않는다.
    onSelect: (id, spoken) => {
      const target = (rankedFacilities as Facility[]).find((f) => f.id === id) ?? expandGroups(facilities).find((f) => f.id === id);
      if (!target) return;
      setSelectedFacility(spoken ? { ...target, voiceSpoken: spoken } : target);
      if (mapInstanceRef.current && typeof target.latitude === 'number') panToVisible(target.latitude, target.longitude);
    },
    // 백엔드가 선호로 후보를 좁힘. 음식 칩으로 알아들은 말이면 칩을 누른 것과 똑같이 적용한다(I09 — 칩이 켜진다).
    onFilter: (matchIds, spoken) => {
      const chip = pendingVoiceChipRef.current;
      pendingVoiceChipRef.current = null;
      if (chip) {
        applyCuisineChip(chip, { switchCategory: true });
        return;
      }
      const set = new Set(matchIds);
      const pool = expandGroups(facilities)
        .filter((f) => set.has(f.id) && !rejectedIds.has(f.id) && !savedIds.has(f.id));
      if (pool.length === 0) {
        showToast(t('map.voiceNoMatch')); // 빈 결과 → 필터 미적용(현재 카드 유지)
        return;
      }
      setActiveDiscovery(null);
      setDiscoveryLoading(false);
      userPickRef.current = null;
      applyVoiceFilter(set); // ref+state 동시 갱신(effect는 이후 재실행 시 ref로 읽음)
      const ranked = pool.map((f) => ({ ...f, spot: calculateSPOT(f) })).sort(compareFacilities);
      ranked.forEach((f, i) => { f.apiRank = i + 1; f.totalCandidates = ranked.length; });
      setRankedFacilities(ranked);
      setSelectedFacility(spoken ? { ...ranked[0], voiceSpoken: spoken } : ranked[0]);
      if (mapInstanceRef.current && typeof ranked[0].latitude === 'number') panToVisible(ranked[0].latitude, ranked[0].longitude);
    },
    onCommand: (command: VoiceAppCommand) => {
      const typeByFilter: Record<string, PlaceCategory> = {
        '음식점': 'restaurant', '카페': 'cafe', '관광지': 'attraction', '문화시설': 'culture',
      };
      const filterByType: Record<PlaceCategory, string> = {
        restaurant: '음식점', cafe: '카페', attraction: '관광지', culture: '문화시설',
      };
      const currentType = typeByFilter[activeFilter] ?? 'restaurant';
      const transition = buildVoiceCommandTransition(command, currentType, travelContext);
      if (transition.navigation) {
        track('voice_tool_executed', { tool: command.name, status: 'applied', facility_type: currentType });
        router.push(transition.navigation);
        return true;
      }

      const eligible = expandGroups(facilities).some((facility) =>
        facility.type === transition.facilityType
        && !(transition.facilityType === 'restaurant' && isBarFacility(facility))
        && !rejectedIds.has(facility.id)
        && !savedIds.has(facility.id)
        && isClosedToday((facility.features?.rest_date_raw ?? facility.features?.restDateRaw) as string | null | undefined) !== true
        && matchesTravelContext(facility, transition.context, userLocation, haversineMeters)
      );
      const eventProps = {
        tool: command.name,
        status: eligible ? 'applied' : 'no_match',
        facility_type: transition.facilityType,
        max_walk_minutes: transition.context.maxWalkMinutes ?? null,
      };
      track('voice_tool_executed', eventProps);
      if (!eligible) {
        showToast(t('map.voiceNoMatch'));
        return false;
      }

      applyVoiceFilter(null);
      setActiveDiscovery(null);
      setDiscoveryLoading(false);
      cuisineIntentRef.current = null;
      setCuisineChip(null);
      firstViewPendingRef.current = false;
      userPickRef.current = null;
      setActiveFilter(filterByType[transition.facilityType]);
      setTravelContext(transition.context);
      saveTravelContext(transition.context);
      // 말로 바꾼 조건이 화면에 남는다 — 카드 머리의 조건 칩과 이 알림(I67).
      if (command.name === 'set_max_walk_minutes' && transition.context.maxWalkMinutes) {
        showToast(t('voice.appliedWalk', { n: transition.context.maxWalkMinutes }));
      } else if (command.name === 'set_indoor_mode' && transition.context.requiredAttributes.includes('indoor')) {
        showToast(t('voice.appliedIndoor'));
      }
      track('context_applied', {
        categories: transition.context.categories,
        max_walk_minutes: transition.context.maxWalkMinutes ?? null,
        available_minutes: transition.context.availableMinutes ?? null,
        required_attributes: transition.context.requiredAttributes,
        exclude_visited: transition.context.excludeVisited,
      });
      return true;
    },
    // 사용자 발화 해석: (1) 다른 언어 화면은 그 언어의 '네/다음/자세히/그만' 을 바로 (2) 음식 말은 음식 칩과 같은 풀로
    // (3) 나머지는 백엔드 키워드 분류기(/api/v1/voice/turn)로 — 지금 칩 유형의 후보(이름·음식 종류·메뉴·혼잡·거리)를 동봉.
    interpret: async (utterance, f) => {
      const filterMap: Record<string, string> = { '음식점': 'restaurant', '카페': 'cafe', '관광지': 'attraction', '문화시설': 'culture' };
      const type = f?.type || filterMap[activeFilter] || 'restaurant';

      if (locale !== 'ko') {
        const intent = classifyIntent([utterance], locale);
        const action = ({ accept: 'accept', next: 'next', negative: 'next', rejectAll: 'next', detail: 'details', cancel: 'stop' } as Record<string, string>)[intent];
        if (action) return { action };
      }

      const excluded = new Set<string>([...rejectedIds, ...savedIds]);
      const chip = cuisineChipForUtterance(utterance);
      if (chip) {
        const pool = cuisineChipPool(expandGroups(facilities), chip, excluded);
        if (pool.length > 0) {
          pendingVoiceChipRef.current = chip;
          return { action: 'filter', matchIds: pool.map((x) => x.id), spoken: null };
        }
      }

      rankingOriginRef.current = null; // 식당/일반 경로는 사용자 위치 기준 정렬
      // 음식 종류는 camelCase(cuisineTags)까지 읽어 싣고, 술집·관심 없음·저장은 빼고, 가까운 순 30곳(lib/voice/voiceCandidates).
      const cands = voiceCandidatePayload(expandGroups(facilities), { type, origin: userLocation, excludedIds: excluded });
      const res = await voiceTurn(utterance, type, f?.name ?? null, cands, {
        route: 'main',
        facilityType: type as PlaceCategory,
        indoorRequired: travelContext.requiredAttributes.includes('indoor'),
        maxWalkMinutes: travelContext.maxWalkMinutes ?? null,
      });
      // 음식 선호 발화(filter)는 '식당'일 때만 음식 의도로 저장(주차/회의/휴게 선호% 오염 방지).
      if (res.action === 'filter' && type === 'restaurant') cuisineIntentRef.current = utterance;
      // suggestionId: filter 매치 0건일 때의 '유사 대안 제안' — 훅이 2턴(accept→select) 흐름으로 소비.
      return {
        action: res.action,
        targetId: res.targetFacilityId,
        matchIds: res.matchIds,
        spoken: res.spoken,
        suggestionId: res.suggestionId,
        command: res.command,
      };
    },
  });

  // 한 번만 등록되는 Kakao 지도 이벤트 콜백이 항상 '현재' voice(stop/active)를 참조하도록 ref 미러링.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  // 카드가 새로 뜨면(세션 활성 상태) 그 카드의 이유를 자동 발화, 카드가 사라지면 정지.
  // deps에 reason·voiceSpoken 포함 — 같은 시설이라도 사유가 바뀌면 새로 안내(id만 보면 놓침).
  useEffect(() => {
    // Notify the voice assistant about the current recommendation context (for interruption/correction)
    voice.notifyItem(selectedFacility ? selectedFacility : null);
  }, [selectedFacility?.id, selectedFacility?.reason, selectedFacility?.voiceSpoken]);

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
      // 컨테이너를 지역 상수로 붙잡는다: 아래 maps.load 는 비동기 콜백이라, SDK 가 로드되는 사이
      // 사용자가 페이지를 떠나면 mapContainerRef.current 는 null 이 된다(언마운트). 그 상태로
      // new Map(null) 을 부르면 SDK 가 throw 한다 — 콜백 진입 시 다시 확인하고 조용히 빠진다.
      const container = mapContainerRef.current;
      window.kakao.maps.load(() => {
        if (!mapContainerRef.current) return; // 로드 대기 중 언마운트됨

        let centerLat = REGION.center.lat as number;
        let centerLng = REGION.center.lng as number;
        let level = 4;
        // 세션에서 지도 위치를 복원했는지 — 복원한 화면은 사용자가 보던 그대로가 맞으므로
        // 아래 '가시영역 중심 보정'을 건너뛴다(복원값은 이미 보정된 중심의 저장본이기도 하다).
        let restoredCenter = false;

        // 마지막 지도 위치 복원은 '있으면 좋은' 값이다. 그런데 저장소는 읽기만 해도 throw 하는
        // 환경이 있다(프라이빗 모드·인앱 브라우저·서드파티 저장소 차단). 여기서 예외가 새어 나가면
        // 아래 new kakao.maps.Map 에 닿지 못해 mapLoaded 도 mapUnavailable 도 영영 켜지지 않는다 —
        // 폴링 effect 는 initMap 을 부른 뒤 이미 interval 을 지웠고 8초 타임아웃도 지나간 뒤라,
        // 지도도 폴백 UI 도 없는 빈 화면이 그대로 남는다. 복원 실패는 기본 중심/줌으로 떨어진다.
        if (typeof window !== 'undefined') {
          try {
            const savedLat = sessionStorage.getItem('nextspot_map_center_lat');
            const savedLng = sessionStorage.getItem('nextspot_map_center_lng');
            const savedLevel = sessionStorage.getItem('nextspot_map_level');

            if (savedLat && savedLng) {
              const parsedLat = parseFloat(savedLat);
              const parsedLng = parseFloat(savedLng);
              if (!isNaN(parsedLat) && !isNaN(parsedLng)) {
                centerLat = parsedLat;
                centerLng = parsedLng;
                restoredCenter = true;
              }
            }
            if (savedLevel) {
              const parsedLevel = parseInt(savedLevel, 10);
              if (!isNaN(parsedLevel)) {
                level = parsedLevel;
              }
            }
          } catch {
            /* 저장소 차단 — 기본 중심/줌으로 시작한다(지도는 반드시 뜬다) */
          }
        }

        const options = {
          center: new window.kakao.maps.LatLng(centerLat, centerLng),
          level: level,
        };
        const map = new window.kakao.maps.Map(container, options);
        mapInstanceRef.current = map;
        setMapLoaded(true);

        // 첫 진입(복원 없음): 기본 중심(=현재 위치 점)을 전체 화면이 아니라, 상단 칩 바 아래·
        // 우측 카드 패널 왼쪽 '실제 보이는 영역'의 한가운데에 오도록 보정한다.
        // 복원된 중심이라도 '내 위치(지역 중심)'와 사실상 같으면 보정한다 — 사용자가 지도를
        // 옮긴 적 없이 저장된 중심(보정 배포 전 저장본 포함)은 전체 화면 중앙에 점을 놓는
        // 옛 화면을 그대로 재현하기 때문이다. 판별 반경 ±0.0005°(≈50m): 실제로 패닝한 지도는
        // 이보다 크게 벗어나고, 보정된 중심도 통상 줌에서 수백 m 이동이라 재보정되지 않는다.
        const restoredNearMyLocation =
          Math.abs(centerLat - (REGION.center.lat as number)) < 0.0005
          && Math.abs(centerLng - (REGION.center.lng as number)) < 0.0005;
        if (!restoredCenter || restoredNearMyLocation) centerOnFreeArea(centerLat, centerLng);

        // Save center and level on map idle
        setMapLevel(map.getLevel());
        window.kakao.maps.event.addListener(map, 'idle', () => {
          const center = map.getCenter();
          const lvl = map.getLevel();
          setMapLevel(lvl); // 줌 변경 시 마커 밀집도 재계산 트리거
          setMapViewportVersion((version) => version + 1);
          // 위치 기억도 저장소가 막히면 throw 한다. 이 콜백은 지도 idle 마다 SDK 가 부르므로,
          // 예외가 새어 나가면 같은 이벤트에 걸린 다른 리스너까지 지도를 움직일 때마다 끊긴다.
          try {
            sessionStorage.setItem('nextspot_map_center_lat', center.getLat().toString());
            sessionStorage.setItem('nextspot_map_center_lng', center.getLng().toString());
            sessionStorage.setItem('nextspot_map_level', lvl.toString());
          } catch {
            /* 저장소 차단 — 이번 세션의 지도 위치는 기억하지 않는다 */
          }
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
          setSelectedParkingLot(null);
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
    searchMatchLabelsRef.current.forEach((label) => label.setMap(null));
    searchMatchLabelsRef.current = [];

    // 그릴 시설이 없어도 아래로 내려간다 — 빈 목록이면 핀 0개 · 칠한 핀 0개로 끝난다(마커 잔상 · 낡은 범례 방지).

    // 표시 시설 선택(카테고리 필터 + 이름 검색 + 줌 밀집도 상한)을 computeDisplayFacilities 로 통일.
    // markerFacilities 는 '지금'=실측, 예측 모드=예측 혼잡도가 반영된 파생 목록 → 마커가 자동 재채색된다.
    const displayFacilities = computeDisplayFacilities(markerFacilities);

    // 핀 모양은 lib/map/markerSvg.pinDisplay 한 곳에서 정한다(계획 B3): 24시간 안쪽 실측만 등급색으로 꽉 찬 핀,
    // 나머지는 옅은 빈 핀, 서버 상위 추천은 금색 고리 + 순위. 예측(+N시간) 중이면 순위 핀이 그 시각의 이 일대(또는
    // 장소별 모델) 예측 등급을 흰 점선 고리로. 추정(주차+관광 통계)은 핀을 칠하지 않는다(PM 4.3).
    const isNarrow = typeof window !== 'undefined' && window.innerWidth < 768;
    const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('nextspot-dark');
    const paintNow = new Date();
    let graded = 0;

    const newMarkers = displayFacilities.map((f) => {
      // 관광 POI는 모두 핀 마커(바닥 앵커).
      // 그룹 마커는 activeGroupId 로, 개별 마커는 selectedFacility 로 선택 판정 → 둘 다 진한 색 + 확대
      const isSel = f.isGroup
        ? activeGroupId === f.id
        : ((f.type === 'parking' && selectedParkingLot?.id === f.id)
          || (!!selectedFacility && f.id === selectedFacility.id));
      const rank = f.isGroup ? (f.pinRank ?? null) : (pinRankById.get(String(f.id)) ?? null);
      const forecastLevel = !stripForecast
        ? null
        : stripForecast.basis === 'model'
          ? (stripForecast.predictions[String(f.id)]?.level ?? null)
          : rank ? stripForecast.level : null;
      const display = pinDisplay({
        type: f.type,
        level: f.type === 'parking' ? (f.live ? f.congestionLevel : null) : f.isGroup ? f.pinLevel : f.congestionLevel,
        observedAt: f.type === 'parking' ? f.observedAt : f.isGroup ? f.pinObservedAt : (f.congestionTimestamp ?? f.lastUpdated),
        source: f.congestionSource ?? f.source,
        rank,
        forecastMode,
        forecastLevel,
        selected: isSel,
        phone: isNarrow,
        busyAt,
        now: paintNow,
      });
      if (display.style === 'filled') graded += 1;
      const markerImage = new kakao.maps.MarkerImage(
        pinSvg(display, f.type, { selected: isSel, dark }),
        new kakao.maps.Size(display.width, display.height),
        { offset: new kakao.maps.Point(display.width / 2, display.height) }
      );

      const marker = new kakao.maps.Marker({
        position: new kakao.maps.LatLng(f.latitude, f.longitude),
        image: markerImage,
        title: f.name,
      });
      marker.setZIndex(display.zIndex); // 선택 > 순위 > 등급 > 빈 핀

      kakao.maps.event.addListener(marker, "click", () => {
        if (activeOverlayRef.current) {
          activeOverlayRef.current.setMap(null);
          activeOverlayRef.current = null;
        }
        // 축제 핀/영역이 떠 있으면 함께 정리한다(마커 클릭은 지도 click 이벤트를 발생시키지 않아
        // 지도 click 핸들러의 정리 로직이 실행되지 않으므로, 여기서도 명시적으로 지운다).
        clearFestivalOverlay();

        if (f.type === 'parking') {
          setActiveGroupId(null);
          setSelectedFacility(null);
          setSelectedParkingLot(f as ParkingLot);
          panToVisible(f.latitude, f.longitude);
          return;
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
              selectFacilityWithHoursGuard(sub);
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
          mapInstanceRef.current?.panTo(marker.getPosition());
        } else {
          setActiveGroupId(null);
          if (selectFacilityWithHoursGuard(f)) {
            panToVisible(f.latitude, f.longitude);
          }
        }
      });

      marker.setMap(mapInstanceRef.current);
      // 등록된 로컬 검색 결과도 이름을 핀 위에 표시한다. 단시푸딩과 같은 필지의 Kakao
      // 기본지도 GS25 라벨이 겹쳐도, 검색 직후 사용자가 선택한 점포를 명확히 구분한다.
      if (searchQuery.trim()) {
        const label = document.createElement('div');
        label.className = 'rounded-full border border-gold/50 bg-white/95 px-2.5 py-1 text-[11px] font-bold text-muk shadow-[0_2px_10px_rgba(43,35,32,0.14)] whitespace-nowrap';
        label.textContent = f.name;
        const labelOverlay = new window.kakao.maps.CustomOverlay({
          position: marker.getPosition(),
          content: label,
          yAnchor: 3.2,
          zIndex: 80,
          clickable: false,
        });
        labelOverlay.setMap(mapInstanceRef.current);
        searchMatchLabelsRef.current.push(labelOverlay);
      }
      return marker;
    });

    markersRef.current = newMarkers;
    setGradedPinCount((count) => (count === graded ? count : graded));
    // selectedFacility 변경 시에도 다시 그려 선택 핀만 크게(기존 마커는 effect 시작부에서 정리).
    // stripForecast: 예측(+N시간)을 받거나 지우면 순위 핀이 다시 칠해진다. pinRankById: 추천 목록이 바뀌면 고리가 옮겨 간다.
    // busyAt: 운영자 혼잡 경계는 부팅 뒤 비동기로 도착한다. dep 에 없으면 마커가 기본 경계로 칠해진 채 남아 배지와 색이 어긋난다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerFacilities, activeFilter, mapLoaded, selectedFacility?.id, selectedParkingLot?.id, activeGroupId, mapLevel, mapViewportVersion, searchQuery, busyAt, stripForecast, pinRankById]);

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

    // 열지도에 칠할 점(= 혼잡을 말할 **실측 근거가 있는** 좌표)만 모은다(사용자 결정 2026-09-20 — 실측 전용,
    // lib/congestionEstimate.test.ts 가 이 블록을 지킨다). 계획 B3: 장소 점은 24시간 안쪽에 잰 곳만(핀과 같은 선),
    // 공영주차장은 경주시 ITS 실시간 잔여면 그 자리에만 — 주변 주차 수요를 추천 장소 좌표에 옮겨 칠하던 점은 뺐다
    // (그 장소를 잰 값이 아니다).
    //   1) 지도에 뜬 시설의 실측   2) 지금 카드가 비교 중인 추천 후보의 실측
    //   3) 경주시 ITS 공영주차장 실시간 잔여면   4) 테마 대표 랜드마크(앵커)의 실측
    const heatPoints = new Map<string, { lat: number; lng: number; level: number }>();
    const addHeatPoint = (id: unknown, lat: unknown, lng: unknown, level: unknown) => {
      const key = String(id ?? '');
      if (!key || heatPoints.has(key)) return;
      if (typeof lat !== 'number' || typeof lng !== 'number') return;
      if (typeof level !== 'number' || !Number.isFinite(level)) return;
      heatPoints.set(key, { lat, lng, level: Math.max(0, Math.min(1, level)) });
    };
    const heatNow = new Date();
    const measuredLevel = (f: Facility | null | undefined): number | null => (
      f && isPaintableMeasurement({ level: f.congestionLevel, observedAt: f.congestionTimestamp ?? f.lastUpdated, source: f.congestionSource ?? f.source }, heatNow)
        ? f.congestionLevel
        : null
    );

    const displayFacilities = computeDisplayFacilities(markerFacilities)
      .flatMap((f) => (f.isGroup && Array.isArray(f.subFacilities)) ? f.subFacilities : [f]);
    displayFacilities.forEach((f) => {
      addHeatPoint(f.id, f.latitude, f.longitude, f.type === 'parking' ? (f.live ? f.congestionLevel : null) : measuredLevel(f));
    });
    (rankedFacilities as Facility[]).forEach((f) => {
      addHeatPoint(f?.id, f?.latitude, f?.longitude, measuredLevel(f));
    });
    heatParkingLots.forEach((lot) => {
      addHeatPoint(`parking-${lot.id}`, lot.latitude, lot.longitude, lot.occupancy);
    });
    DISCOVERY_THEMES.forEach((theme) => {
      const anchor = findDiscoveryAnchor(expandGroups(facilities), theme) as Facility | null;
      if (!anchor) return;
      addHeatPoint(anchor.id, anchor.latitude, anchor.longitude, measuredLevel(anchor));
    });

    const overlays = [...heatPoints.values()].map((point) => {
      const size = getHeatRadius(point.level);
      const blob = document.createElement('div');
      blob.style.width = `${size}px`;
      blob.style.height = `${size}px`;
      blob.style.borderRadius = '50%';
      blob.style.background = getHeatGradient(point.level, busyAt);
      blob.style.mixBlendMode = 'screen'; // 겹칠수록 가산 합성되어 번지는 열지도 효과
      blob.style.pointerEvents = 'none';

      const overlay = new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(point.lat, point.lng),
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
    // rankedFacilities/estimateById/facilities 도 dep 이다 — 추천이 바뀌거나 추정 피드가 도착하면
    // 열지도도 같은 사실을 따라가야 한다(카드와 지도가 다른 말을 하지 않도록).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerFacilities, activeFilter, mapLoaded, mapLevel, mapViewportVersion, searchQuery, showHeatmap, busyAt, rankedFacilities, heatParkingLots, facilities]);

  const filters = [
    { id: '음식점', key: 'restaurant', icon: Utensils },
    { id: '카페', key: 'cafe', icon: Coffee },
    { id: '관광지', key: 'attraction', icon: MapPin },
    { id: '문화시설', key: 'culture', icon: Building2 },
    { id: '주차장', key: 'parking', icon: Car },
  ];

  // 카테고리 칩 전환 — 칩 탭 · ♿ 자동 전환 · 다른 칩 제안 카드가 같은 길을 탄다.
  const selectCategory = (filterId: string) => {
    firstViewPendingRef.current = false;
    userPickRef.current = null;
    setActiveDiscovery(null);
    setDiscoveryLoading(false);
    setActiveFilter(filterId);
    setActiveGroupId(null);
    setSelectedParkingLot(null);
    if (filterId === '주차장') setShowHeatmap(false);
    applyVoiceFilter(null); // 카테고리 전환 시 음성 선호 필터(예: 양식) 해제(ref+state)
    setCuisineChip(null);   // 세부분류 칩도 함께 해제(음식점 외 카테고리로 새지 않게)
    cuisineIntentRef.current = null;
    // 필터(섹션) 전환 시 열려있던 모둠 팝업도 닫기
    if (activeOverlayRef.current) {
      activeOverlayRef.current.setMap(null);
      activeOverlayRef.current = null;
    }
    if (typeof window !== 'undefined') {
      // 저장소가 막힌 환경에서 여기서 throw 하면 필터 전환 클릭이 통째로 예외로 끝난다
      // (지도 초기화와 같은 부류 — 위 initMap 주석 참조). 기억 못 하는 건 감수한다.
      try { sessionStorage.setItem('nextspot_active_filter', filterId); } catch { /* 저장소 차단 */ }
    }
  };

  // 세부 음식분류 칩 — kw 는 lib/recommender.cuisineMatch 의 의도 키워드(라벨은 i18n cuisine.*).
  // 음식점 카테고리에서만 노출. TourAPI POI 는 cat3 매핑, 시드는 음식 태그/공식 메뉴/상호명으로 매칭된다.
  // 칩 목록과 후보 풀은 음성과 같은 것을 쓴다(lib/voice/voiceCandidates) — 말해도 누른 것과 같은 결과(I09).
  const cuisineChips = CUISINE_CHIPS;
  // 온보딩에서 고른 음식(있으면) — 데스크톱 🍽 메뉴 ▾ 의 안내 문구와 휴대폰 시트의 칩 고리(계획 B3 · A12 I39).
  // 고른 것만 알려 준다(거르지 않는다) — 그 취향은 이미 추천의 취향 일치율에 들어가 있다.
  const setupCuisine = travelContext.cuisine;
  const setupCuisineHint = setupCuisine ? t('map.menuSetupHint', { cuisine: t(SETUP_FOOD_KEY[setupCuisine]) }) : null;
  const setupCuisineChipId = setupCuisine ? SETUP_CUISINE_CHIP[setupCuisine] ?? null : null;
  // 툴바 둘째 줄 칩(히트맵·♿·🅿·🐾) — 불투명 바탕, 켜지면 청록.
  const layerChipClass = (on: boolean) => `flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
    on ? 'border-jade bg-jade/15 text-muk' : 'border-line bg-white text-muk-soft hover:border-jade/60 hover:text-muk'
  }`;

  // 칩 적용 — 칩 탭과 음성 음식 요청이 같은 길: 매칭 id 집합 → applyVoiceFilter(마커·추천 풀 공통 필터)
  // + cuisineIntent(선호%를 음식 매칭도로 재산정) + 필터 내 SPOT #1 즉시 선택. 목록 순위도 그 풀로 바꾼다
  // (머리 배지가 '베스트 추천 → 2번째 …' 로 말하게). switchCategory: 음식점 칩이 아닐 때 음식점으로 옮긴다(음성).
  const applyCuisineChip = (chip: CuisineChip, options: { switchCategory?: boolean } = {}): boolean => {
    const pool = cuisineChipPool(expandGroups(facilities), chip, new Set<string>([...rejectedIds, ...savedIds]));
    if (pool.length === 0) {
      showToast(t('cuisine.noMatch'));
      return false;
    }
    setActiveDiscovery(null);
    setDiscoveryLoading(false);
    firstViewPendingRef.current = false;
    userPickRef.current = null;
    if (options.switchCategory && activeFilter !== '음식점') {
      setActiveFilter('음식점');
      setActiveGroupId(null);
      setSelectedParkingLot(null);
      try { sessionStorage.setItem('nextspot_active_filter', '음식점'); } catch { /* 저장소 차단 */ }
    }
    setCuisineChip(chip.id);
    cuisineIntentRef.current = chip.kw;
    applyVoiceFilter(new Set(pool.map((f) => f.id)));
    const ranked = pool.map((f) => ({ ...f, spot: calculateSPOT(f) })).sort(compareFacilities);
    ranked.forEach((f, i) => { f.apiRank = i + 1; f.totalCandidates = ranked.length; });
    setRankedFacilities(ranked);
    if (selectFacilityWithHoursGuard(ranked[0])
      && mapInstanceRef.current && typeof ranked[0].latitude === 'number') {
      panToVisible(ranked[0].latitude, ranked[0].longitude);
    }
    return true;
  };

  // 칩 선택 — 같은 칩을 다시 누르면 해제. null = 해제.
  const selectCuisineChip = (chip: CuisineChip | null) => {
    if (!chip || cuisineChip === chip.id) {
      setActiveDiscovery(null);
      setDiscoveryLoading(false);
      setCuisineChip(null);
      cuisineIntentRef.current = null;
      applyVoiceFilter(null);
      return;
    }
    applyCuisineChip(chip);
  };

  // 밤의 첫 화면(계획 B2 잔여 항목): 처음 열린 칩에 지금 추천할 곳이 없으면 한 번만, 지금 카드에 올릴 수 있는 곳
  // (조건 · 영업 확인 통과)이 가장 많은 칩을 열고 짧게 알린다. 사용자가 칩을 직접 누른 뒤에는 하지 않는다 —
  // 그때는 종전대로 제안 카드가 고를 칩을 보여 준다(A5).
  const maybeSwitchFirstView = (current: PlaceCategory) => {
    if (!firstViewPendingRef.current) return;
    firstViewPendingRef.current = false;
    const excluded = new Set<string>([...rejectedIdsRef.current, ...savedIdsRef.current]);
    const counts: Partial<Record<PlaceCategory, number>> = {};
    for (const { type } of CATEGORY_FILTERS) {
      counts[type] = chipCandidates(
        facilities.filter((f) => f.type === type && !(type === 'restaurant' && isBarFacility(f))),
        travelContext,
        (context) => (f: Facility) => matchesTravelContext(f, context, userLocation, haversineMeters),
      ).items.filter((f) => !excluded.has(f.id) && isRecommendationOpen(f.type, (f as any).operatingHours)).length;
    }
    const next = pickFirstViewCategory(counts, current);
    if (!next) return;
    const nextFilter = CATEGORY_FILTERS.find((filter) => filter.type === next)?.id;
    if (!nextFilter) return;
    selectCategory(nextFilter);
    const from = t(`category.${current}`);
    const to = t(`category.${next}`);
    const ko = locale === 'ko';
    showToast(t('map.firstViewSwitched', {
      from: ko ? `${from}${hasFinalConsonant(from) ? '이' : '가'}` : from,
      to: ko ? `${to}${hasFinalConsonant(to) ? '을' : '를'}` : to,
    }));
  };

  // 지금 걸린 여행 조건(도보 N분 이내 · 실내 · 무장애) — 카드 머리의 칩, ✕ 로 바로 푼다(계획 B2 9번 · I67).
  const cardConditions: CardCondition[] = [
    ...(travelContext.maxWalkMinutes
      ? [{ key: 'walk' as const, label: t('condition.walk', { n: travelContext.maxWalkMinutes }), name: t('condition.walkName', { n: travelContext.maxWalkMinutes }) }]
      : []),
    ...(travelContext.requiredAttributes.includes('indoor')
      ? [{ key: 'indoor' as const, label: t('condition.indoor'), name: t('condition.indoorName') }]
      : []),
    ...(showBarrierFree
      ? [{ key: 'barrierFree' as const, label: t('condition.barrierFree'), name: t('condition.barrierFreeName') }]
      : []),
  ];
  const removeCondition = (key: CardCondition['key']) => {
    // 도보 제한은 키 자체를 뺀다 — undefined 로 남기면 서버로 null 이 실려 간다(lib/travelContext relaxWalkLimit 와 같은 이유).
    const next: TravelContext = key === 'walk'
      ? (relaxWalkLimit(travelContext) ?? travelContext)
      : {
          ...travelContext,
          requiredAttributes: travelContext.requiredAttributes.filter((attribute) =>
            attribute !== (key === 'indoor' ? 'indoor' : 'accessible')),
        };
    setTravelContext(next);
    saveTravelContext(next);
    track('context_applied', {
      categories: next.categories,
      max_walk_minutes: next.maxWalkMinutes ?? null,
      available_minutes: next.availableMinutes ?? null,
      required_attributes: next.requiredAttributes,
      exclude_visited: next.excludeVisited,
    });
  };

  // (c) 검색 결과 유무 — 현재 카테고리에서 이름 일치 마커가 0건이면 '빈 지도' 혼란을 막기 위해 안내를 띄운다.
  const _filterTypeMap: Record<string, string> = { '음식점': 'restaurant', '카페': 'cafe', '관광지': 'attraction', '문화시설': 'culture', '주차장': 'parking' };
  const searchActive = searchQuery.trim() !== '';
  // 빈 상태 배지 4종을 각각 facilities.filter로 재순회하지 않고, 관련 상태가 바뀔 때 한 번만 집계한다.
  const { searchMatchCount, barrierFreeMatchCount, parkingMatchCount, petMatchCount } = useMemo(() => {
    const targetType = _filterTypeMap[activeFilter];
    const query = searchQuery.trim();
    let search = 0, barrier = 0, parking = 0, pet = 0;
    const searchPool = activeFilter === '주차장' ? parkingLots : facilities;
    for (const f of searchPool) {
      if (query && facilityMatchesSearch(f as Facility, query)) search += 1;
    }
    for (const f of facilities) {
      if (f.type !== targetType) continue;
      if ((f?.barrierFree ?? f?.barrier_free ?? f?.features?.barrier_free) === true) barrier += 1;
      if (parseAvailability(f?.features?.parking as string | null | undefined) === true) parking += 1;
      if (parseAvailability((f?.features?.chk_pet ?? f?.features?.chkPet) as string | null | undefined) === true) pet += 1;
    }
    return {
      searchMatchCount: searchActive ? search : 0,
      barrierFreeMatchCount: showBarrierFree ? barrier : 0,
      parkingMatchCount: showParkingFilter ? parking : 0,
      petMatchCount: showPetFilter ? pet : 0,
    };
  }, [facilities, parkingLots, activeFilter, searchQuery, searchActive, showBarrierFree, showParkingFilter, showPetFilter]);

  // ♿ 무장애 확인 장소 수(유형별, 지도 핀과 같은 판정) — 넷 다 0이면 칩을 숨기고(🐾 와 같은 규칙),
  // 켜는 순간 지금 칩이 0곳이면 가장 많은 칩으로 옮긴다.
  const barrierFreeByType = useMemo(() => {
    const counts: Record<PlaceCategory, number> = { restaurant: 0, cafe: 0, attraction: 0, culture: 0 };
    for (const f of facilities) {
      if (f.type in counts && (f?.barrierFree ?? f?.barrier_free ?? f?.features?.barrier_free) === true) {
        counts[f.type as PlaceCategory] += 1;
      }
    }
    return counts;
  }, [facilities]);
  const barrierFreeAnywhere = Object.values(barrierFreeByType).some((count) => count > 0);
  // ♿ 를 켰을 때 칩마다 **카드에 오를 수 있는** 무장애 장소 수 — 추천 effect·제안 카드와 같은 조건(chipCandidates).
  // 핀 수(위)로만 고르면 핀은 있지만 걸어갈 거리 밖인 칩에 머물러 카드도 제안도 없는 빈 지도가 됐다(10-06 실측).
  const barrierFreeCandidatesByType = useMemo(() => {
    const accessible = travelContext.requiredAttributes.includes('accessible')
      ? travelContext
      : { ...travelContext, requiredAttributes: [...travelContext.requiredAttributes, 'accessible' as const] };
    const counts: Record<PlaceCategory, number> = { restaurant: 0, cafe: 0, attraction: 0, culture: 0 };
    for (const { type } of CATEGORY_FILTERS) {
      counts[type] = chipCandidates(
        facilities.filter((f) => f.type === type && !(type === 'restaurant' && isBarFacility(f))),
        accessible,
        (context) => (f: Facility) => matchesTravelContext(f, context, userLocation, haversineMeters),
      ).items.length;
    }
    return counts;
  }, [facilities, travelContext, userLocation]);
  // 무장애 확인 핀(이 유형)을 지도 한 화면에 모은다 — 카드에 오를 곳이 없어도 어디에 있는지는 보여 준다.
  const fitBarrierFreePins = (type: PlaceCategory) => {
    const map = mapInstanceRef.current;
    if (!map || typeof window === 'undefined' || !window.kakao) return;
    const pins = facilities.filter((f) => f.type === type
      && (f?.barrierFree ?? f?.barrier_free ?? f?.features?.barrier_free) === true
      && Number.isFinite(f.latitude) && Number.isFinite(f.longitude));
    if (pins.length === 0) return;
    if (pins.length === 1) {
      centerOnFreeArea(pins[0].latitude, pins[0].longitude);
      return;
    }
    const bounds = new window.kakao.maps.LatLngBounds();
    pins.forEach((f) => bounds.extend(new window.kakao.maps.LatLng(f.latitude, f.longitude)));
    // 보이는 띠(톱바·추천 패널·예측 줄·미리보기를 뺀 곳) 안에 맞춘다 — panToVisible 과 같은 가림 폭. 지도 높이의 절반은 넘지 않게.
    const h = mapContainerRef.current?.clientHeight || 0;
    const insets = mapInsets();
    const top = Math.min(insets.top, Math.round(h * 0.5));
    const bottom = Math.min(insets.bottom, Math.round(h * 0.4));
    try { map.setBounds(bounds, top + 16, (insets.right || 8) + 16, bottom + 16, 24); } catch { /* 투영 실패 — 지도는 그대로 둔다 */ }
  };
  const onBarrierFreeChip = () => {
    toggleBarrierFree();
    // 켜는 순간 지금 칩에 카드에 오를 무장애 장소가 없으면 빈 지도로 두지 않고 가장 많은 칩으로 옮긴다.
    const current = CATEGORY_FILTERS.find(({ id }) => id === activeFilter);
    if (showBarrierFree || !current || barrierFreeCandidatesByType[current.type] > 0) return;
    const best = CATEGORY_FILTERS
      .map((filter) => ({ ...filter, count: barrierFreeCandidatesByType[filter.type] }))
      .sort((a, b) => b.count - a.count)[0];
    if (best.count > 0) {
      selectCategory(best.id);
      showToast(t('map.barrierFreeSwitched', { category: t(`category.${best.type}`), n: best.count }));
      return;
    }
    // 어느 칩에도 카드에 오를 곳이 없다(전부 걸어갈 거리 밖 등) — 무장애 핀이 있는 칩에서 그 핀들로 지도를
    // 맞춘다. 카드 자리에는 제안 카드가 '지도에 N곳' 을 말한다(아래 category-suggestion).
    const pinFilter = barrierFreeByType[current.type] > 0
      ? current
      : CATEGORY_FILTERS
        .map((filter) => ({ ...filter, count: barrierFreeByType[filter.type] }))
        .sort((a, b) => b.count - a.count)[0];
    if (pinFilter.id !== activeFilter) selectCategory(pinFilter.id);
    fitBarrierFreePins(pinFilter.type);
  };

  // 칩에 추천할 곳이 없을 때 대신 보여 줄 다른 칩과 그 후보 수 — 추천 effect 와 같은 조건(chipCandidates).
  const suggestedCategories = useMemo(() => {
    if (!noRecommendation) return [];
    return CATEGORY_FILTERS
      .filter(({ id }) => id !== activeFilter)
      .map(({ id, type }) => ({
        id,
        type,
        count: chipCandidates(
          facilities.filter((f) => f.type === type && !(type === 'restaurant' && isBarFacility(f))),
          travelContext,
          (context) => (f: Facility) => matchesTravelContext(f, context, userLocation, haversineMeters),
        ).items.length,
      }))
      .filter(({ count }) => count > 0);
  }, [noRecommendation, activeFilter, facilities, travelContext, userLocation]);
  // ♿ 가 켜졌는데 고를 칩이 없을 때(카드에 오를 무장애 장소가 어디에도 없음) — 빈 칸 대신 무장애 핀을 가리킨다.
  // 지금 칩에 핀이 있으면 그 수와 '지도에서 보기', 없으면 핀이 있는 다른 칩.
  const activeCategoryType = CATEGORY_FILTERS.find(({ id }) => id === activeFilter)?.type ?? null;
  const barrierFreePinsHere = showBarrierFree && activeCategoryType ? barrierFreeByType[activeCategoryType] : 0;
  const barrierFreePinChips = showBarrierFree && suggestedCategories.length === 0 && barrierFreePinsHere === 0
    ? CATEGORY_FILTERS
      .filter(({ id, type }) => id !== activeFilter && barrierFreeByType[type] > 0)
      .map((filter) => ({ ...filter, count: barrierFreeByType[filter.type] }))
    : [];

  // Kakao 시설명 검색 — 등록 여부와 현재 카테고리에 관계없이 지점·작은 점포까지 찾는다.
  useEffect(() => {
    const sequence = ++placeSearchSequenceRef.current;
    if (searchResultMarkerRef.current) {
      searchResultMarkerRef.current.setMap(null);
      searchResultMarkerRef.current = null;
    }
    if (searchResultLabelRef.current) {
      searchResultLabelRef.current.setMap(null);
      searchResultLabelRef.current = null;
    }
    const q = searchQuery.trim();
    // 한 글자 입력과 로컬에서 이미 찾은 질의는 외부 검색을 호출하지 않는다. 타이핑할 때마다
    // Kakao 쿼터를 소진하거나 429로 검색 전체가 잠기는 것을 막는다.
    if (!searchActive || q.length < 2 || searchMatchCount > 0) {
      setLiveSearchItems([]);
      setLiveSearchLoading(false);
      setTourApiItems([]);
      setTourApiAsked(false);
      if (q.length >= 2 && searchMatchCount > 0 && mapInstanceRef.current) {
        const pool = activeFilter === '주차장' ? parkingLots : facilities;
        const matches = pool.filter((facility) => facilityMatchesSearch(facility as Facility, q));
        const nearest = matches.sort((a, b) => (
          haversineMeters(userLocation.lat, userLocation.lng, a.latitude, a.longitude)
          - haversineMeters(userLocation.lat, userLocation.lng, b.latitude, b.longitude)
        ))[0];
        if (nearest && Number.isFinite(nearest.latitude) && Number.isFinite(nearest.longitude)) {
          mapInstanceRef.current.setLevel(3);
          panToVisible(nearest.latitude, nearest.longitude);
        }
      }
      // 찾은 장소(우리 DB)가 곧 카드다 — 지도만 옮기고 옛 추천을 그대로 두면 검색이 카드와 따로 논다(I84).
      // 음성 검색도 같은 길이다(받아쓴 말이 검색어가 된다).
      if (q.length >= 2 && searchMatchCount > 0 && activeFilter !== '주차장') {
        const hit = facilities
          .filter((facility) => facilityMatchesSearch(facility as Facility, q))
          .sort((a, b) => (
            haversineMeters(userLocation.lat, userLocation.lng, a.latitude, a.longitude)
            - haversineMeters(userLocation.lat, userLocation.lng, b.latitude, b.longitude)
          ))[0];
        if (hit && String(selectedFacilityRef.current?.id ?? '') !== String(hit.id)) {
          const listed = (rankedFacilitiesRef.current as Facility[]).find((f) => String(f.id) === String(hit.id));
          userPickRef.current = { id: String(hit.id), filter: activeFilter, kind: 'search' };
          setSelectedFacility({ ...(listed ?? hit), pickKind: 'search' });
        }
      }
      return;
    }
    setLiveSearchLoading(true);
    // 질의가 바뀌었으면 이전 질의의 관광공사 결과는 즉시 버린다. 그대로 두면 Kakao 응답을
    // 기다리는 동안 **다른 검색어의 목록**이 화면에 남아 이번 검색 결과처럼 읽힌다.
    setTourApiItems([]);
    setTourApiAsked(false);
    const timer = setTimeout(async () => {
      let kakaoItems: PlaceSearchItem[] = [];
      try {
        const res = await apiClient.get('/api/v1/search/places', { params: { q }, timeoutMs: 4500 });
        kakaoItems = Array.isArray(res?.items) ? res.items : [];
      } catch (err) {
        console.warn('Kakao 장소 검색 실패 — 무해 폴백(빈 목록):', err);
      }
      if (sequence !== placeSearchSequenceRef.current) return;
      setLiveSearchItems(kakaoItems);
      setLiveSearchLoading(false);
      // 여기서 찾았으면 외부 자료는 꺼내지 않는다 — 우리가 아는 장소를 두고 관광공사 목록을
      // 함께 띄우면 어느 줄이 우리 데이터인지 사용자가 구분할 수 없다.
      if (kakaoItems.length > 0) return;

      // --- 관광공사(TourAPI) 키워드 폴백 ---------------------------------------
      //
      // 배경: 백엔드 GET /api/v1/search/keyword 와 관리자 승인 큐는 살아 있는데 웹 어디에서도
      // 부르지 않고 있었다(전수 확인). 위 상태 선언의 주석은 '[다음 배치 추가 요청]으로 큐잉'
      // 이라고 적고 있었지만 그 버튼이 화면에 없었다 — 여기서 그 배선을 되살린다.
      //
      // 같은 effect 안에서 이어 부르는 이유: 별도 effect 로 빼면 Kakao 응답이 상태로 반영된
      // 뒤에야 시작해 디바운스 350ms 를 한 번 더 기다린다. 순서(로컬 → Kakao → 관광공사)와
      // 취소 판정(placeSearchSequenceRef)도 한 곳에 있어야 서로 어긋나지 않는다.
      setTourApiLoading(true);
      let tourItems: TourApiSearchItem[] = [];
      try {
        const res = await apiClient.get('/api/v1/search/keyword', { params: { q }, timeoutMs: 6000 });
        tourItems = Array.isArray(res?.items) ? (res.items as TourApiSearchItem[]) : [];
      } catch (err) {
        // 키 미설정·TourAPI 장애는 백엔드가 이미 무해 폴백(빈 목록)으로 흡수한다. 여기 오는
        // 것은 네트워크·429 정도라 조용히 빈 목록으로 둔다(검색 자체를 막지 않는다).
        console.warn('관광공사 키워드 검색 실패 — 무해 폴백(빈 목록):', err);
      }
      if (sequence !== placeSearchSequenceRef.current) return;
      setTourApiItems(tourItems);
      setTourApiLoading(false);
      setTourApiAsked(true);
    }, 350);
    return () => clearTimeout(timer);
  }, [activeFilter, facilities, parkingLots, searchActive, searchMatchCount, searchQuery, userLocation.lat, userLocation.lng]);

  // '다음 배치 추가 요청' — 관리자 승인 큐(admin_ingest_requests)에 pending 으로 넣는다.
  // 성공/실패를 그대로 말한다. 실패를 접수된 것처럼 보이게 하면 사용자는 오지 않을 장소를 기다린다.
  const requestIngest = async (item: TourApiSearchItem) => {
    setIngestPendingId(item.contentid);
    try {
      await apiClient.post('/api/v1/search/ingest-request', {
        contentid: item.contentid,
        name: item.title,
        contentTypeId: item.contenttypeid ?? null,
      });
      setIngestRequested((prev) => new Set(prev).add(item.contentid));
      showToast(t('map.ingestRequestDone', { name: item.title }));
    } catch (err) {
      // 서버 문구(레이트리밋·테이블 미준비 안내)가 있으면 그대로 전한다 — 왜 안 됐는지가 정보다.
      showToast(errorMessage(err) || t('map.ingestRequestFailed'));
    } finally {
      setIngestPendingId(null);
    }
  };

  const focusPlaceSearchResult = (item: PlaceSearchItem) => {
    const map = mapInstanceRef.current;
    if (!map || !window.kakao?.maps) return;
    const position = new window.kakao.maps.LatLng(item.latitude, item.longitude);
    if (searchResultMarkerRef.current) searchResultMarkerRef.current.setMap(null);
    if (searchResultLabelRef.current) searchResultLabelRef.current.setMap(null);
    const marker = new window.kakao.maps.Marker({ position, title: item.name });
    marker.setMap(map);
    searchResultMarkerRef.current = marker;
    // Kakao 기본지도에 같은 필지의 GS25 같은 다른 점포명이 보이더라도, 사용자가 선택한
    // 검색 결과의 이름을 핀 위에 명시해 어느 장소를 가리키는지 혼동하지 않게 한다.
    const label = document.createElement('div');
    label.className = 'rounded-full border border-gold/50 bg-white/95 px-3 py-1.5 text-xs font-bold text-muk shadow-[0_2px_10px_rgba(43,35,32,0.16)] whitespace-nowrap';
    label.textContent = item.name;
    const labelOverlay = new window.kakao.maps.CustomOverlay({
      position,
      content: label,
      yAnchor: 2.9,
      zIndex: 90,
      clickable: false,
    });
    labelOverlay.setMap(map);
    searchResultLabelRef.current = labelOverlay;
    map.setLevel(3);
    panToVisible(item.latitude, item.longitude);
  };

  // 소개 화면 바로가기·콘솔 링크(교차 레인 계약 1·2) — 마운트 때 한 번만 읽는다.
  //   ?focus=forecast — 히트맵을 켜고 시간 조절에 고리 · ?focus=live — 관광지(실시간 정보 새로고침이 있는 TourAPI 카드)
  //   ?focus=voice — 음성 비서 알약에 고리 · ?place=<시설 id> — 그 장소를 '선택한 장소' 카드로.
  const urlIntentHandledRef = useRef(false);
  useEffect(() => {
    if (urlIntentHandledRef.current || typeof window === 'undefined') return;
    urlIntentHandledRef.current = true;
    let params: URLSearchParams;
    try { params = new URLSearchParams(window.location.search); } catch { return; }
    const focus = params.get('focus');
    if (focus === 'forecast') {
      setShowHeatmap(true);
      setFocusRing('forecast');
    } else if (focus === 'voice') {
      setFocusRing('voice');
    } else if (focus === 'live') {
      selectCategory('관광지');
    }
    const place = params.get('place');
    if (place) {
      pendingPlaceRef.current = place;
      firstViewPendingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 고리는 잠깐만 — 화면을 한 번 누르거나 10초가 지나면 걷는다.
  useEffect(() => {
    if (!focusRing) return;
    const clear = () => setFocusRing(null);
    const timer = window.setTimeout(clear, 10_000);
    window.addEventListener('pointerdown', clear, { once: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', clear);
    };
  }, [focusRing]);
  // ?place=<id> — 시설 목록이 오면 그 장소의 칩으로 옮기고 그 장소를 카드로 연다(목록 순위와 상관없이 '선택한 장소').
  useEffect(() => {
    const placeId = pendingPlaceRef.current;
    if (!placeId || facilities.length === 0) return;
    const place = expandGroups(facilities).find((f) => String(f.id) === placeId);
    if (!place) return;
    pendingPlaceRef.current = null;
    const filter = CATEGORY_FILTERS.find(({ type }) => type === place.type)?.id ?? activeFilter;
    if (filter !== activeFilter) selectCategory(filter);
    userPickRef.current = { id: placeId, filter, kind: 'place' };
    firstViewPendingRef.current = false;
    setPickingFirst(false);
    setSelectedFacility({ ...place, pickKind: 'place' });
    if (mapInstanceRef.current && typeof place.latitude === 'number') panToVisible(place.latitude, place.longitude);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facilities]);

  // 지도·검색에서 사용자가 직접 고른 장소가 도착 후 30분 안에 닫히면 조용히 바꾸지 않는다.
  // 이유를 먼저 알린 뒤, 서버가 이미 검증한 SPOT 후보 중 다음 장소로 전환한다.
  const selectFacilityWithHoursGuard = (facility: any): boolean => {
    const arrivalStatusFor = (candidate: any) => {
      if (candidate.openStatusAtArrival) return candidate.openStatusAtArrival;
      const latitude = Number(candidate.latitude);
      const longitude = Number(candidate.longitude);
      const distanceM = Number.isFinite(latitude) && Number.isFinite(longitude)
        ? haversineMeters(userLocation.lat, userLocation.lng, latitude, longitude)
        : 0;
      const travelMinutes = displayWalkingMinutes(undefined, distanceM);
      return getArrivalOpenStatus(
        candidate.operatingHours,
        new Date(Date.now() + travelMinutes * 60_000),
      );
    };
    // 추천 목록에 있는 곳이면 목록의 값(서버 사유·근거·순위)으로 연다 — 같은 장소가 핀으로 열 때와 목록으로 열 때
    // 다른 카드가 되지 않게. 사용자가 직접 고른 카드로 기억해 목록이 다시 와도 바꾸지 않는다.
    const listed = (rankedFacilities as Facility[]).find((candidate) => String(candidate.id) === String(facility.id));
    const target = listed ?? facility;
    const arrivalStatus = arrivalStatusFor(target);
    if (arrivalStatus !== 'closing_soon') {
      userPickRef.current = { id: String(target.id), filter: activeFilter, kind: 'pin' };
      setSelectedFacility(target);
      return true;
    }

    const alternative = rankedFacilities.find((candidate) =>
      candidate.id !== facility.id
      && arrivalStatusFor(candidate) === 'open_expected'
    );
    showToast(t(
      alternative ? 'map.closingSoonRedirect' : 'map.closingSoonNoAlternative',
      { name: facility.name },
    ));
    if (alternative) {
      setSelectedFacility(alternative);
      panToVisible(Number(alternative.latitude), Number(alternative.longitude));
    } else {
      setSelectedFacility(null);
      setNoRecommendation(true);
    }
    return false;
  };

  // ── 🔮 혼잡 예측 줄에 넘길 값(계획 B3) ─────────────────────────────────────────────
  const stripPresets = ASSUMED_TIME_PRESETS.filter((p) => p.id !== 'now').map((p) => ({ id: p.id, label: t(p.labelKey) }));
  const activeStripType = CATEGORY_FILTERS.find(({ id }) => id === activeFilter)?.type ?? null;
  const stripBadge = (() => {
    if (!stripForecast) return null;
    const level = forecastHeadlineLevel(
      stripForecast,
      activeStripType ? facilities.filter((f) => f.type === activeStripType).map((f) => String(f.id)) : undefined,
    );
    if (level === null) return null;
    const grade = congestionKey(level, busyAt);
    const levelText = t(`congestion.${grade}`);
    const text = stripForecast.basis === 'area'
      ? t('forecast.badgeArea', { h: stripForecast.hours, level: levelText })
      : `${t('forecast.badgeModel', { h: stripForecast.hours, level: levelText })}${stripForecast.anchored ? '' : ` · ${t('map.forecastEstimateTag')}`}`;
    return { text, grade };
  })();
  // 범례 — 등급이 칠해진 핀이 화면에 있거나, 히트맵·예측이 켜져 있을 때만. 아니면 '지금 이 일대 … · 추정' 칩 하나(추정 피드).
  const showStripLegend = forecastMode || showHeatmap || gradedPinCount > 0;
  const stripLegend = showStripLegend
    ? { title: stripForecast ? t('forecast.legendAhead', { h: stripForecast.hours }) : t('forecast.legendNow'), dashed: forecastMode }
    : null;
  const stripAreaChip = !showStripLegend && areaNowLevel !== null
    ? t('forecast.areaNow', { level: t(`congestion.${congestionKey(areaNowLevel, busyAt)}`) })
    : null;
  const phoneCardExpanded = isPhone && !!selectedFacility && !recalcLabel && !cardPeek;
  const showStrip = activeFilter !== '주차장' && !isLoadingFacilities && !facilitiesLoadError && facilities.length > 0 && !phoneCardExpanded;

  return (
    <div className="relative w-full h-[100dvh] overflow-hidden flex flex-col">

      {/* 지도는 주간에는 채도를 낮춘 Kakao 타일(핀 색이 묻히지 않게), 야간에는 전역 테마의 저휘도 필터를 쓴다. */}
      <div
        ref={mapContainerRef}
        className={`nextspot-map nextspot-main-map w-full h-full absolute inset-0 z-0${mapUnavailable ? ' bg-gradient-to-b from-hanji-deep/70 via-hanji-deep/40 to-hanji' : ''}`}
      />

      {/* 언어 · 시계(계획 B3 — 오른쪽 위, 불투명). 휴대폰은 언어(+출처)가 왼쪽 위, 시계가 오른쪽 위. 데스크톱은 둘이 오른쪽
          위에 나란히 서고, 툴바 첫 줄이 이 묶음의 폭만큼 비운다(topClusterPx). */}
      <div
        ref={topClusterRef}
        className="pointer-events-none absolute inset-x-3 top-[calc(env(safe-area-inset-top)+0.5rem)] z-30 flex items-start justify-between gap-2 md:inset-x-auto md:right-5 md:top-5 md:items-center md:justify-end"
      >
        <div className="flex max-w-[220px] flex-col items-start gap-1 md:max-w-none">
          <LanguageSwitcher className="pointer-events-auto" />
          {/* 휴대폰 출처 — 데스크톱은 툴바 둘째 줄 끝의 출처 칩 하나(P8). */}
          <SourceCredit compact className="md:hidden" />
        </div>
        {/* 장소 카드와 분리된 경주 현지 시계 — 영업 여부·도착 시각의 기준(KST). */}
        {clockLabels && (
          <div
            aria-label={`${clockLabels.date} ${clockLabels.time} KST`}
            className="flex items-center gap-2 rounded-2xl border border-line bg-white px-3 py-2 text-right shadow-[0_3px_16px_rgba(43,35,32,0.12)] md:py-1"
          >
            <Clock3 size={16} className="shrink-0 text-gold" aria-hidden />
            <div className="leading-none">
              <p className="whitespace-nowrap text-[10px] font-semibold text-muk-soft">{clockLabels.date}</p>
              <p className="mt-1 whitespace-nowrap text-[13px] font-extrabold tracking-tight text-muk">
                <span className="mr-1 text-[9px] font-bold tracking-wider text-gold-deep">KST</span>
                {clockLabels.time}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Top Layer: Search & Filters — 판마다 불투명 바탕(지도가 글자 뒤로 비치지 않게). 휴대폰 머리는 280px 안(계획 B3):
          검색 · 날씨/첫 방문 한 줄 · '필터·편의' 가 맨 앞인 칩 한 줄. 키 낮은 휴대폰은 날씨/첫 방문을 검색 줄 옆에 붙인다. */}
      <div ref={topBarRef} className="absolute top-0 w-full z-20 pt-[calc(env(safe-area-inset-top)+4.25rem)] md:pt-5 pb-4 px-4 flex flex-col gap-2 md:gap-4 pointer-events-none">

        {/* 지도 SDK 로드 실패(8초 타임아웃) 안내 칩 — 검색/배리어프리 빈 상태 칩과 동일 스타일 재사용.
            추천 카드 등 나머지 UI 는 지도 유무와 무관하게 계속 동작한다. */}
        {mapUnavailable && (
          <div className="flex justify-center pointer-events-auto">
            <span className="inline-block text-muk text-xs bg-white border border-line rounded-full px-3 py-1 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
              {t('map.loadFailed')}
            </span>
          </div>
        )}

        {/* PC(md+)는 구글맵스식 톱바 — 왼쪽 열(정체성 한 줄 · 검색 · 날씨/첫 방문)과 오른쪽 툴바 판(두 줄)을 나란히.
            모바일은 세로 스택. */}
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:gap-4">

        {/* 왼쪽 열: 정체성 한 줄 + 검색 줄 + 검색 결과 */}
        <div className="flex flex-col gap-2 md:w-[22%] md:min-w-[290px] md:max-w-[400px] md:shrink-0">

        {/* 정체성 한 줄(데스크톱) — 워드마크 + '줄 서는 대신, 경주를 한 곳 더.'(landing.tagline). */}
        <div className="pointer-events-auto hidden w-fit max-w-full items-center gap-2 rounded-full border border-line bg-white px-3 py-1 shadow-[0_2px_10px_rgba(43,35,32,0.08)] md:flex" data-testid="identity-line">
          <Image src="/nextspot-logo.png" alt="NextSpot" width={505} height={109} className="nextspot-logo-light h-4 w-auto shrink-0" />
          <Image src="/nextspot-logo-dark.png" alt="NextSpot" width={505} height={109} className="nextspot-logo-dark h-4 w-auto shrink-0" />
          <span className="min-w-0 text-[12px] font-bold leading-tight text-muk">{t('landing.tagline')}</span>
        </div>

        {/* 검색 줄 — 검색창 + 날씨/첫 방문 알약 줄. 키 낮은 휴대폰(높이 720 미만)은 알약을 검색창 옆에 붙인다. */}
        <div ref={searchRowRef} className="flex flex-col gap-2 short:max-md:flex-row short:max-md:items-center">

        {/* Search Bar — (c) 로컬 시설명 검색(마커 필터). 음성 검색(Mic)은 브라우저 STT 로 받아쓰기 → 검색어 주입.
            (Web Speech 미지원 브라우저에선 '준비 중' 비활성으로 graceful 폴백.) */}
        <div className="flex min-w-0 items-center bg-white rounded-full px-4 py-2.5 short:max-md:flex-1 short:max-md:px-3 short:max-md:py-2 border border-line shadow-[0_2px_14px_rgba(43,35,32,0.06)] pointer-events-auto">
          <Search size={20} className="text-muk-soft mr-3" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('map.searchPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-muk outline-none placeholder:text-muk-soft text-sm"
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
              {speechSearch.listening ? (
                <span className="text-[10px] font-medium whitespace-nowrap">{t('map.voiceSearchListening')}</span>
              ) : (
                // 넓은 화면에서는 무엇을 하는 마이크인지 글자로도 말한다(I84 · 계획 B2 — 아이콘만으로는 음성 비서와 헷갈린다).
                <span className="hidden whitespace-nowrap text-[11px] font-semibold lg:inline">{t('map.voiceSearchLabel')}</span>
              )}
            </button>
          ) : null}
          <NextSpotMascot className="ml-3 w-9 short:max-md:hidden" />
        </div>

        {/* 날씨 · 첫 방문(✨) 알약 한 줄 — 검색 중에는 감춘다(언마운트하지 않아 날씨를 다시 부르지 않는다). */}
        <div className={searchActive ? 'hidden' : 'flex items-center gap-2 short:max-md:shrink-0'}>
          <WeatherChip
            indoorRequired={travelContext.requiredAttributes.includes('indoor')}
            onIndoorRequiredChange={(required) => {
              const requiredAttributes = required
                ? [...new Set([...travelContext.requiredAttributes, 'indoor' as const])]
                : travelContext.requiredAttributes.filter((attribute) => attribute !== 'indoor');
              const next = { ...travelContext, requiredAttributes };
              setTravelContext(next);
              saveTravelContext(next);
              track('context_applied', {
                categories: next.categories,
                max_walk_minutes: next.maxWalkMinutes ?? null,
                available_minutes: next.availableMinutes ?? null,
                required_attributes: next.requiredAttributes,
                exclude_visited: next.excludeVisited,
              });
            }}
          />
          {!isLoadingFacilities && facilities.length > 0 && !activeDiscovery && (
            <button
              type="button"
              onClick={() => setShowDiscoveryThemes((open) => !open)}
              aria-expanded={showDiscoveryThemes}
              title={t('discovery.entryHint')}
              aria-label={t('discovery.entry')}
              className="toss-pressable pointer-events-auto flex h-8 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-gold/40 bg-white px-3 text-[12px] font-extrabold text-muk shadow-[0_2px_10px_rgba(43,35,32,0.08)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
            >
              <span aria-hidden className="text-[14px] leading-none">✨</span>
              <span className="truncate short:max-md:sr-only">{t('discovery.entry')}</span>
              <ChevronDown size={14} className={`shrink-0 text-gold-deep transition-transform ${showDiscoveryThemes ? 'rotate-180' : ''}`} aria-hidden />
            </button>
          )}
        </div>
        </div>{/* /검색 줄 */}

        {/* 검색 결과는 검색창 바로 아래 — 날씨·첫 방문 카드 밑으로 밀리면 찾은 줄이 검색과 떨어져 보인다. */}
        {/* (c) 검색 결과 없음 안내 — 입력값은 있으나 현재 카테고리에 일치 장소가 없을 때.
            관광공사 폴백이 아직 답하지 않았거나 무언가 찾아냈다면 띄우지 않는다 — 바로 아래에
            결과 블록이 뜨는데 그 위에 '검색 결과 없음' 이 함께 있으면 서로 반대되는 말이 된다. */}
        {searchActive && searchMatchCount === 0 && !liveSearchLoading && liveSearchItems.length === 0
          && !tourApiLoading && tourApiItems.length === 0 && (
          <div className="pointer-events-auto px-2 -mt-1">
            <span className="inline-block text-muk text-xs bg-white/90 border border-line rounded-full px-3 py-1 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
              {/* 관광공사 자료까지 물어본 뒤라면 그 사실을 밝힌다(어디까지 찾아봤는지가 정보다). */}
              {tourApiAsked ? t('map.searchNoResultAnywhere', { q: searchQuery.trim() }) : t('map.searchNoResult', { q: searchQuery.trim() })}
            </span>
          </div>
        )}

        {/* 등록 여부와 무관한 Kakao 시설 검색. 결과의 좌표와 주소는 같은 장소 ID에서 온다. */}
        {searchActive && (liveSearchLoading || liveSearchItems.length > 0) && (
          <div data-testid="place-search-results" className="pointer-events-auto rounded-2xl bg-white/95 backdrop-blur border border-line shadow-[0_2px_14px_rgba(43,35,32,0.06)] overflow-hidden">
            <div className="px-3 py-2 border-b border-line/70">
              <p className="text-xs font-semibold text-muk flex items-center gap-1.5">
                <Search size={12} className="text-gold" />
                {t('map.placeSearchTitle')}
              </p>
              <p className="mt-0.5 text-[10px] leading-snug text-muk-soft">{t('map.placeSearchSource')}</p>
            </div>
            {liveSearchLoading ? (
              // 제목이 바로 위에 있다 — '검색 결과…' 를 한 번 더 말하지 않고 도는 표시만 둔다.
              <div aria-busy="true" className="px-3 py-3 flex items-center gap-2 text-xs text-muk-soft">
                <span className="inline-block w-3 h-3 rounded-full border-2 border-gold/40 border-t-gold animate-spin" />
              </div>
            ) : (
              <ul className="max-h-64 overflow-y-auto divide-y divide-line/60">
                {liveSearchItems.map((item) => {
                  return (
                    <li key={item.placeId} className="px-3 py-2.5 flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-muk truncate">{item.name}</p>
                        {item.address && <p className="text-[11px] text-muk-soft truncate">{item.address}</p>}
                        <span className="inline-block mt-1 text-[10px] font-medium text-muk-soft bg-line/60 rounded-full px-2 py-0.5">
                          {item.categoryName || t('map.placeSearchResult')}
                        </span>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <button
                          type="button"
                          onClick={() => focusPlaceSearchResult(item)}
                          title={t('map.placeSearchView')}
                          className="shrink-0 text-[11px] font-semibold rounded-full px-2.5 py-1.5 border text-gold border-gold/50 hover:bg-gold/10 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                        >
                          {t('map.placeSearchView')}
                        </button>
                        {item.placeUrl && (
                          <a
                            href={item.placeUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-1 text-[10px] font-semibold text-muk-soft underline-offset-2 hover:text-muk hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                          >
                            {t('map.searchKakaoPlace')}
                          </a>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {/* 관광공사(TourAPI) 키워드 폴백 — 우리 데이터에도 Kakao 에도 없을 때만.
            출처를 헤더에 못 박아 위 두 목록과 섞이지 않게 한다. 여기 줄들은 아직 우리 DB 에 없는 장소라
            상세 카드가 없다 — 사진·임시 지도 핀·카카오맵 길찾기를 주고, '다음 배치 추가 요청' 으로
            관리자 승인 큐에 넣는다. */}
        {searchActive && (tourApiLoading || tourApiItems.length > 0) && (
          <div data-testid="tourapi-search-results" className="pointer-events-auto rounded-2xl bg-white/95 backdrop-blur border border-jade/40 shadow-[0_2px_14px_rgba(43,35,32,0.06)] overflow-hidden">
            <div className="px-3 py-2 border-b border-line/70">
              <p className="text-xs font-semibold text-muk flex items-center gap-1.5">
                <Search size={12} className="text-jade" />
                {t('map.tourApiTitle')}
              </p>
              <p className="mt-0.5 text-[10px] leading-snug text-muk-soft">{t('map.tourApiSource')}</p>
            </div>
            {tourApiLoading ? (
              // 제목이 바로 위에 있다 — '검색 결과…' 를 한 번 더 말하지 않고 도는 표시만 둔다.
              <div aria-busy="true" className="px-3 py-3 flex items-center gap-2 text-xs text-muk-soft">
                <span className="inline-block w-3 h-3 rounded-full border-2 border-jade/40 border-t-jade animate-spin" />
              </div>
            ) : (
              <ul className="max-h-64 overflow-y-auto divide-y divide-line/60">
                {tourApiItems.map((item) => {
                  const requested = ingestRequested.has(item.contentid);
                  const pending = ingestPendingId === item.contentid;
                  // 좌표가 있으면 임시 지도 핀과 카카오맵 길찾기를 바로 준다 — 아직 우리 DB 에 없어도 갈 수는 있다.
                  const lat = typeof item.mapy === 'number' && Number.isFinite(item.mapy) ? item.mapy : null;
                  const lng = typeof item.mapx === 'number' && Number.isFinite(item.mapx) ? item.mapx : null;
                  return (
                    <li key={item.contentid} className="px-3 py-2.5 flex items-start gap-3">
                      {item.firstimage && (
                        // TourAPI 대표 사진(도메인이 다양해 next/image 최적화 대상이 아님 — 정적 export). 깨지면 자리를 접는다.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.firstimage}
                          alt=""
                          loading="lazy"
                          onError={(event) => { event.currentTarget.style.display = 'none'; }}
                          className="h-12 w-12 shrink-0 rounded-xl border border-line object-cover"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-muk truncate">{item.title}</p>
                        {item.addr1 && <p className="text-[11px] text-muk-soft truncate">{item.addr1}</p>}
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {lat !== null && lng !== null && (
                            <>
                              <button
                                type="button"
                                onClick={() => focusPlaceSearchResult({
                                  placeId: item.contentid, name: item.title, latitude: lat, longitude: lng, address: item.addr1 ?? '',
                                })}
                                className="text-[11px] font-bold rounded-full px-2.5 py-1.5 bg-jade text-white hover:bg-jade/90 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-jade/60"
                              >
                                {t('map.placeSearchView')}
                              </button>
                              <a
                                href={`https://map.kakao.com/link/to/${encodeURIComponent(item.title)},${lat},${lng}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] font-semibold rounded-full px-2.5 py-1.5 border text-jade border-jade/50 hover:bg-jade/10 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-jade/60"
                              >
                                {t('map.searchKakaoRoute')}
                              </a>
                            </>
                          )}
                          {/* 접수된 뒤에는 버튼을 '접수됨' 으로 잠근다 — 같은 줄을 다시 눌러도
                              백엔드가 조용히 무시하므로(contentid UNIQUE) 눌리는 버튼을 남겨 두면
                              아무 일도 일어나지 않는 조작을 주는 셈이다. 갈 길(위 두 버튼)이 먼저라 보조 버튼이지만,
                              기능설명서가 이름으로 부르는 단계라 옆 버튼과 같은 알약 모양으로 찾을 수 있게 둔다. */}
                          <button
                            type="button"
                            onClick={() => requestIngest(item)}
                            disabled={requested || pending}
                            className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-muk-soft hover:border-jade/50 hover:text-jade transition-colors disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:border-line disabled:hover:text-muk-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-jade/60"
                          >
                            {requested ? t('map.ingestRequested') : pending ? `${t('map.ingestRequest')}…` : t('map.ingestRequest')}
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {!isLoadingFacilities && facilities.length > 0 && showDiscoveryThemes && !activeDiscovery && !searchActive && (
          <section className="pointer-events-auto rounded-3xl border border-gold/30 bg-white/95 p-4 shadow-[0_8px_28px_rgba(43,35,32,0.13)] backdrop-blur">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-extrabold text-muk">{t('discovery.title')}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muk-soft">{t('discovery.subtitle')}</p>
              </div>
              <button
                type="button"
                onClick={() => setShowDiscoveryThemes(false)}
                aria-label={t('discovery.close')}
                className="toss-pressable rounded-full p-2 text-muk-soft hover:bg-hanji-deep"
              >
                <X size={16} />
              </button>
            </div>
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1 no-scrollbar md:flex-wrap">
              {DISCOVERY_THEMES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  onClick={() => activateDiscoveryTheme(theme)}
                  className="toss-pressable shrink-0 rounded-full border border-line bg-hanji px-3 py-2 text-xs font-bold text-muk hover:border-gold hover:bg-gold/10"
                >
                  <span aria-hidden>{theme.emoji}</span> {t(`discovery.theme.${theme.id}`)}
                </button>
              ))}
            </div>
          </section>
        )}

        {activeDiscovery && (
          <section className="pointer-events-auto rounded-3xl border border-jade/25 bg-white/95 p-4 shadow-[0_8px_28px_rgba(43,35,32,0.13)] backdrop-blur">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-extrabold text-jade">
                  {getDiscoveryTheme(activeDiscovery.themeId).emoji}{' '}
                  {t(`discovery.theme.${activeDiscovery.themeId}`)}
                </p>
                <p className="mt-1 truncate text-sm font-extrabold text-muk">
                  {t('discovery.activeTitle', { anchor: activeDiscovery.anchorName })}
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-muk-soft">{t('discovery.activeBody')}</p>
              </div>
              <button
                type="button"
                onClick={clearDiscoveryTheme}
                aria-label={t('discovery.clear')}
                className="toss-pressable rounded-full p-2 text-muk-soft hover:bg-hanji-deep"
              >
                <X size={16} />
              </button>
            </div>
            {discoveryLoading ? (
              <div className="mt-3 flex items-center gap-2 rounded-2xl bg-hanji-deep px-3 py-2.5 text-[11px] font-semibold text-muk-soft">
                <span className="inline-block h-3 w-3 rounded-full border-2 border-jade/30 border-t-jade animate-spin" />
                {t('discovery.loading', { anchor: activeDiscovery.anchorName })}
              </div>
            ) : rankedFacilities.length > 0 ? (
              <div className="mt-3 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
                {rankedFacilities.slice(0, 3).map((facility, index) => {
                  const spot = facility.spot;
                  if (!spot) return null;
                  const selected = selectedFacility?.id === facility.id;
                  return (
                    <button
                      key={facility.id}
                      type="button"
                      onClick={() => {
                        setSelectedFacility(facility);
                        panToVisible(facility.latitude, facility.longitude);
                      }}
                      aria-pressed={selected}
                      className={`toss-pressable min-w-[148px] flex-1 rounded-2xl border px-3 py-2.5 text-left ${selected ? 'border-jade bg-jade/10' : 'border-line bg-hanji hover:border-jade/40'}`}
                    >
                      <span className="block text-[9px] font-extrabold text-jade">
                        {t('discovery.alternativeRank', { rank: index + 1 })}
                      </span>
                      <span className="mt-0.5 block truncate text-xs font-extrabold text-muk">{facility.name}</span>
                      {facility.discoveryThemeMatch && (
                        <span className="mt-1 block text-[9px] font-semibold text-jade">
                          {t(facility.discoveryThemeMatch.source === 'tourapi_related'
                            ? 'discovery.match.related'
                            : 'discovery.match.fact')}
                        </span>
                      )}
                      <span className="mt-1 block text-[10px] font-semibold text-muk-soft">
                        {t('discovery.walkMinutes', { n: displayWalkingMinutes(spot.expectedTravel) })}
                      </span>
                      <span className="mt-1 line-clamp-2 block text-[9px] leading-snug text-muk-soft">
                        {spotComparisonById.get(String(facility.id))?.text}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </section>
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

        {/* 오른쪽 열(모바일은 아래): 불투명 툴바 판 두 줄(계획 B3 · I37/P8). 1줄 = 카테고리(+ 음식점이면 🍽 메뉴 ▾),
            2줄 = 지도 레이어 · 편의 칩 + 출처 칩 하나. 줄은 넘쳐도 접히지 않는다 — 칩 무리는 가로로 밀리고 출처 칩은 늘 보인다.
            언어·시계 묶음이 첫 줄 오른쪽 끝에 떠 있으므로 첫 줄만 그 폭(--cluster-w)을 비운다. 휴대폰은 칩 한 줄. */}
        <div
          ref={chipColumnRef}
          data-testid="map-toolbar"
          className="flex flex-col gap-2 md:pointer-events-auto md:min-w-0 md:flex-1 md:gap-1 md:rounded-2xl md:border md:border-line md:bg-hanji md:p-1 md:shadow-[0_4px_18px_rgba(43,35,32,0.12)]"
          style={{ '--cluster-w': `${(topClusterPx ?? 288) + 12}px` } as CSSProperties}
        >
        <div data-testid="toolbar-row-1" className="pointer-events-auto flex items-center gap-2 overflow-x-auto no-scrollbar md:gap-1.5 md:pr-[var(--cluster-w)]">
          {/* 휴대폰: 필터·편의가 칩 줄 맨 앞(히트맵·♿·🅿·음식 종류·축제·화장실은 시트 안). */}
          {activeFilter !== '주차장' && (
            <button
              type="button"
              onClick={() => setShowMobileTools(true)}
              className="toss-pressable flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-white px-3 text-[13px] font-bold text-muk shadow-[0_2px_10px_rgba(43,35,32,0.08)] short:max-md:h-[34px] md:hidden"
            >
              <SlidersHorizontal size={14} aria-hidden /> {t('map.mobileTools')}
            </button>
          )}
          {filters.map((filter) => {
            const Icon = filter.icon;
            const isActive = activeFilter === filter.id;
            return (
              <button
                key={filter.id}
                onClick={() => selectCategory(filter.id)}
                aria-pressed={isActive}
                className={`toss-pressable flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-[13px] font-semibold shadow-[0_2px_10px_rgba(43,35,32,0.06)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 short:max-md:h-[34px] md:h-8 md:px-3 md:shadow-none ${
                  isActive
                    ? 'border-muk bg-muk text-hanji'
                    : 'border-line bg-white text-muk-soft hover:border-gold/60 hover:text-muk'
                }`}
              >
                <Icon size={15} aria-hidden className={isActive ? 'text-hanji' : 'text-gold-deep'} />
                <span>{t(`category.${filter.key}`)}</span>
              </button>
            );
          })}
          {/* 데스크톱 음식 종류 — 칩 줄 대신 🍽 메뉴 ▾ 하나(음식점에서만). 온보딩에서 고른 음식이 있으면 그 취향을 알려 준다
              (추천의 취향 일치율이 이미 그 음식을 본다 — 고르기 전에는 거르지 않는다). 칩과 같은 길(selectCuisineChip). */}
          {activeFilter === '음식점' && (
            <label className="hidden h-8 shrink-0 items-center rounded-full border border-line bg-white pl-3 pr-2 focus-within:ring-2 focus-within:ring-gold/60 md:flex">
              <select
                aria-label={t('map.menuAria')}
                value={cuisineChip ?? ''}
                onChange={(event) => selectCuisineChip(cuisineChips.find((chip) => chip.id === event.target.value) ?? null)}
                className="max-w-[13rem] cursor-pointer truncate bg-transparent text-[13px] font-bold text-muk outline-none"
              >
                <option value="">{cuisineChip ? t('map.menuAll') : setupCuisineHint ?? t('map.menuSelect')}</option>
                {cuisineChips.map((chip) => (
                  <option key={chip.id} value={chip.id}>{chip.emoji} {t(`cuisine.${chip.id}`)}</option>
                ))}
              </select>
            </label>
          )}
        </div>

        {/* 2줄(데스크톱): 🔥 히트맵 · ♿ 무장애 · 🅿 주차 · (🐾) · 🏮 축제 · 🚻 화장실 · 🍃 지금 한산, 그리고 출처 칩 하나. */}
        <div data-testid="toolbar-row-2" className="pointer-events-auto hidden items-center gap-2 md:flex">
          {/* 축제·화장실·지금 한산 칩은 각자 컴포넌트의 크기를 갖고 있다 — 이 줄에서는 같은 높이(32px)로 맞춘다. */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto no-scrollbar [&>button]:h-8 [&>button]:py-0 [&>button]:px-3 [&>button]:text-[13px]">
          {activeFilter !== '주차장' && (
            <>
              <button
                type="button"
                onClick={() => setShowHeatmap((prev) => !prev)}
                aria-pressed={showHeatmap}
                className={layerChipClass(showHeatmap)}
              >
                🔥 {t('map.heatmap')}
              </button>

              {/* ♿ 무장애 — 확인된 곳이 한 칩에도 없으면 숨긴다(🐾 와 같은 규칙). 켜져 있는 동안은 끌 수 있게 남긴다. */}
              {(barrierFreeAnywhere || showBarrierFree) && (
                <button type="button" onClick={onBarrierFreeChip} aria-pressed={showBarrierFree} className={layerChipClass(showBarrierFree)}>
                  ♿ {t('map.barrierFree')}
                </button>
              )}

              {/* 🅿 주차 가능 — features.parking 이 '가능' 으로 읽히는 곳만 지도에(배리어프리와 AND). */}
              <button type="button" onClick={() => setShowParkingFilter((prev) => !prev)} aria-pressed={showParkingFilter} className={layerChipClass(showParkingFilter)}>
                🅿 {t('map.filterParking')}
              </button>

              {/* 🐾 반려동물 동반 — 적재 데이터에 chk_pet 값이 하나도 없으면 늘 빈 지도라 숨긴다(값이 생기면 자동 노출). */}
              {facilities.some((f: any) => parseAvailability((f?.features?.chk_pet ?? f?.features?.chkPet) as string | null | undefined) !== null) && (
                <button type="button" onClick={() => setShowPetFilter((prev) => !prev)} aria-pressed={showPetFilter} className={layerChipClass(showPetFilter)}>
                  🐾 {t('map.filterPet')}
                </button>
              )}

              {/* 🏮 경주 축제 — TourAPI 실시간 축제/행사(GET /api/v1/events). 0건·백엔드 다운이면 스스로 숨는다. */}
              <FestivalBanner onFocus={focusFestivalOnMap} location={userLocation} className="max-w-[16rem]" />

              {/* 인근 공중화장실. 외부 키/호출 실패 시 칩이 스스로 숨는다. */}
              <RestroomChip location={userLocation} />

              {/* 🍃 지금 한산 — 지금 여유로운 곳 TOP3. 0곳이면 칩 자체를 숨긴다. */}
              <TodayCalmSpots
                facilities={facilities}
                userLocation={userLocation}
                onFocus={(f) => {
                  const full = facilities.find((x) => x.id === f.id) || f;
                  setActiveGroupId(null);
                  if (selectFacilityWithHoursGuard(full)
                    && mapInstanceRef.current && typeof full.latitude === 'number') {
                    panToVisible(full.latitude, full.longitude);
                  }
                }}
              />
            </>
          )}
          </div>
          {/* 출처 칩 하나 — 'ⓒ한국관광공사 TourAPI · N시간 전 동기화'. 시각을 모르면 출처만(지어내지 않는다). */}
          <SourceCredit syncedAt={tourapiSyncAt} className="max-w-[17rem] shrink-0" />
        </div>

        </div>{/* /오른쪽 열(툴바) */}
        </div>{/* /구글맵스식 톱바 행 */}
      </div>

      {showMobileTools && activeFilter !== '주차장' && (
        <div className="fixed inset-0 z-50 flex items-end bg-muk/35 md:hidden" onClick={() => setShowMobileTools(false)}>
          <section className="w-full rounded-t-3xl bg-hanji px-4 pb-[calc(20px+env(safe-area-inset-bottom))] pt-3 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <div><h2 className="font-bold text-muk">{t('map.mobileToolsTitle')}</h2><p className="text-xs text-muk-soft">{t('map.mobileToolsDesc')}</p></div>
              <button type="button" onClick={() => setShowMobileTools(false)} aria-label={t('common.close')} className="rounded-full border border-line bg-white p-2 text-muk"><X size={18} /></button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {/* 이 패널은 지도를 덮는 모달이라, 여기서 히트맵을 켜면 바뀐 지도를 볼 수 없다 — 함께 닫는다. */}
              <button type="button" onClick={() => { setShowHeatmap((value) => !value); setShowMobileTools(false); }} aria-pressed={showHeatmap} className={`rounded-xl border px-3 py-3 text-sm font-semibold ${showHeatmap ? 'border-jade bg-jade/15' : 'border-jade/30 bg-white'}`}>🔥 {t('map.heatmap')}</button>
              {(barrierFreeAnywhere || showBarrierFree) && <button type="button" onClick={onBarrierFreeChip} aria-pressed={showBarrierFree} className={`rounded-xl border px-3 py-3 text-sm font-semibold ${showBarrierFree ? 'border-jade bg-jade/15' : 'border-jade/30 bg-white'}`}>♿ {t('map.barrierFree')}</button>}
              <button type="button" onClick={() => setShowParkingFilter((value) => !value)} aria-pressed={showParkingFilter} className={`rounded-xl border px-3 py-3 text-sm font-semibold ${showParkingFilter ? 'border-jade bg-jade/15' : 'border-jade/30 bg-white'}`}>🅿 {t('map.filterParking')}</button>
            </div>
            {activeFilter === '음식점' && (
              <div className="mt-4"><p className="mb-2 text-xs font-bold text-muk-soft">{t('map.foodFilters')}</p><div className="flex gap-2 overflow-x-auto no-scrollbar">{cuisineChips.map((chip) => (
                <button key={chip.id} type="button" onClick={() => selectCuisineChip(chip)} aria-pressed={cuisineChip === chip.id} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold ${cuisineChip === chip.id ? 'border-gold bg-gold/15 text-gold-deep' : 'border-line bg-white text-muk'} ${cuisineChip !== chip.id && setupCuisineChipId === chip.id ? 'ring-2 ring-gold/70 ring-offset-1 ring-offset-hanji' : ''}`}><span aria-hidden>{chip.emoji}</span> {t(`cuisine.${chip.id}`)}</button>
              ))}</div></div>
            )}
            <div className="mt-4 flex flex-wrap gap-2"><FestivalBanner onFocus={focusFestivalOnMap} location={userLocation} /><RestroomChip location={userLocation} /></div>
          </section>
        </div>
      )}

      {/* (a) 시설 로드 상태 안내 — 로딩 스피너 / 로드 실패 재시도 / 전체 빈 상태 (데모 사고 방지선) */}
      {activeFilter !== '주차장' && isLoadingFacilities && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 pointer-events-none">
          <NextSpotMascot variant="full" className="w-20 shadow-[0_8px_24px_rgba(43,35,32,0.10)]" />
          <div className="w-10 h-10 rounded-full border-2 border-line border-t-gold animate-spin" />
          <span className="text-muk text-sm font-medium">{t('map.loadingRec')}</span>
        </div>
      )}

      {activeFilter !== '주차장' && !isLoadingFacilities && facilitiesLoadError && (
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

      {activeFilter !== '주차장' && !isLoadingFacilities && !facilitiesLoadError && facilities.length === 0 && (
        <div className="absolute inset-0 z-30 flex items-center justify-center px-6 pointer-events-none">
          <div className="bg-white border border-line rounded-2xl px-6 py-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)] flex flex-col items-center gap-2 max-w-xs text-center">
            <NextSpotMascot variant="full" className="w-16" />
            <p className="text-muk text-sm font-semibold">{t('map.emptyTitle')}</p>
            <p className="text-muk-soft text-xs leading-relaxed">{t('map.emptyBody')}</p>
          </div>
        </div>
      )}

      <ActiveJourneyCard location={userLocation} />

      {/* AI Recommendation Card — 휴대폰: 하단 시트. 데스크톱(md+): 오른쪽 열(380/420/460px, lib/mainPanelLayout)을
          툴바 아래부터 바닥까지 채운다(I31). 주차장 탭도 같은 열을 쓴다. */}
      {activeFilter === '주차장' && parkingLoading && parkingLots.length === 0 && (
        <div className={`absolute z-20 px-4 bottom-[calc(var(--tourist-nav-clearance)+env(safe-area-inset-bottom))] w-full md:bottom-6 ${DESKTOP_PANEL_CLASS} pointer-events-none`}>
          <div className="rounded-2xl border border-line bg-white/95 px-5 py-4 text-sm font-semibold text-muk shadow-lg">
            {t('map.parkingLoading')}
          </div>
        </div>
      )}

      {activeFilter === '주차장' && !parkingLoading && parkingLots.length === 0 && (
        <div className={`absolute z-20 px-4 bottom-[calc(var(--tourist-nav-clearance)+env(safe-area-inset-bottom))] w-full md:bottom-6 ${DESKTOP_PANEL_CLASS} pointer-events-none`}>
          <div className="pointer-events-auto rounded-2xl border border-line bg-white/95 px-5 py-4 text-sm font-semibold text-muk shadow-lg">
            <p>{t(parkingLoadError ? 'map.parkingLoadFailed' : 'map.parkingEmpty')}</p>
            {parkingLoadError && (
              <button
                type="button"
                onClick={() => setParkingReloadNonce((value) => value + 1)}
                className="toss-pressable mt-3 rounded-full bg-muk px-4 py-2 text-xs font-bold text-white"
              >
                {t('common.retry')}
              </button>
            )}
          </div>
        </div>
      )}

      {selectedParkingLot && activeFilter === '주차장' && (
        <div className={`absolute z-20 px-4 bottom-[calc(var(--tourist-nav-clearance)+env(safe-area-inset-bottom))] w-full md:bottom-6 ${DESKTOP_PANEL_CLASS} pointer-events-none`}>
          <div className="pointer-events-auto rounded-3xl border border-line bg-white/95 p-5 shadow-[0_8px_30px_rgba(43,35,32,0.16)] backdrop-blur">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-bold text-sky-700">{t('map.parkingEyebrow')}</p>
                <h3 className="mt-1 text-lg font-bold text-muk">{selectedParkingLot.name}</h3>
                <p className="mt-1 text-xs text-muk-soft">
                  {t('map.parkingDistance', { n: Math.ceil(selectedParkingLot.distanceM).toLocaleString() })}
                </p>
              </div>
              <button type="button" onClick={() => setSelectedParkingLot(null)} aria-label={t('common.close')} className="rounded-full p-2 text-muk-soft hover:bg-hanji-deep">
                <X size={18} />
              </button>
            </div>
            {/* 잔여면 실시간 값이 있을 때만 상자를 그린다 — 없다는 사실은 관광객에게 할 일을 주지 않는다. */}
            {selectedParkingLot.live && selectedParkingLot.availableSpaces !== null && selectedParkingLot.totalSpaces !== null && (
              <div className="mt-4 rounded-2xl border border-jade/25 bg-jade/10 px-4 py-3">
                <p className="text-sm font-extrabold text-jade">
                  {t('map.parkingLiveSpaces', { available: selectedParkingLot.availableSpaces, total: selectedParkingLot.totalSpaces })}
                </p>
              </div>
            )}
            <button type="button" onClick={() => openDrivingDirections(selectedParkingLot)} className="toss-pressable mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-muk px-4 py-3 text-sm font-bold text-white">
              <Car size={16} /> {t('map.parkingDirections')}
            </button>
          </div>
        </div>
      )}

      {activeFilter !== '주차장' && (() => {
        // 이 열 하나에 음성 비서 칸 · 스켈레톤(첫 카드 고르는 중 / 다시 계산 중) · 추천 카드 · 제안 카드가 차례로 선다.
        const showSkeleton = !!recalcLabel || (pickingFirst && !selectedFacility);
        const showCard = !!selectedFacility && !recalcLabel;
        // (b) 현재 칩에 추천할 곳이 없으면 '없어요' 대신 지금 후보가 있는 다른 칩을 바로 고르게 한다.
        //     ♿ 가 켜져 있으면 무장애 확인 장소가 있는 칩만 나온다(같은 조건으로 센다). 그런 칩이 없으면 무장애 핀을
        //     가리킨다(barrierFreePinsHere · barrierFreePinChips). 고를 것이 하나도 없으면 카드 자체를 그리지 않는다.
        const showSuggestion = !isLoadingFacilities && !facilitiesLoadError && facilities.length > 0 && !selectedFacility
          && noRecommendation && !showSkeleton
          && (suggestedCategories.length > 0 || noOpenTodayOnly || barrierFreePinsHere > 0 || barrierFreePinChips.length > 0);
        // 음성 비서는 카드가 없어도 남는다(♿·밤처럼 카드가 없는 화면에서도 말로 칩을 바꿀 수 있다 — 계획 B2).
        const voiceAvailable = voice.ttsSupported && !isLoadingFacilities && !facilitiesLoadError && facilities.length > 0;
        if (!showSkeleton && !showCard && !showSuggestion && !voiceAvailable) return null;
        const pill = voiceAvailable ? (
          <VoicePill
            active={voice.active}
            voiceState={voice.voiceState}
            onClick={voice.onOrbClick}
            ringed={focusRing === 'voice'}
          />
        ) : null;
        const panelStyle = toolbarClearPx === null
          ? undefined
          : ({ '--panel-top': `${Math.max(76, toolbarClearPx)}px` } as CSSProperties);
        return (
          // pointer-events-none(열): 카드·알약·제안 카드만 auto — 빈 열 자리를 누르면 지도가 받는다.
          // 음성이 켜져 있는 동안은 자막 막대가 시계 위로 오도록 열을 한 층 올린다.
          <div
            ref={setRecPanelEl}
            data-testid="rec-panel"
            className={`rec-panel absolute ${voice.active ? 'z-40' : 'z-20'} px-4 bottom-[calc(var(--tourist-nav-clearance)+env(safe-area-inset-bottom))] w-full md:bottom-4 md:top-[var(--panel-top,6rem)] ${DESKTOP_PANEL_CLASS} md:flex md:flex-col md:gap-2 pointer-events-none`}
            style={panelStyle}
          >
            {/* 데스크톱: 카드 바로 위 44px 칸의 '🎙 AI 음성 비서' 알약(P7). */}
            {pill && <div data-testid="voice-slot" className="hidden h-11 shrink-0 items-center justify-end md:flex">{pill}</div>}
            {/* 휴대폰: 카드가 있으면 카드 오른쪽 위(카드가 그린다), 없으면 이 열 오른쪽 위. */}
            {pill && !showCard && <div className="mb-2 flex justify-end md:hidden">{pill}</div>}
            {/* 자막 막대 — 떠 있는 막대라 아래 내용을 밀지 않는다(I27). 데스크톱은 열 맨 위(알약·카드 위쪽)에 겹치고,
                휴대폰은 카드 바로 위(화면 아래쪽 — 시계에 가리지 않는다). */}
            {voice.active && (
              <VoiceCaptionBar
                voiceState={voice.voiceState}
                liveTranscript={voice.liveTranscript}
                caption={voice.caption}
                sttSupported={voice.sttSupported}
                hint={t('recommend.voiceHint')}
                onStop={voice.stop}
                className="absolute inset-x-4 bottom-full z-10 mb-2 md:inset-x-0 md:bottom-auto md:top-0 md:mb-0"
              />
            )}

            {/* 스켈레톤 — 첫 카드를 고르는 중(서버 1위를 최대 3.5초 기다린다) 또는 시간대·테마로 다시 계산하는 중.
                카드와 같은 자리·같은 폭이라 화면이 튀지 않는다. */}
            {showSkeleton && (
              <div
                role="status"
                aria-live="polite"
                data-testid="rec-skeleton"
                className="pointer-events-auto w-full rounded-3xl border border-line bg-white/95 p-5 toss-surface backdrop-blur-2xl"
              >
                <div className="mx-auto mb-3 h-1.5 w-16 rounded-full bg-muk/15" />
                <p className="flex items-center gap-2 text-[13px] font-extrabold text-muk">
                  <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-gold/30 border-t-gold-deep" />
                  {recalcLabel ? t('assume.recalculating', { label: recalcLabel }) : t('map.pickingFirst')}
                </p>
                {/* 휴대폰: 결과 카드가 짧은 미리보기로 뜨므로 스켈레톤도 그 높이만 쓴다(max-md:hidden). */}
                <div className="mt-3 flex flex-col gap-2">
                  <div className="h-3 w-2/5 animate-pulse rounded-full bg-hanji-deep max-md:hidden" />
                  <div className="h-6 w-4/5 animate-pulse rounded-lg bg-hanji-deep" />
                  <div className="h-3 w-3/5 animate-pulse rounded-full bg-hanji-deep" />
                  <div className="mt-1 h-16 w-full animate-pulse rounded-2xl bg-hanji-deep max-md:hidden" />
                  <div className="mt-1 flex gap-2 max-md:hidden">
                    <div className="h-10 flex-1 animate-pulse rounded-2xl bg-hanji-deep" />
                    <div className="h-10 flex-1 animate-pulse rounded-2xl bg-hanji-deep" />
                  </div>
                </div>
              </div>
            )}

            {showCard && (() => {
              try {
                const spot = selectedFacility.spot || calculateSPOT(selectedFacility);
                // 카드 첫 줄의 기준 명소(A) — 음성과 같은 값(anchorContextFor).
                const { anchorName: compareAnchorName, anchorLevel: compareAnchorLevel, anchorDistanceM: compareAnchorDistanceM } =
                  anchorContextFor(selectedFacility, spot);
                // 머리 배지 — 지금 보이는 추천 목록(관심 없음·저장 제외)에서의 자리. 검색·링크로 직접 연 곳은 목록에
                // 있어도 '선택한 장소'(교차 레인 계약 2), 목록 밖이면 언제나 '선택한 장소'(lib/cardRank.ts).
                const visibleList = (rankedFacilities as Facility[]).filter((f) => !rejectedIds.has(f.id) && !savedIds.has(f.id));
                const listIndex = visibleList.findIndex((f) => String(f.id) === String(selectedFacility.id));
                const forcedSelected = selectedFacility.pickKind === 'search' || selectedFacility.pickKind === 'place';
                const listRank = forcedSelected || listIndex < 0 ? null : listIndex + 1;
                // '추천 이유'(베스트 대비 차이)는 그 문장의 순위가 카드의 순위와 같을 때만(I05 j).
                const comparison = spotComparisonById.get(String(selectedFacility.id));
                const spotComparisonReason = comparison && listRank !== null && comparison.rank === listRank
                  ? comparison.text
                  : undefined;
                // 카드 첫 상자의 '🕒 … 기준' — 혼잡 예측 +N시간이면 '+N시간 후', 요일 프리셋이면 그 라벨.
                const assumedTimeLabel = cardHours > 0
                  ? t('forecast.ahead', { h: cardHours })
                  : assumedPreset !== 'now'
                    ? t(ASSUMED_TIME_PRESETS.find((p) => p.id === assumedPreset)?.labelKey ?? 'timeSim.now')
                    : null;
                const cardContextBadge = activeDiscovery
                  ? t('compare.contextBadge', { label: t(`discovery.theme.${activeDiscovery.themeId}`) })
                  : null;
                // 서버 사유는 한국어 템플릿이므로 화면에서는 구조화된 사실로 현재 로케일 문장을 조립한다.
                const walk = displayWalkingMinutes(spot.expectedTravel);
                // 대기 분은 카드의 칩·타일·도착 요약과 같은 규칙(lib/cardTimes.ts, 올림)으로.
                const verifiedWait = selectedFacility.scoringMode === 'model' && selectedFacility.congestionSource !== 'none'
                  ? cardTimes(spot.expectedTravel, spot.expectedWait, null).waitMin
                  : null;
                // 💡 사유는 관광객이 얻는 것만 말한다(걷는 시간·검증된 대기).
                const reason = verifiedWait !== null
                  ? t('recommend.fallbackWithWait', { name: selectedFacility.name, walk, wait: verifiedWait })
                  : t('recommend.fallbackTravelOnly', { name: selectedFacility.name, walk });
                // "{A} 대신 {B} 어떠세요?" — 카드가 첫 줄을 화살표 비교로 그릴 때만 쓴다(같은 판정, 카드 안 chooseCompareHeadline).
                const insteadReason = verifiedWait === null && compareAnchorName
                  ? t('recommend.reasonInstead', { anchor: compareAnchorName, name: selectedFacility.name, walk })
                  : null;
                return (
                  <div className="pointer-events-auto md:flex md:min-h-0 md:flex-1 md:flex-col">
                  <RecommendationCard
                    title={selectedFacility.name}
                    reason={reason}
                    insteadReason={insteadReason}
                    spotComparisonReason={spotComparisonReason}
                    onAccept={() => handleAccept(selectedFacility)}
                    onDrive={() => handleAccept(selectedFacility, 'car')}
                    onReject={() => handleReject(selectedFacility)}
                    onPutOff={() => handlePutOff(selectedFacility)}
                    spotScore={spot.score}
                    preferencePercent={spot.preferencePercent}
                    expectedWait={selectedFacility.scoringMode === 'model' && selectedFacility.congestionSource !== 'none' ? spot.expectedWait : undefined}
                    expectedTravel={spot.expectedTravel}
                    travelSource={spot.travelSource}
                    timeToService={spot.timeToService}
                    eventBoost={spot.eventBoost}
                    eventTitle={spot.eventTitle}
                    areaDemandLevel={spot.areaDemandLevel}
                    areaDemandMode={spot.areaDemandMode}
                    areaDemandSources={spot.areaDemandSources}
                    areaDemandObservedAt={spot.areaDemandObservedAt}
                    areaDemandRadiusM={spot.areaDemandRadiusM}
                    areaDemandParkingEvidence={spot.areaDemandParkingEvidence}
                    areaDemandTourismEvidence={spot.areaDemandTourismEvidence}
                    areaDemandConfidence={spot.areaDemandConfidence}
                    areaDemandRank={spot.areaDemandRank}
                    areaDemandComparableCount={spot.areaDemandComparableCount}
                    areaDemandDeltaVsMedian={spot.areaDemandDeltaVsMedian}
                    areaDemandDistinguishable={spot.areaDemandDistinguishable}
                    delayedAreaDemandLevel={spot.delayedAreaDemandLevel}
                    arrivalAction={spot.arrivalAction}
                    recommendedDepartureDelayMinutes={spot.recommendedDepartureDelayMinutes}
                    facilityType={selectedFacility.type}
                    facility={selectedFacility}
                    rank={listRank}
                    showListRank
                    mockHour={mockHour}
                    dataSource={{
                      source: selectedFacility.congestionSource === 'measured'
                        ? selectedFacility.congestionLogSource ?? 'measured'
                        : selectedFacility.congestionSource ?? selectedFacility.source ?? null,
                      // 혼잡을 본 시각만 — dataUpdatedAt 은 시설 기록의 갱신 시각이라 "N시간 전 기준" 이 될 수 없다.
                      lastUpdated: selectedFacility.congestionTimestamp
                        ?? selectedFacility.lastUpdated
                        ?? null,
                      isStale: selectedFacility.congestionIsStale ?? !!selectedFacility.isStale,
                    }}
                    openStatusAtArrival={selectedFacility.openStatusAtArrival}
                    congestionSource={selectedFacility.congestionSource}
                    // 서버 판정: 이 실측이 '지금' 을 말할 자격이 있는가(verified/corroborated · 30분).
                    congestionIsCurrent={selectedFacility.congestionIsCurrent}
                    congestionTimestamp={selectedFacility.congestionTimestamp ?? selectedFacility.lastUpdated}
                    scoringMode={selectedFacility.scoringMode}
                    // 지도에서 고른 시설은 추정 피드의 **최신** 값을, 추천 카드는 응답이 실어 준 값을 쓴다.
                    congestionEstimate={
                      (estimateById[selectedFacility.id] as CongestionEstimate | undefined)
                        ?? selectedFacility.congestionEstimate
                        ?? null
                    }
                    // 비교 헤더·주변 수요 자리는 이 화면에서만 켠다 — 지도에서 고른 명소가 '대신할 A' 다.
                    showCompare
                    compareAnchorName={compareAnchorName}
                    compareAnchorDistanceM={compareAnchorDistanceM}
                    compareAnchorLevel={compareAnchorLevel}
                    assumedTimeLabel={assumedTimeLabel}
                    contextBadge={cardContextBadge}
                    // 휴대폰에서는 짧은 미리보기로 연다 — 지도와 톱바(검색·✨·칩·필터·편의)가 가려지지 않게.
                    mobilePeek
                    conditions={cardConditions}
                    onRemoveCondition={removeCondition}
                    voiceSlot={isPhone ? pill ?? undefined : undefined}
                    peekRequest={peekRequest}
                    desktopFill
                    onPeekChange={setCardPeek}
                  />
                  </div>
                );
              } catch (err) {
                console.warn("Error rendering RecommendationCard IIFE:", err);
                return null;
              }
            })()}

            {showSuggestion && (
          <div data-testid="category-suggestion" className="pointer-events-auto bg-white border border-line rounded-2xl px-5 py-4 shadow-[0_2px_14px_rgba(43,35,32,0.06)] flex flex-col items-center gap-2 text-center">
            <NextSpotMascot className="w-12" />
            {/* '다른 곳을 보여드릴게요' 는 아래에 고를 칩이 있을 때만 — 버튼 없이 약속만 남기지 않는다. */}
            {suggestedCategories.length > 0 && (
              <p className="text-muk text-sm font-semibold">
                {showBarrierFree ? t('map.barrierFreeElsewhere') : t('map.suggestTitle')}
              </p>
            )}
            {/* 소진 원인이 '전부 오늘 휴무'면 그 사실을 말한다 — 데이터 부족/엔진 실패로 오해하지 않게. */}
            {noOpenTodayOnly && (
              <p className="text-muk-soft text-xs leading-relaxed">{t('map.noRecClosedBody')}</p>
            )}
            {suggestedCategories.length > 0 && (
              <div className="mt-1 flex flex-wrap justify-center gap-2">
                {suggestedCategories.map(({ id, type, count }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => selectCategory(id)}
                    className="toss-pressable rounded-full border border-gold/50 bg-gold/10 px-3.5 py-2 text-xs font-bold text-muk hover:bg-gold/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                  >
                    {t('map.suggestButton', { category: t(`category.${type}`), n: count })}
                  </button>
                ))}
              </div>
            )}
            {suggestedCategories.length === 0 && barrierFreePinsHere > 0 && activeCategoryType && (
              <>
                <p className="text-muk text-sm font-semibold">{t('map.barrierFreeOnMap', { n: barrierFreePinsHere })}</p>
                <button
                  type="button"
                  onClick={() => fitBarrierFreePins(activeCategoryType)}
                  className="toss-pressable mt-1 rounded-full border border-gold/50 bg-gold/10 px-3.5 py-2 text-xs font-bold text-muk hover:bg-gold/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                >
                  {t('map.placeSearchView')}
                </button>
              </>
            )}
            {barrierFreePinChips.length > 0 && (
              <>
                <p className="text-muk text-sm font-semibold">{t('map.barrierFreeElsewhere')}</p>
                <div className="mt-1 flex flex-wrap justify-center gap-2">
                  {barrierFreePinChips.map(({ id, type, count }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => { selectCategory(id); fitBarrierFreePins(type); }}
                      className="toss-pressable rounded-full border border-gold/50 bg-gold/10 px-3.5 py-2 text-xs font-bold text-muk hover:bg-gold/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                    >
                      {t('map.suggestButton', { category: t(`category.${type}`), n: count })}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
            )}
          </div>
        );
      })()}

      {/* 🔮 혼잡 예측 줄(계획 B3) — 데스크톱: 지도 빈 자리(오른쪽 추천 패널 왼쪽) 아래 가운데, Kakao 로고(왼쪽 아래)보다 위.
          휴대폰: 카드 미리보기 바로 위 한 줄(카드 열 높이를 재서 그 위에 선다). 펼친 휴대폰 카드 위에서는 감춘다. */}
      {showStrip && (
        <div
          className="pointer-events-none absolute inset-x-4 z-20 flex justify-center bottom-[calc(var(--tourist-nav-clearance)+env(safe-area-inset-bottom)+var(--strip-dock))] md:left-4 md:right-[var(--strip-right)] md:bottom-8"
          style={{
            '--strip-dock': `${(recPanelEl ? recPanelHeight : 0) + 8}px`,
            '--strip-right': `${desktopPanelReservePx(viewportWidth) + 16}px`,
          } as CSSProperties}
        >
          <div ref={stripRef} className="w-full md:max-w-[640px]">
            <ForecastTimeStrip
              hours={cardHours}
              loading={strip.status === 'loading'}
              presetId={assumedPreset}
              presets={stripPresets}
              onSelectHours={selectForecastHours}
              onSelectPreset={selectAssumedPreset}
              badge={stripBadge}
              legend={stripLegend}
              areaChip={stripAreaChip}
              ringed={focusRing === 'forecast'}
            />
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
                        // 전체 화면 중심이 아니라 가시영역(칩 바 아래·카드 패널 왼쪽) 중심으로 —
                        // 초기 진입과 같은 규칙이라 '내 위치' 점이 항상 같은 자리에 놓인다.
                        centerOnFreeArea(loc.lat, loc.lng);
                        if (typeof window !== 'undefined') {
                          // 저장소 차단 환경에서 throw 하면 아래 토스트까지 못 가 '아무 일도 안 일어난' 것처럼 보인다.
                          try { sessionStorage.removeItem('nextspot_selected_facility_id'); } catch { /* 저장소 차단 */ }
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
