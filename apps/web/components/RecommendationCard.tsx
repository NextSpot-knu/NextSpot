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
  tttvScore?: number;
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
  tttvScore,
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
  
  // Meeting room mock state
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showBookingModal, setShowBookingModal] = useState(false);
  const [bookingTime, setBookingTime] = useState('09:00');
  const [bookingName, setBookingName] = useState('');
  
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
        address: facility?.features?.address || '경상북도 구미시 산단로',
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
        // 동명 체인이 타지로 잡히는 것을 차단: '지코바 송정점'→부산 해운대, '선비꼬마김밥'→서울 본사 처럼
        // 카카오 1순위가 다른 도시일 수 있다. '구미' 주소를 가진 첫 결과만 채택하고, 없으면 우리 DB(구미) 주소로 폴백.
        const place = (status === window.kakao.maps.services.Status.OK && Array.isArray(data))
          ? data.find((p: any) => ((p.road_address_name || p.address_name || '').includes('구미')))
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
          // 구미 매칭 결과가 없으면(타지 체인만 잡히거나 검색 실패) 우리 데이터의 구미 주소로 폴백.
          setPlaceInfo({
            address: facility?.features?.address || '경상북도 구미시 산단로',
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

  const hasTttvMetrics = tttvScore !== undefined;

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
      className={`w-full bg-[#111622]/95 backdrop-blur-2xl border border-white/10 rounded-3xl ${isMinimized ? 'p-3' : 'p-5'} shadow-[0_10px_35px_rgba(0,0,0,0.5)] flex flex-col ${isMinimized ? 'gap-1' : 'gap-3'} select-none relative overflow-hidden`}
      drag={(showScheduleModal || showBookingModal) ? false : "y"}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={0.2}
      onDragEnd={handleDragEnd}
      layout
      transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
    >
      {/* Decorative upper border glow */}
      <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-blue-500/80 to-transparent" />

      {/* Swipe/Drag Handle Bar */}
      <div 
        className="w-16 h-1.5 bg-white/20 hover:bg-white/30 rounded-full mx-auto mb-1 cursor-pointer flex items-center justify-center transition-colors"
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
           <span className="text-sm font-bold text-white truncate max-w-[200px]">{title}</span>
           <span className="text-[10px] text-blue-400 font-bold bg-blue-500/10 px-2 py-0.5 rounded-full border border-blue-500/20 whitespace-nowrap">
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
              <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-gradient-to-r from-blue-600 to-blue-400 text-white text-[10px] font-black rounded-lg shadow-sm shadow-blue-500/20">
                <Sparkles size={12} />
                추천 {rank}순위
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-500/20 text-blue-300 text-[10px] font-bold rounded-lg">
                <Sparkles size={12} />
                AI 추천
              </span>
            )}
            {totalCandidates && rank && (
              <span className="text-[10px] text-gray-400 font-medium">대안 {totalCandidates}개 중</span>
            )}
          </div>
          <h3 className="text-xl font-bold text-white tracking-tight leading-tight">{title}</h3>
          
          {/* Status Pills — 펼쳐도(상세 표시 중에도) 혼잡도·잔여석은 항상 표시 */}
          {facility && facility.congestionLevel !== undefined && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${
                facility.congestionLevel >= 0.75
                  ? 'bg-orange-500/10 border-orange-500/20 text-orange-400'
                  : facility.congestionLevel >= 0.5
                  ? 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                  : facility.congestionLevel >= 0.25
                  ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                  : 'bg-blue-500/10 border-blue-500/20 text-blue-400'
              }`}>
                혼잡도: {facility.congestionLevel >= 0.75 ? '혼잡' : facility.congestionLevel >= 0.5 ? '보통' : facility.congestionLevel >= 0.25 ? '여유' : '한산'}
              </span>
              <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-white/5 border border-white/10 text-slate-300">
                잔여: {Math.max(0, (facility.capacity || 0) - (facility.currentCount || 0))}자리 (총 {facility.capacity})
              </span>
            </div>
          )}
        </div>

        {/* Dynamic Badge (TTTV Score or match percentage) */}
        {hasTttvMetrics ? (
          <div className="relative group">
            <div
              className="flex flex-col items-center justify-center min-w-[60px] h-[60px] rounded-2xl border border-purple-500/40 bg-gradient-to-b from-purple-500/20 to-purple-500/5 cursor-pointer shadow-lg shadow-purple-500/10"
            >
              <span className="text-[9px] text-purple-300 font-bold uppercase mb-0.5">TTTV 점수</span>
              <span className="text-white font-black text-xl leading-none">{Math.round(tttvScore || 0)}<span className="text-[10px] font-normal text-purple-200 ml-0.5">점</span></span>
            </div>
            
            {/* Info Icon */}
            <div className="absolute -top-1.5 -right-1.5 bg-[#111622] rounded-full p-0.5 border border-purple-500/30 shadow-md">
              <Info size={12} className="text-purple-300" />
            </div>

            {/* Tooltip */}
            <div className="absolute top-full right-0 mt-3 w-[260px] p-3.5 bg-[#161c28]/95 backdrop-blur-xl border border-purple-500/20 rounded-xl shadow-[0_10px_30px_rgba(0,0,0,0.5)] opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 pointer-events-none">
              <p className="text-[11px] text-slate-300 leading-relaxed text-right break-keep space-y-1">
                <span className="block mb-1.5"><strong className="text-purple-300 font-bold text-[12px]">TTTV Score란?</strong></span>
                <span className="block">InduSpot의 핵심 기술로, 도착 시점의 혼잡도를 미리 예측하는 <strong className="text-purple-200">머신러닝 AI 모델</strong>과 사용자의 선호도를 분석하는 <strong className="text-purple-200">벡터 알고리즘</strong>의 결합.</span>
                <span className="block mt-1.5">지금 이 순간, 사용자의 시간 가치를 극대화하는 가장 완벽한 목적지를 제안합니다.</span>
              </p>
            </div>
          </div>
        ) : (
          matchPercentage !== undefined && (
            <div className="flex flex-col items-center justify-center min-w-[60px] h-[60px] rounded-2xl border border-blue-500/30 bg-blue-500/10 shadow-md">
              <span className="text-white font-black text-lg">{matchPercentage}%</span>
              <span className="text-[9px] text-blue-300 font-semibold mt-0.5">Match</span>
            </div>
          )
        )}
      </div>



      {/* TTTV Metric Grid (Only if metrics are provided) */}
      {hasTttvMetrics && facilityType !== 'rest_area' && (
        <div className="flex flex-col gap-2 mt-1 cursor-pointer" onClick={toggleExpand}>
          {facilityType === 'meeting_room' ? (
            <div className="grid grid-cols-2 gap-1 bg-white/5 rounded-2xl p-2.5 border border-white/5 text-[11px]">
              <div className="text-center">
                <span className="text-slate-400 block text-[9px] mb-0.5 font-medium">현재 이용현황</span>
                <span className={`font-extrabold ${(facility?.currentCount ?? 0) > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                  {(facility?.currentCount ?? 0) > 0 ? `사용중 ${facility.currentCount}/${facility.capacity}` : '비어있음'}
                </span>
              </div>
              <div className="text-center border-l border-white/10">
                <span className="text-slate-400 block text-[9px] mb-0.5 font-medium">예상 대기</span>
                <span className="font-extrabold text-amber-400">
                  {(facility?.currentCount ?? 0) > 0 ? `${facility?.features?.remainingMinutes || 15}분` : '즉시 이용'}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                {/* Time Cost Column */}
                <div className="flex-1 bg-gradient-to-br from-blue-500/10 to-blue-500/5 border border-blue-500/20 rounded-2xl p-3 flex flex-col justify-center relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-2 opacity-20">
                    <Clock size={24} className="text-blue-300" />
                  </div>
                  <span className="text-blue-300 text-[10px] font-semibold mb-1">총 소요 시간</span>
                  <div className="flex items-baseline gap-1 mb-1.5">
                    <span className="text-2xl font-black text-white">{timeToService}</span>
                    <span className="text-xs text-blue-200 font-medium">분</span>
                  </div>
                  <div className="flex items-center gap-2 text-[9px] text-blue-200/80 font-medium">
                    <span className="bg-blue-500/20 px-1.5 py-0.5 rounded text-blue-300">대기 {expectedWait}분</span>
                    <span className="text-blue-500/50">+</span>
                    <span className="bg-emerald-500/20 px-1.5 py-0.5 rounded text-emerald-400">이동 {expectedTravel}분</span>
                  </div>
                </div>

                {/* Preference Column */}
                <div className="w-[110px] bg-white/5 border border-white/10 rounded-2xl p-3 flex flex-col justify-center items-center text-center">
                  <span className="text-slate-400 text-[10px] font-semibold mb-1">취향 일치율</span>
                  <div className="flex items-baseline gap-0.5 mb-1">
                    <span className="text-xl font-black text-sky-400">{preferencePercent}</span>
                    <span className="text-xs text-sky-400/80 font-bold">%</span>
                  </div>
                  {facilityType === 'parking' ? (
                    <span className="text-[9px] text-slate-500 mt-0.5 line-clamp-2">주차공간 맞춤</span>
                  ) : (
                    <span className="text-[9px] text-slate-500 mt-0.5 line-clamp-2">사용자 패턴 기반</span>
                  )}
                </div>
              </div>

              {/* Timeline UI */}
              {currentTime && arrivalTime && serviceTime && (
                <div className="bg-white/5 border border-white/10 rounded-2xl px-4 py-3 flex flex-col gap-3">
                  <div className="flex items-start justify-between relative mt-1">
                    {/* Connecting Line */}
                    <div className="absolute top-[3px] left-4 right-4 h-[2px] bg-white/10 z-0" />
                    
                    {/* Travel Duration Label */}
                    <div className="absolute top-[-10px] left-[25%] -translate-x-1/2 z-10">
                      <span className="text-[9px] font-medium text-emerald-400 bg-[#161c28] px-1.5 py-0.5 rounded border border-emerald-500/20">이동 {travelMins}분</span>
                    </div>
                    {/* Wait Duration Label */}
                    <div className="absolute top-[-10px] left-[75%] -translate-x-1/2 z-10">
                      <span className="text-[9px] font-medium text-amber-400 bg-[#161c28] px-1.5 py-0.5 rounded border border-amber-500/20">대기 {waitMins}분</span>
                    </div>
                    
                    {/* Current Time Step */}
                    <div className="flex flex-col items-center z-10 w-12">
                      <div className="w-2 h-2 rounded-full bg-blue-500 ring-4 ring-[#1a2133] mb-1.5" />
                      <span className="text-[10px] text-white font-bold">{formatTime(currentTime)}</span>
                      <span className="text-[9px] text-slate-400 mt-0.5">출발</span>
                    </div>
                    
                    {/* Arrival Time Step */}
                    <div className="flex flex-col items-center z-10 w-12">
                      <div className="w-2 h-2 rounded-full bg-emerald-400 ring-4 ring-[#1a2133] mb-1.5" />
                      <span className="text-[10px] text-white font-bold">{formatTime(arrivalTime)}</span>
                      <span className="text-[9px] text-slate-400 mt-0.5">도착</span>
                    </div>

                    {/* Service Start Step */}
                    <div className="flex flex-col items-center z-10 w-12">
                      <div className="w-2 h-2 rounded-full bg-amber-400 ring-4 ring-[#1a2133] mb-1.5" />
                      <span className="text-[10px] text-white font-bold">{formatTime(serviceTime)}</span>
                      <span className="text-[9px] text-slate-400 mt-0.5">{facilityType === 'cafeteria' ? '식사' : '이용'}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 휴게실 특화 UI (TTTV 미사용) */}
      {facilityType === 'rest_area' && (
        <div className="flex flex-col gap-2 mt-1 cursor-pointer" onClick={toggleExpand}>
          {/* 예상 대기 — 혼잡도와 연관(혼잡↑ → 대기↑) */}
          <div className="flex justify-between items-center bg-white/5 rounded-2xl p-3 border border-white/10 text-xs">
            <span className="text-slate-300 font-medium">예상 대기</span>
            <span className="font-extrabold text-rose-300">
              {(() => {
                const c = facility?.congestionLevel ?? 0;
                if (c >= 0.75) return `약 ${10 + Math.round(((c - 0.75) / 0.25) * 20)}분`; // 혼잡 10~30분
                if (c >= 0.5) return `약 ${5 + Math.round(((c - 0.5) / 0.25) * 5)}분`;     // 보통 5~10분
                if (c >= 0.25) return `약 ${2 + Math.round(((c - 0.25) / 0.25) * 3)}분`;    // 여유 2~5분
                return '즉시 이용 가능';                                                      // 한산
              })()}
            </span>
          </div>
          <div className="flex justify-between items-center bg-white/5 rounded-2xl p-3 border border-white/10 text-xs">
            <span className="text-slate-300 font-medium">안마의자 이용현황</span>
            <span className="font-extrabold text-amber-400">
              {facility?.features?.massageChairs ? `${facility.features.massageChairs.inUse} / ${facility.features.massageChairs.total}` : '0 / 3'}
            </span>
          </div>
          <div className="flex justify-between items-center bg-white/5 rounded-2xl p-3 border border-white/10 text-xs">
            <span className="text-slate-300 font-medium">수면캡슐 이용현황</span>
            <span className="font-extrabold text-sky-400">
              {facility?.features?.sleepCapsules ? `${facility.features.sleepCapsules.inUse} / ${facility.features.sleepCapsules.total}` : '0 / 2'}
            </span>
          </div>
          <div className="flex justify-between items-center bg-white/5 rounded-2xl p-3 border border-white/10 text-xs">
            <span className="text-slate-300 font-medium">플레이스테이션 이용현황</span>
            <span className="font-extrabold text-purple-400">
              {facility?.features?.playstation ? `${facility.features.playstation.inUse} / ${facility.features.playstation.total}` : '0 / 1'}
            </span>
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
            <div className="border-t border-white/10 pt-3.5 space-y-3 text-xs text-slate-300">
          
          {/* AI 추천 사유 (WP3 Gemini, 있을 때만) */}
          {reason && (
            <p className="text-[13px] leading-relaxed text-sky-200/95 bg-sky-500/10 border border-sky-500/20 rounded-2xl px-3.5 py-2.5">
              💡 {reason}
            </p>
          )}
          
          {/* Rating */}
          <div className="flex items-center gap-2">
            <div className="flex items-center text-amber-400">
              <Star size={14} className="fill-amber-400 mr-0.5" />
              <span className="font-extrabold text-white">{placeInfo?.rating ?? 4.5}</span>
            </div>
            <span className="text-slate-500">|</span>
            <span className="text-slate-400">리뷰 {placeInfo?.reviewCount ?? 20}개</span>
            
            {placeInfo?.url && (
              <a 
                href={placeInfo.url} 
                target="_blank" 
                rel="noreferrer"
                className="ml-auto text-blue-400 hover:text-blue-300 underline font-bold tracking-tight"
              >
                상세 리뷰 보기 ↗
              </a>
            )}
          </div>

          {/* Address */}
          <div className="flex items-start gap-2">
            <MapPin size={14} className="text-slate-400 mt-0.5 flex-shrink-0" />
            <div>
              <span className="text-slate-400 block text-[9px] uppercase font-bold">주소</span>
              <span className="text-slate-200 leading-relaxed">{placeInfo?.address}</span>
            </div>
          </div>

          {/* Phone */}
          <div className="flex items-start gap-2">
            <Phone size={14} className="text-slate-400 mt-0.5 flex-shrink-0" />
            <div>
              <span className="text-slate-400 block text-[9px] uppercase font-bold">전화번호</span>
              <span className="text-slate-200">{placeInfo?.phone}</span>
            </div>
          </div>

          {/* Operating Hours */}
          <div className="flex items-start gap-2">
            <Clock size={14} className="text-slate-400 mt-0.5 flex-shrink-0" />
            <div>
              <span className="text-slate-400 block text-[9px] uppercase font-bold">운영 시간</span>
              <span className="text-slate-200">
                {facility?.operatingHours?.open || '09:00'} ~ {facility?.operatingHours?.close || '22:00'}
                {facility?.operatingHours?.weekday && ` (${facility.operatingHours.weekday})`}
              </span>
            </div>
          </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Action Buttons: Reject, Put off, Accept Route (or custom for meeting rooms) */}
      {facilityType === 'rest_area' ? null : facilityType === 'meeting_room' ? (
        <div className="flex gap-2 mt-1">
          <button
            onClick={() => setShowScheduleModal(true)}
            className="flex-1 bg-white/5 hover:bg-white/10 text-gray-300 font-bold py-3 rounded-2xl border border-white/10 transition-all text-xs"
          >
            예약 현황
          </button>
          <button
            onClick={() => setShowBookingModal(true)}
            className="flex-1 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold py-3 rounded-2xl transition-all text-xs shadow-md shadow-blue-500/20"
          >
            예약하기
          </button>
        </div>
      ) : (
        <div className="flex gap-2 mt-1">
          <button
            onClick={onReject}
            className="flex-1 bg-white/5 hover:bg-rose-500/10 hover:text-rose-400 hover:border-rose-500/30 text-gray-300 font-bold py-3 rounded-2xl border border-white/10 transition-all text-xs focus:outline-none"
          >
            Reject
          </button>
          {onPutOff && (
            <button
              onClick={onPutOff}
              className="flex-1 bg-white/5 hover:bg-amber-500/10 hover:text-amber-400 hover:border-amber-500/30 text-gray-300 font-bold py-3 rounded-2xl border border-white/10 transition-all text-xs focus:outline-none"
            >
              Put off
            </button>
          )}
          <button
            onClick={onAccept}
            className="flex-1 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold py-3 rounded-2xl transition-all text-xs shadow-md shadow-blue-500/20 focus:outline-none"
          >
            Accept Route
          </button>
        </div>
      )}

      {/* Meeting Room Schedule Modal (Mock) */}
      {showScheduleModal && (
        <div className="absolute inset-0 z-50 bg-[#111622]/95 backdrop-blur-xl flex flex-col p-5">
          <div className="flex justify-between items-center mb-4">
            <h4 className="text-white font-bold text-lg">오늘 예약 현황</h4>
            <button onClick={() => setShowScheduleModal(false)} className="text-gray-400 hover:text-white">✕</button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-2 pr-2 custom-scrollbar">
            {['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00'].map((time, idx) => {
              const isBooked = idx % 3 === 1 || idx % 4 === 2; // dummy logic
              return (
                <div key={time} className={`flex items-center justify-between p-3 rounded-xl border ${isBooked ? 'bg-white/5 border-white/10' : 'bg-blue-500/10 border-blue-500/20'}`}>
                  <span className="text-sm font-bold text-slate-300">{time} ~</span>
                  {isBooked ? (
                    <span className="text-xs text-slate-400">예약됨 (홍길동)</span>
                  ) : (
                    <span className="text-xs text-blue-400 font-bold">예약 가능</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      </>
      )}

      {/* Meeting Room Booking Modal (Mock) */}
      {showBookingModal && (
        <div className="absolute inset-0 z-50 bg-[#111622]/95 backdrop-blur-xl flex flex-col p-5 justify-center">
          <div className="flex justify-between items-center mb-6">
            <h4 className="text-white font-bold text-lg">회의실 예약하기</h4>
            <button onClick={() => setShowBookingModal(false)} className="text-gray-400 hover:text-white">✕</button>
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">예약 시간 (비어있는 시간대)</label>
              <select 
                className="w-full bg-black/50 border border-white/20 text-white rounded-xl p-3 outline-none"
                value={bookingTime}
                onChange={(e) => setBookingTime(e.target.value)}
              >
                <option value="09:00">09:00 ~ 09:30</option>
                <option value="11:00">11:00 ~ 11:30</option>
                <option value="13:30">13:30 ~ 14:00</option>
                <option value="15:00">15:00 ~ 15:30</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">예약자명</label>
              <input 
                type="text" 
                placeholder="이름을 입력하세요"
                className="w-full bg-black/50 border border-white/20 text-white rounded-xl p-3 outline-none"
                value={bookingName}
                onChange={(e) => setBookingName(e.target.value)}
              />
            </div>
            <button 
              onClick={() => {
                if (!bookingName) return alert('예약자명을 입력해주세요.');
                alert(`${bookingName}님, ${bookingTime} 예약이 완료되었습니다.`);
                setShowBookingModal(false);
                setBookingName('');
              }}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded-xl mt-4"
            >
              예약 완료
            </button>
          </div>
        </div>
      )}
    </motion.div>
  );
}
