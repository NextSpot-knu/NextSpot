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
  ReferenceArea, ReferenceLine, ReferenceDot, Label,
} from 'recharts';
import {
  Printer, BarChart3, Calendar, Satellite, Clock, AlertCircle, Info,
} from 'lucide-react';
import { AdminSidebar } from '@/components/AdminSidebar';
import { adminApi } from '@/lib/admin-api';
import { apiClient } from '@/lib/api-client';
import { formatRelativeKo } from '@/lib/freshness';

const REPORT_DAYS = 30;
// 대시보드(fetchTrend)와 동일 기준 — 실측 표본일이 이 미만이면 통계적 해석 유의 문구를 반드시 덧붙인다.
const MIN_SAMPLE_DAYS_FOR_CONFIDENCE = 3;

// ── 차트 색 ──────────────────────────────────────────────────────────────
// recharts 는 stroke/fill 을 SVG presentation attribute 로 내보내므로 var(--color-*) 가 해석되지
// 않는다(속성은 CSS 가 아니다). 그래서 globals.css @theme 토큰 값을 여기서 그대로 미러링한다
// — 색의 단일 정의점은 여전히 globals.css 이고, 여기는 recharts 전용 사본이다.
// 대비는 전부 '이 리포트가 인쇄되는 흰 종이(#ffffff)' 기준 WCAG 상대휘도로 계산했다.
const CHART_COLOR = {
  ink: '#2b2320',        // --color-muk        축 눈금/값 라벨. 흰 종이 대비 15.4:1
  inkSoft: '#6b5d4f',    // --color-muk-soft   축선·평균선·보조 텍스트. 흰 종이 대비 6.4:1 (AA)
  grid: '#e6dcc6',       // --color-line       격자. 1.36:1 — 데이터보다 항상 약해야 하므로 의도적으로 낮다
  voidFill: '#f1e7d3',   // --color-hanji-deep 미관측 구간 음영
  congestion: '#c1553b', // --color-terracotta 혼잡 계열(토큰 주석부터 '혼잡'용). 흰 종이 대비 4.54:1 (AA)
  accept: '#3e7c6a',     // --color-jade       수락률 계열. 흰 종이 대비 4.89:1 (AA)
} as const;
// 주의: terracotta(0.181)와 jade(0.165)는 상대휘도가 거의 같아 흑백 인쇄·색각 이상에서 서로 구분되지
// 않는다. 그래서 계열 구분을 색에만 맡기지 않고 선 패턴(실선/파선)을 함께 부여한다(WCAG 1.4.1).
const SERIES_DASH = { congestion: undefined, accept: '7 4' } as const;

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
// 색은 text-gray-400(흰 배경 대비 2.5:1, AA 미달)에서 muk-soft(6.4:1)로 올렸다 — '데이터 없음'은
// 이 리포트에서 값만큼 중요한 정보라 값보다 흐리게 보여선 안 된다.
function ValueOrState({ loading, error, value }: { loading: boolean; error: boolean; value: string | null }) {
  if (loading) return <span className="text-muk-soft">불러오는 중…</span>;
  if (error || value === null) return <span className="text-muk-soft">데이터 없음</span>;
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
      {/* Tailwind 유틸리티로 표현 불가능한 인쇄 규칙만 별도 지정한다(@page·print-color-adjust·recharts SVG 폭). */}
      <style>{`
        @page { size: A4; margin: 14mm; }
        @media print {
          /* 브라우저는 인쇄 시 배경색을 기본적으로 생략한다. 이 리포트는 '미관측 구간' 음영처럼
             배경이 곧 의미인 요소가 있어(빠지면 데이터 없는 구간과 빈 여백이 구분되지 않는다)
             종이 영역에 한해 강제 출력한다. */
          .report-paper, .report-paper * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
          /* recharts 래퍼 폭은 CSS 로 건드리지 않는다. ResponsiveContainer 가 인쇄 레이아웃 전환 시
             ResizeObserver 로 스스로 다시 측정해 A4 폭에 맞춘다(실제 PDF 출력으로 확인).
             width/height 를 !important 로 덮으면 오히려 0×0 중간 래퍼와 얽혀 차트가 통째로 사라진다. */
        }
      `}</style>

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
          <div className="report-paper w-full max-w-[210mm] bg-white text-black shadow-xl print:shadow-none rounded-lg print:rounded-none p-10 print:p-0 flex flex-col gap-8">

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

            {/* 30일 추이 차트 2개 — 화면과 인쇄(PDF)에서 모두 읽히도록 설계한 리포트 전용 구성.
                계열 구분은 색 + 선 패턴 2중이고, 툴팁이 없는 인쇄에서도 값을 읽을 수 있게
                평균선·최고점 라벨·하단 요약 캡션을 함께 낸다. */}
            <TrendLineChart
              title="30일 일평균 혼잡도 추이"
              seriesName="일평균 혼잡도(실측)"
              data={chartRows}
              dataKey="avgCongestion"
              color={CHART_COLOR.congestion}
              dash={SERIES_DASH.congestion}
              loading={loading}
              error={trendError}
              emptyMessage="집계된 혼잡 로그가 없어 표시할 추이가 없습니다."
            />
            <TrendLineChart
              title="30일 AI 분산 추천 수락률 추이"
              seriesName="추천 수락률(실측)"
              data={chartRows}
              dataKey="acceptShare"
              color={CHART_COLOR.accept}
              dash={SERIES_DASH.accept}
              loading={loading}
              error={trendError}
              emptyMessage="집계된 AI 분산 추천 기록이 없어 표시할 추이가 없습니다."
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

// ── 차트 보조 계산 ───────────────────────────────────────────────────────
// 미관측(값 null)이 연속으로 이어지는 구간. 카테고리 축의 ReferenceArea 로 음영 처리해
// '선이 끊긴 곳 = 0' 이라는 오독을 막는다. 카테고리 축에서 x1===x2 인 1일짜리 구간은 폭이 0이라
// 그려지지 않으므로 2일 이상만 음영 대상으로 삼는다(1일 결측은 끊긴 선 자체로 드러난다).
interface VoidSpan { from: string; to: string; days: number }

interface ChartStats {
  observed: number;
  total: number;
  avg: number | null;
  max: { date: string; value: number } | null;
  min: { date: string; value: number } | null;
  voidSpans: VoidSpan[];
  voidDays: number;
}

function summarizeSeries(data: ChartRow[], dataKey: 'avgCongestion' | 'acceptShare'): ChartStats {
  const points = data
    .map((d) => ({ date: d.date, value: d[dataKey] }))
    .filter((p): p is { date: string; value: number } => p.value !== null && p.value !== undefined);

  let sum = 0;
  let max: { date: string; value: number } | null = null;
  let min: { date: string; value: number } | null = null;
  for (const p of points) {
    sum += p.value;
    if (!max || p.value > max.value) max = p;
    if (!min || p.value < min.value) min = p;
  }

  const voidSpans: VoidSpan[] = [];
  let runStart: number | null = null;
  data.forEach((d, i) => {
    const missing = d[dataKey] === null || d[dataKey] === undefined;
    if (missing && runStart === null) runStart = i;
    if ((!missing || i === data.length - 1) && runStart !== null) {
      const end = missing ? i : i - 1;
      const days = end - runStart + 1;
      if (days >= 2) voidSpans.push({ from: data[runStart].date, to: data[end].date, days });
      runStart = null;
    }
  });

  return {
    observed: points.length,
    total: data.length,
    avg: points.length > 0 ? sum / points.length : null,
    max,
    min,
    voidSpans,
    voidDays: data.length - points.length,
  };
}

// 30일 추이 라인 차트 1개 — 의회·평가 제출용 인쇄물이 최종 산출물이라, 화면 전용 어포던스(툴팁)에
// 값 읽기를 의존하지 않는다. 인쇄에서 살아남는 것만으로 차트를 읽을 수 있게 구성한다:
//   ① 범례·축 제목·눈금을 muk(15.4:1)/muk-soft(6.4:1)로 명시  ② 평균 기준선(값은 범례) + 최고점 값 라벨
//   ③ 미관측 구간 음영                                        ④ 차트 아래 숫자 요약 캡션
// 계열 구분은 색 + 선 패턴 2중(흑백 인쇄 대비). 표본이 전무하면 축을 그리지 않고 '데이터 없음'
// 패널로 대체한다 — 빈 좌표축만 남으면 '전 구간 0%' 로 읽히기 때문이다.
function TrendLineChart({
  title, seriesName, data, dataKey, color, dash, loading, error, emptyMessage,
}: {
  title: string;
  seriesName: string;
  data: ChartRow[];
  dataKey: 'avgCongestion' | 'acceptShare';
  color: string;
  dash?: string;
  loading: boolean;
  error: boolean;
  emptyMessage: string;
}) {
  const stats = summarizeSeries(data, dataKey);
  const hasData = !loading && !error && stats.observed > 0;
  const formatPercent = (value: unknown) => `${(Number(value) * 100).toFixed(1)}%`;
  // 음영 라벨은 가장 긴 구간 하나에만 붙인다(짧은 구간까지 붙이면 글자가 겹친다).
  const labeledSpan = stats.voidSpans.reduce<VoidSpan | null>(
    (best, s) => (!best || s.days > best.days ? s : best), null,
  );

  return (
    <section className="report-chart break-inside-avoid">
      {/* 제목 + 범례를 한 줄에 — 범례 스와치가 실제 선 두께·패턴·마커를 그대로 재현하므로
          차트를 보지 않고도 어떤 선이 무엇인지 알 수 있다. 평균값을 차트 안(ReferenceLine Label)이
          아니라 여기 두는 이유: 관측일이 오른쪽 끝까지 이어지면 라벨이 추이선 위에 겹쳐 읽히지 않는다. */}
      <div className="flex items-baseline justify-between gap-x-4 gap-y-1 mb-2 flex-wrap">
        <h3 className="text-sm font-bold">{title}</h3>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-muk">
            <svg width="34" height="10" aria-hidden="true" className="flex-shrink-0">
              <line x1="1" y1="5" x2="33" y2="5" stroke={color} strokeWidth="2.75" strokeDasharray={dash} />
              <circle cx="17" cy="5" r="3.2" fill={color} stroke="#ffffff" strokeWidth="1.4" />
            </svg>
            {seriesName}
          </span>
          {hasData && stats.avg !== null && (
            <span className="flex items-center gap-1.5 text-xs font-semibold text-muk">
              <svg width="34" height="10" aria-hidden="true" className="flex-shrink-0">
                <line x1="1" y1="5" x2="33" y2="5" stroke={CHART_COLOR.inkSoft} strokeWidth="1.25" strokeDasharray="2 3" />
              </svg>
              관측 평균 {fmtPct(stats.avg)}
            </span>
          )}
        </div>
      </div>

      <div className="h-[248px] w-full border border-gray-300 rounded-md p-2">
        {loading ? (
          <div className="h-full flex items-center justify-center text-sm text-muk-soft">불러오는 중…</div>
        ) : hasData ? (
          <ResponsiveContainer width="100%" height="100%">
            {/* 위 여백 24 — 최고점/평균선 값 라벨이 100% 근처에 놓여도 잘리지 않을 만큼 */}
            <LineChart data={data} margin={{ top: 24, right: 20, bottom: 22, left: 4 }}>
              {/* 격자는 데이터보다 항상 약하게(1.36:1) — 이전 gray-200 과 밝기는 비슷하되 한지 웜톤 */}
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_COLOR.grid} />

              {/* 미관측 구간 음영 — '선이 없다 = 0' 오독 방지. 인쇄에서도 나오도록 print-color-adjust:exact */}
              {stats.voidSpans.map((s) => (
                <ReferenceArea
                  key={`void-${s.from}`}
                  x1={s.from}
                  x2={s.to}
                  fill={CHART_COLOR.voidFill}
                  fillOpacity={1}
                  stroke={CHART_COLOR.grid}
                  ifOverflow="extendDomain"
                >
                  {labeledSpan && labeledSpan.from === s.from && (
                    <Label
                      value={`미관측 ${s.days}일 (${s.from}~${s.to})`}
                      position="insideBottom"
                      offset={10}
                      fill={CHART_COLOR.inkSoft}
                      fontSize={11}
                      fontWeight={600}
                    />
                  )}
                </ReferenceArea>
              ))}

              <XAxis
                dataKey="date"
                axisLine={{ stroke: CHART_COLOR.inkSoft }}
                tickLine={{ stroke: CHART_COLOR.inkSoft }}
                tick={{ fill: CHART_COLOR.ink, fontSize: 11 }}
                tickMargin={6}
                interval="preserveStartEnd"
                minTickGap={14}
                padding={{ left: 8, right: 8 }}
              >
                <Label value="날짜 (월/일, KST)" position="insideBottom" offset={-16} fill={CHART_COLOR.inkSoft} fontSize={11} />
              </XAxis>
              <YAxis
                axisLine={{ stroke: CHART_COLOR.inkSoft }}
                tickLine={{ stroke: CHART_COLOR.inkSoft }}
                tick={{ fill: CHART_COLOR.ink, fontSize: 11 }}
                domain={[0, 1]}
                ticks={[0, 0.25, 0.5, 0.75, 1]}
                tickFormatter={(v) => `${Math.round(v * 100)}%`}
                width={58}
              >
                {/* 눈금 글자('100%')와 겹치지 않도록 축 폭을 넓히고 제목을 축 바깥쪽 끝에 붙인다 */}
                <Label value="비율 (%)" angle={-90} position="insideLeft" offset={0} fill={CHART_COLOR.inkSoft} fontSize={11} />
              </YAxis>

              {/* 기간 평균 기준선 — 값은 위 범례가 말한다(여기 라벨을 두면 추이선과 겹친다). */}
              {stats.avg !== null && (
                <ReferenceLine y={stats.avg} stroke={CHART_COLOR.inkSoft} strokeDasharray="2 3" strokeWidth={1.25} />
              )}

              <Tooltip
                formatter={formatPercent}
                labelFormatter={(l) => `${l} (KST)`}
                contentStyle={{
                  fontSize: 12, borderRadius: 6,
                  border: `1px solid ${CHART_COLOR.grid}`, color: CHART_COLOR.ink,
                }}
              />

              {/* connectNulls 제거 — 미관측 구간을 직선으로 이으면 없는 관측을 있는 것처럼 그린다.
                  선은 끊고, 끊긴 이유는 위 음영과 아래 캡션이 말한다(정직성 원칙). */}
              <Line
                name={seriesName}
                type="monotone"
                dataKey={dataKey}
                stroke={color}
                strokeWidth={2.75}
                strokeDasharray={dash}
                dot={{ r: 3.2, fill: color, stroke: '#ffffff', strokeWidth: 1.4 }}
                activeDot={{ r: 6 }}
                connectNulls={false}
                isAnimationActive={false}
              />

              {/* 기간 내 최고점만 값 라벨 — 30개 전부 붙이면 겹쳐서 오히려 안 읽힌다. */}
              {stats.max && (
                <ReferenceDot
                  x={stats.max.date}
                  y={stats.max.value}
                  r={4.5}
                  fill={color}
                  stroke="#ffffff"
                  strokeWidth={1.6}
                  ifOverflow="extendDomain"
                >
                  <Label
                    value={`최고 ${fmtPct(stats.max.value)}`}
                    position="top"
                    offset={8}
                    fill={CHART_COLOR.ink}
                    fontSize={11}
                    fontWeight={700}
                  />
                </ReferenceDot>
              )}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          // 빈 상태는 좌표축 없이 낸다 — 축만 남기면 '전 구간 0%' 로 읽히기 때문.
          <div className="h-full flex flex-col items-center justify-center gap-1 text-center px-6 bg-hanji-deep rounded-sm">
            <p className="text-sm font-bold text-muk">{error ? '데이터를 불러오지 못했습니다' : '데이터 없음'}</p>
            <p className="text-xs text-muk-soft">
              {error ? '관제 API 응답이 없어 이 구간의 추이를 표시할 수 없습니다.' : emptyMessage}
            </p>
            {!error && (
              <p className="text-xs font-semibold text-muk-soft">값이 0%라는 뜻이 아닙니다 — 해당 기간에 집계된 기록이 없습니다.</p>
            )}
          </div>
        )}
      </div>

      {/* 인쇄에서 살아남는 숫자 요약 — 툴팁 없이도 이 한 줄로 차트를 읽을 수 있게 한다. */}
      <p className="mt-1.5 text-[11px] text-muk-soft leading-relaxed flex gap-1.5">
        <Info size={12} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
        <span>
          {hasData ? (
            <>
              관측 {stats.observed}일 / {stats.total}일 · 평균 {fmtPct(stats.avg)}
              {stats.max && ` · 최고 ${fmtPct(stats.max.value)} (${stats.max.date})`}
              {stats.min && ` · 최저 ${fmtPct(stats.min.value)} (${stats.min.date})`}
              {stats.voidDays > 0
                && ` · 미관측 ${stats.voidDays}일은 선을 잇지 않고 음영으로 표시했습니다(0%가 아님).`}
            </>
          ) : (
            <>관측 0일 / {stats.total}일 — 기간 전체가 미관측이라 추이선을 그리지 않았습니다.</>
          )}
        </span>
      </p>
    </section>
  );
}
