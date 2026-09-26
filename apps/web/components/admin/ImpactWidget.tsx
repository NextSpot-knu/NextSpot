'use client';

import { useState, useEffect } from 'react';
import { Route, TimerOff } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';
import { useCountUp } from '@/lib/useCountUp';
import {
  MIN_MEASURED_SAMPLES,
  SCENARIO_BADGE,
  basisSubline,
  scenarioKpis,
  type KpiBasis,
  type LoopSamples,
} from '@/lib/adminPredictedView';

// 분산 효과 정량화 — 오늘(KST) 수락된 추천의 '절감 대기시간' 합산.
// 산식(백엔드 GET /api/v1/admin/impact): Σ max(0, 원본 예상대기 − 대안 도착시점 예상대기).
// 원본/대안 대기는 추천 생성 시점의 score_breakdown 스냅샷이라 사후 재계산 왜곡이 없다.
//
// 시나리오 모드(2026-09-22 PM 결정, 2026-09-26 공동 판정): 추천 고리 네 패널(수락률·DAU·이 위젯·깔때기)이
// 모두 실측 5건 미만일 때만(페이지의 resolveLoopBasis → loopBasis === 'scenario') 서버 합계 대신
// lib/adminPredictedView.scenarioKpis(응답 도착 시각)의 재배치·절감 분을 '시나리오' 배지와 함께 보여 준다.
// 이 위젯 혼자 5건 미만이어도 옆 패널이 실측이면 실측 그대로다 — '5,000건 중 0건 수락'(실측) 옆에
// '179건 재배치(추천 수락)'(시나리오)을 세우지 않는다. 이 위젯은 자기 창(오늘 수락)의 표본 수를
// onMeasuredSamples 로 페이지에 알린다. 조회 실패는 시나리오로 덮지 않는다 — '—' 와 '갱신 중' 이다.

/** 시나리오 값 아래 붙는 근거 한 줄 — 무엇으로 만든 값인지와 언제 실측으로 바뀌는지. */
const SCENARIO_FOOTNOTE = '도입 목표 패턴의 하루 총량 × 시각 진행률 · 실측 수락 기록이 쌓이면 실측으로 전환';

interface ImpactData {
  relocations: number;
  saved_wait_minutes: number;
  measured: number;
  estimated: number;
  /** 서버 상한(_IMPACT_REC_CAP)에 닿았는가. 합계 지표라 잘리면 **실제보다 작게** 말하게 된다. */
  truncated?: boolean;
}

// KST '오늘 00:00' 을 UTC ISO 로 — dashboard/page.tsx 의 범위 계산과 동일한 고정 +9h 환산.
function kstTodayStartUtcIso(): string {
  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const startUtcMs =
    Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate(), 0, 0, 0, 0) -
    9 * 60 * 60 * 1000;
  return new Date(startUtcMs).toISOString();
}

