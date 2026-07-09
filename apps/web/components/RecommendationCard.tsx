'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, PanInfo, AnimatePresence } from 'framer-motion';
import { Bookmark, Sparkles, Star, Phone, MapPin, Clock, ChevronUp, ChevronDown, Info } from 'lucide-react';

interface RecommendationCardProps {
  title: string;
  matchPercentage?: number;
  description: string;
  reason?: string; // WP3: Gemini 생성 추천 사유
  onAccept: () => void;
  onReject: () => void;
  onPutOff?: () => void;
  onClose?: () => void; // Added close/hide callback
  spotScore?: number;
  preferencePercent?: number;
  expectedWait?: number;
  expectedTravel?: number;
  timeToService?: number;
  facilityType?: string;
  facility?: any;
  rank?: number;
  totalCandidates?: number;
  mockHour?: number | null;
}

export function RecommendationCard({
  title,
  matchPercentage,
  description,
  reason,
  onAccept,
  onReject,
  onPutOff,
  onClose,
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
}: RecommendationCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  
  const [currentTime, setCurrentTime] = useState<Date | null>(null);
  useEffect(() => {
    setIsExpanded(false);
    setIsMinimized(false);
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
    
    // Check if services library is loaded
    if (!window.kakao.maps.services) {
      console.warn("Kakao Places services library not loaded");
      setPlaceInfo({
        address: facility?.features?.address || '경상북도 경주시 황남동',
        phone: facility?.features?.phone || '054-123-4567',
        rating: 4.5,
        reviewCount: 28,
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
          // Stable mock rating and reviews based on place ID
          const seed = place.id ? parseInt(place.id) : 10;
          const mockRating = 4.0 + (seed % 10) / 10;
          const mockReviews = 10 + (seed % 90);

          setPlaceInfo({
            address: place.road_address_name || place.address_name,
            phone: place.phone || facility?.features?.phone || '전화번호 정보 없음',
            rating: parseFloat(mockRating.toFixed(1)),
            reviewCount: mockReviews,
            url: place.place_url
          });
        } else {
          // 경주 매칭 결과가 없으면(타지 체인만 잡히거나 검색 실패) 우리 데이터의 경주 주소로 폴백.
          setPlaceInfo({
            address: facility?.features?.address || '경상북도 경주시 황남동',
            phone: facility?.features?.phone || '054-123-4567',
            rating: 4.3,
            reviewCount: 15,
            url: `https://map.kakao.com/?q=${encodeURIComponent(title)}`
          });
        }
      });
    } catch (e) {
      console.error("Kakao Places API search error:", e);
    }
  }, [title, facility]);

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
        if (onClose) {
          onClose();
        } else {
          setIsMinimized(true);
        }
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
             열기 <ChevronUp size={12} className="inline mb-0.5" />
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
                추천 {rank}순위
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-gold/15 text-gold-deep text-[10px] font-bold rounded-lg">
                <Sparkles size={12} />
                AI 추천
              </span>
            )}
            {totalCandidates && rank && (
              <span className="text-[10px] text-muk-soft font-medium">대안 {totalCandidates}개 중</span>
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
                  혼잡도: {facility.congestionLevel >= 0.75 ? '혼잡' : facility.congestionLevel >= 0.5 ? '보통' : facility.congestionLevel >= 0.25 ? '여유' : '한산'}
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-md text-[10px] font-bold border bg-muk/5 border-line text-muk-soft">
                  혼잡도: 데이터 없음
                </span>
              )}
              <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-hanji-deep border border-line text-muk-soft">
                잔여: {facility.currentCount != null && facility.capacity != null
                  ? `${Math.max(0, facility.capacity - facility.currentCount)}자리 (총 ${facility.capacity})`
                  : '—'}
              </span>
            </div>
          )}
        </div>

        {/* Dynamic Badge (SPOT Score or match percentage) */}
        {hasSpotMetrics ? (
          <div className="relative group">
            <div
              className="flex flex-col items-center justify-center min-w-[60px] h-[60px] rounded-2xl border border-gold/40 bg-gradient-to-b from-gold/20 to-gold/5 cursor-pointer shadow-sm"
            >
              <span className="text-[9px] text-gold-deep font-bold mb-0.5">SPOT 점수</span>
              <span className="text-muk font-black text-xl leading-none">{Math.round(spotScore || 0)}<span className="text-[10px] font-normal text-muk-soft ml-0.5">점</span></span>
            </div>
            
            {/* Info Icon */}
            <div className="absolute -top-1.5 -right-1.5 bg-white rounded-full p-0.5 border border-gold/40 shadow-sm">
              <Info size={12} className="text-gold" />
            </div>

            {/* Tooltip */}
            <div className="absolute top-full right-0 mt-3 w-[260px] p-3.5 bg-white/95 backdrop-blur-xl border border-line rounded-xl shadow-[0_10px_30px_rgba(43,35,32,0.15)] opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 pointer-events-none">
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
              <span className="text-[9px] text-gold-deep font-semibold mt-0.5">일치</span>
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
                  <span className="text-muk-soft text-[10px] font-semibold mb-1">총 소요 시간</span>
                  <div className="flex items-baseline gap-1 mb-1.5">
                    <span className="text-2xl font-black text-muk">{timeToService}</span>
                    <span className="text-xs text-muk-soft font-medium">분</span>
                  </div>
                  <div className="flex items-center gap-2 text-[9px] text-muk-soft font-medium">
                    <span className="bg-gold/15 px-1.5 py-0.5 rounded text-gold-deep">대기 {expectedWait}분</span>
                    <span className="text-muk-soft/60">+</span>
                    <span className="bg-jade/15 px-1.5 py-0.5 rounded text-jade">이동 {expectedTravel}분</span>
                  </div>
                </div>

                {/* Preference Column */}
                <div className="w-[110px] bg-hanji-deep border border-line rounded-2xl p-3 flex flex-col justify-center items-center text-center">
                  <span className="text-muk-soft text-[10px] font-semibold mb-1">취향 일치율</span>
                  <div className="flex items-baseline gap-0.5 mb-1">
                    <span className="text-xl font-black text-jade">{preferencePercent}</span>
                    <span className="text-xs text-jade/80 font-bold">%</span>
                  </div>
                  <span className="text-[9px] text-muk-soft mt-0.5 line-clamp-2">사용자 패턴 기반</span>
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
                      <span className="text-[9px] font-medium text-jade bg-hanji-deep px-1.5 py-0.5 rounded border border-jade/25">이동 {travelMins}분</span>
                    </div>
                    {/* Wait Duration Label */}
                    <div className="absolute top-[-10px] left-[75%] -translate-x-1/2 z-10">
                      <span className="text-[9px] font-medium text-gold-deep bg-hanji-deep px-1.5 py-0.5 rounded border border-gold/25">대기 {waitMins}분</span>
                    </div>

                    {/* Current Time Step */}
                    <div className="flex flex-col items-center z-10 w-12">
                      <div className="w-2 h-2 rounded-full bg-gold ring-4 ring-hanji-deep mb-1.5" />
                      <span className="text-[10px] text-muk font-bold">{formatTime(currentTime)}</span>
                      <span className="text-[9px] text-muk-soft mt-0.5">출발</span>
                    </div>

                    {/* Arrival Time Step */}
                    <div className="flex flex-col items-center z-10 w-12">
                      <div className="w-2 h-2 rounded-full bg-jade ring-4 ring-hanji-deep mb-1.5" />
                      <span className="text-[10px] text-muk font-bold">{formatTime(arrivalTime)}</span>
                      <span className="text-[9px] text-muk-soft mt-0.5">도착</span>
                    </div>

                    {/* Service Start Step */}
                    <div className="flex flex-col items-center z-10 w-12">
                      <div className="w-2 h-2 rounded-full bg-gold ring-4 ring-hanji-deep mb-1.5" />
                      <span className="text-[10px] text-muk font-bold">{formatTime(serviceTime)}</span>
                      <span className="text-[9px] text-muk-soft mt-0.5">{facilityType === 'restaurant' || facilityType === 'cafe' ? '식사' : '관람'}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
        </div>
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
          
          {/* AI 추천 사유 (WP3 Gemini, 있을 때만) */}
          {reason && (
            <p className="text-[13px] leading-relaxed text-muk bg-gold/10 border border-gold/25 rounded-2xl px-3.5 py-2.5">
              💡 {reason}
            </p>
          )}
          
          {/* Rating */}
          <div className="flex items-center gap-2">
            <div className="flex items-center text-gold">
              <Star size={14} className="fill-gold mr-0.5" />
              <span className="font-extrabold text-muk">{placeInfo?.rating ?? 4.5}</span>
            </div>
            <span className="text-muk-soft/40">|</span>
            <span className="text-muk-soft">리뷰 {placeInfo?.reviewCount ?? 20}개</span>
            
            {placeInfo?.url && (
              <a 
                href={placeInfo.url} 
                target="_blank" 
                rel="noreferrer"
                className="ml-auto text-gold-deep hover:text-gold underline font-bold tracking-tight"
              >
                상세 리뷰 보기 ↗
              </a>
            )}
          </div>

          {/* Address */}
          <div className="flex items-start gap-2">
            <MapPin size={14} className="text-muk-soft mt-0.5 flex-shrink-0" />
            <div>
              <span className="text-muk-soft block text-[9px] font-bold">주소</span>
              <span className="text-muk leading-relaxed">{placeInfo?.address}</span>
            </div>
          </div>

          {/* Phone */}
          <div className="flex items-start gap-2">
            <Phone size={14} className="text-muk-soft mt-0.5 flex-shrink-0" />
            <div>
              <span className="text-muk-soft block text-[9px] font-bold">전화번호</span>
              <span className="text-muk">{placeInfo?.phone}</span>
            </div>
          </div>

          {/* Operating Hours */}
          <div className="flex items-start gap-2">
            <Clock size={14} className="text-muk-soft mt-0.5 flex-shrink-0" />
            <div>
              <span className="text-muk-soft block text-[9px] font-bold">운영 시간</span>
              <span className="text-muk">
                {facility?.operatingHours?.open || '09:00'} ~ {facility?.operatingHours?.close || '22:00'}
                {facility?.operatingHours?.weekday && ` (${facility.operatingHours.weekday})`}
              </span>
            </div>
          </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Action Buttons: 관심 없어요 · 나중에 볼게요(저장) · 여기로 갈래요 */}
      <div className="flex gap-2 mt-1">
          <button
            onClick={onReject}
            aria-label="이 추천에 관심 없음, 다른 장소 추천받기"
            className="flex-1 bg-hanji-deep hover:bg-terracotta/10 hover:text-terracotta hover:border-terracotta/30 text-muk-soft font-bold py-3 rounded-2xl border border-line transition-all active:scale-95 text-xs focus:outline-none"
          >
            관심 없어요
          </button>
          {onPutOff && (
            <button
              onClick={onPutOff}
              aria-label="이 장소를 나중에 볼 목록에 저장"
              className="group flex-1 flex items-center justify-center gap-1.5 bg-hanji-deep hover:bg-gold/10 hover:text-gold-deep hover:border-gold/30 text-muk-soft font-bold py-3 rounded-2xl border border-line transition-all active:scale-95 text-xs focus:outline-none"
            >
              {/* 저장 인지 강화용 북마크 — hover/press 시 채워지며 살짝 팝(순수 Tailwind, 과하지 않게) */}
              <Bookmark
                size={14}
                className="fill-transparent transition-all duration-300 group-hover:fill-gold group-hover:scale-110 group-active:scale-125"
              />
              나중에 볼게요
            </button>
          )}
          <button
            onClick={onAccept}
            aria-label="여기로 길안내 시작"
            className="flex-1 bg-gradient-to-r from-gold to-terracotta hover:from-gold-deep hover:to-terracotta text-white font-bold py-3 rounded-2xl transition-all active:scale-95 text-xs shadow-[0_4px_14px_rgba(193,85,59,0.25)] focus:outline-none"
          >
            여기로 갈래요
          </button>
        </div>
      </>
      )}
    </motion.div>
  );
}
