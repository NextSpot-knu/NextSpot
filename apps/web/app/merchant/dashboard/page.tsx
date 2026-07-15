'use client';

// 내 가게 대시보드(머천트 콘솔) — 4섹션: ① 예상 혼잡 ② 성적표 ③ 셀프 타임세일 ④ 좌석 상태 방송.
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
  PowerOff,
} from 'lucide-react';
import { toast } from 'sonner';
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
  clearSeatStatus,
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
          aria-label="사장님 콘솔 홈으로"
          className="flex items-center gap-1 text-muk-soft text-sm hover:text-muk transition-colors rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <div className="text-center">
          <p className="text-sm font-bold font-serif text-muk">{facility.name}</p>
          <p className="text-xs text-muk-soft">{TYPE_LABEL[facility.type] || facility.type}</p>
        </div>
        <button
          onClick={handleChangeFacility}
          className="text-xs text-muk-soft hover:text-muk transition-colors underline underline-offset-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
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
          <span className="flex-shrink-0 px-2 py-0.5 rounded-full text-xs font-bold border bg-gold/15 text-gold-deep border-gold/30">
            {badge}
          </span>
          <h2 className="text-base font-bold font-serif text-muk">{title}</h2>
        </div>
      </div>
      {honestNote && <p className="text-xs text-muk-soft mb-3 leading-relaxed">{honestNote}</p>}
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
        className="flex items-center gap-2 px-4 py-2 rounded-lg border border-line text-muk text-sm hover:bg-hanji transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
      >
        <RefreshCw size={14} aria-hidden="true" /> 다시 시도
      </button>
    </div>
  );
}

function SkeletonBlock({ heightClass = 'h-24' }: { heightClass?: string }) {
  return <div className={`w-full ${heightClass} rounded-xl bg-hanji-deep animate-pulse`} />;
}

