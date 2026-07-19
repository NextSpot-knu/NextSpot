'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Navigation, RefreshCw } from 'lucide-react';
import { getActiveTrip, getVisitHistory, markTripArrived, recordActiveTrip, type ActiveTrip } from '@/lib/visits';
import { loadTravelContext, type PlaceCategory, type RequiredAttribute, type TravelContext } from '@/lib/travelContext';
import { parseTravelContext, recommendByType } from '@/lib/api-client';
import { openDrivingDirections, openWalkingDirections } from '@/lib/navigation';
import { track } from '@/lib/analytics';
import { useT } from '@/lib/i18n/I18nProvider';

const CATEGORIES: PlaceCategory[] = ['restaurant', 'cafe', 'attraction', 'culture'];
const WALKS = [5, 10, 20] as const;
const AVAILABLE = [30, 60, 120] as const;

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
  const [replanEmpty, setReplanEmpty] = useState(false);
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
    markTripArrived();
    track('arrival_confirmed', { facility_type: trip.type });
    window.dispatchEvent(new Event('nextspot:trip-arrived'));
    setTrip(null);
  };
  const parseChange = async () => {
    if (!changeText.trim() || busy) return;
    setBusy(true);
    setReplanEmpty(false);
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
    setReplanEmpty(false);
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
      const batches = await Promise.all(
        facilityTypes.map((facilityType) => recommendByType(facilityType, location, [trip.facilityId], 1, context)),
      );
      const next = batches.flat().sort((a, b) =>
        b.spotScore - a.spotScore || a.distanceM - b.distanceM || a.facility.id.localeCompare(b.facility.id),
      )[0];
      if (!next) {
        // Preserve the existing active trip when no eligible replacement exists.
        setReplanEmpty(true);
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

  return (
    <aside className="absolute z-30 top-24 left-4 right-4 max-h-[calc(100dvh-7rem)] overflow-y-auto md:left-auto md:right-[400px] md:w-80 rounded-2xl border border-jade/30 bg-white/95 backdrop-blur p-4 shadow-lg">
      <p className="text-xs font-bold text-jade">{t('trip.active')}</p>
      <p className="mt-1 font-bold text-muk truncate">{t('trip.heading', { name: trip.name })}</p>
      {trip.navigationMode !== 'car' && trip.walkMinutes != null && <p className="text-xs text-muk-soft mt-0.5">{t('trip.walkEstimate', { n: Math.round(trip.walkMinutes) })}</p>}
      {trip.navigationMode === 'car' && <p className="text-xs text-muk-soft mt-0.5">{t('trip.driveBasisHint')}</p>}
      <div className="grid grid-cols-3 gap-2 mt-3 text-xs font-bold">
        <button type="button" onClick={arrived} className="rounded-xl bg-jade text-white py-2">{t('trip.arrived')}</button>
        <button type="button" onClick={() => setTrip(null)} className="rounded-xl border border-line py-2">{t('trip.stillGoing')}</button>
        <button type="button" disabled={busy} onClick={() => { setChangeOpen(true); setDraft({}); setParseError(false); }} className="rounded-xl border border-gold/40 bg-gold/10 py-2 flex items-center justify-center gap-1"><RefreshCw size={12} />{t('trip.changed')}</button>
      </div>
      {changeOpen && (
        <div className="mt-3 border-t border-line pt-3">
          <label className="text-xs font-bold text-muk" htmlFor="trip-change">{t('trip.changeTitle')}</label>
          <button type="button" disabled={busy} onClick={() => void replan()} className="mt-2 w-full rounded-xl bg-jade py-2 text-xs font-bold text-white disabled:opacity-50">{t('trip.confirmContext')}</button>
          {replanEmpty && <p role="status" className="mt-2 rounded-xl bg-terracotta/10 px-3 py-2 text-xs text-terracotta">{t('map.noRecBody')}</p>}
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
                <button type="button" disabled={busy || !hasCondition(draft)} onClick={() => void replan(draft)} className="flex-1 rounded-xl bg-jade py-2 text-xs font-bold text-white disabled:opacity-50">{t('trip.confirmContext')}</button>
              </div>
            </div>
          )}
        </div>
      )}
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
      }} className="mt-2 w-full text-xs text-gold-deep font-bold flex justify-center items-center gap-1"><Navigation size={12} />{t(trip.navigationMode === 'car' ? 'trip.resumeDriving' : 'trip.resumeDirections')}</button>
    </aside>
  );
}

function ChoiceChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${active ? 'border-jade bg-jade/10 text-jade' : 'border-line bg-white text-muk-soft'}`}>{children}</button>;
}
