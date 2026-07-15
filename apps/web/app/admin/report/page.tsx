'use client';

// 분산정책 성과 리포트(B2G) — 관제 데이터를 의회/평가 제출용 인쇄물로 원클릭 조립하는 화면.
// 신규 백엔드 없이 기존 관리자 엔드포인트만 조합한다:
//   - GET /api/v1/admin/metrics/trend?days=30 (일평균 혼잡·추천 수락 KST 일별 실측)
//   - GET /api/v1/admin/dashboard/today       (오늘 스냅샷 — 참고용, 30일 KPI와는 별개 기간)
//   - GET /api/v1/freshness                  (TourAPI 마지막 동기화 신선도)
// 정직성 원칙: 위 3개 응답에서 파생 불가능한 지표(쿠폰 발급·사용 등)는 지어내지 않고 표에서 제외하며
// 그 사유를 각주로 명시한다. 표본이 부족한 30일 추이는(대시보드와 달리) 데모 데이터로 대체하지 않고
// '데이터 없음/표본 부족' 상태를 그대로 노출한다 — 의회·평가 제출용 공식 리포트이기 때문이다.

import { useEffect, useMemo, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  Printer, BarChart3, Calendar, Satellite, Clock, AlertCircle,
} from 'lucide-react';
import { AdminSidebar } from '@/components/AdminSidebar';
import { adminApi } from '@/lib/admin-api';
import { apiClient } from '@/lib/api-client';
import { formatRelativeKo } from '@/lib/freshness';

const REPORT_DAYS = 30;
// 대시보드(fetchTrend)와 동일 기준 — 실측 표본일이 이 미만이면 통계적 해석 유의 문구를 반드시 덧붙인다.
const MIN_SAMPLE_DAYS_FOR_CONFIDENCE = 3;

// ── 응답 타입 ────────────────────────────────────────────────────────────
// GET /api/v1/admin/metrics/trend (admin.py get_metrics_trend) — admin-api 는 케이스 변환이 없어
// 백엔드 snake_case 필드명을 그대로 받는다.
interface TrendDay {
  date: string; // 'YYYY-MM-DD' (KST)
  avg_congestion: number | null; // 로그 없는 날은 null(실측 0과 구분)
  samples: number;
  rec_total: number;
  rec_accepted: number;
}
interface TrendResponse {
  days: number;
  daily: TrendDay[];
  truncated: boolean;
}

// GET /api/v1/admin/dashboard/today (admin.py get_dashboard_today) — 이미 camelCase 로 내려온다.
interface DashboardTodayResponse {
  hasLogs: boolean;
  avgCongestion: { value: number; changePercent: number } | null;
  anomalyCount: number | null;
}

// 차트용 표시 행(월/일 라벨 + 0~1 비율)
interface ChartRow {
  date: string;
  avgCongestion: number | null;
  acceptShare: number | null;
}

function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

