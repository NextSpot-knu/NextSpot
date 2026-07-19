'use client';

import { useState, useEffect } from 'react';
import { motion, PanInfo, AnimatePresence } from 'framer-motion';
import { Bookmark, Sparkles, Star, Phone, MapPin, Clock, ChevronUp, ChevronDown, Info, Globe, Utensils } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { CongestionReportButton } from '@/components/CongestionReportButton';
import { GoldenHourBadge } from '@/components/GoldenHourBadge';
import { relativeParts } from '@/lib/freshness';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { isClosedToday } from '@/lib/restDate';

// facility prop 이 이 컴포넌트에서 실제로 읽는 필드만 구조적으로 명시한 타입.
// 콜러 둘의 합집합: main(page)은 Facility(congestionLevel/currentCount: number|null,
// features: 인덱스시그니처 unknown)를, saved(page)는 {congestionLevel, capacity, currentCount}
// 요약 리터럴만 전달한다. features 값은 unknown 인덱스라 읽는 곳에서 string 으로 좁힌다.
interface RecommendationCardFacility {
  id?: string;
  name?: string;
  type?: string;
  congestionLevel?: number | null;
  currentCount?: number | null;
  capacity?: number | null;
  features?: Record<string, unknown> | null;
  // 인제스트는 {open, closed} 저장(수동 시드는 weekday 등 다른 키도 존재) — api-client Facility 와 동일 형태.
  operatingHours?: { open?: string; closed?: string; [key: string]: any } | null;
  // TourAPI 상세 필드(A2, 전부 Optional) — 실데이터가 있을 때만 내려온다.
  imageUrl?: string | null;
  // detailImage2 갤러리(최대 5장) — 대표 사진 로드 실패 시 순차 폴백(waiting WaitingCardImage 패턴).
  galleryImages?: string[] | null;
  address?: string | null;
  phone?: string | null;
  homepage?: string | null;
  overview?: string | null;
  // 머천트 랭킹 연동 2단계(facility 최상위 필드, features 아님) — keysToCamel 적용 후 형태.
  // 활성 타임세일 할인율(0~0.5), 타임세일이 기본 쿠폰율보다 클 때만 존재.
  timesaleRate?: number | null;
  // 30분 내 사장 좌석 확인(신선도) — 과거 패턴 추정보다 우선하는 실측 신호.
  seatStatusFresh?: { level?: 'low' | 'mid' | 'full'; minutesAgo?: number } | null;
}

interface RecommendationCardProps {
  title: string;
  matchPercentage?: number;
  reason?: string; // 백엔드 템플릿 생성 추천 사유
  onAccept: () => void;
  onReject: () => void;
  onPutOff?: () => void;
  spotScore?: number;
  preferencePercent?: number;
  expectedWait?: number;
  expectedTravel?: number;
  timeToService?: number;
  facilityType?: string;
  facility?: RecommendationCardFacility;
  rank?: number;
  totalCandidates?: number;
  mockHour?: number | null;
  // A4: 행사 혼잡 보정 배지(explore/recommend 와 동일) — 백엔드 breakdown.eventBoost/eventTitle 그대로 전달.
  eventBoost?: number;
  eventTitle?: string;
  // 신선도 정직화(계약 5): 혼잡 데이터 출처·나이. user_report→'방문객 제보 · n분 전',
  // 기타 최신→'n분 전 기준', isStale(로그 나이>24h)→'과거 패턴 기반'(회색). 미제공(저장 목록 등)이면 미표시.
  dataSource?: { source: string | null; lastUpdated?: string | null; isStale?: boolean };
  weatherAdjusted?: boolean;
  openStatusAtArrival?: 'open_expected' | 'closing_soon' | 'closed_confirmed' | 'needs_confirmation';
}

