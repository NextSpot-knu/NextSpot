import { Navigation, RefreshCw } from 'lucide-react-native';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AppState,
  Keyboard,
  Platform,
  ScrollView,
  TextInput,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { Icon, Pressable, Text, cn, useReduceMotion } from '~/components/ui';
import { AiConsentNotice, canSendToAi, useAiConsent } from '~/features/aiConsent';
import { parseTravelContext, recommendByType, type PlaceCategory, type TravelContext } from '~/lib/core/apiClient';
import type { RequiredAttribute } from '~/lib/core/travelContextTypes';
import { queueRecommendationOutcome } from '~/lib/core/recommendationOutcomes';
import { haptic } from '~/lib/platform/haptics';
import { openDrivingDirections, openWalkingDirections } from '~/lib/platform/links';
import { track } from '~/lib/platform/analytics';
import { shadows, springs } from '~/lib/theme/tokens';
import { classifyReplanOutcome, replanNotice, type ReplanOutcome } from '@/lib/replanOutcome';

import { displayWalkMinutes } from './cardTimes';
import {
  REPLAN_ATTRIBUTES,
  REPLAN_AVAILABLE,
  REPLAN_CATEGORIES,
  REPLAN_RESPONSE_BUDGET_MS,
  REPLAN_WALKS,
  buildReplanContext,
  hasCondition,
  loadTravelContext,
  replanFacilityTypes,
  sortReplanCandidates,
  toggled,
  visibleTrip,
} from './journeyCore';
import {
  getActiveTrip,
  getVisitHistory,
  markTripArrivedIf,
  recordActiveTrip,
  tripEvents,
  type ActiveTrip,
} from './tripLoop';
import { useT } from '~/lib/i18n/I18nProvider';

/** 웹 backdrop-blur(8px) — 웹 빌드만. 네이티브는 흐림 없이 95% 흰색(D14, 안드로이드 RN 은 뒤 지도를 흐릴 수 없다). */
const WEB_BLUR = Platform.OS === 'web' ? ({ backdropFilter: 'blur(8px)' } as unknown as ViewStyle) : null;

export interface ActiveJourneyCardProps {
  /** 내 위치(없으면 이 카드는 재계획을 못 한다 — 길안내 다시 열기 · 도착은 그대로). 홈이 넘긴다. */
  location: { lat: number; lng: number };
  /** 위치·크기(홈이 지도 위에 띄운다) — 예: 'absolute left-4 right-4'. */
  className?: string;
  /** 위치를 계산값으로 줄 때(예: top: insets.top + 96) — 바깥 상자에 붙는다. */
  style?: StyleProp<ViewStyle>;
  /**
   * 카드 최대 높이(pt). 주면 카드 안이 스크롤된다(웹 `max-h-[calc(100dvh-7rem)] overflow-y-auto`).
   * 없으면 내용 높이 그대로 그린다(부르는 쪽이 스크롤을 맡는다).
   */
  maxHeight?: number;
  /** 도착을 눌렀다 — 방문 확인(VisitCheckCard)이 바로 이어진다. */
  onArrived?: () => void;
  /** 그릴 것이 생기거나 없어질 때(길안내 중 여정 · '아직 가는 중'으로 닫음) — 홈이 카드 자리를 고른다. */
  onActiveChange?: (active: boolean) => void;
  /** 이 카드 안 입력 칸에 초점이 갔다 — 홈이 스크롤 안에서 그 칸을 보이게 한다. */
  onInputFocus?: () => void;
  /** 그 입력 칸에서 초점이 떠났다. */
  onInputBlur?: () => void;
}


/** 웹 text-[11px] 은 줄 높이를 정하지 않아 본문 1.5 배를 물려받는다(16.5px). */
const LEADING_11 = 'leading-[16.5px]';

