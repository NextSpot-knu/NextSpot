'use client';

// 경주 축제/행사 칩 + 목록 패널 (TourAPI searchFestival2 → GET /api/v1/events).
//
// 동작: 마운트 시 목록을 한 번 가져와(세션 캐시 6h) "🏮 축제 N" 칩을 노출하고, 탭하면 패널로
//   전체 목록(행사명·기간·장소·거리·포스터·카카오맵 링크)을 보여준다. 백엔드 다운·키 미설정
//   (source=unavailable)이면 칩 자체를 렌더하지 않는다(무해 폴백). 응답은 받았는데 0건이면
//   칩은 남기고 패널에서 "현재 진행 중인 행사가 없어요"라고 말한다 — 눌렀을 때 아무 일도 없는
//   버튼은 심사에서 '고장'으로 기록된다.
//
// 패널 구현은 **RestroomChip 의 것을 그대로 따른다**(body 포털 + z-[1000] + 단순 div).
//   이전 구현은 framer-motion AnimatePresence + z-[60] 조합이었고, 실측에서 칩을 눌러도
//   시트가 열리지 않았다. 같은 화면의 화장실 패널은 문제없이 열리므로 이미 동작이 확인된 쪽의
//   구조를 복사해 변수를 없앤다.
// 배치: 메인 지도 상단 레이어 컨트롤 행(히트맵 토글 옆)에 마운트 — 지도 앱의 행사 배너 관례.
//
// 모양(variant) 셋 — 패널은 셋이 같다(2026-10-06 감사 I80):
//   chip(기본)   "🏮 축제 N" 칩. 위 동작 그대로(0건이어도 칩을 남긴다).
//   banner      포스터 + "🏮 지금 경주 축제 · 10.24까지" + 축제 이름 + 출처. 랜딩 '바로 시작' 아래.
//   compact     한 줄 "🏮 {축제 이름} · 10.24까지"(최대 16rem). 지도 툴바·폰 지도 위처럼 자리가 좁은 곳.
//   banner·compact 는 **진행 중인 축제가 있을 때만** 선다 — 없으면 자리째 숨는다(lib/festivalBanner.ts).
//   행사장까지의 거리·도보 시간은 배너에 적지 않는다(엑스포공원처럼 시내에서 7km 떨어진 축제가 많다).
// 요청은 화면당 한 번 — 여러 개가 마운트돼도(랜딩의 폰·데스크톱 배치, 지도의 툴바·시트) 모듈 하나의
// 진행 중 요청을 같이 기다리고, 받은 목록은 세션 캐시(6h)로 다음 화면(랜딩 → 지도)이 다시 쓴다.

import { useEffect, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronRight, MapPin, Phone, X, ExternalLink, Map as MapIcon } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { festivalBannerModel, festivalShortDate } from '@/lib/festivalBanner';
import { haversineMeters } from '@/lib/recommender';
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

// 한 화면에서 진행 중인 요청 하나를 모든 인스턴스가 같이 기다린다. 끝나면 비워 둔다 — 실패는 다음 화면이
// 다시 물을 수 있게, 성공은 세션 캐시가 이어받는다.
let inflight: Promise<FestivalEvent[] | null> | null = null;

function loadFestivalEvents(): Promise<FestivalEvent[] | null> {
  const cached = readCache();
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  const request = (async () => {
    try {
      const res = await apiClient.get('/api/v1/events');
      if (res?.source !== 'tourapi' || !Array.isArray(res.events)) return null;
      const events = res.events as FestivalEvent[];
      dispatchFestivalLlmDebug(events); // 응답 파싱 직후 중앙 발행(api-client 관례 미러)
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), events }));
      } catch { /* 시크릿 모드 등 저장 실패는 무시 */ }
      return events;
    } catch {
      // 백엔드 다운/네트워크 오류 — 축제는 부가 정보라 조용히 숨긴다(칩·배너 미노출).
      return null;
    }
  })();
  inflight = request;
  void request.finally(() => {
    if (inflight === request) inflight = null;
  });
  return request;
}

