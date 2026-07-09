'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, Ticket, Compass, AlertCircle, CheckCircle2 } from 'lucide-react';
import { apiClient } from '@/lib/api-client';

// 백엔드 /api/v1/coupons/mine 응답(snake_case)을 api-client 가 camelCase 로 변환해 준다.
interface Coupon {
  id: string;
  facilityId: string;
  facilityName: string | null;
  facilityType: string | null;
  couponRate: number;   // 0.20 = 20%
  status: 'issued' | 'used';
  issuedAt: string | null;
  usedAt: string | null;
}

// 시설 유형 → 한국어 라벨(관제 대시보드와 동일 매핑).
const TYPE_LABEL: Record<string, string> = {
  restaurant: '음식점',
  cafe: '카페',
  attraction: '관광지',
  culture: '문화시설',
};

function formatDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
  } catch {
    return '';
  }
}

export default function CouponsPage() {
  const router = useRouter();
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchCoupons = async () => {
      setIsLoading(true);
      setHasError(false);
      try {
        // api-client 가 Supabase 세션 토큰을 실어 보낸다(다른 관광객 페이지와 동일 경로).
        const data = await apiClient.get('/api/v1/coupons/mine');
        if (!cancelled) setCoupons(Array.isArray(data) ? data : []);
      } catch (err) {
        console.warn('Failed to fetch coupons', err);
        if (!cancelled) setHasError(true);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    fetchCoupons();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="relative w-full h-[100dvh] bg-hanji flex flex-col overflow-hidden">

      {/* 헤더 */}
      <header className="flex items-center gap-3 p-5 z-10 relative">
        <button
          type="button"
          aria-label="뒤로"
          onClick={() => router.back()}
          className="text-muk-soft hover:text-muk transition-colors"
        >
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-xl font-bold font-serif text-muk tracking-wide">내 쿠폰함</h1>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative z-10 px-6 overflow-y-auto pb-[120px] md:pb-6 no-scrollbar">
        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : hasError ? (
          // Error State
          <div className="flex-1 flex items-center justify-center">
            <div className="bg-white border border-line rounded-3xl p-8 flex flex-col items-center text-center w-full max-w-[320px] shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
              <div className="w-16 h-16 rounded-full bg-terracotta/10 border border-terracotta/20 flex items-center justify-center mb-6">
                <AlertCircle className="text-terracotta" size={32} />
              </div>
              <h2 className="text-xl font-bold font-serif text-muk mb-3">쿠폰을 불러오지 못했어요</h2>
              <p className="text-muk-soft text-sm leading-relaxed mb-8 px-2">
                잠시 후 다시 시도해 주세요.
              </p>
              <button
                onClick={() => router.refresh()}
                className="px-5 py-2.5 rounded-xl bg-gold hover:bg-gold-deep text-white text-sm font-semibold transition-all"
              >
                다시 시도
              </button>
            </div>
          </div>
        ) : coupons.length === 0 ? (
          // Empty State
          <div className="flex-1 flex items-center justify-center">
            <div className="bg-white border border-line rounded-3xl p-8 flex flex-col items-center text-center w-full max-w-[320px] shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
              <div className="w-16 h-16 rounded-full bg-gradient-to-b from-gold/20 to-gold/10 border border-line flex items-center justify-center mb-6">
                <Ticket className="text-gold" size={32} />
              </div>
              <h2 className="text-xl font-bold font-serif text-muk mb-3">아직 받은 쿠폰이 없어요</h2>
              <p className="text-muk-soft text-sm leading-relaxed mb-8 px-2">
                분산 추천을 받아 제휴 가맹점을 방문하면 할인 쿠폰이 여기에 쌓여요.
              </p>
              <button
                onClick={() => router.push('/main')}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gold hover:bg-gold-deep text-white text-sm font-semibold transition-all"
              >
                <Compass size={18} className="text-white" />
                <span>추천 둘러보기</span>
              </button>
            </div>
          </div>
        ) : (
          // List State
          <div className="flex flex-col gap-4 mt-2">
            <p className="text-sm text-muk-soft px-1">
              제휴 가맹점에서 아래 할인율을 받을 수 있어요.
            </p>

            {coupons.map((coupon) => {
              const used = coupon.status === 'used';
              const pct = Math.round((coupon.couponRate ?? 0) * 100);
              const typeLabel = coupon.facilityType ? TYPE_LABEL[coupon.facilityType] ?? coupon.facilityType : null;
              return (
                <div
                  key={coupon.id}
                  className={`relative flex items-stretch rounded-2xl border overflow-hidden shadow-[0_2px_14px_rgba(43,35,32,0.06)] transition-colors ${
                    used ? 'bg-hanji-deep border-line opacity-70' : 'bg-white border-gold/40'
                  }`}
                >
                  {/* 좌측 할인율 스텁 (티켓 느낌의 노치 색면) */}
                  <div className={`flex flex-col items-center justify-center px-5 py-4 shrink-0 ${
                    used ? 'bg-muk-soft/15 text-muk-soft' : 'bg-gradient-to-br from-gold to-terracotta text-white'
                  }`}>
                    <span className="text-2xl font-bold font-serif leading-none">{pct}%</span>
                    <span className="text-[10px] font-semibold mt-1 tracking-wide">할인</span>
                  </div>

                  {/* 우측 정보 */}
                  <div className="flex-1 flex flex-col justify-center px-4 py-3 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {typeLabel && (
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-jade/12 text-jade border border-jade/25">
                          {typeLabel}
                        </span>
                      )}
                      {used ? (
                        <span className="flex items-center gap-1 text-[11px] font-semibold text-muk-soft">
                          <CheckCircle2 size={12} /> 사용 완료
                        </span>
                      ) : (
                        <span className="text-[11px] font-semibold text-gold-deep">사용 가능</span>
                      )}
                    </div>
                    <h3 className={`text-base font-bold truncate ${used ? 'text-muk-soft' : 'text-muk'}`}>
                      {coupon.facilityName ?? '제휴 가맹점'}
                    </h3>
                    {coupon.issuedAt && (
                      <p className="text-[11px] text-muk-soft mt-0.5">
                        {formatDate(coupon.issuedAt)} 발급
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* 은은한 노을 광원 */}
      <div className="absolute top-1/4 right-1/4 w-[300px] h-[300px] bg-sunset-1/10 rounded-full blur-[100px] pointer-events-none z-0"></div>
    </div>
  );
}
