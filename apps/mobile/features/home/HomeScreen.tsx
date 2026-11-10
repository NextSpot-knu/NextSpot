// 홈(지도) 화면 — 웹 /main(apps/web/app/main/page.tsx, 기준 커밋 0d145a1)의 앱판.
//
// 뺀 것(계획 §3.1): 음성 비서 · 히트맵 · 혼잡 예측 띠/가정 시각 · 데모 조작 패널 · 지역 전환(내부 계정) · 주차장 탭 ·
//   경주 테마(✨) · 적재 요청 UI. 추천 카드 시트·진행 중 여행·방문 확인·혼잡 제보는 features/recommendation-card 의 것을 그대로 올린다
//   (rec_* 이용 이벤트는 시트가 직접 보낸다 — 홈은 보내지 않는다). 시트에 넘길 값은 sheetModel.ts 의 순수 함수가 만든다.
// 흐름: 시설 로드(/infrastructures) → 칩의 종류로 서버 추천(by-type) → 1위를 카드 자리에 연다 → 핀·검색으로 직접 고르면
//   그 장소가 '선택한 장소'. 핀 겹침은 지도가 알려 준 영역으로 declutterPins.
// 첫 설정(nextspot_setup_prefs)이 첫 칩·조건 칩을 정하고, 도보·여행 시간·음식 취향·방문 제외를 추천 요청에 싣는다
//   (homeContext.ts — 웹 rankContext). 도보 제한으로 0곳이면 한 번 넓혀 다시 묻는다. 서버에는 이번 세션 거절 + 저장한 곳을 빼 달라고 보낸다.
import { useFocusEffect, useRouter } from 'expo-router';
import { LocateFixed, Search, SlidersHorizontal, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Dimensions, Keyboard, Platform, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { facilityMatchesSearch } from '@/lib/placeSearch';
import { getArrivalOpenStatus } from '@/lib/restDate';
import { EmptyState, ErrorState, Icon, IconButton, Pressable, Text, toast } from '~/components/ui';
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
  RecommendationSheet,
  VisitCheckCard,
  type SheetCandidate,
} from '~/features/recommendation-card';
import { loadTravelContext } from '~/features/course/travelContext';
import { recommendByType, type RecommendationResponse } from '~/lib/core/apiClient';
import { loadSavedLocal, syncSaved } from '~/lib/core/savedFacilities';
import type { TravelContext } from '~/lib/core/travelContextTypes';
import { useBusyThreshold } from '~/lib/core/publicSettings';
import { isStrollerFriendly } from '~/lib/core/strollerSupport';
import { useT } from '~/lib/i18n/I18nProvider';
import { haptic } from '~/lib/platform/haptics';
import { openExternalUrl, openWalkingDirections } from '~/lib/platform/links';
import { track } from '~/lib/platform/analytics';
import { colors, fontFamilies } from '~/lib/theme/tokens';

