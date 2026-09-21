'use client';

// 엔진 검증 — 서울 실시간 도시데이터 대비 혼잡 추정기 성적표.
//
// 이 화면이 지켜야 하는 것 두 가지:
//  1) **표본이 적을 때도 운영 콘솔로 읽힐 것.** 서울 API 는 이력을 주지 않아 수집을 시작한 날부터만
//     표본이 쌓인다. 초기 구간은 '수집 중' 이 정상 상태다 — 깨진 화면이나 0% 로 보이면 안 된다.
//     상태 판정·문구는 lib/engineValidation.ts 가 하고 테스트가 잠근다.
//  2) **기준에 못 미친 지표를 감추지 않을 것.** 개선 중은 개선 중으로, 보고 제외는 이유와 함께.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle, AlertTriangle, CheckCircle2, Info, LogIn, MapPin, RefreshCw, Loader2, Database, FlaskConical,
} from 'lucide-react';
import { AdminSidebar } from '@/components/AdminSidebar';
import { MetricTile, OmittedMetricTile } from '@/components/admin/engine-validation/MetricTile';
import { ConfusionTable } from '@/components/admin/engine-validation/ConfusionTable';
import { ValidationSeriesChart } from '@/components/admin/engine-validation/ValidationSeriesChart';
import { SeoulAlternativesPanel } from '@/components/admin/engine-validation/SeoulAlternativesPanel';
import { SeoulCalibrationPanel } from '@/components/admin/engine-validation/SeoulCalibrationPanel';
import { adminApi, adminApiKind, adminApiStatus } from '@/lib/admin-api';
import { errorMessage } from '@/lib/errors';
import type { AdminFailureNotice } from '@/lib/adminApiFailure';
import {
  DEFAULT_WINDOW_DAYS, SEOUL_ATTRIBUTION, WINDOW_OPTIONS,
  describeFetchFailure, describeState, formatKst, parseSummary, sampleCaveat, summaryPath,
  tallyMetrics, tallySentence,
  type PlaceSummary, type Tone, type ValidationSummary,
} from '@/lib/engineValidation';

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; summary: ValidationSummary }
  | { status: 'failed'; failure: AdminFailureNotice };

const TONE_STYLE: Record<Tone, { box: string; title: string; Icon: typeof Info }> = {
  ok: { box: 'bg-emerald-500/10 border-emerald-500/30', title: 'text-emerald-700', Icon: CheckCircle2 },
  info: { box: 'bg-hanok-panel border-hanok-line', title: 'text-hanok-ink', Icon: Info },
  warn: { box: 'bg-amber-500/10 border-amber-500/30', title: 'text-amber-800', Icon: AlertTriangle },
  error: { box: 'bg-rose-500/10 border-rose-500/30', title: 'text-rose-700', Icon: AlertCircle },
};

