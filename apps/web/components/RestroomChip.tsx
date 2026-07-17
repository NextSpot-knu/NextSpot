'use client';

import { useEffect, useState } from 'react';
import { MapPin, Toilet, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { apiClient } from '@/lib/api-client';
import { useT } from '@/lib/i18n/I18nProvider';

interface Restroom {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  distanceM: number;
  placeUrl: string;
}

export default function RestroomChip({ location }: { location: { lat: number; lng: number } | null }) {
  const t = useT();
  const [items, setItems] = useState<Restroom[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!location) return;
    let active = true;
    apiClient.get('/api/v1/restrooms', { params: {
      lat: String(location.lat), lng: String(location.lng), radiusM: '3000',
    } }).then((value: { restrooms?: Restroom[] }) => {
      if (active) setItems(value.restrooms || []);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [location]);

  if (!items.length) return null;
  return <>
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-white/80 px-3.5 py-2 text-[13px] font-medium text-muk-soft fractal-glass shadow-[0_2px_14px_rgba(43,35,32,0.06)] hover:bg-white hover:text-muk sm:px-4 sm:text-sm"
      aria-label={t('restroom.chipAria', { n: items.length })}
    >
      <Toilet size={15} aria-hidden="true" /> {t('restroom.chip')} {items.length}
    </button>
    {open && typeof document !== 'undefined' && createPortal(
      <div className="fixed inset-0 z-[1000] flex items-end justify-center bg-black/30" onClick={() => setOpen(false)}>
        <section className="max-h-[70vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-hanji p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
          <div className="mb-4 flex items-start justify-between">
            <div><h2 className="text-lg font-bold text-muk">{t('restroom.title')}</h2><p className="text-xs text-muk-soft">{t('restroom.subtitle')}</p></div>
            <button type="button" onClick={() => setOpen(false)} aria-label={t('common.close')} className="rounded-full p-2 hover:bg-hanji-deep"><X size={18} /></button>
          </div>
          <div className="space-y-2">
            {items.map((item) => <a
              key={item.id}
              href={item.placeUrl || `https://map.kakao.com/link/map/${encodeURIComponent(item.name)},${item.latitude},${item.longitude}`}
              target="_blank" rel="noreferrer"
              className="flex items-center justify-between rounded-2xl border border-line bg-white/70 p-3"
            >
              <div className="min-w-0"><p className="truncate text-sm font-bold text-muk">{item.name}</p><p className="truncate text-xs text-muk-soft">{item.address}</p></div>
              <span className="ml-3 flex shrink-0 items-center gap-1 text-xs font-bold text-gold"><MapPin size={13} />{item.distanceM < 1000 ? `${item.distanceM}m` : `${(item.distanceM / 1000).toFixed(1)}km`}</span>
            </a>)}
          </div>
        </section>
      </div>, document.body)}
  </>;
}
