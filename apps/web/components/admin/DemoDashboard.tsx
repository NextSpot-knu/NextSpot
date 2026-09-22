'use client';

// 관제 대시보드 데모(/admin/dashboard?demo=1) — 로그인도 역할 검사도 없이 보는 읽기 전용 화면.
//
// 왜 실제 대시보드를 그대로 쓰지 않는가: 실제 화면의 카드들(ModelTrustPanel · CouponPolicyPanel ·
// ImpactWidget · FacilityTable · AreaDemandReliabilityPanel)은 **각자 관리자 API 를 직접 호출한다**.
// 데모에는 세션이 없으므로 그 카드들은 전부 401/403 으로 무너진다. 그래서 여기서는
//   · 값을 props 로만 받는 순수 컴포넌트(DashboardCharts · DashboardHeatmap · AdminSidebar)는 그대로 쓰고,
//   · 자체 조회를 하는 카드 자리에는 같은 사실을 말하는 고정값 카드를 세운다.
//
// ⚠️ 이 파일에는 fetch·supabase·adminApi 호출이 하나도 없다(그게 이 화면의 계약이다).
//    쓰기처럼 보이는 버튼(정책 조정·CSV)은 눌리되 "데모에서는 저장되지 않아요" 토스트만 띄운다.

import Link from 'next/link';
import { Activity, AlertTriangle, ArrowRight, Bell, Compass, Download, LogIn, Sparkles, Store, Timer, TrendingUp } from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AdminSidebar } from '@/components/AdminSidebar';
import { DashboardCharts, DashboardHeatmap } from '@/components/admin/DashboardCharts';
import { DemoBadge, useDemoToast } from '@/components/DemoBadge';
import { useT } from '@/lib/i18n/I18nProvider';
import {
  DEMO_ADMIN_ALTERNATIVES,
  DEMO_ADMIN_HOTSPOT_TREND,
  DEMO_ADMIN_KPI,
  DEMO_ADMIN_STORES,
  demoAdminAnomalies,
  demoAdminDistribution,
  demoAdminHeatmap,
} from '@/lib/demoFixtures';

// recharts 는 stroke 를 SVG 속성으로 내보내므로 토큰(var)이 아니라 값이 필요하다
// (components/admin/DashboardCharts.tsx 가 같은 이유로 같은 방식으로 미러링한다).
const HOTSPOT_COLORS: Record<string, string> = {
  황리단길: '#c1553b',
  대릉원: '#c19a3e',
  첨성대: '#3e7c6a',
  교촌마을: '#2f6f9f',
};
const HANOK_GRID = '#d8cab2';
const HANOK_AXIS = '#63533f';

// 좌석 상태는 화면 문구라 i18n 을 탄다(고정값은 한국어 키를 들고 있을 뿐이다).
const SEAT_LABEL_KEY: Record<'여유' | '보통' | '만석', string> = {
  여유: 'demo.seatLow',
  보통: 'demo.seatMid',
  만석: 'demo.seatFull',
};

