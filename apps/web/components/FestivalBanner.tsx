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
import { useI18n } from '@/lib/i18n/I18nProvider';

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
  // 상세 조합(퀵윈 C3) — 전부 Optional, 진행 중 축제만 채워진다(백엔드 무해 폴백).
  // 백엔드는 snake_case(event_place/usetime_festival)라 apiClient 의 keysToCamel 이
  // eventPlace/usetimeFestival 로 정상 변환하지만, 레포 함정(다른 화면에서 camel/snake 이중
  // 표기가 실제로 갈렸던 전례) 방어로 원시 표기(eventplace/usetimefestival)도 타입에 남겨
  // 아래 getter 들이 둘 다 인식하게 한다.
  overview?: string | null;
  homepage?: string | null; // href 원문(HTML anchor 조각일 수 있음) — extractHomepageUrl 로 추출
  playtime?: string | null;
  eventPlace?: string | null;
  eventplace?: string | null;
  usetimeFestival?: string | null;
  usetimefestival?: string | null;
  // P1-4 다국어 요약 — 진행 중 + overview 보유 축제만 백엔드가 채운다(무해 폴백: 부재 시 원문).
  //   overviewI18n: {en,ja,zh} AI 요약·번역(백엔드 캐시 히트분만 — 부분 채택 가능).
  //   summaryLlmStatus: LLM 관찰 필드 — 'nextspot:llm-debug' CustomEvent 발행용.
  overviewI18n?: Record<string, string> | null;
  summaryLlmStatus?: string | null;
}

// camel/snake 이중 표기 방어 — 필드명이 어느 쪽으로 오든 값을 잃지 않는다.
function eventPlaceOf(ev: FestivalEvent): string | null {
  return ev.eventPlace ?? ev.eventplace ?? null;
}
function usetimeFestivalOf(ev: FestivalEvent): string | null {
  return ev.usetimeFestival ?? ev.usetimefestival ?? null;
}

