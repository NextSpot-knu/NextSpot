'use client';

// '🔮 혼잡 예측' 시간 줄(계획 B3 · P3 배치 + I01 자료 경로). 기능설명서 1-② '하단 시간 슬라이더 +2시간 후 · 🔮 예측' 의 자리.
//
//   · 데스크톱: 지도 빈 자리(오른쪽 추천 패널을 뺀 곳) 아래 가운데의 판. 휴대폰: 카드 미리보기 바로 위 한 줄.
//     자리는 부모(app/main/page.tsx)가 정한다 — 이 컴포넌트는 판 하나만 그린다.
//   · 네 칸 트랙(지금 | +1시간 후 | +2시간 후 | +3시간 후) — 누르기 · 끌기 · 방향키. 끄는 동안은 칸만 따라오고,
//     손을 뗄 때 한 번 고른다(끄는 칸마다 예측을 부르지 않는다).
//   · '다른 시간 ▾' — 요일 프리셋(평일 12:00 · 금 18:00 · 토 14:00 · 일 11:00). 이 값은 /waiting·/course 와 나눈다.
//   · 예측을 받으면 등급색 배지 한 줄 + 범례. 범례는 등급이 칠해진 핀이 화면에 있거나 예측 중일 때만, 아니면
//     '지금 이 일대 … · 추정' 칩 하나(추정 피드가 있을 때만).
//   · 휴대폰은 배지를 따로 한 줄로 두지 않고 '🔮 혼잡 예측' 자리에 짧은 배지('🔮 여유 예측')를 둔다. 키 낮은 휴대폰
//     (높이 720 미만)은 범례 줄도 감춘다 — 360×640 의 지도 띠(180px 이상, 계획 3.2)가 예측 중에도 남게(리뷰 10-07).
//   · 768~1023px(태블릿 · 좁은 창)는 휴대폰 글자 크기를 쓴다 — 칸 이름('+1시간 후')이 좁은 트랙에서 겹치지 않게.
// 자료를 부르지 않는다 — 고른 값만 부모에 알린다(lib/forecastStrip.ts 가 규칙).
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronDown, Clock3 } from 'lucide-react';
import { useT } from '@/lib/i18n/I18nProvider';
import { FORECAST_STOPS, clampForecastHours, type ForecastHours } from '@/lib/forecastStrip';
import { PIN_GRADE_COLORS, RANK_BADGE } from '@/lib/map/markerSvg';
import type { CongestionKey } from '@/lib/congestionScale';

const GRADES: CongestionKey[] = ['quiet', 'relaxed', 'moderate', 'busy'];

const BADGE_TONE: Record<CongestionKey, string> = {
  quiet: 'benefit-quiet',
  relaxed: 'benefit-relaxed',
  moderate: 'border-gold/45 bg-gold/15 text-gold-deep',
  busy: 'border-terracotta/40 bg-terracotta/10 text-terracotta',
};

export interface ForecastPreset {
  id: string;
  label: string;
}

export interface ForecastTimeStripProps {
  /** 트랙에서 고른 칸(0 = 지금). 요일 프리셋이 걸려 있으면 트랙은 아무 칸도 칠하지 않는다. */
  hours: ForecastHours;
  /** 예측을 받는 중(고른 칸에 도는 표시). */
  loading: boolean;
  /** 걸려 있는 요일 프리셋 id('now' 면 없음). */
  presetId: string;
  /** 요일 프리셋('지금' 제외). */
  presets: ForecastPreset[];
  onSelectHours: (hours: ForecastHours) => void;
  onSelectPreset: (id: string) => void;
  /** 예측 배지(등급색). 없으면 그리지 않는다. short = 휴대폰 줄 안의 짧은 배지('🔮 여유 예측'). */
  badge: { text: string; short: string; grade: CongestionKey | null } | null;
  /** 범례 — 보일 때만 제목을 준다. 예측 중이면 dashed. */
  legend: { title: string; dashed: boolean } | null;
  /** 칠한 핀이 없을 때의 '지금 이 일대 … · 추정' 칩. */
  areaChip: string | null;
  /** /main?focus=forecast — 소개 화면 바로가기로 왔을 때 판에 고리. */
  ringed?: boolean;
  className?: string;
}

