'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, Ticket, Compass, AlertCircle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient, isAuthError } from '@/lib/api-client';
import { useT } from '@/lib/i18n/I18nProvider';

// 백엔드 /api/v1/coupons/mine 응답(snake_case)을 api-client 가 camelCase 로 변환해 준다.
// status 'expired' 는 백엔드가 expires_at 을 기준으로 파생한 값(DB CHECK 제약은 issued/used 로 불변).
interface Coupon {
  id: string;
  facilityId: string;
  facilityName: string | null;
  facilityType: string | null;
  couponRate: number;   // 0.20 = 20%
  status: 'issued' | 'used' | 'expired';
  issuedAt: string | null;
  usedAt: string | null;
  expiresAt: string | null; // null 이면 만료 없음 — D-day 뱃지 생략(하위호환)
}

// 시설 유형(캐노니컬 키) — i18n category 네임스페이스로 표시명을 번역한다.
const TYPE_IDS = ['restaurant', 'cafe', 'attraction', 'culture'];

function formatDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
  } catch {
    return '';
  }
}

// 만료까지 남은 일수(올림). 이미 지났으면 음수/0 이 나올 수 있어 뱃지 렌더 쪽에서 0 하한을 적용한다.
function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / (24 * 60 * 60 * 1000));
}

