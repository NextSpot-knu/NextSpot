'use client';

import { useEffect, useState } from 'react';
import { CloudSun } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useT } from '@/lib/i18n/I18nProvider';

interface WeatherNow {
  temperatureC: number;
  sky: number;
  precipitationType: number;
  precipitationProbability: number;
  windSpeedMps: number;
}

interface WeatherResponse {
  source: 'kma' | 'unavailable';
  current: WeatherNow | null;
  indoorRecommended: boolean;
}

function iconOf(now: WeatherNow): string {
  if (now.precipitationType === 3 || now.precipitationType === 7) return '❄️';
  if (now.precipitationType > 0) return '🌧️';
  if (now.sky >= 4) return '☁️';
  if (now.sky >= 3) return '⛅';
  return '☀️';
}

export default function WeatherChip() {
  const t = useT();
  const [data, setData] = useState<WeatherResponse | null>(null);

  useEffect(() => {
    let active = true;
    apiClient.get('/api/v1/weather')
      .then((value: WeatherResponse) => { if (active) setData(value); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  if (!data?.current || data.source !== 'kma') return null;
  const now = data.current;
  return (
    <div
      title={t('weather.source')}
      className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-white/80 px-3.5 py-2 text-[13px] font-medium text-muk-soft fractal-glass shadow-[0_2px_14px_rgba(43,35,32,0.06)] sm:px-4 sm:text-sm"
    >
      <CloudSun size={15} aria-hidden="true" />
      <span>{iconOf(now)} {Math.round(now.temperatureC)}°</span>
      <span className="text-[11px] text-muk-soft/80">{t('weather.rain', { n: now.precipitationProbability })}</span>
      {data.indoorRecommended && <span className="font-bold text-gold">{t('weather.indoor')}</span>}
    </div>
  );
}
