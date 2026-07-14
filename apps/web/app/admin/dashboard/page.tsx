'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Users, Activity, TrendingUp, AlertTriangle, Search, Bell, Download, Info
} from 'lucide-react';
import { AdminSidebar } from '@/components/AdminSidebar';
import { DashboardCharts, DashboardHeatmap } from '@/components/admin/DashboardCharts';
import { FacilityTable } from '@/components/admin/FacilityTable';
import { SimulatePeakButton } from '@/components/admin/SimulatePeakButton';
import { CouponPolicyPanel } from '@/components/admin/CouponPolicyPanel';
import { ImpactWidget } from '@/components/admin/ImpactWidget';
import { ModelAccuracyBadge } from '@/components/admin/ModelAccuracyBadge';
import { DataFreshnessBadge } from '@/components/admin/DataFreshnessBadge';

import { adminApi } from '@/lib/admin-api';

// ── 로컬 타입 정의 ──────────────────────────────────────────────────────────
// admin-api.ts 는 snake_case→camelCase 변환을 하지 않으므로(해당 파일 상단 주석 참조),
// API 유래 응답은 백엔드가 보내는 snake_case 키를 그대로 갖는다.
interface AnomalyAlert {
  id: string;
  facilityName: string;
  timestamp: string;
  congestionLevel: number;
  durationMinutes: number;
}
// GET /api/v1/admin/metrics 응답 (apps/api/app/routers/admin.py get_metrics)
interface MetricsRecommendation {
  accepted: boolean;
  created_at: string;
}
interface MetricsFeedback {
  user_id: string;
  timestamp: string;
}
interface AdminMetricsResponse {
  since: string;
  recommendations: MetricsRecommendation[];
  feedback: MetricsFeedback[];
}