export default function CouponsPage() {
  const router = useRouter();
  const t = useT();
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [usingId, setUsingId] = useState<string | null>(null);

  // 쿠폰 조회 — 마운트 effect 와 에러 상태의 '다시 시도' 버튼이 함께 재사용한다.
  // (output: 'export' 에서는 router.refresh() 가 무동작이라 직접 재호출해야 한다.)
  const fetchCoupons = useCallback(async () => {
    setIsLoading(true);
    setHasError(false);
    setNeedsAuth(false);
    try {
      // api-client 가 Supabase 세션 토큰을 실어 보낸다(다른 관광객 페이지와 동일 경로).
      const data = await apiClient.get('/api/v1/coupons/mine');
      setCoupons(Array.isArray(data) ? data : []);
    } catch (err) {
      console.warn('Failed to fetch coupons', err);
      // 401(인증 필요)은 서버 장애가 아니다 → 무한 재시도 대신 정직한 안내를 보여준다.
      if (isAuthError(err)) {
        setNeedsAuth(true);
      } else {
        setHasError(true);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 쿠폰 사용 처리 — 매장에서 즉시 제시하는 흐름이라 별도 확인 없이 사용 후 목록 갱신.
  const handleUse = useCallback(async (couponId: string) => {
    setUsingId(couponId);
    try {
      await apiClient.post(`/api/v1/coupons/${couponId}/use`);
      toast.success(t('coupons.useSuccess'));
      await fetchCoupons();
    } catch (err) {
      console.warn('coupon use failed', err);
      toast.error(t('coupons.useFail'));
    } finally {
      setUsingId(null);
    }
  }, [t, fetchCoupons]);

  useEffect(() => {
    void fetchCoupons();
  }, [fetchCoupons]);

  return (
    <div className="relative w-full h-[100dvh] bg-hanji flex flex-col overflow-hidden">

      {/* 헤더 */}
      <header className="flex items-center gap-3 p-5 z-10 relative">
        <button
          type="button"
          aria-label={t('coupons.backAria')}
          onClick={() => router.back()}
          className="text-muk-soft hover:text-muk transition-colors"
        >
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-xl font-bold font-serif text-muk tracking-wide">{t('coupons.title')}</h1>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative z-10 px-6 overflow-y-auto pb-[calc(80px+env(safe-area-inset-bottom))] md:pb-6 no-scrollbar">
        {isLoading ? (
          // 티켓 카드 형태의 스켈레톤(스피너 대체) — 좌측 할인 스텁 + 우측 정보 레이아웃을 암시한다.
          <div className="flex flex-col gap-4 mt-2" aria-hidden>
            {[0, 1].map((i) => (
              <div key={i} className="flex items-stretch rounded-2xl border border-line overflow-hidden shadow-[0_2px_14px_rgba(43,35,32,0.06)] animate-pulse">
                <div className="w-20 shrink-0 bg-hanji-deep" />
                <div className="flex-1 flex flex-col justify-center gap-2 px-4 py-4">
                  <div className="h-4 bg-hanji-deep w-1/3 rounded-md" />
                  <div className="h-5 bg-hanji-deep w-2/3 rounded-md" />
                  <div className="h-3 bg-hanji-deep w-1/4 rounded-md" />
                </div>
              </div>
            ))}
          </div>
        ) : needsAuth ? (
          // Auth-required State — 관광객 로그인이 없어 쿠폰함이 비어 있는 것이 정상이다.
          // '다시 시도'는 절대 성공할 수 없으므로, 대신 추천을 받으러 지도로 유도한다.
          <div className="flex-1 flex items-center justify-center">
            <div className="bg-white border border-line rounded-3xl p-8 flex flex-col items-center text-center w-full max-w-[320px] shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
              <div className="w-16 h-16 rounded-full bg-gradient-to-b from-gold/20 to-gold/10 border border-line flex items-center justify-center mb-6">
                <Ticket className="text-gold" size={32} />
              </div>
              <h2 className="text-xl font-bold font-serif text-muk mb-3">{t('coupons.authTitle')}</h2>
              <p className="text-muk-soft text-sm leading-relaxed mb-8 px-2">
                {t('coupons.authBody')}
              </p>
              <button
                onClick={() => router.push('/main')}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gold hover:bg-gold-deep text-white text-sm font-semibold transition-all"
              >
                <Compass size={18} className="text-white" />
                <span>{t('coupons.authCta')}</span>
              </button>
            </div>
          </div>
        ) : hasError ? (
          // Error State
          <div className="flex-1 flex items-center justify-center">
            <div className="bg-white border border-line rounded-3xl p-8 flex flex-col items-center text-center w-full max-w-[320px] shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
              <div className="w-16 h-16 rounded-full bg-terracotta/10 border border-terracotta/20 flex items-center justify-center mb-6">
                <AlertCircle className="text-terracotta" size={32} />
              </div>
              <h2 className="text-xl font-bold font-serif text-muk mb-3">{t('coupons.errorTitle')}</h2>
              <p className="text-muk-soft text-sm leading-relaxed mb-8 px-2">
                {t('coupons.errorBody')}
              </p>
              <button
                onClick={() => void fetchCoupons()}
                className="px-5 py-2.5 rounded-xl bg-gold hover:bg-gold-deep text-white text-sm font-semibold transition-all"
              >
                {t('common.retry')}
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
              <h2 className="text-xl font-bold font-serif text-muk mb-3">{t('coupons.emptyTitle')}</h2>
              <p className="text-muk-soft text-sm leading-relaxed mb-8 px-2">
                {t('coupons.emptyBody')}
              </p>
              <button
                onClick={() => router.push('/main')}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gold hover:bg-gold-deep text-white text-sm font-semibold transition-all"
              >
                <Compass size={18} className="text-white" />
                <span>{t('coupons.browse')}</span>
              </button>
            </div>
          </div>
        ) : (
          // List State
          <div className="flex flex-col gap-4 mt-2">
            <p className="text-sm text-muk-soft px-1">
              {t('coupons.listHint')}
            </p>

            {coupons.map((coupon) => {
              const used = coupon.status === 'used';
              const expired = coupon.status === 'expired';
              const dimmed = used || expired; // 흐림 처리 대상(사용 완료·만료 공통)
              const pct = Math.round((coupon.couponRate ?? 0) * 100);
              const typeLabel = coupon.facilityType
                ? (TYPE_IDS.includes(coupon.facilityType) ? t(`category.${coupon.facilityType}`) : coupon.facilityType)
                : null;
              // D-day 뱃지 — expires_at 이 없으면(하위호환) 생략, issued 상태에서만 표시(used/expired 는 뱃지 대신 상태 라벨).
              const daysLeft = !dimmed ? daysUntil(coupon.expiresAt) : null;
              const showDday = daysLeft !== null;
              const urgent = showDday && daysLeft! <= 3;
              return (
                <div
                  key={coupon.id}
                  className={`relative flex items-stretch rounded-2xl border overflow-hidden shadow-[0_2px_14px_rgba(43,35,32,0.06)] transition-colors ${
                    dimmed ? 'bg-hanji-deep border-line opacity-70' : 'bg-white border-gold/40'
                  }`}
                >
                  {/* 좌측 할인율 스텁 (티켓 느낌의 노치 색면) */}
                  <div className={`flex flex-col items-center justify-center px-5 py-4 shrink-0 ${
                    dimmed ? 'bg-muk-soft/15 text-muk-soft' : 'bg-gradient-to-br from-gold to-terracotta text-white'
                  }`}>
                    <span className="text-2xl font-bold font-serif leading-none">{pct}%</span>
                    <span className="text-[10px] font-semibold mt-1 tracking-wide">{t('coupons.discount')}</span>
                  </div>

                  {/* 우측 정보 */}
                  <div className="flex-1 flex flex-col justify-center px-4 py-3 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      {typeLabel && (
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-jade/12 text-jade border border-jade/25">
                          {typeLabel}
                        </span>
                      )}
                      {used ? (
                        <span className="flex items-center gap-1 text-[11px] font-semibold text-muk-soft">
                          <CheckCircle2 size={12} /> {t('coupons.used')}
                        </span>
                      ) : expired ? (
                        <span className="flex items-center gap-1 text-[11px] font-semibold text-muk-soft">
                          <AlertCircle size={12} /> {t('coupons.expired')}
                        </span>
                      ) : (
                        <span className="text-[11px] font-semibold text-gold-deep">{t('coupons.available')}</span>
                      )}
                      {showDday && (
                        <span
                          className={`text-[11px] font-bold px-2 py-0.5 rounded-md border ${
                            urgent
                              ? 'bg-terracotta/12 text-terracotta border-terracotta/30'
                              : 'bg-muk-soft/10 text-muk-soft border-muk-soft/20'
                          }`}
                        >
                          {daysLeft! <= 0 ? t('coupons.dDayToday') : t('coupons.dDay', { n: daysLeft! })}
                        </span>
                      )}
                    </div>
                    <h3 className={`text-base font-bold truncate ${dimmed ? 'text-muk-soft' : 'text-muk'}`}>
                      {coupon.facilityName ?? t('coupons.partner')}
                    </h3>
                    {coupon.issuedAt && (
                      <p className="text-[11px] text-muk-soft mt-0.5">
                        {t('coupons.issued', { date: formatDate(coupon.issuedAt) })}
                      </p>
                    )}
                    {!dimmed && (
                      <button
                        type="button"
                        onClick={() => handleUse(coupon.id)}
                        disabled={usingId === coupon.id}
                        className="mt-2 self-start px-3 py-1.5 rounded-lg bg-gold hover:bg-gold-deep text-white text-xs font-bold transition-colors disabled:opacity-50"
                      >
                        {usingId === coupon.id ? t('common.loading') : t('coupons.use')}
                      </button>
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
