'use client';

import { useEffect, useState } from 'react';
import { Navigation, RefreshCw } from 'lucide-react';
import { getActiveTrip, markTripArrived, recordActiveTrip, type ActiveTrip } from '@/lib/visits';
import { loadTravelContext, type TravelContext } from '@/lib/travelContext';
import { recommendByType } from '@/lib/api-client';
import { openWalkingDirections } from '@/lib/navigation';
import { track } from '@/lib/analytics';
import { useT } from '@/lib/i18n/I18nProvider';

export default function ActiveJourneyCard({ location }: { location: { lat: number; lng: number } }) {
  const t = useT();
  const [trip, setTrip] = useState<ActiveTrip | null>(null);
  const [busy, setBusy] = useState(false);
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
  const replan = async () => {
    if (busy) return;
    setBusy(true);
    track('replan_requested', { facility_type: trip.type });
    try {
      const context = (trip.context as unknown as TravelContext | undefined) ?? loadTravelContext();
      const results = await recommendByType(trip.type, location, [trip.facilityId], 1, context);
      const next = results[0];
      if (!next) return;
      recordActiveTrip({
        id: next.facility.id, name: next.facility.name, type: next.facility.type,
        latitude: next.facility.latitude, longitude: next.facility.longitude,
      }, { recommendationId: next.recommendationId, walkMinutes: next.breakdown.travelTime, context: context as unknown as Record<string, unknown> });
      const updated = getActiveTrip();
      setTrip(updated);
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
        <button type="button" disabled={busy} onClick={() => void replan()} className="rounded-xl border border-gold/40 bg-gold/10 py-2 flex items-center justify-center gap-1"><RefreshCw size={12} />{t('trip.changed')}</button>
      </div>
      <button type="button" onClick={() => trip.lat != null && trip.lng != null && openWalkingDirections({ name: trip.name, latitude: trip.lat, longitude: trip.lng })} className="mt-2 w-full text-xs text-gold-deep font-bold flex justify-center items-center gap-1"><Navigation size={12} />{t('trip.resumeDirections')}</button>
    </aside>
  );
}
