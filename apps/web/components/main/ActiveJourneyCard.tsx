'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigation, RefreshCw } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { getActiveTrip, getVisitHistory, markTripArrived, recordActiveTrip, type ActiveTrip } from '@/lib/visits';
import { loadTravelContext, type PlaceCategory, type RequiredAttribute, type TravelContext } from '@/lib/travelContext';
import { parseTravelContext, recommendByType } from '@/lib/api-client';
import { openDrivingDirections, openWalkingDirections } from '@/lib/navigation';
import { track } from '@/lib/analytics';
import { useT } from '@/lib/i18n/I18nProvider';
import { queueRecommendationOutcome } from '@/lib/recommendationOutcomes';
import { haptic, interactionSpring, sheetSpring } from '@/lib/motion';
import { displayWalkingMinutes } from '@/lib/recommender';
import { classifyReplanOutcome, replanNotice, type ReplanOutcome } from '@/lib/replanOutcome';

const CATEGORIES: PlaceCategory[] = ['restaurant', 'cafe', 'attraction', 'culture'];
const WALKS = [5, 10, 20] as const;
const AVAILABLE = [30, 60, 120] as const;
const REPLAN_RESPONSE_BUDGET_MS = 3000;

function hasCondition(value: Partial<TravelContext> | null): boolean {
  return Boolean(value && (
    value.categories?.length || value.maxWalkMinutes || value.availableMinutes
    || value.requiredAttributes?.length || value.excludeVisited
  ));
}