// TourAPI homepage 원문은 순수 URL 또는 '<a href="...">...</a>' HTML 조각일 수 있어 첫
// http(s) URL 만 방어적으로 추출(RecommendationCard 의 기존 homepage 정규식 패턴 재사용).
function extractHomepageUrl(raw?: string | null): string | null {
  if (!raw) return null;
  return String(raw).match(/https?:\/\/[^\s"'<>]+/)?.[0] ?? null;
}

const OVERVIEW_CLAMP_THRESHOLD = 90;

// LLM 동작 디버그 배지 — lib/api-client.ts / lib/admin-api.ts 가 발행하는 'nextspot:llm-debug'
// CustomEvent 와 동일 메커니즘(components/LlmDebugToast.tsx 가 구독 — 라벨은 오케스트레이터가 추가).
// 백엔드가 summary_llm_status 를 아직 안 주는 구버전 응답이면 발행하지 않는다(방어적).
// 어떤 예외도 조용히 무시 — 디버그 배지는 절대 주 기능(축제 목록)을 방해하지 않는다.
function dispatchFestivalLlmDebug(events: FestivalEvent[]): void {
  if (typeof window === 'undefined') return;
  const status = events.find((ev) => ev.summaryLlmStatus)?.summaryLlmStatus;
  if (!status) return;
  try {
    window.dispatchEvent(new CustomEvent('nextspot:llm-debug', { detail: { feature: 'festival', status } }));
  } catch {
    // CustomEvent 미지원 등 — 무시
  }
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

export function FestivalBanner({ className = '', onFocus }: {
  className?: string;
  // 축제 1건을 지도에 표시(핀/영역)하도록 부모에 위임. 제공되면 카드 전체가 클릭 대상이 된다(카드 아무 곳이나 누르면 표시).
  onFocus?: (ev: FestivalEvent) => void;
}) {
  const { t, locale } = useI18n();
  const [events, setEvents] = useState<FestivalEvent[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [mounted, setMounted] = useState(false); // 포털은 클라이언트 마운트 후에만(정적 export 안전)
  useEffect(() => setMounted(true), []);
  const [expandedOverviewIds, setExpandedOverviewIds] = useState<Set<string>>(new Set());
  const toggleOverview = (contentId: string) => {
    setExpandedOverviewIds((prev) => {
      const next = new Set(prev);
      if (next.has(contentId)) next.delete(contentId);
      else next.add(contentId);
      return next;
    });
  };
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
        dispatchFestivalLlmDebug(res.events); // 응답 파싱 직후 중앙 발행(api-client 관례 미러)
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
              className="relative flex h-[88vh] h-[88dvh] w-full max-w-sm flex-col overflow-hidden rounded-t-3xl border border-line bg-hanji shadow-[0_-8px_40px_rgba(43,35,32,0.2)] sm:h-[82vh] sm:h-[82dvh] sm:rounded-3xl sm:shadow-[0_20px_60px_rgba(43,35,32,0.25)]"
            >
              <div className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-transparent via-gold/60 to-transparent" />

              {/* 헤더 */}
              <div className="flex shrink-0 items-start justify-between gap-3 p-6 pb-4">
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

              {/* 목록 — min-h-0 필수: flex 자식의 기본 min-height:auto 때문에 축소되지 못하면
                  부모 overflow-hidden 이 하단을 잘라내고 스크롤도 안 된다(콘텐츠 잘림 버그의 원인).
                  하단 패딩은 safe-area 를 더해 홈 인디케이터/노치 영역에서 마지막 카드가 가리지 않게 한다. */}
              <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] flex flex-col gap-3">
                {events.map((ev) => {
                  // 카드 아무 곳이나 누르면 지도에 표시(canFocus). 접근성: 카드 <div> 를 role=button 으로
                  // 만들면 내부 링크(카카오맵/전화)가 '버튼 안의 링크'(nested-interactive) 무효 구조가 된다.
                  // 대신 카드를 덮는 실제 <button>(스트레치드, inset-0)을 형제로 두고 링크는 그 위(z-10)에
                  // 올려, 카드 클릭=지도 표시 / 링크=각자 동작 을 접근성 트리 위반 없이 분리한다.
                  const canFocus = !!onFocus && ev.latitude != null && ev.longitude != null;
                  const focusCard = () => { if (canFocus) { onFocus!(ev); setIsOpen(false); } };
                  return (
                  <div
                    key={ev.contentId}
                    className={`group relative shrink-0 rounded-2xl border border-line bg-white/70 overflow-hidden transition-colors ${canFocus ? 'hover:bg-gold/5 hover:border-gold/40' : ''}`}
                  >
                    {canFocus && (
                      <button
                        type="button"
                        onClick={focusCard}
                        aria-label={t('festival.showOnMapAria', { title: ev.title })}
                        className="absolute inset-0 z-0 cursor-pointer rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                      />
                    )}
                    {ev.imageUrl && (
                      /* TourAPI 포스터 원본은 도메인이 다양해 next/image 최적화 대상이 아님(정적 export) — img 사용 */
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={ev.imageUrl} alt={ev.title} loading="lazy" className="w-full h-24 object-cover" />
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

                      {/* 상세 조합(퀵윈 C3) — 값 없는 필드는 행 자체 생략('지어내지 않기'). */}
                      {ev.overview && (() => {
                        const isExpanded = expandedOverviewIds.has(ev.contentId);
                        // P1-4: 비-ko 로케일은 캐시된 AI 요약(overviewI18n)을 우선 표시하고, 필드 부재
                        // (캐시 미적재·구버전 응답)면 기존 한국어 원문 폴백(무해). ko 는 항상 원문.
                        // 표시 우선순위는 docs/TOURAPI_EXPANSION.md 4-4 — 공식 해당 언어 > 공식 한국어
                        // 원문 > 명시된 AI 번역. 공식 다국어 자매 서비스(2-1) 적재가 후속 정본이며,
                        // 그때까지 이 요약은 'AI 요약·번역' 라벨(festival.aiSummary)로 명시한다.
                        const aiSummary = locale !== 'ko' ? (ev.overviewI18n?.[locale] ?? null) : null;
                        const overviewText = aiSummary ?? ev.overview;
                        return (
                          <div className="text-[11px] leading-snug">
                            <span className="mb-0.5 flex items-center gap-1.5 text-[10px] font-bold text-muk-soft">
                              {t('festival.about')}
                              {aiSummary && (
                                <span className="rounded-full border border-gold/30 bg-gold/10 px-1.5 py-px text-[9px] font-bold text-gold-deep">
                                  {t('festival.aiSummary')}
                                </span>
                              )}
                            </span>
                            <p className={`whitespace-pre-line break-words text-muk-soft leading-relaxed ${isExpanded ? '' : 'line-clamp-3'}`}>
                              {overviewText}
                            </p>
                            {overviewText.length > OVERVIEW_CLAMP_THRESHOLD && (
                              <button
                                type="button"
                                onClick={() => toggleOverview(ev.contentId)}
                                className="relative z-10 mt-1 rounded text-[11px] font-bold text-gold-deep hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                              >
                                {isExpanded ? t('festival.showLess') : t('festival.showMore')}
                              </button>
                            )}
                          </div>
                        );
                      })()}
                      {ev.address && (
                        <p className="flex items-start gap-1 whitespace-pre-line break-words text-[11px] text-muk-soft leading-snug">
                          <MapPin size={12} className="mt-0.5 shrink-0" aria-hidden />
                          {ev.address}
                        </p>
                      )}
                      {eventPlaceOf(ev) && (
                        <p className="flex items-start gap-1 whitespace-pre-line break-words text-[11px] text-muk-soft leading-snug">
                          <span aria-hidden>📍</span>
                          {eventPlaceOf(ev)}
                        </p>
                      )}
                      {ev.playtime && (
                        <p className="flex items-start gap-1 whitespace-pre-line break-words text-[11px] text-muk-soft leading-snug">
                          <span aria-hidden>🕐</span>
                          {ev.playtime}
                        </p>
                      )}
                      {usetimeFestivalOf(ev) && (
                        <p className="flex items-start gap-1 whitespace-pre-line break-words text-[11px] text-muk-soft leading-snug">
                          <span aria-hidden>💰</span>
                          {usetimeFestivalOf(ev)}
                        </p>
                      )}

                      {/* 스트레치드 버튼 위에 뜨는 링크 — relative z-10 으로 카드 클릭보다 위. 각자 독립 동작. */}
                      <div className="relative z-10 flex flex-wrap items-center gap-2 pt-1">
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
                        {extractHomepageUrl(ev.homepage) && (
                          <a
                            href={extractHomepageUrl(ev.homepage)!}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-hanji-deep hover:bg-gold/10 border border-line hover:border-gold/40 text-muk-soft hover:text-gold-deep text-[11px] font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                          >
                            <ExternalLink size={11} aria-hidden />
                            {t('festival.homepage')}
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
                  );
                })}
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
