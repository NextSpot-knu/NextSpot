// 홈(지도) 화면 — 웹 /main(apps/web/app/main/page.tsx, 기준 yunseong e8d1c07)의 앱판.
//
// 뺀 것(계획 §3.1 · D9 · D12): 음성 비서 · 히트맵(v1.1) · 데모 조작 패널 · 지역 전환(내부 계정) · '내 위치' 버튼·위치 배너(D3 ① — 웹처럼
//   실패 알약만, 다시 켜기는 마이>설정).
// ✨ 경주 테마(F2 · G2-14): 날씨 줄 끝 알약 → 위 묶음의 테마 판 → 고르면 그 테마의 기준 명소로 POST /recommendations(discovery_theme)를
//   묻고, 결과가 칩 추천 자리(recs)를 대신한다 — 카드·핀 순위·다시 계산은 칩 추천과 같은 길. 칩·음식 칩·✕ 가 테마를 끈다(웹 :1509-1550).
// 화면 층(웹 page.tsx 와 같은 순서): 지도(유리가 흐릴 대상) → 상단 묶음(언어·출처·시계) → 검색·날씨·칩(유리) → 아래 스택(예측 띠 ·
//   추천 카드 · 제안 상자) / 주차장 판 → 진행 중 여행 카드(위) → 홈 알약 토스트 → 방문 확인 카드(아래) → 날씨 팝오버 → 시트들.
// 추천 카드(features/recommendation-card/RecommendationCard)는 rec_* 이용 이벤트와 수락·킵·거절 쓰기를 스스로 한다 —
//   이 화면의 처리기는 선택·카메라·화면 상태만 바꾼다(같은 이벤트·쓰기를 두 번 보내지 않는다).
// 흐름: 시설 로드(/infrastructures) → 칩의 종류로 서버 추천(by-type, 가정 시각 포함) → 1위를 카드 자리에 연다 → 핀·검색으로 직접 고르면
//   그 장소가 '선택한 장소'. 추천이 실패하면 같은 자리에 오류 판(G3-26), 0곳이면 다른 칩 제안 상자(G3-27 · G2-30).
// 카메라(G2-01): 고른 핀은 '보이는 띠'의 가운데로 — 위 = 머리(검색·칩) 아래 + 8, 아래 = 아래 스택 위끝 + 8(카드가 펼쳐져 있어도 미리보기
//   높이로 잰다 — 계획 §3.3 ②). 스택 높이가 바뀌면(스켈레톤 → 카드) 방금 옮긴 핀을 새 띠로 한 번 더 맞춘다.
// 지도 패딩(F12): 구글 로고가 카드 밑에 숨지 않게 스택 높이 + 8 을 8 단위로, 잠깐 기다렸다(흔들림 없이) 넘긴다.
import { useFocusEffect, useRouter } from 'expo-router';
import { Building2, Car, Coffee, MapPin, Search, SlidersHorizontal, Utensils, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BackHandler, Dimensions, Keyboard, Platform, Pressable as RNPressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { facilityMatchesSearch } from '@/lib/placeSearch';
import { REGION } from '@/lib/region';
import { getArrivalOpenStatus } from '@/lib/restDate';
import { NextSpotMascot } from '~/components/NextSpotMascot';
import { useNavInsets } from '~/components/navigation/navMetrics';
import { pushMypageSub, useOpenMypageHome } from '~/components/navigation/useOpenMypage';
import { Card, Glass, GlassBlurProvider, GlassBlurTarget, Icon, Pressable, RingSpinner, Text } from '~/components/ui';
import { ANDROID_GLASS_BLUR } from '~/components/ui/glassSurface';
import { fontStyleFor } from '~/components/ui/textStyle';
import {
  declutterPins,
  NextSpotMap,
  type LatLng,
  type MapPopover,
  type MapViewport,
  type NextSpotMapHandle,
  type NextSpotMarker,
  type PinCluster,
  type PinMarker,
} from '~/features/map';
import {
  ActiveJourneyCard,
  CardSkeleton,
  RecommendationCard,
  VisitCheckCard,
  type CardCondition,
  type SheetCandidate,
} from '~/features/recommendation-card';
import { formatSpotComparison } from '~/features/explore/port/spotComparison';
import { displayWalkingMinutes } from '~/features/explore/port/walking';
import { loadTravelContext, saveTravelContext } from '~/features/course/travelContext';
import { getRecommendations, recommendByType, type RecommendationResponse } from '~/lib/core/apiClient';
import { assumedPresetLabelKey } from '~/lib/core/assumedTime';
import { loadSavedLocal, syncSaved } from '~/lib/core/savedFacilities';
import type { TravelContext } from '~/lib/core/travelContextTypes';
import { useBusyThreshold } from '~/lib/core/publicSettings';
import { isStrollerFriendly } from '~/lib/core/strollerSupport';
import { useI18n } from '~/lib/i18n/I18nProvider';
import { haptic } from '~/lib/platform/haptics';
import { openExternalUrl, openWalkingDirections } from '~/lib/platform/links';
import { track } from '~/lib/platform/analytics';
import { colors } from '~/lib/theme/tokens';

import {
  bandBottomInset,
  bestCategory,
  candidateCountsByType,
  cardConditionKeys,
  chipCandidates,
  chipPool,
  clientWalkRelaxed,
  countPinsByType,
  FILTER_IDS,
  hasPinAttributes,
  MAP_SESSION_KEYS,
  nearCenter,
  onlyClosedTodayLeft,
  parseMapSession,
  pickFirstViewCategory,
  pinAttributesOf,
  removeCondition,
  stablePadding,
  suggestionModel,
  tabFromFilterId,
  withAttribute,
  type ConditionKey,
  type HomeTab,
  type PinAttribute,
  type SuggestionModel,
} from './chipModel';
import { DiscoveryActivePanel, DiscoveryChip, DiscoveryThemePanel } from './discovery/DiscoveryPanel';
import {
  activateDiscovery,
  discoveryCompareAnchor,
  discoveryRequestContext,
  discoveryRequestKey,
  discoveryResultItems,
  getDiscoveryTheme,
  type ActiveDiscovery,
  type DiscoveryTheme,
} from './discovery/discoveryModel';
import { ForecastStrip } from './ForecastStrip';
import { forecastLevelFor, shouldShowForecastStrip, stripBadgeFor, stripLegendFor } from './forecastStripModel';
import { LocationPrimer, PlaceSearchResults, SearchNoResultPill, ToolsSheet, TourSearchResults } from './HomeOverlays';
import {
  applyConvenience,
  buildInsteadHref,
  buildPinMarkers,
  CATEGORIES,
  canSeeInstead,
  CUISINE_CHIPS,
  distanceM,
  HOME_PANEL_MAX_WIDTH,
  JOURNEY_TOP_OFFSET,
  journeyCardMaxHeight,
  keyboardCoverFor,
  festivalFocus,
  isAccessible,
  matchesCuisineChip,
  searchLabelMarkers,
  selectByCategoryOrSearch,
  shouldAskExternal,
  walkingMinutes,
  type Convenience,
  type FestivalFocus,
  type HomeFacility,
  type PlaceCategory,
} from './homeModel';
import {
  buildSelectedCandidate,
  cardStatus,
  compareAnchorFor,
  comparisonFor,
  spotComparisonsById,
  type PickKind,
} from './sheetModel';
import { showsUserDot } from './locationPolicy';
import {
  buildExcludeIds,
  cuisineIntentOf,
  homeFilterSeed,
  parseRejectedIds,
  REJECTED_IDS_KEY,
  relaxWalkLimit,
  serializeRejectedIds,
} from './homeContext';
import { HomeToast, useHomeToast } from './HomeToast';
import { HomeTopCluster } from './HomeTopCluster';
import { ParkingPanel } from './ParkingPanel';
import { parkingPinMarkers, type ParkingLot } from './parkingModel';
import { orderPinsBySpot } from './pinOrder';
import { CHIP_HIT_SLOP, useWeather, WeatherPill, WeatherPopover, type FestivalEvent, type PillAnchor } from './ToolChips';
import { useFacilities } from './useFacilities';
import { STRIP_PRESETS, useForecastStrip } from './useForecastStrip';
import { useParkingLots } from './useParkingLots';
import { useIngestRequest, usePlaceSearch, type PlaceSearchItem, type TourApiSearchItem } from './usePlaceSearch';
import { usePreferredCategories } from './usePreferredCategories';
import { useUserLocation } from './useUserLocation';

const OUT_OF_REGION_NOTICE_KEY = 'nextspot_out_of_region_notice';
const RECOMMENDATION_TIMEOUT_MS = 20_000;
/** 다시 계산 스켈레톤의 비상 종료 — 추천 요청 시간 초과 뒤(웹 RECALC_EMERGENCY_MS). */
const RECALC_EMERGENCY_MS = RECOMMENDATION_TIMEOUT_MS + 2_000;
/** 다시 계산이 너무 빨리 끝나도 이만큼은 스켈레톤을 보인다(웹 finishRecalc 420ms — 깜빡임 방지). */
const RECALC_MIN_MS = 420;
/** 웹 홈 지도 SDK 대기 상한(page.tsx 2911-2927 · F12). 웹 빌드만 쓴다. */
const MAP_UNAVAILABLE_TIMEOUT_MS = 8000;
/** 웹 상단 묶음(언어·출처·시계) 아래에서 검색 줄이 시작하는 자리 — top-[safe + 4.25rem](G2-10 5번). */
const HEADER_TOP = 68;
/** 웹 inset-x-4 · px-4 — 검색 줄·아래 스택·여정 카드의 좌우. */
const SIDE = 16;
/** 웹 방문 확인 카드 max-w-sm. */
const VISIT_MAX_WIDTH = 384;
/** 웹 키 낮은 휴대폰(short: 높이 720 미만) — 검색창을 낮추고 마스코트를 숨기며 날씨 알약을 옆에 붙인다. */
const SHORT_SCREEN_MAX = 720;
/** 제안 상자 · 빈 상태 카드 — 웹 shadow-[0_2px_14px_rgba(43,35,32,0.06)]. */
const SOFT_SHADOW = '0px 2px 14px rgba(43, 35, 32, 0.06)';
/** 분류 칩 — 웹 shadow-[0_2px_10px_rgba(43,35,32,0.06)]. */
const CHIP_SHADOW = '0px 2px 10px rgba(43, 35, 32, 0.06)';
/** 장소 불러오는 중 마스코트 — 웹 shadow-[0_8px_24px_rgba(43,35,32,0.10)]. */
const MASCOT_SHADOW = '0px 8px 24px rgba(43, 35, 32, 0.1)';
/** 방금 옮긴 핀을 스택 높이 변화에 맞춰 다시 맞출 시간 창(ms). */
const REFOCUS_WINDOW_MS = 900;
/** 지도 패딩을 넘기기 전 기다리는 시간 — 카드 끌기·펼침 애니메이션 중에 구글 패딩을 거듭 바꾸지 않는다. */
const PADDING_SETTLE_MS = 250;
/** 웹 첫 설정 음식 취향 → 필터 시트에서 금 링으로 알려 줄 음식 칩(page.tsx SETUP_CUISINE_CHIP). */
const SETUP_CUISINE_CHIP: Partial<Record<string, string>> = { '한식': 'korean', '분식·국밥': 'bunsik', '양식': 'western' };
const NO_EXTERNAL = { places: [], placesLoading: false, tour: [], tourLoading: false, tourAsked: false } as const;
/** 분류 칩(웹 filters, page.tsx 3299-3306) — 주차장은 추천 칩이 아니라 탭이다. */
const TAB_CHIPS: readonly { tab: HomeTab; icon: typeof Utensils }[] = [
  { tab: 'restaurant', icon: Utensils },
  { tab: 'cafe', icon: Coffee },
  { tab: 'attraction', icon: MapPin },
  { tab: 'culture', icon: Building2 },
  { tab: 'parking', icon: Car },
];

type Selection = { id: string; kind: PickKind };
type Recalc = { label: string; prevTopId: string | null; startedAt: number };
type Focus = { latitude: number; longitude: number; level?: number; at: number };

function sessionStore(): Storage | null {
  return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
}

function sessionGet(key: string): string | null {
  try {
    return sessionStore()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function sessionSet(key: string, value: string): void {
  try {
    sessionStore()?.setItem(key, value);
  } catch { /* 저장소 차단 — 이번에는 기억하지 않는다 */ }
}

function loadRejectedIds(): Set<string> {
  return parseRejectedIds(sessionGet(REJECTED_IDS_KEY));
}

function savedIdSet(): Set<string> {
  return new Set(loadSavedLocal().map((b) => b.id));
}

type PlacePin = { id: string; name: string; latitude: number; longitude: number };

/** 웹 track('context_applied') 와 같은 값(toggleRequiredAttribute · removeCondition). */
function trackContext(next: TravelContext): void {
  track('context_applied', {
    categories: next.categories,
    max_walk_minutes: next.maxWalkMinutes ?? null,
    available_minutes: next.availableMinutes ?? null,
    required_attributes: next.requiredAttributes,
    exclude_visited: next.excludeVisited,
  });
}

export function HomeScreen() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const openMypageHome = useOpenMypageHome();
  const insets = useSafeAreaInsets();
  const nav = useNavInsets();
  const { height: windowHeight } = useWindowDimensions();
  const busyAt = useBusyThreshold();
  const mapRef = useRef<NextSpotMapHandle>(null);
  const home = useHomeToast();
  const showToast = home.show;

  const { facilities, loading, error, reload, estimateById } = useFacilities();
  const loc = useUserLocation();
  const userPoint = loc.location;
  const preferredCategories = usePreferredCategories();
  const weather = useWeather();

  // 첫 설정 조건(nextspot_setup_prefs) — ♿·👶·실내 조건도 여기 산다(웹 travelContext.requiredAttributes). 바꾸면 저장한다(G2-28).
  const [stored, setStored] = useState<TravelContext>(loadTravelContext);
  const storedRef = useRef(stored);
  storedRef.current = stored;
  // 이번 세션에 고른 칩(웹 nextspot_active_filter) — 있으면 그 칩으로 열고 밤의 첫 화면 전환은 하지 않는다(G2-02 · G2-29).
  const [sessionTab] = useState<HomeTab | null>(() => tabFromFilterId(sessionGet(MAP_SESSION_KEYS.filter)));
  const [category, setCategory] = useState<PlaceCategory>(() =>
    sessionTab && sessionTab !== 'parking' ? sessionTab : homeFilterSeed(stored).category);
  const [parkingTab, setParkingTab] = useState(sessionTab === 'parking');
  const firstViewPendingRef = useRef(sessionTab === null);
  const [query, setQuery] = useState('');
  const [panelOpen, setPanelOpen] = useState(true);
  // 지도 핀만 거르는 편의 조건(🅿) — 추천 조건이 아니라 저장하지 않는다(웹 showParkingFilter).
  const [parkingFilter, setParkingFilter] = useState(false);
  const [cuisineId, setCuisineId] = useState<string | null>(null);
  // 추천 점수에 넘길 음식 의도(웹 cuisineIntentRef) — 첫 설정 음식으로 시작, 칩을 바꾸면 비우고, 음식 칩을 고르면 그 칩의 kw.
  const [cuisineIntent, setCuisineIntent] = useState<string | null>(() => cuisineIntentOf(stored));
  const cuisineIntentRef = useRef(cuisineIntent);
  cuisineIntentRef.current = cuisineIntent;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [recs, setRecs] = useState<RecommendationResponse[] | null>(null);
  // 추천 요청이 실패했다(G3-26 — 카드 자리에 오류 판). 다시 시도는 recsNonce 로 같은 조건을 다시 묻는다.
  const [recsFailed, setRecsFailed] = useState(false);
  const [recsNonce, setRecsNonce] = useState(0);
  // 카드가 '다음 후보' 없이 끝났다(거절·킵으로 다 넘김) — 웹 noRecommendation(후보 소진). 새 추천이 오면 풀린다.
  const [exhausted, setExhausted] = useState<{ closedToday: boolean } | null>(null);
  // 서버가 도보 제한을 풀고 매긴 칩·기준(웹 serverWalkRelaxedFor) — 그동안 카드의 '🚶 도보 N분 이내' 칩을 감춘다.
  const [walkRelaxedFor, setWalkRelaxedFor] = useState<string | null>(null);
  // 이번 세션에 거절한 곳(세션 저장소 — 웹과 같은 키)과 저장(킵)한 곳. 둘 다 목록·핀 순위에서 빼고 서버에도 빼 달라고 보낸다.
  const [rejectedIds, setRejectedIds] = useState<ReadonlySet<string>>(loadRejectedIds);
  const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(savedIdSet);
  const excluded = useMemo<ReadonlySet<string>>(() => new Set(buildExcludeIds(rejectedIds, savedIds)), [rejectedIds, savedIds]);
  // ✨ 경주 테마(웹 showDiscoveryThemes · activeDiscovery · discoveryLoading). 켜져 있으면 추천 요청이 칩 대신 테마로 간다.
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [activeDiscovery, setActiveDiscovery] = useState<ActiveDiscovery | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const activeDiscoveryRef = useRef(activeDiscovery);
  activeDiscoveryRef.current = activeDiscovery;
  const [activeGroup, setActiveGroup] = useState<PinCluster<HomeFacility> | null>(null);
  const [festival, setFestival] = useState<FestivalFocus | null>(null);
  const [placePin, setPlacePin] = useState<PlacePin | null>(null);
  const [viewport, setViewport] = useState<MapViewport | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapUnavailable, setMapUnavailable] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [weatherAnchor, setWeatherAnchor] = useState<PillAnchor | null>(null);
  const [headerH, setHeaderH] = useState(insets.top + HEADER_TOP + 100);
  const [containerH, setContainerH] = useState(0);
  // 다시 계산 중(웹 recalcLabel) — 예측 띠 칸·'다른 시간'을 바꾸면 카드 자리에 스켈레톤 '… 기준으로 다시 계산 중…'.
  const [recalc, setRecalc] = useState<string | null>(null);
  // 카드가 미리보기인가(웹 cardPeek) — 펼친 카드 위에는 예측 띠를 보이지 않는다(G2-24). 카드가 없어지면 true 로 되돌린다.
  const [cardPeek, setCardPeek] = useState(true);
  const [parkingPanelH, setParkingPanelH] = useState(0);
  const [mapPaddingBottom, setMapPaddingBottom] = useState(0);
  // 키보드가 이 화면 아래를 가린 두께 — 진행 중 여행 카드의 '상황 변경' 입력 칸이 키보드 밑으로 숨지 않게 카드 최대 높이를 줄인다.
  const rootRef = useRef<View>(null);
  const searchInputRef = useRef<TextInput>(null);
  const bottomInsetRef = useRef(insets.bottom);
  bottomInsetRef.current = insets.bottom;
  const [keyboardCover, setKeyboardCover] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      const android = Platform.OS === 'android';
      const windowH = Dimensions.get('window').height;
      const screenH = android ? Dimensions.get('screen').height : windowH;
      const navBar = android ? bottomInsetRef.current : 0;
      rootRef.current?.measureInWindow((_x, y, _w, h) => setKeyboardCover(keyboardCoverFor({
        rootY: y, rootH: h, windowH, screenH, keyboardH: e.endCoordinates.height, navBar,
      })));
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardCover(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  // 사용자가 이 칩에서 직접 고른 카드가 있으면 추천 1위가 늦게 와도 덮지 않는다(웹 userPickRef).
  const pickedRef = useRef(false);
  const facilitiesRef = useRef(facilities);
  facilitiesRef.current = facilities;
  const excludedRef = useRef(excluded);
  excludedRef.current = excluded;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  // 로그인 사용자면 저장 목록을 원격과 맞춘다(기기 변경 복원 — 웹과 같다). 실패하면 로컬 그대로.
  useEffect(() => {
    let alive = true;
    void syncSaved()
      .then((list) => { if (alive) setSavedIds(new Set(list.map((b) => b.id))); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);
  // 탭에 돌아올 때 — 저장 탭에서 지웠을 수 있고, 첫 설정을 다시 했을 수 있다.
  useFocusEffect(useCallback(() => {
    setSavedIds((prev) => {
      const next = savedIdSet();
      return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
    });
    const nextStored = loadTravelContext();
    if (JSON.stringify(nextStored) !== JSON.stringify(storedRef.current)) {
      setStored(nextStored);
      setParkingTab(false);
      setCategory(homeFilterSeed(nextStored).category);
      setCuisineId(null);
      setCuisineIntent(cuisineIntentOf(nextStored));
      setActiveDiscovery(null);
      setDiscoveryLoading(false);
      setSelection(null);
      pickedRef.current = false;
    }
  }, []));

  const byId = useMemo(() => new Map(facilities.map((f) => [f.id, f])), [facilities]);
  const hasFacilities = facilities.length > 0;
  const accessibleOn = stored.requiredAttributes.includes('accessible');
  const strollerOn = stored.requiredAttributes.includes('stroller');
  const indoorOn = stored.requiredAttributes.includes('indoor');
  const convenience: Convenience = useMemo(
    () => ({ accessible: accessibleOn, stroller: strollerOn, parking: parkingFilter, pet: false }),
    [accessibleOn, strollerOn, parkingFilter],
  );
  // 서버에 보낼 조건 — 칩이 유형을 정하니 categories 는 비운다(웹 chipRankingContext).
  const travelContext = useMemo<TravelContext>(() => ({ ...stored, categories: [] }), [stored]);

  const parking = useParkingLots(parkingTab, userPoint);

  // ── 혼잡 예측 띠(G2-24) · 다시 계산(웹 startRecalc · finishRecalc · abandonRecalc) ──────────────
  const recalcRef = useRef<Recalc | null>(null);
  const recalcTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRecalc = useCallback((label: string) => {
    if (recalcTimerRef.current) { clearTimeout(recalcTimerRef.current); recalcTimerRef.current = null; }
    recalcRef.current = { label, prevTopId: selectionRef.current?.id ?? null, startedAt: Date.now() };
    setRecalc(label);
  }, []);
  const abandonRecalc = useCallback(() => {
    recalcRef.current = null;
    if (recalcTimerRef.current) { clearTimeout(recalcTimerRef.current); recalcTimerRef.current = null; }
    setRecalc(null);
  }, []);
  const finishRecalc = useCallback((topId: string | null) => {
    const pending = recalcRef.current;
    if (!pending) return;
    recalcRef.current = null;
    const same = pending.prevTopId !== null && topId !== null && pending.prevTopId === topId;
    const delay = Math.max(0, RECALC_MIN_MS - (Date.now() - pending.startedAt));
    if (recalcTimerRef.current) clearTimeout(recalcTimerRef.current);
    recalcTimerRef.current = setTimeout(() => {
      recalcTimerRef.current = null;
      setRecalc(null);
      showToast(same ? t('assume.sameResult') : t('assume.recalculated', { label: pending.label }));
    }, delay);
  }, [showToast, t]);
  useEffect(() => {
    if (!recalc) return;
    const timer = setTimeout(abandonRecalc, RECALC_EMERGENCY_MS);
    return () => clearTimeout(timer);
  }, [recalc, abandonRecalc]);
  useEffect(() => () => { if (recalcTimerRef.current) clearTimeout(recalcTimerRef.current); }, []);

  const strip = useForecastStrip({
    // ✨ 테마가 켜져 있으면 띠를 바꿔도 다시 묻지 않으니(아래 requestBasis) 다시 계산 스켈레톤도 띄우지 않는다.
    onChange: (c) => {
      if (activeDiscoveryRef.current) return;
      startRecalc(
        c.kind === 'hours'
          ? (c.hours ? t('forecast.ahead', { h: c.hours }) : t('forecast.now'))
          : t(assumedPresetLabelKey(c.id)),
      );
    },
    onFail: () => { abandonRecalc(); showToast(t('map.predictFail')); },
  });
  // 순위 기준(웹 rankBasis) — +N시간·다른 시간·여행 조건. 바뀌면 직접 고른 카드도 놓아준다(웹 1901).
  const rankBasis = `${strip.basisKey}|${JSON.stringify(travelContext)}`;
  // 추천 요청의 기준 — ✨ 테마 요청은 가정 시각(assumedAt)을 보내지 않으니 띠 기준을 빼고 여행 조건만 본다. 웹은 띠를 바꾸면 같은
  // 테마 요청을 다시 보내고 '다시 계산했어요' 를 띄우지만 결과가 같을 수밖에 없어 앱은 다시 묻지 않는다(의도한 차이 — F2 검토 L1).
  const requestBasis = activeDiscovery && !parkingTab ? `theme|${JSON.stringify(travelContext)}` : rankBasis;

  // ── 카메라 ───────────────────────────────────────────────────────────
  const searching = query.trim() !== '';
  // 띠 아래 두께에 쓰는 스택 높이 — 카드가 펼쳐져 있는 동안은 마지막 미리보기 때 값(§3.3 G2-01 ②).
  const bandStackRef = useRef(0);
  const liveStackRef = useRef(0);
  const expandedRef = useRef(false);
  const parkingPanelRef = useRef(0);
  const parkingTabRef = useRef(parkingTab);
  parkingTabRef.current = parkingTab;
  const headerRef = useRef(headerH);
  headerRef.current = headerH;
  const navGapRef = useRef(nav.gap);
  navGapRef.current = nav.gap;
  const navBarRef = useRef(nav.barHeight);
  navBarRef.current = nav.barHeight;
  const bandInsets = useCallback(() => ({
    top: headerRef.current + 8,
    bottom: bandBottomInset({
      stackHeight: parkingTabRef.current ? navGapRef.current : bandStackRef.current,
      navGap: navGapRef.current,
      parkingPanelHeight: parkingTabRef.current ? parkingPanelRef.current : 0,
    }),
  }), []);
  const lastFocusRef = useRef<Focus | null>(null);
  const focusOn = useCallback((latitude: number, longitude: number, level?: number) => {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    lastFocusRef.current = { latitude, longitude, level, at: Date.now() };
    mapRef.current?.animateTo({ latitude, longitude }, { level, insets: bandInsets() });
  }, [bandInsets]);
  /** 방금 옮긴 핀을 바뀐 띠로 다시 맞춘다(스켈레톤 → 카드 미리보기, 주차장 판이 뜸 — 웹은 높이를 재지 않고 같은 프레임에 그린다). */
  const refocusIfRecent = useCallback(() => {
    const last = lastFocusRef.current;
    if (!last || Date.now() - last.at > REFOCUS_WINDOW_MS) return;
    mapRef.current?.animateTo({ latitude: last.latitude, longitude: last.longitude }, { level: last.level, insets: bandInsets(), duration: 250 });
  }, [bandInsets]);

  // 지도 패딩(F12 · 구글 로고 약관) — 스택(또는 주차장 판) 높이 + 8, 8 단위, 잠깐 기다렸다 넘긴다.
  const paddingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerHRef = useRef(containerH);
  containerHRef.current = containerH;
  const schedulePadding = useCallback(() => {
    if (paddingTimerRef.current) clearTimeout(paddingTimerRef.current);
    paddingTimerRef.current = setTimeout(() => {
      paddingTimerRef.current = null;
      const covered = parkingTabRef.current
        ? Math.max(navGapRef.current, parkingPanelRef.current > 0 ? parkingPanelRef.current + navGapRef.current : 0)
        : liveStackRef.current;
      const cap = containerHRef.current > 0 ? containerHRef.current * 0.6 : covered + 8;
      setMapPaddingBottom(stablePadding(Math.min(covered + 8, cap)));
    }, PADDING_SETTLE_MS);
  }, []);
  useEffect(() => () => { if (paddingTimerRef.current) clearTimeout(paddingTimerRef.current); }, []);
  useEffect(() => { schedulePadding(); }, [parkingTab, schedulePadding]);

  const bandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onStackLayout = useCallback((height: number) => {
    const h = Math.round(height);
    liveStackRef.current = h;
    schedulePadding();
    // 카드가 미리보기 → 펼침으로 바뀌는 순간의 높이는 onPeekChange 보다 먼저 올 수 있다 — 한 박자 뒤에 '펼침이 아닌가'를 보고 띠에 넣는다.
    if (bandTimerRef.current) clearTimeout(bandTimerRef.current);
    bandTimerRef.current = setTimeout(() => {
      bandTimerRef.current = null;
      if (expandedRef.current || Math.abs(bandStackRef.current - liveStackRef.current) <= 2) return;
      bandStackRef.current = liveStackRef.current;
      refocusIfRecent();
    }, 60);
  }, [refocusIfRecent, schedulePadding]);
  useEffect(() => () => { if (bandTimerRef.current) clearTimeout(bandTimerRef.current); }, []);
  const onParkingHeight = useCallback((height: number) => {
    parkingPanelRef.current = height;
    setParkingPanelH(height);
    if (height > 0) refocusIfRecent();
    schedulePadding();
  }, [refocusIfRecent, schedulePadding]);

  // 첫 진입(웹 initMap): 이번 세션에 보던 자리가 있으면 그대로(sessionStorage 복원), 없으면 지금 기준점(내 위치 또는 지역 중심)을
  // 띠 가운데로(centerOnFreeArea). 지도가 뜨기 전에 추천 1위로 옮기라는 요청이 이미 왔으면 그 자리로 — 웹은 위치가 늦게 잡혀도
  // 지도를 내 위치로 끌고 가지 않는다(1위 핀이 기준점 가까이에 있다).
  const [restored] = useState(() => parseMapSession(
    sessionGet(MAP_SESSION_KEYS.lat), sessionGet(MAP_SESSION_KEYS.lng), sessionGet(MAP_SESSION_KEYS.level),
  ));
  const centeredRef = useRef(false);
  useEffect(() => {
    if (!mapReady || centeredRef.current) return;
    centeredRef.current = true;
    if (restored && !nearCenter(restored, REGION.center)) {
      mapRef.current?.animateTo({ latitude: restored.latitude, longitude: restored.longitude }, { level: restored.level ?? 4, duration: 0 });
      return;
    }
    const last = lastFocusRef.current;
    if (last) {
      // 지금 옮긴 것으로 친다 — 곧 스택이 스켈레톤 → 카드로 바뀌면 새 띠로 한 번 더 맞춘다(refocusIfRecent).
      lastFocusRef.current = { ...last, at: Date.now() };
      mapRef.current?.animateTo({ latitude: last.latitude, longitude: last.longitude }, { level: last.level ?? restored?.level ?? 4, duration: 0, insets: bandInsets() });
      return;
    }
    mapRef.current?.animateTo({ latitude: userPoint.lat, longitude: userPoint.lng }, { level: restored?.level ?? 4, duration: 0, insets: bandInsets() });
  }, [mapReady, userPoint.lat, userPoint.lng, restored, bandInsets]);
  const onRegionChangeComplete = useCallback((v: MapViewport) => {
    setViewport(v);
    if (!centeredRef.current) return; // 첫 영역(기본 중심)으로 세션 기억을 덮지 않는다
    sessionSet(MAP_SESSION_KEYS.lat, String(v.region.latitude));
    sessionSet(MAP_SESSION_KEYS.lng, String(v.region.longitude));
    sessionSet(MAP_SESSION_KEYS.level, String(v.level));
  }, []);

  // ── 위치 안내(D3 ① — 웹처럼 버튼·배너 없이 알약만) ─────────────────────
  // 웹 빌드는 웹처럼 브라우저 권한 창을 바로 묻는다(사전 안내 화면은 네이티브만 — G2-32 ①).
  const askedBrowserRef = useRef(false);
  const continueFromPrimer = loc.continueFromPrimer;
  useEffect(() => {
    if (Platform.OS !== 'web' || loc.status !== 'needs-primer' || askedBrowserRef.current) return;
    askedBrowserRef.current = true;
    continueFromPrimer();
  }, [loc.status, continueFromPrimer]);
  useEffect(() => {
    if (loc.notice !== 'outOfRegion') return;
    // 도보 N분이 어디서 잰 값인지 모르면 '내 위치' 거리로 읽힌다 — 세션에 한 번만 알린다(웹과 같다).
    if (sessionGet(OUT_OF_REGION_NOTICE_KEY) === '1') return;
    sessionSet(OUT_OF_REGION_NOTICE_KEY, '1');
    showToast(t('map.outOfRegionStart'));
  }, [loc.notice, t, showToast]);
  // 위치를 쓸 수 없다(거부 · 동의 없음 · 읽기 실패 · 대략적 위치 — 황리단길 중심 기준) — 웹 map.locationFallback 알약 한 번.
  const fallbackShownRef = useRef(false);
  const locationFallback = loc.status === 'denied' || loc.status === 'no-consent' || loc.readFailed
    || (loc.status === 'granted' && loc.notice === 'coarse');
  useEffect(() => {
    if (!locationFallback || fallbackShownRef.current) return;
    fallbackShownRef.current = true;
    showToast(t('map.locationFallback'));
  }, [locationFallback, t, showToast]);

  // ── 서버 추천(칩 종류별 상위 5) ─────────────────────────────────────
  const userKey = `${userPoint.lat.toFixed(4)},${userPoint.lng.toFixed(4)}`;
  // 지난 요청의 칩·기준 — 같은 칩·기준의 재요청(위치·시설 갱신 · 다시 시도)은 떠 있던 카드를 지우지 않고 그대로 둔다(H3a 검토 L3).
  const lastRequestRef = useRef<{ tab: string; basis: string } | null>(null);
  const recsRef = useRef(recs);
  recsRef.current = recs;
  const keepSelectionRef = useRef(false);
  useEffect(() => {
    const discovery = parkingTab ? null : activeDiscovery;
    const tabKey = discoveryRequestKey(discovery) ?? (parkingTab ? 'parking' : category);
    const prev = lastRequestRef.current;
    const tabChanged = prev?.tab !== tabKey;
    const basisChanged = prev?.basis !== requestBasis;
    if (parkingTab) {
      // 주차장 탭은 추천을 묻지 않는다 — 다시 계산도 말없이 거둔다(웹 1904-1909).
      lastRequestRef.current = { tab: tabKey, basis: requestBasis };
      setRecs(null);
      setSelection(null);
      abandonRecalc();
      return;
    }
    if (!hasFacilities) { abandonRecalc(); return; }
    lastRequestRef.current = { tab: tabKey, basis: requestBasis };
    if (basisChanged) pickedRef.current = false;
    keepSelectionRef.current = !tabChanged && !basisChanged;
    if (tabChanged) { setRecs(null); setRecsFailed(false); }
    let cancelled = false;
    const controller = new AbortController();
    // ✨ 경주 테마(웹 :1926-2027) — 유명 장소 자체가 아니라 그 명소를 기준(original)으로 보내, TourAPI 연관성·도착 영업·보행 경로를
    // 통과한 같은 종류 대안을 서버 SPOT 으로 다시 매긴다. 칩 추천(by-type)과 섞이지 않게 이 갈래만 묻는다.
    if (discovery) {
      const theme = getDiscoveryTheme(discovery.themeId);
      setDiscoveryLoading(true);
      (async () => {
        try {
          const res = await getRecommendations(discovery.anchorId, userPoint, discoveryRequestContext(storedRef.current, theme), {
            preferenceIntent: theme.preferenceIntent,
            candidateTypes: [theme.candidateType],
            discoveryTheme: theme.id,
            signal: controller.signal,
          });
          if (cancelled) return;
          const known = new Set(facilitiesRef.current.map((f) => f.id));
          const listed = res.filter((r) => known.has(r.facility.id));
          setDiscoveryLoading(false);
          setWalkRelaxedFor(null);
          setRecsFailed(false);
          if (!listed.some((r) => !excludedRef.current.has(r.facility.id))) {
            // 이 경우의 안내는 토스트 하나 — '다시 계산했어요' 를 겹치지 않는다. '서버가 대안을 못 찾았다' 일 때만 그렇게 말한다(웹 :2003-2011).
            abandonRecalc();
            if (res.length === 0) showToast(t('discovery.noAlternatives', { anchor: discovery.anchorName }));
          }
          setRecs(listed);
        } catch {
          // 웹은 테마 실패를 '추천 없음'으로 둔다(오류 판 아님, :2017-2026) — 다시 계산은 끝났다고 말한다(recs 효과의 finishRecalc).
          if (cancelled) return;
          setDiscoveryLoading(false);
          setRecsFailed(false);
          setRecs([]);
        }
      })();
      return () => { cancelled = true; controller.abort(); };
    }
    // 칩 안에 여행 조건으로 오를 곳이 하나도 없으면 묻지 않는다(웹 chipCandidates 0 → noRecommendation).
    const eligible = chipCandidates(chipPool(facilitiesRef.current, category), travelContext, userPoint);
    if (eligible.items.length === 0) {
      setRecsFailed(false);
      setWalkRelaxedFor(null);
      setRecs([]);
      return;
    }
    // 웹 rankContext(page.tsx 2049-2053 · 2167) — 칩 안에서 엄격한 조건으로 0곳이면 이미 도보 제한을 푼 조건으로 묻는다.
    const rankContext = eligible.context;
    // 거절·저장 id 는 요청 때의 값(ref)으로 — 거절할 때마다 다시 묻지 않는다(웹도 dep 에서 뺐다).
    const excludeIds = [...excludedRef.current];
    const intent = cuisineIntentRef.current;
    const assumedAt = strip.assumedAtIso();
    const request = (context: TravelContext) =>
      recommendByType(category, userPoint, excludeIds, 5, context, intent, controller.signal, RECOMMENDATION_TIMEOUT_MS, assumedAt);
    (async () => {
      try {
        let res = await request(rankContext);
        // 서버는 실제 걷는 길로 도보 제한을 잰다 — 0곳이고 아직 도보 제한이 걸려 있으면 그것만 풀어 한 번 더(웹 relaxWalkLimit).
        const relaxed = res.length === 0 ? relaxWalkLimit(rankContext) : null;
        if (relaxed && !cancelled) res = await request(relaxed);
        if (cancelled) return;
        const known = new Set(facilitiesRef.current.map((f) => f.id));
        setWalkRelaxedFor(relaxed && res.length > 0 ? `${category}|${rankBasis}` : null);
        setRecsFailed(false);
        setRecs(res.filter((r) => known.has(r.facility.id)));
      } catch {
        // 실패 — 화면 안에서 점수를 지어내지 않고 카드 자리에 오류 판 + 다시 시도(G3-26, 'SPOT 은 백엔드 단일 소스').
        if (cancelled) return;
        abandonRecalc();
        // 같은 칩의 재요청(+N시간 · 조건 · 위치 갱신)이 실패하면 보던 목록·카드를 그대로 두고 알린다 — 카드가 순위·고리를 말없이
        // 잃지 않게. 첫 요청(칩이 바뀜 · 목록 없음)이면 같은 자리에 오류 판(직접 고른 카드는 그대로).
        if (!tabChanged && (recsRef.current?.length ?? 0) > 0) {
          showToast(t('recommend.loadFailed'));
          return;
        }
        if (!pickedRef.current) setSelection(null);
        setRecsFailed(true);
        setRecs([]);
      }
    })();
    return () => { cancelled = true; controller.abort(); };
    // userPoint 는 userKey 로, facilities 는 ref 로 본다 — 목록이 갱신될 때마다 다시 묻지 않는다. strip.assumedAtIso 는 rankBasis 로.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFacilities, parkingTab, category, userKey, requestBasis, recsNonce, activeDiscovery]);

  const visibleRecs = useMemo(() => (recs ?? []).filter((r) => !excluded.has(r.facility.id)), [recs, excluded]);
  const rankById = useMemo(() => {
    const ranks = new Map<string, number>();
    visibleRecs.slice(0, 5).forEach((r, i) => ranks.set(r.facility.id, i + 1));
    return ranks;
  }, [visibleRecs]);

  // ── 표시 시설 ────────────────────────────────────────────────────────
  const cuisineChip = cuisineId ? CUISINE_CHIPS.find((c) => c.id === cuisineId) ?? null : null;
  const filtered = useMemo(() => applyConvenience(facilities, convenience), [facilities, convenience]);
  const poolList = useMemo(() => {
    const base = cuisineChip && !query.trim() ? filtered.filter((f) => matchesCuisineChip(f, cuisineChip)) : filtered;
    return selectByCategoryOrSearch(base, category, query);
  }, [filtered, cuisineChip, category, query]);
  const nearestOf = useCallback(<T extends LatLng>(list: readonly T[]) => {
    const origin = { latitude: userPoint.lat, longitude: userPoint.lng };
    return [...list].sort((a, b) => distanceM(origin, a) - distanceM(origin, b))[0] ?? null;
  }, [userPoint.lat, userPoint.lng]);

  // ── 선택 ─────────────────────────────────────────────────────────────
  /** 도착 뒤 30분 안에 닫는 곳은 조용히 바꾸지 않는다 — 이유를 말하고 다음 추천으로(웹 selectFacilityWithHoursGuard). */
  const select = useCallback((facility: HomeFacility, kind: PickKind): boolean => {
    const rec = visibleRecs.find((r) => r.facility.id === facility.id);
    const walk = walkingMinutes(distanceM({ latitude: userPoint.lat, longitude: userPoint.lng }, facility));
    const status = rec?.openStatusAtArrival
      ?? getArrivalOpenStatus(facility.operatingHours, new Date(Date.now() + walk * 60_000));
    // 어느 갈래든 다른 선택으로 바뀌니 묶음 말풍선·축제 표시는 닫는다(H3a 검토 L6).
    setActiveGroup(null);
    setFestival(null);
    if (status === 'closing_soon') {
      const alt = visibleRecs.find((r) => r.facility.id !== facility.id && r.openStatusAtArrival === 'open_expected');
      const altFacility = alt ? byId.get(alt.facility.id) : undefined;
      showToast(t(altFacility ? 'map.closingSoonRedirect' : 'map.closingSoonNoAlternative', { name: facility.name }));
      pickedRef.current = false;
      if (altFacility) {
        setSelection({ id: altFacility.id, kind: 'recommended' });
        focusOn(altFacility.latitude, altFacility.longitude);
      } else {
        setSelection(null);
      }
      return false;
    }
    pickedRef.current = kind !== 'recommended';
    setSelection({ id: facility.id, kind });
    return true;
  }, [visibleRecs, userPoint.lat, userPoint.lng, byId, focusOn, t, showToast]);

  // 조건 핀(♿·👶)을 지도 한 화면에 모은다(웹 fitAttributePins) — 카드에 오를 곳이 없어도 어디 있는지는 보인다. 지도 전이면 준비되는 대로.
  const pendingPinFitRef = useRef<{ type: PlaceCategory; attributes: PinAttribute[] } | null>(null);
  const fitAttributePins = useCallback((type: PlaceCategory, attributes: readonly PinAttribute[]) => {
    if (attributes.length === 0) return;
    if (!mapReady) { pendingPinFitRef.current = { type, attributes: [...attributes] }; return; }
    const pins = facilitiesRef.current.filter((f) => f.type === type && hasPinAttributes(f, attributes)
      && Number.isFinite(f.latitude) && Number.isFinite(f.longitude));
    if (pins.length === 0) return;
    if (pins.length === 1) { focusOn(pins[0].latitude, pins[0].longitude); return; }
    const band = bandInsets();
    const h = containerHRef.current;
    mapRef.current?.fitToCoordinates(pins.map((f) => ({ latitude: f.latitude, longitude: f.longitude })), {
      padding: { top: Math.min(band.top, Math.round(h * 0.5)) + 16, right: 24, bottom: Math.min(band.bottom, Math.round(h * 0.4)) + 16, left: 24 },
    });
  }, [mapReady, focusOn, bandInsets]);
  useEffect(() => {
    const pending = pendingPinFitRef.current;
    if (!mapReady || !pending) return;
    pendingPinFitRef.current = null;
    fitAttributePins(pending.type, pending.attributes);
  }, [mapReady, fitAttributePins]);

  /** 칩·탭을 바꾼다 — 칩 탭 · ♿·👶 자동 전환 · 제안 상자 · 밤의 첫 화면이 같은 길을 탄다(웹 selectCategory). */
  const switchTab = useCallback((next: HomeTab) => {
    firstViewPendingRef.current = false;
    pickedRef.current = false;
    if (next === 'parking') setParkingTab(true);
    else { setParkingTab(false); setCategory(next); }
    setSelection(null);
    setActiveGroup(null);
    setCuisineId(null);
    setCuisineIntent(null); // 웹 selectCategory 가 cuisineIntentRef 를 비운다(page.tsx 3320)
    // 테마 요청이 아직 오는 중이면 테마 다시 계산을 거둔다 — 남겨 두면 칩 추천이 끝날 때 '<테마> 기준으로 다시 계산했어요' 가 뜬다.
    if (activeDiscoveryRef.current) abandonRecalc();
    setActiveDiscovery(null);
    setDiscoveryLoading(false);
    setFestival(null);
    parking.select(null);
    sessionSet(MAP_SESSION_KEYS.filter, FILTER_IDS[next]);
  }, [parking, abandonRecalc]);

  /**
   * ✨ 테마를 켠다(웹 activateDiscoveryTheme) — 기준 명소가 지도에 없으면 토스트만. 켜면 그 테마의 종류 칩으로 옮기고, 카드 자리에
   * '… 기준으로 다시 계산 중' 스켈레톤을 바로 띄운다(결과가 와야만 바뀌면 그 몇 초는 죽은 칩이다). 이용 이벤트는 웹과 같은 한 건.
   */
  const onPickTheme = useCallback((theme: DiscoveryTheme) => {
    haptic('selection');
    const next = activateDiscovery(facilitiesRef.current, theme);
    if (!next) { showToast(t('discovery.noAnchor')); return; }
    startRecalc(t(`discovery.theme.${theme.id}`));
    firstViewPendingRef.current = false;
    pickedRef.current = false;
    setCuisineId(null);
    setCuisineIntent(theme.preferenceIntent); // 웹 cuisineIntentRef = theme.preferenceIntent(핀 순서도 이 의도로)
    setActiveGroup(null);
    parking.select(null);
    setParkingTab(false);
    setCategory(theme.candidateType);
    setActiveDiscovery(next);
    setDiscoveryLoading(true);
    setSelection(null);
    setExhausted(null);
    setDiscoveryOpen(false);
    sessionSet(MAP_SESSION_KEYS.filter, FILTER_IDS[theme.candidateType]);
    track('gyeongju_theme_selected', {
      theme_id: theme.id,
      reference_facility_id: next.anchorId,
      candidate_type: theme.candidateType,
    });
  }, [parking, startRecalc, showToast, t]);
  /** 일반 추천으로 돌아간다(웹 clearDiscoveryTheme) — 지금 칩으로 다시 묻는다(요청 열쇠가 바뀐다). */
  // 선택을 바꾸는 누름이라 분류 칩처럼 햅틱(여닫기만 하는 ✨ 알약 · 판 ✕ 는 날씨 · 필터 알약처럼 없음).
  const clearTheme = useCallback(() => {
    haptic('selection');
    abandonRecalc(); // 테마 요청 중에 끄면 테마 다시 계산을 거둔다(아니면 '<테마> 기준으로 다시 계산했어요' 오보)
    pickedRef.current = false;
    setCuisineIntent(null); // 웹 clearDiscoveryTheme — cuisineIntentRef = null
    setActiveDiscovery(null);
    setDiscoveryLoading(false);
    setSelection(null);
    setExhausted(null);
  }, [abandonRecalc]);
  const onTabChip = useCallback((next: HomeTab) => {
    haptic('selection');
    // 웹 selectCategory 는 이용 이벤트를 보내지 않는다 — 같은 동작에 웹에 없는 쓰기를 더하지 않는다.
    switchTab(next);
  }, [switchTab]);

  /** 밤의 첫 화면(G2-29) — 처음 열린 칩에 지금 추천할 곳이 없으면 한 번만, 지금 열 곳이 가장 많은 칩으로 옮기고 알린다. */
  const maybeSwitchFirstView = useCallback((current: PlaceCategory) => {
    if (!firstViewPendingRef.current) return;
    firstViewPendingRef.current = false;
    const counts = candidateCountsByType(facilitiesRef.current, travelContext, userPoint, { excluded: excludedRef.current, openOnly: true });
    const next = pickFirstViewCategory(counts, current);
    if (!next) return;
    switchTab(next);
    showToast(t('map.firstViewSwitched', { to: t(`category.${next}`) }));
  }, [travelContext, userPoint, switchTab, showToast, t]);

  // 추천이 도착하면 — 같은 칩·기준의 재요청이고 보던 카드가 새 목록에도 있으면 그대로, 아니면 1위를 카드 자리에 연다.
  // 0곳이면 비워 두고 제안 상자(G3-27)가, 실패면 오류 판(G3-26)이 같은 자리를 쓴다.
  useEffect(() => {
    if (recs === null) return;
    setExhausted(null);
    if (recsFailed) return;
    if (pickedRef.current) { abandonRecalc(); return; }
    const current = selectionRef.current;
    if (keepSelectionRef.current && current && visibleRecs.some((r) => r.facility.id === current.id)) {
      finishRecalc(current.id);
      return;
    }
    const top = visibleRecs[0] ? byId.get(visibleRecs[0].facility.id) : undefined;
    if (!top) {
      setSelection(null);
      finishRecalc(null);
      // 테마 대안이 0곳이면 테마 판과 토스트가 말한다 — 조건 핀 맞추기·밤의 첫 화면은 칩 추천에만(웹 테마 갈래에는 없다).
      if (activeDiscoveryRef.current) return;
      // ♿·👶 가 켜져 있는데 0곳 — 빈 지도로 두지 않고 조건 핀으로 지도를 맞춘다(제안 상자가 '지도에 N곳').
      fitAttributePins(category, pinAttributesOf(travelContext.requiredAttributes));
      maybeSwitchFirstView(category);
      return;
    }
    firstViewPendingRef.current = false;
    setSelection({ id: top.id, kind: 'recommended' });
    focusOn(top.latitude, top.longitude);
    finishRecalc(top.id);
    // 추천이 바뀔 때만 — 선택·위치가 바뀔 때마다 1위로 되돌리지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recs]);

  const selected = selection ? byId.get(selection.id) ?? null : null;
  // 카드가 없어지면 미리보기로 되돌린다 — 펼친 채 닫힌 카드가 예측 띠를 계속 감추지 않게(H3a 검토 M1).
  useEffect(() => { if (!selected) setCardPeek(true); }, [selected]);
  const cardExpanded = !!selected && !recalc && !cardPeek;
  expandedRef.current = cardExpanded;

  // ── ♿·👶·실내 조건(G2-28) — 저장하고, 켤 때 지금 칩이 0곳이면 가장 많은 칩으로 옮긴다 ──────────
  const updateContext = useCallback((next: TravelContext) => {
    if (next === storedRef.current) return;
    storedRef.current = next;
    setStored(next);
    saveTravelContext(next);
    trackContext(next);
  }, []);
  /** 켠 뒤의 조건 핀이 있는 칩(지금 칩에 있으면 지금 칩)에서 그 핀들로 지도를 맞춘다(웹 showAttributePins). */
  const showAttributePins = useCallback((attributes: PinAttribute[]) => {
    const pins = countPinsByType(facilitiesRef.current, attributes);
    let target: PlaceCategory = category;
    if (pins[category] === 0) {
      const best = bestCategory(pins);
      if (!best) return;
      target = best.type;
    }
    if (target !== category) switchTab(target);
    fitAttributePins(target, attributes);
  }, [category, switchTab, fitAttributePins]);
  const onAttributeChip = useCallback((attribute: 'accessible' | 'stroller') => {
    haptic('selection');
    const wasOn = storedRef.current.requiredAttributes.includes(attribute);
    const next = withAttribute(storedRef.current, attribute, !wasOn);
    updateContext(next);
    if (wasOn || parkingTab) return;
    const counts = candidateCountsByType(facilitiesRef.current, { ...next, categories: [] }, userPoint);
    if (counts[category] > 0) return;
    const best = bestCategory(counts);
    if (best) {
      switchTab(best.type);
      showToast(t(attribute === 'accessible' ? 'map.barrierFreeSwitched' : 'map.strollerSwitched', {
        category: t(`category.${best.type}`), n: best.count,
      }));
      return;
    }
    showAttributePins(pinAttributesOf(next.requiredAttributes));
  }, [updateContext, parkingTab, userPoint, category, switchTab, showToast, t, showAttributePins]);
  const toggleTool = useCallback((key: 'accessible' | 'stroller' | 'parking') => {
    if (key === 'parking') { haptic('selection'); setParkingFilter((on) => !on); return; }
    onAttributeChip(key);
  }, [onAttributeChip]);
  const toggleIndoor = useCallback((required: boolean) => {
    updateContext(withAttribute(storedRef.current, 'indoor', required));
  }, [updateContext]);
  const onRemoveCondition = useCallback((key: CardCondition['key']) => {
    updateContext(removeCondition(storedRef.current, key as ConditionKey));
  }, [updateContext]);

  const selectCuisine = useCallback((chip: (typeof CUISINE_CHIPS)[number]) => {
    haptic('selection');
    // 음식 칩을 켜거나 끄면 ✨ 테마도 끈다(웹 applyCuisineChip · selectCuisineChip).
    if (cuisineId === chip.id) { setCuisineId(null); setCuisineIntent(null); setActiveDiscovery(null); setDiscoveryLoading(false); return; }
    const pool = filtered.filter((f) => matchesCuisineChip(f, chip) && !excludedRef.current.has(f.id));
    if (pool.length === 0) { showToast(t('cuisine.noMatch')); return; }
    // 웹 applyCuisineChip(3356-3370) — 밤의 첫 화면 전환을 끄고, 음식 의도를 그 칩으로.
    firstViewPendingRef.current = false;
    if (activeDiscoveryRef.current) abandonRecalc(); // 오는 중인 테마 다시 계산을 거둔다(F2 검토 L2)
    setActiveDiscovery(null);
    setDiscoveryLoading(false);
    setCategory('restaurant');
    setCuisineId(chip.id);
    setCuisineIntent(chip.kw);
    setFilterOpen(false);
    const first = nearestOf(pool);
    if (first && select(first, 'pin')) focusOn(first.latitude, first.longitude);
  }, [cuisineId, filtered, nearestOf, select, focusOn, t, showToast, abandonRecalc]);

  // ── 핀 ───────────────────────────────────────────────────────────────
  // 놓는 순서 = 서버 순위 먼저, 같은 순위 안에서는 SPOT 점수(웹 computeDisplayFacilities, G2-03).
  const forecastLevelOf = useCallback((id: string, ranked: boolean) => forecastLevelFor(strip.forecast, id, ranked), [strip.forecast]);
  const parkingPool = useMemo(() => {
    const q = query.trim();
    if (!q) return parking.lots;
    return parking.lots.filter((lot) => facilityMatchesSearch({ name: lot.name, type: 'parking' } as Parameters<typeof facilityMatchesSearch>[0], q));
  }, [parking.lots, query]);
  const pinMarkers: PinMarker[] = useMemo(() => {
    const region = viewport ? { region: viewport.region, size: viewport.size } : null;
    if (parkingTab) {
      return parkingPinMarkers(declutterPins(parkingPool, region, { searching }), {
        selectedId: parking.selected?.id ?? null, busyAt, now: new Date(), forecastMode: strip.forecastMode,
      });
    }
    const ordered = orderPinsBySpot(poolList, rankById, { userLocation: userPoint, preferredCategories, cuisineIntent });
    return buildPinMarkers(declutterPins(ordered, region, { searching }), {
      rankById,
      selectedId: selection?.id ?? null,
      activeGroupId: activeGroup?.key ?? null,
      busyAt,
      now: new Date(),
      groupName: (count) => t('map.placesInBuilding', { count }),
      forecastMode: strip.forecastMode,
      forecastLevelOf,
    });
  }, [parkingTab, parkingPool, parking.selected?.id, poolList, rankById, userPoint, preferredCategories, cuisineIntent, viewport, searching,
    selection?.id, activeGroup?.key, busyAt, t, strip.forecastMode, forecastLevelOf]);
  const gradedPinCount = useMemo(() => pinMarkers.filter((p) => p.pin.style === 'filled').length, [pinMarkers]);

  const markers: NextSpotMarker[] = useMemo(() => {
    const extra: NextSpotMarker[] = [...(festival?.markers ?? [])];
    // 검색 중 일치 핀마다 이름표(G2-19 — 웹 searchMatchLabels).
    if (searching) extra.push(...searchLabelMarkers(pinMarkers));
    if (placePin) {
      const at = { latitude: placePin.latitude, longitude: placePin.longitude };
      extra.push({ kind: 'dot', id: `place-${placePin.id}`, coordinate: at, color: colors.gold, size: 14, zIndex: 90 });
      extra.push({ kind: 'label', id: `place-label-${placePin.id}`, coordinate: at, text: placePin.name, color: colors.muk, above: true, zIndex: 91 });
    }
    return [...pinMarkers, ...extra];
  }, [pinMarkers, festival, placePin, searching]);

  const onMarkerPress = useCallback((marker: NextSpotMarker) => {
    if (marker.kind !== 'pin') return;
    haptic('selection');
    setPlacePin(null);
    if (marker.placeType === 'parking') {
      const lot = marker.data as ParkingLot | undefined;
      if (!lot) return;
      setActiveGroup(null);
      parking.select(lot);
      focusOn(lot.latitude, lot.longitude);
      return;
    }
    const cluster = marker.data as PinCluster<HomeFacility> | undefined;
    if (!cluster) return;
    if (select(cluster.anchor, 'pin')) focusOn(cluster.anchor.latitude, cluster.anchor.longitude);
  }, [select, focusOn, parking]);

  // 같은 건물 묶음 핀(G2-31) — 지도 위 말풍선. 카드는 비우고, 지도는 그 핀으로 단순 이동(띠 가운데 아님 — 웹 panTo).
  const onGroupPress = useCallback((marker: PinMarker) => {
    const cluster = marker.data as PinCluster<HomeFacility> | undefined;
    if (!cluster) return;
    haptic('selection');
    setActiveGroup(cluster);
    setSelection(null);
    setFestival(null);
    pickedRef.current = false;
    lastFocusRef.current = null;
    // 웹 panTo 는 '화면' 가운데(지도가 탭 막대 뒤까지 이어진다) — 앱 지도는 막대 위에서 끝나니 막대 높이만큼 위를 비워 같은 자리로.
    mapRef.current?.animateTo(
      { latitude: cluster.anchor.latitude, longitude: cluster.anchor.longitude },
      { insets: { top: navBarRef.current } },
    );
  }, []);
  const popover: MapPopover | null = useMemo(() => (activeGroup
    ? {
      coordinate: { latitude: activeGroup.anchor.latitude, longitude: activeGroup.anchor.longitude },
      title: t('map.placesInBuilding', { count: activeGroup.members.length }),
      items: activeGroup.members.map((m) => ({ id: m.id, label: m.name })),
    }
    : null), [activeGroup, t]);
  const onPopoverPick = useCallback((id: string) => {
    const member = activeGroup?.members.find((m) => m.id === id);
    setActiveGroup(null);
    if (member && select(member, 'pin')) focusOn(member.latitude, member.longitude);
  }, [activeGroup, select, focusOn]);

  // 안드로이드 뒤로 = 말풍선 닫기(이 화면이 앞에 있을 때만) — 웹은 X 없이 바깥 누름으로 닫는다.
  useFocusEffect(useCallback(() => {
    if (!activeGroup) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setActiveGroup(null); return true; });
    return () => sub.remove();
  }, [activeGroup]));

  const onMapPress = useCallback((_: LatLng) => {
    Keyboard.dismiss();
    setSelection(null);
    setActiveGroup(null);
    setFestival(null);
    setPlacePin(null);
    parking.select(null);
    pickedRef.current = false;
  }, [parking]);

  // ── 검색 ─────────────────────────────────────────────────────────────
  // 우리 장소 일치는 목록 없이 지도 핀 + 이름표로 보인다(G2-19). 일치가 0 일 때만 카카오 → 관광공사를 묻는다.
  const allMatches = useMemo(() => {
    const q = query.trim();
    if (!q || parkingTab) return [];
    return filtered.filter((f) => facilityMatchesSearch(f, q));
  }, [filtered, query, parkingTab]);
  const matchCount = parkingTab ? (query.trim() ? parkingPool.length : 0) : allMatches.length;
  const nearestMatch = useMemo(() => nearestOf(allMatches), [allMatches, nearestOf]);
  const nearestLot = useMemo(() => (parkingTab && query.trim() ? nearestOf(parkingPool) : null), [parkingTab, parkingPool, query, nearestOf]);
  const external = usePlaceSearch(query, matchCount);
  const ingest = useIngestRequest(showToast);
  // 두 글자부터, 일치가 있으면 가장 가까운 곳을 레벨 3 으로 띠 가운데에(웹 :3693-3703). 같은 검색어로는 한 번만.
  const zoomedQueryRef = useRef('');
  const nearestPoint = nearestMatch ?? nearestLot;
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || !nearestPoint) { if (!q) zoomedQueryRef.current = ''; return; }
    if (zoomedQueryRef.current === q) return;
    zoomedQueryRef.current = q;
    focusOn(nearestPoint.latitude, nearestPoint.longitude, 3);
  }, [query, nearestPoint, focusOn]);

  const pickLocal = useCallback((facility: HomeFacility) => {
    Keyboard.dismiss();
    setPanelOpen(false);
    setPlacePin(null);
    if ((CATEGORIES as readonly string[]).includes(facility.type) && facility.type !== category) {
      setCategory(facility.type as PlaceCategory);
      setCuisineId(null);
      sessionSet(MAP_SESSION_KEYS.filter, FILTER_IDS[facility.type as PlaceCategory]);
    }
    if (select(facility, 'search')) focusOn(facility.latitude, facility.longitude, 3);
  }, [category, select, focusOn]);
  const onSubmitSearch = useCallback(() => {
    if (nearestLot) { Keyboard.dismiss(); parking.select(nearestLot); focusOn(nearestLot.latitude, nearestLot.longitude, 3); return; }
    if (nearestMatch) pickLocal(nearestMatch);
  }, [nearestLot, nearestMatch, pickLocal, parking, focusOn]);

  const viewPlace = useCallback((item: PlaceSearchItem | TourApiSearchItem, kind: 'place' | 'tour') => {
    const latitude = kind === 'place' ? (item as PlaceSearchItem).latitude : (item as TourApiSearchItem).mapy;
    const longitude = kind === 'place' ? (item as PlaceSearchItem).longitude : (item as TourApiSearchItem).mapx;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return;
    Keyboard.dismiss();
    setPanelOpen(false);
    setSelection(null);
    setPlacePin({
      id: kind === 'place' ? (item as PlaceSearchItem).placeId : (item as TourApiSearchItem).contentid,
      name: kind === 'place' ? (item as PlaceSearchItem).name : (item as TourApiSearchItem).title,
      latitude,
      longitude,
    });
    focusOn(latitude, longitude, 3);
  }, [focusOn]);

  const onFestivalFocus = useCallback((ev: FestivalEvent) => {
    const focus = festivalFocus(ev, t('app.home.festivalAreaLabel', { title: ev.title }), `🏮 ${ev.title}`);
    if (!focus) return;
    setFilterOpen(false);
    setSelection(null);
    setActiveGroup(null);
    setPlacePin(null);
    setFestival(focus);
    focusOn(focus.center.latitude, focus.center.longitude, focus.area ? 5 : 4);
  }, [focusOn, t]);

  // ── 카드 ─────────────────────────────────────────────────────────────
  const goInstead = useCallback((origin: Parameters<typeof buildInsteadHref>[0]) => {
    router.push(buildInsteadHref(origin, loc.known ? userPoint : null) as never);
  }, [router, loc.known, userPoint]);

  /** 카드가 킵·거절을 처리한 뒤 — 그 장소는 목록·핀 순위에서 빼고(onPutOff·onReject), 카드가 알려 준 다음 후보로 넘어간다(없으면 비운다). */
  const moveToNext = useCallback((done: SheetCandidate, next: SheetCandidate | null) => {
    pickedRef.current = false;
    const facility = next ? byId.get(next.facility.id) : undefined;
    if (facility) {
      setSelection({ id: facility.id, kind: 'recommended' });
      focusOn(facility.latitude, facility.longitude);
      return;
    }
    // 후보 소진 — 남은 곳이 전부 오늘 휴무면 그 사실을 말한다(웹 noOpenTodayOnly).
    setSelection(null);
    const gone = new Set(excludedRef.current).add(String(done.facility.id));
    setExhausted({ closedToday: onlyClosedTodayLeft(facilitiesRef.current, category, gone) });
  }, [byId, focusOn, category]);

  const onPutOff = useCallback((done: SheetCandidate, next: SheetCandidate | null) => {
    setSavedIds((prev) => new Set(prev).add(done.facility.id));
    moveToNext(done, next);
  }, [moveToNext]);
  const onReject = useCallback((done: SheetCandidate, next: SheetCandidate | null) => {
    setRejectedIds((prev) => {
      const updated = new Set(prev).add(done.facility.id);
      sessionSet(REJECTED_IDS_KEY, serializeRejectedIds(updated));
      return updated;
    });
    moveToNext(done, next);
  }, [moveToNext]);

  // 길안내(도보·자동차)를 고른 뒤에도 카드를 닫지 않는다 — 웹처럼 카드가 남아 '바로 갈래요' 가 확인(✓) 상태가 되고,
  // 진행 중 여행 카드가 위에 뜬다. 늦게 온 추천 1위가 이 카드를 덮지 않게 직접 고른 것으로 둔다.
  const keepAfterAccept = useCallback(() => { pickedRef.current = true; }, []);
  const showAlternatives = useCallback((c: SheetCandidate) => {
    goInstead({ facilityId: c.facility.id, type: c.facility.type, latitude: c.facility.latitude, longitude: c.facility.longitude });
  }, [goInstead]);
  const selectedCandidate = useMemo(() => {
    if (!selected || !selection) return null;
    const c = buildSelectedCandidate(selected, selection.kind, visibleRecs, { lat: userPoint.lat, lng: userPoint.lng }, estimateById);
    // 가정 시각(+N·다른 시간)에서는 지금 실측·추정을 그 시각 값처럼 말하지 않는다(웹 timeShifted).
    return strip.timeShifted ? { ...c, congestionIsCurrent: false, congestionEstimate: null } : c;
  }, [selected, selection, visibleRecs, userPoint.lat, userPoint.lng, estimateById, strip.timeShifted]);
  // 비교 헤더의 기준 명소(G3-13) · 2·3위 '추천 이유'(G3-14).
  // ✨ 테마가 켜져 있으면 테마 기준 명소가 이름을 대신한다(웹 anchorContextFor — 거리는 두 좌표 사이).
  const compareAnchor = useMemo(() => (activeDiscovery
    ? discoveryCompareAnchor(activeDiscovery, selectedCandidate, facilities, { estimateById, timeShifted: strip.timeShifted })
    : compareAnchorFor(selectedCandidate, facilities, estimateById, new Date(), strip.timeShifted)),
  [activeDiscovery, selectedCandidate, facilities, estimateById, strip.timeShifted]);
  const comparisons = useMemo(() => spotComparisonsById(visibleRecs), [visibleRecs]);
  const comparison = comparisonFor(comparisons, selectedCandidate, visibleRecs);
  const comparisonReason = comparison ? formatSpotComparison(t, comparison) : undefined;
  // 카드 가치 상자의 ✨ 칩(G3-05 · 웹 :4800-4802)과 테마 판의 대안 3칸(웹 :4365-4402).
  const contextBadge = activeDiscovery
    ? t('compare.contextBadge', { label: t(`discovery.theme.${activeDiscovery.themeId}`) })
    : null;
  const discoveryItems = useMemo(() => (activeDiscovery ? discoveryResultItems(visibleRecs) : []), [activeDiscovery, visibleRecs]);
  const discoveryComparison = useCallback((id: string) => {
    const c = comparisons.get(id);
    return c ? formatSpotComparison(t, c) : undefined;
  }, [comparisons, t]);
  /** 테마 판의 대안 칸을 누르면 그 장소를 카드에(웹 setSelectedFacility + panToVisible — 순위 그대로, 이용 이벤트 없음). */
  const onPickDiscoveryResult = useCallback((id: string) => {
    const facility = byId.get(id);
    if (!facility) return;
    haptic('selection');
    setSelection({ id: facility.id, kind: 'recommended' });
    focusOn(facility.latitude, facility.longitude);
  }, [byId, focusOn]);
  const status = cardStatus({ hasFacilities, recsLoaded: recs !== null, recsFailed, hasSelection: selection !== null, searching });
  // 오류 판의 '다시 시도' — 오류를 걷고 스켈레톤부터 다시(그대로 두면 같은 판이 아무 표시 없이 남는다).
  const retryRecs = useCallback(() => {
    setRecsFailed(false);
    setRecs(null);
    setRecsNonce((n) => n + 1);
  }, []);

  // 가정 시각 라벨·배지·예측 혼잡(웹 page.tsx 4793-4799 · 4880-4890).
  const assumedTimeLabel = strip.hours > 0
    ? t('forecast.ahead', { h: strip.hours })
    : strip.presetId !== 'now' ? t(assumedPresetLabelKey(strip.presetId)) : null;
  const assumedTimeBadge = strip.hours > 0 ? t('forecast.basis', { h: strip.hours }) : null;
  const cardForecastLevel = strip.timeShifted && selected ? forecastLevelFor(strip.forecast, selected.id, rankById.has(selected.id)) : null;

  // 카드 조건 칩(G3-06) — 도보 칩은 그 조건이 지금 카드에 정말 걸려 있을 때만.
  const walkRelaxed = useMemo(
    // 테마 순위는 도보 제한을 클라이언트에서 넓히지 않는다(웹 clientWalkRelaxed — activeDiscovery 면 false).
    () => (!activeDiscovery && clientWalkRelaxed(facilities, category, travelContext, userPoint)) || walkRelaxedFor === `${category}|${rankBasis}`,
    [activeDiscovery, facilities, category, travelContext, userPoint, walkRelaxedFor, rankBasis],
  );
  const cardWalkMin = selectedCandidate
    ? displayWalkingMinutes(selectedCandidate.breakdown?.travelTime, selectedCandidate.distanceM)
    : null;
  const conditions: CardCondition[] = useMemo(() => cardConditionKeys(travelContext, { walkRelaxed, cardWalkMin }).map((key) => {
    const vars = key === 'walk' ? { n: travelContext.maxWalkMinutes ?? 0 } : undefined;
    return { key, label: t(`condition.${key}`, vars), name: t(`condition.${key}Name`, vars) };
  }), [travelContext, walkRelaxed, cardWalkMin, t]);

  // 다른 칩 제안 상자(G2-30 · G3-27) — 이 칩 추천이 정말 0곳일 때만(빈 지도를 눌러 카드만 닫은 때는 아니다). 수는 카드에 오를 수 있는 곳.
  const noRecommendation = recs !== null && !recsFailed && (visibleRecs.length === 0 || exhausted !== null);
  const pinAttributes = useMemo(() => pinAttributesOf(travelContext.requiredAttributes), [travelContext.requiredAttributes]);
  const suggestion: SuggestionModel | null = useMemo(() => {
    if (parkingTab || selected || loading || error || !hasFacilities || !noRecommendation || recalc || status === 'loading') return null;
    return suggestionModel({
      category,
      candidateCounts: candidateCountsByType(facilities, travelContext, userPoint),
      attributePins: countPinsByType(facilities, pinAttributes),
      pinAttributes,
      strollerOn,
      closedToday: exhausted?.closedToday ?? false,
    });
  }, [parkingTab, selected, loading, error, hasFacilities, noRecommendation, recalc, status, category, facilities, travelContext, userPoint,
    pinAttributes, strollerOn, exhausted]);

  const accessibleAnywhere = useMemo(() => facilities.some((f) => isAccessible(f)), [facilities]);
  const strollerAnywhere = useMemo(() => facilities.some((f) => isStrollerFriendly(f)), [facilities]);
  const askedExternal = shouldAskExternal(query, matchCount);
  const ext = askedExternal ? external : NO_EXTERNAL;
  const showSearchResults = searching && panelOpen;
  const searchNothing = matchCount === 0 && !ext.placesLoading && ext.places.length === 0 && !ext.tourLoading && ext.tour.length === 0;
  // 🅿 주차 가능 필터를 켰는데 이 칩에 0곳(웹 :4407-4414 — 검색 없음 알약이 먼저).
  const parkingFilterEmpty = parkingFilter && !parkingTab && !(searching && searchNothing)
    && filtered.filter((f) => f.type === category).length === 0;

  // 검색 중에는 날씨 줄을 감춘다 — 열린 팝오버도 닫는다.
  useEffect(() => {
    if (searching) setWeatherAnchor(null);
  }, [searching]);

  // 예측 띠(G2-24) — 아래 스택 첫 칸, 카드가 펼쳐지면 숨는다. 다시 그려질 때 들어오는 효과가 다시 돌게 조건부로 붙인다.
  const showStrip = shouldShowForecastStrip({
    parkingTab, loadingFacilities: loading, facilitiesError: !!error, facilityCount: facilities.length, cardExpanded,
  });
  const stripBadge = useMemo(
    () => stripBadgeFor(strip.forecast, { typeIds: facilities.filter((f) => f.type === category).map((f) => f.id), busyAt, t }),
    [strip.forecast, facilities, category, busyAt, t],
  );
  const stripLegend = useMemo(() => stripLegendFor(strip.forecast, { gradedPinCount, t }), [strip.forecast, gradedPinCount, t]);
  const stripPresets = useMemo(() => STRIP_PRESETS.map((p) => ({ id: p.id, label: t(p.labelKey) })), [t]);

  const userDotShown = showsUserDot(loc);
  // 넓은 화면(폴더블 펼침)에서 위 칩 줄 · 아래 스택을 같은 폭의 가운데 열로 — 지도가 양옆에 남는다.
  const overlayWidth = { width: '100%' as const, maxWidth: HOME_PANEL_MAX_WIDTH, alignSelf: 'center' as const };
  const sideStyle = { paddingLeft: insets.left + SIDE, paddingRight: insets.right + SIDE };
  const journeyTop = insets.top + JOURNEY_TOP_OFFSET;
  const searchFont = fontStyleFor('regular', locale, Platform.OS === 'web' ? 'web' : 'native');
  const short = windowHeight < SHORT_SCREEN_MAX;
  const mapPadding = useMemo(() => ({ bottom: mapPaddingBottom }), [mapPaddingBottom]);
  // 웹은 지도가 탭 막대 뒤까지 이어져 가운데 카드가 '화면' 가운데에 선다 — 앱 지도는 막대 위에서 끝나니 막대 높이만큼 위를 띄워 같은 자리로.
  const centerOnScreen = { paddingTop: nav.barHeight };
  const toolsActive = accessibleOn || strollerOn || parkingFilter || cuisineId !== null;

  const weatherPill = !searching && weather ? (
    <WeatherPill
      data={weather}
      expanded={weatherAnchor !== null}
      onToggle={(anchor) => setWeatherAnchor((open) => (open ? null : anchor))}
    />
  ) : null;
  // ✨ 알약(웹 :4113) — 장소를 다 불러온 뒤, 테마가 꺼져 있을 때만. 검색 중에는 날씨 줄과 함께 감춘다.
  const discoveryChip = !searching && hasFacilities && !loading && !activeDiscovery ? (
    <DiscoveryChip open={discoveryOpen} compact={short} onToggle={() => setDiscoveryOpen((open) => !open)} />
  ) : null;
  const showThemePanel = hasFacilities && !loading && discoveryOpen && !activeDiscovery && !searching;

  return (
    <View ref={rootRef} className="flex-1 bg-hanji" onLayout={(e) => setContainerH(Math.round(e.nativeEvent.layout.height))}>
      <GlassBlurProvider>
        {/* 지도 — 유리(검색·칩·상단 묶음)가 흐릴 대상(D14 · G2-G03 — 안드로이드 흐림은 Fold7 시험 전까지 꺼져 있다). */}
        <MapLayer style={StyleSheet.absoluteFill}>
          <NextSpotMap
            ref={mapRef}
            style={{ flex: 1 }}
            markers={markers}
            circles={festival?.circles}
            userLocation={userDotShown ? { latitude: userPoint.lat, longitude: userPoint.lng, variant: 'halo' } : null}
            onMarkerPress={onMarkerPress}
            onGroupPress={onGroupPress}
            onMapPress={onMapPress}
            onRegionChangeComplete={onRegionChangeComplete}
            onMapReady={() => { setMapReady(true); setMapUnavailable(false); }}
            onUnavailable={() => setMapUnavailable(true)}
            unavailableTimeoutMs={MAP_UNAVAILABLE_TIMEOUT_MS}
            mapPadding={mapPadding}
            popover={popover}
            onPopoverPick={onPopoverPick}
          />
        </MapLayer>

        {/* 상단 묶음 — 언어 · 출처(왼쪽 열) · KST 시계(오른쪽), G2-10. */}
        <HomeTopCluster />

        {/* 위 — (지도 실패 칩) · 검색 · 날씨 줄 · 검색 결과 · 칩 줄. 빈 곳을 누르면 지도가 받는다. */}
        <View
          pointerEvents="box-none"
          className="absolute inset-x-0 top-0"
          style={[{ paddingTop: insets.top + HEADER_TOP }, sideStyle]}
          onLayout={(e) => {
            const h = Math.round(e.nativeEvent.layout.height);
            const changed = Math.abs(h - headerRef.current) > 2;
            headerRef.current = h;
            setHeaderH(h);
            // 머리 높이가 바뀌면(검색 결과 판이 닫혀 짧아짐 · ✨ 테마 판이 '비교 중' 줄에서 대안 칸으로 자라남) 방금 옮긴 핀을
            // 새 띠로 다시 맞춘다 — 자랄 때 안 맞추면 1위 핀이 테마 판 밑에 깔린다(F2 검토 M1).
            if (changed) refocusIfRecent();
          }}
        >
          <View pointerEvents="box-none" style={overlayWidth} className="gap-[8px]">
            {/* 지도 SDK 실패 안내(G2-08 — 웹 :4017-4023). 추천 카드는 지도 없이도 동작한다. */}
            {mapUnavailable ? (
              <View pointerEvents="none" className="items-center">
                <View className="rounded-full border border-line bg-white px-[12px] py-[4px]" style={{ boxShadow: SOFT_SHADOW }}>
                  <Text className="text-xs">{t('map.loadFailed')}</Text>
                </View>
              </View>
            ) : null}

            {/* 검색창(G2-11) — 유리 · 높이 58 · 좌우 16 · 돋보기 20 + 12 · 마스코트 36. 키 낮은 폰은 낮추고 마스코트를 숨기며 날씨를 옆에. */}
            <View pointerEvents="box-none" className={short ? 'flex-row items-center gap-[8px]' : undefined}>
              {/* 키 낮은 폰은 웹 short:max-md:py-2(38) — 보이는 높이는 38, 누르는 영역은 위아래 3씩 넓혀 44(누름 축소 효과 없는 RN Pressable). */}
              <RNPressable
                accessible={false}
                hitSlop={short ? { top: 3, bottom: 3 } : undefined}
                onPress={() => searchInputRef.current?.focus()}
                style={short ? { flex: 1 } : undefined}
              >
              <Glass className={`flex-row items-center ${short ? 'min-h-[38px] px-[12px]' : 'min-h-[58px] px-[16px]'}`}>
                <Icon icon={Search} size={20} color="muk-soft" />
                <TextInput
                  ref={searchInputRef}
                  value={query}
                  onChangeText={(v) => { setQuery(v); setPanelOpen(true); }}
                  onSubmitEditing={onSubmitSearch}
                  placeholder={t('map.searchPlaceholder')}
                  placeholderTextColor={colors['glass-muk-soft']}
                  accessibilityLabel={t('map.searchPlaceholder')}
                  returnKeyType="search"
                  autoCorrect={false}
                  className={`ml-[12px] flex-1 text-[14px] text-muk ${short ? 'min-h-[36px]' : 'min-h-[44px]'}`}
                  style={[searchFont, { paddingVertical: 0, paddingHorizontal: 0 }]}
                />
                {query ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('map.searchClear')}
                    hitSlop={13}
                    onPress={() => setQuery('')}
                    className="ml-[12px] rounded-full"
                  >
                    <Icon icon={X} size={18} color="muk-soft" />
                  </Pressable>
                ) : null}
                {short ? null : <NextSpotMascot size={36} style={{ marginLeft: 12 }} />}
              </Glass>
              </RNPressable>
              {short ? weatherPill : null}
              {short ? discoveryChip : null}
            </View>

            {/* 날씨 · ✨ 한 줄(웹 :4092-4127) — 가로 스크롤이 아니다. 검색 중에는 감춘다. */}
            {!short && (weatherPill || discoveryChip) ? (
              <View pointerEvents="box-none" className="flex-row items-center gap-[8px]">
                {weatherPill}
                {discoveryChip}
              </View>
            ) : null}

            {/* 검색 결과 — 검색창 바로 아래(웹 :4131-4300). 우리 장소 일치가 있으면 목록 없이 지도(핀 + 이름표)가 보인다. */}
            {showSearchResults ? (
              <>
                {searchNothing ? (
                  <SearchNoResultPill
                    message={ext.tourAsked ? t('map.searchNoResultAnywhere', { q: query.trim() }) : t('map.searchNoResult', { q: query.trim() })}
                  />
                ) : null}
                <PlaceSearchResults
                  items={ext.places}
                  loading={ext.placesLoading}
                  onView={(item) => viewPlace(item, 'place')}
                  onOpenKakao={(item) => { if (item.placeUrl) void openExternalUrl(item.placeUrl); }}
                  onSeeInstead={(item) => {
                    const known = facilities.find((f) => String(f.features?.kakaoPlaceId ?? f.features?.kakao_place_id ?? '') === String(item.placeId));
                    const type = known?.type ?? item.type;
                    if (!type) return;
                    goInstead(known
                      ? { facilityId: known.id, type: known.type, latitude: known.latitude, longitude: known.longitude }
                      : { name: item.name, type, latitude: item.latitude, longitude: item.longitude });
                  }}
                />
                <TourSearchResults
                  items={ext.tour}
                  loading={ext.tourLoading}
                  requested={ingest.requested}
                  pendingId={ingest.pendingId}
                  onView={(item) => viewPlace(item, 'tour')}
                  onRoute={(item) => {
                    if (typeof item.mapy !== 'number' || typeof item.mapx !== 'number') return;
                    void openWalkingDirections(
                      { name: item.title, latitude: item.mapy, longitude: item.mapx },
                      loc.known ? { latitude: userPoint.lat, longitude: userPoint.lng } : null,
                    );
                  }}
                  onRequestIngest={(item) => void ingest.request(item)}
                />
              </>
            ) : null}

            {/* ✨ 테마 고르기 판 · 켜진 테마 판(웹 :4307-4405) — 검색 결과 아래, 분류 칩 줄 위. 위 묶음 높이에 들어가 카메라 띠도 따라 내려간다. */}
            {showThemePanel ? <DiscoveryThemePanel onPick={onPickTheme} onClose={() => setDiscoveryOpen(false)} /> : null}
            {activeDiscovery ? (
              <DiscoveryActivePanel
                active={activeDiscovery}
                loading={discoveryLoading}
                items={discoveryItems}
                selectedId={selection?.id ?? null}
                comparisonText={discoveryComparison}
                onSelect={onPickDiscoveryResult}
                onClear={clearTheme}
              />
            ) : null}

            {parkingFilterEmpty ? <SearchNoResultPill message={`🅿 ${t('map.searchNoResult', { q: t('map.filterParking') })}`} /> : null}

            {/* 분류 칩 줄(G2-25) — '필터·편의'(주차장 탭에서는 숨김) + 아이콘 칩 5개. 비활성은 유리, 활성은 먹. 검색 중에도 남는다(G2-19). */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8, alignItems: 'center' }}>
              {!parkingTab ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('map.mobileTools')}
                  accessibilityState={{ selected: toolsActive }}
                  hitSlop={CHIP_HIT_SLOP}
                  onPress={() => setFilterOpen(true)}
                  className="shrink-0 rounded-full"
                >
                  <Glass className="h-[36px] flex-row items-center gap-[6px] px-[12px]">
                    <Icon icon={SlidersHorizontal} size={14} color="muk" />
                    <Text className="text-[13px]" weight="bold" numberOfLines={1}>{t('map.mobileTools')}</Text>
                  </Glass>
                </Pressable>
              ) : null}
              {TAB_CHIPS.map(({ tab, icon }) => {
                const on = tab === 'parking' ? parkingTab : !parkingTab && tab === category;
                const label = t(`category.${tab}`);
                return (
                  <Pressable
                    key={tab}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityState={{ selected: on }}
                    hitSlop={CHIP_HIT_SLOP}
                    onPress={() => { if (!on) onTabChip(tab); }}
                    className="shrink-0 rounded-full"
                  >
                    {on ? (
                      <View className="h-[36px] flex-row items-center gap-[6px] rounded-full border border-muk bg-muk px-[14px]" style={{ boxShadow: CHIP_SHADOW }}>
                        <Icon icon={icon} size={15} color="hanji" />
                        <Text className="text-[13px] text-hanji" weight="semibold" numberOfLines={1}>{label}</Text>
                      </View>
                    ) : (
                      <Glass className="h-[36px] flex-row items-center gap-[6px] px-[14px]">
                        <Icon icon={icon} size={15} color="gold-deep" />
                        <Text className="text-[13px]" weight="semibold" numberOfLines={1}>{label}</Text>
                      </Glass>
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>

        {/* 가운데 — 불러오는 중 · 실패 · 빈 상태(웹 :4596-4631, 주차장 탭에서는 없음) */}
        {!parkingTab && loading && !hasFacilities ? (
          <View pointerEvents="none" className="absolute inset-0 items-center justify-center gap-[12px]" style={centerOnScreen}>
            <NextSpotMascot variant="full" size={80} shadow={MASCOT_SHADOW} />
            <RingSpinner size={40} borderWidth={2} trackColor={colors.line} headColor="gold" />
            <Text className="text-[14px]" weight="medium">{t('map.loadingRec')}</Text>
          </View>
        ) : null}
        {!parkingTab && !loading && error ? (
          <View pointerEvents="box-none" className="absolute inset-0 items-center justify-center px-[24px]" style={centerOnScreen}>
            <Card padded={false} className="max-w-[320px] items-center gap-[12px] px-[24px] py-[20px]" style={{ boxShadow: SOFT_SHADOW }}>
              <Text className="text-[24px]" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">⚠️</Text>
              <Text className="text-center text-[14px]" weight="semibold" accessibilityRole="header">{t('map.loadErrorTitle')}</Text>
              <Text className="text-center text-[12px] leading-[19.5px] text-muk-soft">{t('map.loadErrorBody')}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={reload}
                hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                className="mt-[4px] rounded-full bg-gold px-[16px] py-[8px]"
              >
                <Text className="text-[14px] text-white" weight="bold">{t('common.retry')}</Text>
              </Pressable>
            </Card>
          </View>
        ) : null}
        {!parkingTab && !loading && !error && !hasFacilities ? (
          <View pointerEvents="none" className="absolute inset-0 items-center justify-center px-[24px]" style={centerOnScreen}>
            <Card padded={false} className="max-w-[320px] items-center gap-[8px] px-[24px] py-[20px]" style={{ boxShadow: SOFT_SHADOW }}>
              <NextSpotMascot variant="full" size={64} />
              <Text className="text-center text-[14px]" weight="semibold">{t('map.emptyTitle')}</Text>
              <Text className="text-center text-[12px] leading-[19.5px] text-muk-soft">{t('map.emptyBody')}</Text>
            </Card>
          </View>
        ) : null}

        {/* 아래 스택 — 웹 `absolute inset-x-4 bottom-[clearance] flex-col gap-2`(탭 막대 위 NAV_GAP). 주차장 탭에서는 비고 주차장 판이 대신한다.
            순서: 예측 띠(웹 order-first) → 스켈레톤 · 추천 카드 · 오류 판(RecommendationCard 하나가 상태로 고른다) / 다시 계산 스켈레톤 → 제안 상자. */}
        <View
          pointerEvents="box-none"
          className="absolute inset-x-0 bottom-0"
          style={[{ paddingBottom: nav.gap }, sideStyle]}
          onLayout={(e) => onStackLayout(e.nativeEvent.layout.height)}
        >
          {parkingTab ? null : (
            <View pointerEvents="box-none" style={overlayWidth} className="gap-[8px]">
              {showStrip ? (
                <ForecastStrip
                  hours={strip.hours}
                  loading={strip.loading}
                  presetId={strip.presetId}
                  presets={stripPresets}
                  onSelectHours={strip.selectHours}
                  onSelectPreset={strip.selectPreset}
                  badge={stripBadge}
                  legend={stripLegend}
                />
              ) : null}
              {recalc ? (
                <CardSkeleton label={t('assume.recalculating', { label: recalc })} />
              ) : (
                <RecommendationCard
                  selected={selectedCandidate}
                  candidates={visibleRecs}
                  excludedIds={excluded}
                  status={status}
                  onRetry={retryRecs}
                  compactPeek
                  showCompare
                  showListRank
                  travelContext={travelContext}
                  onAccept={keepAfterAccept}
                  onDrive={keepAfterAccept}
                  onPutOff={onPutOff}
                  onReject={onReject}
                  onSeeInstead={selected && canSeeInstead(selected.type) ? showAlternatives : undefined}
                  conditions={conditions}
                  onRemoveCondition={onRemoveCondition}
                  comparisonReason={comparisonReason}
                  compareAnchor={compareAnchor}
                  contextBadge={contextBadge}
                  assumedTimeLabel={assumedTimeLabel}
                  assumedTimeBadge={assumedTimeBadge}
                  forecastLevel={cardForecastLevel}
                  onPeekChange={setCardPeek}
                  onToast={showToast}
                  onViewProfile={openMypageHome}
                  onViewLab={() => pushMypageSub('lab')}
                />
              )}
              {suggestion ? (
                <SuggestionBox
                  model={suggestion}
                  title={t(accessibleOn ? 'map.barrierFreeElsewhere' : strollerOn ? 'map.strollerElsewhere' : 'map.suggestTitle')}
                  pinsTitle={t(accessibleOn ? 'map.barrierFreeOnMap' : 'map.strollerOnMap', { n: suggestion.pinsHere })}
                  pinChipsTitle={t(accessibleOn ? 'map.barrierFreeElsewhere' : 'map.strollerElsewhere')}
                  closedBody={t('map.noRecClosedBody')}
                  strollerNoneTitle={t(accessibleOn && strollerAnywhere ? 'map.strollerAndWheelchairNone' : 'map.strollerNone')}
                  chipLabel={(type, n) => t('map.suggestButton', { category: t(`category.${type}`), n })}
                  viewLabel={t('map.placeSearchView')}
                  strollerOffLabel={t('map.strollerOff')}
                  onPick={(type) => onTabChip(type)}
                  onShowPinsHere={() => fitAttributePins(category, pinAttributes)}
                  onPickPinChip={(type) => { switchTab(type); fitAttributePins(type, pinAttributes); }}
                  onStrollerOff={() => onAttributeChip('stroller')}
                />
              ) : null}
            </View>
          )}
        </View>

        {/* 주차장 탭의 아래 판(G2-25 · H2b) — 스스로 탭 막대 위 NAV_GAP 에 선다. 높이는 지도 패딩·카메라 띠로. */}
        {parkingTab ? (
          <ParkingPanel
            lots={parking.lots}
            loading={parking.loading}
            error={parking.error}
            selected={parking.selected}
            onClose={() => parking.select(null)}
            onRetry={parking.reload}
            onHeightChange={onParkingHeight}
          />
        ) : null}

        {/* 진행 중 여행 — 웹 `absolute z-30 top-24 inset-x-4`: 검색창 아래 절반에 겹치고 추천 카드보다 위 층(G3-28). */}
        <View pointerEvents="box-none" className="absolute inset-x-0" style={[{ top: journeyTop }, sideStyle]}>
          <ActiveJourneyCard
            location={userPoint}
            style={overlayWidth}
            maxHeight={journeyCardMaxHeight(containerH, journeyTop, keyboardCover)}
          />
        </View>

        {/* 홈 알약 토스트 — 화면 아래 350px(F10). */}
        <HomeToast toast={home.current} />

        {/* 방문 확인 — 웹 `fixed z-[55] bottom-[clearance + 8] max-w-sm px-4`: 탭 막대 위 NAV_GAP + 8, 가운데, 추천 카드 위에 겹친다(G3-31). */}
        <View
          pointerEvents="box-none"
          className="absolute inset-x-0 items-center"
          style={[{ bottom: nav.gap + 8 }, { paddingLeft: insets.left, paddingRight: insets.right }]}
        >
          <VisitCheckCard
            style={{ width: '100%', maxWidth: VISIT_MAX_WIDTH, paddingHorizontal: SIDE }}
            onOpenCoupons={() => pushMypageSub('coupons')}
            onToast={showToast}
          />
        </View>

        {/* 날씨 팝오버 — 칩 줄 안이 아니라 화면 루트(잘림·터치 막힘 회피, G2-16). */}
        {weather && weatherAnchor && !searching ? (
          <WeatherPopover
            data={weather}
            anchor={weatherAnchor}
            indoorRequired={indoorOn}
            onIndoorRequiredChange={toggleIndoor}
            onClose={() => setWeatherAnchor(null)}
          />
        ) : null}

        <ToolsSheet
          open={filterOpen}
          onClose={() => setFilterOpen(false)}
          convenience={convenience}
          onToggle={toggleTool}
          showAccessible={accessibleAnywhere}
          showStroller={strollerAnywhere}
          showCuisine={category === 'restaurant'}
          cuisineId={cuisineId}
          cuisineSetupId={stored.cuisine ? SETUP_CUISINE_CHIP[stored.cuisine] ?? null : null}
          onSelectCuisine={selectCuisine}
          location={userPoint}
          onFocusFestival={onFestivalFocus}
        />
        {/* 시스템 권한 창 앞 안내 — 네이티브만(웹 빌드는 웹처럼 브라우저 창을 바로 묻는다). */}
        {loc.status === 'needs-primer' && Platform.OS !== 'web' ? <LocationPrimer onContinue={loc.continueFromPrimer} /> : null}
      </GlassBlurProvider>
    </View>
  );
}

/**
 * 지도 층 — 안드로이드 유리 흐림(D14 ①)이 켜졌을 때만 흐릴 대상(BlurTargetView)으로 감싼다. 꺼져 있으면(Fold7 시험 전, 기본)
 * 보통 View — 흐리지도 않는 대상 뷰를 지도 밑에 두지 않는다. iOS·웹 빌드는 대상 없이 흐린다.
 */
function MapLayer({ style, children }: { style: StyleProp<ViewStyle>; children: ReactNode }) {
  if (Platform.OS === 'android' && ANDROID_GLASS_BLUR) return <GlassBlurTarget style={style}>{children}</GlassBlurTarget>;
  return <View style={style}>{children}</View>;
}

/** 웹 제안 버튼 — `border-gold/50 bg-gold/10 px-3.5 py-2 text-xs font-bold text-muk`, 탭 영역은 hitSlop 으로 44. */
function SuggestButton({ label, onPress, tall }: { label: string; onPress: () => void; tall?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={tall ? undefined : { top: 6, bottom: 6 }}
      className={`justify-center rounded-full border border-gold/50 bg-gold/10 ${tall ? 'min-h-[44px] px-[16px]' : 'px-[14px] py-[8px]'}`}
    >
      <Text className="text-[12px]" weight="bold">{label}</Text>
    </Pressable>
  );
}

/**
 * 다른 칩 제안 상자(G2-30 · G3-27) — 웹 category-suggestion(page.tsx 4916-4994): 흰 판 · 마스코트 48 · 14 semibold 제목 · 금 알약 칩.
 * 갈래: 고를 다른 칩 / '전부 오늘 휴무' 한 줄 / ♿·👶 조건 핀('지도에 N곳' + 지도에서 보기 · 다른 칩의 조건 핀) / '유모차 조건 끄기'.
 */
function SuggestionBox(props: {
  model: SuggestionModel;
  title: string;
  pinsTitle: string;
  pinChipsTitle: string;
  closedBody: string;
  strollerNoneTitle: string;
  chipLabel: (type: PlaceCategory, n: number) => string;
  viewLabel: string;
  strollerOffLabel: string;
  onPick: (type: PlaceCategory) => void;
  onShowPinsHere: () => void;
  onPickPinChip: (type: PlaceCategory) => void;
  onStrollerOff: () => void;
}) {
  const { model } = props;
  return (
    <View
      accessibilityLiveRegion="polite"
      className="items-center gap-[8px] rounded-2xl border border-line bg-white px-[20px] py-[16px]"
      style={{ boxShadow: SOFT_SHADOW }}
    >
      <NextSpotMascot size={48} />
      {model.chips.length > 0 ? <Text className="text-center text-[14px]" weight="semibold">{props.title}</Text> : null}
      {model.closedToday ? <Text className="text-center text-[12px] leading-[19.5px] text-muk-soft">{props.closedBody}</Text> : null}
      {model.chips.length > 0 ? (
        <View className="mt-[4px] flex-row flex-wrap justify-center gap-[8px]">
          {model.chips.map((s) => <SuggestButton key={s.type} label={props.chipLabel(s.type, s.count)} onPress={() => props.onPick(s.type)} />)}
        </View>
      ) : null}
      {model.pinsHere > 0 ? (
        <>
          <Text className="text-center text-[14px]" weight="semibold">{props.pinsTitle}</Text>
          <View className="mt-[4px]"><SuggestButton label={props.viewLabel} onPress={props.onShowPinsHere} /></View>
        </>
      ) : null}
      {model.pinChips.length > 0 ? (
        <>
          <Text className="text-center text-[14px]" weight="semibold">{props.pinChipsTitle}</Text>
          <View className="mt-[4px] flex-row flex-wrap justify-center gap-[8px]">
            {model.pinChips.map((s) => <SuggestButton key={s.type} label={props.chipLabel(s.type, s.count)} onPress={() => props.onPickPinChip(s.type)} />)}
          </View>
        </>
      ) : null}
      {model.strollerNone ? (
        <>
          <Text className="text-center text-[14px]" weight="semibold">{props.strollerNoneTitle}</Text>
          <View className="mt-[4px]"><SuggestButton tall label={props.strollerOffLabel} onPress={props.onStrollerOff} /></View>
        </>
      ) : null}
    </View>
  );
}
