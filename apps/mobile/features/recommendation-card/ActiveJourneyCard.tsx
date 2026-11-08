import { Navigation, RefreshCw, X } from 'lucide-react-native';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Keyboard, TextInput, View } from 'react-native';

import { Button, Card, Chip, Icon, IconButton, Pressable, Text } from '~/components/ui';
import { AiConsentNotice, canSendToAi, useAiConsent } from '~/features/aiConsent';
import { parseTravelContext, recommendByType, type PlaceCategory, type TravelContext } from '~/lib/core/apiClient';
import type { RequiredAttribute } from '~/lib/core/travelContextTypes';
import { queueRecommendationOutcome } from '~/lib/core/recommendationOutcomes';
import { haptic } from '~/lib/platform/haptics';
import { openDrivingDirections, openWalkingDirections } from '~/lib/platform/links';
import { track } from '~/lib/platform/analytics';
import { classifyReplanOutcome, replanNotice, type ReplanOutcome } from '@/lib/replanOutcome';

import { displayWalkMinutes } from './cardTimes';
import {
  REPLAN_ATTRIBUTES,
  REPLAN_AVAILABLE,
  REPLAN_CATEGORIES,
  REPLAN_RESPONSE_BUDGET_MS,
  REPLAN_WALKS,
  buildReplanContext,
  firstSighting,
  hasCondition,
  loadTravelContext,
  replanFacilityTypes,
  sortReplanCandidates,
  toggled,
  tripKey,
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

export interface ActiveJourneyCardProps {
  /** 내 위치(없으면 이 카드는 재계획을 못 한다 — 길안내 다시 열기 · 도착은 그대로). 홈이 넘긴다. */
  location: { lat: number; lng: number };
  /** 위치·크기(홈이 지도 위에 띄운다) — 예: 'absolute left-4 right-4 top-24'. */
  className?: string;
  /** 도착을 눌렀다 — 방문 확인(VisitCheckCard)이 바로 이어진다. */
  onArrived?: () => void;
  /** 그릴 것이 생기거나 없어질 때(길안내 중 여정 · '아직 가는 중'으로 닫음) — 홈이 카드 자리를 고른다. */
  onActiveChange?: (active: boolean) => void;
  /** 이 카드 안 입력 칸에 초점이 갔다 — 홈이 스크롤 안에서 그 칸을 보이게 한다. */
  onInputFocus?: () => void;
  /** 그 입력 칸에서 초점이 떠났다. */
  onInputBlur?: () => void;
}

/** 이번 앱 실행에서 'trip_resumed' 를 이미 보낸 여정(tripKey). 카드를 다시 붙여도 여정마다 한 번만 보낸다. */
const resumedTrips = new Set<string>();
/** 이번 앱 실행에서 '아직 가는 중'으로 닫은 여정(tripKey) — 다시 읽어도 그 여정은 띄우지 않는다. */
const hiddenTrips = new Set<string>();

/**
 * 진행 중 여행 카드 — 도착했어요 · 아직 가는 중 · 상황 변경(자연어·칩으로 조건을 바꿔 다른 곳으로 갈아타기) · 길안내 다시 열기.
 * 웹 components/main/ActiveJourneyCard.tsx(기준 커밋 0d145a1). 저장소·이벤트는 tripLoop, 판정은 journeyCore.
 * 자유 문장 해석(POST /travel-context/parse)은 서버가 외부 AI(Upstage)로 보낸다 — 외부 AI 전송을 허용했을 때만 입력 칸을 켠다
 * (App Store 5.1.2(i), features/aiConsent). 허용하지 않아도 칩으로 조건을 고르는 길은 그대로다.
 */
export function ActiveJourneyCard({ location, className, onArrived, onActiveChange, onInputFocus, onInputBlur }: ActiveJourneyCardProps) {
  const t = useT();
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
  // 결과 보고를 두 번 보냈다.
  const sync = useCallback(() => {
    const active = visibleTrip(getActiveTrip(), hiddenTrips);
    setTrip(active);
    if (active && firstSighting(resumedTrips, tripKey(active))) track('trip_resumed', { facility_type: active.type });
  }, []);
  useEffect(() => {
    sync();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && sync());
    const offs = [
      tripEvents.on('trip-navigating', sync),
      tripEvents.on('trip-arrived', sync),
      tripEvents.on('trip-cleared', sync),
    ];
    return () => {
      sub.remove();
      offs.forEach((off) => off());
    };
  }, [sync]);
  useFocusEffect(sync);

  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;
  const isActive = trip !== null && trip.status !== 'arrived';
  useEffect(() => {
    onActiveChangeRef.current?.(isActive);
  }, [isActive]);

  const arrived = useCallback(() => {
    if (!trip) return;
    // 저장소의 여정이 이 카드의 여정일 때만 — 이미 끝났거나 바뀌었으면 결과 보고 없이 다시 읽는다.
    if (!markTripArrivedIf(trip)) {
      sync();
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

  const resume = () => {
    if (trip.lat == null || trip.lng == null) return;
    const dest = { name: trip.name, latitude: trip.lat, longitude: trip.lng };
    if (car) void openDrivingDirections(dest);
    else void openWalkingDirections(dest);
    track('navigation_started', { facility_type: trip.type, navigation_mode: trip.navigationMode ?? 'walk', walk_minutes: trip.walkMinutes ?? null });
    queueRecommendationOutcome(trip.recommendationId, 'navigation_started');
  };

  // 접은 판·펼친 판을 따로 두지 않는다 — 판은 하나이고, 홈이 남은 높이 안에서 스크롤로 보여 준다(자리가 좁으면 위쪽만).
  // 그래서 가장 중요한 것(이름 · 도착했어요 · 아직 가는 중 · 상황 변경)을 맨 위에 둔다.
  return (
    <Card elevation="surface" className={className ?? ''} accessibilityLabel={t('trip.active')}>
      {/* '진행 중' 꼬리표는 이름 줄 앞에 붙인다 — 자리가 좁아도 이름 줄 + 행동 줄이 함께 보이게(homeModel TRIP_CARD_HEIGHT.journey). */}
      <Text className="pr-[4px] text-[16px] leading-[22px]" weight="bold" numberOfLines={2}>
        <Text className="text-[12px] text-jade" weight="bold">{`${t('trip.active')} · `}</Text>
        {t('trip.heading', { name: trip.name })}
      </Text>

      <View className="mt-[10px] flex-row gap-[8px]">
        <Pressable accessibilityRole="button" accessibilityLabel={t('trip.arrived')} onPress={arrived} className="min-h-[44px] flex-1 items-center justify-center rounded-xl bg-jade px-[6px]">
          <Text className="text-center text-[12px] leading-[16px] text-white" weight="bold">{t('trip.arrived')}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('trip.stillGoing')}
          onPress={() => { haptic('selection'); hiddenTrips.add(tripKey(trip)); setTrip(null); }}
          className="min-h-[44px] flex-1 items-center justify-center rounded-xl border border-line px-[6px]"
        >
          <Text className="text-center text-[12px] leading-[16px]" weight="bold">{t('trip.stillGoing')}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('trip.changed')}
          disabled={busy}
          onPress={() => { haptic('selection'); setChangeOpen(true); setDraft({}); setParseError(false); }}
          className="min-h-[44px] flex-1 flex-row items-center justify-center gap-[4px] rounded-xl border border-gold/40 bg-gold/10 px-[6px]"
        >
          <Icon icon={RefreshCw} size="xs" />
          <Text className="text-center text-[12px] leading-[16px]" weight="bold">{t('trip.changed')}</Text>
        </Pressable>
      </View>

      {!car && trip.walkMinutes != null && (
        <Text className="mt-[8px] text-[12px] leading-[16px] text-muk-soft">{t('trip.walkEstimate', { n: displayWalkMinutes(trip.walkMinutes) })}</Text>
      )}
      {car && <Text className="mt-[8px] text-[12px] leading-[16px] text-muk-soft">{t('trip.driveBasisHint')}</Text>}

      {changeOpen && (
        <View className="mt-[12px] gap-[8px] border-t border-line pt-[4px]">
          {/* 펼친 상황 변경은 길다 — 맨 위에서 바로 닫을 수 있게(아래 '취소' 는 조건을 고르기 시작해야 보인다). */}
          <View className="flex-row items-center gap-[8px]">
            <Text className="min-w-0 flex-1 text-[12px] leading-[16px]" weight="bold">{t('trip.changeTitle')}</Text>
            <IconButton icon={X} accessibilityLabel={t('common.close')} onPress={() => { haptic('selection'); Keyboard.dismiss(); setChangeOpen(false); }} />
          </View>
          <Button label={busy ? t('common.loading') : t('trip.confirmContext')} loading={busy} onPress={() => void replan()} />
          {notice && (
            <View accessibilityLiveRegion="polite" className="rounded-xl bg-terracotta/10 px-[12px] py-[8px]">
              <Text className="text-[12px] leading-[17px] text-terracotta">{t(notice.messageKey)}</Text>
              {notice.retryable && (
                <Button className="mt-[6px]" variant="secondary" label={t('common.retry')} loading={busy} onPress={() => { haptic('selection'); void replan(lastContext.current); }} />
              )}
            </View>
          )}
          <AiConsentNotice />
          <TextInput
            accessibilityLabel={t('trip.changeTitle')}
            accessibilityState={{ disabled: !aiAllowed }}
            editable={aiAllowed}
            maxLength={300}
            multiline
            value={changeText}
            onChangeText={setChangeText}
            onFocus={() => { inputFocused.current = true; onInputFocus?.(); }}
            onBlur={releaseInput}
            placeholder={t('trip.changePlaceholder')}
            placeholderTextColor="#8a7f78"
            className={aiAllowed ? 'min-h-[64px] rounded-xl border border-line px-[12px] py-[8px] text-[13px] text-muk' : 'min-h-[64px] rounded-xl border border-line bg-hanji-deep px-[12px] py-[8px] text-[13px] text-muk-soft'}
            maxFontSizeMultiplier={1.6}
          />
          <Button variant="secondary" label={busy ? t('trip.parsing') : t('trip.parse')} disabled={busy || !aiAllowed || !changeText.trim()} onPress={() => void parseChange()} />
          {draft && (
            <View className="gap-[8px]">
              <Text className="text-[11px] leading-[15px] text-muk-soft">{parseError ? t('trip.noContext') : t('trip.manualHint')}</Text>
              <View className="flex-row flex-wrap gap-[6px]">
                {REPLAN_CATEGORIES.map((c: PlaceCategory) => (
                  <Chip key={c} label={t(`category.${c}`)} selected={draft.categories?.includes(c) ?? false} onPress={() => update((d) => ({ ...d, categories: toggled(d.categories, c) }))} />
                ))}
              </View>
              <View className="flex-row flex-wrap gap-[6px]">
                {REPLAN_WALKS.map((m) => (
                  <Chip key={m} label={t('trip.walkChip', { n: m })} selected={draft.maxWalkMinutes === m} onPress={() => update((d) => ({ ...d, maxWalkMinutes: m }))} />
                ))}
              </View>
              <View className="flex-row flex-wrap gap-[6px]">
                {REPLAN_AVAILABLE.map((m) => (
                  <Chip key={m} label={m === 120 ? t('setup.twoHoursPlus') : t('trip.availableChip', { n: m })} selected={draft.availableMinutes === m} onPress={() => update((d) => ({ ...d, availableMinutes: m }))} />
                ))}
              </View>
              <View className="flex-row flex-wrap gap-[6px]">
                {REPLAN_ATTRIBUTES.map((a: RequiredAttribute) => (
                  <Chip key={a} label={t(`trip.attribute.${a}`)} selected={draft.requiredAttributes?.includes(a) ?? false} onPress={() => update((d) => ({ ...d, requiredAttributes: toggled(d.requiredAttributes, a) }))} />
                ))}
                <Chip label={t('setup.excludeVisited')} selected={draft.excludeVisited === true} onPress={() => update((d) => ({ ...d, excludeVisited: !d.excludeVisited }))} />
              </View>
              <View className="flex-row gap-[8px]">
                <Button className="flex-1" variant="secondary" label={t('common.cancel')} onPress={() => setChangeOpen(false)} />
                <Button className="flex-1" label={busy ? t('common.loading') : t('trip.confirmContext')} disabled={busy || !hasCondition(draft)} onPress={() => void replan(draft)} />
              </View>
            </View>
          )}
        </View>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(car ? 'trip.resumeDriving' : 'trip.resumeDirections')}
        onPress={resume}
        className="mt-[8px] min-h-[44px] flex-row items-center justify-center gap-[4px]"
      >
        <Icon icon={Navigation} size="xs" color="gold-deep" />
        <Text className="text-[12px] leading-[16px] text-gold-deep" weight="bold">{t(car ? 'trip.resumeDriving' : 'trip.resumeDirections')}</Text>
      </Pressable>
    </Card>
  );
}
