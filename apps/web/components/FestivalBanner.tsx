'use client';

// 경주 축제/행사 칩 + 바텀시트 (TourAPI searchFestival2 → GET /api/v1/events).
//
// 동작: 마운트 시 목록을 한 번 가져와(세션 캐시 6h) 축제가 있으면 "🏮 축제 N" 칩을 노출,
//   탭하면 바텀시트로 전체 목록(포스터·기간·주소·전화·카카오맵 링크)을 보여준다.
//   백엔드 다운·키 미설정(source=unavailable)·0건이면 칩 자체를 렌더하지 않는다(무해 폴백).
// 배치: 메인 지도 상단 레이어 컨트롤 행(히트맵 토글 옆)에 마운트 — 지도 앱의 행사 배너 관례.
// 팔레트·모달 관례는 CongestionReportButton 을 따른다(한지 웜톤 + body 포털 + framer-motion).

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { CalendarDays, MapPin, Phone, X, ExternalLink } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useT } from '@/lib/i18n/I18nProvider';

interface FestivalEvent {
  contentId: string;
  title: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  address?: string | null;
  imageUrl?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  tel?: string | null;
  isOngoing: boolean;
}

// 세션 캐시 — 지도 재방문마다 백엔드/TourAPI 를 다시 두드리지 않는다(백엔드 24h 캐시와 별개의 프런트 절약).
const CACHE_KEY = 'nextspot_events_v1';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function readCache(): FestivalEvent[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { at, events } = JSON.parse(raw);
    if (typeof at !== 'number' || Date.now() - at > CACHE_TTL_MS || !Array.isArray(events)) return null;
    return events;
  } catch {
    return null;
  }
}

// "2026-10-09" → "10.09" (연도는 기간 표기에서 생략 — 관광객 UI 는 올해/내년 축제만 다룬다)
function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return m && d ? `${m}.${d}` : iso;
}

export function FestivalBanner({ className = '' }: { className?: string }) {
  const t = useT();
  const [events, setEvents] = useState<FestivalEvent[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [mounted, setMounted] = useState(false); // 포털은 클라이언트 마운트 후에만(정적 export 안전)
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const cached = readCache();
    if (cached) {
      setEvents(cached);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiClient.get('/api/v1/events');
        if (cancelled || res?.source !== 'tourapi' || !Array.isArray(res.events)) return;
        setEvents(res.events);
        try {
          sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), events: res.events }));
        } catch { /* 시크릿 모드 등 저장 실패는 무시 */ }
      } catch {
        // 백엔드 다운/네트워크 오류 — 축제는 부가 정보라 조용히 숨긴다(칩 미노출).
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);

  if (events.length === 0) return null;

  return (
    <>
      {/* 트리거 칩 — 히트맵 토글과 동일 문법(pill + fractal-glass). 진행 중 축제가 있으면 점 펄스. */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-haspopup="dialog"
        aria-label={t('festival.chipAria', { n: String(events.length) })}
        className={`flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-[13px] font-medium transition-all fractal-glass shadow-[0_2px_14px_rgba(43,35,32,0.06)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 sm:px-4 sm:py-2 sm:text-sm bg-white/80 border-line text-muk-soft hover:bg-white hover:text-muk ${className}`}
      >
        <span aria-hidden>🏮</span>
        {t('festival.chip')}
        <span className={`min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center ${
          events.some((ev) => ev.isOngoing) ? 'bg-terracotta text-white' : 'bg-gold/20 text-gold-deep'
        }`}>
          {events.length}
        </span>
      </button>

      {/* 목록 바텀시트 — body 포털(상단 오버레이 pointer-events-none 조상 탈출). */}
      {mounted && createPortal(
        <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center"
          >
            <button
              type="button"
              aria-label={t('common.close')}
              tabIndex={-1}
              onClick={() => setIsOpen(false)}
              className="absolute inset-0 bg-muk/40 backdrop-blur-sm"
            />

            <motion.div
              initial={{ y: 40, opacity: 0, scale: 0.98 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 40, opacity: 0, scale: 0.98 }}
              transition={{ type: 'spring', bounce: 0.25, duration: 0.5 }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="festival-sheet-title"
              className="relative w-full max-w-sm max-h-[80dvh] bg-hanji border border-line rounded-t-3xl sm:rounded-3xl shadow-[0_-8px_40px_rgba(43,35,32,0.2)] sm:shadow-[0_20px_60px_rgba(43,35,32,0.25)] flex flex-col overflow-hidden"
            >
              <div className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-transparent via-gold/60 to-transparent" />

              {/* 헤더 */}
              <div className="flex items-start justify-between gap-3 p-6 pb-4">
                <div>
                  <h2 id="festival-sheet-title" className="text-lg font-serif font-bold text-muk leading-tight">
                    🏮 {t('festival.title')}
                  </h2>
                  <p className="text-[11px] text-muk-soft mt-1 font-medium">{t('festival.subtitle')}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  aria-label={t('common.close')}
                  className="p-1.5 rounded-full text-muk-soft hover:text-muk hover:bg-hanji-deep transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                >
                  <X size={18} />
                </button>
              </div>

              {/* 목록 */}
              <div className="flex-1 overflow-y-auto px-4 pb-6 flex flex-col gap-3">
                {events.map((ev) => (
                  <div key={ev.contentId} className="rounded-2xl border border-line bg-white/70 overflow-hidden">
                    {ev.imageUrl && (
                      /* TourAPI 포스터 원본은 도메인이 다양해 next/image 최적화 대상이 아님(정적 export) — img 사용 */
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={ev.imageUrl} alt={ev.title} loading="lazy" className="w-full h-32 object-cover" />
                    )}
                    <div className="p-4 flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          ev.isOngoing ? 'bg-terracotta/15 text-terracotta' : 'bg-jade/15 text-jade'
                        }`}>
                          {ev.isOngoing ? t('festival.ongoing') : t('festival.upcoming')}
                        </span>
                        <span className="flex items-center gap-1 text-[11px] text-muk-soft font-medium">
                          <CalendarDays size={12} aria-hidden />
                          {shortDate(ev.startDate)} ~ {shortDate(ev.endDate)}
                        </span>
                      </div>
                      <p className="text-sm font-bold text-muk leading-snug">{ev.title}</p>
                      {ev.address && (
                        <p className="flex items-start gap-1 text-[11px] text-muk-soft leading-snug">
                          <MapPin size={12} className="mt-0.5 shrink-0" aria-hidden />
                          {ev.address}
                        </p>
                      )}
                      <div className="flex items-center gap-2 pt-1">
                        {ev.latitude != null && ev.longitude != null && (
                          <a
                            href={`https://map.kakao.com/link/map/${encodeURIComponent(ev.title)},${ev.latitude},${ev.longitude}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-gold/10 hover:bg-gold/20 border border-gold/30 text-gold-deep text-[11px] font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                          >
                            <ExternalLink size={11} aria-hidden />
                            {t('festival.openMap')}
                          </a>
                        )}
                        {ev.tel && (
                          <a
                            href={`tel:${ev.tel.replace(/[^\d+-]/g, '')}`}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-hanji-deep hover:bg-jade/10 border border-line hover:border-jade/40 text-muk-soft hover:text-jade text-[11px] font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                          >
                            <Phone size={11} aria-hidden />
                            {t('festival.call')}
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

export default FestivalBanner;