import { FilterSheet, GroupSheet, LocationBanner, LocationPrimer, SearchPanel } from './HomeOverlays';
import {
  applyConvenience,
  buildInsteadHref,
  buildPinMarkers,
  CATEGORIES,
  canSeeInstead,
  CUISINE_CHIPS,
  distanceM,
  HOME_PANEL_MAX_WIDTH,
  keyboardCoverFor,
  festivalFocus,
  hasAnyConvenience,
  isAccessible,
  matchesCuisineChip,
  NO_CONVENIENCE,
  orderForPins,
  petDataExists,
  pickTripOverlay,
  tripScrollMaxHeight,
  tripOverlayRoom,
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
  mapBottomInset,
  sheetStatus,
  type PickKind,
  sheetCoverHeight,
  type SheetHeightState,
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
import { CalmChip, CHIP_HIT_SLOP, FestivalChip, RestroomChip, WeatherChip, type FestivalEvent } from './ToolChips';
import { useFacilities } from './useFacilities';
import { usePlaceSearch, type PlaceSearchItem, type TourApiSearchItem } from './usePlaceSearch';
import { useUserLocation } from './useUserLocation';

const OUT_OF_REGION_NOTICE_KEY = 'nextspot_out_of_region_notice';
const RECOMMENDATION_TIMEOUT_MS = 20_000;
const LOCAL_RESULT_LIMIT = 8;
const SLOT_FALLBACK_HEIGHT = 150;

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
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const busyAt = useBusyThreshold();
  const mapRef = useRef<NextSpotMapHandle>(null);

  const { facilities, loading, error, reload } = useFacilities();
  const loc = useUserLocation();
  const userPoint = loc.location;

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
  const [headerH, setHeaderH] = useState(160);
  const [sheetState, setSheetState] = useState<SheetHeightState | null>(null);
  // 시트 가장 낮은 높이(px) — 시트가 머리 + 첫 행동 줄을 재서 알려 준다. 모르면 27% 비율(sheetModel.sheetCoverHeight).
  const [sheetPeekPx, setSheetPeekPx] = useState<number | null>(null);
  const [containerH, setContainerH] = useState(0);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [bottomStackH, setBottomStackH] = useState(0);
  // 키보드가 이 화면 아래를 가린 두께 — 여정 카드의 '상황 변경' 입력 칸이 키보드 밑으로 숨지 않게 카드 자리를 줄인다.
  // (안드로이드가 창을 줄여 주면 containerH 가 줄어 이 값은 0 이 된다 — 두 경우 모두 맞다.)
  // 계산은 homeModel.keyboardCoverFor — 화면 높이 − 키보드 − 내비게이션 막대(안드로이드 14 이하·15 모두 맞게), 분할 창은 창 기준.
  const rootRef = useRef<View>(null);
  const tripScrollRef = useRef<ScrollView>(null);
  const tripContentRef = useRef<View>(null);
  const tripInputFocusedRef = useRef(false);
  const [tripTyping, setTripTyping] = useState(false);
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const later = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => { timersRef.current.delete(id); fn(); }, ms);
    timersRef.current.add(id);
  }, []);
  useEffect(() => () => { timersRef.current.forEach(clearTimeout); timersRef.current.clear(); }, []);
  const bottomInsetRef = useRef(insets.bottom);
  bottomInsetRef.current = insets.bottom;
  const [keyboardCover, setKeyboardCover] = useState(0);
  /** 여정 카드 안에서 초점 받은 입력 칸을 스크롤 안 보이는 곳으로(키보드가 올라와 자리가 줄어든 뒤에도). */
  const revealFocusedInput = useCallback(() => {
    if (!tripInputFocusedRef.current) return;
    const input = TextInput.State.currentlyFocusedInput?.();
    const content = tripContentRef.current;
    if (!input || !content) return;
    try {
      input.measureLayout(content, (_x, y) => tripScrollRef.current?.scrollTo({ y: Math.max(0, y - 12), animated: true }), () => undefined);
    } catch { /* 여정 카드 밖 입력 — 둘 일 없음 */ }
  }, []);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      const android = Platform.OS === 'android';
      const windowH = Dimensions.get('window').height;
      const screenH = android ? Dimensions.get('screen').height : windowH;
      const navBar = android ? bottomInsetRef.current : 0;
      rootRef.current?.measureInWindow((_x, y, _w, h) => setKeyboardCover(keyboardCoverFor({
        rootY: y, rootH: h, windowH, screenH, keyboardH: e.endCoordinates.height, navBar,
      })));
      setTripTyping(tripInputFocusedRef.current);
      later(revealFocusedInput, 120); // 줄어든 자리로 다시 그린 뒤
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => { setKeyboardCover(0); setTripTyping(false); });
    return () => { show.remove(); hide.remove(); };
  }, [revealFocusedInput, later]);
  // 여정 카드가 그릴 것이 있는가 — 카드가 알려 준다(둘 다 늘 붙어 있다).
  const [visitActive, setVisitActive] = useState(false);
  const [journeyActive, setJourneyActive] = useState(false);

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
  // 지도 가려진 띠 = 시트 높이(시트가 알려 주는 3단 상태 × 화면 높이). 시트가 없으면 작은 여백만.
  const searching = query.trim() !== '';
  const status = sheetStatus({ hasFacilities, recsLoaded: recs !== null, hasSelection: selection !== null, searching });
  const sheetShown = selection !== null || status === 'loading';
  const bottomInset = mapBottomInset(sheetShown ? sheetState : null, containerH, SLOT_FALLBACK_HEIGHT, 16, sheetPeekPx);
  const focusOn = useCallback((latitude: number, longitude: number, level?: number) => {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    mapRef.current?.animateTo({ latitude, longitude }, { level, insets: { top: headerH + 8, bottom: bottomInset } });
  }, [headerH, bottomInset]);

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
    if (!noticed) toast(t('map.outOfRegionStart'));
  }, [loc.notice, t]);
  useEffect(() => {
    if (loc.readFailed) toast(t('map.locationFallback'));
  }, [loc.readFailed, t]);

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
        if (!cancelled) setRecs([]); // 실패 — 가까운 곳으로 대신한다(아래 효과)
      }
    })();
    return () => { cancelled = true; controller.abort(); };
    // userPoint 는 userKey 로, facilities 는 ref 로 본다 — 목록이 갱신될 때마다 다시 묻지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFacilities, category, userKey, travelContext]);

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
      toast(t(altFacility ? 'map.closingSoonRedirect' : 'map.closingSoonNoAlternative', { name: facility.name }));
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
  }, [visibleRecs, userPoint.lat, userPoint.lng, byId, focusOn, t]);

  // 추천이 도착하면 1위를 카드 자리에 연다. 서버가 실패했거나 0곳이면 가까운 곳으로(웹의 즉시 계산 카드 대신).
  useEffect(() => {
    if (recs === null || pickedRef.current) return;
    const top = visibleRecs[0] ? byId.get(visibleRecs[0].facility.id) : undefined;
    const next = top ?? (recs.length === 0 ? nearestOf(applyConvenience(facilities.filter((f) => f.type === category), convenience)) : null);
    if (!next) { setSelection(null); return; }
    setSelection({ id: next.id, kind: 'recommended' });
    focusOn(next.latitude, next.longitude);
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
    if (pool.length === 0) { toast(t('cuisine.noMatch')); return; }
    setCategory('restaurant');
    setCuisineId(chip.id);
    setFilterOpen(false);
    const first = nearestOf(pool);
    if (first && select(first, 'pin')) focusOn(first.latitude, first.longitude);
  }, [cuisineId, filtered, nearestOf, select, focusOn, t]);

  // ── 핀 ───────────────────────────────────────────────────────────────
  const pinMarkers: PinMarker[] = useMemo(() => {
    const ordered = orderForPins(poolList, rankById, userPoint);
    const clusters = declutterPins(ordered, viewport ? { region: viewport.region, size: viewport.size } : null, { searching });
    return buildPinMarkers(clusters, {
      rankById,
      selectedId: selection?.id ?? null,
      activeGroupId: activeGroup?.key ?? null,
      busyAt,
      now: new Date(),
      groupName: (count) => t('map.placesInBuilding', { count }),
    });
  }, [poolList, rankById, userPoint, viewport, searching, selection?.id, activeGroup?.key, busyAt, t]);

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
  const allMatches = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    return filtered.filter((f) => facilityMatchesSearch(f, q));
  }, [filtered, query]);
  const localResults = useMemo(() => {
    const origin = { latitude: userPoint.lat, longitude: userPoint.lng };
    return allMatches
      .map((facility) => ({ facility, distM: distanceM(origin, facility) }))
      .sort((a, b) => a.distM - b.distM)
      .slice(0, LOCAL_RESULT_LIMIT);
  }, [allMatches, userPoint.lat, userPoint.lng]);
  const external = usePlaceSearch(query, allMatches.length);

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
    setSelection(null);
    setActiveGroup(null);
    setPlacePin(null);
    setFestival(focus);
    focusOn(focus.center.latitude, focus.center.longitude, focus.area ? 5 : 4);
  }, [focusOn, t]);

  // ── 카드 자리 ────────────────────────────────────────────────────────
  const goInstead = useCallback((origin: Parameters<typeof buildInsteadHref>[0]) => {
    router.push(buildInsteadHref(origin, loc.known ? userPoint : null) as never);
  }, [router, loc.known, userPoint]);

  /** 시트가 킵·거절을 처리한 뒤 — 그 장소는 목록·핀 순위에서 빼고(onKeep·onReject), 시트가 알려 준 다음 후보로 넘어간다(없으면 접는다). */
  const moveToNext = useCallback((next: SheetCandidate | null) => {
    pickedRef.current = false;
    const facility = next ? byId.get(next.facility.id) : undefined;
    if (facility) { setSelection({ id: facility.id, kind: 'recommended' }); focusOn(facility.latitude, facility.longitude); }
    else setSelection(null);
  }, [byId, focusOn]);

  const onKeep = useCallback((done: SheetCandidate, next: SheetCandidate | null) => {
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

  const closeSheet = useCallback(() => { setSelection(null); pickedRef.current = false; }, []);
  // 길안내를 고른 뒤에도 카드를 닫지 않는다 — 웹처럼 카드가 남아 '길안내' 버튼이 확인(✓) 상태가 되고,
  // 진행 중 여행 카드가 위에 뜬다. 늦게 온 추천 1위가 이 카드를 덮지 않게 직접 고른 것으로 둔다.
  const keepAfterAccept = useCallback(() => { pickedRef.current = true; }, []);
  const showAlternatives = useCallback((c: SheetCandidate) => {
    goInstead({ facilityId: c.facility.id, type: c.facility.type, latitude: c.facility.latitude, longitude: c.facility.longitude });
  }, [goInstead]);
  const selectedCandidate = useMemo(
    () => (selected && selection ? buildSelectedCandidate(selected, selection.kind, visibleRecs, { lat: userPoint.lat, lng: userPoint.lng }) : null),
    [selected, selection, visibleRecs, userPoint.lat, userPoint.lng],
  );
  // 이 칩에 보여 줄 카드가 없을 때 — 지금 후보가 있는 다른 칩을 바로 고르게 한다(웹 category-suggestion).
  const suggestions = useMemo(() => {
    if (selection || loading || error || !hasFacilities || recs === null) return [];
    return CATEGORIES.filter((c) => c !== category)
      .map((c) => ({ type: c, count: filtered.filter((f) => f.type === c).length }))
      .filter((s) => s.count > 0);
  }, [selection, loading, error, hasFacilities, recs, category, filtered]);

  // 동의 없음('no-consent')도 거부와 같은 배너 자리 — 누르면 설정 앱 대신 동의 화면.
  const showBanner = !bannerDismissed && (loc.status === 'denied' || loc.status === 'no-consent' || loc.notice === 'coarse');

  const accessibleAnywhere = useMemo(() => facilities.some((f) => isAccessible(f)), [facilities]);
  const strollerAnywhere = useMemo(() => facilities.some((f) => isStrollerFriendly(f)), [facilities]);
  const petAnywhere = useMemo(() => petDataExists(facilities), [facilities]);
  const askedExternal = shouldAskExternal(query, allMatches.length);
  const showSearchPanel = searching && panelOpen;

  // 여정 카드 — 한 번에 하나(방문 확인이 먼저), 위 칩 줄과 아래 시트·배너 사이 남은 자리에만(homeModel.pickTripOverlay).
  const overlayTop = headerH + 8;
  const sheetCover = sheetShown && sheetState ? sheetCoverHeight(sheetState, containerH, sheetPeekPx) : 0;
  const tripRoom = tripOverlayRoom(containerH, overlayTop, Math.max(sheetCover, bottomStackH, keyboardCover));
  const tripRoomNoKeyboard = tripOverlayRoom(containerH, overlayTop, Math.max(sheetCover, bottomStackH));
  const tripOverlay = pickTripOverlay({
    visitActive, journeyActive, searching: showSearchPanel, room: tripRoom, roomWithoutKeyboard: tripRoomNoKeyboard, typing: tripTyping,
  });
  const tripHidden = tripOverlay.card === null || tripOverlay.hidden;
  // 감춘 카드 안 입력 칸에 키보드가 남지 않게(검색 판이 열리거나 시트를 올림).
  useEffect(() => {
    if (tripHidden && tripInputFocusedRef.current) Keyboard.dismiss();
  }, [tripHidden]);

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
      } else if (after === 'outOfRegion') toast(t('map.outOfRegionStart'));
      else if (after === 'coarse') explainBlocked(true);
      else if (!next && wasFailed) toast(t('map.locationFallback'));
    });
  }, [loc, focusOn, userPoint.lat, userPoint.lng, t]);

  // 넓은 화면(폴더블 펼침)에서 위 칩 줄 · 여정 카드 · 아래 시트를 같은 폭의 가운데 열로 — 지도가 양옆에 남는다.
  const overlayWidth = { width: '100%' as const, maxWidth: HOME_PANEL_MAX_WIDTH, alignSelf: 'center' as const };

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

      {/* 위 — 검색 · 날씨 · 칩 줄. 빈 곳을 누르면 지도가 받는다. */}
      <View
        pointerEvents="box-none"
        className="absolute inset-x-0 top-0 px-[12px]"
        style={{ paddingTop: insets.top + 8, paddingLeft: insets.left + 12, paddingRight: insets.right + 12 }}
        onLayout={(e) => setHeaderH(Math.round(e.nativeEvent.layout.height))}
      >
        <View pointerEvents="box-none" style={overlayWidth} className="gap-[8px]">
          <View className="min-h-[48px] flex-row items-center rounded-full border border-line bg-white px-[14px]">
            <Icon icon={Search} size="lg" color="muk-soft" />
            <TextInput
              value={query}
              onChangeText={(v) => { setQuery(v); setPanelOpen(true); }}
              onSubmitEditing={() => { if (localResults[0]) pickLocal(localResults[0].facility); }}
              placeholder={t('map.searchPlaceholder')}
              placeholderTextColor={colors['muk-soft']}
              accessibilityLabel={t('map.searchPlaceholder')}
              returnKeyType="search"
              autoCorrect={false}
              className="min-h-[44px] flex-1 px-[10px] text-[14px] text-muk"
              style={{ fontFamily: fontFamilies.regular, paddingVertical: 0 }}
            />
            {query ? (
              <IconButton icon={X} accessibilityLabel={t('map.searchClear')} color="muk-soft" onPress={() => { setQuery(''); setPlacePin(null); }} />
            ) : null}
          </View>

          {showSearchPanel ? (
            <SearchPanel
              query={query}
              local={localResults}
              external={askedExternal ? external : { places: [], placesLoading: false, tour: [], tourLoading: false, tourAsked: false }}
              onPickLocal={pickLocal}
              onViewPlace={viewPlace}
              onOpenKakaoPlace={(item) => { if (item.placeUrl) void openExternalUrl(item.placeUrl); }}
              onRouteTour={(item) => {
                if (typeof item.mapy !== 'number' || typeof item.mapx !== 'number') return;
                void openWalkingDirections(
                  { name: item.title, latitude: item.mapy, longitude: item.mapx },
                  loc.known ? { latitude: userPoint.lat, longitude: userPoint.lng } : null,
                );
              }}
              onSeeInsteadPlace={(item) => {
                const known = facilities.find((f) => String(f.features?.kakaoPlaceId ?? f.features?.kakao_place_id ?? '') === String(item.placeId));
                const type = known?.type ?? item.type;
                if (!type) return;
                goInstead(known
                  ? { facilityId: known.id, type: known.type, latitude: known.latitude, longitude: known.longitude }
                  : { name: item.name, type, latitude: item.latitude, longitude: item.longitude });
              }}
            />
          ) : (
            <>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 6, alignItems: 'center' }}>
                <WeatherChip indoorRequired={indoor} onIndoorRequiredChange={toggleIndoor} />
                <FestivalChip location={userPoint} onFocus={onFestivalFocus} />
                <RestroomChip location={userPoint} />
                <CalmChip
                  facilities={facilities}
                  location={userPoint}
                  onFocus={(spot) => {
                    const f = byId.get(spot.id);
                    if (!f) return;
                    if (f.type !== category && (CATEGORIES as readonly string[]).includes(f.type)) selectCategory(f.type as PlaceCategory);
                    if (select(f, 'pin')) focusOn(f.latitude, f.longitude);
                  }}
                />
              </ScrollView>
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
              {category === 'restaurant' ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 6, alignItems: 'center' }}>
                  {CUISINE_CHIPS.map((chip) => {
                    const on = chip.id === cuisineId;
                    return (
                      <Pressable
                        key={chip.id}
                        accessibilityRole="button"
                        accessibilityLabel={t(`cuisine.${chip.id}`)}
                        accessibilityState={{ selected: on }}
                        hitSlop={CHIP_HIT_SLOP}
                        onPress={() => selectCuisine(chip)}
                        className={`min-h-[36px] shrink-0 flex-row items-center gap-[4px] rounded-full border px-[12px] py-[6px] ${on ? 'border-jade bg-jade-chip' : 'border-line bg-white'}`}
                      >
                        <Text className="text-[13px]" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{chip.emoji}</Text>
                        <Text className="text-[13px]" weight="semibold" numberOfLines={1}>{t(`cuisine.${chip.id}`)}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              ) : null}
            </>
          )}
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

      {/* 아래 — 배너 · 카드 자리 · 다른 칩 제안 */}
      <View
        pointerEvents="box-none"
        className="absolute inset-x-0 bottom-0 px-[12px]"
        style={{ paddingBottom: bottomInset, paddingLeft: insets.left + 12, paddingRight: insets.right + 12 }}
        onLayout={(e) => setBottomStackH(Math.round(e.nativeEvent.layout.height))}
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
          {!selected && suggestions.length > 0 ? (
            <View className="items-center gap-[8px] rounded-2xl border border-line bg-white p-[16px]" accessibilityLiveRegion="polite">
              <Text className="text-center text-[14px]" weight="semibold">{t('map.suggestTitle')}</Text>
              <View className="flex-row flex-wrap justify-center gap-[8px]">
                {suggestions.map((s) => (
                  <Pressable
                    key={s.type}
                    accessibilityRole="button"
                    onPress={() => selectCategory(s.type)}
                    className="min-h-[44px] justify-center rounded-full border border-jade/40 bg-jade/10 px-[14px]"
                  >
                    <Text className="text-[13px] text-jade" weight="bold">{t('map.suggestButton', { category: t(`category.${s.type}`), n: s.count })}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}
        </View>
      </View>

      {/* 진행 중 여행 · 방문 확인 — 웹 /main 모바일처럼 검색·칩 줄 아래에 얹는다. 두 카드는 늘 붙여 두고(답하던 단계·상황 변경
          입력이 사라지지 않게) pickTripOverlay 가 고른 하나만 보인다. 카드는 접은 판 없이 늘 같은 판이고, 남은 높이(maxHeight)
          안에서 위쪽부터 보이며 나머지는 스크롤된다. 이름 + 첫 행동 줄이 들어갈 자리도 없으면 감추기만 한다(display none). */}
      <View
        pointerEvents="box-none"
        className="absolute inset-x-0 px-[12px]"
        style={{ top: overlayTop, paddingLeft: insets.left + 12, paddingRight: insets.right + 12, display: tripHidden ? 'none' : 'flex' }}
        accessibilityElementsHidden={tripHidden}
        importantForAccessibility={tripHidden ? 'no-hide-descendants' : 'auto'}
      >
        <ScrollView
          ref={tripScrollRef}
          style={[overlayWidth, { maxHeight: tripScrollMaxHeight(tripRoom, tripRoomNoKeyboard, tripOverlay.card, tripTyping), flexGrow: 0 }]}
          keyboardShouldPersistTaps="handled"
          persistentScrollbar
        >
          <View ref={tripContentRef} collapsable={false}>
            <View style={{ display: tripOverlay.card === 'visit' ? 'flex' : 'none' }}>
              <VisitCheckCard
                onActiveChange={setVisitActive}
                onOpenCoupons={() => router.push('/mypage/coupons' as never)}
              />
            </View>
            <View style={{ display: tripOverlay.card === 'journey' ? 'flex' : 'none' }}>
              <ActiveJourneyCard
                location={userPoint}
                onActiveChange={setJourneyActive}
                onInputFocus={() => { tripInputFocusedRef.current = true; setTripTyping(true); later(revealFocusedInput, 350); }}
                onInputBlur={() => { tripInputFocusedRef.current = false; setTripTyping(false); }}
              />
            </View>
          </View>
        </ScrollView>
      </View>

      <RecommendationSheet
        selected={selectedCandidate}
        candidates={visibleRecs}
        excludedIds={excluded}
        status={status}
        onRetry={reload}
        travelContext={travelContext}
        onAccept={keepAfterAccept}
        onKeep={onKeep}
        onReject={onReject}
        onShowAlternatives={selected && canSeeInstead(selected.type) ? showAlternatives : undefined}
        onClose={closeSheet}
        onViewProfile={() => router.push('/mypage' as never)}
        onViewLab={() => router.push('/mypage/lab' as never)}
        onStateChange={setSheetState}
        onPeekHeightChange={setSheetPeekPx}
        maxWidth={HOME_PANEL_MAX_WIDTH}
      />

      <FilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        convenience={convenience}
        onToggle={toggleConvenience}
        showAccessible={accessibleAnywhere}
        showStroller={strollerAnywhere}
        showPet={petAnywhere}
        showCuisine={category === 'restaurant'}
        cuisineId={cuisineId}
        onSelectCuisine={selectCuisine}
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
