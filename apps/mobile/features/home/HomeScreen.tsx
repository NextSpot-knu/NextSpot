// 홈(지도) 화면 — 웹 /main(apps/web/app/main/page.tsx, 기준 커밋 0d145a1)의 앱판.
//
// 뺀 것(계획 §3.1): 음성 비서 · 히트맵 · 혼잡 예측 띠/가정 시각 · 데모 조작 패널 · 지역 전환(내부 계정) · 주차장 탭 ·
//   경주 테마(✨) · 적재 요청 UI. 추천 카드 시트·진행 중 여행·방문 확인·혼잡 제보는 features/recommendation-card 의 것을 그대로 올린다
//   (rec_* 이용 이벤트는 시트가 직접 보낸다 — 홈은 보내지 않는다). 시트에 넘길 값은 sheetModel.ts 의 순수 함수가 만든다.
// 흐름: 시설 로드(/infrastructures) → 칩의 종류로 서버 추천(by-type) → 1위를 카드 자리에 연다 → 핀·검색으로 직접 고르면
//   그 장소가 '선택한 장소'. 핀 겹침은 지도가 알려 준 영역으로 declutterPins.
import { useRouter } from 'expo-router';
import { Search, SlidersHorizontal, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, ScrollView, TextInput, View } from 'react-native';
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
import { recommendByType, type RecommendationResponse } from '~/lib/core/apiClient';
import { useBusyThreshold } from '~/lib/core/publicSettings';
import { isStrollerFriendly } from '~/lib/core/strollerSupport';
import { useT } from '~/lib/i18n/I18nProvider';
import { haptic } from '~/lib/platform/haptics';
import { openExternalUrl, openWalkingDirections } from '~/lib/platform/links';
import { track } from '~/lib/platform/analytics';
import { CONTENT_MAX_WIDTH, colors, fontFamilies } from '~/lib/theme/tokens';

import { FilterSheet, GroupSheet, LocationBanner, LocationPrimer, SearchPanel } from './HomeOverlays';
import {
  applyConvenience,
  buildInsteadHref,
  buildPinMarkers,
  CATEGORIES,
  canSeeInstead,
  CUISINE_CHIPS,
  distanceM,
  festivalFocus,
  hasAnyConvenience,
  homeTravelContext,
  isAccessible,
  matchesCuisineChip,
  NO_CONVENIENCE,
  orderForPins,
  petDataExists,
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
  type SheetHeightState,
} from './sheetModel';
import { CalmChip, FestivalChip, RestroomChip, WeatherChip, type FestivalEvent } from './ToolChips';
import { useFacilities } from './useFacilities';
import { usePlaceSearch, type PlaceSearchItem, type TourApiSearchItem } from './usePlaceSearch';
import { useUserLocation } from './useUserLocation';

const OUT_OF_REGION_NOTICE_KEY = 'nextspot_out_of_region_notice';
const RECOMMENDATION_TIMEOUT_MS = 20_000;
const LOCAL_RESULT_LIMIT = 8;
const SLOT_FALLBACK_HEIGHT = 150;

