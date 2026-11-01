import { Navigation, RefreshCw } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, TextInput, View } from 'react-native';

import { Button, Card, Chip, Icon, Pressable, Text } from '~/components/ui';
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
  hasCondition,
  loadTravelContext,
  replanFacilityTypes,
  sortReplanCandidates,
  toggled,
} from './journeyCore';
import {
  getActiveTrip,
  getVisitHistory,
  markTripArrived,
  recordActiveTrip,
  tripEvents,
  type ActiveTrip,
} from './tripLoop';
import { useCardT } from './useCardT';

export interface ActiveJourneyCardProps {
  /** 내 위치(없으면 이 카드는 재계획을 못 한다 — 길안내 다시 열기 · 도착은 그대로). 홈이 넘긴다. */
  location: { lat: number; lng: number };
  /** 위치·크기(홈이 지도 위에 띄운다) — 예: 'absolute left-4 right-4 top-24'. */
  className?: string;
  /** 도착을 눌렀다 — 방문 확인(VisitCheckCard)이 바로 이어진다. */
  onArrived?: () => void;
}

/**
 * 진행 중 여행 카드 — 도착했어요 · 아직 가는 중 · 상황 변경(자연어·칩으로 조건을 바꿔 다른 곳으로 갈아타기) · 길안내 다시 열기.
 * 웹 components/main/ActiveJourneyCard.tsx(기준 커밋 0d145a1). 저장소·이벤트는 tripLoop, 판정은 journeyCore.
 */
export function ActiveJourneyCard({ location, className, onArrived }: ActiveJourneyCardProps) {
  const { t } = useCardT();
  const [trip, setTrip] = useState<ActiveTrip | null>(null);
  const [busy, setBusy] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeText, setChangeText] = useState('');
  const [draft, setDraft] = useState<Partial<TravelContext> | null>(null);
  const [parseError, setParseError] = useState(false);
  const [outcome, setOutcome] = useState<ReplanOutcome | null>(null);
  // 재시도는 같은 조건으로 — 실패한 시도가 draft 였는지 현재 여정 조건이었는지 기억한다(웹과 같다).
  const lastContext = useRef<Partial<TravelContext> | undefined>(undefined);

  useEffect(() => {
    const sync = () => {
      const found = getActiveTrip();
      const active = found?.status === 'navigating' ? found : null;
      setTrip(active);
      if (active) track('trip_resumed', { facility_type: active.type });
    };
    sync();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && sync());
    const off = tripEvents.on('trip-navigating', sync);
    return () => {
      sub.remove();
      off();
    };
  }, []);

  const arrived = useCallback(() => {
    if (!trip) return;
    haptic('success');
    queueRecommendationOutcome(trip.recommendationId, 'arrival_confirmed');
    markTripArrived();
    track('arrival_confirmed', { facility_type: trip.type });
    tripEvents.emit('trip-arrived', undefined);
    setTrip(null);
    onArrived?.();
  }, [trip, onArrived]);

  if (!trip || trip.status === 'arrived') return null;

  const parseChange = async () => {
    if (!changeText.trim() || busy) return;
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

  return (
    <Card elevation="surface" className={className ?? ''} accessibilityLabel={t('trip.active')}>
      <Text className="text-[12px] leading-[16px] text-jade" weight="bold">{t('trip.active')}</Text>
      <Text className="mt-[4px] text-[16px] leading-[22px]" weight="bold" numberOfLines={2}>{t('trip.heading', { name: trip.name })}</Text>
      {!car && trip.walkMinutes != null && (
        <Text className="mt-[2px] text-[12px] leading-[16px] text-muk-soft">{t('trip.walkEstimate', { n: displayWalkMinutes(trip.walkMinutes) })}</Text>
      )}
      {car && <Text className="mt-[2px] text-[12px] leading-[16px] text-muk-soft">{t('trip.driveBasisHint')}</Text>}

      <View className="mt-[12px] flex-row gap-[8px]">
        <Pressable accessibilityRole="button" accessibilityLabel={t('trip.arrived')} onPress={arrived} className="min-h-[44px] flex-1 items-center justify-center rounded-xl bg-jade px-[6px]">
          <Text className="text-center text-[12px] leading-[16px] text-white" weight="bold">{t('trip.arrived')}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('trip.stillGoing')}
          onPress={() => { haptic('selection'); setTrip(null); }}
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

      {changeOpen && (
        <View className="mt-[12px] gap-[8px] border-t border-line pt-[12px]">
          <Text className="text-[12px] leading-[16px]" weight="bold">{t('trip.changeTitle')}</Text>
          <Button label={busy ? t('common.loading') : t('trip.confirmContext')} loading={busy} onPress={() => void replan()} />
          {notice && (
            <View accessibilityLiveRegion="polite" className="rounded-xl bg-terracotta/10 px-[12px] py-[8px]">
              <Text className="text-[12px] leading-[17px] text-terracotta">{t(notice.messageKey)}</Text>
              {notice.retryable && (
                <Button className="mt-[6px]" variant="secondary" label={t('common.retry')} loading={busy} onPress={() => { haptic('selection'); void replan(lastContext.current); }} />
              )}
            </View>
          )}
          <TextInput
            accessibilityLabel={t('trip.changeTitle')}
            maxLength={300}
            multiline
            value={changeText}
            onChangeText={setChangeText}
            placeholder={t('trip.changePlaceholder')}
            placeholderTextColor="#8a7f78"
            className="min-h-[64px] rounded-xl border border-line px-[12px] py-[8px] text-[13px] text-muk"
            maxFontSizeMultiplier={1.6}
          />
          <Button variant="secondary" label={busy ? t('trip.parsing') : t('trip.parse')} disabled={busy || !changeText.trim()} onPress={() => void parseChange()} />
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
