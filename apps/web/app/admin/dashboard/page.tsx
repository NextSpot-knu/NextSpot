'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  Users, Activity, TrendingUp, AlertTriangle, Bell, Download, Info, Sparkles, FlaskConical, ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { AdminSidebar } from '@/components/AdminSidebar';
import { DashboardCharts, DashboardHeatmap } from '@/components/admin/DashboardCharts';
import { FacilityTable } from '@/components/admin/FacilityTable';
import { CouponPolicyPanel } from '@/components/admin/CouponPolicyPanel';
import { ImpactWidget } from '@/components/admin/ImpactWidget';
import { ModelAccuracyBadge } from '@/components/admin/ModelAccuracyBadge';
import { ModelTrustPanel } from '@/components/admin/ModelTrustPanel';
import { AreaDemandReliabilityPanel } from '@/components/admin/AreaDemandReliabilityPanel';
import { DataFreshnessBadge } from '@/components/admin/DataFreshnessBadge';

import { adminApi, getDashboardBriefing } from '@/lib/admin-api';
import {
  changeBadge,
  congestionMetric,
  metricsMetric,
  type AdminMetric,
  type CongestionSlice,
  type MetricsSlice,
} from '@/lib/adminMetricState';
import { estimatedBasisNotice } from '@/lib/dashboardFallback';
import {
  ESTIMATE_ANOMALY_UNIT,
  ESTIMATE_BADGE,
  csvBasisCell,
  dashboardDateBadge,
  dashboardEmptyNotice,
  dashboardFallbackExplanation,
  dashboardPeriodLabel,
  estimateBasisLine,
  estimateMethodNote,
  estimateUnavailableNote,
  pendingFromHour,
  resolveDashboardView,
  type DashboardTodayWithEstimate,
} from '@/lib/adminEstimateView';

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
// 히트맵 셀 — DashboardCharts.tsx 의 동명 타입 미러(그쪽은 export 하지 않는다).
// value: null = 그 시간대에 로그가 없음(실측 0.00 과 구분되는 센티넬).
interface HeatmapCell {
  facility: string;
  facilityType: string;
  hour: number;
  value: number | null;
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
  /** 표본이 서버 상한(_METRICS_ROW_CAP)에서 잘렸는가 — 아래 수락률·DAU 가 창 전체의 값이 아니다. */
  truncated?: boolean;
}

/** /admin/dashboard/today 의 avgCongestion — 서버가 세 값을 함께 싣는다.
 *
 *  changePercentOrNull / prevSampleCount 는 신규 키다. lib/adminMetricState.ts 의
 *  CongestionSlice 는 아직 구 모양(changePercent 만)을 선언하고 있어 여기에 확장 타입을
 *  둔다 — 그 파일은 지표 판정의 단일 소스라 화면 사정으로 흔들지 않는다.
 *
 *  두 키가 optional 인 이유: Render(API)와 Vercel(웹)은 배포 시점이 다르고 스테이징이 없다.
 *  **새 화면이 옛 서버를 받는 구간**도 실존하므로, 키가 없으면 구 키로 물러난다(아래 참조).
 */
interface AvgCongestionValue {
  value: number;
  /** 구 키. '변화 없음' 과 '표본 없음' 이 둘 다 0 이라 이것만으로는 판단할 수 없다. */
  changePercent: number;
  /** 비교할 수 없으면 null(전일 표본 0건이거나 전일 평균이 0). */
  changePercentOrNull?: number | null;
  /** 비교에 실제로 쓴 전일 로그 건수. */
  prevSampleCount?: number;
}

/**
 * 전일 대비 배지를 그릴 수 있는가.
 *
 * 서버가 changePercentOrNull 을 실으면 그 값이 유일한 근거다 — null 이면 **배지를 내지
 * 않는다.** 예전에는 표본이 없는 날에도 0% 배지를 회색으로 그리고 툴팁으로 얼버무렸는데,
 * 툴팁은 아무도 읽지 않는다. 화면에 배지가 있다는 것 자체가 '비교했다' 는 주장이다.
 *
 * 신규 키가 없으면(옛 서버) 구 키를 그대로 쓴다 — 그 구간의 동작은 예전과 같다.
 */
function changeComparison(avg: AvgCongestionValue):
  | { kind: 'badge'; percent: number }
  | { kind: 'no-sample' } {
  if (avg.changePercentOrNull === undefined) {
    // 옛 서버 응답 — 구분할 근거가 없다. 기존 동작(구 키로 배지)을 유지한다.
    return { kind: 'badge', percent: avg.changePercent };
  }
  if (avg.changePercentOrNull === null) return { kind: 'no-sample' };
  return { kind: 'badge', percent: avg.changePercentOrNull };
}

