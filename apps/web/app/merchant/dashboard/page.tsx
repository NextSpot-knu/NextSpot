'use client';

// 내 가게 대시보드(머천트 콘솔) — 4섹션: ① 예측 유입 ② 성적표 ③ 셀프 타임세일 ④ 좌석 상태 방송.
// 모바일 우선 · 한지(라이트) 팔레트. 각 섹션은 독립적으로 로딩/에러를 관리한다 — 백엔드 신규
// 엔드포인트(/api/v1/merchant/*)가 아직 배포되지 않았거나 마이그레이션 미적용이어도, 다른 섹션은
// 정상 동작하고 실패한 섹션만 "우아한 폴백"(재시도 버튼)으로 저하된다(무한 스켈레톤 금지).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2,
  RefreshCw,
  ChevronLeft,
  Ticket,
  MessageCircleWarning,
  ThumbsUp,
  Eye,
  Zap,
  Timer,
  X as XIcon,
  CircleCheck,
  CircleDot,
  CircleX,
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { createPublicClient } from '@/lib/supabase';
import {
  isMerchantAuthed,
  getMerchantFacility,
  clearMerchantFacility,
  type MerchantFacility,
} from '../_lib/merchant-auth';
import {
  fetchMerchantStats,
  fetchActiveTimesales,
  createTimesale,
  cancelTimesale,
  updateSeatStatus,
  fetchFacilityCongestionForecast,
  MerchantApiError,
  type MerchantStats,
  type MerchantTimesale,
  type SeatLevel,
  type HourlyCongestionPoint,
} from '../_lib/merchant-api';

const TYPE_LABEL: Record<string, string> = {
  restaurant: '음식점',
  cafe: '카페',
  attraction: '관광지',
  culture: '문화시설',
};

type AsyncState = 'loading' | 'ready' | 'error';

export default function MerchantDashboardPage() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [facility, setFacility] = useState<MerchantFacility | null>(null);

  useEffect(() => {
    setMounted(true);
    if (!isMerchantAuthed()) {
      router.replace('/merchant');
      return;
    }
    const fac = getMerchantFacility();
    if (!fac) {
      router.replace('/merchant');
      return;
    }
    setFacility(fac);
  }, [router]);

  const handleChangeFacility = () => {
    clearMerchantFacility();
    router.push('/merchant');
  };

  if (!mounted || !facility) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-hanji text-muk-soft">
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-hanji font-sans pb-16">
      <header className="sticky top-0 z-10 bg-hanji/90 backdrop-blur border-b border-line px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push('/merchant')}
          className="flex items-center gap-1 text-muk-soft text-sm hover:text-muk transition-colors"
        >
          <ChevronLeft size={18} />
        </button>
        <div className="text-center">
          <p className="text-sm font-bold font-serif text-muk">{facility.name}</p>
          <p className="text-[11px] text-muk-soft">{TYPE_LABEL[facility.type] || facility.type}</p>
        </div>
        <button
          onClick={handleChangeFacility}
          className="text-[11px] text-muk-soft hover:text-muk transition-colors underline underline-offset-2"
        >
          가게 변경
        </button>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-5 flex flex-col gap-5">
        <ForecastSection facilityId={facility.id} />
        <StatsSection facilityId={facility.id} />
        <TimesaleSection facilityId={facility.id} />
        <SeatStatusSection facilityId={facility.id} />
      </main>
    </div>
  );
}

// =========================================================================
// 공용 UI 조각
// =========================================================================

function SectionCard({
  badge,
  title,
  honestNote,
  children,
}: {
  badge: string;
  title: string;
  honestNote?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-white border border-line rounded-3xl p-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div className="flex items-center gap-2">
          <span className="flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold border bg-gold/15 text-gold-deep border-gold/30">
            {badge}
          </span>
          <h2 className="text-base font-bold font-serif text-muk">{title}</h2>
        </div>
      </div>
      {honestNote && <p className="text-[11px] text-muk-soft mb-3 leading-relaxed">{honestNote}</p>}
      {children}
    </section>
  );
}

function ErrorFallback({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-8">
      <p className="text-sm text-terracotta text-center">{message}</p>
      <button
        onClick={onRetry}
        className="flex items-center gap-2 px-4 py-2 rounded-lg border border-line text-muk text-sm hover:bg-hanji transition-colors"
      >
        <RefreshCw size={14} /> 다시 시도
      </button>
    </div>
  );
}

function SkeletonBlock({ heightClass = 'h-24' }: { heightClass?: string }) {
  return <div className={`w-full ${heightClass} rounded-xl bg-hanji-deep animate-pulse`} />;
}

// =========================================================================
// ① 예측 유입 — POST /predict/batch 를 hours_ahead 0..8 로 호출해 내 시설만 뽑아 시계열화.
// =========================================================================

