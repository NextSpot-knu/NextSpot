'use client';

// "서울 실측으로 보정".
//
// 이 블록이 답해야 하는 것은 하나다: **그래서 경주 추정에 적용됐나, 아니면 어떤 조건에서 적용되나.**
// 곡선 그림이 예쁘게 그려져 있어도 적용 전이면 화면은 먼저 그렇게 말해야 한다 — 기본은 기준선
// 유지이고, 한 권역에서 맞춘 곡선을 경주에 옮기는 것은 보수적으로 판단한다.
//
// 엔드포인트는 다른 에이전트가 만드는 중이라 한동안 404 다. 404 는 장애가 아니라 배포 순서 문제
// 이므로 조용한 안내로 가른다 — 빨간 배너를 띄우면 관리자가 매번 없는 고장을 쫓는다.

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw, Sigma } from 'lucide-react';
import { adminApi, adminApiKind, adminApiStatus } from '@/lib/admin-api';
import { errorMessage } from '@/lib/errors';
import type { AdminFailureNotice } from '@/lib/adminApiFailure';
import { CalibrationCurveChart, HourShapeChart } from './CalibrationCharts';
import {
  CALIBRATION_WINDOW_DAYS,
  calibrationPath,
  describeCalibrationState,
  describeFetchFailure,
  describeQualityDelta,
  formatKst,
  formatQualityNumber,
  hourShapeRows,
  parseCalibration,
  type CalibrationResponse,
  type CalibrationView,
  type Tone,
} from '@/lib/engineValidation';

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; data: CalibrationResponse | null }
  | { status: 'not_deployed' }
  | { status: 'failed'; failure: AdminFailureNotice };

const TONE_BOX: Record<Tone, string> = {
  ok: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700',
  info: 'bg-hanok-card border-hanok-line text-hanok-ink',
  warn: 'bg-amber-500/10 border-amber-500/30 text-amber-800',
  error: 'bg-rose-500/10 border-rose-500/30 text-rose-700',
};

