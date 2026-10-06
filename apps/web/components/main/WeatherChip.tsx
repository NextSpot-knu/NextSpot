'use client';

// 지금 경주 날씨 — 알약 하나(계획 B3: 날씨·첫 방문은 모든 폭에서 알약 두 개짜리 한 줄). 누르면 6시간 예보와
// '실내만' 조건이 알약 아래에 떠서 펼쳐진다(아래 줄을 밀지 않는다). 키 낮은 휴대폰(높이 720 미만)에서는 검색줄 옆에
// 서므로 '지금 경주' 를 빼고 아이콘 · 기온만 보인다(접근 이름은 그대로).
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Umbrella } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useT } from '@/lib/i18n/I18nProvider';

interface WeatherNow { at: string; temperatureC: number; sky: number; precipitationType: number; precipitationProbability: number; windSpeedMps: number; }
interface WeatherResponse { source: 'kma' | 'unavailable'; current: WeatherNow | null; forecasts: WeatherNow[]; indoorRecommended: boolean; }
interface WeatherChipProps { indoorRequired: boolean; onIndoorRequiredChange: (required: boolean) => void; }

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

export default function WeatherChip({ indoorRequired, onIndoorRequiredChange }: WeatherChipProps) {
  const t = useT();
  const [data, setData] = useState<WeatherResponse | null>(null);
  const [expanded, setExpanded] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    apiClient.get('/api/v1/weather').then((value: WeatherResponse) => { if (active) setData(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  // 펼친 예보는 바깥을 누르면 닫는다(지도 위에 떠 있는 판이라 그대로 두면 지도를 가린다).
  useEffect(() => {
    if (!expanded) return;
    const close = (event: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setExpanded(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [expanded]);

  if (!data?.current || data.source !== 'kma') return null;
  const now = data.current;
  const full = t('weather.gyeongjuNow', { n: Math.round(now.temperatureC) });
  const summary = data.indoorRecommended
    ? t('weather.riskSummary', { n: now.precipitationProbability })
    : t('weather.calmSummary', { n: now.precipitationProbability });
  return (
    <div ref={boxRef} className="pointer-events-auto relative shrink-0">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`${full} · ${summary}`}
        title={summary}
        className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border bg-white px-3 text-[12px] font-bold text-muk shadow-[0_2px_10px_rgba(43,35,32,0.08)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${data.indoorRecommended ? 'border-gold/60' : 'border-line'}`}
      >
        <span aria-hidden className="text-[15px] leading-none">{iconOf(now)}</span>
        <span className="short:max-md:hidden">{full}</span>
        <span aria-hidden className="hidden short:max-md:inline">{Math.round(now.temperatureC)}℃</span>
        {data.indoorRecommended && <Umbrella size={13} aria-hidden className="text-gold-deep" />}
        {expanded ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
      </button>
      {expanded && (
        <section className="absolute left-0 top-full z-30 mt-2 w-72 rounded-2xl border border-line bg-white px-3.5 pb-3 pt-2.5 shadow-[0_10px_30px_rgba(43,35,32,0.18)]">
          <p className="text-[12px] font-semibold text-muk">{summary}</p>
          <div className="mt-2 grid grid-cols-6 gap-1" aria-label={t('weather.sixHour')}>
            {data.forecasts.slice(0, 6).map((forecast) => (
              <div key={forecast.at} className="text-center text-[10px] text-muk-soft">
                <div>{hourOf(forecast.at)}</div><div className="my-0.5 text-base" aria-hidden>{iconOf(forecast)}</div><div className="font-semibold text-muk">{Math.round(forecast.temperatureC)}°</div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[10px] text-muk-soft">{t('weather.observedAt', { time: hourOf(now.at) })}</div>
          {(data.indoorRecommended || indoorRequired) && (
            <button type="button" onClick={() => onIndoorRequiredChange(!indoorRequired)} aria-pressed={indoorRequired} className={`mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${indoorRequired ? 'border-jade bg-jade/15 text-jade' : 'border-gold/50 bg-gold/10 text-muk'}`}>
              <Umbrella size={14} />{t('setup.indoorOnly')}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
