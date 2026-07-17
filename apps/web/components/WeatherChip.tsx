'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Umbrella } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useT } from '@/lib/i18n/I18nProvider';

interface WeatherNow { at: string; temperatureC: number; sky: number; precipitationType: number; precipitationProbability: number; windSpeedMps: number; }
interface WeatherResponse { source: 'kma' | 'unavailable'; current: WeatherNow | null; forecasts: WeatherNow[]; indoorRecommended: boolean; }
interface WeatherChipProps { onPreferenceChange?: (enabled: boolean, activeRisk: boolean) => void; }

function iconOf(now: WeatherNow): string {
  if (now.precipitationType === 3 || now.precipitationType === 7) return '❄️';
  if (now.precipitationType > 0) return '🌧️';
  if (now.sky >= 4) return '☁️';
  if (now.sky >= 3) return '⛅';
  return '☀️';
}

function hourOf(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(new Date(value));
}

export default function WeatherChip({ onPreferenceChange }: WeatherChipProps) {
  const t = useT();
  const [data, setData] = useState<WeatherResponse | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    apiClient.get('/api/v1/weather').then((value: WeatherResponse) => { if (active) setData(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    onPreferenceChange?.(enabled, Boolean(data?.indoorRecommended));
  }, [data?.indoorRecommended, enabled, onPreferenceChange]);

  if (!data?.current || data.source !== 'kma') return null;
  const now = data.current;
  return (
    <section className={`pointer-events-auto overflow-hidden rounded-2xl border bg-white/95 backdrop-blur shadow-[0_2px_14px_rgba(43,35,32,0.08)] ${data.indoorRecommended ? 'border-gold/60' : 'border-line'}`}>
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} className="flex w-full items-center gap-3 px-3.5 py-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold/60">
        <span className="text-2xl" aria-hidden>{iconOf(now)}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-muk">{t('weather.gyeongjuNow', { n: Math.round(now.temperatureC) })}</span>
          <span className="block truncate text-[11px] text-muk-soft">{data.indoorRecommended ? t('weather.riskSummary', { n: now.precipitationProbability }) : t('weather.calmSummary', { n: now.precipitationProbability })}</span>
        </span>
        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {expanded && (
        <div className="border-t border-line/70 px-3.5 pb-3 pt-2.5">
          <div className="grid grid-cols-6 gap-1" aria-label={t('weather.sixHour')}>
            {data.forecasts.slice(0, 6).map((forecast) => (
              <div key={forecast.at} className="text-center text-[10px] text-muk-soft">
                <div>{hourOf(forecast.at)}</div><div className="my-0.5 text-base" aria-hidden>{iconOf(forecast)}</div><div className="font-semibold text-muk">{Math.round(forecast.temperatureC)}°</div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[10px] text-muk-soft">{t('weather.observedAt', { time: hourOf(now.at) })}</div>
          {data.indoorRecommended && (
            <button type="button" onClick={() => setEnabled((value) => !value)} aria-pressed={enabled} className={`mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${enabled ? 'border-jade bg-jade/15 text-jade' : 'border-gold/50 bg-gold/10 text-muk'}`}>
              <Umbrella size={14} />{enabled ? t('weather.modeOn') : t('weather.modeCta')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