export default function EngineValidationPage() {
  const [days, setDays] = useState<number>(DEFAULT_WINDOW_DAYS);
  const [reloadKey, setReloadKey] = useState(0);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [selectedPlace, setSelectedPlace] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    adminApi
      .get(summaryPath(days))
      .then((raw: unknown) => {
        if (!active) return;
        const summary = parseSummary(raw);
        if (!summary) {
          setLoad({
            status: 'failed',
            failure: {
              title: '검증 결과를 갱신하는 중입니다',
              action: '잠시 후 다시 시도해 주세요 — 새로고침하면 최신 결과를 불러옵니다.',
              href: null,
              retryable: true,
              detail: null,
            },
          });
          return;
        }
        setLoad({ status: 'loaded', summary });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setLoad({
          status: 'failed',
          failure: describeFetchFailure({
            kind: adminApiKind(err),
            status: adminApiStatus(err),
            message: errorMessage(err),
          }),
        });
      });
    return () => {
      active = false;
    };
  }, [days, reloadKey]);

  const reload = () => {
    setLoad({ status: 'loading' });
    setReloadKey((k) => k + 1);
  };
  const changeDays = (next: number) => {
    if (next === days) return;
    setLoad({ status: 'loading' });
    setDays(next);
  };

  const summary = load.status === 'loaded' ? load.summary : null;
  const places = summary?.places ?? [];
  const place: PlaceSummary | null =
    places.find((p) => (p.area_nm ?? p.area_cd) === selectedPlace) ?? places[0] ?? null;
  const notice = summary ? describeState(summary, place) : null;
  const tally = place ? tallyMetrics(place.metrics) : null;
  const omitted = place?.omitted_metrics?.length ? place.omitted_metrics : summary?.omitted_metrics ?? [];

  return (
    <div className="flex h-screen bg-hanok text-hanok-ink font-sans overflow-hidden">
      <AdminSidebar />

      <main className="flex-1 flex flex-col h-full min-h-0 overflow-hidden">
        <header className="h-20 bg-hanok-panel border-b border-hanok-line flex items-center justify-between px-8 flex-shrink-0">
          <h2 className="text-xl font-bold text-hanok-ink flex items-center gap-2">
            <FlaskConical size={22} className="text-gold-deep" />
            엔진 검증 — 서울 실시간 도시데이터
          </h2>
          <span className="text-xs text-hanok-muted hidden md:block">{SEOUL_ATTRIBUTION}</span>
        </header>

        <div className="flex-1 min-h-0 p-8 overflow-y-auto pb-20 space-y-6">
          {/* 컨트롤: 대상지 · 기간 · 새로고침 */}
          <div className="flex flex-wrap justify-between items-center gap-3 bg-hanok-panel p-4 rounded-2xl border border-hanok-line shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-hanok-muted mr-1 flex items-center gap-1">
                <MapPin size={14} /> 대상지
              </span>
              {places.length === 0 ? (
                // 표본이 쌓이기 전에도 무엇을 검증하는 화면인지 보여 준다(홍대 관광특구 1곳).
                <span className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-hanok-card text-hanok-muted border border-hanok-line">
                  홍대 관광특구
                </span>
              ) : (
                places.map((p) => {
                  const key = p.area_nm ?? p.area_cd ?? '';
                  const active = p === place;
                  return (
                    <button
                      key={key}
                      onClick={() => setSelectedPlace(key)}
                      aria-pressed={active}
                      className={`px-3 py-1.5 rounded-lg text-sm font-semibold border transition-colors ${
                        active ? 'bg-gold/10 text-gold-deep border-gold/40' : 'bg-hanok-card text-hanok-muted border-hanok-line hover:text-hanok-ink'
                      }`}
                    >
                      {p.area_nm ?? p.area_cd}
                    </button>
                  );
                })
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-hanok-muted mr-1">기간</span>
              {WINDOW_OPTIONS.map((option) => (
                <button
                  key={option}
                  onClick={() => changeDays(option)}
                  aria-pressed={option === days}
                  className={`px-3 py-1.5 rounded-lg text-sm font-semibold border transition-colors ${
                    option === days ? 'bg-gold/10 text-gold-deep border-gold/40' : 'bg-hanok-card text-hanok-muted border-hanok-line hover:text-hanok-ink'
                  }`}
                >
                  최근 {option}일
                </button>
              ))}
              <button
                onClick={reload}
                disabled={load.status === 'loading'}
                className="ml-2 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-semibold border bg-hanok-card text-hanok-ink border-hanok-line hover:text-gold-deep disabled:opacity-50"
              >
                <RefreshCw size={14} className={load.status === 'loading' ? 'animate-spin' : ''} /> 새로고침
              </button>
            </div>
          </div>

          {load.status === 'loading' && (
            <div className="flex items-center gap-2 text-sm text-hanok-muted bg-hanok-panel p-4 rounded-2xl border border-hanok-line">
              <Loader2 size={16} className="animate-spin" /> 검증 표본을 불러오는 중…
            </div>
          )}

          {load.status === 'failed' && (
            <div className="flex items-start gap-3 bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4">
              <AlertCircle size={20} className="text-rose-600 flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-bold text-rose-700">{load.failure.title}</p>
                <p className="text-sm text-hanok-muted mt-1">{load.failure.action}</p>
                <div className="flex items-center gap-3 mt-2">
                  {load.failure.href && (
                    <Link href={load.failure.href} className="inline-flex items-center gap-1 text-xs font-semibold text-hanok-ink underline underline-offset-2 hover:text-gold-deep">
                      <LogIn size={13} /> 관리자 로그인으로 이동
                    </Link>
                  )}
                  {load.failure.retryable && (
                    <button onClick={reload} className="inline-flex items-center gap-1 text-xs font-semibold text-hanok-ink underline underline-offset-2 hover:text-gold-deep">
                      <RefreshCw size={13} /> 다시 시도
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {summary && notice && (
            <>
              {/* 수집·판정 상태 */}
              <StateBanner tone={notice.tone} title={notice.title} detail={notice.detail}>
                {summary.collection && summary.collection.row_count > 0 && (
                  <p className="text-xs text-hanok-muted mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    <span><Database size={12} className="inline mr-1" />대조 표본 {summary.collection.row_count}건</span>
                    <span>대조 시작 {formatKst(summary.collection.first_bucket_at)}</span>
                    <span>최근 대조 {formatKst(summary.collection.last_bucket_at)}</span>
                    <span>마지막 서울 집계 {formatKst(summary.collection.last_observed_at)} (KST)</span>
                    {tally && <span>{tallySentence(tally)}</span>}
                  </p>
                )}
              </StateBanner>

              {/* 표본 출처 — 결과보다 먼저, 항상 */}
              <div className="flex items-start gap-3 bg-hanok-panel border border-hanok-line rounded-2xl p-4">
                <Info size={18} className="text-hanok-muted flex-shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-bold text-hanok-ink">{sampleCaveat(place)}</p>
                  <p className="text-hanok-muted mt-1">
                    경주와 동일한 산식을 서울 실측 데이터로 교차 검증한 결과입니다.
                  </p>
                </div>
              </div>

              {/* KPI 타일 */}
              <section>
                <h3 className="text-lg font-bold text-hanok-ink mb-3">검증 지표</h3>
                {place ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                    {place.metrics.map((metric) => (
                      <MetricTile key={metric.key} metric={metric} />
                    ))}
                    {omitted.map((item) => (
                      <OmittedMetricTile key={item.key} item={item} />
                    ))}
                  </div>
                ) : (
                  <div className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line text-sm text-hanok-muted space-y-2">
                    <p>7개 지표를 기준·표본 수와 함께 집계하는 중입니다: 등급 일치율(≥ 50%) · 인접 등급 일치율(≥ 85%) · 순위 상관(≥ 0.5) · 위험 오분류율(≤ 5%) · 30분 전망 오차(지속 모델보다 낮게) · 서울시 예측 대비(보고용) · 커버리지(보고용).</p>
                    {omitted.map((item) => (
                      <p key={item.key}><span className="text-hanok-ink font-semibold">{item.label}</span>은 보고 제외 항목입니다 — {item.reason}</p>
                    ))}
                  </div>
                )}
              </section>

              {/* 시계열 */}
              <section className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
                  <h3 className="text-lg font-bold text-hanok-ink">정규화 실측 vs NextSpot 추정</h3>
                  <span className="text-xs text-hanok-muted">10분 버킷 · KST · 수집 구간만 연결</span>
                </div>
                <p className="text-xs text-hanok-muted mb-4">
                  실측 = 서울시 인구 범위 중앙값 ÷ 이 기간 최대 중앙값
                  {place?.normalization.max_midpoint ? ` (${Math.round(place.normalization.max_midpoint).toLocaleString('ko-KR')}명, ${formatKst(place.normalization.max_midpoint_bucket_at)})` : ''}.
                  점선 가로선은 추정 등급 경계(25·50·75%)입니다.
                </p>
                <div className="w-full h-[320px]">
                  <ValidationSeriesChart series={place?.series ?? []} />
                </div>
              </section>

              {/* 혼동표 + 방법 */}
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                <section className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm">
                  <h3 className="text-lg font-bold text-hanok-ink mb-3">등급 혼동표</h3>
                  {place && place.confusion.total > 0 ? (
                    <ConfusionTable matrix={place.confusion.matrix} total={place.confusion.total} />
                  ) : (
                    <p className="text-sm text-hanok-muted">등급 대조표를 집계하는 중입니다 — 10분 주기로 표본이 누적됩니다.</p>
                  )}
                </section>

                <section className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm text-sm text-hanok-muted space-y-3">
                  <h3 className="text-lg font-bold text-hanok-ink">방법</h3>
                  <div>
                    <p className="font-semibold text-hanok-ink">추정기 (경주와 같은 산식)</p>
                    <p className="font-mono text-xs bg-hanok-card border border-hanok-line rounded-lg px-3 py-2 mt-1 text-hanok-ink">
                      level = 0.7 · 주변 공영주차 점유율 + 0.3 · 관광 집중률 기준선
                    </p>
                    <p className="mt-1 text-xs">
                      두 신호 중 하나만 들어와도 그 값으로 산출하며, 산출 범위는 커버리지 지표에 함께 표시합니다.
                      결과는 0~100% 혼잡 수준으로 제시합니다.
                    </p>
                  </div>
                  <div>
                    <p className="font-semibold text-hanok-ink">실측과 대조하는 법</p>
                    <p className="text-xs mt-1">
                      서울시 4등급(여유·보통·약간 붐빔·붐빔)을 0~3으로 두고, NextSpot 추정은 0.25·0.50·0.75 경계(75 이상 = 혼잡)로 나눕니다.
                      30분 전망은 t 시점의 추정을 t+30분 실측과 맞춰 보고, t 의 실측을 그대로 쓰는 지속 모델과 같은 표본에서 비교합니다.
                      판정은 버킷 {summary.min_samples}개(위험 오분류는 실측 붐빔 {summary.min_danger_samples}개) 이상에서 확정합니다.
                    </p>
                  </div>
                  <div>
                    <p className="font-semibold text-hanok-ink">혼잡 신호</p>
                    <p className="text-xs mt-1">
                      경주 ITS 공영주차 실시간 점유율을 혼잡 신호로 활용합니다 — 10분 주기로 갱신되는 실측 데이터입니다.
                    </p>
                  </div>
                  <div>
                    <p className="font-semibold text-hanok-ink">비교 기준 데이터</p>
                    <p className="text-xs mt-1">
                      서울시 인구는 통신사 기지국 5분 집계를 50m 격자로 배분한 값이며, 핫스팟 권역 단위로 제공됩니다.
                    </p>
                  </div>
                </section>
              </div>
            </>
          )}

          {/* 아래 두 블록은 검증 표본 상태와 무관하게 스스로 조회한다 — 위 지표가 실패해도 보여야 한다. */}
          <SeoulAlternativesPanel />
          <SeoulCalibrationPanel />

          <footer className="text-xs text-hanok-muted border-t border-hanok-line pt-4">
            {SEOUL_ATTRIBUTION}
          </footer>
        </div>
      </main>
    </div>
  );
}

function StateBanner({ tone, title, detail, children }: { tone: Tone; title: string; detail: string; children?: React.ReactNode }) {
  const style = TONE_STYLE[tone];
  const { Icon } = style;
  return (
    <div className={`flex items-start gap-3 border rounded-2xl p-4 ${style.box}`}>
      <Icon size={20} className={`${style.title} flex-shrink-0 mt-0.5`} />
      <div className="min-w-0">
        <p className={`font-bold ${style.title}`}>{title}</p>
        <p className="text-sm text-hanok-muted mt-1">{detail}</p>
        {children}
      </div>
    </div>
  );
}