type Selection = { id: string; kind: PickKind };
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

  const [category, setCategory] = useState<PlaceCategory>('restaurant');
  const [query, setQuery] = useState('');
  const [panelOpen, setPanelOpen] = useState(true);
  const [convenience, setConvenience] = useState<Convenience>(NO_CONVENIENCE);
  const [indoor, setIndoor] = useState(false);
  const [cuisineId, setCuisineId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [recs, setRecs] = useState<RecommendationResponse[] | null>(null);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [activeGroup, setActiveGroup] = useState<PinCluster<HomeFacility> | null>(null);
  const [festival, setFestival] = useState<FestivalFocus | null>(null);
  const [placePin, setPlacePin] = useState<PlacePin | null>(null);
  const [viewport, setViewport] = useState<MapViewport | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [headerH, setHeaderH] = useState(160);
  const [sheetState, setSheetState] = useState<SheetHeightState | null>(null);
  const [containerH, setContainerH] = useState(0);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // 사용자가 이 칩에서 직접 고른 카드가 있으면 추천 1위가 늦게 와도 덮지 않는다(웹 userPickRef).
  const pickedRef = useRef(false);
  const facilitiesRef = useRef(facilities);
  facilitiesRef.current = facilities;
  const excludedRef = useRef(excluded);
  excludedRef.current = excluded;

  const byId = useMemo(() => new Map(facilities.map((f) => [f.id, f])), [facilities]);
  const hasFacilities = facilities.length > 0;

  // ── 카메라 ───────────────────────────────────────────────────────────
  // 지도 가려진 띠 = 시트 높이(시트가 알려 주는 3단 상태 × 화면 높이). 시트가 없으면 작은 여백만.
  const searching = query.trim() !== '';
  const status = sheetStatus({ hasFacilities, recsLoaded: recs !== null, hasSelection: selection !== null, searching });
  const sheetShown = selection !== null || status === 'loading';
  const bottomInset = mapBottomInset(sheetShown ? sheetState : null, containerH, SLOT_FALLBACK_HEIGHT);
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
  useEffect(() => {
    if (!hasFacilities) return;
    let cancelled = false;
    const controller = new AbortController();
    setRecs(null);
    const context = homeTravelContext(convenience, indoor, category);
    (async () => {
      try {
        const res = await recommendByType(category, userPoint, [], 5, context, null, controller.signal, RECOMMENDATION_TIMEOUT_MS);
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
  }, [hasFacilities, category, userKey, convenience.accessible, convenience.stroller, indoor]);

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

  /** 시트가 킵·거절을 처리한 뒤 — 그 장소는 목록·핀 순위에서 빼고, 시트가 알려 준 다음 후보로 넘어간다(없으면 접는다). */
  const moveToNext = useCallback((done: SheetCandidate, next: SheetCandidate | null) => {
    setExcluded((prev) => new Set(prev).add(done.facility.id));
    pickedRef.current = false;
    const facility = next ? byId.get(next.facility.id) : undefined;
    if (facility) { setSelection({ id: facility.id, kind: 'recommended' }); focusOn(facility.latitude, facility.longitude); }
    else setSelection(null);
  }, [byId, focusOn]);

  const closeSheet = useCallback(() => { setSelection(null); pickedRef.current = false; }, []);
  const showAlternatives = useCallback((c: SheetCandidate) => {
    goInstead({ facilityId: c.facility.id, type: c.facility.type, latitude: c.facility.latitude, longitude: c.facility.longitude });
  }, [goInstead]);
  const travelContext = useMemo(() => homeTravelContext(convenience, indoor, category), [convenience, indoor, category]);
  const selectedCandidate = useMemo(
    () => (selected && selection ? buildSelectedCandidate(selected, selection.kind, visibleRecs) : null),
    [selected, selection, visibleRecs],
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

  const overlayWidth = { width: '100%' as const, maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' as const };

  return (
    <View className="flex-1 bg-hanji" onLayout={(e) => setContainerH(Math.round(e.nativeEvent.layout.height))}>
      <NextSpotMap
        ref={mapRef}
        style={{ flex: 1 }}
        markers={markers}
        circles={festival?.circles}
        userLocation={{ latitude: userPoint.lat, longitude: userPoint.lng, variant: 'halo' }}
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
                        accessibilityState={{ selected: on }}
                        onPress={() => selectCuisine(chip)}
                        className={`min-h-[36px] shrink-0 flex-row items-center gap-[4px] rounded-full border px-[12px] py-[6px] ${on ? 'border-jade bg-jade-chip' : 'border-line bg-white'}`}
                      >
                        <Text className="text-[13px]" accessibilityElementsHidden>{chip.emoji}</Text>
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
      >
        <View pointerEvents="box-none" style={overlayWidth} className="gap-[8px]">
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

      {/* 진행 중 여행 · 방문 확인 — 웹 /main 모바일처럼 검색·칩 줄 아래에 얹는다(둘 다 없으면 아무것도 그리지 않는다). */}
      <View
        pointerEvents="box-none"
        className="absolute inset-x-0 px-[12px]"
        style={{ top: headerH + 8, paddingLeft: insets.left + 12, paddingRight: insets.right + 12 }}
      >
        <View pointerEvents="box-none" style={overlayWidth} className="gap-[8px]">
          <ActiveJourneyCard location={userPoint} />
          <VisitCheckCard onOpenCoupons={() => router.push('/mypage/coupons' as never)} />
        </View>
      </View>

      <RecommendationSheet
        selected={selectedCandidate}
        candidates={visibleRecs}
        excludedIds={excluded}
        status={status}
        onRetry={reload}
        travelContext={travelContext}
        onAccept={closeSheet}
        onKeep={moveToNext}
        onReject={moveToNext}
        onShowAlternatives={selected && canSeeInstead(selected.type) ? showAlternatives : undefined}
        onClose={closeSheet}
        onViewProfile={() => router.push('/mypage' as never)}
        onViewLab={() => router.push('/mypage/lab' as never)}
        onStateChange={setSheetState}
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
