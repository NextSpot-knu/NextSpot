'use client';

import { useState, useEffect } from 'react';
import { Route, Timer } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';
import {
  MIN_RATE_SAMPLES,
  hasEnoughSamples,
  insufficientSampleLabel,
  readImpact,
  waitDiffBasisLine,
  type ImpactView,
} from '@/lib/adminLoopMetrics';

// 추천 수락 결과(최근 30일) — 백엔드 GET /api/v1/admin/impact(P1-1 정의).
//
//   · 재배치 = 수락 · 원본 ≠ 목적지 · 도착 확인. 예전에는 수락 행 수를 '수요 재배치' 로 적었다 — 메인 '바로 갈래요'
//     (원본 = 목적지)와 수락만 하고 가지 않은 건까지 셌다. 지금은 수락을 네 갈래로 나눠 함께 적는다.
//   · 예상 대기 차이(모델 추정) = 재배치 건의 Σ max(0, 원본 예상대기 − 대안 예상대기). 예상대기는 혼잡도 × 업종
//     처리시간 × 시간대 계수로 추천 때 계산한 값이다 — 측정한 대기도, 측정한 절감도 아니어서 '절감' 이라 부르지 않는다.
//   · 재배치가 하한(MIN_RATE_SAMPLES) 미만이면 합계 대신 '표본 부족 · n건 / 필요 m건' 을 적는다. 건수 자체는 사실이라
//     그대로 적는다. 운영 화면은 그 자리를 데모 값(시나리오)으로 채우지 않는다(2026-10-31 P0-3).
//   · 응답 모양이 다르거나 옛 서버(relocations = 수락 행 수)면 '—' 와 '갱신 중' 이다 — 수락 행 수를 재배치로 그리지 않는다.

/** 집계 창 — 최근 30일. */
const IMPACT_WINDOW_DAYS = 30;

// KST 기준 30일 전 00:00 을 UTC ISO 로 — dashboard/page.tsx 의 범위 계산과 동일한 고정 +9h 환산.
function kstWindowStartUtcIso(days: number = IMPACT_WINDOW_DAYS): string {
  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const startUtcMs =
    Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate() - (days - 1), 0, 0, 0, 0) -
    9 * 60 * 60 * 1000;
  return new Date(startUtcMs).toISOString();
}

export function ImpactWidget() {
  const [data, setData] = useState<ImpactView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    adminApi
      .get(`/api/v1/admin/impact?since=${encodeURIComponent(kstWindowStartUtcIso())}`)
      .then((res) => {
        if (!active) return;
        // 모양 검증은 readImpact 한 곳에서 — 옛 서버의 '수락 행 수' 를 재배치로 읽지 않는다.
        const view = readImpact(res);
        if (view) setData(view);
        else setFailed(true);
      })
      .catch((err) => {
        console.warn('추천 수락 결과 조회 실패:', err);
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const enough = data !== null && hasEnoughSamples(data.relocations);
  const basisLine = data ? waitDiffBasisLine(data) : '';

  return (
    <div className="bg-hanok-panel rounded-2xl shadow-sm overflow-hidden flex flex-col border border-hanok-line">
      <div className="p-6 border-b border-hanok-line bg-hanok-card/30">
        <div className="flex items-center gap-2 flex-wrap">
          <Route className="text-emerald-600" size={20} />
          <h3 className="text-lg font-bold text-hanok-ink">추천 수락 결과 (최근 {IMPACT_WINDOW_DAYS}일)</h3>
        </div>
        <p className="text-xs text-hanok-muted mt-1">
          원본과 다른 장소를 수락하고 도착이 확인된 건만 재배치로 셉니다 · 내부 계정 제외
        </p>
      </div>

      <div className="flex-1 p-6 flex flex-col justify-center gap-6">
        {/* 값이 숫자일 때만 포맷한다 — 응답 모양이 어긋나면 '—'(모른다). 0 으로 채우지 않는다. */}
        <div className="flex items-center gap-4">
          <div className="p-3 bg-gold/10 rounded-xl text-gold-deep">
            <Route size={24} />
          </div>
          <div>
            <div className="text-3xl font-black text-hanok-ink">
              {data ? `${data.relocations.toLocaleString('ko-KR')}건` : '—'}
            </div>
            <div className="text-xs text-hanok-muted font-semibold mt-0.5">재배치 (도착 확인)</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="p-3 bg-emerald-500/10 rounded-xl text-emerald-600">
            <Timer size={24} />
          </div>
          <div className="min-w-0">
            {data && !enough ? (
              // 재배치가 하한 미만 — 몇 건의 모델 추정 합을 '효과' 로 읽게 두지 않는다.
              <div className="text-lg font-black leading-8 text-hanok-muted">
                {insufficientSampleLabel(data.relocations, MIN_RATE_SAMPLES)}
              </div>
            ) : (
              <div className="text-3xl font-black text-emerald-700">
                {data ? `${Math.round(data.waitDiffMinutes).toLocaleString('ko-KR')}분` : '—'}
              </div>
            )}
            <div className="text-xs text-hanok-muted font-semibold mt-0.5">예상 대기 차이 합 (모델 추정)</div>
          </div>
        </div>

        {data && (
          <div className="flex flex-col gap-1 text-[11px] leading-snug text-hanok-muted">
            {/* 수락 표본(n)과 네 갈래 — 재배치가 아닌 수락을 버리지 않고 따로 적는다. */}
            <p>
              수락 {data.acceptedTotal.toLocaleString('ko-KR')}건 = 재배치 {data.relocations.toLocaleString('ko-KR')}
              {' · '}도착 미확인 {data.movesUnconfirmed.toLocaleString('ko-KR')}
              {' · '}같은 장소 {data.sameFacility.toLocaleString('ko-KR')}
              {data.missingFacility > 0 ? ` · 시설 정보 없음 ${data.missingFacility.toLocaleString('ko-KR')}` : ''}
            </p>
            {/* 예상 대기 차이가 무엇으로 계산됐는가 — 관측한 값이 하나도 없다는 사실을 숨기지 않는다. */}
            <p>
              예상 대기 = 혼잡도 × 업종 처리시간 × 시간대 계수(측정값 아님){basisLine ? ` · ${basisLine}` : ''}
            </p>
          </div>
        )}
        {/* 서버 상한에 닿았다 — 위 건수·합계는 실제보다 작을 수 있다(합계라 잘려도 그럴듯해 보인다). */}
        {data?.truncated && (
          <p>
            <span className="inline-flex items-center rounded-full border border-hanok-line bg-hanok-card px-2.5 py-1 text-[11px] font-semibold text-hanok-muted">
              최신 구간 기준
            </span>
          </p>
        )}
        {failed && (
          <p className="text-[11px] text-hanok-muted">
            추천 수락 결과를 갱신하는 중입니다 — 잠시 후 자동으로 표시됩니다.
          </p>
        )}
      </div>
    </div>
  );
}
