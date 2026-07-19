'use client';

import { useEffect, useState } from 'react';
import { Navigation, RefreshCw } from 'lucide-react';
import { getActiveTrip, getVisitHistory, markTripArrived, recordActiveTrip, type ActiveTrip } from '@/lib/visits';
import { loadTravelContext, type TravelContext } from '@/lib/travelContext';
import { parseTravelContext, recommendByType } from '@/lib/api-client';
import { openWalkingDirections } from '@/lib/navigation';
import { track } from '@/lib/analytics';
import { useT } from '@/lib/i18n/I18nProvider';

export default function ActiveJourneyCard({ location }: { location: { lat: number; lng: number } }) {
  const t = useT();
  const [trip, setTrip] = useState<ActiveTrip | null>(null);
  const [busy, setBusy] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeText, setChangeText] = useState('');
  const [draft, setDraft] = useState<Partial<TravelContext> | null>(null);
  const [parseError, setParseError] = useState(false);
  useEffect(() => {
    const active = getActiveTrip();
    setTrip(active);
    if (active) track('trip_resumed', { facility_type: active.type });
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
    track('replan_requested', { facility_type: trip.type });
    try {
      const base = (trip.context as unknown as TravelContext | undefined) ?? loadTravelContext();
      const context: TravelContext = {
        ...base,
        ...confirmed,
        categories: confirmed?.categories ?? base.categories,
        requiredAttributes: confirmed?.requiredAttributes ?? base.requiredAttributes,
        visitedFacilityIds: confirmed?.excludeVisited
          ? [...new Set(getVisitHistory().map((entry) => entry.facilityId))].slice(0, 200)
          : base.visitedFacilityIds,
      };
      const facilityType = confirmed?.categories?.[0] ?? trip.type;
      const results = await recommendByType(facilityType, location, [trip.facilityId], 1, context);
      const next = results[0];
      if (!next) return;
      recordActiveTrip({
        id: next.facility.id, name: next.facility.name, type: next.facility.type,
        latitude: next.facility.latitude, longitude: next.facility.longitude,
      }, { recommendationId: next.recommendationId, walkMinutes: next.breakdown.travelTime, context: context as unknown as Record<string, unknown> });
      const updated = getActiveTrip();
      setTrip(updated);
      setChangeOpen(false);
      setDraft(null);
      setChangeText('');
      openWalkingDirections(next.facility);
    } finally { setBusy(false); }
  };

  return (
    <aside className="absolute z-30 top-24 left-4 right-4 md:left-auto md:right-[400px] md:w-80 rounded-2xl border border-jade/30 bg-white/95 backdrop-blur p-4 shadow-lg">
      <p className="text-xs font-bold text-jade">{t('trip.active')}</p>
      <p className="mt-1 font-bold text-muk truncate">{t('trip.heading', { name: trip.name })}</p>
      {trip.walkMinutes != null && <p className="text-xs text-muk-soft mt-0.5">{t('trip.walkEstimate', { n: Math.round(trip.walkMinutes) })}</p>}
      <div className="grid grid-cols-3 gap-2 mt-3 text-xs font-bold">
        <button type="button" onClick={arrived} className="rounded-xl bg-jade text-white py-2">{t('trip.arrived')}</button>
        <button type="button" onClick={() => setTrip(null)} className="rounded-xl border border-line py-2">{t('trip.stillGoing')}</button>
        <button type="button" disabled={busy} onClick={() => { setChangeOpen(true); setDraft(null); setParseError(false); }} className="rounded-xl border border-gold/40 bg-gold/10 py-2 flex items-center justify-center gap-1"><RefreshCw size={12} />{t('trip.changed')}</button>
      </div>
      {changeOpen && (
        <div className="mt-3 border-t border-line pt-3">
          <label className="text-xs font-bold text-muk" htmlFor="trip-change">{t('trip.changeTitle')}</label>
          <textarea id="trip-change" maxLength={300} value={changeText} onChange={(event) => setChangeText(event.target.value)} placeholder={t('trip.changePlaceholder')} className="mt-2 w-full min-h-16 resize-none rounded-xl border border-line px-3 py-2 text-xs text-muk outline-none focus:border-jade" />
          <button type="button" disabled={busy || !changeText.trim()} onClick={() => void parseChange()} className="mt-2 w-full rounded-xl border border-jade/30 bg-jade/5 py-2 text-xs font-bold text-jade disabled:opacity-50">{busy ? t('trip.parsing') : t('trip.parse')}</button>
          {draft && (
            <div className="mt-2">
              <p className="text-[11px] text-muk-soft">{parseError ? t('trip.noContext') : t('trip.confirmHint')}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {draft.categories?.map((category) => <span key={category} className="rounded-full bg-jade/10 px-2 py-1 text-[11px] text-jade">{t(`category.${category}`)}</span>)}
                {draft.maxWalkMinutes && <span className="rounded-full bg-jade/10 px-2 py-1 text-[11px] text-jade">{t('trip.walkChip', { n: draft.maxWalkMinutes })}</span>}
                {draft.availableMinutes && <span className="rounded-full bg-jade/10 px-2 py-1 text-[11px] text-jade">{t('trip.availableChip', { n: draft.availableMinutes })}</span>}
                {draft.requiredAttributes?.map((attribute) => <span key={attribute} className="rounded-full bg-jade/10 px-2 py-1 text-[11px] text-jade">{t(`trip.attribute.${attribute}`)}</span>)}
                {draft.excludeVisited && <span className="rounded-full bg-jade/10 px-2 py-1 text-[11px] text-jade">{t('setup.excludeVisited')}</span>}
              </div>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => setChangeOpen(false)} className="flex-1 rounded-xl border border-line py-2 text-xs font-bold">{t('common.cancel')}</button>
                <button type="button" disabled={busy || parseError} onClick={() => void replan(draft)} className="flex-1 rounded-xl bg-jade py-2 text-xs font-bold text-white disabled:opacity-50">{t('trip.confirmContext')}</button>
              </div>
            </div>
          )}
        </div>
      )}
      <button type="button" onClick={() => trip.lat != null && trip.lng != null && openWalkingDirections({ name: trip.name, latitude: trip.lat, longitude: trip.lng })} className="mt-2 w-full text-xs text-gold-deep font-bold flex justify-center items-center gap-1"><Navigation size={12} />{t('trip.resumeDirections')}</button>
    </aside>
  );
}