export default function ForecastTimeStrip({
  hours,
  loading,
  presetId,
  presets,
  onSelectHours,
  onSelectPreset,
  badge,
  legend,
  areaChip,
  ringed = false,
  className = '',
}: ForecastTimeStripProps) {
  const t = useT();
  const trackRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [dragStop, setDragStop] = useState<ForecastHours | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const presetActive = presetId !== 'now';
  const activePreset = presets.find((preset) => preset.id === presetId) ?? null;
  // 칠할 칸 — 끄는 중이면 손가락 밑 칸, 아니면 고른 칸. 요일 프리셋이 걸려 있으면 비운다.
  const shown: ForecastHours | null = dragStop ?? (presetActive ? null : hours);
  const label = (h: number) => (h === 0 ? t('forecast.now') : t('forecast.ahead', { h }));
  // 휴대폰 칸(약 46px)에 들어가는 짧은 이름 — 일·중은 '後/后' 를 뺀다(리뷰 10-07 화면: '+1時間後+2時間後' 가 칸을 넘쳐 겹쳤다).
  // 한국어·영어는 원래 이름이 들어가 짧은 이름이 같다 — 그때는 한 덩어리만 그린다(글자로 찾는 시험이 둘을 만나지 않게).
  const shortLabel = (h: number) => (h === 0 ? t('forecast.now') : t('forecast.aheadShort', { h }));

  const stopAt = (clientX: number): ForecastHours => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return hours;
    return clampForecastHours(Math.floor(((clientX - rect.left) / rect.width) * FORECAST_STOPS.length - 1e-9));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 일부 브라우저 — 끌기만 덜 매끄럽다 */ }
    setDragStop(stopAt(event.clientX));
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStop === null) return;
    const next = stopAt(event.clientX);
    if (next !== dragStop) setDragStop(next);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStop === null) return;
    const next = stopAt(event.clientX);
    setDragStop(null);
    onSelectHours(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = presetActive ? 0 : hours;
    const next = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? Math.min(3, from + 1)
      : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? Math.max(0, from - 1)
        : event.key === 'Home' ? 0
          : event.key === 'End' ? 3
            : null;
    if (next === null) return;
    event.preventDefault();
    onSelectHours(clampForecastHours(next));
  };

  // 메뉴 — 바깥을 누르거나 Esc 로 닫는다.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <section
      data-testid="forecast-strip"
      data-focus-target="forecast"
      aria-label={t('forecast.name')}
      className={`pointer-events-auto w-full rounded-2xl border border-line bg-white px-2 py-1.5 shadow-[0_6px_22px_rgba(43,35,32,0.16)] md:px-3 md:py-2 ${ringed ? 'ring-4 ring-gold ring-offset-2 ring-offset-hanji' : ''} ${className}`}
    >
      {badge && (
        <p
          data-testid="forecast-badge"
          role="status"
          className={`mb-1.5 flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-[13px] font-extrabold leading-snug max-md:hidden md:text-[15px] ${badge.grade ? BADGE_TONE[badge.grade] : 'border-line bg-hanji-deep text-muk'}`}
        >
          {badge.grade && (
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full border border-dashed border-white" style={{ backgroundColor: PIN_GRADE_COLORS[badge.grade].base }} />
          )}
          <span className="min-w-0 break-keep">{badge.text}</span>
        </p>
      )}
      <div className="flex items-center gap-1.5 md:gap-2.5">
        <span className={`shrink-0 whitespace-nowrap text-[11px] font-extrabold text-muk lg:text-[14px] ${badge ? 'max-md:hidden' : ''}`}>{t('forecast.title')}</span>
        {badge && (
          // 휴대폰: 배지 줄 대신 이 자리에 짧은 배지(등급색) — 줄 높이가 늘지 않는다. 읽는 이름은 긴 배지 그대로.
          <span
            data-testid="forecast-badge-short"
            role="status"
            title={badge.text}
            className={`shrink-0 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[11px] font-extrabold leading-tight md:hidden ${badge.grade ? BADGE_TONE[badge.grade] : 'border-line bg-hanji-deep text-muk'}`}
          >
            <span aria-hidden>{badge.short}</span>
            <span className="sr-only">{badge.text}</span>
          </span>
        )}
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label={t('forecast.name')}
          aria-valuemin={0}
          aria-valuemax={3}
          aria-valuenow={presetActive ? 0 : hours}
          aria-valuetext={activePreset ? activePreset.label : label(hours)}
          aria-busy={loading || undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDragStop(null)}
          onKeyDown={onKeyDown}
          data-testid="forecast-track"
          className="relative grid min-w-0 flex-1 cursor-pointer touch-none select-none grid-cols-4 rounded-full bg-hanji-deep p-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/70"
        >
          {shown !== null && (
            <span
              aria-hidden
              className="absolute inset-y-0.5 rounded-full bg-muk shadow-sm transition-[left] duration-150"
              style={{ left: `calc(${shown * 25}% + 2px)`, width: 'calc(25% - 4px)' }}
            />
          )}
          {FORECAST_STOPS.map((h) => (
            <span
              key={h}
              data-stop={h}
              className={`relative z-10 flex items-center justify-center gap-1 whitespace-nowrap px-1 py-1.5 text-center text-[11px] font-bold leading-none md:py-2 lg:text-[13px] ${shown === h ? 'text-hanji' : 'text-muk-soft'}`}
            >
              {loading && shown === h && h > 0 && (
                <span aria-hidden className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-hanji/40 border-t-hanji" />
              )}
              {shortLabel(h) === label(h) ? label(h) : (
                <>
                  <span className="max-md:hidden">{label(h)}</span>
                  <span className="md:hidden">{shortLabel(h)}</span>
                </>
              )}
            </span>
          ))}
        </div>
        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-label={activePreset ? `${t('forecast.otherTimes')}: ${activePreset.label}` : t('forecast.otherTimes')}
            data-testid="forecast-other-times"
            className={`flex h-8 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[12px] font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 md:h-9 lg:px-3 lg:text-[13px] ${presetActive ? 'border-gold bg-gold/15 text-gold-deep' : 'border-line bg-white text-muk-soft hover:text-muk'}`}
          >
            <Clock3 size={14} aria-hidden className="shrink-0" />
            <span className="max-lg:sr-only">{activePreset ? activePreset.label : t('forecast.otherTimes')}</span>
            <ChevronDown size={14} aria-hidden className="shrink-0" />
          </button>
          {menuOpen && (
            <div
              id={menuId}
              role="menu"
              aria-label={t('forecast.otherTimes')}
              className="absolute bottom-full right-0 z-30 mb-2 w-44 rounded-2xl border border-line bg-white p-1 shadow-[0_10px_30px_rgba(43,35,32,0.2)]"
            >
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={preset.id === presetId}
                  onClick={() => { setMenuOpen(false); onSelectPreset(preset.id); }}
                  className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] font-bold ${preset.id === presetId ? 'bg-gold/15 text-gold-deep' : 'text-muk hover:bg-hanji-deep'}`}
                >
                  {preset.label}
                  {preset.id === presetId && <span aria-hidden>✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {(legend || areaChip) && (
        // 휴대폰은 예측 중일 때만 범례 줄을 둔다 — 지금 모드의 범례·이 일대 칩까지 올리면 360×640 에서 지도 띠가 모자란다.
        // 키 낮은 휴대폰은 예측 중에도 감춘다(짧은 배지가 등급을 말하고, 지도 띠 180px 을 지킨다).
        <div className={`mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 px-1 text-[11px] font-bold text-muk-soft ${legend?.dashed ? 'short:max-md:hidden' : 'max-md:hidden'}`} data-testid="forecast-legend">
          {legend ? (
            <>
              <span className="text-muk">{legend.title}</span>
              {GRADES.map((grade) => (
                <span key={grade} className="flex items-center gap-1">
                  <span
                    aria-hidden
                    className={`h-2.5 w-2.5 rounded-full ${legend.dashed ? 'outline outline-1 outline-dashed outline-offset-1 outline-muk/40' : ''}`}
                    style={{ backgroundColor: PIN_GRADE_COLORS[grade].base }}
                  />
                  {t(`congestion.${grade}`)}
                </span>
              ))}
              <span className="flex items-center gap-1" data-testid="forecast-legend-pick">
                {legend.dashed ? (
                  // 예측 중의 순위 핀은 금색 고리가 아니라 번호 원 + 흰 점선 고리다 — 범례도 그 모양(리뷰 10-07).
                  <span
                    aria-hidden
                    data-swatch="rank-dashed"
                    className="flex h-3.5 w-3.5 items-center justify-center rounded-full text-[8px] font-black leading-none outline outline-1 outline-dashed outline-offset-1 outline-muk/40"
                    style={{ backgroundColor: RANK_BADGE.fill, color: RANK_BADGE.text }}
                  >
                    1
                  </span>
                ) : (
                  <span aria-hidden data-swatch="gold-ring" className="h-2.5 w-2.5 rounded-full border-2 border-gold bg-white" />
                )}
                {t('forecast.legendPick')}
              </span>
            </>
          ) : (
            <span data-testid="forecast-area-chip" className="rounded-full border border-dashed border-line bg-hanji-deep px-2 py-0.5 text-muk">{areaChip}</span>
          )}
        </div>
      )}
    </section>
  );
}