function fmtIsoDateKo(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${y}.${m}.${d}`;
}

function fmtNowKo(d: Date): string {
  return d.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }) + ' (KST)';
}

// 로딩/실패 상태를 값 자리에 그대로 노출하는 작은 헬퍼 — 무한 스켈레톤 대신 텍스트로 대체한다.
function ValueOrState({ loading, error, value }: { loading: boolean; error: boolean; value: string | null }) {
  if (loading) return <span className="text-gray-400">불러오는 중…</span>;
  if (error || value === null) return <span className="text-gray-400">데이터 없음</span>;
  return <span>{value}</span>;
}

export default function AdminReportPage() {
  const [trend, setTrend] = useState<TrendResponse | null>(null);
  const [trendError, setTrendError] = useState(false);
  const [today, setToday] = useState<DashboardTodayResponse | null>(null);
  const [todayError, setTodayError] = useState(false);
  const [freshness, setFreshness] = useState<{ lastTourapiSync: string | null; source: string | null } | null>(null);
  const [freshnessError, setFreshnessError] = useState(false);
  const [loading, setLoading] = useState(true);
  // 생성 시각은 마운트 시점에 1회 고정(리렌더마다 바뀌지 않도록).
  const [generatedAt] = useState(() => new Date());

  useEffect(() => {
    let active = true;
    (async () => {
      const results = await Promise.allSettled([
        adminApi.get(`/api/v1/admin/metrics/trend?days=${REPORT_DAYS}`),
        adminApi.get('/api/v1/admin/dashboard/today'),
        apiClient.getFreshness(),
      ]);
      if (!active) return;
      const [trendRes, todayRes, freshRes] = results;

      if (trendRes.status === 'fulfilled') setTrend(trendRes.value);
      else { setTrendError(true); console.warn('[report] 30일 추이 조회 실패:', trendRes.reason); }

      if (todayRes.status === 'fulfilled') setToday(todayRes.value);
      else { setTodayError(true); console.warn('[report] 오늘 스냅샷 조회 실패:', todayRes.reason); }

      if (freshRes.status === 'fulfilled') {
        setFreshness({ lastTourapiSync: freshRes.value.lastTourapiSync, source: freshRes.value.source });
      } else {
        setFreshnessError(true);
        console.warn('[report] 데이터 신선도 조회 실패:', freshRes.reason);
      }

      setLoading(false); // adminApi/apiClient 모두 요청 타임아웃(8~10초)이 있어 유한하게 종료된다.
    })();
    return () => { active = false; };
  }, []);

  // ── 30일 KPI 파생값 ──────────────────────────────────────────────────
  const kpi = useMemo(() => {
    if (!trend || !trend.daily || trend.daily.length === 0) return null;
    const daily = trend.daily;
    const withSamples = daily.filter((d) => d.samples > 0 && d.avg_congestion !== null);
    const sampleDays = withSamples.length;
    let avgCongestion: number | null = null;
    let maxCongestion: number | null = null;
    if (sampleDays > 0) {
      const sumWeighted = withSamples.reduce((acc, d) => acc + (d.avg_congestion as number) * d.samples, 0);
      const sumSamples = withSamples.reduce((acc, d) => acc + d.samples, 0);
      avgCongestion = sumSamples > 0 ? sumWeighted / sumSamples : null;
      maxCongestion = Math.max(...withSamples.map((d) => d.avg_congestion as number));
    }
    const recTotal = daily.reduce((acc, d) => acc + (d.rec_total || 0), 0);
    const recAccepted = daily.reduce((acc, d) => acc + (d.rec_accepted || 0), 0);
    const acceptRate = recTotal > 0 ? recAccepted / recTotal : null;
    return {
      totalDays: daily.length, sampleDays, avgCongestion, maxCongestion, recTotal, recAccepted, acceptRate,
      periodStart: daily[0].date, periodEnd: daily[daily.length - 1].date,
    };
  }, [trend]);

  const chartRows: ChartRow[] = useMemo(() => {
    if (!trend?.daily) return [];
    return trend.daily.map((d) => {
      const [, m, dd] = d.date.split('-');
      return {
        date: `${Number(m)}/${Number(dd)}`,
        avgCongestion: d.avg_congestion,
        acceptShare: d.rec_total > 0 ? Math.round((d.rec_accepted / d.rec_total) * 1000) / 1000 : null,
      };
    });
  }, [trend]);

  // ── 자동 총평 문단(수치 기반 템플릿 — 지어낸 문장 없음) ──────────────
  const narrative = useMemo(() => {
    if (loading) return null;
    if (trendError) return '30일 추이 데이터를 불러오지 못해 자동 총평을 생성할 수 없습니다.';
    if (!kpi) return '집계된 데이터가 없어 자동 총평을 생성할 수 없습니다.';

    const sentences: string[] = [];
    if (kpi.sampleDays === 0) {
      sentences.push(`최근 ${kpi.totalDays}일간 실측 혼잡 로그 표본이 없어 평균 혼잡도를 산출할 수 없습니다.`);
    } else {
      const stable = kpi.avgCongestion !== null && kpi.maxCongestion !== null
        && (kpi.maxCongestion - kpi.avgCongestion) > 0.05;
      sentences.push(
        `관측 표본 ${kpi.sampleDays}일 기준 평균 혼잡도는 ${fmtPct(kpi.avgCongestion)}로, 기간 내 최고 ${fmtPct(kpi.maxCongestion)} 대비 `
        + (stable ? '안정 구간을 유지했습니다.' : '큰 변동 없이 유지되었습니다.'),
      );
    }
    if (kpi.recTotal > 0) {
      sentences.push(`AI 분산 추천은 ${kpi.recTotal}건 제시되어 ${fmtPct(kpi.acceptRate)}가 수락되었습니다.`);
    } else {
      sentences.push('해당 기간 AI 분산 추천 기록이 없어 수락률을 산출할 수 없습니다.');
    }
    if (kpi.sampleDays < MIN_SAMPLE_DAYS_FOR_CONFIDENCE) {
      sentences.push('표본이 부족하여 통계적 해석에 주의가 필요합니다.');
    }
    return sentences.join(' ');
  }, [loading, trendError, kpi]);

  // ── 표지 헤더 표시값 ─────────────────────────────────────────────────
  const periodLabel = trendError
    ? '데이터 없음'
    : kpi
      ? `${fmtIsoDateKo(kpi.periodStart)} ~ ${fmtIsoDateKo(kpi.periodEnd)} (최근 ${kpi.totalDays}일)`
      : null; // null = 로딩 중(ValueOrState 가 처리)

  const freshnessLabel = freshnessError
    ? null
    : freshness
      ? (freshness.lastTourapiSync
        ? `TourAPI 동기화 ${formatRelativeKo(freshness.lastTourapiSync)} · 기준 ${new Date(freshness.lastTourapiSync).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (${freshness.source === 'estimate' ? '적재 시각 추정' : '동기화 마커 실측'})`
        : 'TourAPI 동기화 이력 없음')
      : undefined; // undefined = 아직 로딩 중

  return (
    <div className="flex h-screen bg-hanok text-hanok-ink font-sans overflow-hidden print:h-auto print:overflow-visible print:bg-white">
      {/* A4 페이지 여백 — Tailwind 유틸리티로 표현 불가능한 @page 규칙만 별도 지정 */}
      <style>{`@page { size: A4; margin: 14mm; }`}</style>

      {/* 사이드바 — 인쇄 시 숨김 */}
      <div className="print:hidden">
        <AdminSidebar />
      </div>

      <main className="flex-1 flex flex-col h-full overflow-hidden print:h-auto print:overflow-visible">
        {/* 상단 컨트롤바 — 인쇄 시 숨김 */}
        <header className="print:hidden h-20 bg-hanok-panel border-b border-hanok-line flex items-center justify-between px-8 flex-shrink-0">
          <div className="flex items-center gap-3">
            <BarChart3 className="text-gold" size={22} />
            <h2 className="text-xl font-bold text-hanok-ink">분산정책 성과 리포트</h2>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gold/10 border border-gold/30 text-gold text-sm font-bold">
                <Calendar size={14} /> 최근 30일 (고정)
              </span>
              <span
                title="분기·연간 등 임의 기간 선택 및 비교 리포트는 2단계 로드맵 항목입니다."
                className="text-xs text-hanok-muted cursor-help"
              >
                분기/연간은 2단계
              </span>
            </div>
            <button
              type="button"
              onClick={() => window.print()}
              className="flex items-center gap-2 px-4 py-2 bg-gold hover:bg-gold-deep text-hanok font-bold rounded-lg shadow-sm transition-colors text-sm cursor-pointer"
            >
              <Printer size={16} /> 리포트 인쇄 / PDF 저장
            </button>
          </div>
        </header>

        {/* 리포트 본문 — 화면에서도 인쇄물과 동일한 흰 A4 용지로 미리보기한다 */}
        <div className="flex-1 overflow-y-auto print:overflow-visible print:h-auto bg-hanok-line/20 print:bg-white p-6 print:p-0 flex justify-center">
          <div className="w-full max-w-[210mm] bg-white text-black shadow-xl print:shadow-none rounded-lg print:rounded-none p-10 print:p-0 flex flex-col gap-8">

            {/* 표지 헤더 */}
            <section className="break-inside-avoid border-b-2 border-black pb-6">
              <p className="text-xs font-bold tracking-widest text-gray-500 uppercase mb-2">
                NextSpot 관광 분산 정책 · B2G 제출용
              </p>
              <h1 className="text-2xl font-black leading-snug">
                경주 황리단길 관광 분산 정책 성과 리포트
              </h1>
              <div className="mt-5 grid grid-cols-3 gap-6 text-sm">
                <div>
                  <div className="text-gray-500 font-semibold mb-1">생성일</div>
                  <div className="font-bold">{fmtNowKo(generatedAt)}</div>
                </div>
                <div>
                  <div className="text-gray-500 font-semibold mb-1">데이터 기간</div>
                  <div className="font-bold"><ValueOrState loading={loading} error={trendError} value={periodLabel} /></div>
                </div>
                <div>
                  <div className="text-gray-500 font-semibold mb-1 flex items-center gap-1">
                    <Satellite size={13} /> 데이터 신선도
                  </div>
                  <div className="font-bold">
                    <ValueOrState loading={loading} error={freshnessError} value={freshnessLabel === undefined ? null : freshnessLabel} />
                  </div>
                </div>
              </div>
            </section>

            {/* KPI 요약 표 */}
            <section className="break-inside-avoid">
              <h2 className="text-base font-bold mb-3 flex items-center gap-2">
                <BarChart3 size={16} /> 기간 내(30일) KPI 요약
              </h2>
              <table className="w-full text-sm border-collapse">
                <tbody>
                  <tr className="border-b border-gray-200">
                    <td className="py-2 pr-4 text-gray-600 w-1/2">평균 혼잡도 (표본 가중평균)</td>
                    <td className="py-2 font-bold">
                      <ValueOrState loading={loading} error={trendError} value={kpi ? fmtPct(kpi.avgCongestion) : null} />
                    </td>
                  </tr>
                  <tr className="border-b border-gray-200">
                    <td className="py-2 pr-4 text-gray-600">기간 내 최고 혼잡도</td>
                    <td className="py-2 font-bold">
                      <ValueOrState loading={loading} error={trendError} value={kpi ? fmtPct(kpi.maxCongestion) : null} />
                    </td>
                  </tr>
                  <tr className="border-b border-gray-200">
                    <td className="py-2 pr-4 text-gray-600">실측 표본일수</td>
                    <td className="py-2 font-bold">
                      <ValueOrState
                        loading={loading}
                        error={trendError}
                        value={kpi ? `${kpi.sampleDays}일 / ${kpi.totalDays}일 (${fmtPct(kpi.sampleDays / kpi.totalDays, 0)})` : null}
                      />
                    </td>
                  </tr>
                  <tr className="border-b border-gray-200">
                    <td className="py-2 pr-4 text-gray-600">AI 분산 추천 노출 건수</td>
                    <td className="py-2 font-bold">
                      <ValueOrState loading={loading} error={trendError} value={kpi ? `${kpi.recTotal.toLocaleString()}건` : null} />
                    </td>
                  </tr>
                  <tr className="border-b border-gray-200">
                    <td className="py-2 pr-4 text-gray-600">AI 분산 추천 수락 건수</td>
                    <td className="py-2 font-bold">
                      <ValueOrState loading={loading} error={trendError} value={kpi ? `${kpi.recAccepted.toLocaleString()}건` : null} />
                    </td>
                  </tr>
                  <tr className="border-b border-gray-200">
                    <td className="py-2 pr-4 text-gray-600">AI 분산 추천 수락률</td>
                    <td className="py-2 font-bold">
                      <ValueOrState loading={loading} error={trendError} value={kpi ? fmtPct(kpi.acceptRate) : null} />
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-2 text-xs text-gray-500 flex gap-1.5">
                <AlertCircle size={13} className="flex-shrink-0 mt-px" />
                쿠폰 발급·사용 건수는 현재 리포트가 조합하는 관제 API(30일 추이·오늘 현황·데이터 신선도) 응답에
                포함되어 있지 않아 임의로 추정하지 않고 표에서 제외했습니다.
              </p>
            </section>

            {/* 오늘 현황(참고) — 30일 KPI와 기간이 다르므로 별도 박스로 명확히 분리 표기 */}
            <section className="break-inside-avoid bg-gray-50 border border-gray-200 rounded-md p-4">
              <h3 className="text-sm font-bold mb-2 flex items-center gap-1.5">
                <Clock size={14} /> 참고: 오늘(생성일) 관제 현황 스냅샷
              </h3>
              <p className="text-xs text-gray-500 mb-3">
                아래 두 값은 위 30일 KPI와 별개로, 실시간 관제 대시보드와 동일 산식으로 계산한 &apos;오늘 하루&apos; 기준 값입니다.
              </p>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-gray-500 mb-1">오늘 평균 혼잡도</div>
                  <div className="font-bold">
                    <ValueOrState
                      loading={loading}
                      error={todayError}
                      value={today && today.hasLogs && today.avgCongestion ? fmtPct(today.avgCongestion.value) : (todayError ? null : '표본 부족(로그 5건 미만)')}
                    />
                  </div>
                </div>
                <div>
                  <div className="text-gray-500 mb-1">오늘 이상 혼잡 발생</div>
                  <div className="font-bold">
                    <ValueOrState
                      loading={loading}
                      error={todayError}
                      value={today && today.hasLogs && today.anomalyCount !== null ? `${today.anomalyCount}건` : (todayError ? null : '표본 부족(로그 5건 미만)')}
                    />
                  </div>
                </div>
              </div>
            </section>

            {/* 30일 추이 차트 2개 — admin/dashboard 와 동일한 recharts 구성 재사용, 인쇄 폭 고려 고정 높이 */}
            <TrendLineChart
              title="30일 일평균 혼잡도 추이"
              data={chartRows}
              dataKey="avgCongestion"
              color="#2563eb"
              loading={loading}
              error={trendError}
              emptyMessage="표시할 혼잡도 추이 데이터가 없습니다."
            />
            <TrendLineChart
              title="30일 AI 분산 추천 수락률 추이"
              data={chartRows}
              dataKey="acceptShare"
              color="#059669"
              loading={loading}
              error={trendError}
              emptyMessage="표시할 추천 수락률 추이 데이터가 없습니다."
            />

            {/* 자동 총평 문단 */}
            <section className="break-inside-avoid">
              <h2 className="text-base font-bold mb-2">자동 총평</h2>
              <p className="text-sm leading-relaxed bg-gray-50 border border-gray-200 rounded-md p-4">
                {loading ? '불러오는 중…' : narrative}
              </p>
            </section>

            {/* 하단 각주 */}
            <section className="break-inside-avoid mt-auto pt-6 border-t border-gray-300 text-[11px] text-gray-500 leading-relaxed">
              <p>
                본 리포트는 NextSpot 실측 로그 자동 집계로 생성되었습니다({fmtNowKo(generatedAt)}).
                예측치는 ML 추정으로 실측과 구분 표기합니다.
              </p>
            </section>

          </div>
        </div>
      </main>
    </div>
  );
}

// 30일 추이 라인 차트 1개 — recharts(admin/dashboard 의 DashboardCharts.tsx 와 동일 컴포넌트 구성)를
// 인쇄용 흰 배경/고정 높이(220px)로 재구성한다. 표본이 전무하면(전부 null) 차트 대신 안내 문구를 낸다.
function TrendLineChart({
  title, data, dataKey, color, loading, error, emptyMessage,
}: {
  title: string;
  data: ChartRow[];
  dataKey: 'avgCongestion' | 'acceptShare';
  color: string;
  loading: boolean;
  error: boolean;
  emptyMessage: string;
}) {
  const hasData = !loading && !error && data.some((d) => d[dataKey] !== null && d[dataKey] !== undefined);
  const formatPercent = (value: unknown) => `${(Number(value) * 100).toFixed(1)}%`;

  return (
    <section className="break-inside-avoid">
      <h3 className="text-sm font-bold mb-2">{title}</h3>
      <div className="h-[220px] w-full border border-gray-200 rounded-md p-2">
        {loading ? (
          <div className="h-full flex items-center justify-center text-sm text-gray-400">불러오는 중…</div>
        ) : hasData ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: '#374151', fontSize: 11 }} />
              <YAxis
                axisLine={false} tickLine={false} tick={{ fill: '#374151', fontSize: 11 }}
                domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} width={40}
              />
              <Tooltip formatter={formatPercent} contentStyle={{ fontSize: 12, borderRadius: 6 }} />
              <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} dot={{ r: 2 }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-gray-400">
            {error ? '데이터를 불러오지 못했습니다.' : emptyMessage}
          </div>
        )}
      </div>
    </section>
  );
}
