'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Menu, Bell, Home, Bookmark, User, Compass, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { RecommendationCard } from '@/components/RecommendationCard';
import { CongestionAlertToggle } from '@/components/CongestionAlertToggle';
import { useT } from '@/lib/i18n/I18nProvider';

// 저장된 카테고리(한국어 라벨) → i18n category 키 매핑(표시용 번역).
const CATEGORY_LABEL_TO_KEY: Record<string, string> = {
  '음식점': 'restaurant',
  '카페': 'cafe',
  '관광지': 'attraction',
  '문화시설': 'culture',
};

interface BookmarkData {
  id: string;
  name: string;
  category: string;
  trafficStatus: 'orange' | 'yellow' | 'green' | 'blue';
  waitTime: string;
  latitude?: number;
  longitude?: number;
  spot?: any;
  reason?: string; // 저장 시점의 추천 사유(백엔드 Gemini 또는 미러)
}

export default function SavedPage() {
  const router = useRouter();
  const t = useT();
  const [bookmarks, setBookmarks] = useState<BookmarkData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedBookmark, setSelectedBookmark] = useState<BookmarkData | null>(null);
  const [currentTime, setCurrentTime] = useState<Date | null>(null);
  // 저장 목록 카테고리 필터('all' | 음식점 | 카페 | 관광지 | 문화시설)
  const [activeCategory, setActiveCategory] = useState<string>('all');

  useEffect(() => {
    setCurrentTime(new Date());
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const formatTime = (date: Date | null) => {
    if (!date) return '';
    return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  useEffect(() => {
    // API Fetch Mockup
    // ⚠️ 백엔드 데이터 하드코딩 금지 원칙 준수
    // 실제로는 fetch('/api/bookmarks') 등을 통해 데이터를 가져옴
    const fetchBookmarks = async () => {
      setIsLoading(true);
      try {
        const saved = localStorage.getItem('nextspot_saved_facilities');
        if (saved) {
          const parsed = JSON.parse(saved);
          const compareBookmarks = (a: any, b: any) => {
            if (!a.spot || !b.spot) return (a.name || '').localeCompare(b.name || '', 'ko-KR');
            if (b.spot.score !== a.spot.score) return b.spot.score - a.spot.score;
            if (a.spot.timeToService !== b.spot.timeToService) return a.spot.timeToService - b.spot.timeToService;
            if (b.spot.preferencePercent !== a.spot.preferencePercent) return b.spot.preferencePercent - a.spot.preferencePercent;
            if (a.spot.expectedTravel !== b.spot.expectedTravel) return a.spot.expectedTravel - b.spot.expectedTravel;
            return (a.name || '').localeCompare(b.name || '', 'ko-KR');
          };
          parsed.sort(compareBookmarks);
          setBookmarks(parsed);
        } else {
          setBookmarks([]);
        }
      } catch (error) {
        console.warn('Failed to fetch bookmarks', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchBookmarks();
  }, []);



  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = bookmarks.filter(b => b.id !== id);
    setBookmarks(updated);
    localStorage.setItem('nextspot_saved_facilities', JSON.stringify(updated));
    if (selectedBookmark?.id === id) {
      setSelectedBookmark(null);
    }
    toast.success(t('saved.deleteSuccess'));
  };

  // 전체 초기화: 되돌릴 수 없는 파괴적 동작이므로 네이티브 confirm() 대신
  // 전역 sonner 토스트의 action/cancel 버튼으로 인페이지 확인을 받는다(다크 글래스 UI 유지).
  const handleClearAll = () => {
    toast(t('saved.clearConfirm'), {
      description: t('saved.clearConfirmDesc'),
      duration: 8000,
      action: {
        label: t('saved.clearAction'),
        onClick: () => {
          setBookmarks([]);
          localStorage.removeItem('nextspot_saved_facilities');
          setSelectedBookmark(null);
          toast.success(t('saved.clearedSuccess'));
        },
      },
      cancel: {
        label: t('common.cancel'),
        onClick: () => {},
      },
    });
  };

  const renderTrafficIndicator = (status: 'orange' | 'yellow' | 'green' | 'blue') => {
    // 혼잡 신호등: 색만 웜 팔레트로 교체(임계·매핑 로직 불변). 네온 글로우 제거.
    const colors = {
      orange: 'bg-terracotta',   // 혼잡
      yellow: 'bg-gold',         // 보통
      green: 'bg-emerald-500',   // 여유
      blue: 'bg-jade'            // 한산
    };
    return <div className={`w-3 h-3 rounded-full ${colors[status]}`} />;
  };

  // 카테고리별 개수 + 필터 적용 목록. 저장이 없는 카테고리는 칩을 감춘다.
  const categoryCounts = bookmarks.reduce<Record<string, number>>((acc, b) => {
    acc[b.category] = (acc[b.category] || 0) + 1;
    return acc;
  }, {});
  const availableCategories = Object.keys(CATEGORY_LABEL_TO_KEY).filter((c) => categoryCounts[c]);
  // 선택했던 카테고리가 삭제로 0이 되면 '전체'로 자동 복귀(빈 목록 혼란 방지).
  const effectiveCategory = activeCategory !== 'all' && !categoryCounts[activeCategory] ? 'all' : activeCategory;
  const visibleBookmarks = effectiveCategory === 'all' ? bookmarks : bookmarks.filter((b) => b.category === effectiveCategory);

  return (
    <div className="relative w-full h-[100dvh] bg-hanji flex flex-col overflow-hidden">

      {/* 헤더 */}
      <header className="flex justify-between items-center p-5 border-b border-line z-10 relative">
        <button className="text-muk-soft hover:text-muk transition-colors">
          <Menu size={24} />
        </button>
        <h1 className="text-xl font-bold font-serif text-muk tracking-wide">NextSpot</h1>
        <button className="text-muk-soft hover:text-muk transition-colors">
          <Bell size={24} />
        </button>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col relative z-10 p-6 overflow-y-auto pb-[calc(80px+env(safe-area-inset-bottom))] md:pb-6">
        {isLoading ? (
          // 저장 카드 형태의 스켈레톤(스피너 대체) — 실제 목록 레이아웃을 미리 암시한다.
          <div className="flex flex-col gap-4" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="bg-white rounded-2xl border border-line p-4 space-y-3 shadow-[0_2px_14px_rgba(43,35,32,0.06)] animate-pulse">
                <div className="flex items-center gap-2">
                  <div className="h-5 w-16 bg-hanji-deep rounded-md" />
                  <div className="w-3 h-3 rounded-full bg-hanji-deep" />
                </div>
                <div className="h-5 bg-hanji-deep w-2/3 rounded-md" />
                <div className="h-16 bg-hanji-deep/60 rounded-2xl w-full" />
              </div>
            ))}
          </div>
        ) : bookmarks.length === 0 ? (
          // Empty State
          <div className="flex-1 flex items-center justify-center">
            <div className="bg-white border border-line rounded-3xl p-8 flex flex-col items-center text-center w-full max-w-[320px] shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
              <div className="w-16 h-16 rounded-full bg-gradient-to-b from-gold/20 to-gold/10 border border-line flex items-center justify-center mb-6">
                <Star className="text-gold fill-gold/40" size={32} />
              </div>
              <h2 className="text-xl font-bold font-serif text-muk mb-3">{t('saved.emptyTitle')}</h2>
              <p className="text-muk-soft text-sm leading-relaxed mb-8 px-2">
                {t('saved.emptyBody')}
              </p>
              <button
                onClick={() => router.push('/main')}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gold hover:bg-gold-deep text-white text-sm font-semibold transition-all"
              >
                <Compass size={18} className="text-white" />
                <span>{t('saved.browseMap')}</span>
              </button>
            </div>
          </div>
        ) : (
          // List State
          <div className="flex flex-col gap-4">
            <div className="flex justify-between items-center px-1 mb-2">
              <div className="flex items-baseline gap-2">
                <h2 className="text-lg font-bold font-serif text-muk">{t('saved.title')}</h2>
                {/* 저장한 장소 총 개수 */}
                <span className="text-sm font-bold text-gold-deep bg-gold/15 border border-gold/30 rounded-full px-2.5 py-0.5">
                  {bookmarks.length}
                </span>
              </div>
              <button
                onClick={handleClearAll}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-terracotta/15 text-terracotta border border-terracotta/30 hover:bg-terracotta/25 transition-colors"
              >
                {t('saved.clearAll')}
              </button>
            </div>

            {/* 카테고리 필터 칩 — 저장이 있는 분류만 노출(2개 이상일 때). 각 칩에 개수 표시. */}
            {availableCategories.length > 1 && (
              <div className="flex gap-2 overflow-x-auto no-scrollbar px-1 pb-1">
                {(['all', ...availableCategories]).map((cat) => {
                  const isActive = effectiveCategory === cat;
                  const label = cat === 'all' ? t('saved.filterAll') : t(`category.${CATEGORY_LABEL_TO_KEY[cat]}`);
                  const count = cat === 'all' ? bookmarks.length : categoryCounts[cat];
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setActiveCategory(cat)}
                      aria-pressed={isActive}
                      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
                        isActive
                          ? 'bg-gold/15 border-gold text-muk'
                          : 'bg-white border-line text-muk-soft hover:bg-hanji-deep hover:text-muk'
                      }`}
                    >
                      {label}
                      <span className={`text-[11px] font-bold rounded-full px-1.5 ${isActive ? 'bg-gold/25 text-gold-deep' : 'bg-hanji-deep text-muk-soft'}`}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* 저장한 곳이 한산해지면 인앱 알림(옵트인) */}
            <div className="px-1 -mt-1 mb-1">
              <CongestionAlertToggle />
            </div>

            {/* 저장 카드 그리드 — 모바일 1열, PC(md) 2열, 초광폭(xl) 3열.
                전폭 1열 카드가 데스크톱에서 가로로 과하게 늘어나던 문제 해결. 2열을 기본으로 둔 건
                카드 내부 타임라인(출발·도착·이용 3노드+라벨)이 좁아지면 뭉개지기 때문 — 열당 폭 확보. */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start">
            {visibleBookmarks.map((bookmark, index) => (
              // 카드 안에 실제 삭제 <button> 을 두어야 하므로 카드 자체는 button 대신
              // role="button" 컨테이너로 둔다(button-in-button 무효 HTML 방지 + 키보드 접근).
              <div
                key={bookmark.id}
                role="button"
                tabIndex={0}
                aria-pressed={selectedBookmark?.id === bookmark.id}
                onClick={() => setSelectedBookmark(bookmark)}
                onKeyDown={(e) => {
                  // 내부 요소(삭제 버튼)에서 버블링된 키 이벤트는 무시해 중복 실행을 막는다.
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedBookmark(bookmark);
                  }
                }}
                className={`group flex flex-col p-4 rounded-2xl border transition-all text-left relative overflow-hidden cursor-pointer shadow-[0_2px_14px_rgba(43,35,32,0.06)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
                  selectedBookmark?.id === bookmark.id
                    ? 'bg-gold/15 border-gold'
                    : 'bg-white border-line hover:bg-hanji-deep'
                }`}
              >
                {/* 랭크 표시 뱃지 */}
                <div className="absolute top-0 left-0 bg-gold text-white text-[10px] font-bold px-2 py-1 rounded-br-lg z-10">
                  {t('saved.rankSuffix', { rank: index + 1 })}
                </div>
                
                {/* 상단: 기본 정보 */}
                <div className="flex justify-between items-start w-full">
                  <div className="pl-4">
                    <div className="flex items-center gap-2 mb-1 mt-1">
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-md bg-hanji-deep text-muk-soft">
                        {CATEGORY_LABEL_TO_KEY[bookmark.category] ? t(`category.${CATEGORY_LABEL_TO_KEY[bookmark.category]}`) : bookmark.category}
                      </span>
                      {renderTrafficIndicator(bookmark.trafficStatus)}
                    </div>
                    <h3 className="text-lg font-bold text-muk">{bookmark.name}</h3>
                  </div>
                  
                  {/* Delete Button — 실제 <button> 으로 시맨틱 교정(키보드 포커스/스크린리더 지원) */}
                  <div className="flex flex-col items-end pr-1 z-20">
                    <button
                      type="button"
                      aria-label={t('saved.deleteAria', { name: bookmark.name })}
                      onClick={(e) => handleDelete(bookmark.id, e)}
                      className="p-2 rounded-xl bg-terracotta/10 text-terracotta hover:bg-terracotta/20 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60 transition-opacity md:flex hidden"
                    >
                      <Trash2 size={18} />
                    </button>
                    <button
                      type="button"
                      aria-label={t('saved.deleteAria', { name: bookmark.name })}
                      onClick={(e) => handleDelete(bookmark.id, e)}
                      className="p-2.5 rounded-lg bg-terracotta/10 text-terracotta hover:bg-terracotta/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60 md:hidden flex"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>

                {/* 하단: 타임라인 */}
                {(() => {
                  const travelMins = bookmark.spot?.expectedTravel ?? 0;
                  const waitMins = bookmark.spot?.expectedWait ?? parseInt(bookmark.waitTime) ?? 0;
                  const timeToService = bookmark.spot?.timeToService ?? parseInt(bookmark.waitTime) ?? 0;
                  
                  const arrivalTime = currentTime ? new Date(currentTime.getTime() + travelMins * 60000) : null;
                  const serviceTime = arrivalTime ? new Date(arrivalTime.getTime() + waitMins * 60000) : null;
                  
                  if (!currentTime || !arrivalTime || !serviceTime) return null;
                  
                  return (
                    <div className="w-full mt-4 bg-hanji border border-line rounded-2xl px-4 py-3 flex flex-col gap-3">
                      <div className="flex justify-between items-center px-1 mb-1">
                        <span className="text-muk-soft text-[10px] font-semibold">{t('saved.totalTime')}</span>
                        <span className="text-gold font-bold text-sm">{t('saved.minutes', { n: timeToService })}</span>
                      </div>
                      <div className="flex items-start justify-between relative">
                        {/* 연결선 */}
                        <div className="absolute top-[3px] left-4 right-4 h-[2px] bg-line z-0" />

                        {/* 이동 시간 라벨 */}
                        <div className="absolute top-[-10px] left-[25%] -translate-x-1/2 z-10">
                          <span className="text-[10px] font-medium text-jade bg-hanji px-1.5 py-0.5 rounded border border-jade/25">{t('saved.travelLabel', { n: travelMins })}</span>
                        </div>
                        {/* 대기 시간 라벨 */}
                        <div className="absolute top-[-10px] left-[75%] -translate-x-1/2 z-10">
                          <span className="text-[10px] font-medium text-gold bg-hanji px-1.5 py-0.5 rounded border border-gold/25">{t('saved.waitLabel', { n: waitMins })}</span>
                        </div>

                        {/* 출발 시점 */}
                        <div className="flex flex-col items-center z-10 w-12">
                          <div className="w-2 h-2 rounded-full bg-muk ring-4 ring-hanji mb-1.5" />
                          <span className="text-[10px] text-muk font-bold">{formatTime(currentTime)}</span>
                          <span className="text-[10px] text-muk-soft mt-0.5">{t('saved.depart')}</span>
                        </div>

                        {/* 도착 시점 */}
                        <div className="flex flex-col items-center z-10 w-12">
                          <div className="w-2 h-2 rounded-full bg-jade ring-4 ring-hanji mb-1.5" />
                          <span className="text-[10px] text-muk font-bold">{formatTime(arrivalTime)}</span>
                          <span className="text-[10px] text-muk-soft mt-0.5">{t('saved.arrive')}</span>
                        </div>

                        {/* 이용 시작 시점 */}
                        <div className="flex flex-col items-center z-10 w-12">
                          <div className="w-2 h-2 rounded-full bg-gold ring-4 ring-hanji mb-1.5" />
                          <span className="text-[10px] text-muk font-bold">{formatTime(serviceTime)}</span>
                          <span className="text-[10px] text-muk-soft mt-0.5">{bookmark.category === '음식점' || bookmark.category === '카페' ? t('saved.dine') : t('saved.view')}</span>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            ))}
            </div>
          </div>
        )}
      </main>

      {/* Selected Item Detail Bottom Sheet (RecommendationCard) */}
      {selectedBookmark && (
        <div className="absolute bottom-[calc(80px+env(safe-area-inset-bottom))] w-full z-20 px-4 animate-slide-up">
          <RecommendationCard
            title={selectedBookmark.name}
            matchPercentage={100}
            reason={selectedBookmark.reason}
            description={`현재 혼잡도: ${selectedBookmark.trafficStatus === 'orange' ? '혼잡' : selectedBookmark.trafficStatus === 'yellow' ? '보통' : selectedBookmark.trafficStatus === 'green' ? '여유' : '한산'}. 예상 대기 시간: ${selectedBookmark.waitTime}.`}
            spotScore={selectedBookmark.spot?.score}
            preferencePercent={selectedBookmark.spot?.preferencePercent}
            expectedWait={selectedBookmark.spot?.expectedWait ?? parseInt(selectedBookmark.waitTime) ?? 0}
            expectedTravel={selectedBookmark.spot?.expectedTravel ?? 0}
            timeToService={selectedBookmark.spot?.timeToService ?? parseInt(selectedBookmark.waitTime) ?? 0}
            facilityType={selectedBookmark.category === '음식점' ? 'restaurant' : selectedBookmark.category === '카페' ? 'cafe' : selectedBookmark.category === '관광지' ? 'attraction' : selectedBookmark.category === '문화시설' ? 'culture' : 'restaurant'}
            facility={{
              congestionLevel: selectedBookmark.trafficStatus === 'orange' ? 0.85 : selectedBookmark.trafficStatus === 'yellow' ? 0.6 : selectedBookmark.trafficStatus === 'green' ? 0.4 : 0.1,
              capacity: 100,
              currentCount: selectedBookmark.trafficStatus === 'orange' ? 85 : selectedBookmark.trafficStatus === 'yellow' ? 60 : selectedBookmark.trafficStatus === 'green' ? 40 : 10,
            }}
            onAccept={() => {
              const destUrl = selectedBookmark.latitude && selectedBookmark.longitude
                ? `https://map.kakao.com/link/to/${encodeURIComponent(selectedBookmark.name)},${selectedBookmark.latitude},${selectedBookmark.longitude}`
                : `https://map.kakao.com/?q=${encodeURIComponent(selectedBookmark.name)}`;
              window.open(destUrl, '_blank');
            }}
            onReject={() => {
              const updated = bookmarks.filter(b => b.id !== selectedBookmark.id);
              setBookmarks(updated);
              localStorage.setItem('nextspot_saved_facilities', JSON.stringify(updated));
              setSelectedBookmark(null);
              toast.success(t('saved.removedFromSaved', { name: selectedBookmark.name }));
            }}
          />
        </div>
      )}

      {/* 은은한 노을 광원 (콜드 블루 글로우 → 웜) */}
      <div className="absolute top-1/4 left-1/4 w-[300px] h-[300px] bg-sunset-1/10 rounded-full blur-[100px] pointer-events-none z-0"></div>
    </div>
  );
}