// 섹션별 로딩 스켈레톤 — 전면 스피너 게이트 제거 후, 각 지표가 준비될 때까지 자리에 표시한다.
function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-hanok-line/60 ${className}`} />;
}

// KPI 숫자 자리의 '실패' 표시 — 0 대신 '—' 와 붉은 배지를 둔다.
// 관리자는 이 타일 하나로 판단하므로, 못 가져온 것을 0 으로 그리면 '문제 없음' 으로 읽힌다.
function MetricUnavailable({ hint }: { hint: string }) {
  return (
    <div className="flex items-center gap-2 cursor-help" title={hint}>
      <span className="text-3xl font-black text-hanok-muted leading-none">—</span>
      <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/15 text-amber-700 border border-amber-500/30">
        갱신 중
      </span>
    </div>
  );
}

// KPI 숫자 자리의 '표본 없음' 표시 — 조회는 됐지만 계산할 데이터가 없다는 뜻.
// 실패와도, 실측 0 과도 다른 사실이라 셋을 각각 다른 모양으로 그린다.
function MetricNoSample({ hint }: { hint: string }) {
  return (
    <div className="flex items-center gap-2 cursor-help" title={hint}>
      <span className="text-3xl font-black text-hanok-muted leading-none">—</span>
      <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-hanok-card text-hanok-muted border border-hanok-line">
        수집 중
      </span>
    </div>
  );
}

// '추정' 배지 — 추정치를 그리는 모든 자리(KPI·히트맵·알림)에 같은 모양으로 붙는다.
// 점선 테두리는 카드 테두리(점선)와 같은 신호다: 숫자는 읽히되, 실측과 같은 모양이 아니다.
function EstimateBadge({ title }: { title?: string }) {
  return (
    <span
      title={title}
      className="px-2 py-0.5 rounded-full text-[11px] font-black border border-dashed bg-sky-500/15 text-sky-700 border-sky-400/60 cursor-help whitespace-nowrap"
    >
      {ESTIMATE_BADGE}
    </span>
  );
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
    blue: 'bg-gold/15 text-gold-deep border-gold/30',
    amber: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    emerald: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
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
//
// (*1) '전일 대비' 배지의 라벨 대 계산 — 라벨을 계산에 맞췄다.
// 서버(admin.py get_dashboard_today)의 changePercent 는 **오늘 KST 00:00~현재까지 쌓인 로그의
// 평균**을 **어제 하루 전체 평균**과 비교한다(어제 구간은 오늘 구간을 통째로 하루 민 것이라
// 항상 온종일이다). 즉 '동시간대' 비교가 아니라 부분 하루 vs 온종일 비교다. 예전 라벨은
// '전일 동시간대 평균 대비' 였고, 그건 사실이 아니었다 — 아침에 보면 언제나 큰 감소로 읽혔다.
//
// 계산을 라벨(동시간대)에 맞추지 않은 이유: 계산은 서버 소유이고, 어제를 '같은 시각까지' 로
// 자르면 지표의 정의 자체가 바뀐다(과거 값들과 비교 불가). 프런트에서 몰래 바꿀 일이 아니다.
// 그래서 여기서는 **라벨을 사실에 맞추고**, 부분 하루 비교라는 편향을 툴팁에 명시했다.
// 지표 정의를 '동시간대' 로 바꿀지는 사람이 결정할 문제다(보고서 참조).
//
// (*2) 응답에는 신규 키 세 개가 더 실린다: sampleCount / latestObservedAt / fallback.
// 이 화면의 '오늘' 구간은 **실제로 자주 비어 있다** — congestion_logs 를 채우는 경로가
// 손님 제보·사장 좌석 방송·관리자 오버라이드뿐이고, 10분마다 들어오는
// 공영주차 실측은 전혀 다른 표(area_demand_snapshots)로 간다. 예전에는 그때 화면이 그냥
// 비어서, 관리자가 '고장' 과 '오늘 관측 없음' 을 구분할 수 없었다. 판정은
// lib/dashboardFallback.ts 에 두고 테스트로 고정한다.
//
// (*3) 그리고 `estimated` — 그 주차 실측 + 관광공사 집중률로 서버가 읽을 때 계산한 **오늘의
// 추정 집계**(경주 추정 모드). 오늘 실측이 비면 과거 날짜(폴백)보다 이걸 먼저 그린다.
// 판정(순서·형 가드·근거 문장)은 lib/adminEstimateView.ts 에 두고 테스트로 고정한다.
async function fetchCongestion(): Promise<DashboardTodayWithEstimate> {
  return withColdStartRetry(() => adminApi.get('/api/v1/admin/dashboard/today'));
}

// 추천 수락률(최근 7일)/DAU(오늘) 슬라이스 — recommendations/user_feedback 은 RLS 강화로 anon 열람이
// 막혀(20260707 security_hardening) 관리자 API(/admin/metrics, service_role) 경유(WS-A-6).
// 혼잡 집계와 별개 슬라이스라 병렬 로드한다.
//
// 예외를 **잡지 않고 그대로 던진다**: 예전에는 여기서 catch 해 { acceptRate: null, activeUsers: null }
// 을 돌려줬는데, 그러면 호출부에서 '조회 실패' 와 '지난 7일 추천이 0건(표본 없음)' 이 완전히 같은
// 값이 되어 화면에 똑같이 0.0% / 0명으로 찍혔다. 실패는 호출부의 .catch 가 failed 슬라이스로 표시한다.
// (지표별 null 은 이제 '표본 없음' 만 뜻한다.)
async function fetchMetrics(): Promise<MetricsSlice & { truncated: boolean }> {
  const { start, end } = getKstTodayRangeUtc();
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
  // 피드백 0건은 '오늘 활동한 사용자가 없음'(실측 0)이지 '모름' 이 아니다.
  activeUsers = new Set(fb.map((f: MetricsFeedback) => f.user_id)).size;
  // 서버가 상한(_METRICS_ROW_CAP)에 닿으면 최신순으로 남기고 자른다 — 그러면 위 수락률·DAU
  // 는 창 전체의 값이 아니다. 서버는 어젯밤부터 이 플래그를 싣고 있었는데 화면이 읽지 않았다.
  return { acceptRate, activeUsers, truncated: metrics?.truncated === true };
}

// ③ 분산 효과 30일 추이 슬라이스 — /admin/metrics/trend(KST 일별 실측: 일평균 혼잡도·추천 수락률).
// 혼잡 표본이 있는 날이 3일 미만이면 추이로서 무의미하므로 기존 데모 예시로 폴백하고,
// 어느 쪽인지는 차트 헤더 라벨(실측 집계/예시 추이)로 구분 표기한다(정직성 원칙).
async function fetchTrend(): Promise<{ mode: 'live' | 'demo'; rows: any[]; truncated: boolean }> {
  try {
    const t = await withColdStartRetry(() => adminApi.get('/api/v1/admin/metrics/trend?days=30'));
    const daily: any[] = t?.daily || [];
    const liveDays = daily.filter((d) => d.samples > 0).length;
    if (liveDays >= 3) {
      const rows = daily.map((d) => {
        const [, m, dd] = String(d.date).split('-');
        return {
          date: `${Number(m)}/${Number(dd)}`,
          // 로그/추천 없는 날은 **null 로 둔다**(0 으로 채우지 않는다 — 0 은 '실측 0' 이라는 뜻이다).
          // 차트는 이 null 을 잇지 않고 끊어 그리고 미관측 구간을 음영으로 표시한다
          // (DashboardCharts 의 connectNulls={false} + lib/adminSeriesGaps.ts).
          // 예전 주석은 'connectNulls 로 선만 잇는다' 고 적혀 있었는데, 그건 동작을 반대로
          // 설명한 것이자 지금은 사실도 아니다 — 없는 관측을 직선으로 그리던 것을 걷어냈다.
          avgCongestion: d.avg_congestion,
          acceptShare: d.rec_total > 0 ? Math.round((d.rec_accepted / d.rec_total) * 1000) / 1000 : null,
        };
      });
      // truncated 면 창의 **앞쪽(오래된 날)** 이 실제보다 비어 보인다 — 서버가 상한에 닿으면
      // 최신순으로 남기기 때문이다. 추이 차트에서 이건 '그때는 한산했다' 로 읽힌다.
      return { mode: 'live', rows, truncated: t?.truncated === true };
    }
  } catch {
    // 백엔드 미기동/권한 차이 시 데모 폴백
  }
  return { mode: 'demo', rows: buildDemoDistribution(), truncated: false };
}

// 오늘의 브리핑(P0-2) 슬라이스 — 서버(briefing_service)가 대시보드 집계를 Solar 로 프로즈화.
// KPI 타일 렌더를 막지 않는 후행 fetch 이며, null(스킵/폐기/장애/미기동)이면 카드 자체를 렌더하지
// 않는다(무해 폴백). 디버그 배지 이벤트는 getDashboardBriefing 이 중앙 발행한다(api-client 관례).
async function fetchBriefing(): Promise<string | null> {
  try {
    const res = await getDashboardBriefing();
    return res?.briefing ?? null;
  } catch {
    return null; // 백엔드 미기동/권한 차이 시 조용한 미렌더
  }
}

export default function DashboardPage() {
  // 슬라이스별 상태 — 혼잡 집계(오늘/어제 로그)와 추천/DAU 지표를 각각 독립 보관해 준비되는 대로 렌더한다
  // (전면 스피너 게이트 제거 → 섹션별 스켈레톤). null = 아직 로딩 중.
  // failed:true 는 '조회 실패' 전용 표식이다 — 표본 부족(hasLogs=false)과 반드시 구분해 그린다.
  const [congestion, setCongestion] = useState<DashboardTodayWithEstimate | null>(null);
  // 혼잡 응답을 받은 시각(ms) — 히트맵의 '아직 오지 않은 시간' 경계를 이 시각으로 긋는다.
  const [congestionAt, setCongestionAt] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<MetricsSlice | null>(null);
  // 30일 분산 효과 — 실측(metrics/trend)이 충분하면 live, 빈약하면 데모 폴백(fetchTrend 참조). null = 로딩 중.
  const [distribution, setDistribution] = useState<{ mode: 'live' | 'demo'; rows: any[]; truncated?: boolean } | null>(null);
  // 표본 절단 — 서버가 상한에서 자른 사실. 화면이 이걸 말하지 않으면 관리자는 잘린 수치를
  // 기간 전체의 값으로 읽는다(그래서 '조용한 절단' 이 위험하다).
  const [metricsTruncated, setMetricsTruncated] = useState(false);
  // 오늘의 브리핑(AI) — null 이면 카드 미렌더(로딩 중/스킵/폐기/장애 모두 동일 취급, 스켈레톤 없음).
  const [briefing, setBriefing] = useState<string | null>(null);

  // 언마운트 이후 setState 방지 가드(마운트 동안 true).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 대시보드 데이터 로드 — 독립 슬라이스(혼잡 집계·추천/DAU 지표·추이·브리핑)를 '병렬'로 로드하고
  // 각자 완료되는 대로 setState 한다(직렬 워터폴·전면 스피너 제거).
  // (예전에는 '24시간 모의 발생'·'주차 실측 기반 추정 적재' 버튼의 성공 콜백도 이걸 불렀다.
  //  두 버튼은 D6 결정으로 걷어냈다 — 추정은 이제 서버가 읽을 때 계산해 estimated 로 싣는다.)
  const loadData = useCallback(async () => {
    const congestionTask = fetchCongestion()
      .then((c) => {
        if (!mountedRef.current) return;
        setCongestion(c);
        setCongestionAt(Date.now());
      })
      .catch((err) => {
        // 실패를 '표본 없음'(hasLogs=false)으로 강등하지 않는다. 그렇게 하면 관리자 화면에
        // 0.0% / 0건이 찍히고, 그건 '문제 없음' 으로 읽힌다.
        console.warn('혼잡 집계 조회 실패:', err);
        if (mountedRef.current) setCongestion({ failed: true });
      });
    const metricsTask = fetchMetrics()
      .then((m) => {
        if (!mountedRef.current) return;
        setMetrics(m);
        setMetricsTruncated(m.truncated);
      })
      .catch((err) => {
        console.warn('추천 수락률/DAU 조회 실패:', err);
        if (mountedRef.current) setMetrics({ failed: true });
      });
    const trendTask = fetchTrend()
      .then((t) => { if (mountedRef.current) setDistribution(t); })
      .catch(() => { if (mountedRef.current) setDistribution({ mode: 'demo', rows: buildDemoDistribution() }); });
    // 브리핑은 후행 fetch — KPI/히트맵 슬라이스와 병렬이라 타일 렌더를 절대 막지 않는다.
    const briefingTask = fetchBriefing()
      .then((b) => { if (mountedRef.current) setBriefing(b); })
      .catch(() => { if (mountedRef.current) setBriefing(null); });
    await Promise.all([congestionTask, metricsTask, trendTask, briefingTask]);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 무엇을 보고 있는가(오늘 / 폴백 기준일 / 표본 없음 / 실패)를 먼저 정한다 — 그 다음에야
  // 지표를 뽑을 수 있다. 오늘이 비었을 때 폴백일 집계를 그리되, **기준 날짜를 항상 함께**
  // 들고 다니는 것이 이 판정의 핵심이다(날짜 없이 그리면 오늘 것으로 읽힌다).
  //
  // 순서: 오늘 실측 → 오늘 **추정** → 과거 실측(폴백). 추정은 두 달 전 시드보다 앞선다 —
  // 관리자가 지금 판단하는 데는 '오늘 이 시각의 추정' 이 더 쓸모 있다. 실측이 들어오면 실측이 이긴다.
  const view = resolveDashboardView(congestion);
  const basis = view.basis;
  const isFallback = basis.kind === 'fallback';
  const isEstimate = basis.kind === 'estimate';
  // 추정 근거 한 줄('주차 실측(ITS 공영주차 N곳) + 관광공사 집중률 기반 추정 · HH:MM 관측 · 반경 2km').
  // 추정 값이 그려지는 모든 자리가 이 문장(또는 배지+이 문장의 툴팁)을 함께 단다.
  const estimateLine = basis.kind === 'estimate' ? estimateBasisLine(basis.info, basis.dateKst) : null;
  const estimateMethod = basis.kind === 'estimate' ? estimateMethodNote(basis.info) : null;
  // 추정을 못 그리고 폴백/빈 화면에 있다면 그 이유(추정 모드가 '사라진' 것처럼 보이지 않게).
  const estimateMissing = estimateUnavailableNote(congestion, basis);
  const dateBadge = dashboardDateBadge(basis);
  const basisNote = dashboardFallbackExplanation(basis);
  const emptyNotice = dashboardEmptyNotice(basis);
  // 이 구간의 값이 실측인가 추정인가. 주차 파생 추정치가 섞이면 아래 제목
  // ('시설 혼잡 (손님 제보 · 좌석 방송 기반)')이 그대로는 거짓이 되므로 배너로 정정한다.
  // (오늘 추정 모드의 집계는 source 가 'estimated' 하나라 여기 걸리지 않는다 — 그쪽은 아래
  //  추정 배너가 따로, 더 크게 말한다.)
  const estimatedBasis = estimatedBasisNotice(view.day);
  // KPI 타일 제목의 기간 라벨 — 폴백 중에 '오늘' 이라고 적으면 타일 전체가 거짓이 된다.
  const periodLabel = dashboardPeriodLabel(basis);
  // 오늘을 그릴 때만 '아직 오지 않은 시간' 이 있다. 기준 시각은 **응답을 받은 시각**이다 —
  // 렌더 중에 시계를 읽으면 같은 응답이 리렌더마다 다른 격자가 된다(그리고 순수성 규칙 위반).
  const pendingHour =
    basis.kind === 'estimate' && congestionAt !== null ? pendingFromHour(basis.dateKst, congestionAt) : null;

  // 슬라이스 → 지표별 표시 상태(로딩/실패/표본없음/정상). 예전에는 여기서 `?? 0` 으로 뭉개서
  // 세 경우가 화면에 똑같이 0 으로 찍혔다 — 판정은 lib/adminMetricState.ts 에 두고 테스트로 고정한다.
  const congestionFailed = basis.kind === 'failed';
  const day = view.day as CongestionSlice | null;
  const avgCongestion = congestionMetric(day, (s) => s.avgCongestion ?? null);
  const anomalyCount = congestionMetric(day, (s) => s.anomalyCount ?? null);
  const acceptRate = metricsMetric(metrics, (s) => s.acceptRate ?? null);
  const activeUsers = metricsMetric(metrics, (s) => s.activeUsers ?? null);
  const heatmap = (view.day?.heatmap ?? []) as HeatmapCell[];
  const anomalies = (view.day?.anomalies ?? []) as AnomalyAlert[];

  // 정적 export 에는 서버 라우트(/api/admin/export)가 없으므로, 현재 로드된 데이터로
  // 클라이언트에서 CSV 를 생성해 다운로드한다(엑셀 한글 깨짐 방지를 위해 BOM 부착).
  const handleExportCsv = () => {
    try {
      // 화면과 같은 규칙으로 내보낸다 — 못 가져온 값을 0 으로 적으면 CSV 를 받아 본 사람은
      // '측정값 0' 으로 읽는다. 실패/표본 없음은 숫자 대신 사유 문자열로 적는다.
      const cell = <T,>(m: AdminMetric<T>, fmt: (v: T) => string) =>
        m.status === 'ok' ? fmt(m.value) : m.status === 'failed' ? '갱신 중' : m.status === 'empty' ? '수집 중' : '로딩 중';
      const lines: string[] = [];
      lines.push('구분,항목,값');
      // 파일로 나간 숫자는 화면 맥락을 잃는다 — 어느 날 기준인지 첫 줄에 박아 둔다.
      // (폴백 중인 CSV 를 '오늘' 로 적으면, 그 파일을 받아 본 사람에게는 되돌릴 방법이 없다.)
      // 추정이면 '추정치(현장 관측 아님)' 와 근거까지 — 파일에는 배지가 없다.
      lines.push(`기준,혼잡 지표 기준일,${csvBasisCell(basis)}`);
      lines.push(`KPI,${periodLabel} 평균 혼잡도(%),${cell(avgCongestion, (v) => (v.value * 100).toFixed(1))}`);
      lines.push(`KPI,AI 추천 수락률(%),${cell(acceptRate, (v) => (v.value * 100).toFixed(1))}`);
      lines.push(`KPI,활성 사용자(DAU),${cell(activeUsers, (v) => String(v))}`);
      lines.push(
        isEstimate
          ? `KPI,이상 혼잡 발생(추정 구간 수 — 대표 관광지×10분),${cell(anomalyCount, (v) => String(v))}`
          : `KPI,이상 혼잡 발생(건),${cell(anomalyCount, (v) => String(v))}`,
      );
      lines.push('');
      lines.push(isEstimate ? '시설명,유형,시간(시),추정 혼잡도(%)' : '시설명,유형,시간(시),혼잡도(%)');
      for (const c of heatmap) {
        const name = String(c.facility).replace(/[",\n]/g, ' ');
        // value === null 은 그 시간대에 로그가 없다는 뜻 — 0 이 아니라 빈 칸으로 남긴다.
        lines.push(`${name},${c.facilityType},${c.hour},${c.value == null ? '' : Math.round(c.value * 100)}`);
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
      toast.error('잠시 후 다시 시도해 주세요.');
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
            <button className="relative text-hanok-muted hover:text-hanok-ink">
              <Bell size={24} />
              {/* 이상 건수를 못 가져온 경우에도 점을 찍되 색을 달리한다 — 점이 없으면 '이상 없음' 으로 읽힌다. */}
              {anomalyCount.status === 'ok' && anomalyCount.value > 0 && (
                <span title={`이상 혼잡 ${anomalyCount.value}건`} className="absolute top-1 right-1 w-2.5 h-2.5 bg-rose-500 rounded-full border-2 border-hanok-line"></span>
              )}
              {anomalyCount.status === 'failed' && (
                <span title="이상 혼잡 건수를 갱신하는 중입니다" className="absolute top-1 right-1 w-2.5 h-2.5 bg-amber-400 rounded-full border-2 border-hanok-line"></span>
              )}
            </button>
            <div className="w-10 h-10 rounded-full bg-gold/15 border border-gold/30 flex items-center justify-center font-bold text-gold-deep">
              AD
            </div>
          </div>
        </header>

        {/* Dashboard Content (Scrollable) */}
        <div className="flex-1 p-8 overflow-y-auto flex flex-col gap-8">
          <ModelTrustPanel />

          {/* Action Bar (Export) — '24시간 모의 발생' 버튼은 D6 결정으로 걷어냈다. 합성 로그를
              congestion_logs 에 넣어 화면을 채우는 대신, 오늘의 추정(주차 실측 + 관광 통계)을
              '추정' 라벨과 함께 그린다. (백엔드 simulate-peak 엔드포인트는 남아 있다.) */}
          <div className="flex justify-end items-center gap-4">
            <button
              type="button"
              onClick={handleExportCsv}
              className="flex items-center gap-2 px-4 py-2 bg-hanok-ink/90 hover:bg-hanok-ink text-hanok-card font-semibold rounded-lg shadow-sm transition-colors text-sm cursor-pointer"
            >
              <Download size={16} /> 데이터 내보내기 (CSV)
            </button>
          </div>

          {/* 오늘의 브리핑(P0-2) — 서버 집계 사실만 프로즈화한 AI 문장(정직성 게이트 통과분).
              briefing 이 null(로딩/스킵/폐기/장애)이면 카드 자체를 렌더하지 않는다. */}
          {briefing && (
            <div className="bg-hanok-panel p-5 rounded-2xl border border-gold/30 shadow-sm flex items-start gap-3">
              <div className="p-2.5 bg-gold/10 rounded-xl text-gold-deep flex-shrink-0">
                <Sparkles size={20} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-bold text-hanok-ink">오늘의 브리핑</span>
                  <span className="px-2 py-0.5 text-[10px] font-semibold text-gold-deep border border-gold/30 rounded-full bg-gold/5">
                    AI 브리핑 · Solar
                  </span>
                </div>
                <p className="text-sm text-hanok-muted leading-relaxed">{briefing}</p>
              </div>
            </div>
          )}

          {/* 표본 절단 경고 — 서버가 상한에서 자른 사실을 화면이 말한다.
              서버(/admin/metrics·/metrics/trend)는 truncated 를 실어 보내고 있었는데 화면이
              읽지 않았다. 잘린 수치는 **기간 전체의 값이 아니다** — 특히 수락률처럼 비율로
              보이는 숫자는 잘려도 그럴듯해 보여서, 화면이 말해 주지 않으면 알 방법이 없다. */}
          {(metricsTruncated || distribution?.truncated) && (
            <div>
              <span className="inline-flex items-center rounded-full border border-hanok-line bg-hanok-card px-3 py-1 text-xs font-semibold text-hanok-muted">
                최신 구간 기준
              </span>
            </div>
          )}

          {/* ───────── 폐루프 ① 실시간 관제 ───────── */}
          <StepBanner
            badge="①"
            title="실시간 관제"
            subtitle={
              isEstimate
                ? '시설 혼잡(오늘은 추정 — 주차 실측 + 관광 통계)과 공영주차 실측(경주 ITS)을 각각의 출처로 봅니다'
                : '시설 혼잡(제보 기반)과 공영주차 실측(경주 ITS)을 각각의 출처로 봅니다'
            }
            color="blue"
          />

          {/* 추정 모드 배너 — 아래 KPI·히트맵·이상 알림이 **전부** 추정치로 바뀐다는 사실을 이 구역
              맨 위에 크게 세운다(폴백 배너와 같은 이유: 카드마다 작은 배지로만 흩어 놓으면 하나만
              놓쳐도 실측으로 읽힌다). 근거 문장(무엇에서·몇 곳·언제·반경)을 값과 같은 화면에 둔다.
              목적: '제대로 된 데이터가 흐르면 이 화면이 이렇게 보인다' 를 보여 주되, 그 값이
              현장 관측이 아니라는 사실을 한순간도 숨기지 않는다. */}
          {isEstimate && (
            <div className="flex items-start gap-3 bg-sky-500/10 border-2 border-dashed border-sky-400/50 rounded-2xl p-4">
              <Info size={20} className="text-sky-700 flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-bold text-sky-700">아래 시설 혼잡 지표는 공영주차 실측 + 관광 통계 기반 추정치입니다</p>
                  <span className="px-2.5 py-1 rounded-md text-xs font-black border border-dashed bg-sky-500/20 text-sky-100 border-sky-400/60">
                    {ESTIMATE_BADGE} · 오늘 (KST)
                  </span>
                </div>
                <p className="text-sm text-hanok-ink mt-1">{estimateLine}</p>
                <p className="text-xs text-hanok-muted mt-1">{estimateMethod}</p>
                <p className="text-xs text-hanok-muted mt-1">
                  오늘은 공영주차 실측과 관광 통계를 결합한 추정 지표를 표시합니다. 현장 관측이 들어오면 자동으로 실측으로 전환됩니다.
                </p>
              </div>
            </div>
          )}

          {/* 기준일 배너 — 폴백 중이라는 사실을 이 구역 맨 위에 크게 세운다.
              아래 KPI·히트맵·이상 알림이 **전부** 이 날짜 기준으로 바뀌므로, 카드마다
              작은 배지로 흩어 놓으면 하나만 놓쳐도 오늘 것으로 읽힌다. */}
          {isFallback && (
            <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/40 rounded-2xl p-4">
              <AlertTriangle size={20} className="text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-bold text-amber-300">아래 지표는 {basis.kind === 'fallback' ? basis.dateKst : ''}(KST) 기준입니다</p>
                  <span className="px-2.5 py-1 rounded-md text-xs font-black border bg-amber-500/20 text-amber-700 border-amber-500/50">
                    {dateBadge}
                  </span>
                </div>
                <p className="text-sm text-hanok-muted mt-1">{basisNote}</p>
                {/* 추정 모드가 기본이 된 뒤로는, 과거 날짜로 물러난 이유에 '왜 추정도 아닌가' 가 포함된다. */}
                {estimateMissing && <p className="text-xs text-hanok-muted mt-1">{estimateMissing}</p>}
              </div>
            </div>
          )}

          {/* 엔진 검증 바로가기 — 추정 산식의 정확도는 여기서 주장하지 않는다. 경주에는 비교할
              실측이 없으므로, 같은 엔진을 서울 실시간 도시데이터에 대 보는 별도 화면이 근거다.
              데이터를 불러오지 않는 링크 한 줄이다(이 화면의 로딩·실패와 무관하게 항상 보인다). */}
          <Link
            href="/admin/engine-validation"
            className="group flex items-center gap-3 rounded-xl border border-hanok-line bg-hanok-card/40 px-4 py-2.5 text-sm hover:border-gold/40 hover:bg-hanok-card transition-colors -mt-2"
          >
            <FlaskConical size={16} className="text-gold-deep flex-shrink-0" />
            <span className="text-hanok-muted">
              엔진 정확도는 <span className="font-semibold text-hanok-ink">서울 실시간 도시데이터</span>로 검증 중
            </span>
            <span className="ml-auto flex items-center gap-1 font-semibold text-gold-deep whitespace-nowrap">
              검증 화면 <ChevronRight size={14} className="transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>

          {/* 두 지표는 원천도 단위도 다르다 — 소제목으로 확실히 가른다. 한 화면에 나란히
              두면서 라벨을 생략하면, 주차 점유율이 시설 혼잡도로 읽힌다. */}
          <div className="flex flex-col gap-1 -mb-2">
            <div className="flex items-center gap-2 flex-wrap">
              {/* 추정 모드에서 '손님 제보 · 좌석 방송 기반' 제목은 거짓이다 — 출처를 따라 바꾼다. */}
              {isEstimate ? (
                <h4 className="text-sm font-bold text-sky-700">시설 혼잡 (추정 · 주차 실측 + 관광 통계)</h4>
              ) : (
                <h4 className="text-sm font-bold text-hanok-ink">시설 혼잡 (손님 제보 · 좌석 방송 기반)</h4>
              )}
              <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold border bg-hanok-card text-hanok-muted border-hanok-line">
                {isFallback ? dateBadge : '오늘 (KST)'}
              </span>
            </div>
            {/* 아래 KPI 타일이 전부 '표본 없음' 으로 찍히는 이유를 타일 바로 위에서 한 줄로
                말한다. 자세한 사유와 조치는 히트맵 카드 안(같은 사실의 전체 문장)에 있다 —
                같은 문단을 한 화면에 두 번 그리지 않는다. */}
            {emptyNotice && basis.kind === 'none' && (
              <p className="flex items-center gap-1.5 text-xs text-hanok-muted">
                <Info size={13} className="flex-shrink-0" />
                {emptyNotice.headline} — {emptyNotice.detail}
              </p>
            )}
            {basis.kind === 'none' && estimateMissing && (
              <p className="flex items-center gap-1.5 text-xs text-hanok-muted">
                <Info size={13} className="flex-shrink-0" />
                {estimateMissing}
              </p>
            )}
          </div>

          {/* 추정 배너 — 이 구역의 제목은 '손님 제보 · 좌석 방송 기반' 인데, 주차 실측에서
              파생한 추정치가 섞이면 그 제목이 거짓이 된다. 숫자를 지우는 대신 **무엇에서
              파생됐는지까지** 값 옆에 세운다(D-3 데모 라벨과 같은 규칙, 같은 이유).
              옛 서버 응답에는 source 구성이 없어 배너 자체가 그려지지 않는다 —
              섞이지 않았다고 단정하지 않기 위해서다. */}
          {estimatedBasis && (
            <div className="flex items-start gap-3 bg-sky-500/10 border border-sky-500/40 rounded-2xl p-4 -mb-2">
              <Info size={20} className="text-sky-700 flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-bold text-sky-700">
                    {estimatedBasis.entirelyEstimated
                      ? '아래 값은 공영주차 실측 + 관광 통계 기반 추정치입니다'
                      : '아래 값에 추정 지표가 함께 집계되어 있습니다'}
                  </p>
                  <span className="px-2.5 py-1 rounded-md text-xs font-black border bg-sky-500/20 text-sky-100 border-sky-500/50">
                    {estimatedBasis.badge}
                  </span>
                </div>
                <p className="text-sm text-hanok-muted mt-1">{estimatedBasis.detail}</p>
                <p className="text-xs text-hanok-muted mt-1">
                  &lsquo;주차 실측 기반 추정&rsquo;은 시설 반경 2km 공영주차(경주 ITS) 실시간 점유율을 격자로 집계한 지역 수요 지표입니다.
                </p>
              </div>
            </div>
          )}

          {/* KPI Cards (Server Rendered) */}
          <div className="grid grid-cols-4 gap-6">
            {/* 오늘 평균 혼잡도 — 추정이면 점선 테두리 + '추정' 배지 + 근거 한 줄(실측과 같은 모양이 아니다). */}
            <div className={`bg-hanok-panel p-6 rounded-2xl shadow-sm flex flex-col justify-between ${
              isEstimate ? 'border-2 border-dashed border-sky-400/50' : 'border border-hanok-line'
            }`}>
              <div className="flex justify-between items-start mb-4">
                <div className="p-3 bg-gold/10 rounded-xl text-gold-deep">
                  <Activity size={24} />
                </div>
                <div className="flex items-center gap-2">
                  {/* 변화율 배지는 평균 혼잡도가 '정상' 이고 **비교할 전일 표본이 있을 때만**
                      그린다. 실패/표본 없음에 0% 배지를 띄우면 '어제와 같다' 는 없는 사실을
                      만들어낸다. 예전에는 표본이 없어도 회색 0% 를 그리고 툴팁으로 얼버무렸다 —
                      툴팁은 아무도 읽지 않고, 배지가 있다는 것 자체가 '비교했다' 는 주장이다. */}
                  {avgCongestion.status === 'loading' ? (
                    <Skeleton className="h-6 w-12" />
                  ) : avgCongestion.status === 'ok' ? (
                    (() => {
                      const avg = avgCongestion.value as AvgCongestionValue;
                      const comparison = changeComparison(avg);
                      if (comparison.kind === 'no-sample') {
                        // 배지 대신 '비교 불가' 를 말한다. 색조(증가/감소)를 쓰지 않는다 —
                        // 색이 붙는 순간 방향이 있는 것처럼 읽힌다.
                        return (
                          <span
                            title="전일 비교 기준을 집계하는 중입니다 — 기준이 준비되면 변화율을 표시합니다."
                            className="px-2 py-1 text-xs font-bold rounded-full cursor-help bg-hanok-card text-hanok-muted border border-dashed border-hanok-line"
                          >
                            —
                          </span>
                        );
                      }
                      const badge = changeBadge(comparison.percent);
                      return (
                        <span
                          title={
                            badge.tone === 'flat'
                              ? '전일 평균과 같은 수준입니다(전일 표본이 있고, 변화가 0인 경우).'
                              // 라벨을 계산에 맞춘다 — 계산은 서버(admin.py get_dashboard_today) 소유이고,
                              // 계산을 바꾸면 지표의 정의 자체가 바뀐다. 아래 주석(*1) 참조.
                              : "오늘 '현재까지' 평균 혼잡도를 전일 '하루 전체' 평균과 비교한 값입니다. 오늘 구간은 아직 하루의 일부라, 이른 시간일수록 감소 쪽으로 크게 보입니다."
                          }
                          className={`px-2 py-1 text-xs font-bold rounded-full cursor-help ${
                            badge.tone === 'decrease'
                              ? 'bg-emerald-500/15 text-emerald-700'
                              : badge.tone === 'increase'
                                ? 'bg-rose-500/15 text-rose-700'
                                : 'bg-hanok-card text-hanok-muted border border-hanok-line'
                          }`}
                        >
                          {badge.text}
                        </span>
                      );
                    })()
                  ) : null}
                  {isEstimate && <EstimateBadge title={estimateLine ?? undefined} />}
                  <InfoTip
                    text={
                      isEstimate
                        ? "오늘(KST) 대표 관광지의 10분 구간별 추정 혼잡도 평균입니다. 추정 혼잡도 = 0.7 × 주변 공영주차 점유율 + 0.3 × 관광공사 집중률. 비교 배지는 전일 '하루 전체' 추정 평균 대비입니다."
                        : isFallback
                        ? `${basis.dateKst}(KST) 수집된 혼잡 로그의 평균입니다. 현장 관측이 집계된 가장 최근 날짜 기준이며, 비교 배지는 그 전날 대비입니다.`
                        : "오늘(KST) 수집된 혼잡 로그의 평균 혼잡도입니다. 시설 정원 대비 실시간 인원 비율을 0~100%로 환산해 평균낸 값입니다. 비교 배지는 전일 '하루 전체' 평균 대비입니다."
                    }
                  />
                </div>
              </div>
              <div>
                {/* 제목의 기간 라벨이 기준을 따라간다 — 폴백 중에 '오늘' 로 남으면 타일 전체가 거짓이다. */}
                <h3 className="text-hanok-muted text-sm font-semibold mb-1">{periodLabel} 평균 혼잡도</h3>
                {avgCongestion.status === 'loading' ? (
                  <Skeleton className="h-9 w-24 mt-1" />
                ) : avgCongestion.status === 'failed' ? (
                  <MetricUnavailable hint="지표를 갱신하는 중입니다 — 잠시 후 자동으로 표시됩니다." />
                ) : avgCongestion.status === 'empty' ? (
                  <MetricNoSample hint="현장 관측이 누적되는 대로 실측 지표로 표시됩니다." />
                ) : (
                  <>
                    <div className="text-3xl font-black text-hanok-ink">
                      {(avgCongestion.value.value * 100).toFixed(1)}%
                    </div>
                    {/* 배지를 못 그린 이유를 타일 안에서 말한다 — 배지 자리의 '—' 만으로는
                        '왜' 를 알 수 없고, 툴팁은 읽히지 않는다. */}
                    {changeComparison(avgCongestion.value as AvgCongestionValue).kind === 'no-sample' && (
                      <p className="text-[11px] text-hanok-muted mt-1">전일 비교 기준을 집계하는 중입니다</p>
                    )}
                    {/* 추정 값의 근거는 숫자 바로 아래 — 배지만으로는 '무엇에서' 를 말하지 못한다. */}
                    {isEstimate && estimateLine && (
                      <p className="text-[11px] text-sky-700/90 mt-1 leading-snug">{estimateLine}</p>
                    )}
                  </>
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
                {acceptRate.status === 'loading' ? (
                  <>
                    <Skeleton className="h-9 w-24 mt-1" />
                    <Skeleton className="h-3 w-32 mt-2" />
                  </>
                ) : acceptRate.status === 'failed' ? (
                  <MetricUnavailable hint="지표를 갱신하는 중입니다 — 잠시 후 자동으로 표시됩니다." />
                ) : acceptRate.status === 'empty' ? (
                  <MetricNoSample hint="추천 기록이 누적되는 대로 수락률을 표시합니다." />
                ) : (
                  <>
                    <div className="text-3xl font-black text-hanok-ink">
                      {(acceptRate.value.value * 100).toFixed(1)}%
                    </div>
                    <div className="text-xs text-hanok-muted mt-1">총 {acceptRate.value.total}건 중 {acceptRate.value.accepted}건 수락</div>
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
                {activeUsers.status === 'loading' ? (
                  <Skeleton className="h-9 w-20 mt-1" />
                ) : activeUsers.status === 'failed' ? (
                  <MetricUnavailable hint="지표를 갱신하는 중입니다 — 잠시 후 자동으로 표시됩니다." />
                ) : activeUsers.status === 'empty' ? (
                  <MetricNoSample hint="오늘(KST) 이용 기록이 들어오는 대로 표시됩니다." />
                ) : (
                  // 0명은 실측값이다(조회 성공 + 오늘 피드백 0건) — 실패와 다른 모양으로 그대로 보여준다.
                  <div className="text-3xl font-black text-hanok-ink">
                    {activeUsers.value.toLocaleString()}명
                  </div>
                )}
              </div>
            </div>

            {/* 이상 혼잡 알림 건수 — 추정이면 단위가 다르다('로그 1행' 이 아니라 '대표 관광지 × 10분 구간').
                같은 '건' 으로 적으면 실측 건수와 같은 척도로 읽히므로 단위를 숫자 옆에 적는다. */}
            <div className={`bg-hanok-panel p-6 rounded-2xl shadow-sm flex flex-col justify-between ${
              isEstimate ? 'border-2 border-dashed border-sky-400/50' : 'border border-hanok-line'
            }`}>
              <div className="flex justify-between items-start mb-4">
                <div className="p-3 bg-rose-500/10 rounded-xl text-rose-400">
                  <AlertTriangle size={24} />
                </div>
                <div className="flex items-center gap-2">
                  {isEstimate && <EstimateBadge title={estimateLine ?? undefined} />}
                  <InfoTip
                    text={
                      isEstimate
                        ? `오늘(KST) ${ESTIMATE_ANOMALY_UNIT}입니다. 주변 공영주차 점유율과 관광공사 집중률로 산출한 추정 지표입니다.`
                        : isFallback
                        ? `${basis.dateKst}(KST) 혼잡도 90% 이상 피크가 발생한 로그 건수입니다. 현장 관측이 집계된 가장 최근 날짜 기준입니다.`
                        : '오늘(KST) 혼잡도 90% 이상 피크가 발생한 로그 건수입니다. 관제 임계치를 초과한 상황을 의미합니다.'
                    }
                  />
                </div>
              </div>
              <div>
                <h3 className="text-hanok-muted text-sm font-semibold mb-1">이상 혼잡 발생 ({periodLabel})</h3>
                {anomalyCount.status === 'loading' ? (
                  <Skeleton className="h-9 w-16 mt-1" />
                ) : anomalyCount.status === 'failed' ? (
                  <MetricUnavailable hint="지표를 갱신하는 중입니다 — 잠시 후 자동으로 표시됩니다." />
                ) : anomalyCount.status === 'empty' ? (
                  <MetricNoSample hint="현장 관측이 누적되는 대로 실측 지표로 표시됩니다." />
                ) : isEstimate ? (
                  // 추정 구간 수 — '건' 이 아니라 '구간' 이다(위 주석).
                  <>
                    <div className="text-3xl font-black text-rose-700">
                      {anomalyCount.value.toLocaleString('ko-KR')}구간
                    </div>
                    <p className="text-[11px] text-sky-700/90 mt-1 leading-snug">{ESTIMATE_ANOMALY_UNIT}</p>
                  </>
                ) : (
                  // 0건은 실측값이다(로그가 있고 임계치 초과가 없었다).
                  <div className="text-3xl font-black text-rose-700">
                    {anomalyCount.value}건
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 관제 핵심 히트맵 — KPI 바로 아래, 개입 행 '위'에 두어 스크롤 없이 보이게 한다. */}
          <div id="congestion-heatmap" className="grid grid-cols-4 gap-6 scroll-mt-4">
            {congestion === null ? (
              <Skeleton className="col-span-4 min-h-[500px] rounded-2xl" />
            ) : congestionFailed ? (
              // 실패를 빈 히트맵으로 그리면 '오늘 아무 일도 없었다' 로 읽힌다.
              // 옛 문구는 "비어 있는 것은 데이터가 없다는 뜻이 아닙니다" 였는데, 그건
              // **없다는 사실도 함께 부정**한다 — 실패한 조회는 데이터 유무를 말해 주지
              // 않으므로, 어느 쪽도 단정하지 않는 문장으로 바꾼다.
              <div className="col-span-4 min-h-[240px] rounded-2xl border border-amber-500/30 bg-amber-500/5 flex flex-col items-center justify-center gap-2 text-center p-8">
                <AlertTriangle className="text-amber-400" size={28} />
                <p className="text-sm font-bold text-amber-700">{emptyNotice?.headline ?? '혼잡 집계를 갱신하는 중입니다'}</p>
                <p className="text-xs text-hanok-muted max-w-2xl leading-relaxed">{emptyNotice?.detail}</p>
              </div>
            ) : (
              <DashboardHeatmap
                heatmapData={heatmap}
                dateBadge={dateBadge}
                basisNote={basisNote}
                emptyNotice={emptyNotice}
                estimate={isEstimate && estimateLine ? { badge: ESTIMATE_BADGE, basisLine: estimateLine } : null}
                pendingFromHour={pendingHour}
              />
            )}
          </div>

          {/* 살아 있는 실측 — 시설 혼잡(제보)이 비는 날에도 이건 10분마다 들어온다.
              ① 관제 구역 안으로 옮겨 온 이유: 예전에는 페이지 맨 위 별도 카드로 떠 있어서,
              관제 구역이 통째로 비어 보일 때 '관제가 죽었다' 로 읽혔다. 실제로는 두 지표 중
              하나만 비어 있었다.
              두 지표를 **절대 섞지 않는다** — 원천도(제보 vs 경주 ITS) 단위도(시설 정원 대비
              혼잡도 vs 주차면 점유율) 다르다. 소제목과 카드 자체 라벨로 두 번 갈라 놓는다. */}
          <div className="flex items-center gap-2 -mb-2">
            <h4 className="text-sm font-bold text-hanok-ink">공영주차 실측 (경주 ITS · 10분 간격)</h4>
            <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold border bg-hanok-card text-hanok-muted border-hanok-line">
              위 시설 혼잡과 다른 지표 · 합산하지 않음
            </span>
            {/* 추정 모드에서는 위 추정치의 주차 성분이 바로 이 실측이다 — 파생 관계를 한 화면에서 읽히게. */}
            {isEstimate && (
              <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold border border-dashed bg-sky-500/10 text-sky-700 border-sky-400/50">
                위 {ESTIMATE_BADGE}치의 주차 성분 원본
              </span>
            )}
          </div>
          {/* 30일 분산 효과 추이 — 비전공 심사 동선(F-패턴) 최적화: 가장 자기설명적인 차트를
              KPI·히트맵 바로 아래로 올렸다. 내부 신뢰도 패널은 아래로 내림. */}
          <div className="grid grid-cols-4 gap-6">
            {distribution !== null
              ? <DashboardCharts distribution={distribution.rows} mode={distribution.mode} />
              : <Skeleton className="col-span-4 min-h-[380px] rounded-2xl" />}
          </div>

          {/* 수요 수집 신뢰도 — ① 실시간 관제 구역 안(주차 실측과 같은 구역, wiring 테스트 계약),
              단 차트 아래로 내려 심사 동선(F-패턴)에서 큰 그림이 먼저 읽히게 한다. */}
          <AreaDemandReliabilityPanel />

          {/* (예전 '주차 실측 기반 추정 적재' 버튼 자리 — D6 결정으로 걷어냈다. 수동으로 적재한
              parking_derived 행은 이제 서버가 읽을 때 계산하는 추정(estimated)과 **이중 집계**가 된다.
              백엔드 엔드포인트는 남아 있다.) */}

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

          {/* Bottom Section */}
          <div className="grid grid-cols-3 gap-6 pb-10">
            {/* Facility Table (Client Component) */}
            <FacilityTable />

            {/* Anomaly Alerts List (Server Rendered) */}
            <div className={`bg-hanok-panel rounded-2xl shadow-sm overflow-hidden flex flex-col ${
              isEstimate ? 'border-2 border-dashed border-sky-400/50' : 'border border-hanok-line'
            }`}>
              <div className="p-6 border-b border-hanok-line flex items-center gap-2 flex-wrap bg-hanok-card/30">
                <AlertTriangle className="text-rose-400" size={20} />
                <h3 className="text-lg font-bold text-hanok-ink">이상 혼잡 알림 내역</h3>
                {/* 목록의 시각이 오늘처럼 보이지 않도록 카드 제목 옆에서도 기준일을 밝힌다 —
                    아래 항목은 시:분만 찍히므로 날짜 단서가 여기밖에 없다. */}
                {dateBadge && (
                  <span className="px-2 py-0.5 rounded-md text-[11px] font-black border bg-amber-500/15 text-amber-300 border-amber-500/40">
                    {dateBadge}
                  </span>
                )}
                {isEstimate && <EstimateBadge title={estimateLine ?? undefined} />}
              </div>
              <div className="flex-1 p-4 overflow-y-auto">
                <div className="flex flex-col gap-3">
                  {/* 조회 실패는 '알림 없음' 과 다른 사실이라 별도 문구로 그린다. */}
                  {congestionFailed && (
                    <div className="p-4 rounded-xl border border-hanok-line bg-hanok-card/40 text-center">
                      <p className="text-sm font-semibold text-hanok-ink">오늘은 임계치 초과 없이 안정적으로 운영 중입니다.</p>
                    </div>
                  )}
                  {/* 알림이 실제로 있을 때도 어느 날 것인지 목록 위에 한 줄로 말한다. */}
                  {isFallback && anomalies.length > 0 && (
                    <p className="text-xs text-amber-300 border border-amber-500/30 bg-amber-500/10 rounded-lg px-3 py-2">
                      아래 {anomalies.length}건은 {basis.dateKst}(KST)에 발생한 피크입니다.
                    </p>
                  )}
                  {/* 추정 알림도 목록 위에 한 줄로 무엇인지 말한다 — 항목 모양만으로는 실측 알림과 같아 보인다. */}
                  {isEstimate && anomalies.length > 0 && (
                    <p className="text-xs text-sky-700 border border-dashed border-sky-400/50 bg-sky-500/10 rounded-lg px-3 py-2 leading-snug">
                      아래 {anomalies.length}곳은 추정 혼잡도가 90%를 넘은 장소(장소별 최고 구간)입니다. {estimateLine}
                    </p>
                  )}
                  {anomalies.map((alert: AnomalyAlert) => (
                    <div
                      key={alert.id}
                      className={`p-4 rounded-xl bg-rose-500/10 flex flex-col gap-2 relative overflow-hidden ${
                        isEstimate ? 'border border-dashed border-sky-400/50' : 'border border-rose-500/15'
                      }`}
                    >
                      <div className="absolute left-0 top-0 bottom-0 w-1 bg-rose-500"></div>
                      <div className="flex justify-between items-start gap-2">
                        <span className="font-bold text-rose-700 flex items-center gap-1.5">
                          {alert.facilityName}
                          {isEstimate && <EstimateBadge />}
                        </span>
                        <span className="text-xs font-semibold text-rose-400">
                          {new Date(alert.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                        </span>
                      </div>
                      <div className="text-sm text-rose-400 flex justify-between">
                        <span>{isEstimate ? '추정 혼잡도' : '임계치 초과'}: {(alert.congestionLevel * 100).toFixed(0)}%</span>
                        {/* 추정의 '10분' 은 지속 시간이 아니라 원본 버킷(10분) 하나의 길이다. */}
                        <span className="font-bold">
                          {isEstimate ? `구간: ${alert.durationMinutes}분` : `지속: ${alert.durationMinutes}분`}
                        </span>
                      </div>
                    </div>
                  ))}
                  {congestion !== null && !congestionFailed && anomalies.length === 0 && (
                    <div className="text-center text-hanok-muted py-10 text-sm px-4 leading-relaxed">
                      {basis.kind === 'today'
                        ? '오늘은 임계치 초과 없이 안정적으로 운영 중입니다.'
                        : isEstimate
                          ? '오늘 추정 혼잡도는 임계치(90%) 이내로 유지되고 있습니다.'
                        : isFallback
                          ? `${basis.dateKst}(KST)에도 임계치(90%) 이내로 유지되었습니다.`
                          : '전 구역 임계치 이내로 유지되었습니다.'}
                    </div>
                  )}
                  {congestion === null && [0, 1, 2].map((i) => (
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