export default function ActiveJourneyCard({ location }: { location: { lat: number; lng: number } }) {
  const t = useT();
  const [trip, setTrip] = useState<ActiveTrip | null>(null);
  const [busy, setBusy] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeText, setChangeText] = useState('');
  const [draft, setDraft] = useState<Partial<TravelContext> | null>(null);
  const [parseError, setParseError] = useState(false);
  // 재계획이 대체지 없이 끝난 '이유'. 예전에는 불리언 하나였고, 장애·타임아웃·0건이 전부
  // '추천할 곳이 없어요' 로 나갔다(lib/replanOutcome 주석 참조).
  const [replanOutcome, setReplanOutcome] = useState<ReplanOutcome | null>(null);
  // 재시도는 **같은 조건으로** 다시 보내야 한다. 실패한 시도가 draft 였는지 현재 여정 조건이었는지
  // 기억하지 않으면, '다시 시도' 가 사용자가 방금 고른 조건을 조용히 버린 다른 요청이 된다.
  const lastReplanContextRef = useRef<Partial<TravelContext> | undefined>(undefined);
  useEffect(() => {
    const sync = () => {
      const active = getActiveTrip();
      setTrip(active?.status === 'navigating' ? active : null);
      if (active?.status === 'navigating') track('trip_resumed', { facility_type: active.type });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') sync();
    };
    sync();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('nextspot:trip-navigating', sync);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('nextspot:trip-navigating', sync);
    };
  }, []);
  if (!trip || trip.status === 'arrived') return null;

  const arrived = () => {
    haptic('success');
    queueRecommendationOutcome(trip.recommendationId, 'arrival_confirmed');
    markTripArrived();
    track('arrival_confirmed', { facility_type: trip.type });
    window.dispatchEvent(new Event('nextspot:trip-arrived'));
    setTrip(null);
  };
  const parseChange = async () => {
    if (!changeText.trim() || busy) return;
    setBusy(true);
    setReplanOutcome(null);
    setParseError(false);
    try {
      const result = await parseTravelContext(changeText.trim());
      setDraft(result.context);
      setParseError(Object.keys(result.context).length === 0);
    } catch {
      setDraft({});
      setParseError(true);
    } finally { setBusy(false); }
  };
  const replan = async (confirmed?: Partial<TravelContext>) => {
    if (busy) return;
    setBusy(true);
    setReplanOutcome(null);
    lastReplanContextRef.current = confirmed;
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
    try {
      const base = (trip.context as unknown as TravelContext | undefined) ?? loadTravelContext();
      const excludeVisited = confirmed?.excludeVisited ?? base.excludeVisited;
      const context: TravelContext = {
        ...base,
        ...confirmed,
        categories: confirmed?.categories ?? base.categories,
        requiredAttributes: confirmed?.requiredAttributes ?? base.requiredAttributes,
        visitedFacilityIds: excludeVisited
          ? [...new Set(getVisitHistory().map((entry) => entry.facilityId))].slice(0, 200)
          : [],
      };
      const facilityTypes = context.categories.length ? context.categories : [trip.type];
      let deadlineId: ReturnType<typeof setTimeout> | undefined;
      // 예산 초과를 '빈 배열' 로 표현하지 않는다. 예전에는 setTimeout 이 [] 를 resolve 했고,
      // 그 [] 가 서버의 '조건에 맞는 곳 0건' 과 구분되지 않아 타임아웃이 '추천할 곳이 없어요' 로
      // 나갔다. 표식을 따로 돌려주고 아래 classifyReplanOutcome 이 셋을 갈라놓는다.
      const raced = await Promise.race([
        Promise.all(
          facilityTypes.map((facilityType) => recommendByType(facilityType, location, [trip.facilityId], 1, context)),
        ).then((batches) => ({ batches })),
        new Promise<{ overBudget: true }>((resolve) => {
          deadlineId = setTimeout(() => resolve({ overBudget: true }), REPLAN_RESPONSE_BUDGET_MS);
        }),
      ]);
      if (deadlineId) clearTimeout(deadlineId);
      const timedOut = 'overBudget' in raced;
      const candidates = timedOut ? [] : raced.batches.flat().sort((a, b) =>
        b.spotScore - a.spotScore || a.distanceM - b.distanceM || a.facility.id.localeCompare(b.facility.id),
      );
      // 후보가 없으면 outcome 은 'empty' 아니면 'timeout' 이다('replaced' 는 후보가 있을 때만 나온다).
      const next = candidates[0];
      if (!next) {
        // 진행 중인 여정은 어떤 경우에도 지우지 않는다. 다만 왜 못 갈아탔는지는 구분해서 말한다.
        setReplanOutcome(classifyReplanOutcome({ timedOut, candidateCount: candidates.length }));
        return;
      }
      recordActiveTrip({
        id: next.facility.id, name: next.facility.name, type: next.facility.type,
        latitude: next.facility.latitude, longitude: next.facility.longitude,
      }, { recommendationId: next.recommendationId, walkMinutes: next.breakdown.travelTime, context: context as unknown as Record<string, unknown>, navigationMode: trip.navigationMode ?? 'walk' });
      const updated = getActiveTrip();
      setTrip(updated);
      setChangeOpen(false);
      setDraft(null);
      setChangeText('');
      if (trip.navigationMode === 'car') openDrivingDirections(next.facility);
      else openWalkingDirections(next.facility);
      track('navigation_started', {
        facility_type: next.facility.type,
        navigation_mode: trip.navigationMode ?? 'walk',
        walk_minutes: next.breakdown.travelTime,
      });
      queueRecommendationOutcome(next.recommendationId, 'navigation_started');
    } catch {
      // 호출 자체가 실패했다. 진행 중인 여정은 절대 지우지 않되, 이것을 '조건에 맞는 곳이 없음'
      // 으로 말하지 않는다 — 조건을 바꿔도 달라지지 않는 문제이므로 재시도 경로를 준다.
      setReplanOutcome('failed');
    } finally { setBusy(false); }
  };
  const updateDraft = (update: (current: Partial<TravelContext>) => Partial<TravelContext>) => {
    setParseError(false);
    setDraft((current) => update(current ?? {}));
  };
  const toggleCategory = (category: PlaceCategory) => updateDraft((current) => {
    const values = current.categories ?? [];
    return { ...current, categories: values.includes(category) ? values.filter((value) => value !== category) : [...values, category] };
  });
  const toggleAttribute = (attribute: RequiredAttribute) => updateDraft((current) => {
    const values = current.requiredAttributes ?? [];
    return { ...current, requiredAttributes: values.includes(attribute) ? values.filter((value) => value !== attribute) : [...values, attribute] };
  });
  const notice = replanOutcome ? replanNotice(replanOutcome) : null;

  return (
    <motion.aside
      initial={{ opacity: 0, y: -12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={sheetSpring}
      className="absolute z-30 top-24 left-4 right-4 max-h-[calc(100dvh-7rem)] overflow-y-auto md:left-auto md:right-[400px] md:w-80 rounded-2xl border border-jade/30 bg-white/95 backdrop-blur p-4 toss-surface"
    >
      <p className="text-xs font-bold text-jade">{t('trip.active')}</p>
      <p className="mt-1 font-bold text-muk truncate">{t('trip.heading', { name: trip.name })}</p>
      {trip.navigationMode !== 'car' && trip.walkMinutes != null && <p className="text-xs text-muk-soft mt-0.5">{t('trip.walkEstimate', { n: displayWalkingMinutes(trip.walkMinutes) })}</p>}
      {trip.navigationMode === 'car' && <p className="text-xs text-muk-soft mt-0.5">{t('trip.driveBasisHint')}</p>}
      <div className="grid grid-cols-3 gap-2 mt-3 text-xs font-bold">
        <button type="button" onClick={arrived} className="toss-pressable rounded-xl bg-jade text-white py-2">{t('trip.arrived')}</button>
        <button type="button" onClick={() => { haptic('selection'); setTrip(null); }} className="toss-pressable rounded-xl border border-line py-2">{t('trip.stillGoing')}</button>
        <button type="button" disabled={busy} onClick={() => { haptic('selection'); setChangeOpen(true); setDraft({}); setParseError(false); }} className="toss-pressable rounded-xl border border-gold/40 bg-gold/10 py-2 flex items-center justify-center gap-1"><RefreshCw size={12} />{t('trip.changed')}</button>
      </div>
      <AnimatePresence initial={false}>
      {changeOpen && (
        <motion.div
          initial={{ height: 0, opacity: 0, y: -8 }}
          animate={{ height: 'auto', opacity: 1, y: 0 }}
          exit={{ height: 0, opacity: 0, y: -8 }}
          transition={interactionSpring}
          className="mt-3 overflow-hidden border-t border-line pt-3"
        >
          <label className="text-xs font-bold text-muk" htmlFor="trip-change">{t('trip.changeTitle')}</label>
          <button type="button" disabled={busy} onClick={() => void replan()} className="mt-2 w-full rounded-xl bg-jade py-2 text-xs font-bold text-white disabled:opacity-50">{busy ? t('common.loading') : t('trip.confirmContext')}</button>
          {notice && (
            <div role="status" className="mt-2 rounded-xl bg-terracotta/10 px-3 py-2 text-xs text-terracotta">
              <p>{t(notice.messageKey)}</p>
              {/* 장애일 때만 재시도를 준다. 0건은 다시 눌러도 같은 답이라 조건을 바꾸는 쪽이 맞다. */}
              {notice.retryable && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { haptic('selection'); void replan(lastReplanContextRef.current); }}
                  className="toss-pressable mt-1.5 w-full rounded-lg border border-terracotta/40 py-1.5 font-bold disabled:opacity-50"
                >
                  {busy ? t('common.loading') : t('common.retry')}
                </button>
              )}
            </div>
          )}
          <textarea id="trip-change" maxLength={300} value={changeText} onChange={(event) => setChangeText(event.target.value)} placeholder={t('trip.changePlaceholder')} className="mt-2 w-full min-h-16 resize-none rounded-xl border border-line px-3 py-2 text-xs text-muk outline-none focus:border-jade" />
          <button type="button" disabled={busy || !changeText.trim()} onClick={() => void parseChange()} className="mt-2 w-full rounded-xl border border-jade/30 bg-jade/5 py-2 text-xs font-bold text-jade disabled:opacity-50">{busy ? t('trip.parsing') : t('trip.parse')}</button>
          {draft && (
            <div className="mt-2">
              <p className="text-[11px] text-muk-soft">{parseError ? t('trip.noContext') : t('trip.manualHint')}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {CATEGORIES.map((category) => <ChoiceChip key={category} active={draft.categories?.includes(category) ?? false} onClick={() => toggleCategory(category)}>{t(`category.${category}`)}</ChoiceChip>)}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {WALKS.map((minutes) => <ChoiceChip key={minutes} active={draft.maxWalkMinutes === minutes} onClick={() => updateDraft((current) => ({ ...current, maxWalkMinutes: minutes }))}>{t('trip.walkChip', { n: minutes })}</ChoiceChip>)}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {AVAILABLE.map((minutes) => <ChoiceChip key={minutes} active={draft.availableMinutes === minutes} onClick={() => updateDraft((current) => ({ ...current, availableMinutes: minutes }))}>{minutes === 120 ? t('setup.twoHoursPlus') : t('trip.availableChip', { n: minutes })}</ChoiceChip>)}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(['indoor', 'accessible'] as RequiredAttribute[]).map((attribute) => <ChoiceChip key={attribute} active={draft.requiredAttributes?.includes(attribute) ?? false} onClick={() => toggleAttribute(attribute)}>{t(`trip.attribute.${attribute}`)}</ChoiceChip>)}
                <ChoiceChip active={draft.excludeVisited === true} onClick={() => updateDraft((current) => ({ ...current, excludeVisited: !current.excludeVisited }))}>{t('setup.excludeVisited')}</ChoiceChip>
              </div>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => setChangeOpen(false)} className="flex-1 rounded-xl border border-line py-2 text-xs font-bold">{t('common.cancel')}</button>
                <button type="button" disabled={busy || !hasCondition(draft)} onClick={() => void replan(draft)} className="flex-1 rounded-xl bg-jade py-2 text-xs font-bold text-white disabled:opacity-50">{busy ? t('common.loading') : t('trip.confirmContext')}</button>
              </div>
            </div>
          )}
        </motion.div>
      )}
      </AnimatePresence>
      <button type="button" onClick={() => {
        if (trip.lat == null || trip.lng == null) return;
        const facility = { name: trip.name, latitude: trip.lat, longitude: trip.lng };
        if (trip.navigationMode === 'car') openDrivingDirections(facility);
        else openWalkingDirections(facility);
        track('navigation_started', {
          facility_type: trip.type,
          navigation_mode: trip.navigationMode ?? 'walk',
          walk_minutes: trip.walkMinutes ?? null,
        });
        queueRecommendationOutcome(trip.recommendationId, 'navigation_started');
      }} className="toss-pressable mt-2 w-full text-xs text-gold-deep font-bold flex justify-center items-center gap-1"><Navigation size={12} />{t(trip.navigationMode === 'car' ? 'trip.resumeDriving' : 'trip.resumeDirections')}</button>
    </motion.aside>
  );
}

function ChoiceChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-pressed={active} onClick={() => { haptic('selection'); onClick(); }} className={`toss-pressable rounded-full border px-2.5 py-1 text-[11px] font-semibold ${active ? 'border-jade bg-jade/10 text-jade' : 'border-line bg-white text-muk-soft'}`}>{children}</button>;
}