// =========================================================================
// ① 시간대별 예상 혼잡 — POST /predict/batch 를 hours_ahead 0..8 로 호출해 내 시설만 뽑아 시계열화.
// ⚠️ 이 값은 '혼잡도 예측'이다. 방문객 수·유입 인원·매출이 아니다 — 라벨을 그렇게 읽히게 쓰지 말 것.
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
      badge="① 예상 혼잡"
      title="시간대별 예상 혼잡"
      honestNote={
        hasAnchored
          ? '가게가 얼마나 붐빌지에 대한 예측치이며, 방문객 수나 실측이 아닙니다. 우리 가게의 최근 실측 혼잡도에 앵커링된 시간대 곡선입니다.'
          : '가게가 얼마나 붐빌지에 대한 예측치이며, 방문객 수나 실측이 아닙니다(최근 실측 혼잡 로그가 없어 유형 평균 곡선을 보여드립니다).'
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

  // 모든 항목이 0 이면 숫자 타일 대신 '아직 기록 없음 + 다음 행동'을 보여준다 — 0 만 늘어놓으면
  // 사장님이 "고장났나?" 로 읽는다(감사 P1).
  const isEmpty =
    !!stats &&
    stats.coupons_issued === 0 &&
    stats.coupons_used === 0 &&
    stats.congestion_reports === 0 &&
    stats.recommendations_exposed === 0 &&
    stats.recommendations_accepted === 0;

  return (
    <SectionCard badge="② 성적표" title={`최근 ${stats?.window_days ?? 7}일 활동`}>
      {state === 'loading' && <SkeletonBlock heightClass="h-32" />}
      {state === 'error' && <ErrorFallback message={errorMessage} onRetry={load} />}
      {state === 'ready' && stats && isEmpty && (
        <div className="flex flex-col gap-3">
          <div className="px-3 py-4 rounded-xl bg-hanji border border-line">
            <p className="text-sm font-bold text-muk mb-1">아직 기록이 없습니다</p>
            <p className="text-xs text-muk-soft leading-relaxed">
              최근 {stats.window_days}일 동안 우리 가게에서 발생한 쿠폰·제보·추천 기록이 없습니다. 서버에 남은
              기록만 보여드리므로, 기록이 쌓이면 이 자리에 숫자가 나타납니다.
            </p>
          </div>
          <div className="px-3 py-3 rounded-xl bg-hanji border border-line">
            <p className="text-xs font-bold text-muk mb-1.5">이렇게 시작해보세요</p>
            <ul className="text-xs text-muk-soft leading-relaxed list-disc pl-4 flex flex-col gap-1">
              <li>③ 셀프 타임세일을 발행하면 추천 랭킹 인센티브에 반영됩니다.</li>
              <li>④ 좌석 상태를 방송하면 30분 동안 추천 혼잡도에 사장님 확인값이 쓰입니다.</li>
            </ul>
          </div>
        </div>
      )}
      {state === 'ready' && stats && !isEmpty && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <StatTile
              icon={<Ticket size={16} />}
              label="쿠폰 사용"
              value={`${stats.coupons_used} / ${stats.coupons_issued}`}
              sub={`사용 ${stats.coupons_used} / 발급 ${stats.coupons_issued}`}
            />
            <StatTile
              icon={<ThumbsUp size={16} />}
              label="추천 수락"
              value={`${stats.recommendations_accepted} / ${stats.recommendations_exposed}`}
              sub={`수락 ${stats.recommendations_accepted} / 제안 ${stats.recommendations_exposed}`}
            />
            <div className="col-span-2">
              <StatTile
                icon={<MessageCircleWarning size={16} />}
                label="혼잡 제보"
                value={stats.congestion_reports}
                sub="손님이 보내주신 혼잡 제보 건수"
              />
            </div>
          </div>
          <p className="text-xs text-muk-soft leading-relaxed px-1">
            &lsquo;추천 제안&rsquo;은 우리 가게가 손님 추천 목록에 오른 횟수(서버에 남은 추천 기록 수)입니다. 손님이
            실제로 화면에서 보셨는지까지는 확인하지 않습니다.
          </p>
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-hanji border border-line text-xs text-muk-soft leading-relaxed">
            <Eye size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
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
        <span aria-hidden="true" className="flex items-center">
          {icon}
        </span>
        <span className="text-xs font-semibold">{label}</span>
      </div>
      <span className="text-xl font-bold text-muk">{value}</span>
      {sub && <span className="text-xs text-muk-soft">{sub}</span>}
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

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

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
  // 발행 직전 확인 스냅샷 — 확인 화면에 보여준 조건 그대로 발행한다(확인 후 선택이 바뀌는 사고 방지).
  const [publishConfirm, setPublishConfirm] = useState<{
    rate: number;
    minutes: number;
    label: string;
    endsAtMs: number;
  } | null>(null);
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);

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

  const openPublishConfirm = () => {
    if (selectedRate === null || selectedDuration === null) return;
    const opt = DURATION_OPTIONS.find((o) => o.minutes === selectedDuration);
    setPublishError('');
    setPublishConfirm({
      rate: selectedRate,
      minutes: selectedDuration,
      label: opt?.label ?? `${selectedDuration}분`,
      endsAtMs: Date.now() + selectedDuration * 60_000,
    });
  };

  const handlePublish = async () => {
    if (!publishConfirm) return;
    const { rate, minutes } = publishConfirm;
    setPublishing(true);
    setPublishError('');
    try {
      await createTimesale(facilityId, rate as 0.15 | 0.2 | 0.3, minutes as 60 | 120 | 180);
      setSelectedRate(null);
      setSelectedDuration(null);
      setPublishConfirm(null);
      await load();
      toast.success(`${Math.round(rate * 100)}% 타임세일을 발행했습니다.`, {
        description: '할인율이 기본 쿠폰율보다 높으면 추천 랭킹 인센티브에 반영됩니다.',
      });
    } catch (e) {
      const message = e instanceof MerchantApiError ? e.message : '타임세일 발행에 실패했습니다.';
      setPublishError(message);
      toast.error(message);
    } finally {
      setPublishing(false);
    }
  };

  const handleCancel = async (id: string) => {
    setCancelingId(id);
    setPublishError('');
    try {
      await cancelTimesale(id, facilityId);
      setCancelConfirmId(null);
      await load();
      toast.success('타임세일을 취소했습니다.', { description: '추천 인센티브 반영도 함께 해제됩니다.' });
    } catch (e) {
      const message = e instanceof MerchantApiError ? e.message : '타임세일 취소에 실패했습니다.';
      setPublishError(message);
      toast.error(message);
    } finally {
      setCancelingId(null);
    }
  };

  return (
    <SectionCard
      badge="③ 셀프 타임세일"
      title="지금 할인, 지금 발행"
      honestNote="발행 즉시 추천 랭킹 인센티브에 반영됩니다(할인율이 기본 쿠폰율보다 높을 때). 손님께 보여드릴 할인 안내로도 함께 활용해주세요."
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
                    <Zap size={16} className="text-gold-deep" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-bold text-muk">{Math.round(sale.rate * 100)}% 할인 중</p>
                      <p className="text-xs text-muk-soft flex items-center gap-1">
                        <Timer size={12} aria-hidden="true" /> {formatRemaining(new Date(sale.ends_at).getTime() - now)}
                      </p>
                    </div>
                  </div>
                  {cancelConfirmId === sale.id ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muk font-semibold">지금 종료할까요?</span>
                      <button
                        onClick={() => setCancelConfirmId(null)}
                        disabled={cancelingId === sale.id}
                        className="px-2.5 py-1.5 rounded-lg border border-line text-muk-soft text-xs hover:bg-hanji transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                      >
                        유지
                      </button>
                      <button
                        onClick={() => handleCancel(sale.id)}
                        disabled={cancelingId === sale.id}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-terracotta text-terracotta text-xs font-bold hover:bg-terracotta/10 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
                      >
                        {cancelingId === sale.id && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                        종료
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setCancelConfirmId(sale.id)}
                      aria-label={`${Math.round(sale.rate * 100)}% 할인 타임세일 취소`}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-line text-muk-soft text-xs hover:bg-hanji transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                    >
                      <XIcon size={12} aria-hidden="true" />
                      취소
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div>
            <p className="text-xs font-semibold text-muk-soft mb-2" id="timesale-rate-label">
              할인율
            </p>
            <div className="grid grid-cols-3 gap-2 mb-3" role="group" aria-labelledby="timesale-rate-label">
              {RATE_OPTIONS.map((rate) => (
                <button
                  key={rate}
                  onClick={() => {
                    setSelectedRate(rate);
                    setPublishConfirm(null);
                  }}
                  aria-pressed={selectedRate === rate}
                  className={`py-2.5 rounded-xl border text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
                    selectedRate === rate ? 'border-gold bg-gold/10 text-gold-deep' : 'border-line text-muk hover:bg-hanji'
                  }`}
                >
                  {Math.round(rate * 100)}%
                </button>
              ))}
            </div>
            <p className="text-xs font-semibold text-muk-soft mb-2" id="timesale-duration-label">
              지속 시간
            </p>
            <div className="grid grid-cols-3 gap-2 mb-3" role="group" aria-labelledby="timesale-duration-label">
              {DURATION_OPTIONS.map((opt) => (
                <button
                  key={opt.minutes}
                  onClick={() => {
                    setSelectedDuration(opt.minutes);
                    setPublishConfirm(null);
                  }}
                  aria-pressed={selectedDuration === opt.minutes}
                  className={`py-2.5 rounded-xl border text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
                    selectedDuration === opt.minutes ? 'border-gold bg-gold/10 text-gold-deep' : 'border-line text-muk hover:bg-hanji'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {publishError && <p className="text-xs text-terracotta mb-2">{publishError}</p>}

            {publishConfirm ? (
              // 발행 전 확인 — 무거운 모달 없이 인라인 단계로(레포에 shadcn 없음).
              <div className="flex flex-col gap-2.5 px-3 py-3 rounded-xl border border-gold/40 bg-gold/10">
                <p className="text-sm text-muk leading-relaxed">
                  <span className="font-bold">{Math.round(publishConfirm.rate * 100)}% 할인</span>을 지금부터{' '}
                  <span className="font-bold">{publishConfirm.label}</span> 동안 발행합니다. 종료 예정{' '}
                  <span className="font-bold">{formatClock(publishConfirm.endsAtMs)}</span>.
                </p>
                <p className="text-xs text-muk-soft leading-relaxed">
                  할인율이 기본 쿠폰율보다 높으면 추천 랭킹 인센티브에 반영됩니다. 이대로 발행할까요?
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setPublishConfirm(null)}
                    disabled={publishing}
                    className="py-2.5 rounded-xl border border-line bg-white text-muk text-sm font-semibold hover:bg-hanji transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                  >
                    다시 고르기
                  </button>
                  <button
                    onClick={handlePublish}
                    disabled={publishing}
                    className="py-2.5 rounded-xl font-semibold text-sm text-white bg-gradient-to-r from-gold to-terracotta hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                  >
                    {publishing ? (
                      <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Zap size={15} aria-hidden="true" />
                    )}
                    발행 확인
                  </button>
                </div>
              </div>
            ) : (
              <button
                disabled={selectedRate === null || selectedDuration === null}
                onClick={openPublishConfirm}
                className="w-full py-3 rounded-xl font-semibold text-sm text-white bg-gradient-to-r from-gold to-terracotta hover:opacity-90 transition-opacity disabled:opacity-40 disabled:pointer-events-none flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
              >
                <Zap size={15} aria-hidden="true" />
                타임세일 발행
              </button>
            )}
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

// 추천 반영 유효 창(분) — 백엔드 merchant_boost.SEAT_STATUS_FRESH_MINUTES 와 동일해야 한다.
// 이보다 오래된 방송은 추천에서 무시되므로 콘솔도 '만료됨'으로 표시한다(방송 중으로 오해 금지).
const SEAT_FRESH_MINUTES = 30;

function SeatStatusSection({ facilityId }: { facilityId: string }) {
  const [state, setState] = useState<AsyncState>('loading');
  const [current, setCurrent] = useState<{ level: SeatLevel; updated_at: string } | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [submitting, setSubmitting] = useState<SeatLevel | null>(null);
  const [clearing, setClearing] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [now, setNow] = useState(() => Date.now());

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

  // 만료 카운트다운 — 방송값이 있을 때만 30초 간격으로 갱신한다.
  // (now 가 과거로 뒤처져 있어도 minutesAgo 가 0 으로 클램프되어 '방금 방송'으로 보이고, 30초 안에 보정된다.)
  const updatedAt = current?.updated_at ?? null;
  useEffect(() => {
    if (!updatedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [updatedAt]);

  const handleBroadcast = async (level: SeatLevel) => {
    setSubmitting(level);
    setSubmitError('');
    try {
      const res = await updateSeatStatus(facilityId, level);
      setCurrent({ level: res.level, updated_at: res.updated_at });
      toast.success(`좌석 상태를 '${SEAT_LABEL[level]}'(으)로 방송했습니다.`, {
        description: `${SEAT_FRESH_MINUTES}분 동안 추천 혼잡도에 반영됩니다.`,
      });
    } catch (e) {
      const message = e instanceof MerchantApiError ? e.message : '좌석 상태 갱신에 실패했습니다.';
      setSubmitError(message);
      toast.error(message);
    } finally {
      setSubmitting(null);
    }
  };

  const handleClear = async () => {
    setClearing(true);
    setSubmitError('');
    try {
      await clearSeatStatus(facilityId);
      setCurrent(null);
      toast.success('좌석 상태 방송을 껐습니다.', { description: '추천에는 다시 예측 혼잡도가 쓰입니다.' });
    } catch (e) {
      const message = e instanceof MerchantApiError ? e.message : '좌석 상태 방송을 끄지 못했습니다.';
      setSubmitError(message);
      toast.error(message);
    } finally {
      setClearing(false);
    }
  };

  // updated_at 이 없거나 깨졌으면 '만료'로 본다 — 신선함을 증명 못 하면 방송 중으로 보여주지 않는다.
  const broadcast = useMemo(() => {
    if (!current?.updated_at) return null;
    const ts = new Date(current.updated_at).getTime();
    if (Number.isNaN(ts)) return null;
    const minutesAgo = Math.max(0, Math.floor((now - ts) / 60_000));
    const minutesLeft = SEAT_FRESH_MINUTES - minutesAgo;
    return {
      minutesAgo,
      minutesLeft,
      fresh: minutesLeft > 0,
      clockLabel: formatClock(ts),
    };
  }, [current, now]);

  // 추천에 실제로 반영 중인 레벨만 '선택됨'으로 칠한다(만료값을 선택된 것처럼 보이게 하지 않는다).
  const activeLevel = broadcast?.fresh ? (current?.level ?? null) : null;

  return (
    <SectionCard
      badge="④ 좌석 상태 방송"
      title="지금 우리 가게 상태"
      honestNote={`방송하면 ${SEAT_FRESH_MINUTES}분 동안 추천 혼잡도에 사장님 확인값으로 반영되고, 그 뒤에는 자동으로 만료되어 예측값으로 돌아갑니다. 손님께 보여드릴 현재 상태 안내로도 함께 활용해주세요.`}
    >
      {state === 'loading' && <SkeletonBlock heightClass="h-20" />}
      {state === 'error' && <ErrorFallback message={errorMessage} onRetry={load} />}
      {state === 'ready' && (
        <div className="flex flex-col gap-3">
          <div
            className={`flex items-center justify-between flex-wrap gap-2 px-3 py-2.5 rounded-xl border ${
              broadcast?.fresh ? 'bg-gold/10 border-gold/30' : 'bg-hanji border-line'
            }`}
          >
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muk-soft">현재 방송</span>
                <span className="text-sm font-bold text-muk">
                  {current ? SEAT_LABEL[current.level] : '설정 안 함'}
                </span>
                {current && (
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-bold border ${
                      broadcast?.fresh
                        ? 'bg-gold/15 text-gold-deep border-gold/30'
                        : 'bg-white text-muk-soft border-line'
                    }`}
                  >
                    {broadcast?.fresh ? '적용 중' : '만료됨'}
                  </span>
                )}
              </div>
              <p className="text-xs text-muk-soft">
                {!current && '아직 방송한 상태가 없습니다. 추천에는 예측 혼잡도가 쓰입니다.'}
                {current &&
                  broadcast?.fresh &&
                  `${broadcast.clockLabel} 방송 · 약 ${broadcast.minutesLeft}분 뒤 만료(추천 반영 중)`}
                {current &&
                  broadcast &&
                  !broadcast.fresh &&
                  `${broadcast.minutesAgo}분 전 방송 · 추천에는 더 이상 반영되지 않습니다`}
                {current && !broadcast && '방송 시각을 알 수 없어 추천에 반영되지 않습니다.'}
              </p>
            </div>
            {current && (
              <button
                onClick={handleClear}
                disabled={clearing || submitting !== null}
                aria-label="좌석 상태 방송 끄기"
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-line bg-white text-muk-soft text-xs hover:bg-hanji transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
              >
                {clearing ? (
                  <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                ) : (
                  <PowerOff size={12} aria-hidden="true" />
                )}
                방송 끄기
              </button>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="좌석 상태 방송">
            {SEAT_OPTIONS.map((opt) => (
              <button
                key={opt.level}
                onClick={() => handleBroadcast(opt.level)}
                disabled={submitting !== null || clearing}
                aria-pressed={activeLevel === opt.level}
                className={`flex flex-col items-center gap-1 py-3 rounded-xl border text-sm font-bold transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
                  activeLevel === opt.level ? 'border-gold bg-gold/10 text-gold-deep' : 'border-line text-muk hover:bg-hanji'
                }`}
              >
                {submitting === opt.level ? (
                  <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                ) : (
                  <span aria-hidden="true" className="flex items-center">
                    {opt.icon}
                  </span>
                )}
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