export function AdminDemoDashboard() {
  const t = useT();
  const demoToast = useDemoToast();
  const heatmap = demoAdminHeatmap();
  const anomalies = demoAdminAnomalies();
  const distribution = demoAdminDistribution();

  return (
    // 모바일(심사 링크가 바로 여는 폭)에서는 사이드바가 접히고 문서 스크롤을 쓴다.
    // 데스크톱(lg~)은 기존 관제 레이아웃 그대로 — 화면 높이 고정 + 본문만 스크롤.
    <div className="flex min-h-screen bg-hanok font-sans text-hanok-ink lg:h-screen lg:overflow-hidden">
      <DemoBadge />
      <AdminSidebar demo />

      <main className="flex min-w-0 flex-1 flex-col lg:h-full lg:overflow-hidden">
        {/* pt-11 은 고정 데모 배지가 앉는 자리다(사장님 콘솔과 같은 값). 데스크톱은 기존 pt-8 유지. */}
        <header className="sticky top-0 z-20 flex flex-shrink-0 flex-col gap-2 border-b border-hanok-line bg-hanok-panel px-4 pb-3 pt-11 lg:static lg:h-20 lg:flex-row lg:items-center lg:justify-between lg:gap-0 lg:px-8 lg:pb-0 lg:pt-8">
          <div className="flex min-w-0 items-center gap-2 lg:gap-3">
            <h2 className="truncate text-base font-bold text-hanok-ink lg:text-xl">경주 관광 혼잡 종합 대시보드</h2>
            <span className="flex-shrink-0 rounded-full border border-gold/40 bg-gold/15 px-2.5 py-0.5 text-[11px] font-black text-gold-deep">
              {t('demo.badgeShort')}
            </span>
          </div>
          {/* 사이드바가 접히는 폭에서도 나가는 길 두 개는 남는다 — 관광객 앱 · 실제 계정 로그인. */}
          <div className="flex flex-wrap items-center gap-2 lg:hidden">
            <Link
              href="/main"
              className="flex items-center gap-1.5 rounded-lg border border-hanok-line bg-hanok-card px-2.5 py-1.5 text-[12px] font-semibold text-hanok-muted transition-colors hover:text-hanok-ink"
            >
              <Compass size={14} aria-hidden="true" />
              관광객 앱으로
            </Link>
            <Link
              href="/admin/login"
              className="flex items-center gap-1.5 rounded-lg border border-gold/40 bg-gold/10 px-2.5 py-1.5 text-[12px] font-semibold text-gold-deep transition-colors hover:bg-gold/20"
            >
              <LogIn size={14} aria-hidden="true" />
              {t('demo.realLogin')}
            </Link>
          </div>
          <div className="hidden items-center gap-6 lg:flex">
            <button type="button" onClick={demoToast} className="relative text-hanok-muted hover:text-hanok-ink" aria-label={t('demo.anomalyTitle')}>
              <Bell size={24} />
              <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full border-2 border-hanok-line bg-rose-500" />
            </button>
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-gold/30 bg-gold/15 font-bold text-gold-deep">
              AD
            </div>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-6 p-4 lg:gap-8 lg:overflow-y-auto lg:p-8">
          {/* 내보내기 — 데모에서는 파일을 만들지 않는다(무엇이 나갔는지 추적되지 않는 파일을 만들지 않기 위해). */}
          <div className="flex items-center justify-end gap-4">
            <button
              type="button"
              onClick={demoToast}
              className="flex cursor-pointer items-center gap-2 rounded-lg bg-hanok-ink/90 px-4 py-2 text-sm font-semibold text-hanok-card shadow-sm transition-colors hover:bg-hanok-ink"
            >
              <Download size={16} /> 데이터 내보내기 (CSV)
            </button>
          </div>

          {/* 정책 브리핑 */}
          <div className="flex items-start gap-3 rounded-2xl border border-gold/30 bg-hanok-panel p-5 shadow-sm">
            <div className="flex-shrink-0 rounded-xl bg-gold/10 p-2.5 text-gold-deep">
              <Sparkles size={20} />
            </div>
            <div className="min-w-0">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-sm font-bold text-hanok-ink">{t('demo.briefingTitle')}</span>
                <span className="rounded-full border border-gold/30 bg-gold/5 px-2 py-0.5 text-[10px] font-semibold text-gold-deep">
                  {t('demo.briefingBadge')}
                </span>
              </div>
              <p className="text-sm leading-relaxed text-hanok-muted">{t('demo.adminBriefingText')}</p>
            </div>
          </div>

          {/* KPI 4종 */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:gap-6 xl:grid-cols-4">
            <KpiTile
              icon={<ArrowRight size={24} />}
              tone="gold"
              label={t('demo.kpiDispersals')}
              value={`${DEMO_ADMIN_KPI.dispersals.toLocaleString()}${t('demo.unitCases')}`}
              note={t('demo.kpiDispersalsNote')}
            />
            <KpiTile
              icon={<Timer size={24} />}
              tone="jade"
              label={t('demo.kpiSavedWait')}
              value={`${DEMO_ADMIN_KPI.savedWaitMinutes.toLocaleString()}${t('demo.unitMinutes')}`}
              note={t('demo.kpiSavedWaitNote')}
            />
            <KpiTile
              icon={<Store size={24} />}
              tone="emerald"
              label={t('demo.kpiStores')}
              value={`${DEMO_ADMIN_KPI.participatingStores}${t('demo.unitStores')}`}
              note={t('demo.kpiStoresNote')}
            />
            <KpiTile
              icon={<TrendingUp size={24} />}
              tone="rose"
              label={t('demo.kpiConversion')}
              value={`${(DEMO_ADMIN_KPI.alternativeConversion * 100).toFixed(1)}%`}
              note={t('demo.kpiConversionNote')}
            />
          </div>

          {/* ① 실시간 관제 */}
          <StepBanner badge="①" title="실시간 관제" subtitle={t('demo.step1Sub')} tone="gold" />

          <div className="rounded-2xl border border-hanok-line bg-hanok-panel p-4 shadow-sm lg:p-6">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Activity size={18} className="text-gold-deep" />
              <h3 className="text-base font-bold text-hanok-ink">{t('demo.hotspotTrendTitle')}</h3>
              <span className="rounded-md border border-hanok-line bg-hanok-card px-2 py-0.5 text-[11px] font-semibold text-hanok-muted">
                {t('demo.hotspotTrendNote')}
              </span>
            </div>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={DEMO_ADMIN_HOTSPOT_TREND} margin={{ top: 5, right: 20, bottom: 0, left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={HANOK_GRID} />
                  <XAxis dataKey="hour" axisLine={false} tickLine={false} tick={{ fill: HANOK_AXIS, fontSize: 12 }} />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: HANOK_AXIS, fontSize: 12 }}
                    domain={[0, 1]}
                    tickFormatter={(v) => `${Math.round(Number(v) * 100)}%`}
                    width={48}
                  />
                  <Tooltip
                    formatter={(value: unknown) => `${(Number(value) * 100).toFixed(0)}%`}
                    contentStyle={{ borderRadius: 10, border: `1px solid ${HANOK_GRID}`, fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, color: HANOK_AXIS }} />
                  {/* 관제 임계치(90%) — 선 하나로 '언제 개입해야 하는가' 가 읽힌다. */}
                  <ReferenceLine y={0.9} stroke="#c1553b" strokeDasharray="5 4" />
                  {Object.keys(HOTSPOT_COLORS).map((key) => (
                    <Line
                      key={key}
                      type="monotone"
                      dataKey={key}
                      stroke={HOTSPOT_COLORS[key]}
                      strokeWidth={2.5}
                      dot={{ r: 2 }}
                      activeDot={{ r: 5 }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 히트맵 — 실제 대시보드와 같은 컴포넌트, 값만 고정값이다.
              grid-cols-4 를 유지하는 이유: 자식이 col-span-4 라서(그 파일은 여기 소유가 아니다)
              열을 줄이면 암시적 열이 생겨 폭이 터진다. 한 칸짜리 span-4 는 어느 폭에서도 100% 다. */}
          <div className="grid grid-cols-4 gap-4 lg:gap-6">
            <DashboardHeatmap heatmapData={heatmap} dateBadge={t('demo.badgeShort')} />
          </div>

          {/* ② 정책 개입 */}
          <StepBanner badge="②" title="정책 개입" subtitle={t('demo.step2Sub')} tone="amber" />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
            {/* 대안 전환율 */}
            <div className="flex flex-col rounded-2xl border border-hanok-line bg-hanok-panel shadow-sm lg:col-span-2">
              <div className="flex flex-wrap items-center gap-2 border-b border-hanok-line bg-hanok-card/30 p-4 lg:p-6">
                <h3 className="text-lg font-bold text-hanok-ink">{t('demo.alternativesTitle')}</h3>
                <span className="text-xs text-hanok-muted">{t('demo.alternativesNote')}</span>
              </div>
              <div className="overflow-x-auto p-4">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold text-hanok-muted">
                      <th className="px-3 py-2">{t('demo.altFrom')}</th>
                      <th className="px-3 py-2">{t('demo.altTo')}</th>
                      <th className="px-3 py-2 text-right">{t('demo.altOffered')}</th>
                      <th className="px-3 py-2 text-right">{t('demo.altMoved')}</th>
                      <th className="px-3 py-2 text-right">{t('demo.altRate')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DEMO_ADMIN_ALTERNATIVES.map((row) => {
                      const rate = row.moved / row.offered;
                      return (
                        <tr key={row.from} className="border-t border-hanok-line/70">
                          <td className="whitespace-nowrap px-3 py-3 font-semibold text-hanok-ink">{row.from}</td>
                          <td className="whitespace-nowrap px-3 py-3 text-hanok-muted">{row.to}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-hanok-muted">{row.offered.toLocaleString()}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-hanok-muted">{row.moved.toLocaleString()}</td>
                          <td className="px-3 py-3 text-right">
                            <span className="inline-flex items-center gap-2">
                              <span className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-hanok-line sm:block">
                                <span className="block h-full rounded-full bg-gold" style={{ width: `${Math.round(rate * 100)}%` }} />
                              </span>
                              <span className="font-bold tabular-nums text-hanok-ink">{(rate * 100).toFixed(1)}%</span>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-hanok-line p-4">
                <button
                  type="button"
                  onClick={demoToast}
                  className="w-full rounded-xl bg-gradient-to-r from-gold to-terracotta py-2.5 text-sm font-bold text-white transition-opacity hover:opacity-90"
                >
                  {t('demo.adjustPolicy')}
                </button>
              </div>
            </div>

            {/* 참여 점포 */}
            <div className="flex flex-col rounded-2xl border border-hanok-line bg-hanok-panel shadow-sm">
              <div className="flex items-center gap-2 border-b border-hanok-line bg-hanok-card/30 p-4 lg:p-6">
                <Store size={18} className="text-gold-deep" />
                <h3 className="text-lg font-bold text-hanok-ink">{t('demo.storesTitle')}</h3>
              </div>
              <div className="flex flex-col gap-2 p-4">
                {DEMO_ADMIN_STORES.map((store) => (
                  <div key={store.name} className="flex items-center justify-between gap-2 rounded-xl border border-hanok-line bg-hanok-card/40 px-3.5 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-hanok-ink">{store.name}</p>
                      <p className="text-[11px] text-hanok-muted">{store.area}</p>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-1.5">
                      <span
                        className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${
                          store.timesale
                            ? 'border border-gold/40 bg-gold/15 text-gold-deep'
                            : 'border border-hanok-line bg-hanok-card text-hanok-muted'
                        }`}
                      >
                        {store.timesale ?? t('demo.storeNone')}
                      </span>
                      <span
                        className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${
                          store.seat === '여유'
                            ? 'bg-emerald-500/15 text-emerald-700'
                            : store.seat === '보통'
                              ? 'bg-amber-500/15 text-amber-800'
                              : 'bg-rose-500/15 text-rose-700'
                        }`}
                      >
                        {t(SEAT_LABEL_KEY[store.seat])}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ③ 분산 효과 — 실제 대시보드와 같은 차트 컴포넌트에 고정값을 넣는다. */}
          <StepBanner badge="③" title="분산 효과" subtitle={t('demo.step3Sub')} tone="emerald" />
          {/* 히트맵과 같은 이유로 grid-cols-4 유지(자식이 col-span-4). */}
          <div className="grid grid-cols-4 gap-4 lg:gap-6">
            <DashboardCharts distribution={distribution} mode="demo" />
          </div>

          {/* 이상 혼잡 알림 */}
          <div className="pb-10">
            <div className="flex flex-col overflow-hidden rounded-2xl border border-hanok-line bg-hanok-panel shadow-sm">
              <div className="flex flex-wrap items-center gap-2 border-b border-hanok-line bg-hanok-card/30 p-4 lg:p-6">
                <AlertTriangle className="text-rose-700" size={20} />
                <h3 className="text-lg font-bold text-hanok-ink">{t('demo.anomalyTitle')}</h3>
                <span className="rounded-md border border-gold/40 bg-gold/15 px-2 py-0.5 text-[11px] font-black text-gold-deep">
                  {t('demo.badgeShort')}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
                {anomalies.map((alert) => (
                  <div key={alert.id} className="relative flex flex-col gap-2 overflow-hidden rounded-xl border border-rose-500/15 bg-rose-500/10 p-4">
                    <div className="absolute bottom-0 left-0 top-0 w-1 bg-rose-500" />
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-bold text-rose-700">{alert.facilityName}</span>
                      <span className="text-xs font-semibold text-rose-700">
                        {new Date(alert.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm text-rose-700">
                      <span>임계치 초과: {(alert.congestionLevel * 100).toFixed(0)}%</span>
                      <span className="font-bold">지속: {alert.durationMinutes}분</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function KpiTile({
  icon,
  tone,
  label,
  value,
  note,
}: {
  icon: React.ReactNode;
  tone: 'gold' | 'jade' | 'emerald' | 'rose';
  label: string;
  value: string;
  note: string;
}) {
  const palette: Record<string, string> = {
    gold: 'bg-gold/10 text-gold-deep',
    jade: 'bg-jade/10 text-jade',
    emerald: 'bg-emerald-500/10 text-emerald-600',
    rose: 'bg-rose-500/10 text-rose-700',
  };
  return (
    <div className="flex flex-col justify-between rounded-2xl border border-hanok-line bg-hanok-panel p-6 shadow-sm">
      <div className="mb-4 flex items-start justify-between">
        <div className={`rounded-xl p-3 ${palette[tone]}`}>{icon}</div>
      </div>
      <div>
        <h3 className="mb-1 text-sm font-semibold text-hanok-muted">{label}</h3>
        <div className="text-3xl font-black text-hanok-ink">{value}</div>
        <p className="mt-1 text-[11px] leading-snug text-hanok-muted">{note}</p>
      </div>
    </div>
  );
}

// 폐루프 내러티브 스텝 헤더 — 실제 대시보드의 StepBanner 와 같은 모양(그 함수는 export 되지 않는다).
function StepBanner({
  badge,
  title,
  subtitle,
  tone,
}: {
  badge: string;
  title: string;
  subtitle: string;
  tone: 'gold' | 'amber' | 'emerald';
}) {
  const palette: Record<string, string> = {
    gold: 'bg-gold/15 text-gold-deep border-gold/30',
    amber: 'bg-amber-500/15 text-amber-800 border-amber-500/30',
    emerald: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  };
  return (
    <div className="flex items-center gap-3">
      <span className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border text-base font-black ${palette[tone]}`}>
        {badge}
      </span>
      <div className="min-w-0">
        <h3 className="text-base font-bold leading-tight text-hanok-ink">{title}</h3>
        <p className="truncate text-xs text-hanok-muted">{subtitle}</p>
      </div>
    </div>
  );
}