export function ImpactWidget({
  loopBasis = 'measured',
  onMeasuredSamples,
}: {
  /** 추천 고리 공동 판정 — 'scenario' 일 때만 시나리오를 그린다. null = 아직 판정 전(로딩 모양). 기본은 실측. */
  loopBasis?: KpiBasis | null;
  /** 이 위젯 창(오늘 수락)의 실측 표본 수를 페이지에 알린다(실패·모양 불일치면 'failed'). */
  onMeasuredSamples?: (samples: LoopSamples) => void;
} = {}) {
  const [data, setData] = useState<ImpactData | null>(null);
  const [failed, setFailed] = useState(false);
  // 응답이 도착한 시각(ms). 시나리오 값의 시각 입력은 렌더 중 시계가 아니라 이 값이다 —
  // 같은 응답은 다시 그려도 같은 숫자여야 한다.
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    adminApi
      .get(`/api/v1/admin/impact?since=${encodeURIComponent(kstTodayStartUtcIso())}`)
      .then(res => {
        if (active) {
          setData(res);
          setLoadedAt(Date.now());
        }
      })
      .catch(err => {
        console.warn('분산 효과 집계 조회 실패:', err);
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  // 실측 표본 = 오늘 수락된 추천 건수(relocations). 숫자가 아니면(응답 모양이 다름) 모른다 → 기존 '—'.
  const relocationsMeasured = typeof data?.relocations === 'number' && Number.isFinite(data.relocations) ? data.relocations : null;
  const loaded = !!data && !failed && relocationsMeasured !== null;

  // 페이지에 이 창의 표본 수를 알린다. 실패하거나 숫자가 아니면 'failed' — 화면에 실측 숫자가 없는 자리다.
  useEffect(() => {
    if (!onMeasuredSamples) return;
    if (failed || (data && relocationsMeasured === null)) onMeasuredSamples('failed');
    else if (data && relocationsMeasured !== null) onMeasuredSamples(relocationsMeasured);
  }, [data, failed, relocationsMeasured, onMeasuredSamples]);

  // 공동 판정 전이면 숫자를 비워 둔다(실측 몇 건을 잠깐 보였다가 시나리오로 바꾸지 않는다).
  const pending = loaded && loopBasis === null;
  const scenario = loaded && loopBasis === 'scenario' && loadedAt !== null ? scenarioKpis(loadedAt) : null;
  // 시나리오 숫자만 굴린다(실측 렌더는 그대로). NaN 이면 훅이 아무것도 하지 않는다.
  const scenarioSaved = useCountUp(scenario ? scenario.savedWaitMinutes : Number.NaN);
  const scenarioRelocations = useCountUp(scenario ? scenario.relocations : Number.NaN);
  const scenarioLine = scenario ? basisSubline({ basis: 'scenario', measuredCount: relocationsMeasured, unit: '건' }) : null;

  return (
    <div className={`bg-hanok-panel rounded-2xl shadow-sm overflow-hidden flex flex-col ${
      scenario ? 'border-2 border-dashed border-amber-400/50' : 'border border-hanok-line'
    }`}>
      <div className="p-6 border-b border-hanok-line bg-hanok-card/30">
        <div className="flex items-center gap-2 flex-wrap">
          <Route className="text-emerald-600" size={20} />
          <h3 className="text-lg font-bold text-hanok-ink">오늘 분산 효과</h3>
          {scenario && (
            <span
              title={scenarioLine ?? undefined}
              className="px-2 py-0.5 rounded-full text-[11px] font-black border border-dashed bg-amber-500/15 text-amber-800 border-amber-400/60"
            >
              {SCENARIO_BADGE}
            </span>
          )}
        </div>
        <p className="text-xs text-hanok-muted mt-1">
          {scenario
            ? `도입 목표 패턴 기준 — 실측 ${MIN_MEASURED_SAMPLES}건이 쌓이면 실측으로 전환됩니다 (KST 오늘 기준)`
            : '수락된 추천이 실제로 덜어낸 혼잡 (KST 오늘 기준)'}
        </p>
        {scenarioLine && <p className="text-[11px] text-amber-800/90 mt-1">{scenarioLine}</p>}
      </div>

      <div className="flex-1 p-6 flex flex-col justify-center gap-6">
        {/* 실패해도 패널을 비우지 않는다 — 수치는 '—'로 두고 대기 안내만 덧붙여 자리를 유지. */}
        {/* 실패를 실데이터로 위장하지 않으려 0/공란이 아닌 '—'로 명시. */}
        {/* ⚠️ `data ?` 로는 부족하다. 그 가드는 **객체가 있는지**만 보는데, 응답이 `{}` 이거나
            키가 빠지면 필드가 undefined 라 `.toLocaleString()` 이 터지고 — 이 위젯 하나가
            아니라 **대시보드 전체가 에러 바운더리로 떨어진다**(브라우저에서 재현).
            배포 시차로 옛/새 서버 응답 shape 이 어긋나는 구간에서 실제로 온다.
            그래서 아래는 **값이 숫자일 때만** 포맷하고, 아니면 '—'(모른다)로 둔다. */}
        <div className="flex items-center gap-4">
          <div className="p-3 bg-emerald-500/10 rounded-xl text-emerald-600">
            <TimerOff size={24} />
          </div>
          <div>
            <div className="text-3xl font-black text-emerald-700">
              {scenario
                ? Math.round(scenarioSaved).toLocaleString()
                : !pending && typeof data?.saved_wait_minutes === 'number' ? Math.round(data.saved_wait_minutes).toLocaleString() : '—'}분
            </div>
            <div className="text-xs text-hanok-muted font-semibold mt-0.5">절감 대기시간 합계{scenario ? ` (${SCENARIO_BADGE})` : ''}</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="p-3 bg-gold/10 rounded-xl text-gold-deep">
            <Route size={24} />
          </div>
          <div>
            <div className="text-3xl font-black text-hanok-ink">
              {scenario
                ? Math.round(scenarioRelocations).toLocaleString()
                : !pending && typeof data?.relocations === 'number' ? data.relocations.toLocaleString() : '—'}건
            </div>
            <div className="text-xs text-hanok-muted font-semibold mt-0.5">수요 재배치 (추천 수락){scenario ? ` (${SCENARIO_BADGE})` : ''}</div>
          </div>
        </div>
        {/* 절단은 이 위젯에서 특히 나쁘게 작동한다: 여기 두 숫자는 **합계**라, 행이 빠지면
            '분산 효과가 이만큼 있었다' 를 실제보다 작게 말하게 된다. 그런데 작아진 합계는
            여전히 그럴듯해서 화면만 봐서는 축소 보고를 알아챌 수 없다. 서버가 truncated 를
            싣고 있었는데 화면이 읽지 않았다. */}
        {!pending && !scenario && data?.truncated && (
          <p>
            <span className="inline-flex items-center rounded-full border border-hanok-line bg-hanok-card px-2.5 py-1 text-[11px] font-semibold text-hanok-muted">
              최신 구간 기준
            </span>
          </p>
        )}
        {failed ? (
          <p className="text-[11px] text-hanok-muted">
            분산 효과 집계를 갱신하는 중입니다 — 잠시 후 자동으로 표시됩니다.
          </p>
        ) : scenario ? (
          // 실측 1~4건이면 그 수를 적는다(basisSubline 이 '실측 3건 수집 중' 을 만든다). 0건은 문장에 적지 않는다.
          <p className="text-[11px] text-amber-800/90">
            {SCENARIO_FOOTNOTE}
            {relocationsMeasured !== null && relocationsMeasured >= 1 && relocationsMeasured < MIN_MEASURED_SAMPLES
              ? ` · 실측 ${relocationsMeasured}건 수집 중`
              : ''}
          </p>
        ) : (
          !pending &&
          data &&
          data.estimated > 0 && (
            <p className="text-[11px] text-hanok-muted">
              실측 {data.measured}건 · 추정 {data.estimated}건 (추정분은 혼잡 감소분으로 산출)
            </p>
          )
        )}
      </div>
    </div>
  );
}
