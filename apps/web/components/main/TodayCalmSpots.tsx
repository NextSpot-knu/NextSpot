'use client';

// '🍃 지금 한산' 칩 + 바텀시트 — 지금 이 순간 여유로운 장소 TOP3 를 지도 레이어 컨트롤 행에 노출한다.
//
// 데이터: main 이 이미 가진 facilities(congestionLevel)에서 level<0.3 인 곳만 추린다(합성 주입 없음).
//   정렬: ① 온보딩 취향 카테고리(nextspot_setup_prefs) 우선 → ② 더 한산한 순 → ③ 가까운 순.
//   3곳 미만이면 있는 만큼, 0곳이면 칩 자체를 렌더하지 않는다(무해 폴백).
// 상호작용: 카드 탭 → 시트 닫고 onFocus(f) 위임(부모가 setSelectedFacility + panToVisible) — FestivalBanner 미러.
// 팔레트·포털·모달 관례는 FestivalBanner 를 그대로 따른다(한지 웜톤 + body 포털 + framer-motion).

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { loadTravelContext } from '@/lib/travelContext';
import { motion, AnimatePresence } from 'framer-motion';
import { Leaf, MapPin, X } from 'lucide-react';
import { haversineMeters, formatDistance } from '@/lib/map/geo';
import { useT } from '@/lib/i18n/I18nProvider';

// 온보딩 취향 카테고리(우선 정렬용 시설 타입들). 없으면 빈 배열.
//
// 예전에는 저장 형태를 직접 파싱해 `category`(v1 단수형 한국어 라벨) 하나를 읽었는데,
// 지금 그 키에 저장되는 것은 v2 의 `categories`(영문 키 **배열**)다. 그래서 아래 ① 순위
// 티어는 아무에게도 적용되지 않는 죽은 코드였다 — 모두가 혼잡도·거리 순만 봤다.
function readPreferredTypes(): string[] {
  return loadTravelContext().categories;
}

interface CalmSpot {
  id: string;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
  congestionLevel: number;
  _distM: number;
}

export function TodayCalmSpots({
  facilities,
  userLocation,
  onFocus,
  className = '',
}: {
  facilities: any[];
  userLocation: { lat: number; lng: number };
  onFocus?: (facility: any) => void;
  className?: string;
}) {
  const t = useT();
  const [isOpen, setIsOpen] = useState(false);
  const [mounted, setMounted] = useState(false); // 포털은 클라이언트 마운트 후에만(정적 export/SSR 안전)
  const [prefTypes, setPrefTypes] = useState<string[]>([]);

  useEffect(() => {
    setMounted(true);
    setPrefTypes(readPreferredTypes());
  }, []);

  // 한산(level<0.3) 후보 → 취향 우선 → 더 한산 → 가까운 순 → 상위 3곳.
  const calm = useMemo<CalmSpot[]>(() => {
    const candidates = (facilities || [])
      .filter(
        (f: any) =>
          typeof f?.congestionLevel === 'number' &&
          f.congestionLevel < 0.3 &&
          Number.isFinite(f?.latitude) &&
          Number.isFinite(f?.longitude),
      )
      .map((f: any) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        latitude: f.latitude,
        longitude: f.longitude,
        congestionLevel: f.congestionLevel,
        _distM: haversineMeters(userLocation.lat, userLocation.lng, f.latitude, f.longitude),
      }));

    candidates.sort((a, b) => {
      // v2 는 카테고리를 여러 개 고를 수 있다 — 하나만 비교하면 나머지 선택이 무시된다.
      const ap = prefTypes.includes(a.type) ? 0 : 1;
      const bp = prefTypes.includes(b.type) ? 0 : 1;
      if (ap !== bp) return ap - bp; // ① 취향 카테고리 우선
      if (a.congestionLevel !== b.congestionLevel) return a.congestionLevel - b.congestionLevel; // ② 더 한산
      return a._distM - b._distM; // ③ 가까운 순
    });

    return candidates.slice(0, 3);
  }, [facilities, userLocation.lat, userLocation.lng, prefTypes]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);

  // 한산한 곳이 없으면(0곳) 칩 자체를 숨긴다.
  if (calm.length === 0) return null;

  // 카드 상단 혼잡 pill 과 동일 임계(한산<0.25 / 여유<0.5). 후보는 모두 <0.3 이라 quiet|relaxed 만 나온다.
  const calmKey = (c: number) => (c >= 0.25 ? 'relaxed' : 'quiet');

  return (
    <>
      {/* 트리거 칩 — 히트맵/축제 칩과 동일 문법(pill + fractal-glass). */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-haspopup="dialog"
        aria-label={t('calm.chipAria', { n: String(calm.length) })}
        className={`flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-[13px] font-medium transition-all fractal-glass shadow-[0_2px_14px_rgba(43,35,32,0.06)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 sm:px-4 sm:py-2 sm:text-sm bg-white/80 border-line text-muk-soft hover:bg-white hover:text-muk ${className}`}
      >
        <span aria-hidden>🍃</span>
        {t('calm.chip')}
        <span className="min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center bg-jade/20 text-jade">
          {calm.length}
        </span>
      </button>

      {/* 목록 바텀시트 — body 포털(상단 오버레이 pointer-events-none 조상 탈출). */}
      {mounted &&
        createPortal(
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
                  aria-labelledby="calm-sheet-title"
                  className="relative w-full max-w-sm max-h-[88dvh] sm:max-h-[82dvh] bg-hanji border border-line rounded-t-3xl sm:rounded-3xl shadow-[0_-8px_40px_rgba(43,35,32,0.2)] sm:shadow-[0_20px_60px_rgba(43,35,32,0.25)] flex flex-col overflow-hidden"
                >
                  <div className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-transparent via-jade/60 to-transparent" />

                  {/* 헤더 */}
                  <div className="flex items-start justify-between gap-3 p-6 pb-4">
                    <div>
                      <h2 id="calm-sheet-title" className="text-lg font-serif font-bold text-muk leading-tight">
                        🍃 {t('calm.title')}
                      </h2>
                      <p className="text-[11px] text-muk-soft mt-1 font-medium">{t('calm.subtitle')}</p>
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

                  {/* 목록 — 카드 탭 시 시트 닫고 부모에 포커스 위임. */}
                  <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] flex flex-col gap-3">
                    {calm.map((spot) => (
                      <button
                        key={spot.id}
                        type="button"
                        onClick={() => {
                          onFocus?.(spot);
                          setIsOpen(false);
                        }}
                        aria-label={t('calm.showOnMapAria', { name: spot.name })}
                        className="group text-left rounded-2xl border border-line bg-white/70 hover:bg-jade/5 hover:border-jade/40 transition-colors p-4 flex items-center gap-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-jade/50"
                      >
                        <span className="w-9 h-9 shrink-0 rounded-full bg-jade/10 border border-jade/25 flex items-center justify-center text-jade">
                          <Leaf size={18} aria-hidden />
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-muk leading-snug truncate">{spot.name}</p>
                          <div className="flex flex-wrap items-center gap-1.5 mt-1">
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-hanji-deep text-muk-soft">
                              {t(`category.${spot.type}`)}
                            </span>
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-jade/10 border border-jade/25 text-jade">
                              {t(`congestion.${calmKey(spot.congestionLevel)}`)}
                            </span>
                            {Number.isFinite(spot._distM) && (
                              <span className="flex items-center gap-0.5 text-[10px] text-muk-soft font-medium">
                                <MapPin size={10} aria-hidden />
                                {formatDistance(spot._distM)}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
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

export default TodayCalmSpots;
