'use client';

// 엔진 검증 — 서울 실시간 도시데이터 대비 혼잡 추정기 성적표(docs/CONGESTION_ENGINE_PLAN.md §5.3·§5.4 A·§6).
//
// 이 화면이 지켜야 하는 것 두 가지:
//  1) **표본이 없을 때 정직할 것.** 서울 API 는 이력을 주지 않아 수집을 시작한 날부터만 표본이 쌓인다.
//     처음 몇 주는 '수집 시작 전'·'표본 부족' 이 정상 상태다 — 깨진 화면이나 0% 로 보이면 안 된다.
//     상태 판정·문구는 lib/engineValidation.ts 가 하고 테스트가 잠근다.
//  2) **통과 못 한 지표를 감추지 않을 것**(§6). 미달은 미달로, 계산 불가(구분 가능률)는 이유와 함께.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle, AlertTriangle, CheckCircle2, Info, LogIn, MapPin, RefreshCw, Loader2, Database, FlaskConical,
} from 'lucide-react';
import { AdminSidebar } from '@/components/AdminSidebar';
import { MetricTile, OmittedMetricTile } from '@/components/admin/engine-validation/MetricTile';
import { ConfusionTable } from '@/components/admin/engine-validation/ConfusionTable';
import { ValidationSeriesChart } from '@/components/admin/engine-validation/ValidationSeriesChart';
import { adminApi, adminApiKind, adminApiStatus } from '@/lib/admin-api';
import { errorMessage } from '@/lib/errors';
import type { AdminFailureNotice } from '@/lib/adminApiFailure';
import {
  DEFAULT_WINDOW_DAYS, SEOUL_ATTRIBUTION, WINDOW_OPTIONS,
  describeFetchFailure, describeState, formatKst, parseSummary, sampleCaveat, summaryPath, tallyMetrics,
  type PlaceSummary, type Tone, type ValidationSummary,
} from '@/lib/engineValidation';

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; summary: ValidationSummary }
  | { status: 'failed'; failure: AdminFailureNotice };