// 섹션별 로딩 스켈레톤 — 전면 스피너 게이트 제거 후, 각 지표가 준비될 때까지 자리에 표시한다.
function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-hanok-line/60 ${className}`} />;
}

// 30일 수요 분산 '예시' 추이(데모) — 실측(metrics/trend) 표본이 3일 미만일 때의 폴백 전용.
// 도입 전/후 혼잡도와 대안 장소 활용률의 기대 패턴을 합성해 '③ 분산 효과'를 시각적으로 설명한다.
// 반드시 차트에 '예시 추이(데모)' 라벨과 함께 노출해 실측으로 오인되지 않게 한다(정직성 원칙).
function buildDemoDistribution() {
  const days = 30;
  const rows: any[] = [];
  const today = new Date();
  const clamp = (v: number) => Math.round(Math.min(0.98, Math.max(0.02, v)) * 1000) / 1000;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    const progress = (days - 1 - i) / (days - 1); // 0(30일 전) → 1(오늘)
    // 도입 전(반사실 기준선): 고혼잡을 유지 + 요일성 변동
    const before = 0.82 + 0.04 * Math.sin(i * 0.9);
    // 도입 후: 개입이 누적되며 점진적 혼잡 감소
    const after = 0.78 - 0.3 * progress + 0.03 * Math.sin(i * 1.3);
    // 대안 장소 활용률: 점진적 상승
    const alt = 0.08 + 0.42 * progress + 0.02 * Math.cos(i * 1.1);
    rows.push({
      date: label,
      beforeCongestion: clamp(before),
      afterCongestion: clamp(after),
      alternativeUsage: clamp(alt),
    });
  }
  return rows;
}

// 폐루프 내러티브 스텝 헤더(①실시간 관제 → ②정책 개입 → ③분산 효과) — 심사위원이 흐름을 즉시 읽도록.
function StepBanner({
  badge,
  title,
  subtitle,
  color,
}: {
  badge: string;
  title: string;
  subtitle: string;
  color: 'blue' | 'amber' | 'emerald';
}) {
  const palette: Record<string, string> = {
    blue: 'bg-gold/15 text-gold border-gold/30',
    amber: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    emerald: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  };
  return (
    <div className="flex items-center gap-3">
      <span
        className={`flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full text-base font-black border ${palette[color]}`}
      >
        {badge}
      </span>
      <div className="min-w-0">
        <h3 className="text-base font-bold text-hanok-ink leading-tight">{title}</h3>
        <p className="text-xs text-hanok-muted truncate">{subtitle}</p>
      </div>
    </div>
  );
}

// KPI 근거/기준 툴팁 — info 아이콘 hover 시 노출(간단 CSS 툴팁, 카드 우측 정렬로 좌측으로 펼침).
function InfoTip({ text }: { text: string }) {
  return (
    <span className="relative inline-flex align-middle group/tip">
      <Info size={14} className="text-hanok-muted hover:text-hanok-muted cursor-help" />
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-6 z-30 w-48 rounded-lg border border-hanok-line bg-hanok-card px-3 py-2 text-left text-[11px] font-normal leading-snug text-hanok-muted opacity-0 shadow-xl transition-opacity duration-150 group-hover/tip:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

// KST '오늘' 00:00~23:59:59 구간을 UTC ISO 문자열로 반환.
// congestion_logs.timestamp 는 UTC 로 적재되므로, 브라우저 로컬 TZ 와 무관하게 KST(UTC+9) 고정 환산한다.
function getKstTodayRangeUtc() {
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000); // KST 벽시계
  const y = kstNow.getUTCFullYear();
  const m = kstNow.getUTCMonth();
  const d = kstNow.getUTCDate();
  const startUtcMs = Date.UTC(y, m, d, 0, 0, 0, 0) - 9 * 60 * 60 * 1000;
  const endUtcMs = Date.UTC(y, m, d, 23, 59, 59, 999) - 9 * 60 * 60 * 1000;
  return { start: new Date(startUtcMs).toISOString(), end: new Date(endUtcMs).toISOString() };
}

// 콜드 500 재시도 헬퍼 — 백엔드가 유휴 후 첫 요청에서 간헐 500(supabase 전역 싱글턴의 stale 커넥션 추정)을
// 내는 현상이 실측됨. 즉시 재시도하면 200이 돌아오므로, 실패 시 ~1초 후 딱 1회만 재시도한다.
// 재시도도 실패하면 그대로 던져 각 호출부의 기존 폴백(0/null 채움 + console.warn)으로 넘긴다
// (에러 경로·타입 불변). admin-api.ts 는 요청당 타임아웃만 갖고 재시도는 없으므로 그 위에 최소로 얹는다.
async function withColdStartRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn('초기 요청 실패, 1초 후 1회만 재시도합니다:', err);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return fn();
  }
}

// 혼잡 집계 슬라이스 — 12k행 클라이언트 집계를 서버(/admin/dashboard/today, service_role)로 이관(최적화 #4).
// 서버가 오늘/어제 congestion_logs 를 집계해 compact JSON 만 내려주므로, 브라우저는 페이지네이션·JS 집계 없이
// 슬라이스({ hasLogs, avgCongestion, anomalyCount, heatmap, anomalies })를 그대로 소비한다.
// 산식(KST 오늘 구간·평균·이상건수·히트맵·이상알림)은 서버(admin.py get_dashboard_today)가 단일 소스로 보유한다.
// 실패 시 예외를 그대로 전파 → 호출부 .catch 가 0/빈 값 슬라이스로 강등(기존 동작 유지). 추천 수락률/DAU 는
// fetchMetrics 로 분리해 이 슬라이스와 병렬 로드한다.
async function fetchCongestion() {
  return withColdStartRetry(() => adminApi.get('/api/v1/admin/dashboard/today'));
}

// 추천 수락률(최근 7일)/DAU(오늘) 슬라이스 — recommendations/user_feedback 은 RLS 강화로 anon 열람이
// 막혀(20260707 security_hardening) 관리자 API(/admin/metrics, service_role) 경유(WS-A-6).
// 혼잡 집계와 별개 슬라이스라 병렬 로드하며, 실패 시 null(호출부에서 0/빈 값으로 강등).
async function fetchMetrics() {
  const { start, end } = getKstTodayRangeUtc();
  try {
    const weekAgo = new Date(new Date(start).getTime() - 6 * 24 * 60 * 60 * 1000).toISOString();
    const metrics: AdminMetricsResponse = await withColdStartRetry(() => adminApi.get('/api/v1/admin/metrics?days=8'));
    let acceptRate: { value: number; total: number; accepted: number } | null = null;
    let activeUsers: number | null = null;
    const recs = (metrics?.recommendations || []).filter(
      (r: MetricsRecommendation) => r.created_at >= weekAgo && r.created_at <= end
    );
    if (recs.length > 0) {
      const total = recs.length;
      const accepted = recs.filter((r: MetricsRecommendation) => r.accepted).length;
      acceptRate = { value: Math.round((accepted / total) * 1000) / 1000, total, accepted };
    }
    const fb = (metrics?.feedback || []).filter(
      (f: MetricsFeedback) => f.timestamp >= start && f.timestamp <= end
    );
    if (fb.length > 0) activeUsers = new Set(fb.map((f: MetricsFeedback) => f.user_id)).size;
    return { acceptRate, activeUsers };
  } catch {
    return { acceptRate: null, activeUsers: null }; // 백엔드 미기동/권한 차이 시 폴백
  }
}

// ③ 분산 효과 30일 추이 슬라이스 — /admin/metrics/trend(KST 일별 실측: 일평균 혼잡도·추천 수락률).
// 혼잡 표본이 있는 날이 3일 미만이면 추이로서 무의미하므로 기존 데모 예시로 폴백하고,
// 어느 쪽인지는 차트 헤더 라벨(실측 집계/예시 추이)로 구분 표기한다(정직성 원칙).
async function fetchTrend(): Promise<{ mode: 'live' | 'demo'; rows: any[] }> {
  try {
    const t = await withColdStartRetry(() => adminApi.get('/api/v1/admin/metrics/trend?days=30'));
    const daily: any[] = t?.daily || [];
    const liveDays = daily.filter((d) => d.samples > 0).length;
    if (liveDays >= 3) {
      const rows = daily.map((d) => {
        const [, m, dd] = String(d.date).split('-');
        return {
          date: `${Number(m)}/${Number(dd)}`,
          // 로그/추천 없는 날은 null — recharts connectNulls 로 선만 잇고 점은 찍지 않는다.
          avgCongestion: d.avg_congestion,
          acceptShare: d.rec_total > 0 ? Math.round((d.rec_accepted / d.rec_total) * 1000) / 1000 : null,
        };
      });
      return { mode: 'live', rows };
    }
  } catch {
    // 백엔드 미기동/권한 차이 시 데모 폴백
  }
  return { mode: 'demo', rows: buildDemoDistribution() };
}

export default function DashboardPage() {
  // 슬라이스별 상태 — 혼잡 집계(오늘/어제 로그)와 추천/DAU 지표를 각각 독립 보관해 준비되는 대로 렌더한다
  // (전면 스피너 게이트 제거 → 섹션별 스켈레톤). null = 아직 로딩 중.
  const [congestion, setCongestion] = useState<any>(null); // { hasLogs, avgCongestion, anomalyCount, heatmap, anomalies }
  const [metrics, setMetrics] = useState<any>(null);        // { acceptRate, activeUsers }
  // 30일 분산 효과 — 실측(metrics/trend)이 충분하면 live, 빈약하면 데모 폴백(fetchTrend 참조). null = 로딩 중.
  const [distribution, setDistribution] = useState<{ mode: 'live' | 'demo'; rows: any[] } | null>(null);

  // 언마운트 이후 setState 방지 가드(마운트 동안 true).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 대시보드 데이터 로드/재조회 — 초기 마운트와 '모의 발생' 성공 콜백에서 공용으로 호출한다.
  // 두 독립 슬라이스(혼잡 집계·추천/DAU 지표)를 '병렬'로 로드하고 각자 완료되는 대로 setState 한다
  // (직렬 워터폴·전면 스피너 제거). 정적 export 라 재실행 시 리마운트 없이 슬라이스만 갱신한다.
  const loadData = useCallback(async () => {
    const congestionTask = fetchCongestion()
      .then((c) => { if (mountedRef.current) setCongestion(c); })
      .catch((err) => {
        console.warn('혼잡 집계 조회 실패, 0/빈 값으로 대체:', err);
        if (mountedRef.current) setCongestion({ hasLogs: false, avgCongestion: null, anomalyCount: null, heatmap: null, anomalies: null });
      });
    const metricsTask = fetchMetrics()
      .then((m) => { if (mountedRef.current) setMetrics(m); })
      .catch(() => { if (mountedRef.current) setMetrics({ acceptRate: null, activeUsers: null }); });
    const trendTask = fetchTrend()
      .then((t) => { if (mountedRef.current) setDistribution(t); })
      .catch(() => { if (mountedRef.current) setDistribution({ mode: 'demo', rows: buildDemoDistribution() }); });
    await Promise.all([congestionTask, metricsTask, trendTask]);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 슬라이스 → 렌더 파생값. 도착 전에는 0/빈 값으로 두고, *Ready 로 스켈레톤 표시 여부를 판별한다.
  const congestionReady = congestion !== null;
  const metricsReady = metrics !== null;
  const kpi = {
    avgCongestion: congestion?.avgCongestion ?? { value: 0, changePercent: 0 },
    anomalyCount: congestion?.anomalyCount ?? 0,
    acceptRate: metrics?.acceptRate ?? { value: 0, total: 0, accepted: 0 },
    activeUsers: metrics?.activeUsers ?? 0,
  };
  const heatmap = congestion?.heatmap ?? [];
  const anomalies = congestion?.anomalies ?? [];

  // 정적 export 에는 서버 라우트(/api/admin/export)가 없으므로, 현재 로드된 데이터로
  // 클라이언트에서 CSV 를 생성해 다운로드한다(엑셀 한글 깨짐 방지를 위해 BOM 부착).
  const handleExportCsv = () => {
    try {
      const lines: string[] = [];
      lines.push('구분,항목,값');
      lines.push(`KPI,오늘 평균 혼잡도(%),${(kpi.avgCongestion.value * 100).toFixed(1)}`);
      lines.push(`KPI,AI 추천 수락률(%),${(kpi.acceptRate.value * 100).toFixed(1)}`);
      lines.push(`KPI,활성 사용자(DAU),${kpi.activeUsers}`);
      lines.push(`KPI,이상 혼잡 발생(건),${kpi.anomalyCount}`);
      lines.push('');
      lines.push('시설명,유형,시간(시),혼잡도(%)');
      for (const c of heatmap) {
        const name = String(c.facility).replace(/[",\n]/g, ' ');
        lines.push(`${name},${c.facilityType},${c.hour},${Math.round((c.value ?? 0) * 100)}`);
      }
      const csv = '﻿' + lines.join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const today = new Date().toISOString().split('T')[0];
      a.href = url;
      a.download = `nextspot-dashboard-${today}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.warn('CSV 내보내기 실패:', e);
      alert('CSV 내보내기에 실패했습니다.');
    }
  };

  return (
    <div className="flex h-screen bg-hanok text-hanok-ink font-sans overflow-hidden">

      {/* Sidebar */}
      <AdminSidebar />

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Top Header */}
        <header className="h-20 bg-hanok-panel border-b border-hanok-line flex items-center justify-between px-8 flex-shrink-0">
          <div className="flex items-center gap-4">
            <h2 className="text-xl font-bold text-hanok-ink">경주 관광 혼잡 종합 대시보드</h2>
            <ModelAccuracyBadge />
            <DataFreshnessBadge />
          </div>
          <div className="flex items-center gap-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-hanok-muted" size={18} />
              <input
                type="text"
                placeholder="Search..."
                className="pl-10 pr-4 py-2 bg-hanok-card text-hanok-ink placeholder-hanok-muted rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold w-64"
              />
            </div>
            <button className="relative text-hanok-muted hover:text-hanok-ink">
              <Bell size={24} />
              {kpi.anomalyCount > 0 && (
                <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-rose-500 rounded-full border-2 border-hanok-line"></span>
              )}
            </button>
            <div className="w-10 h-10 rounded-full bg-gold/15 border border-gold/30 flex items-center justify-center font-bold text-gold">
              AD
            </div>
          </div>
        </header>

        {/* Dashboard Content (Scrollable) */}
        <div className="flex-1 p-8 overflow-y-auto flex flex-col gap-8">
          
          {/* Action Bar (Export & Simulation) */}
          <div className="flex justify-end items-center gap-4">
            {/* onSimulated: 리로드 대신 loadData 재조회로 히트맵을 갱신하고 관제 영역으로 스크롤한다. */}
            <SimulatePeakButton onSimulated={loadData} />
            <button
              type="button"
              onClick={handleExportCsv}
              className="flex items-center gap-2 px-4 py-2 bg-hanok-line hover:bg-hanok-line text-white font-semibold rounded-lg shadow-sm transition-colors text-sm cursor-pointer"
            >
              <Download size={16} /> 데이터 내보내기 (CSV)
            </button>
          </div>

          {/* ───────── 폐루프 ① 실시간 관제 ───────── */}
          <StepBanner
            badge="①"
            title="실시간 관제"
            subtitle="현재 혼잡을 모니터링하고 이상 피크를 탐지합니다"
            color="blue"
          />

          {/* KPI Cards (Server Rendered) */}
          <div className="grid grid-cols-4 gap-6">
            {/* 오늘 평균 혼잡도 */}
            <div className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm flex flex-col justify-between">
              <div className="flex justify-between items-start mb-4">
                <div className="p-3 bg-gold/10 rounded-xl text-gold">
                  <Activity size={24} />
                </div>
                <div className="flex items-center gap-2">
                  {congestionReady ? (
                    <span
                      title="전일 동시간대 평균 대비 변화율입니다. 음수(초록)면 혼잡이 줄어든 것으로 분산 효과를 의미합니다."
                      className={`px-2 py-1 text-xs font-bold rounded-full cursor-help ${kpi.avgCongestion.changePercent < 0 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}
                    >
                      {kpi.avgCongestion.changePercent > 0 ? '+' : ''}{kpi.avgCongestion.changePercent}%
                    </span>
                  ) : (
                    <Skeleton className="h-6 w-12" />
                  )}
                  <InfoTip text="오늘(KST) 수집된 혼잡 로그의 평균 혼잡도입니다. 시설 정원 대비 실시간 인원 비율을 0~100%로 환산해 평균낸 값입니다." />
                </div>
              </div>
              <div>
                <h3 className="text-hanok-muted text-sm font-semibold mb-1">오늘 평균 혼잡도</h3>
                {congestionReady ? (
                  <div className="text-3xl font-black text-hanok-ink">
                    {(kpi.avgCongestion.value * 100).toFixed(1)}%
                  </div>
                ) : (
                  <Skeleton className="h-9 w-24 mt-1" />
                )}
              </div>
            </div>

            {/* 추천 수락률 */}
            <div className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm flex flex-col justify-between">
              <div className="flex justify-between items-start mb-4">
                <div className="p-3 bg-jade/10 rounded-xl text-jade">
                  <TrendingUp size={24} />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-hanok-muted">지난 7일</span>
                  <InfoTip text="지난 7일간 생성된 AI 대안 추천 중 사용자가 실제 수락한 비율입니다. (수락 건수 ÷ 전체 추천 건수)" />
                </div>
              </div>
              <div>
                <h3 className="text-hanok-muted text-sm font-semibold mb-1">AI 추천 수락률</h3>
                {metricsReady ? (
                  <>
                    <div className="text-3xl font-black text-hanok-ink">
                      {(kpi.acceptRate.value * 100).toFixed(1)}%
                    </div>
                    <div className="text-xs text-hanok-muted mt-1">총 {kpi.acceptRate.total}건 중 {kpi.acceptRate.accepted}건 수락</div>
                  </>
                ) : (
                  <>
                    <Skeleton className="h-9 w-24 mt-1" />
                    <Skeleton className="h-3 w-32 mt-2" />
                  </>
                )}
              </div>
            </div>

            {/* DAU */}
            <div className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm flex flex-col justify-between">
              <div className="flex justify-between items-start mb-4">
                <div className="p-3 bg-emerald-500/10 rounded-xl text-emerald-400">
                  <Users size={24} />
                </div>
                <InfoTip text="오늘(KST) 피드백을 남긴 순 사용자 수(DAU, Daily Active Users)입니다." />
              </div>
              <div>
                <h3 className="text-hanok-muted text-sm font-semibold mb-1">활성 사용자 수 (DAU)</h3>
                {metricsReady ? (
                  <div className="text-3xl font-black text-hanok-ink">
                    {kpi.activeUsers.toLocaleString()}명
                  </div>
                ) : (
                  <Skeleton className="h-9 w-20 mt-1" />
                )}
              </div>
            </div>

            {/* 이상 혼잡 알림 건수 */}
            <div className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm flex flex-col justify-between">
              <div className="flex justify-between items-start mb-4">
                <div className="p-3 bg-rose-500/10 rounded-xl text-rose-400">
                  <AlertTriangle size={24} />
                </div>
                <InfoTip text="오늘(KST) 혼잡도 90% 이상 피크가 발생한 로그 건수입니다. 관제 임계치를 초과한 상황을 의미합니다." />
              </div>
              <div>
                <h3 className="text-hanok-muted text-sm font-semibold mb-1">이상 혼잡 발생 (오늘)</h3>
                {congestionReady ? (
                  <div className="text-3xl font-black text-rose-600">
                    {kpi.anomalyCount}건
                  </div>
                ) : (
                  <Skeleton className="h-9 w-16 mt-1" />
                )}
              </div>
            </div>
          </div>

          {/* 관제 핵심 히트맵 — 개입(simulate-peak)이 바꾸는 화면이므로 개입 행 '위'에 배치해
              스크롤 없이 보이게 한다. id 앵커: '모의 발생' 성공 후 이 영역으로 스크롤해 분산 변화를 즉시 보여준다. */}
          <div id="congestion-heatmap" className="grid grid-cols-4 gap-6 scroll-mt-4">
            {congestionReady
              ? <DashboardHeatmap heatmapData={heatmap} />
              : <Skeleton className="col-span-4 min-h-[500px] rounded-2xl" />}
          </div>

          {/* ───────── 폐루프 ② 정책 개입 · ③ 분산 효과 ───────── (아래 행의 두 컬럼에 각각 정렬) */}
          <div className="grid grid-cols-3 gap-6">
            <div className="col-span-2">
              <StepBanner
                badge="②"
                title="정책 개입"
                subtitle="쿠폰 인센티브로 분산 목적지의 추천 순위를 조정합니다"
                color="amber"
              />
            </div>
            <div className="col-span-1">
              <StepBanner
                badge="③"
                title="분산 효과"
                subtitle="개입이 덜어낸 혼잡을 정량화합니다"
                color="emerald"
              />
            </div>
          </div>

          {/* 개입 폐루프 Row — 쿠폰 정책(②개입) + 분산 효과(③효과 정량화) */}
          <div className="grid grid-cols-3 gap-6">
            <CouponPolicyPanel />
            <ImpactWidget />
          </div>

          {/* 30일 분산 효과 추이(③) — 실측 집계(metrics/trend) 우선, 표본 부족 시 데모 폴백.
              어느 쪽인지는 차트 헤더 라벨(실측 집계/예시 추이)이 구분 표기한다. */}
          <div className="grid grid-cols-4 gap-6">
            {distribution !== null
              ? <DashboardCharts distribution={distribution.rows} mode={distribution.mode} />
              : <Skeleton className="col-span-4 min-h-[380px] rounded-2xl" />}
          </div>

          {/* Bottom Section */}
          <div className="grid grid-cols-3 gap-6 pb-10">
            {/* Facility Table (Client Component) */}
            <FacilityTable />

            {/* Anomaly Alerts List (Server Rendered) */}
            <div className="bg-hanok-panel rounded-2xl border border-hanok-line shadow-sm overflow-hidden flex flex-col">
              <div className="p-6 border-b border-hanok-line flex items-center gap-2 bg-hanok-card/30">
                <AlertTriangle className="text-rose-400" size={20} />
                <h3 className="text-lg font-bold text-hanok-ink">이상 혼잡 알림 내역</h3>
              </div>
              <div className="flex-1 p-4 overflow-y-auto">
                <div className="flex flex-col gap-3">
                  {anomalies.map((alert: AnomalyAlert) => (
                    <div key={alert.id} className="p-4 rounded-xl border border-rose-500/15 bg-rose-500/10 flex flex-col gap-2 relative overflow-hidden">
                      <div className="absolute left-0 top-0 bottom-0 w-1 bg-rose-500"></div>
                      <div className="flex justify-between items-start">
                        <span className="font-bold text-rose-300">{alert.facilityName}</span>
                        <span className="text-xs font-semibold text-rose-400">
                          {new Date(alert.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                        </span>
                      </div>
                      <div className="text-sm text-rose-400 flex justify-between">
                        <span>임계치 초과: {(alert.congestionLevel * 100).toFixed(0)}%</span>
                        <span className="font-bold">지속: {alert.durationMinutes}분</span>
                      </div>
                    </div>
                  ))}
                  {congestionReady && anomalies.length === 0 && (
                    <div className="text-center text-hanok-muted py-10 text-sm">
                      현재 발생한 이상 알림이 없습니다.
                    </div>
                  )}
                  {!congestionReady && [0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-20 rounded-xl" />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