export function SeoulCalibrationPanel() {
  const [reloadKey, setReloadKey] = useState(0);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    adminApi
      .get(calibrationPath(CALIBRATION_WINDOW_DAYS))
      .then((raw: unknown) => {
        if (!active) return;
        setLoad({ status: 'loaded', data: parseCalibration(raw) });
      })
      .catch((err: unknown) => {
        if (!active) return;
        // 404 = API 에 아직 이 엔드포인트가 없다(배포 순서 차이). 오류가 아니다.
        if (adminApiStatus(err) === 404) {
          setLoad({ status: 'not_deployed' });
          return;
        }
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
  }, [reloadKey]);

  const reload = useCallback(() => {
    setLoad({ status: 'loading' });
    setReloadKey((key) => key + 1);
  }, []);

  const data = load.status === 'loaded' ? load.data : null;
  const view: CalibrationView | null =
    load.status === 'not_deployed' ? 'not_deployed' : load.status === 'loaded' ? (data?.state ?? 'not_migrated') : null;
  const notice = view ? describeCalibrationState(view, load.status === 'loaded' ? data : null) : null;
  const quality = data?.quality ?? null;

  return (
    <section className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-bold text-hanok-ink flex items-center gap-2">
          <Sigma size={18} className="text-gold-deep" /> 서울 실측으로 보정
        </h3>
        <button
          onClick={reload}
          disabled={load.status === 'loading'}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold border bg-hanok-card text-hanok-ink border-hanok-line hover:text-gold-deep disabled:opacity-50"
        >
          <RefreshCw size={13} className={load.status === 'loading' ? 'animate-spin' : ''} /> 새로고침
        </button>
      </div>
      <p className="text-xs text-hanok-muted">
        경주는 <span className="text-hanok-ink font-semibold">공영주차 실시간 점유율</span>을 혼잡 신호로 씁니다.
        서울에서는 주차와 실측 인구가 같은 API 로 함께 오므로, 그 쌍으로 &quot;점유율이 이만큼이면 인파는 이만큼&quot;을 적합합니다.
        적합한 곡선을 경주에 옮기는 것은 <span className="text-hanok-ink font-semibold">검증 단계</span>이며, 기준선(보정 없음)을 상회할 때 적용합니다.
      </p>

      {load.status === 'loading' && (
        <div className="flex items-center gap-2 text-sm text-hanok-muted">
          <Loader2 size={16} className="animate-spin" /> 보정 결과를 불러오는 중…
        </div>
      )}

      {load.status === 'failed' && (
        <div className="flex items-start gap-3 bg-rose-500/10 border border-rose-500/30 rounded-xl p-4">
          <AlertCircle size={18} className="text-rose-600 flex-shrink-0 mt-0.5" />
          <div className="min-w-0 text-sm">
            <p className="font-bold text-rose-700">{load.failure.title}</p>
            <p className="text-hanok-muted mt-1">{load.failure.action}</p>
            {load.failure.retryable && (
              <button onClick={reload} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-hanok-ink underline underline-offset-2 hover:text-gold-deep">
                <RefreshCw size={13} /> 다시 시도
              </button>
            )}
          </div>
        </div>
      )}

      {notice && (
        <div className={`border rounded-xl p-3 ${TONE_BOX[notice.tone]}`}>
          <p className="font-bold text-sm">{notice.title}</p>
          <p className="text-xs text-hanok-muted mt-1">{notice.detail}</p>
          {data && (
            <p className="text-[11px] text-hanok-muted mt-2 flex flex-wrap gap-x-4 gap-y-1">
              <span>최근 {data.window_days}일 창</span>
              <span>짝지은 버킷 {data.sample.paired_buckets}개 / 최소 {data.requirement.min_paired_buckets}개</span>
              <span>{data.sample.days}일치 / 최소 {data.requirement.min_days}일</span>
              {data.places.length > 0 && <span>표본 대상지: {data.places.join(' · ')}</span>}
              {data.curve?.fitted_at && <span>적합 시각 {formatKst(data.curve.fitted_at)}</span>}
            </p>
          )}
        </div>
      )}

      {data && (
        <>
          {/* 항등 대비 성적 */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <QualityTile
              label="30분 오차 (MAE)"
              identity={formatQualityNumber(quality?.mae_identity)}
              calibrated={formatQualityNumber(quality?.mae_calibrated)}
              delta={describeQualityDelta(quality?.mae_identity, quality?.mae_calibrated, true)}
              hint="낮을수록 좋음"
            />
            <QualityTile
              label="순위 상관 (ρ)"
              identity={formatQualityNumber(quality?.spearman_identity, 2)}
              calibrated={formatQualityNumber(quality?.spearman_calibrated, 2)}
              delta={describeQualityDelta(quality?.spearman_identity, quality?.spearman_calibrated, false)}
              hint="높을수록 좋음"
            />
            <div className="bg-hanok-card border border-hanok-line rounded-xl p-3">
              <p className="text-xs text-hanok-muted">홀드아웃</p>
              <p className="text-lg font-bold text-hanok-ink mt-1">{quality?.holdout_days ?? 0}일</p>
              <p className="text-[11px] text-hanok-muted mt-1">학습과 평가를 날짜로 분리해 산출합니다</p>
            </div>
            <div className="bg-hanok-card border border-hanok-line rounded-xl p-3">
              <p className="text-xs text-hanok-muted">경주 추정에 적용</p>
              <p className={`text-lg font-bold mt-1 ${data.applied ? 'text-emerald-700' : 'text-hanok-ink'}`}>
                {data.applied ? '적용 중' : '기준선 유지'}
              </p>
              <p className="text-[11px] text-hanok-muted mt-1">
                {data.requirement.must_beat_identity ? '기준선을 상회할 때 적용합니다' : '기준선 비교 없이 적용합니다'}
                {data.gyeongju_effect?.median_shift !== null && data.gyeongju_effect?.median_shift !== undefined
                  ? ` · 적용 시 경주 추정 중앙 변화 ${data.gyeongju_effect.median_shift > 0 ? '+' : ''}${data.gyeongju_effect.median_shift.toFixed(3)}`
                  : ''}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div>
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
                <h4 className="font-bold text-hanok-ink">보정 곡선</h4>
                <span className="text-xs text-hanok-muted">{data.curve ? '학습 완료' : '학습 중'}</span>
              </div>
              <p className="text-xs text-hanok-muted mb-3">
                가로축 = 주변 공영주차 점유율, 세로축 = 그 점유율에서 실제로 관측된 혼잡 수준(서울 정규화 인구).
                점선 대각선이 <span className="text-hanok-ink font-semibold">기준선</span> — 지금 경주에 걸려 있는 값입니다.
              </p>
              <div className="w-full h-[280px]">
                <CalibrationCurveChart curve={data.curve} />
              </div>
            </div>

            <div>
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
                <h4 className="font-bold text-hanok-ink">하루 모양 — 서울 실측 vs 경주 주차</h4>
                <span className="text-xs text-hanok-muted">KST · 평일/주말 평균</span>
              </div>
              <p className="text-xs text-hanok-muted mb-3">
                두 신호의 피크 시각을 견주면 주차 점유율이 인파를 얼마나 설명하는지 시간대별로 확인할 수 있습니다.
                서울은 대중교통 비중이, 경주는 자차 비중이 높아 하루 모양이 다르게 나타납니다 — 데이터 기준.
              </p>
              <div className="w-full h-[280px]">
                <HourShapeChart rows={hourShapeRows(data.hour_shape)} />
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function QualityTile({
  label, identity, calibrated, delta, hint,
}: { label: string; identity: string; calibrated: string; delta: string; hint: string }) {
  return (
    <div className="bg-hanok-card border border-hanok-line rounded-xl p-3">
      <p className="text-xs text-hanok-muted">{label}</p>
      <p className="text-lg font-bold text-hanok-ink mt-1">{calibrated}</p>
      <p className="text-[11px] text-hanok-muted mt-1">기준선 {identity} · {delta}</p>
      <p className="text-[11px] text-hanok-muted/80">{hint}</p>
    </div>
  );
}