// 내 위치에서 행사장까지의 직선 거리. 좌표가 없으면 숫자를 지어내지 않고 표기 자체를 생략한다.
function distanceLabel(
  ev: FestivalEvent,
  location?: { lat: number; lng: number } | null,
): string | null {
  if (!location || ev.latitude == null || ev.longitude == null) return null;
  const meters = haversineMeters(location.lat, location.lng, ev.latitude, ev.longitude);
  if (!Number.isFinite(meters)) return null;
  return meters < 1000 ? `${Math.round(meters)}m` : `${(meters / 1000).toFixed(1)}km`;
}

export function FestivalBanner({ className = '', onFocus, location, variant = 'chip' }: {
  className?: string;
  // 축제 1건을 지도에 표시(핀/영역)하도록 부모에 위임. 제공되면 '지도에서 보기' 버튼이 뜬다.
  onFocus?: (ev: FestivalEvent) => void;
  // 거리 표기용 현재 위치(선택). 없으면 거리 표기만 빠진다.
  location?: { lat: number; lng: number } | null;
  // 트리거 모양 — 위 파일 머리 주석 참조. banner·compact 는 진행 중 축제가 없으면 아무것도 그리지 않는다.
  variant?: 'chip' | 'banner' | 'compact';
}) {
  const { t, locale } = useI18n();
  const [events, setEvents] = useState<FestivalEvent[]>([]);
  // TourAPI 응답을 실제로 받았는가. false 면 칩 자체를 감춘다(백엔드 다운·키 미설정).
  const [available, setAvailable] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  // 포스터가 깨지면(원본 도메인 차단·삭제) 등불 타일로 바꾼다 — 빈 이미지 상자를 남기지 않는다.
  const [posterFailed, setPosterFailed] = useState(false);
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
    let cancelled = false;
    void loadFestivalEvents().then((list) => {
      if (cancelled || !list) return;
      setEvents(list);
      setAvailable(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);

  if (!available) return null;
  // banner·compact 는 진행 중 축제가 있을 때만 — 없으면 자리째 숨긴다(빈 상태 문구를 세우지 않는다).
  const model = variant === 'chip' ? null : festivalBannerModel(events);
  if (variant !== 'chip' && !model) return null;

  let trigger: ReactElement;
  if (model && variant === 'banner') {
    const poster = !posterFailed ? model.first.imageUrl : null;
    trigger = (
      /* 배너 — 포스터 + "🏮 지금 경주 축제 · 10.24까지(· 외 N건)" + 축제 이름 + 출처. 누르면 같은 패널이 열린다. */
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-haspopup="dialog"
        aria-label={t('festival.bannerAria', { title: model.first.title })}
        className={`toss-pressable flex w-full max-w-[24rem] items-center gap-3 rounded-2xl border border-terracotta/35 bg-white/90 py-2 pl-2 pr-3 text-left shadow-[0_4px_18px_rgba(43,35,32,0.08)] hover:border-terracotta/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${className}`}
      >
        {poster ? (
          /* TourAPI 포스터 원본은 도메인이 다양해 next/image 최적화 대상이 아님(정적 export) — img 사용 */
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt="" onError={() => setPosterFailed(true)} className="h-12 w-12 shrink-0 rounded-xl object-cover" />
        ) : (
          <span aria-hidden className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-terracotta/10 text-xl">🏮</span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-1.5 text-[12px] font-bold leading-snug text-terracotta">
            <span><span aria-hidden>🏮 </span>{t('festival.bannerLabel')}</span>
            <span className="font-semibold text-muk-soft">· {t('festival.bannerUntil', { date: festivalShortDate(model.first.endDate) })}</span>
            {model.moreCount > 0 && (
              <span className="font-semibold text-muk-soft">· {t('festival.bannerMore', { n: String(model.moreCount) })}</span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-[14px] font-bold leading-snug text-muk">{model.first.title}</span>
          <span className="block text-[11px] leading-snug text-muk-soft">{t('festival.bannerCredit')}</span>
        </span>
        <ChevronRight size={16} aria-hidden className="shrink-0 text-muk-soft" />
      </button>
    );
  } else if (model) {
    trigger = (
      /* 한 줄 — 자리가 좁은 곳용. 출처는 열리는 패널 머리에 있다. */
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-haspopup="dialog"
        aria-label={t('festival.bannerAria', { title: model.first.title })}
        className={`toss-pressable flex min-w-0 max-w-[16rem] shrink items-center gap-1.5 rounded-full border border-terracotta/35 bg-white/90 px-3 py-1.5 text-[12px] font-semibold text-muk shadow-[0_2px_10px_rgba(43,35,32,0.06)] hover:border-terracotta/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${className}`}
      >
        <span aria-hidden>🏮</span>
        <span className="truncate">{model.first.title}</span>
        <span className="shrink-0 text-muk-soft">· {t('festival.bannerUntil', { date: festivalShortDate(model.first.endDate) })}</span>
      </button>
    );
  } else {
    trigger = (
      /* 트리거 칩 — 히트맵 토글과 동일 문법(pill + fractal-glass). 진행 중 축제가 있으면 붉은 배지. */
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-haspopup="dialog"
        aria-label={t('festival.chipAria', { n: String(events.length) })}
        className={`flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-[13px] font-medium transition-all fractal-glass shadow-[0_2px_14px_rgba(43,35,32,0.06)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 sm:px-4 sm:py-2 sm:text-sm bg-white/80 border-line text-muk-soft hover:bg-white hover:text-muk ${className}`}
      >
        <span aria-hidden>🏮</span>
        {t('festival.chip')}
        {events.length > 0 && (
          <span className={`min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center ${
            events.some((ev) => ev.isOngoing) ? 'bg-terracotta text-white' : 'bg-gold/20 text-gold-deep'
          }`}>
            {events.length}
          </span>
        )}
      </button>
    );
  }

  return (
    <>
      {trigger}

      {/* 목록 패널 — body 포털(상단 오버레이 pointer-events-none 조상 탈출) + z-[1000].
          구조·z-index 는 동작이 확인된 RestroomChip 패널과 동일하게 유지한다. */}
      {isOpen && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[1000] flex items-end justify-center bg-black/30"
          onClick={() => setIsOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="festival-sheet-title"
            className="max-h-[78vh] w-full max-w-lg overflow-y-auto overscroll-contain rounded-t-3xl bg-hanji p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 id="festival-sheet-title" className="font-serif text-lg font-bold text-muk">
                  🏮 {t('festival.title')}
                </h2>
                {/* 공모전 규정: 공사 데이터가 흐르는 화면에는 ⓒ 출처 표기가 항상 보인다. */}
                <p className="text-xs text-muk-soft">{t('festival.subtitle')}</p>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                aria-label={t('common.close')}
                className="rounded-full p-2 text-muk-soft hover:bg-hanji-deep hover:text-muk"
              >
                <X size={18} />
              </button>
            </div>

            {events.length === 0 ? (
              <p className="rounded-2xl border border-line bg-white/70 px-4 py-6 text-center text-sm font-semibold text-muk-soft">
                {t('compare.festivalEmpty')}
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {events.map((ev) => {
                  const place = eventPlaceOf(ev) ?? ev.address ?? null;
                  const distance = distanceLabel(ev, location);
                  const canFocus = !!onFocus && ev.latitude != null && ev.longitude != null;
                  const homepage = extractHomepageUrl(ev.homepage);
                  return (
                    <div key={ev.contentId} className="overflow-hidden rounded-2xl border border-line bg-white/70">
                      {ev.imageUrl && (
                        /* TourAPI 포스터 원본은 도메인이 다양해 next/image 최적화 대상이 아님(정적 export) — img 사용 */
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={ev.imageUrl} alt={ev.title} loading="lazy" className="h-24 w-full object-cover" />
                      )}
                      <div className="flex flex-col gap-2 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            ev.isOngoing ? 'bg-terracotta/15 text-terracotta' : 'bg-jade/15 text-jade'
                          }`}>
                            {ev.isOngoing ? t('festival.ongoing') : t('festival.upcoming')}
                          </span>
                          {/* 기간 */}
                          <span className="flex items-center gap-1 text-[11px] font-medium text-muk-soft">
                            <CalendarDays size={12} aria-hidden />
                            {festivalShortDate(ev.startDate)} ~ {festivalShortDate(ev.endDate)}
                          </span>
                          {/* 거리 — 좌표가 있을 때만 */}
                          {distance && (
                            <span className="flex items-center gap-1 text-[11px] font-bold text-gold">
                              <MapPin size={12} aria-hidden />{distance}
                            </span>
                          )}
                        </div>

                        {/* 행사명 */}
                        <p className="text-sm font-bold leading-snug text-muk">{ev.title}</p>

                        {/* 장소 */}
                        {place && (
                          <p className="flex items-start gap-1 whitespace-pre-line break-words text-[11px] leading-snug text-muk-soft">
                            <MapPin size={12} className="mt-0.5 shrink-0" aria-hidden />
                            {place}
                          </p>
                        )}
                        {ev.playtime && (
                          <p className="flex items-start gap-1 whitespace-pre-line break-words text-[11px] leading-snug text-muk-soft">
                            <span aria-hidden>🕐</span>
                            {ev.playtime}
                          </p>
                        )}
                        {usetimeFestivalOf(ev) && (
                          <p className="flex items-start gap-1 whitespace-pre-line break-words text-[11px] leading-snug text-muk-soft">
                            <span aria-hidden>💰</span>
                            {usetimeFestivalOf(ev)}
                          </p>
                        )}

                        {/* 소개 — 값 없는 필드는 행 자체 생략('지어내지 않기'). */}
                        {ev.overview && (() => {
                          const isExpanded = expandedOverviewIds.has(ev.contentId);
                          // P1-4: 비-ko 로케일은 캐시된 AI 요약(overviewI18n)을 우선 표시하고, 필드 부재면
                          // 한국어 원문 폴백(무해). 표기 우선순위는 docs/archive/TOURAPI_EXPANSION.md 4-4.
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
                              <p className={`whitespace-pre-line break-words leading-relaxed text-muk-soft ${isExpanded ? '' : 'line-clamp-3'}`}>
                                {overviewText}
                              </p>
                              {overviewText.length > OVERVIEW_CLAMP_THRESHOLD && (
                                <button
                                  type="button"
                                  onClick={() => toggleOverview(ev.contentId)}
                                  className="mt-1 rounded text-[11px] font-bold text-gold-deep hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                                >
                                  {isExpanded ? t('festival.showLess') : t('festival.showMore')}
                                </button>
                              )}
                            </div>
                          );
                        })()}

                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          {/* 지도에서 보기 — 우리 지도에 핀/영역으로 표시하고 패널을 닫는다(1초 안의 변화). */}
                          {canFocus && (
                            <button
                              type="button"
                              onClick={() => { onFocus!(ev); setIsOpen(false); }}
                              className="inline-flex items-center gap-1 rounded-full border border-gold/40 bg-gold/15 px-2.5 py-1.5 text-[11px] font-bold text-gold-deep transition-colors hover:bg-gold/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                            >
                              <MapIcon size={11} aria-hidden />
                              {t('compare.showOnMap')}
                            </button>
                          )}
                          {ev.latitude != null && ev.longitude != null && (
                            <a
                              href={`https://map.kakao.com/link/map/${encodeURIComponent(ev.title)},${ev.latitude},${ev.longitude}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 rounded-full border border-line bg-hanji-deep px-2.5 py-1.5 text-[11px] font-bold text-muk-soft transition-colors hover:border-gold/40 hover:text-gold-deep focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                            >
                              <ExternalLink size={11} aria-hidden />
                              {t('festival.openMap')}
                            </a>
                          )}
                          {homepage && (
                            <a
                              href={homepage}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 rounded-full border border-line bg-hanji-deep px-2.5 py-1.5 text-[11px] font-bold text-muk-soft transition-colors hover:border-gold/40 hover:text-gold-deep focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                            >
                              <ExternalLink size={11} aria-hidden />
                              {t('festival.homepage')}
                            </a>
                          )}
                          {ev.tel && (
                            <a
                              href={`tel:${ev.tel.replace(/[^\d+-]/g, '')}`}
                              className="inline-flex items-center gap-1 rounded-full border border-line bg-hanji-deep px-2.5 py-1.5 text-[11px] font-bold text-muk-soft transition-colors hover:border-jade/40 hover:text-jade focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
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
            )}
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}

export default FestivalBanner;