/**
 * 진행 중 여행 카드 — 도착했어요 · 아직 가는 중 · 상황 변경(자연어·칩으로 조건을 바꿔 다른 곳으로 갈아타기) · 길안내 다시 열기.
 * 웹 components/main/ActiveJourneyCard.tsx 가 기준이다(모양·순서·크기 — G3-28·29). 저장소·이벤트는 tripLoop, 판정은 journeyCore.
 * 자유 문장 해석(POST /travel-context/parse)은 서버가 외부 AI(Upstage)로 보낸다 — 외부 AI 전송을 허용했을 때만 입력 칸을 켠다
 * (App Store 5.1.2(i), features/aiConsent — 결정 D4 ①로 웹과 다르게 남긴다). 허용하지 않아도 칩으로 조건을 고르는 길은 그대로다.
 * '아직 가는 중'은 웹처럼 이 카드의 상태만 비운다(G3-32 나) — 앱이 앞으로 오거나 화면에 돌아오거나 길안내가 다시 시작되면 다시 뜬다.
 */
export function ActiveJourneyCard({
  location,
  className,
  style,
  maxHeight,
  onArrived,
  onActiveChange,
  onInputFocus,
  onInputBlur,
}: ActiveJourneyCardProps) {
  const t = useT();
  const reduceMotion = useReduceMotion();
  const [trip, setTrip] = useState<ActiveTrip | null>(null);
  const [busy, setBusy] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeText, setChangeText] = useState('');
  const [draft, setDraft] = useState<Partial<TravelContext> | null>(null);
  const [parseError, setParseError] = useState(false);
  const [outcome, setOutcome] = useState<ReplanOutcome | null>(null);
  // 재시도는 같은 조건으로 — 실패한 시도가 draft 였는지 현재 여정 조건이었는지 기억한다(웹과 같다).
  const lastContext = useRef<Partial<TravelContext> | undefined>(undefined);
  // 상황 변경 입력 칸이 초점을 가진 채 사라지면(닫기 · 갈아타기 성공 · 도착 · 아직 가는 중) onBlur 가 오지 않을 수 있다 —
  // 홈이 '쓰는 중' 으로 남지 않게 직접 알린다.
  const inputFocused = useRef(false);
  const onInputBlurRef = useRef(onInputBlur);
  onInputBlurRef.current = onInputBlur;
  const releaseInput = useCallback(() => {
    if (!inputFocused.current) return;
    inputFocused.current = false;
    onInputBlurRef.current?.();
  }, []);
  useEffect(() => {
    if (!changeOpen || !trip || trip.status === 'arrived') releaseInput();
  }, [changeOpen, trip, releaseInput]);
  useEffect(() => releaseInput, [releaseInput]);
  const { allowed: aiAllowed } = useAiConsent();

  // 다시 읽는 때: 앱이 앞으로 올 때 · 화면에 돌아올 때 · 길안내 시작 · 도착 · 방문 확인으로 여정이 끝남(trip-cleared).
  // 방문 확인을 끝까지 마치면 저장소의 여정이 지워지는데, 이 카드가 옛 여정을 들고 있으면 홈에 다시 뜨고 '도착했어요'가
  // 결과 보고를 두 번 보냈다. '아직 가는 중'으로 비운 여정도 여기서 다시 읽혀 돌아온다(웹 규칙).
  // 웹 ActiveJourneyCard 처럼 다시 읽을 때마다(첫 표시 · 앱이 앞으로 · 화면 복귀 · 길안내 시작) 진행 중이면 trip_resumed 를 보낸다
  // (웹은 visibilitychange 마다). 도착·여정 끝으로 다시 읽을 때는 세지 않는다(웹에 없는 계기).
  const sync = useCallback((countResume = true) => {
    const active = visibleTrip(getActiveTrip());
    setTrip(active);
    if (active && countResume) track('trip_resumed', { facility_type: active.type });
  }, []);
  useEffect(() => {
    // 첫 표시의 trip_resumed 는 바로 뒤 useFocusEffect 가 한 번 보낸다(두 번 세지 않게).
    sync(false);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && sync());
    const quiet = () => sync(false);
    const offs = [
      tripEvents.on('trip-navigating', () => sync()),
      tripEvents.on('trip-arrived', quiet),
      tripEvents.on('trip-cleared', quiet),
    ];
    return () => {
      sub.remove();
      offs.forEach((off) => off());
    };
  }, [sync]);
  useFocusEffect(useCallback(() => sync(), [sync]));

  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;
  const isActive = trip !== null && trip.status !== 'arrived';
  useEffect(() => {
    onActiveChangeRef.current?.(isActive);
  }, [isActive]);

  // 등장 — 웹 initial {opacity 0, y −12, scale .98} → sheetSpring. 동작 줄이기면 바로 보인다.
  const enter = useSharedValue(0);
  useEffect(() => {
    if (!isActive) {
      enter.value = 0;
      return;
    }
    enter.value = reduceMotion ? 1 : withSpring(1, springs.sheet);
  }, [isActive, reduceMotion, enter]);
  const enterStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, enter.value),
    transform: [{ translateY: -12 * (1 - enter.value) }, { scale: 0.98 + 0.02 * enter.value }],
  }));

  // 상황 변경 펼침 — 웹 height 0 → auto · opacity · y −8(interactionSpring). 닫을 때도 접은 뒤에 내린다.
  const [panelShown, setPanelShown] = useState(false);
  const panel = useSharedValue(0);
  const panelH = useSharedValue(0);
  useEffect(() => {
    if (changeOpen) {
      setPanelShown(true);
      panel.value = reduceMotion ? 1 : withSpring(1, springs.interaction);
      return;
    }
    if (reduceMotion) {
      panel.value = 0;
      setPanelShown(false);
      return;
    }
    panel.value = withSpring(0, { ...springs.interaction, overshootClamping: true }, (finished) => {
      if (finished) runOnJS(setPanelShown)(false);
    });
  }, [changeOpen, reduceMotion, panel]);
  const panelStyle = useAnimatedStyle(() => ({
    height: panelH.value * Math.max(0, panel.value),
    opacity: Math.min(1, Math.max(0, panel.value)),
  }));
  const panelInnerStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -8 * (1 - panel.value) }] }));
  const onPanelLayout = useCallback((e: LayoutChangeEvent) => {
    panelH.value = e.nativeEvent.layout.height;
  }, [panelH]);

  // 카드 안 스크롤(maxHeight 를 받았을 때) — 입력 칸에 초점이 가면 그 칸이 보이게 올린다.
  const scrollRef = useRef<ScrollView>(null);
  const scrollContentRef = useRef<View>(null);
  const inputRef = useRef<TextInput>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
  }, []);
  const revealInput = useCallback(() => {
    if (maxHeight == null) return;
    if (revealTimer.current) clearTimeout(revealTimer.current);
    // 키보드가 올라와 홈이 줄어든 뒤에 잰다.
    revealTimer.current = setTimeout(() => {
      const input = inputRef.current;
      const content = scrollContentRef.current;
      if (!input || !content) return;
      input.measureLayout(content, (_x, y) => scrollRef.current?.scrollTo({ y: Math.max(0, y - 12), animated: true }), () => undefined);
    }, 350);
  }, [maxHeight]);

  const arrived = useCallback(() => {
    if (!trip) return;
    // 저장소의 여정이 이 카드의 여정일 때만 — 이미 끝났거나 바뀌었으면 결과 보고 없이 다시 읽는다.
    if (!markTripArrivedIf(trip)) {
      sync(false);
      return;
    }
    haptic('success');
    queueRecommendationOutcome(trip.recommendationId, 'arrival_confirmed');
    track('arrival_confirmed', { facility_type: trip.type });
    tripEvents.emit('trip-arrived', undefined);
    setTrip(null);
    onArrived?.();
  }, [trip, onArrived, sync]);

  if (!trip || trip.status === 'arrived') return null;

  const parseChange = async () => {
    if (!changeText.trim() || busy) return;
    if (!canSendToAi()) return; // 허용 전에는 문장을 보내지 않는다(버튼도 꺼져 있다)
    setBusy(true);
    setOutcome(null);
    setParseError(false);
    try {
      const result = await parseTravelContext(changeText.trim());
      setDraft(result.context as Partial<TravelContext>);
      setParseError(Object.keys(result.context).length === 0);
    } catch {
      setDraft({});
      setParseError(true);
    } finally {
      setBusy(false);
    }
  };

  const replan = async (confirmed?: Partial<TravelContext>) => {
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    lastContext.current = confirmed;
    track('replan_requested', { facility_type: trip.type });
    if (confirmed) {
      track('context_applied', {
        categories: confirmed.categories ?? [],
        max_walk_minutes: confirmed.maxWalkMinutes ?? null,
        available_minutes: confirmed.availableMinutes ?? null,
        required_attributes: confirmed.requiredAttributes ?? [],
        exclude_visited: confirmed.excludeVisited ?? false,
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const base = (trip.context as unknown as TravelContext | undefined) ?? loadTravelContext();
      const context = buildReplanContext(base, confirmed, getVisitHistory().map((e) => e.facilityId));
      // 예산 초과를 '빈 배열' 로 표현하지 않는다 — 표식을 따로 돌려줘 '없다' 와 '아직 모른다' 를 가른다(replanOutcome).
      // 갈아타기는 카드를 보여 주지 않고 곧바로 길안내를 연다 — 약한 영업 근거 채우기를 끄고(마지막 인자 false) 등급을 먼저 비교한다.
      const raced = await Promise.race([
        Promise.all(
          replanFacilityTypes(context, trip.type).map((type) =>
            recommendByType(type, location, [trip.facilityId], 1, context, undefined, undefined, undefined, undefined, false),
          ),
        ).then((batches) => ({ batches })),
        new Promise<{ overBudget: true }>((resolve) => {
          timer = setTimeout(() => resolve({ overBudget: true }), REPLAN_RESPONSE_BUDGET_MS);
        }),
      ]);
      const timedOut = 'overBudget' in raced;
      const candidates = timedOut ? [] : sortReplanCandidates(raced.batches.flat());
      const next = candidates[0];
      if (!next) {
        // 진행 중인 여정은 어떤 경우에도 지우지 않는다. 다만 왜 못 갈아탔는지는 구분해서 말한다.
        setOutcome(classifyReplanOutcome({ timedOut, candidateCount: candidates.length }));
        return;
      }
      const mode = trip.navigationMode ?? 'walk';
      recordActiveTrip(next.facility, {
        recommendationId: next.recommendationId,
        walkMinutes: next.breakdown.travelTime,
        context: context as unknown as Record<string, unknown>,
        navigationMode: mode,
      });
      setTrip(getActiveTrip());
      setChangeOpen(false);
      setDraft(null);
      setChangeText('');
      const dest = { name: next.facility.name, latitude: next.facility.latitude, longitude: next.facility.longitude };
      if (mode === 'car') void openDrivingDirections(dest);
      else void openWalkingDirections(dest);
      track('navigation_started', { facility_type: next.facility.type, navigation_mode: mode, walk_minutes: next.breakdown.travelTime });
      queueRecommendationOutcome(next.recommendationId, 'navigation_started');
    } catch {
      // 호출 자체가 실패했다 — 조건 문제가 아니므로 재시도 길을 준다.
      setOutcome('failed');
    } finally {
      if (timer) clearTimeout(timer);
      setBusy(false);
    }
  };

  const update = (fn: (c: Partial<TravelContext>) => Partial<TravelContext>) => {
    setParseError(false);
    setDraft((c) => fn(c ?? {}));
  };
  const notice = outcome ? replanNotice(outcome) : null;
  const car = trip.navigationMode === 'car';
  const confirmLabel = busy ? t('common.loading') : t('trip.confirmContext');
  const parseDisabled = busy || !aiAllowed || !changeText.trim();
  const draftReplanDisabled = busy || !hasCondition(draft);

  const resume = () => {
    if (trip.lat == null || trip.lng == null) return;
    const dest = { name: trip.name, latitude: trip.lat, longitude: trip.lng };
    if (car) void openDrivingDirections(dest);
    else void openWalkingDirections(dest);
    track('navigation_started', { facility_type: trip.type, navigation_mode: trip.navigationMode ?? 'walk', walk_minutes: trip.walkMinutes ?? null });
    queueRecommendationOutcome(trip.recommendationId, 'navigation_started');
  };

  // 웹 순서: 활성 여정 → 이름 → 도보/자동차 → 3칸 버튼 → (상황 변경) → 길안내 다시 열기.
  const body = (
    <>
      <Text className="text-[12px] leading-[16px] text-jade" weight="bold">{t('trip.active')}</Text>
      <Text className="mt-[4px] text-[16px] leading-[24px]" weight="bold" numberOfLines={1}>{t('trip.heading', { name: trip.name })}</Text>
      {!car && trip.walkMinutes != null && (
        <Text className="mt-[2px] text-[12px] leading-[16px] text-muk-soft">{t('trip.walkEstimate', { n: displayWalkMinutes(trip.walkMinutes) })}</Text>
      )}
      {car && <Text className="mt-[2px] text-[12px] leading-[16px] text-muk-soft">{t('trip.driveBasisHint')}</Text>}

      {/* 웹 grid-cols-3 gap-2 mt-3 · rounded-xl py-2 — 보이는 높이 약 34, 탭 영역은 hitSlop 으로 44. */}
      <View className="mt-[12px] flex-row gap-[8px]">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('trip.arrived')}
          onPress={arrived}
          hitSlop={ROW_SLOP}
          className="flex-1 items-center justify-center rounded-xl bg-jade px-[4px] py-[8px]"
        >
          <Text className="text-center text-[12px] leading-[16px] text-white" weight="bold">{t('trip.arrived')}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('trip.stillGoing')}
          onPress={() => { haptic('selection'); Keyboard.dismiss(); setTrip(null); }}
          hitSlop={ROW_SLOP}
          className="flex-1 items-center justify-center rounded-xl border border-line px-[4px] py-[8px]"
        >
          <Text className="text-center text-[12px] leading-[16px]" weight="bold">{t('trip.stillGoing')}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('trip.changed')}
          accessibilityState={{ disabled: busy, expanded: changeOpen }}
          disabled={busy}
          onPress={() => { haptic('selection'); setChangeOpen(true); setDraft({}); setParseError(false); }}
          hitSlop={ROW_SLOP}
          className="flex-1 flex-row items-center justify-center gap-[4px] rounded-xl border border-gold/40 bg-gold/10 px-[4px] py-[8px]"
        >
          <Icon icon={RefreshCw} size={12} />
          <Text className="text-center text-[12px] leading-[16px]" weight="bold">{t('trip.changed')}</Text>
        </Pressable>
      </View>

      {panelShown && (
        <Animated.View style={[{ overflow: 'hidden' }, panelStyle]}>
          {/* 안쪽은 자기 높이대로 그려지고(onLayout 으로 잰다) 바깥이 그 높이까지 펼친다. */}
          <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0 }, panelInnerStyle]}>
            {/* onLayout 높이는 margin 을 빼므로 위 간격(웹 mt-3)은 바깥 padding 으로 잰다. */}
            <View onLayout={onPanelLayout} className="pt-[12px]">
            <View className="border-t border-line pt-[12px]">
              <Text className="text-[12px] leading-[16px]" weight="bold">{t('trip.changeTitle')}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={confirmLabel}
                accessibilityState={{ disabled: busy, busy }}
                disabled={busy}
                onPress={() => void replan()}
                hitSlop={ROW_SLOP}
                className={cn('mt-[8px] items-center justify-center rounded-xl bg-jade py-[8px]', busy && 'opacity-50')}
              >
                <Text className="text-[12px] leading-[16px] text-white" weight="bold">{confirmLabel}</Text>
              </Pressable>
              {notice && (
                <View accessibilityLiveRegion="polite" className="mt-[8px] rounded-xl bg-terracotta/10 px-[12px] py-[8px]">
                  <Text className="text-[12px] leading-[16px] text-terracotta">{t(notice.messageKey)}</Text>
                  {/* 장애일 때만 재시도를 준다. 0건은 다시 눌러도 같은 답이라 조건을 바꾸는 쪽이 맞다. */}
                  {notice.retryable && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('common.retry')}
                      accessibilityState={{ disabled: busy, busy }}
                      disabled={busy}
                      onPress={() => { haptic('selection'); void replan(lastContext.current); }}
                      hitSlop={RETRY_SLOP}
                      className={cn('mt-[6px] items-center justify-center rounded-lg border border-terracotta/40 py-[6px]', busy && 'opacity-50')}
                    >
                      <Text className="text-[12px] leading-[16px] text-terracotta" weight="bold">{busy ? t('common.loading') : t('common.retry')}</Text>
                    </Pressable>
                  )}
                </View>
              )}
              <AiConsentNotice className="mt-[8px]" />
              <TextInput
                ref={inputRef}
                accessibilityLabel={t('trip.changeTitle')}
                accessibilityState={{ disabled: !aiAllowed }}
                editable={aiAllowed}
                maxLength={300}
                multiline
                textAlignVertical="top"
                value={changeText}
                onChangeText={setChangeText}
                onFocus={() => { inputFocused.current = true; onInputFocus?.(); revealInput(); }}
                onBlur={releaseInput}
                placeholder={t('trip.changePlaceholder')}
                placeholderTextColor="#8a7f78"
                className={aiAllowed
                  ? 'mt-[8px] min-h-[64px] rounded-xl border border-line px-[12px] py-[8px] text-[12px] leading-[16px] text-muk'
                  : 'mt-[8px] min-h-[64px] rounded-xl border border-line bg-hanji-deep px-[12px] py-[8px] text-[12px] leading-[16px] text-muk-soft'}
                maxFontSizeMultiplier={1.6}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={busy ? t('trip.parsing') : t('trip.parse')}
                accessibilityState={{ disabled: parseDisabled, busy }}
                disabled={parseDisabled}
                onPress={() => void parseChange()}
                hitSlop={ROW_SLOP}
                className={cn('mt-[8px] items-center justify-center rounded-xl border border-jade/30 bg-jade/5 py-[8px]', parseDisabled && 'opacity-50')}
              >
                <Text className="text-[12px] leading-[16px] text-jade" weight="bold">{busy ? t('trip.parsing') : t('trip.parse')}</Text>
              </Pressable>
              {draft && (
                <View className="mt-[8px]">
                  <Text className={cn('text-[11px] text-muk-soft', LEADING_11)}>{parseError ? t('trip.noContext') : t('trip.manualHint')}</Text>
                  <View className="mt-[8px] flex-row flex-wrap gap-[6px]">
                    {REPLAN_CATEGORIES.map((c: PlaceCategory) => (
                      <ChoiceChip key={c} active={draft.categories?.includes(c) ?? false} onPress={() => update((d) => ({ ...d, categories: toggled(d.categories, c) }))}>
                        {t(`category.${c}`)}
                      </ChoiceChip>
                    ))}
                  </View>
                  <View className="mt-[8px] flex-row flex-wrap gap-[6px]">
                    {REPLAN_WALKS.map((m) => (
                      <ChoiceChip key={m} active={draft.maxWalkMinutes === m} onPress={() => update((d) => ({ ...d, maxWalkMinutes: m }))}>
                        {t('trip.walkChip', { n: m })}
                      </ChoiceChip>
                    ))}
                  </View>
                  <View className="mt-[8px] flex-row flex-wrap gap-[6px]">
                    {REPLAN_AVAILABLE.map((m) => (
                      <ChoiceChip key={m} active={draft.availableMinutes === m} onPress={() => update((d) => ({ ...d, availableMinutes: m }))}>
                        {m === 120 ? t('setup.twoHoursPlus') : t('trip.availableChip', { n: m })}
                      </ChoiceChip>
                    ))}
                  </View>
                  <View className="mt-[8px] flex-row flex-wrap gap-[6px]">
                    {REPLAN_ATTRIBUTES.map((a: RequiredAttribute) => (
                      <ChoiceChip key={a} active={draft.requiredAttributes?.includes(a) ?? false} onPress={() => update((d) => ({ ...d, requiredAttributes: toggled(d.requiredAttributes, a) }))}>
                        {t(`trip.attribute.${a}`)}
                      </ChoiceChip>
                    ))}
                    <ChoiceChip active={draft.excludeVisited === true} onPress={() => update((d) => ({ ...d, excludeVisited: !d.excludeVisited }))}>
                      {t('setup.excludeVisited')}
                    </ChoiceChip>
                  </View>
                  <View className="mt-[8px] flex-row gap-[8px]">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('common.cancel')}
                      onPress={() => { haptic('selection'); Keyboard.dismiss(); setChangeOpen(false); }}
                      hitSlop={ROW_SLOP}
                      className="flex-1 items-center justify-center rounded-xl border border-line py-[8px]"
                    >
                      <Text className="text-[12px] leading-[16px]" weight="bold">{t('common.cancel')}</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={confirmLabel}
                      accessibilityState={{ disabled: draftReplanDisabled, busy }}
                      disabled={draftReplanDisabled}
                      onPress={() => void replan(draft)}
                      hitSlop={ROW_SLOP}
                      className={cn('flex-1 items-center justify-center rounded-xl bg-jade py-[8px]', draftReplanDisabled && 'opacity-50')}
                    >
                      <Text className="text-center text-[12px] leading-[16px] text-white" weight="bold">{confirmLabel}</Text>
                    </Pressable>
                  </View>
                </View>
              )}
            </View>
            </View>
          </Animated.View>
        </Animated.View>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(car ? 'trip.resumeDriving' : 'trip.resumeDirections')}
        onPress={resume}
        hitSlop={RESUME_SLOP}
        className="mt-[8px] flex-row items-center justify-center gap-[4px]"
      >
        <Icon icon={Navigation} size={12} color="gold-deep" />
        <Text className="text-[12px] leading-[16px] text-gold-deep" weight="bold">{t(car ? 'trip.resumeDriving' : 'trip.resumeDirections')}</Text>
      </Pressable>
    </>
  );

  // 틀: 웹 rounded-2xl border-jade/30 bg-white/95 backdrop-blur p-4 toss-surface(G3-28). 바깥(className·style)은 홈이 자리를 정한다.
  return (
    <View className={className} style={style}>
      <Animated.View style={enterStyle}>
        <View
          accessibilityLabel={t('trip.active')}
          className="rounded-2xl border border-jade/30 bg-white/95"
          style={[{ boxShadow: shadows.surface }, WEB_BLUR]}
        >
          {maxHeight != null ? (
            <ScrollView
              ref={scrollRef}
              style={{ maxHeight: Math.max(0, maxHeight - 2), flexGrow: 0 }}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              showsVerticalScrollIndicator={false}
            >
              <View ref={scrollContentRef} className="p-[16px]">{body}</View>
            </ScrollView>
          ) : (
            <View className="p-[16px]">{body}</View>
          )}
        </View>
      </Animated.View>
    </View>
  );
}