export function RecommendationCard({
  title,
  matchPercentage,
  reason,
  onAccept,
  onReject,
  onPutOff,
  spotScore,
  preferencePercent,
  expectedWait,
  expectedTravel,
  timeToService,
  facilityType,
  facility,
  rank,
  totalCandidates,
  mockHour,
  eventBoost,
  eventTitle,
  dataSource,
  weatherAdjusted,
  openStatusAtArrival,
}: RecommendationCardProps) {
  const { t, locale } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  // SPOT 점수 설명 툴팁 — 터치/키보드에서도 열 수 있게 탭/포커스로 토글(데스크톱 hover 는 유지)
  const [showTooltip, setShowTooltip] = useState(false);

  // '최적 방문 시각' — 펼쳤을 때 백엔드(/predict/day)에서 받아오는 오늘 24시간 예측 혼잡 곡선.
  // 백엔드 미기동/실패 시 null 로 남아 조용히 숨긴다(카드 나머지는 그대로).
  const [dayPred, setDayPred] = useState<{
    hours: { hour: number; congestion: number }[];
    bestHour: number;
    bestCongestion: number;
  } | null>(null);

  const [currentTime, setCurrentTime] = useState<Date | null>(null);
  useEffect(() => {
    setIsExpanded(false);
    setIsMinimized(false);
    // 다른 장소로 바뀌면 이전 장소의 '최적 방문 시각' 데이터가 남아 깜빡이지 않게 초기화
    setDayPred(null);
  }, [title]);

  useEffect(() => {
    if (mockHour !== undefined && mockHour !== null) {
      const d = new Date();
      d.setHours(Math.floor(mockHour), (mockHour % 1) * 60, 0, 0);
      setCurrentTime(d);
      return;
    }
    setCurrentTime(new Date());
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);
    return () => clearInterval(interval);
  }, [mockHour]);
  
  const [placeInfo, setPlaceInfo] = useState<{
    address?: string;
    phone?: string;
    rating?: number;
    reviewCount?: number;
    url?: string;
  } | null>(null);

  // Load place details from Kakao Places API
  useEffect(() => {
    if (!title || typeof window === 'undefined' || !window.kakao || !window.kakao.maps) return;
    
    // 실제 시설 데이터에 있는 값만 노출한다. 별점/리뷰/전화/주소/영업시간을 절대 지어내지 않는다.
    // 카카오 keywordSearch 는 별점·리뷰수를 제공하지 않으므로 rating/reviewCount 는 설정하지 않는다.

    // Check if services library is loaded
    if (!window.kakao.maps.services) {
      console.warn("Kakao Places services library not loaded");
      setPlaceInfo({
        address: (facility?.features?.address as string | undefined) || undefined,
        phone: (facility?.features?.phone as string | undefined) || undefined,
        url: `https://map.kakao.com/?q=${encodeURIComponent(title)}`
      });
      return;
    }

    try {
      const ps = new window.kakao.maps.services.Places();
      ps.keywordSearch(title, (data: any, status: any) => {
        // 동명 체인이 타지로 잡히는 것을 차단: 카카오 1순위가 다른 도시일 수 있다.
        // '경주' 주소를 가진 첫 결과만 채택하고, 없으면 우리 DB(경주) 주소로 폴백.
        const place = (status === window.kakao.maps.services.Status.OK && Array.isArray(data))
          ? data.find((p: any) => ((p.road_address_name || p.address_name || '').includes('경주')))
          : null;
        if (place) {
          setPlaceInfo({
            address: place.road_address_name || place.address_name || facility?.features?.address || undefined,
            phone: place.phone || facility?.features?.phone || undefined,
            url: place.place_url
          });
        } else {
          // 경주 매칭 결과가 없으면(타지 체인만 잡히거나 검색 실패) 우리 데이터의 경주 주소만 사용.
          setPlaceInfo({
            address: (facility?.features?.address as string | undefined) || undefined,
            phone: (facility?.features?.phone as string | undefined) || undefined,
            url: `https://map.kakao.com/?q=${encodeURIComponent(title)}`
          });
        }
      });
    } catch (e) {
      console.error("Kakao Places API search error:", e);
    }
  }, [title, facility]);

  // 펼쳐졌을 때만 '최적 방문 시각'(오늘 24시간 예측)을 지연 로드한다 — 접힌 카드까지 백엔드를 때리지 않게.
  const dayFacilityType = facilityType || facility?.type;
  useEffect(() => {
    if (!isExpanded || !dayFacilityType) return;
    let active = true;
    apiClient
      .get(`/predict/day?facilityType=${encodeURIComponent(dayFacilityType)}`)
      .then((res) => {
        // 24개 시간 값이 온전할 때만 반영(방어적) — 아니면 조용히 숨김 유지
        if (active && res?.hours?.length === 24) setDayPred(res);
      })
      .catch(() => {
        // 백엔드 미기동/네트워크 실패 — 막대를 그리지 않고 조용히 숨긴다(카드 나머지는 영향 없음)
        if (active) setDayPred(null);
      });
    return () => {
      active = false;
    };
  }, [isExpanded, dayFacilityType]);

  // Framer Motion Drag Handler
  const handleDragEnd = (event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    const offset = info.offset.y;
    const velocity = info.velocity.y;

    if (isExpanded) {
      if (offset > 50 || velocity > 200) {
        setIsExpanded(false);
      }
    } else if (isMinimized) {
      if (offset < -50 || velocity < -200) {
        setIsMinimized(false);
      }
    } else {
      if (offset > 50 || velocity > 200) {
        setIsMinimized(true);
      } else if (offset < -50 || velocity < -200) {
        setIsExpanded(true);
      }
    }
  };

  const toggleExpand = () => {
    setIsExpanded(!isExpanded);
  };

  const hasSpotMetrics = spotScore !== undefined;

  const travelMins = expectedTravel || 0;
  const waitMins = expectedWait || 0;
  
  const arrivalTime = currentTime ? new Date(currentTime.getTime() + travelMins * 60000) : null;
  const serviceTime = arrivalTime ? new Date(arrivalTime.getTime() + waitMins * 60000) : null;

  const formatTime = (date: Date | null) => {
    if (!date) return '';
    return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  // 0-23시 → 로케일별 '오전/오후 N시'(0시=오전 12시, 12시=오후 12시). 예: 16 → '오후 4시'
  const formatKoreanHour = (h: number) => {
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return h < 12 ? t('card.hourAm', { h: h12 }) : t('card.hourPm', { h: h12 });
  };

  // 카드 상단 혼잡 pill 과 동일한 4단계 임계값(혼잡/보통/여유/한산)
  const congestionKey = (c: number) =>
    c >= 0.75 ? 'busy' : c >= 0.5 ? 'moderate' : c >= 0.25 ? 'relaxed' : 'quiet';
  const congestionLabel = (c: number) => t(`congestion.${congestionKey(c)}`);

  // 소개(overview) 다국어 — 배치 번역(apps/api/scripts/translate_overviews.py)이
  // features.overview_i18n = {en, ja, zh} 에 저장(스키마 변경 없음). apiClient(keysToCamel)는 features
  // 내부 키까지 재귀적으로 camelCase 변환하므로 보통 overviewI18n 이지만, supabase 직접 폴백 경로는
  // 원본 snake_case 를 그대로 들고 올 수 있어 둘 다 지원한다(firstMenu/restDateRaw 와 동일 관례).
  // 현재 로케일이 ko 면 항상 원문(overview)만 쓴다 — 번역이 없어도 지금처럼 한국어 원문(기존 동작 불변).
  const overviewI18n = (facility?.features?.overviewI18n ?? facility?.features?.overview_i18n) as
    | Record<string, string>
    | null
    | undefined;
  const translatedOverview = locale !== 'ko' ? overviewI18n?.[locale] : undefined;
  const displayOverview = translatedOverview || facility?.overview;

  // TourAPI 상세(A2) — 시설 정규 컬럼(facility.address/phone) 우선, 카카오 Places 검색값은 폴백으로 강등.
  // 둘 다 없으면 렌더하지 않는다('지어내지 않기').
  const displayAddress = facility?.address || placeInfo?.address;
  const displayPhone = facility?.phone || placeInfo?.phone;
  // TourAPI homepage 원문은 순수 URL 또는 <a href="..."> HTML 조각일 수 있어 첫 http(s) URL 만 방어적으로 추출.
  // 추출 실패 시 링크를 만들지 않는다(깨진 링크 미노출).
  const homepageUrl = facility?.homepage
    ? String(facility.homepage).match(/https?:\/\/[^\s"'<>]+/)?.[0] ?? null
    : null;
  const homepageHost = (() => {
    if (!homepageUrl) return null;
    try { return new URL(homepageUrl).hostname; } catch { return homepageUrl; }
  })();

  // 대표 메뉴(TourAPI detailIntro2 first_menu) — apiClient(/infrastructures, by-type)는 features
  // 내부 키까지 재귀적으로 camelCase 변환하므로 firstMenu 로 오지만, supabase 직접 폴백 경로는
  // 원본 컬럼(snake_case)을 그대로 들고 오므로 둘 다 지원한다(main/page.tsx barrierFree 폴백과 동일 관례).
  // 콤마 구분 시 앞 2개만('지어내지 않기' — 있는 값만 노출).
  const firstMenuRaw = (facility?.features?.firstMenu ?? facility?.features?.first_menu) as string | undefined;
  const firstMenuTokens = firstMenuRaw
    ? firstMenuRaw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 2)
    : [];

  // 오늘 휴무 — rest_date_raw 보수 파서(restDate.ts). true 확정일 때만 배지 노출(과판정 금지 원칙).
  const restDateRaw = (facility?.features?.restDateRaw ?? facility?.features?.rest_date_raw) as string | undefined;
  const closedToday = isClosedToday(restDateRaw) === true;

  // 카드 사진 — 대표(firstimage) → detailImage2 갤러리 순 폴백(waiting WaitingCardImage 패턴 미러).
  // 원본 서버에서 만료·차단된 URL 이 섞여 있어 onError 시 다음 후보로 넘어가고, 전부 실패하면 숨긴다.
  const cardImageUrls = Array.from(
    new Set(
      [facility?.imageUrl, ...(facility?.galleryImages ?? [])].filter(
        (url): url is string => typeof url === 'string' && url.trim().length > 0
      )
    )
  );
  const [cardImageIndex, setCardImageIndex] = useState(0);
  // 시설 전환뿐 아니라 같은 시설의 URL 목록이 갱신(비동기 보강)돼도 소진된 인덱스가 새 이미지를
  // 가리지 않도록, id+URL 집합을 함께 리셋 기준으로 삼는다(Codex 리뷰 P2, 2026-07-17).
  const cardImageKey = `${facility?.id ?? ''}|${cardImageUrls.join('|')}`;
  useEffect(() => { setCardImageIndex(0); }, [cardImageKey]);
  const cardImageUrl = cardImageUrls[cardImageIndex];

  // 머천트 랭킹 연동 2단계 — features 내부가 아니라 facility 최상위 필드지만, 백엔드 응답이 어떤
  // 경로(apiClient keysToCamel 미적용 폴백 등)로 오든 방어적으로 camel/snake 이중 표기를 읽는다.
  const facilityRaw = facility as unknown as Record<string, unknown> | undefined;
  const timesaleRateRaw = (facilityRaw?.timesaleRate ?? facilityRaw?.timesale_rate) as number | undefined;
  // 타임세일이 기본 쿠폰율보다 클 때만 존재한다는 계약이지만, 방어적으로 0보다 큰 수치만 표시.
  const timesaleRatePct =
    typeof timesaleRateRaw === 'number' && timesaleRateRaw > 0 ? Math.round(timesaleRateRaw * 100) : null;

  const seatStatusFreshRaw = (facilityRaw?.seatStatusFresh ?? facilityRaw?.seat_status_fresh) as
    | { level?: string; minutesAgo?: number; minutes_ago?: number }
    | null
    | undefined;
  const seatStatusFreshMinutesRaw = seatStatusFreshRaw
    ? seatStatusFreshRaw.minutesAgo ?? seatStatusFreshRaw.minutes_ago
    : undefined;
  // number 로 좁혀 아래 렌더에서 t() 의 vars(Record<string, string|number>) 타입과 안전하게 맞춘다.
  const seatStatusFreshMinutes = typeof seatStatusFreshMinutesRaw === 'number' ? seatStatusFreshMinutesRaw : null;

  return (
    <motion.div 
      className={`w-full bg-white/95 backdrop-blur-2xl border border-line rounded-3xl ${isMinimized ? 'p-3' : 'p-5'} shadow-[0_8px_30px_rgba(43,35,32,0.12)] flex flex-col ${isMinimized ? 'gap-1' : 'gap-3'} select-none relative overflow-hidden`}
      drag="y"
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={0.2}
      onDragEnd={handleDragEnd}
      layout
      transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
    >
      {/* 상단 장식 라인 — 콜드 블루 글로우를 신라금 웜 그라디언트로 */}
      <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-gold/50 to-transparent" />

      {/* Swipe/Drag Handle Bar */}
      <div 
        className="w-16 h-1.5 bg-muk/15 hover:bg-muk/25 rounded-full mx-auto mb-1 cursor-pointer flex items-center justify-center transition-colors"
        onClick={() => {
          if (isMinimized) setIsMinimized(false);
          else toggleExpand();
        }}
      >
        <div className="sr-only">Drag handle</div>
      </div>

      {isMinimized ? (
        <div 
          className="flex items-center justify-between px-2 pb-1 cursor-pointer"
          onClick={() => setIsMinimized(false)}
        >
           <span className="text-sm font-bold text-muk truncate max-w-[200px]">{title}</span>
           <span className="text-[10px] text-terracotta font-bold bg-gold/10 px-2 py-0.5 rounded-full border border-gold/25 whitespace-nowrap">
             {t('card.open')} <ChevronUp size={12} className="inline mb-0.5" />
           </span>
        </div>
      ) : (
        <>
          {/* Top Header Row — 클릭 시 상세(구체적 장소) 펼침/접기 */}
      <div className="flex justify-between items-start gap-3 cursor-pointer" onClick={toggleExpand}>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1.5">
            {rank ? (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-gradient-to-r from-gold to-terracotta text-white text-[10px] font-black rounded-lg shadow-sm">
                <Sparkles size={12} />
                {t('card.rankBadge', { rank })}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-gold/15 text-gold-deep text-[10px] font-bold rounded-lg">
                <Sparkles size={12} />
                {t('card.aiRec')}
              </span>
            )}
            {totalCandidates && rank && (
              <span className="text-[10px] text-muk-soft font-medium">{t('card.ofCandidates', { n: totalCandidates })}</span>
            )}
          </div>
          <h3 className="text-xl font-serif font-bold text-muk tracking-tight leading-tight">{title}</h3>
          
          {/* Status Pills — 펼쳐도(상세 표시 중에도) 혼잡도·잔여석은 항상 표시.
              혼잡 로그가 없는 시설(congestionLevel=null)은 합성값 대신 회색 '데이터 없음'으로 표기. */}
          {facility && facility.congestionLevel !== undefined && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              {typeof facility.congestionLevel === 'number' ? (
                <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${
                  facility.congestionLevel >= 0.75
                    ? 'bg-terracotta/10 border-terracotta/30 text-terracotta'
                    : facility.congestionLevel >= 0.5
                    ? 'bg-gold/10 border-gold/30 text-gold-deep'
                    : facility.congestionLevel >= 0.25
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600'
                    : 'bg-jade/10 border-jade/30 text-jade'
                }`}>
                  {t('card.congestion')}: {congestionLabel(facility.congestionLevel)}
                </span>
              ) : (
                // D-1(CONGESTION_TRUST_SPEC): '데이터 없음' 대신 '정보 준비 중' — 서비스가 죽은 게
                // 아니라 데이터를 모으는 중이라는 뉘앙스(waiting 페이지의 noData 는 별건 유지).
                <span className="px-2 py-0.5 rounded-md text-[10px] font-bold border bg-muk/5 border-line text-muk-soft">
                  {t('card.congestionPreparing')}
                </span>
              )}
              {/* D-3: 합성(seed)/시뮬(simulated) 혼잡 로그는 데모 데이터임을 라벨로 구분(가드레일). */}
              {typeof facility.congestionLevel === 'number' &&
                (dataSource?.source === 'seed' || dataSource?.source === 'simulated') && (
                <span className="px-2 py-0.5 rounded-md text-[10px] font-medium border bg-hanji-deep border-line text-muk-soft">
                  {t('card.demoData')}
                </span>
              )}
              {/* 오늘 휴무 배지 — 혼잡 배지 바로 옆. isClosedToday 가 true 확정일 때만(null/false 는 무표시). */}
              {closedToday && (
                <span className="px-2 py-0.5 rounded-md text-[10px] font-bold border bg-terracotta/10 border-terracotta/30 text-terracotta">
                  {t('card.closedToday')}
                </span>
              )}
              {openStatusAtArrival && (
                <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${
                  openStatusAtArrival === 'open_expected'
                    ? 'bg-jade/10 border-jade/30 text-jade'
                    : openStatusAtArrival === 'closing_soon'
                      ? 'bg-terracotta/10 border-terracotta/30 text-terracotta'
                      : 'bg-muk/5 border-line text-muk-soft'
                }`}>
                  {t(`card.arrivalStatus.${openStatusAtArrival}`)}
                </span>
              )}
              {/* 타임세일 배지(머천트 랭킹 연동 2단계) — 축제 배지(terracotta)와 톤을 구분한 진한 gold pill. */}
              {timesaleRatePct !== null && (
                <span className="px-2 py-0.5 rounded-md text-[10px] font-black border bg-gold/25 border-gold/60 text-gold-deep">
                  {t('card.timesale', { rate: timesaleRatePct })}
                </span>
              )}
              <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-hanji-deep border border-line text-muk-soft">
                {t('card.remainingLabel')}: {facility.currentCount != null && facility.capacity != null
                  ? t('card.remainingValue', { seats: Math.max(0, facility.capacity - facility.currentCount), total: facility.capacity })
                  : '—'}
              </span>
              {/* 골든타임 알리미 — 혼잡도 pill 바로 옆(같은 줄)에 지연 조회로 끼워 넣는다. 백엔드
                  미기동/available:false 면 조용히 렌더되지 않는다(무해 폴백). */}
              <GoldenHourBadge facilityId={facility.id} />
            </div>
          )}

          {/* 신선도 정직화(계약 5, 확장) — 혼잡 데이터의 출처/나이를 작은 라인으로. 정직성 위계:
              사장 실측(seatStatusFresh, 30분 내) > 방문객 제보/실시간(dataSource) > 과거 패턴 기반(isStale). */}
          {(() => {
            if (seatStatusFreshMinutes !== null) {
              return (
                <p className="text-[10px] text-muk-soft mt-2 flex items-center gap-1">
                  <span aria-hidden>✅</span>
                  {t('card.seatConfirmed', { n: seatStatusFreshMinutes })}
                </p>
              );
            }
            if (!dataSource) return null;
            if (dataSource.isStale) {
              return <p className="text-[10px] text-muk-soft/60 mt-2">{t('card.freshStale')}</p>;
            }
            const parts = relativeParts(dataSource.lastUpdated);
            if (!parts) return null;
            const rel =
              parts.unit === 'now' ? t('freshness.justNow')
              : parts.unit === 'min' ? t('freshness.minAgo', { n: parts.value })
              : parts.unit === 'hour' ? t('freshness.hourAgo', { n: parts.value })
              : t('freshness.dayAgo', { n: parts.value });
            const isReport = dataSource.source === 'user_report';
            return (
              <p className="text-[10px] text-muk-soft mt-2 flex items-center gap-1">
                <span aria-hidden>{isReport ? '📣' : '🕒'}</span>
                {isReport ? t('card.freshReport', { rel }) : t('card.freshLive', { rel })}
              </p>
            );
          })()}
        </div>

        {/* Dynamic Badge (SPOT Score or match percentage) */}
        {hasSpotMetrics ? (
          <div className="relative group">
            <div
              className="flex flex-col items-center justify-center min-w-[60px] h-[60px] rounded-2xl border border-gold/40 bg-gradient-to-b from-gold/20 to-gold/5 cursor-pointer shadow-sm"
            >
              <span className="text-[10px] text-gold-deep font-bold mb-0.5">{t('card.spotScoreLabel')}</span>
              <span className="text-muk font-black text-xl leading-none">{Math.round(spotScore || 0)}<span className="text-[10px] font-normal text-muk-soft ml-0.5">{t('card.pointSuffix')}</span></span>
            </div>
            
            {/* Info Icon — 탭/포커스로 툴팁 토글(터치·키보드 접근) */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowTooltip((v) => !v); }}
              onBlur={() => setShowTooltip(false)}
              aria-label="SPOT 점수 설명 보기"
              aria-expanded={showTooltip}
              className="absolute -top-1.5 -right-1.5 bg-white rounded-full p-0.5 border border-gold/40 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
            >
              <Info size={12} className="text-gold" />
            </button>

            {/* Tooltip — 상태(showTooltip) 또는 데스크톱 hover 시 표시 */}
            <div className={`absolute top-full right-0 mt-3 w-[260px] p-3.5 bg-white/95 backdrop-blur-xl border border-line rounded-xl shadow-[0_10px_30px_rgba(43,35,32,0.15)] transition-all duration-200 z-50 pointer-events-none group-hover:opacity-100 group-hover:visible ${showTooltip ? 'opacity-100 visible' : 'opacity-0 invisible'}`}>
              <p className="text-[11px] text-muk-soft leading-relaxed text-right break-keep space-y-1">
                <span className="block mb-1.5"><strong className="text-gold-deep font-bold text-[12px]">SPOT Score란?</strong></span>
                <span className="block">NextSpot의 핵심 기술로, 도착 시점의 혼잡도를 미리 예측하는 <strong className="text-gold-deep">머신러닝 AI 모델</strong>과 사용자의 선호도를 분석하는 <strong className="text-gold-deep">벡터 알고리즘</strong>의 결합.</span>
                <span className="block mt-1.5">지금 이 순간, 사용자의 시간 가치를 극대화하는 가장 완벽한 목적지를 제안합니다.</span>
              </p>
            </div>
          </div>
        ) : (
          matchPercentage !== undefined && (
            <div className="flex flex-col items-center justify-center min-w-[60px] h-[60px] rounded-2xl border border-gold/30 bg-gold/10 shadow-sm">
              <span className="text-muk font-black text-lg">{matchPercentage}%</span>
              <span className="text-[10px] text-gold-deep font-semibold mt-0.5">{t('card.match')}</span>
            </div>
          )
        )}
      </div>



      {/* SPOT Metric Grid (Only if metrics are provided) */}
      {hasSpotMetrics && (
        <div className="flex flex-col gap-2 mt-1 cursor-pointer" onClick={toggleExpand}>
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                {/* Time Cost Column */}
                <div className="flex-1 bg-gradient-to-br from-gold/10 to-gold/5 border border-gold/20 rounded-2xl p-3 flex flex-col justify-center relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-2 opacity-20">
                    <Clock size={24} className="text-gold" />
                  </div>
                  <span className="text-muk-soft text-[10px] font-semibold mb-1">{t('card.totalTime')}</span>
                  <div className="flex items-baseline gap-1 mb-1.5">
                    <span className="text-2xl font-black text-muk">{timeToService}</span>
                    <span className="text-xs text-muk-soft font-medium">{t('card.minute')}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-muk-soft font-medium">
                    <span className="bg-gold/15 px-1.5 py-0.5 rounded text-gold-deep whitespace-nowrap">{t('card.wait', { n: expectedWait ?? 0 })}</span>
                    <span className="text-muk-soft/60">+</span>
                    <span className="bg-jade/15 px-1.5 py-0.5 rounded text-jade whitespace-nowrap">{t('card.travel', { n: expectedTravel ?? 0 })}</span>
                  </div>
                </div>

                {/* Preference Column */}
                <div className="w-[110px] bg-hanji-deep border border-line rounded-2xl p-3 flex flex-col justify-center items-center text-center">
                  <span className="text-muk-soft text-[10px] font-semibold mb-1">{t('card.prefMatch')}</span>
                  <div className="flex items-baseline gap-0.5 mb-1">
                    <span className="text-xl font-black text-jade">{preferencePercent}</span>
                    <span className="text-xs text-jade/80 font-bold">%</span>
                  </div>
                  <span className="text-[10px] text-muk-soft mt-0.5 line-clamp-2">{t('card.prefBasis')}</span>
                </div>
              </div>

              {/* Timeline UI */}
              {currentTime && arrivalTime && serviceTime && (
                <div className="bg-hanji-deep border border-line rounded-2xl px-4 py-3 flex flex-col gap-3">
                  <div className="flex items-start justify-between relative mt-1">
                    {/* Connecting Line */}
                    <div className="absolute top-[3px] left-4 right-4 h-[2px] bg-line z-0" />

                    {/* Travel Duration Label */}
                    <div className="absolute top-[-10px] left-[25%] -translate-x-1/2 z-10">
                      <span className="text-[10px] font-medium text-jade bg-hanji-deep px-1.5 py-0.5 rounded border border-jade/25 whitespace-nowrap">{t('card.travel', { n: travelMins })}</span>
                    </div>
                    {/* Wait Duration Label */}
                    <div className="absolute top-[-10px] left-[75%] -translate-x-1/2 z-10">
                      <span className="text-[10px] font-medium text-gold-deep bg-hanji-deep px-1.5 py-0.5 rounded border border-gold/25 whitespace-nowrap">{t('card.wait', { n: waitMins })}</span>
                    </div>

                    {/* Current Time Step */}
                    <div className="flex flex-col items-center z-10 w-12">
                      <div className="w-2 h-2 rounded-full bg-gold ring-4 ring-hanji-deep mb-1.5" />
                      <span className="text-[10px] text-muk font-bold">{formatTime(currentTime)}</span>
                      <span className="text-[10px] text-muk-soft mt-0.5">{t('card.depart')}</span>
                    </div>

                    {/* Arrival Time Step */}
                    <div className="flex flex-col items-center z-10 w-12">
                      <div className="w-2 h-2 rounded-full bg-jade ring-4 ring-hanji-deep mb-1.5" />
                      <span className="text-[10px] text-muk font-bold">{formatTime(arrivalTime)}</span>
                      <span className="text-[10px] text-muk-soft mt-0.5">{t('card.arrive')}</span>
                    </div>

                    {/* Service Start Step */}
                    <div className="flex flex-col items-center z-10 w-12">
                      <div className="w-2 h-2 rounded-full bg-gold ring-4 ring-hanji-deep mb-1.5" />
                      <span className="text-[10px] text-muk font-bold">{formatTime(serviceTime)}</span>
                      <span className="text-[10px] text-muk-soft mt-0.5">{facilityType === 'restaurant' || facilityType === 'cafe' ? t('card.dine') : t('card.view')}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
        </div>
      )}

      {/* A4: 행사 혼잡 보정 배지 — 도착시점 인근 진행 중 축제로 예측이 가중됐을 때만 노출(투명성).
          explore/recommend 카드와 동일 시각·문구. */}
      {(eventBoost ?? 0) > 0 && (
        <p className="text-[11px] leading-snug text-terracotta bg-terracotta/10 border border-terracotta/20 rounded-xl px-3 py-2">
          🎪 {t('recommend.festivalAdjusted', {
            title: eventTitle ?? '',
            pct: Math.round((eventBoost ?? 0) * 100),
          })}
        </p>
      )}

      {/* Expandable Details Section (Rating, Address, Phone, Hours) */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div 
            initial={{ height: 0, opacity: 0, marginTop: 0 }}
            animate={{ height: 'auto', opacity: 1, marginTop: 4 }}
            exit={{ height: 0, opacity: 0, marginTop: 0 }}
            className="overflow-hidden"
          >
            <div className="border-t border-line pt-3.5 space-y-3 text-xs text-muk-soft">

          {/* 대표 사진(TourAPI firstimage→갤러리 폴백) — 실제 이미지가 있을 때만. 전부 로드 실패 시 숨겨 깨진 이미지를 노출하지 않는다. */}
          {cardImageUrl && (
            /* TourAPI 이미지 원본은 도메인이 다양해 next/image 최적화 대상이 아님(정적 export) — img 사용 */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={cardImageUrl} /* URL 마다 새 엘리먼트 — 직전 시설 이미지의 늦은 onError 가 새 카드의 인덱스를 밀어올리지 않게 */
              src={cardImageUrl}
              alt={title}
              loading="lazy"
              onError={() => setCardImageIndex((current) => current + 1)}
              className="w-full h-32 object-cover rounded-2xl border border-line"
            />
          )}

          {/* AI 추천 사유 (백엔드 템플릿, 있을 때만) */}
          {weatherAdjusted && (
            <div className="mb-2 rounded-xl border border-gold/40 bg-gold/10 px-3 py-2 text-xs font-semibold text-muk">
              🌧️ {t('weather.cardReason')}
            </div>
          )}
          {reason && (
            <p className="text-[13px] leading-relaxed text-muk bg-gold/10 border border-gold/25 rounded-2xl px-3.5 py-2.5">
              💡 {reason}
            </p>
          )}

          {/* 소개(TourAPI overview, 비-ko 로케일이면 배치 번역 우선) — 있을 때만 3줄 클램프('지어내지 않기') */}
          {displayOverview && (
            <div>
              <span className="text-muk-soft block text-[10px] font-bold mb-0.5">{t('card.about')}</span>
              <p className="text-muk leading-relaxed line-clamp-3">{displayOverview}</p>
            </div>
          )}

          {/* Rating/Reviews — 실제 데이터가 있을 때만. 별점/리뷰수는 지어내지 않는다. */}
          {(placeInfo?.rating != null || placeInfo?.reviewCount != null || placeInfo?.url) && (
            <div className="flex items-center gap-2">
              {placeInfo?.rating != null && (
                <div className="flex items-center text-gold">
                  <Star size={14} className="fill-gold mr-0.5" />
                  <span className="font-extrabold text-muk">{placeInfo.rating}</span>
                </div>
              )}
              {placeInfo?.rating != null && placeInfo?.reviewCount != null && (
                <span className="text-muk-soft/40">|</span>
              )}
              {placeInfo?.reviewCount != null && (
                <span className="text-muk-soft">{t('card.reviewCount', { n: placeInfo.reviewCount })}</span>
              )}

              {placeInfo?.url && (
                <a
                  href={placeInfo.url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto text-gold-deep hover:text-gold underline font-bold tracking-tight"
                >
                  {t('card.viewReviews')}
                </a>
              )}
            </div>
          )}

          {/* Address — 실제 주소가 있을 때만(TourAPI 컬럼 우선, 카카오 Places 검색값 폴백) */}
          {displayAddress && (
            <div className="flex items-start gap-2">
              <MapPin size={14} className="text-muk-soft mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-muk-soft block text-[10px] font-bold">{t('card.address')}</span>
                <span className="text-muk leading-relaxed">{displayAddress}</span>
              </div>
            </div>
          )}

          {/* Phone — 실제 전화번호가 있을 때만(TourAPI 컬럼 우선, 카카오 Places 검색값 폴백) */}
          {displayPhone && (
            <div className="flex items-start gap-2">
              <Phone size={14} className="text-muk-soft mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-muk-soft block text-[10px] font-bold">{t('card.phone')}</span>
                <span className="text-muk">{displayPhone}</span>
              </div>
            </div>
          )}

          {/* Homepage — 실제 홈페이지가 있을 때만. 표시 텍스트는 hostname, 새 탭 외부 링크. */}
          {homepageUrl && (
            <div className="flex items-start gap-2">
              <Globe size={14} className="text-muk-soft mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-muk-soft block text-[10px] font-bold">{t('card.homepage')}</span>
                <a
                  href={homepageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gold-deep hover:text-gold underline font-bold tracking-tight"
                >
                  {homepageHost}
                </a>
              </div>
            </div>
          )}

          {/* 대표 메뉴(TourAPI first_menu) — 있을 때만, 콤마 구분 시 앞 2개만 '·' 로 이어붙임('지어내지 않기') */}
          {firstMenuTokens.length > 0 && (
            <div className="flex items-start gap-2">
              <Utensils size={14} className="text-muk-soft mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-muk-soft block text-[10px] font-bold">{t('card.signatureMenu')}</span>
                <span className="text-muk">{firstMenuTokens.join(' · ')}</span>
              </div>
            </div>
          )}

          {/* Operating Hours — 실제 영업시간이 있을 때만. 인제스트는 {open: 영업시간, closed: 휴무일} 저장 —
              open 만으로 표시한다(레거시 close/weekday 키는 있으면 덧붙임). */}
          {facility?.operatingHours?.open && (
            <div className="flex items-start gap-2">
              <Clock size={14} className="text-muk-soft mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-muk-soft block text-[10px] font-bold">{t('card.hours')}</span>
                <span className="text-muk">
                  {facility.operatingHours.open}
                  {facility.operatingHours.close && ` ~ ${facility.operatingHours.close}`}
                  {facility.operatingHours.weekday && ` (${facility.operatingHours.weekday})`}
                </span>
              </div>
            </div>
          )}

          {/* 휴무일 — closed 가 있을 때만 별도 라인(운영시간과 키 의미가 다름: closed=휴무일 텍스트) */}
          {facility?.operatingHours?.closed && (
            <div className="flex items-start gap-2">
              <Clock size={14} className="text-muk-soft mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-muk-soft block text-[10px] font-bold">{t('card.closedDays')}</span>
                <span className="text-muk">{facility.operatingHours.closed}</span>
              </div>
            </div>
          )}

          {/* 최적 방문 시각 — 오늘 24시간 예측 혼잡 미니 막대(백엔드 성공 시에만). 가장 한산한 시각을 옥(jade)으로 강조. */}
          {dayPred && (
            <div className="border-t border-line/70 pt-3">
              <div className="flex items-center gap-1.5 mb-2">
                <Clock size={13} className="text-gold-deep flex-shrink-0" />
                <span className="text-[11px] font-bold text-muk">{t('card.todayForecast')}</span>
              </div>
              <div
                className="flex items-end gap-[2px] h-10"
                role="img"
                aria-label={t('card.forecastAria', { time: formatKoreanHour(dayPred.bestHour) })}
              >
                {dayPred.hours.map((h) => {
                  const isBest = h.hour === dayPred.bestHour;
                  return (
                    <div
                      key={h.hour}
                      className="flex-1 flex items-end h-full"
                      title={`${formatKoreanHour(h.hour)} · ${congestionLabel(h.congestion)}`}
                    >
                      <div
                        aria-hidden="true"
                        className={`w-full rounded-sm transition-colors ${isBest ? 'bg-jade' : 'bg-gold/35'}`}
                        style={{ height: `${Math.max(8, Math.round(h.congestion * 100))}%` }}
                      />
                    </div>
                  );
                })}
              </div>
              {/* 시각 축(0·6·12·18·23시) — 대략 위치만 안내하는 경량 눈금 */}
              <div className="flex justify-between mt-1 text-[10px] text-muk-soft/70 font-medium" aria-hidden="true">
                <span>{t('card.oClock', { h: 0 })}</span>
                <span>{t('card.oClock', { h: 6 })}</span>
                <span>{t('card.oClock', { h: 12 })}</span>
                <span>{t('card.oClock', { h: 18 })}</span>
                <span>{t('card.oClock', { h: 23 })}</span>
              </div>
              <p className="text-[11px] text-jade font-bold mt-2 flex items-center gap-1">
                <Sparkles size={11} className="text-jade flex-shrink-0" />
                {t('card.bestTime', { time: formatKoreanHour(dayPred.bestHour) })}
              </p>
            </div>
          )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Action Buttons: 관심 없어요 · 나중에 볼게요(저장) · 여기로 갈래요 */}
      <div className="flex gap-2 mt-1">
          <button
            onClick={onReject}
            aria-label={t('card.rejectAria')}
            className="flex-1 bg-hanji-deep hover:bg-terracotta/10 hover:text-terracotta hover:border-terracotta/30 text-muk-soft font-bold py-3 rounded-2xl border border-line transition-all active:scale-95 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
          >
            {t('card.reject')}
          </button>
          {onPutOff && (
            <button
              onClick={onPutOff}
              aria-label={t('card.putOffAria')}
              className="group flex-1 flex items-center justify-center gap-1.5 bg-hanji-deep hover:bg-gold/10 hover:text-gold-deep hover:border-gold/30 text-muk-soft font-bold py-3 rounded-2xl border border-line transition-all active:scale-95 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
            >
              {/* 저장 인지 강화용 북마크 — hover/press 시 채워지며 살짝 팝(순수 Tailwind, 과하지 않게) */}
              <Bookmark
                size={14}
                className="fill-transparent transition-all duration-300 group-hover:fill-gold group-hover:scale-110 group-active:scale-125"
              />
              {t('card.putOff')}
            </button>
          )}
          <button
            onClick={onAccept}
            aria-label={t('card.acceptAria')}
            className="flex-1 bg-gradient-to-r from-gold to-terracotta hover:from-gold-deep hover:to-terracotta text-white font-bold py-3 rounded-2xl transition-all active:scale-95 text-xs shadow-[0_4px_14px_rgba(193,85,59,0.25)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
          >
            {t('card.accept')}
          </button>
        </div>
        {facility?.id && (
          <div className="mt-2 flex justify-center">
            <CongestionReportButton facility={{ id: facility.id!, name: facility.name ?? title }} />
          </div>
        )}
      </>
      )}
    </motion.div>
  );
}