function ForecastSection({ facilityId }: { facilityId: string }) {
  const [state, setState] = useState<AsyncState>('loading');
  const [points, setPoints] = useState<HourlyCongestionPoint[]>([]);
  const [errorMessage, setErrorMessage] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const data = await fetchFacilityCongestionForecast(facilityId, 6);
      setPoints(data);
      setState('ready');
    } catch (e) {
      setErrorMessage(e instanceof MerchantApiError ? e.message : '예측 데이터를 불러오지 못했습니다.');
      setState('error');
    }
  }, [facilityId]);

  useEffect(() => {
    load();
  }, [load]);

  const chartData = points.map((p) => ({
    label: p.hoursAhead === 0 ? '지금' : `+${p.hoursAhead}시간`,
    hourLabel: `${p.hour}시`,
    congestion: Math.round(p.congestion * 100),
  }));
  const hasAnchored = points.some((p) => p.anchored);

  return (
    <SectionCard
      badge="① 예측 유입"
      title="시간대별 예측 혼잡도"
      honestNote={
        hasAnchored
          ? '지금 기준 예측치이며 실측이 아닙니다. 우리 가게의 최근 실측 혼잡도에 앵커링된 시간대 곡선입니다.'
          : '지금 기준 예측치이며 실측이 아닙니다(최근 실측 혼잡 로그가 없어 유형 평균 곡선을 보여드립니다).'
      }
    >
      {state === 'loading' && <SkeletonBlock heightClass="h-48" />}
      {state === 'error' && <ErrorFallback message={errorMessage} onRetry={load} />}
      {state === 'ready' && (
        <div className="h-48 w-full">
          {chartData.length === 0 ? (
            <div className="h-full flex items-center justify-center text-muk-soft text-sm">
              표시할 예측 데이터가 없습니다.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 12, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e6dcc6" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: '#6b5d4f', fontSize: 11 }} />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: '#6b5d4f', fontSize: 11 }}
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                  width={36}
                />
                <Tooltip
                  formatter={(value: unknown) => [`${value}%`, '예측 혼잡도']}
                  labelFormatter={(_label, payload) => (payload?.[0]?.payload?.hourLabel ?? '')}
                  contentStyle={{ borderRadius: '8px', border: '1px solid #e6dcc6', color: '#2b2320' }}
                />
                <Line
                  type="monotone"
                  dataKey="congestion"
                  stroke="#c1553b"
                  strokeWidth={3}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </SectionCard>
  );
}

// =========================================================================
// ② 성적표 — GET /api/v1/merchant/stats (최근 7일)
// =========================================================================

function StatsSection({ facilityId }: { facilityId: string }) {
  const [state, setState] = useState<AsyncState>('loading');
  const [stats, setStats] = useState<MerchantStats | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const data = await fetchMerchantStats(facilityId);
      setStats(data);
      setState('ready');
    } catch (e) {
      setErrorMessage(e instanceof MerchantApiError ? e.message : '성적표를 불러오지 못했습니다.');
      setState('error');
    }
  }, [facilityId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <SectionCard badge="② 성적표" title={`최근 ${stats?.window_days ?? 7}일 활동`}>
      {state === 'loading' && <SkeletonBlock heightClass="h-32" />}
      {state === 'error' && <ErrorFallback message={errorMessage} onRetry={load} />}
      {state === 'ready' && stats && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <StatTile icon={<Ticket size={16} />} label="쿠폰 발급" value={stats.coupons_issued} />
            <StatTile icon={<Ticket size={16} />} label="쿠폰 사용" value={stats.coupons_used} />
            <StatTile icon={<MessageCircleWarning size={16} />} label="혼잡 제보" value={stats.congestion_reports} />
            <StatTile
              icon={<ThumbsUp size={16} />}
              label="추천 수락"
              value={`${stats.recommendations_accepted} / ${stats.recommendations_exposed}`}
              sub="수락 / 노출"
            />
          </div>
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-hanji border border-line text-[11px] text-muk-soft leading-relaxed">
            <Eye size={14} className="flex-shrink-0 mt-0.5" />
            <span>{stats.visit_confirmations_note}</span>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function StatTile({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  sub?: string;
}) {
  return (
    <div className="flex flex-col gap-1 px-3 py-3 rounded-xl bg-hanji border border-line">
      <div className="flex items-center gap-1.5 text-muk-soft">
        {icon}
        <span className="text-[11px] font-semibold">{label}</span>
      </div>
      <span className="text-xl font-bold text-muk">{value}</span>
      {sub && <span className="text-[10px] text-muk-soft">{sub}</span>}
    </div>
  );
}

// =========================================================================
// ③ 셀프 타임세일 — POST /timesale · GET /timesale · POST /timesale/cancel
// =========================================================================

const RATE_OPTIONS = [0.15, 0.2, 0.3] as const;
const DURATION_OPTIONS = [
  { minutes: 60, label: '1시간' },
  { minutes: 120, label: '2시간' },
  { minutes: 180, label: '3시간' },
] as const;

function formatRemaining(ms: number): string {
  if (ms <= 0) return '종료됨';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  if (hours > 0) return `${hours}시간 ${minutes}분 남음`;
  if (minutes > 0) return `${minutes}분 ${seconds}초 남음`;
  return `${seconds}초 남음`;
}

function TimesaleSection({ facilityId }: { facilityId: string }) {
  const [state, setState] = useState<AsyncState>('loading');
  const [sales, setSales] = useState<MerchantTimesale[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [selectedRate, setSelectedRate] = useState<(typeof RATE_OPTIONS)[number] | null>(null);
  const [selectedDuration, setSelectedDuration] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setState('loading');
    try {
      const data = await fetchActiveTimesales(facilityId);
      setSales(data);
      setState('ready');
    } catch (e) {
      setErrorMessage(e instanceof MerchantApiError ? e.message : '타임세일 목록을 불러오지 못했습니다.');
      setState('error');
    }
  }, [facilityId]);

  useEffect(() => {
    load();
  }, [load]);

  // 카운트다운 갱신(1초 간격) — 활성 세일이 있을 때만 돈다.
  useEffect(() => {
    if (sales.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sales.length]);

  const activeSales = useMemo(
    () => sales.filter((s) => !s.canceled_at && new Date(s.ends_at).getTime() > now),
    [sales, now]
  );

  const handlePublish = async () => {
    if (selectedRate === null || selectedDuration === null) return;
    setPublishing(true);
    setPublishError('');
    try {
      await createTimesale(facilityId, selectedRate, selectedDuration as 60 | 120 | 180);
      setSelectedRate(null);
      setSelectedDuration(null);
      await load();
    } catch (e) {
      setPublishError(e instanceof MerchantApiError ? e.message : '타임세일 발행에 실패했습니다.');
    } finally {
      setPublishing(false);
    }
  };

  const handleCancel = async (id: string) => {
    setCancelingId(id);
    try {
      await cancelTimesale(id, facilityId);
      await load();
    } catch (e) {
      setPublishError(e instanceof MerchantApiError ? e.message : '타임세일 취소에 실패했습니다.');
    } finally {
      setCancelingId(null);
    }
  };

  return (
    <SectionCard
      badge="③ 셀프 타임세일"
      title="지금 할인, 지금 발행"
      honestNote="발행 즉시 추천 랭킹 인센티브 반영은 2단계 연동 예정입니다. 지금은 손님께 보여드릴 할인 안내로 활용해주세요."
    >
      {state === 'loading' && <SkeletonBlock heightClass="h-20" />}
      {state === 'error' && <ErrorFallback message={errorMessage} onRetry={load} />}
      {state === 'ready' && (
        <div className="flex flex-col gap-4">
          {activeSales.length > 0 && (
            <div className="flex flex-col gap-2">
              {activeSales.map((sale) => (
                <div
                  key={sale.id}
                  className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-gold/10 border border-gold/30"
                >
                  <div className="flex items-center gap-2">
                    <Zap size={16} className="text-gold-deep" />
                    <div>
                      <p className="text-sm font-bold text-muk">{Math.round(sale.rate * 100)}% 할인 중</p>
                      <p className="text-[11px] text-muk-soft flex items-center gap-1">
                        <Timer size={11} /> {formatRemaining(new Date(sale.ends_at).getTime() - now)}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleCancel(sale.id)}
                    disabled={cancelingId === sale.id}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-line text-muk-soft text-xs hover:bg-hanji transition-colors disabled:opacity-50"
                  >
                    {cancelingId === sale.id ? <Loader2 size={12} className="animate-spin" /> : <XIcon size={12} />}
                    취소
                  </button>
                </div>
              ))}
            </div>
          )}

          <div>
            <p className="text-[11px] font-semibold text-muk-soft mb-2">할인율</p>
            <div className="grid grid-cols-3 gap-2 mb-3">
              {RATE_OPTIONS.map((rate) => (
                <button
                  key={rate}
                  onClick={() => setSelectedRate(rate)}
                  className={`py-2.5 rounded-xl border text-sm font-bold transition-colors ${
                    selectedRate === rate ? 'border-gold bg-gold/10 text-gold-deep' : 'border-line text-muk hover:bg-hanji'
                  }`}
                >
                  {Math.round(rate * 100)}%
                </button>
              ))}
            </div>
            <p className="text-[11px] font-semibold text-muk-soft mb-2">지속 시간</p>
            <div className="grid grid-cols-3 gap-2 mb-3">
              {DURATION_OPTIONS.map((opt) => (
                <button
                  key={opt.minutes}
                  onClick={() => setSelectedDuration(opt.minutes)}
                  className={`py-2.5 rounded-xl border text-sm font-bold transition-colors ${
                    selectedDuration === opt.minutes ? 'border-gold bg-gold/10 text-gold-deep' : 'border-line text-muk hover:bg-hanji'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {publishError && <p className="text-xs text-terracotta mb-2">{publishError}</p>}

            <button
              disabled={selectedRate === null || selectedDuration === null || publishing}
              onClick={handlePublish}
              className="w-full py-3 rounded-xl font-semibold text-sm text-white bg-gradient-to-r from-gold to-terracotta hover:opacity-90 transition-opacity disabled:opacity-40 disabled:pointer-events-none flex items-center justify-center gap-2"
            >
              {publishing ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
              타임세일 발행
            </button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

// =========================================================================
// ④ 좌석 상태 방송 — POST /seat-status (facilities.features.seat_status 병합)
// =========================================================================

const SEAT_OPTIONS: { level: SeatLevel; label: string; icon: React.ReactNode }[] = [
  { level: 'low', label: '여유', icon: <CircleCheck size={16} /> },
  { level: 'mid', label: '보통', icon: <CircleDot size={16} /> },
  { level: 'full', label: '만석', icon: <CircleX size={16} /> },
];

const SEAT_LABEL: Record<SeatLevel, string> = { low: '여유', mid: '보통', full: '만석' };

function SeatStatusSection({ facilityId }: { facilityId: string }) {
  const [state, setState] = useState<AsyncState>('loading');
  const [current, setCurrent] = useState<{ level: SeatLevel; updated_at: string } | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [submitting, setSubmitting] = useState<SeatLevel | null>(null);
  const [submitError, setSubmitError] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const supabase = createPublicClient();
      const { data, error } = await supabase
        .from('facilities')
        .select('features')
        .eq('id', facilityId)
        .maybeSingle();
      if (error) throw error;
      const seatStatus = (data?.features as Record<string, unknown> | null)?.seat_status as
        | { level?: string; updated_at?: string }
        | undefined;
      if (seatStatus?.level && ['low', 'mid', 'full'].includes(seatStatus.level)) {
        setCurrent({ level: seatStatus.level as SeatLevel, updated_at: seatStatus.updated_at || '' });
      } else {
        setCurrent(null);
      }
      setState('ready');
    } catch {
      setErrorMessage('좌석 상태를 불러오지 못했습니다.');
      setState('error');
    }
  }, [facilityId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleBroadcast = async (level: SeatLevel) => {
    setSubmitting(level);
    setSubmitError('');
    try {
      const res = await updateSeatStatus(facilityId, level);
      setCurrent({ level: res.level, updated_at: res.updated_at });
    } catch (e) {
      setSubmitError(e instanceof MerchantApiError ? e.message : '좌석 상태 갱신에 실패했습니다.');
    } finally {
      setSubmitting(null);
    }
  };

  const updatedLabel = current?.updated_at
    ? new Date(current.updated_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <SectionCard
      badge="④ 좌석 상태 방송"
      title="지금 우리 가게 상태"
      honestNote="추천 반영은 2단계 연동 예정입니다. 지금은 손님께 보여드릴 현재 상태 안내로 활용해주세요."
    >
      {state === 'loading' && <SkeletonBlock heightClass="h-20" />}
      {state === 'error' && <ErrorFallback message={errorMessage} onRetry={load} />}
      {state === 'ready' && (
        <div className="flex flex-col gap-3">
          <div className="text-sm text-muk-soft">
            현재 상태:{' '}
            <span className="font-bold text-muk">{current ? SEAT_LABEL[current.level] : '설정 안 함'}</span>
            {updatedLabel && <span className="ml-1 text-[11px]">({updatedLabel} 갱신)</span>}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {SEAT_OPTIONS.map((opt) => (
              <button
                key={opt.level}
                onClick={() => handleBroadcast(opt.level)}
                disabled={submitting !== null}
                className={`flex flex-col items-center gap-1 py-3 rounded-xl border text-sm font-bold transition-colors disabled:opacity-50 ${
                  current?.level === opt.level ? 'border-gold bg-gold/10 text-gold-deep' : 'border-line text-muk hover:bg-hanji'
                }`}
              >
                {submitting === opt.level ? <Loader2 size={16} className="animate-spin" /> : opt.icon}
                {opt.label}
              </button>
            ))}
          </div>
          {submitError && <p className="text-xs text-terracotta">{submitError}</p>}
        </div>
      )}
    </SectionCard>
  );
}