const TONE_STYLE: Record<Tone, { box: string; title: string; Icon: typeof Info }> = {
  ok: { box: 'bg-emerald-500/10 border-emerald-500/30', title: 'text-emerald-300', Icon: CheckCircle2 },
  info: { box: 'bg-hanok-panel border-hanok-line', title: 'text-hanok-ink', Icon: Info },
  warn: { box: 'bg-amber-500/10 border-amber-500/30', title: 'text-amber-300', Icon: AlertTriangle },
  error: { box: 'bg-rose-500/10 border-rose-500/30', title: 'text-rose-300', Icon: AlertCircle },
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
              title: '응답 형식이 이 화면과 맞지 않아요',
              action: 'API 와 웹의 배포 버전이 다를 수 있습니다. 두 쪽을 같은 커밋으로 맞춘 뒤 다시 열어 주세요.',
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
            <FlaskConical size={22} className="text-gold" />
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
                // 표본이 없어도 무엇을 검증하려는지는 보여 준다(§4 반영: 홍대 관광특구 1곳).
                <span className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-hanok-card text-hanok-muted border border-hanok-line">
                  홍대 관광특구 (표본 없음)
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
                        active ? 'bg-gold/10 text-gold border-gold/40' : 'bg-hanok-card text-hanok-muted border-hanok-line hover:text-hanok-ink'
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
                    option === days ? 'bg-gold/10 text-gold border-gold/40' : 'bg-hanok-card text-hanok-muted border-hanok-line hover:text-hanok-ink'
                  }`}
                >
                  최근 {option}일
                </button>
              ))}
              <button
                onClick={reload}
                disabled={load.status === 'loading'}
                className="ml-2 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-semibold border bg-hanok-card text-hanok-ink border-hanok-line hover:text-gold disabled:opacity-50"
              >
                <RefreshCw size={14} className={load.status === 'loading' ? 'animate-spin' : ''} /> 새로고침
              </button>
            </div>
          </div>

          {load.status === 'loading' && (
            <div className="flex items-center gap-2 text-sm text-hanok-muted bg-hanok-panel p-4 rounded-2xl border border-hanok-line">
              <Loader2 size={16} className="animate-spin" /> 검증 표본을 불러오는 중… (서버가 잠들어 있었다면 30초쯤 걸릴 수 있어요)
            </div>
          )}

          {load.status === 'failed' && (
            <div className="flex items-start gap-3 bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4">
              <AlertCircle size={20} className="text-rose-400 flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-bold text-rose-300">{load.failure.title}</p>
                <p className="text-sm text-hanok-muted mt-1">{load.failure.action}</p>
                <div className="flex items-center gap-3 mt-2">
                  {load.failure.href && (
                    <Link href={load.failure.href} className="inline-flex items-center gap-1 text-xs font-semibold text-hanok-ink underline underline-offset-2 hover:text-gold">
                      <LogIn size={13} /> 관리자 로그인으로 이동
                    </Link>
                  )}
                  {load.failure.retryable && (
                    <button onClick={reload} className="inline-flex items-center gap-1 text-xs font-semibold text-hanok-ink underline underline-offset-2 hover:text-gold">
                      <RefreshCw size={13} /> 다시 시도
                    </button>
                  )}
                </div>
                {load.failure.detail && <p className="text-xs text-hanok-muted/80 mt-1 break-words">사유: {load.failure.detail}</p>}
              </div>
            </div>
          )}

          {summary && notice && (
            <>
              {/* 수집·판정 상태 */}
              <StateBanner tone={notice.tone} title={notice.title} detail={notice.detail}>
                {summary.collection && summary.collection.row_count > 0 && (
                  <p className="text-xs text-hanok-muted mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    <span><Database size={12} className="inline mr-1" />창 안 행 {summary.collection.row_count}개</span>
                    <span>첫 버킷 {formatKst(summary.collection.first_bucket_at)}</span>
                    <span>마지막 버킷 {formatKst(summary.collection.last_bucket_at)}</span>
                    <span>마지막 서울 집계 {formatKst(summary.collection.last_observed_at)} (KST)</span>
                    {tally && <span>판정 지표: 통과 {tally.pass} · 미달 {tally.fail} · 표본 부족 {tally.insufficient}</span>}
                  </p>
                )}
              </StateBanner>

              {/* 표본 기간 주의 — 결과보다 먼저, 항상 */}
              <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4">
                <AlertTriangle size={18} className="text-amber-300 flex-shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-bold text-amber-300">{sampleCaveat(place, places.length)}</p>
                  <p className="text-hanok-muted mt-1">
                    결론은 &quot;다른 도시의 한 장소에서 같은 산식이 이만큼 맞았다&quot;까지만 말한다. 서울 결과가 경주 정확도를 보장하지 않는다(§3).
                  </p>
                </div>
              </div>

              {place && (place.excluded_other_version_rows > 0 || place.latest_live_lot_count === 0) && (
                <div className="flex items-start gap-3 bg-hanok-panel border border-hanok-line rounded-2xl p-4 text-sm">
                  <Info size={18} className="text-hanok-muted flex-shrink-0 mt-0.5" />
                  <ul className="space-y-1 text-hanok-muted">
                    {place.excluded_other_version_rows > 0 && (
                      <li>
                        추정기 버전이 창 안에서 바뀌었습니다({place.estimator_versions_in_window.join(' → ')}). 최신 버전
                        <span className="text-hanok-ink font-semibold"> {place.estimator_version}</span> 행만 채점했고 {place.excluded_other_version_rows}행은 뺐습니다.
                      </li>
                    )}
                    {place.latest_live_lot_count === 0 && (
                      <li className="text-amber-300">
                        최근 버킷에 실시간 대수를 주는 주차장이 0곳입니다. 주차 신호가 없으면 추정 자체를 만들 수 없어 대상지를 다시 정해야 할 수 있습니다(§4 반영 7).
                      </li>
                    )}
                  </ul>
                </div>
              )}

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
                    <p>표본이 쌓이면 여기에 7개 지표가 기준·표본 수와 함께 나옵니다: 등급 일치율(≥ 50%) · 인접 등급 일치율(≥ 85%) · 순위 상관(≥ 0.5) · 위험 오분류율(≤ 5%) · 30분 전망 오차(지속 모델보다 낮게) · 서울시 예측 대비(보고용) · 커버리지(보고용).</p>
                    {omitted.map((item) => (
                      <p key={item.key}><span className="text-hanok-ink font-semibold">{item.label}</span>은 계산하지 않습니다 — {item.reason}</p>
                    ))}
                  </div>
                )}
              </section>

              {/* 시계열 */}
              <section className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
                  <h3 className="text-lg font-bold text-hanok-ink">정규화 실측 vs 우리 추정</h3>
                  <span className="text-xs text-hanok-muted">10분 버킷 · KST · 끊긴 구간은 수집 누락</span>
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
                    <p className="text-sm text-hanok-muted">실측 등급과 추정 등급이 함께 있는 버킷이 아직 없습니다.</p>
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
                      둘 중 하나만 있으면 그 값, 둘 다 없으면 추정하지 않는다(커버리지에 반영). 인원수는 만들지 않는다.
                      {place?.estimator_version ? ` 채점한 추정기 버전: ${place.estimator_version}.` : ''}
                    </p>
                  </div>
                  <div>
                    <p className="font-semibold text-hanok-ink">정답과 비교하는 법</p>
                    <p className="text-xs mt-1">
                      서울시 4등급(여유·보통·약간 붐빔·붐빔)을 0~3으로, 우리 추정은 0.25·0.50·0.75 경계(저장소의 75 = 혼잡 기준)로 자른다.
                      30분 전망은 t 의 추정을 t+30분 값으로 보고, t 의 실측을 그대로 쓰는 지속 모델과 같은 표본에서 비교한다.
                      판정은 버킷 {summary.min_samples}개(위험 오분류는 실측 붐빔 {summary.min_danger_samples}개) 이상에서만 한다.
                    </p>
                  </div>
                  <div>
                    <p className="font-semibold text-hanok-ink">왜 홍대는 어려운 장소인가</p>
                    <p className="text-xs mt-1">
                      홍대입구역(2호선·공항철도·경의중앙선)으로 오는 대중교통 비중이 커서 주차 점유율이 인구를 잘 설명하지 못할 가능성이 높다.
                      지표가 낮게 나오면 그대로 보여 주고, &quot;자차 비중이 높은 경주에서는 주차 설명력이 더 클 것&quot;은 가설로만 말한다.
                      반대로 젊은 층·카페 골목 상권이라 황리단길과 성격은 비슷하다.
                    </p>
                  </div>
                  <div>
                    <p className="font-semibold text-hanok-ink">정답도 추정이다</p>
                    <p className="text-xs mt-1">
                      서울시 인구는 통신사 기지국 5분 집계를 50m 격자로 배분한 값이고 단위는 핫스팟 전체다. 가게 단위 검증이 아니다.
                    </p>
                  </div>
                </section>
              </div>
            </>
          )}

          <footer className="text-xs text-hanok-muted border-t border-hanok-line pt-4">
            {SEOUL_ATTRIBUTION}. 계획: docs/CONGESTION_ENGINE_PLAN.md §5.3·§6.
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
