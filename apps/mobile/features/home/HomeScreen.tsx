// 홈(지도) 화면 — 웹 /main(apps/web/app/main/page.tsx, 기준 커밋 0d145a1)의 앱판.
//
// 뺀 것(계획 §3.1): 음성 비서 · 히트맵 · 데모 조작 패널 · 지역 전환(내부 계정).
//   진행 중(다른 묶음): 혼잡 예측 띠·주차장 탭(H2b → H3b 가 아래 스택 첫 칸에 연결) · ✨ 경주 테마(F2 — 날씨 줄 옆 자리).
// 화면 층(웹 page.tsx 와 같은 순서): 지도 → 상단 묶음(언어·출처·시계) → 검색·날씨·칩 → 아래 스택(예측 띠 자리 · 추천 카드) →
//   진행 중 여행 카드(위, 검색창 아래 절반에 겹침) → 홈 알약 토스트 → 방문 확인 카드(아래) → 날씨 팝오버 → 시트들.
// 추천 카드(features/recommendation-card/RecommendationCard)는 지도 위에 뜬 카드(미리보기 / 전체 / 상세, 내용 높이 — G3-01)다.
//   rec_* 이용 이벤트는 카드가 직접 보낸다. 카드에 넘길 값은 sheetModel.ts 의 순수 함수가 만든다.
// 흐름: 시설 로드(/infrastructures) → 칩의 종류로 서버 추천(by-type) → 1위를 카드 자리에 연다 → 핀·검색으로 직접 고르면
//   그 장소가 '선택한 장소'. 추천이 실패하면 같은 자리에 오류 판(G3-26 — 화면 안 SPOT 미러로 점수를 지어내지 않는다),
//   0곳이면 다른 칩 제안 상자(G3-27). 핀 겹침은 지도가 알려 준 영역으로 declutterPins, 핀 순서는 SPOT 점수(pinOrder).
// 첫 설정(nextspot_setup_prefs)이 첫 칩·조건 칩을 정하고, 도보·여행 시간·음식 취향·방문 제외를 추천 요청에 싣는다
//   (homeContext.ts — 웹 rankContext). 도보 제한으로 0곳이면 한 번 넓혀 다시 묻는다. 서버에는 이번 세션 거절 + 저장한 곳을 빼 달라고 보낸다.
// 짧은 안내는 웹 /main 처럼 홈 알약 토스트(HomeToast — 한 칸 · 3초, G3-33 · G2-G09)로, 취향·실험실 안내만 앱 토스트(sonner)로.
import { useFocusEffect, useRouter } from 'expo-router';
import { LocateFixed, Search, SlidersHorizontal, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Dimensions, Keyboard, Platform, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { facilityMatchesSearch } from '@/lib/placeSearch';
import { getArrivalOpenStatus } from '@/lib/restDate';
import { NextSpotMascot } from '~/components/NextSpotMascot';
import { useNavInsets } from '~/components/navigation/navMetrics';
import { pushMypageSub, useOpenMypageHome } from '~/components/navigation/useOpenMypage';
import { EmptyState, ErrorState, Icon, IconButton, Pressable, Text } from '~/components/ui';
import { fontStyleFor } from '~/components/ui/textStyle';
import {
  declutterPins,
  NextSpotMap,
  type LatLng,
  type MapViewport,
  type NextSpotMapHandle,
  type NextSpotMarker,
  type PinCluster,
  type PinMarker,
} from '~/features/map';
import {
  ActiveJourneyCard,
  RecommendationCard,
  VisitCheckCard,
  type SheetCandidate,
} from '~/features/recommendation-card';
import { formatSpotComparison } from '~/features/explore/port/spotComparison';
import { loadTravelContext } from '~/features/course/travelContext';
import { recommendByType, type RecommendationResponse } from '~/lib/core/apiClient';
import { loadSavedLocal, syncSaved } from '~/lib/core/savedFacilities';
import type { TravelContext } from '~/lib/core/travelContextTypes';
import { useBusyThreshold } from '~/lib/core/publicSettings';
import { isStrollerFriendly } from '~/lib/core/strollerSupport';
import { useI18n } from '~/lib/i18n/I18nProvider';
import { haptic } from '~/lib/platform/haptics';
import { openExternalUrl, openWalkingDirections } from '~/lib/platform/links';
import { track } from '~/lib/platform/analytics';
import { colors } from '~/lib/theme/tokens';

import { GroupSheet, LocationBanner, LocationPrimer, PlaceSearchResults, SearchNoResultPill, ToolsSheet, TourSearchResults } from './HomeOverlays';
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
  hasAnyConvenience,
  isAccessible,
  matchesCuisineChip,
  NO_CONVENIENCE,
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
import { myLocationAction, showsMyLocationButton, showsUserDot } from './locationPolicy';
import {
  buildExcludeIds,
  cuisineIntentOf,
  homeFilterSeed,
  homeRequestContext,
  parseRejectedIds,
  REJECTED_IDS_KEY,
  relaxWalkLimit,
  serializeRejectedIds,
} from './homeContext';
import { HomeToast, useHomeToast } from './HomeToast';
import { HomeTopCluster } from './HomeTopCluster';
import { orderPinsBySpot } from './pinOrder';
import { CHIP_HIT_SLOP, useWeather, WeatherPill, WeatherPopover, type FestivalEvent, type PillAnchor } from './ToolChips';
import { useFacilities } from './useFacilities';
import { useIngestRequest, usePlaceSearch, type PlaceSearchItem, type TourApiSearchItem } from './usePlaceSearch';
import { usePreferredCategories } from './usePreferredCategories';
import { useUserLocation } from './useUserLocation';

const OUT_OF_REGION_NOTICE_KEY = 'nextspot_out_of_region_notice';
const RECOMMENDATION_TIMEOUT_MS = 20_000;
/** 웹 상단 묶음(언어·출처·시계) 아래에서 검색 줄이 시작하는 자리 — top-[safe + 4.25rem](G2-10 5번). */
const HEADER_TOP = 68;
/** 웹 inset-x-4 · px-4 — 검색 줄·아래 스택·여정 카드의 좌우. */
const SIDE = 16;
/** 웹 방문 확인 카드 max-w-sm. */
const VISIT_MAX_WIDTH = 384;
/** 제안 상자 — 웹 shadow-[0_2px_14px_rgba(43,35,32,0.06)]. */
const SUGGESTION_SHADOW = '0px 2px 14px rgba(43, 35, 32, 0.06)';
/** 웹 첫 설정 음식 취향 → 필터 시트에서 금 링으로 알려 줄 음식 칩(page.tsx SETUP_CUISINE_CHIP). */
const SETUP_CUISINE_CHIP: Partial<Record<string, string>> = { '한식': 'korean', '분식·국밥': 'bunsik', '양식': 'western' };
const NO_EXTERNAL = { places: [], placesLoading: false, tour: [], tourLoading: false, tourAsked: false } as const;

type Selection = { id: string; kind: PickKind };

function sessionStore(): Storage | null {
  return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
}

function loadRejectedIds(): Set<string> {
  try {
    return parseRejectedIds(sessionStore()?.getItem(REJECTED_IDS_KEY));
  } catch {
    return new Set();
  }
}

function savedIdSet(): Set<string> {
  return new Set(loadSavedLocal().map((b) => b.id));
}
type PlacePin = { id: string; name: string; latitude: number; longitude: number };

export function HomeScreen() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const openMypageHome = useOpenMypageHome();
  const insets = useSafeAreaInsets();
  const nav = useNavInsets();
  const busyAt = useBusyThreshold();
  const mapRef = useRef<NextSpotMapHandle>(null);
  const home = useHomeToast();
  const showToast = home.show;

  const { facilities, loading, error, reload, estimateById } = useFacilities();
  const loc = useUserLocation();
  const userPoint = loc.location;
  const preferredCategories = usePreferredCategories();
  const weather = useWeather();

  // 첫 설정 조건 — 처음 들어올 때 읽고, 탭에 돌아올 때 바뀌었으면(설정 다시 하기) 칩을 다시 맞춘다.
  const [stored, setStored] = useState<TravelContext>(loadTravelContext);
  const seed = useMemo(() => homeFilterSeed(stored), [stored]);
  const [category, setCategory] = useState<PlaceCategory>(seed.category);
  const [query, setQuery] = useState('');
  const [panelOpen, setPanelOpen] = useState(true);
  const [convenience, setConvenience] = useState<Convenience>(() => ({ ...NO_CONVENIENCE, accessible: seed.accessible, stroller: seed.stroller }));
  const [indoor, setIndoor] = useState(seed.indoor);
  const [cuisineId, setCuisineId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [recs, setRecs] = useState<RecommendationResponse[] | null>(null);
  // 추천 요청이 실패했다(G3-26 — 카드 자리에 오류 판). 다시 시도는 recsNonce 로 같은 조건을 다시 묻는다.
  const [recsFailed, setRecsFailed] = useState(false);
  const [recsNonce, setRecsNonce] = useState(0);
  // 이번 세션에 거절한 곳(세션 저장소 — 웹과 같은 키)과 저장(킵)한 곳. 둘 다 목록·핀 순위에서 빼고 서버에도 빼 달라고 보낸다.
  const [rejectedIds, setRejectedIds] = useState<ReadonlySet<string>>(loadRejectedIds);
  const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(savedIdSet);
  const excluded = useMemo<ReadonlySet<string>>(() => new Set(buildExcludeIds(rejectedIds, savedIds)), [rejectedIds, savedIds]);
  const [activeGroup, setActiveGroup] = useState<PinCluster<HomeFacility> | null>(null);
  const [festival, setFestival] = useState<FestivalFocus | null>(null);
  const [placePin, setPlacePin] = useState<PlacePin | null>(null);
  const [viewport, setViewport] = useState<MapViewport | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [weatherAnchor, setWeatherAnchor] = useState<PillAnchor | null>(null);
  const [headerH, setHeaderH] = useState(insets.top + HEADER_TOP + 100);
  const [containerH, setContainerH] = useState(0);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  // 아래 스택(예측 띠 자리 · 추천 카드 · 제안 상자)의 높이 — 카메라가 핀을 그 위에 놓는다(웹 '스택 높이 + 8', R2 G3-01 6번).
  // 콜백을 매번 새로 만들지 않게 ref 로 읽는다(H3b 가 mapPadding 과 G2-01 의 스택 위끝으로 다듬는다).
  const bottomStackRef = useRef(0);
  // 카드가 미리보기인가(웹 cardPeek) — 혼잡 예측 띠는 미리보기일 때만 보인다(G2-24). H3b 가 ForecastStrip(H2b)을 아래 스택
  // 첫 칸에 붙일 때 `cardPeek && <ForecastStrip …/>` 로 읽는다 — 지금은 카드가 알려 주는 값만 받아 둔다.
  const [cardPeek, setCardPeek] = useState(true);
  // 키보드가 이 화면 아래를 가린 두께 — 진행 중 여행 카드의 '상황 변경' 입력 칸이 키보드 밑으로 숨지 않게 카드 최대 높이를 줄인다
  // (안드로이드가 창을 줄여 주면 containerH 가 줄어 이 값은 0 이 된다 — 두 경우 모두 맞다). 칸을 보이게 올리는 것은 카드가 한다.
  const rootRef = useRef<View>(null);
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
  const storedRef = useRef(stored);
  storedRef.current = stored;

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
      const nextSeed = homeFilterSeed(nextStored);
      setStored(nextStored);
      setCategory(nextSeed.category);
      setConvenience((prev) => ({ ...prev, accessible: nextSeed.accessible, stroller: nextSeed.stroller }));
      setIndoor(nextSeed.indoor);
      setCuisineId(null);
      setSelection(null);
      pickedRef.current = false;
    }
  }, []));

  const byId = useMemo(() => new Map(facilities.map((f) => [f.id, f])), [facilities]);
  const hasFacilities = facilities.length > 0;

  // ── 카메라 ───────────────────────────────────────────────────────────
  const searching = query.trim() !== '';
  const focusOn = useCallback((latitude: number, longitude: number, level?: number) => {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    mapRef.current?.animateTo({ latitude, longitude }, { level, insets: { top: headerH + 8, bottom: bottomStackRef.current + 8 } });
  }, [headerH]);

  // 첫 진입·위치가 잡힐 때 그 자리로(웹 centerOnFreeArea). 한 번 옮긴 뒤에는 사용자가 움직이는 대로 둔다.
  const centeredRef = useRef(false);
  useEffect(() => {
    if (!mapReady || centeredRef.current || loc.status === 'checking' || loc.status === 'needs-primer') return;
    centeredRef.current = true;
    mapRef.current?.animateTo({ latitude: userPoint.lat, longitude: userPoint.lng }, { level: 4, duration: 0, insets: { top: headerH + 8, bottom: 16 } });
  }, [mapReady, loc.status, userPoint.lat, userPoint.lng, headerH]);
  const knownRef = useRef(false);
  useEffect(() => {
    if (!loc.known || knownRef.current || !mapReady) return;
    knownRef.current = true;
    focusOn(userPoint.lat, userPoint.lng);
  }, [loc.known, mapReady, userPoint.lat, userPoint.lng, focusOn]);

  // ── 위치 안내 ────────────────────────────────────────────────────────
  useEffect(() => {
    if (loc.notice !== 'outOfRegion') return;
    // 도보 N분이 어디서 잰 값인지 모르면 '내 위치' 거리로 읽힌다 — 세션에 한 번만 알린다(웹과 같다).
    const store = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    let noticed = false;
    try {
      noticed = store?.getItem(OUT_OF_REGION_NOTICE_KEY) === '1';
      store?.setItem(OUT_OF_REGION_NOTICE_KEY, '1');
    } catch { /* 저장소 문제 — 이번 한 번은 알린다 */ }
    if (!noticed) showToast(t('map.outOfRegionStart'));
  }, [loc.notice, t, showToast]);
  useEffect(() => {
    if (loc.readFailed) showToast(t('map.locationFallback'));
  }, [loc.readFailed, t, showToast]);

  // ── 서버 추천(칩 종류별 상위 5) ─────────────────────────────────────
  const userKey = `${userPoint.lat.toFixed(4)},${userPoint.lng.toFixed(4)}`;
  const travelContext = useMemo(
    () => homeRequestContext(stored, { accessible: convenience.accessible, stroller: convenience.stroller, indoor }),
    [stored, convenience.accessible, convenience.stroller, indoor],
  );
  useEffect(() => {
    if (!hasFacilities) return;
    let cancelled = false;
    const controller = new AbortController();
    setRecs(null);
    setRecsFailed(false);
    // 거절·저장 id 는 요청 때의 값(ref)으로 — 거절할 때마다 다시 묻지 않는다(웹도 dep 에서 뺐다).
    const excludeIds = [...excludedRef.current];
    const intent = cuisineIntentOf(storedRef.current);
    const request = (context: TravelContext) =>
      recommendByType(category, userPoint, excludeIds, 5, context, intent, controller.signal, RECOMMENDATION_TIMEOUT_MS);
    (async () => {
      try {
        let res = await request(travelContext);
        // 서버는 실제 걷는 길로 도보 제한을 잰다 — 0곳이면 도보 제한만 풀어 한 번 더(웹 relaxWalkLimit).
        const relaxed = res.length === 0 ? relaxWalkLimit(travelContext) : null;
        if (relaxed && !cancelled) res = await request(relaxed);
        if (cancelled) return;
        const known = new Set(facilitiesRef.current.map((f) => f.id));
        setRecs(res.filter((r) => known.has(r.facility.id)));
      } catch {
        // 실패 — 화면 안에서 점수를 지어내지 않고 카드 자리에 오류 판 + 다시 시도(G3-26, 'SPOT 은 백엔드 단일 소스').
        if (!cancelled) { setRecsFailed(true); setRecs([]); }
      }
    })();
    return () => { cancelled = true; controller.abort(); };
    // userPoint 는 userKey 로, facilities 는 ref 로 본다 — 목록이 갱신될 때마다 다시 묻지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFacilities, category, userKey, travelContext, recsNonce]);

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
  const nearestOf = useCallback((list: readonly HomeFacility[]) => {
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
    if (status === 'closing_soon') {
      const alt = visibleRecs.find((r) => r.facility.id !== facility.id && r.openStatusAtArrival === 'open_expected');
      const altFacility = alt ? byId.get(alt.facility.id) : undefined;
      showToast(t(altFacility ? 'map.closingSoonRedirect' : 'map.closingSoonNoAlternative', { name: facility.name }));
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
    setActiveGroup(null);
    setFestival(null);
    return true;
  }, [visibleRecs, userPoint.lat, userPoint.lng, byId, focusOn, t, showToast]);

  // 추천이 도착하면 1위를 카드 자리에 연다. 0곳이면 비워 두고 제안 상자(G3-27)가, 실패면 오류 판(G3-26)이 같은 자리를 쓴다
  // — 화면 안에서 가까운 곳을 골라 점수 없는 카드를 띄우지 않는다(웹은 SPOT 미러로 띄우지만 앱은 미러를 옮기지 않는다).
  useEffect(() => {
    if (recs === null || pickedRef.current) return;
    const top = visibleRecs[0] ? byId.get(visibleRecs[0].facility.id) : undefined;
    if (!top) { setSelection(null); return; }
    setSelection({ id: top.id, kind: 'recommended' });
    focusOn(top.latitude, top.longitude);
    // 추천이 바뀔 때만 — 선택·위치가 바뀔 때마다 1위로 되돌리지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recs]);

  const selectCategory = useCallback((next: PlaceCategory) => {
    haptic('selection');
    pickedRef.current = false;
    setCategory(next);
    setSelection(null);
    setActiveGroup(null);
    setCuisineId(null);
    setFestival(null);
    track('category_chip', { category: next });
  }, []);

  const selected = selection ? byId.get(selection.id) ?? null : null;

  const toggleConvenience = useCallback((key: keyof Convenience) => {
    haptic('selection');
    setConvenience((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      track('context_applied', { required_attributes: [next.accessible && 'accessible', next.stroller && 'stroller'].filter(Boolean) as string[] });
      return next;
    });
    setSelection(null);
    pickedRef.current = false;
  }, []);

  const toggleIndoor = useCallback((required: boolean) => {
    setIndoor(required);
    setSelection(null);
    pickedRef.current = false;
  }, []);

  const selectCuisine = useCallback((chip: (typeof CUISINE_CHIPS)[number]) => {
    haptic('selection');
    if (cuisineId === chip.id) { setCuisineId(null); return; }
    const pool = filtered.filter((f) => matchesCuisineChip(f, chip) && !excludedRef.current.has(f.id));
    if (pool.length === 0) { showToast(t('cuisine.noMatch')); return; }
    setCategory('restaurant');
    setCuisineId(chip.id);
    setFilterOpen(false);
    const first = nearestOf(pool);
    if (first && select(first, 'pin')) focusOn(first.latitude, first.longitude);
  }, [cuisineId, filtered, nearestOf, select, focusOn, t, showToast]);

  // ── 핀 ───────────────────────────────────────────────────────────────
  // 놓는 순서 = 서버 순위 먼저, 같은 순위 안에서는 SPOT 점수(웹 computeDisplayFacilities, G2-03).
  const cuisineIntent = useMemo(() => cuisineIntentOf(stored), [stored]);
  const pinMarkers: PinMarker[] = useMemo(() => {
    const ordered = orderPinsBySpot(poolList, rankById, { userLocation: userPoint, preferredCategories, cuisineIntent });
    const clusters = declutterPins(ordered, viewport ? { region: viewport.region, size: viewport.size } : null, { searching });
    return buildPinMarkers(clusters, {
      rankById,
      selectedId: selection?.id ?? null,
      activeGroupId: activeGroup?.key ?? null,
      busyAt,
      now: new Date(),
      groupName: (count) => t('map.placesInBuilding', { count }),
    });
  }, [poolList, rankById, userPoint, preferredCategories, cuisineIntent, viewport, searching, selection?.id, activeGroup?.key, busyAt, t]);

  const markers: NextSpotMarker[] = useMemo(() => {
    const extra: NextSpotMarker[] = [...(festival?.markers ?? [])];
    if (placePin) {
      const at = { latitude: placePin.latitude, longitude: placePin.longitude };
      extra.push({ kind: 'dot', id: `place-${placePin.id}`, coordinate: at, color: colors.gold, size: 14, zIndex: 90 });
      extra.push({ kind: 'label', id: `place-label-${placePin.id}`, coordinate: at, text: placePin.name, color: colors.muk, above: true, zIndex: 91 });
    }
    return [...pinMarkers, ...extra];
  }, [pinMarkers, festival, placePin]);

  const onMarkerPress = useCallback((marker: NextSpotMarker) => {
    if (marker.kind !== 'pin') return;
    const cluster = marker.data as PinCluster<HomeFacility> | undefined;
    if (!cluster) return;
    haptic('selection');
    setPlacePin(null);
    if (select(cluster.anchor, 'pin')) focusOn(cluster.anchor.latitude, cluster.anchor.longitude);
  }, [select, focusOn]);

  const onGroupPress = useCallback((marker: PinMarker) => {
    const cluster = marker.data as PinCluster<HomeFacility> | undefined;
    if (!cluster) return;
    haptic('selection');
    setActiveGroup(cluster);
    setSelection(null);
    setFestival(null);
    focusOn(cluster.anchor.latitude, cluster.anchor.longitude);
  }, [focusOn]);

  const onMapPress = useCallback((_: LatLng) => {
    Keyboard.dismiss();
    setSelection(null);
    setActiveGroup(null);
    setFestival(null);
    setPlacePin(null);
    pickedRef.current = false;
  }, []);

  // ── 검색 ─────────────────────────────────────────────────────────────
  // 우리 장소 일치는 목록 없이 지도 핀으로 보인다(G2-19 — 이름표·확대는 H3b). 일치가 0 일 때만 카카오 → 관광공사를 묻는다.
  const allMatches = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    return filtered.filter((f) => facilityMatchesSearch(f, q));
  }, [filtered, query]);
  const nearestMatch = useMemo(() => nearestOf(allMatches), [allMatches, nearestOf]);
  const external = usePlaceSearch(query, allMatches.length);
  const ingest = useIngestRequest(showToast);

  const pickLocal = useCallback((facility: HomeFacility) => {
    Keyboard.dismiss();
    setPanelOpen(false);
    setPlacePin(null);
    if ((CATEGORIES as readonly string[]).includes(facility.type) && facility.type !== category) {
      setCategory(facility.type as PlaceCategory);
      setCuisineId(null);
    }
    if (select(facility, 'search')) focusOn(facility.latitude, facility.longitude, 3);
  }, [category, select, focusOn]);

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
  const moveToNext = useCallback((next: SheetCandidate | null) => {
    pickedRef.current = false;
    const facility = next ? byId.get(next.facility.id) : undefined;
    if (facility) { setSelection({ id: facility.id, kind: 'recommended' }); focusOn(facility.latitude, facility.longitude); }
    else setSelection(null);
  }, [byId, focusOn]);

  const onPutOff = useCallback((done: SheetCandidate, next: SheetCandidate | null) => {
    setSavedIds((prev) => new Set(prev).add(done.facility.id));
    moveToNext(next);
  }, [moveToNext]);
  const onReject = useCallback((done: SheetCandidate, next: SheetCandidate | null) => {
    setRejectedIds((prev) => {
      const updated = new Set(prev).add(done.facility.id);
      try { sessionStore()?.setItem(REJECTED_IDS_KEY, serializeRejectedIds(updated)); } catch { /* 이번 화면에서만 뺀다 */ }
      return updated;
    });
    moveToNext(next);
  }, [moveToNext]);

  // 길안내(도보·자동차)를 고른 뒤에도 카드를 닫지 않는다 — 웹처럼 카드가 남아 '바로 갈래요' 가 확인(✓) 상태가 되고,
  // 진행 중 여행 카드가 위에 뜬다. 늦게 온 추천 1위가 이 카드를 덮지 않게 직접 고른 것으로 둔다.
  const keepAfterAccept = useCallback(() => { pickedRef.current = true; }, []);
  const showAlternatives = useCallback((c: SheetCandidate) => {
    goInstead({ facilityId: c.facility.id, type: c.facility.type, latitude: c.facility.latitude, longitude: c.facility.longitude });
  }, [goInstead]);
  const selectedCandidate = useMemo(
    () => (selected && selection
      ? buildSelectedCandidate(selected, selection.kind, visibleRecs, { lat: userPoint.lat, lng: userPoint.lng }, estimateById)
      : null),
    [selected, selection, visibleRecs, userPoint.lat, userPoint.lng, estimateById],
  );
  // 비교 헤더의 기준 명소(G3-13) · 2·3위 '추천 이유'(G3-14).
  const compareAnchor = useMemo(() => compareAnchorFor(selectedCandidate, facilities, estimateById), [selectedCandidate, facilities, estimateById]);
  const comparisons = useMemo(() => spotComparisonsById(visibleRecs), [visibleRecs]);
  const comparison = comparisonFor(comparisons, selectedCandidate, visibleRecs);
  const comparisonReason = comparison ? formatSpotComparison(t, comparison) : undefined;
  const status = cardStatus({ hasFacilities, recsLoaded: recs !== null, recsFailed, hasSelection: selection !== null, searching });
  const retryRecs = useCallback(() => setRecsNonce((n) => n + 1), []);

  // 이 칩에 추천할 곳이 없을 때(서버 0곳 · 모두 거절·저장) — 지금 후보가 있는 다른 칩을 바로 고르게 한다(웹 category-suggestion).
  // 빈 지도를 눌러 카드만 닫은 때는 띄우지 않는다(G2-30 1번 — 이 칩 추천이 정말 0곳일 때만).
  const noRecommendation = recs !== null && !recsFailed && visibleRecs.length === 0;
  const suggestions = useMemo(() => {
    if (selection || loading || error || !hasFacilities || !noRecommendation || searching) return [];
    return CATEGORIES.filter((c) => c !== category)
      .map((c) => ({ type: c, count: filtered.filter((f) => f.type === c).length }))
      .filter((s) => s.count > 0);
  }, [selection, loading, error, hasFacilities, noRecommendation, searching, category, filtered]);

  // 동의 없음('no-consent')도 거부와 같은 배너 자리 — 누르면 설정 앱 대신 동의 화면.
  const showBanner = !bannerDismissed && (loc.status === 'denied' || loc.status === 'no-consent' || loc.notice === 'coarse');

  const accessibleAnywhere = useMemo(() => facilities.some((f) => isAccessible(f)), [facilities]);
  const strollerAnywhere = useMemo(() => facilities.some((f) => isStrollerFriendly(f)), [facilities]);
  const askedExternal = shouldAskExternal(query, allMatches.length);
  const ext = askedExternal ? external : NO_EXTERNAL;
  const showSearchResults = searching && panelOpen;
  const searchNothing = allMatches.length === 0 && !ext.placesLoading && ext.places.length === 0 && !ext.tourLoading && ext.tour.length === 0;

  // 검색 중에는 날씨 줄을 감춘다 — 열린 팝오버도 닫는다.
  useEffect(() => {
    if (searching) setWeatherAnchor(null);
  }, [searching]);

  // 내 위치 — 점은 동의 + 허용 + 실제 위치일 때만, 버튼은 상태에 맞는 흐름으로(locationPolicy.myLocationAction).
  const userDotShown = showsUserDot(loc);
  const onMyLocation = useCallback(() => {
    haptic('selection');
    // 설정 앱의 선택지 이름이 OS 마다 달라 본문을 나눈다(안드로이드 '앱 사용 중에만 허용' · iOS '앱을 사용하는 동안').
    const explainBlocked = (coarse: boolean) => Alert.alert(
      t(coarse ? 'app.home.myLocation.coarseTitle' : 'app.home.myLocation.blockedTitle'),
      coarse
        ? t('app.home.locationBanner.coarse')
        : t(Platform.OS === 'ios' ? 'app.home.myLocation.blockedBodyIos' : 'app.home.myLocation.blockedBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('app.home.myLocation.openSettings'), onPress: loc.openSettings },
      ],
    );
    const action = myLocationAction(loc);
    if (action === 'consent') { loc.openConsent(); return; }
    if (action === 'request') { loc.continueFromPrimer(); return; }
    if (action === 'settings') { explainBlocked(false); return; }
    if (action === 'none') return;
    // 허용 상태 — 사용자가 누른 것이니 한 번 다시 읽고(앱을 쓰는 중 · foreground), 읽은 결과로 다시 판정한다.
    // 경주 안으로 들어왔거나 정확한 위치를 켜고 왔을 수 있다.
    if (action === 'recenter') focusOn(userPoint.lat, userPoint.lng);
    // 첫 실패는 readFailed 효과가 이미 알린다 — 이미 실패한 상태에서 다시 실패했을 때만 여기서 알린다.
    const wasFailed = loc.readFailed;
    void loc.refresh().then((next) => {
      const after = next ? myLocationAction({ ...loc, status: 'granted', known: next.known, notice: next.notice }) : action;
      if (after === 'recenter') {
        if (next) focusOn(next.location.lat, next.location.lng);
      } else if (after === 'outOfRegion') showToast(t('map.outOfRegionStart'));
      else if (after === 'coarse') explainBlocked(true);
      else if (!next && wasFailed) showToast(t('map.locationFallback'));
    });
  }, [loc, focusOn, userPoint.lat, userPoint.lng, t, showToast]);

  // 넓은 화면(폴더블 펼침)에서 위 칩 줄 · 아래 스택을 같은 폭의 가운데 열로 — 지도가 양옆에 남는다.
  const overlayWidth = { width: '100%' as const, maxWidth: HOME_PANEL_MAX_WIDTH, alignSelf: 'center' as const };
  const sideStyle = { paddingLeft: insets.left + SIDE, paddingRight: insets.right + SIDE };
  const journeyTop = insets.top + JOURNEY_TOP_OFFSET;
  const searchFont = fontStyleFor('regular', locale, Platform.OS === 'web' ? 'web' : 'native');

  return (
    <View ref={rootRef} className="flex-1 bg-hanji" onLayout={(e) => setContainerH(Math.round(e.nativeEvent.layout.height))}>
      <NextSpotMap
        ref={mapRef}
        style={{ flex: 1 }}
        markers={markers}
        circles={festival?.circles}
        userLocation={userDotShown ? { latitude: userPoint.lat, longitude: userPoint.lng, variant: 'halo' } : null}
        onMarkerPress={onMarkerPress}
        onGroupPress={onGroupPress}
        onMapPress={onMapPress}
        onRegionChangeComplete={(v) => setViewport(v)}
        onMapReady={() => setMapReady(true)}
      />

      {/* 상단 묶음 — 언어 · 출처(왼쪽 열) · KST 시계(오른쪽), G2-10. */}
      <HomeTopCluster />

      {/* 위 — 검색 · 날씨 줄 · 검색 결과 · 칩 줄. 빈 곳을 누르면 지도가 받는다. */}
      <View
        pointerEvents="box-none"
        className="absolute inset-x-0 top-0"
        style={[{ paddingTop: insets.top + HEADER_TOP }, sideStyle]}
        onLayout={(e) => setHeaderH(Math.round(e.nativeEvent.layout.height))}
      >
        <View pointerEvents="box-none" style={overlayWidth} className="gap-[8px]">
          <View className="min-h-[48px] flex-row items-center rounded-full border border-line bg-white px-[14px]">
            <Icon icon={Search} size="lg" color="muk-soft" />
            <TextInput
              value={query}
              onChangeText={(v) => { setQuery(v); setPanelOpen(true); }}
              onSubmitEditing={() => { if (nearestMatch) pickLocal(nearestMatch); }}
              placeholder={t('map.searchPlaceholder')}
              placeholderTextColor={colors['muk-soft']}
              accessibilityLabel={t('map.searchPlaceholder')}
              returnKeyType="search"
              autoCorrect={false}
              className="min-h-[44px] flex-1 px-[10px] text-[14px] text-muk"
              style={[searchFont, { paddingVertical: 0 }]}
            />
            {query ? (
              <IconButton icon={X} accessibilityLabel={t('map.searchClear')} color="muk-soft" onPress={() => { setQuery(''); setPlacePin(null); }} />
            ) : null}
          </View>

          {/* 날씨 · ✨ 한 줄(웹 :4092-4127) — 가로 스크롤이 아니다. 검색 중에는 감춘다. ✨ 경주 테마 알약은 F2 가 이 줄 끝에 더한다. */}
          {!searching && weather ? (
            <View pointerEvents="box-none" className="flex-row items-center gap-[8px]">
              <WeatherPill
                data={weather}
                expanded={weatherAnchor !== null}
                onToggle={(anchor) => setWeatherAnchor((open) => (open ? null : anchor))}
              />
            </View>
          ) : null}

          {/* 검색 결과 — 검색창 바로 아래(웹 :4131-4300). 우리 장소 일치가 있으면 목록 없이 지도가 보인다. */}
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

          {/* '필터·편의' 가 맨 앞인 분류 칩 줄 — 검색 중에도 남는다(G2-19). 모양(유리·아이콘·주차장 탭)은 H3b(G2-25). */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 6, alignItems: 'center' }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('map.mobileTools')}
              accessibilityState={{ selected: hasAnyConvenience(convenience) || cuisineId !== null }}
              hitSlop={CHIP_HIT_SLOP}
              onPress={() => setFilterOpen(true)}
              className={`min-h-[36px] shrink-0 flex-row items-center gap-[6px] rounded-full border px-[12px] py-[6px] ${hasAnyConvenience(convenience) || cuisineId ? 'border-jade bg-jade-chip' : 'border-line bg-white'}`}
            >
              <Icon icon={SlidersHorizontal} size="sm" color="muk" />
              <Text className="text-[13px]" weight="semibold" numberOfLines={1}>{t('map.mobileTools')}</Text>
            </Pressable>
            {CATEGORIES.map((c) => {
              const on = c === category;
              return (
                <Pressable
                  key={c}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  hitSlop={CHIP_HIT_SLOP}
                  onPress={() => selectCategory(c)}
                  className={`min-h-[36px] shrink-0 flex-row items-center rounded-full border px-[14px] py-[6px] ${on ? 'border-muk bg-muk' : 'border-line bg-white'}`}
                >
                  <Text className={`text-[13px] ${on ? 'text-hanji' : 'text-muk'}`} weight="semibold" numberOfLines={1}>{t(`category.${c}`)}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </View>

      {/* 가운데 — 불러오는 중 · 실패 · 빈 상태 */}
      {loading && !hasFacilities ? (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center gap-[12px]">
          <ActivityIndicator size="large" color={colors.gold} />
          <Text className="text-[14px]" weight="medium">{t('map.loadingRec')}</Text>
        </View>
      ) : null}
      {!loading && error ? (
        <View pointerEvents="box-none" className="absolute inset-0 items-center justify-center px-[24px]">
          <ErrorState message={`${t('map.loadErrorTitle')}\n${t('map.loadErrorBody')}`} retryLabel={t('common.retry')} onRetry={reload} className="max-w-[320px] bg-white" />
        </View>
      ) : null}
      {!loading && !error && !hasFacilities ? (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center px-[24px]">
          <EmptyState emoji="🗺️" title={t('map.emptyTitle')} description={t('map.emptyBody')} className="max-w-[320px]" />
        </View>
      ) : null}

      {/* 아래 스택 — 웹 `absolute inset-x-4 bottom-[clearance] flex-col gap-2`(탭 막대 위 NAV_GAP). 카드가 마지막 자식이다.
          순서: (내 위치 · 위치 배너 — H3b 위치 흐름) → 예측 띠 자리(H2b ForecastStrip — 웹 order-first, 카드가 미리보기일 때만,
          H3b 가 cardPeek 와 함께 연결) → 스켈레톤 · 추천 카드 · 오류 판(RecommendationCard 하나가 상태로 고른다) → 제안 상자. */}
      <View
        pointerEvents="box-none"
        className="absolute inset-x-0 bottom-0"
        style={[{ paddingBottom: nav.gap }, sideStyle]}
        onLayout={(e) => { bottomStackRef.current = Math.round(e.nativeEvent.layout.height); }}
      >
        <View pointerEvents="box-none" style={overlayWidth} className="gap-[8px]">
          {showsMyLocationButton(loc.status) && hasFacilities ? (
            <View pointerEvents="box-none" className="items-end">
              <IconButton
                icon={LocateFixed}
                accessibilityLabel={t('app.home.myLocation.recenter')}
                color={userDotShown ? 'gold-deep' : 'muk-soft'}
                onPress={onMyLocation}
                className="border border-line bg-white"
              />
            </View>
          ) : null}
          {showBanner ? (
            <LocationBanner
              kind={loc.status === 'denied' || loc.status === 'no-consent' ? 'denied' : 'coarse'}
              onOpenSettings={loc.status === 'no-consent' ? loc.openConsent : loc.openSettings}
              onDismiss={() => setBannerDismissed(true)}
            />
          ) : null}
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
            comparisonReason={comparisonReason}
            compareAnchor={compareAnchor}
            onPeekChange={setCardPeek}
            onToast={showToast}
            onViewProfile={openMypageHome}
            onViewLab={() => pushMypageSub('lab')}
          />
          {!selected && suggestions.length > 0 ? (
            <SuggestionBox
              title={t(convenience.accessible ? 'map.barrierFreeElsewhere' : convenience.stroller ? 'map.strollerElsewhere' : 'map.suggestTitle')}
              items={suggestions.map((s) => ({ type: s.type, label: t('map.suggestButton', { category: t(`category.${s.type}`), n: s.count }) }))}
              onPick={selectCategory}
            />
          ) : null}
        </View>
      </View>

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

      {/* 방문 확인 — 웹 `fixed z-[55] bottom-[clearance + 8] max-w-sm px-4`: 탭 막대 위 NAV_GAP + 8, 가운데, 추천 카드 위에 겹친다(G3-31).
          진행 중 여행 카드(위)와 함께 보일 수 있다. */}
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
          indoorRequired={indoor}
          onIndoorRequiredChange={toggleIndoor}
          onClose={() => setWeatherAnchor(null)}
        />
      ) : null}

      <ToolsSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        convenience={convenience}
        onToggle={toggleConvenience}
        showAccessible={accessibleAnywhere}
        showStroller={strollerAnywhere}
        showCuisine={category === 'restaurant'}
        cuisineId={cuisineId}
        cuisineSetupId={stored.cuisine ? SETUP_CUISINE_CHIP[stored.cuisine] ?? null : null}
        onSelectCuisine={selectCuisine}
        location={userPoint}
        onFocusFestival={onFestivalFocus}
      />
      <GroupSheet
        title={activeGroup ? t('map.placesInBuilding', { count: activeGroup.members.length }) : ''}
        members={activeGroup ? activeGroup.members : null}
        onClose={() => setActiveGroup(null)}
        onPick={(facility) => {
          setActiveGroup(null);
          if (select(facility, 'pin')) focusOn(facility.latitude, facility.longitude);
        }}
      />
      {loc.status === 'needs-primer' ? <LocationPrimer onContinue={loc.continueFromPrimer} /> : null}
    </View>
  );
}

/**
 * 다른 칩 제안 상자(G3-27) — 웹 category-suggestion(page.tsx 4916-4994): 흰 판 · 마스코트 48 · 14 semibold 제목 · 금 알약 칩.
 * ♿·👶 조건 핀 안내('지도에 N곳' · '유모차 조건 끄기')와 '전부 오늘 휴무' 문장은 조건 저장·카메라 맞춤(G2-28 · G2-30)과 함께 H3b 가 더한다.
 */
function SuggestionBox({ title, items, onPick }: {
  title: string;
  items: readonly { type: PlaceCategory; label: string }[];
  onPick: (type: PlaceCategory) => void;
}) {
  return (
    <View
      accessibilityLiveRegion="polite"
      className="items-center gap-[8px] rounded-2xl border border-line bg-white px-[20px] py-[16px]"
      style={{ boxShadow: SUGGESTION_SHADOW }}
    >
      <NextSpotMascot size={48} />
      <Text className="text-center text-[14px]" weight="semibold">{title}</Text>
      <View className="mt-[4px] flex-row flex-wrap justify-center gap-[8px]">
        {items.map((s) => (
          <Pressable
            key={s.type}
            accessibilityRole="button"
            onPress={() => onPick(s.type)}
            hitSlop={{ top: 6, bottom: 6 }}
            className="justify-center rounded-full border border-gold/50 bg-gold/10 px-[14px] py-[8px]"
          >
            <Text className="text-[12px]" weight="bold">{s.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