/** 3칸 버튼 등 32~34pt 버튼의 탭 영역을 44 로(위아래만 — 옆 버튼과 겹치지 않게). */
const ROW_SLOP = { top: 5, bottom: 5, left: 0, right: 0 };
/** 재시도(약 30pt). */
const RETRY_SLOP = { top: 7, bottom: 7, left: 0, right: 0 };
/** 길안내 다시 열기 — 글자 한 줄(16pt). */
const RESUME_SLOP = { top: 14, bottom: 14, left: 12, right: 12 };
/** 칩(약 27pt) — 줄 사이 간격이 6~8 이라 44 까지 채우면 이웃 줄과 크게 겹친다. 반쯤만 넓힌다. */
const CHIP_SLOP = { top: 6, bottom: 6, left: 2, right: 2 };

/** 상황 변경 칩 — 웹 ActiveJourneyCard 의 ChoiceChip 값 그대로(공용 Chip 과 크기·색이 달라 카드 안에만 둔다). */
function ChoiceChip({ active, onPress, children }: { active: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={() => { haptic('selection'); onPress(); }}
      hitSlop={CHIP_SLOP}
      className={active
        ? 'rounded-full border border-jade bg-jade/10 px-[10px] py-[4px]'
        : 'rounded-full border border-line bg-white px-[10px] py-[4px]'}
    >
      <Text className={cn('text-[11px]', LEADING_11, active ? 'text-jade' : 'text-muk-soft')} weight="semibold">{children}</Text>
    </Pressable>
  );
}
