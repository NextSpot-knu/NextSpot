'use client';

import { useState, useEffect } from 'react';
import { Route, TimerOff } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';

// 분산 효과 정량화 — 오늘(KST) 수락된 추천의 '절감 대기시간' 합산.
// 산식(백엔드 GET /api/v1/admin/impact): Σ max(0, 원본 예상대기 − 대안 도착시점 예상대기).
// 원본/대안 대기는 추천 생성 시점의 score_breakdown 스냅샷이라 사후 재계산 왜곡이 없다.

interface ImpactData {
  relocations: number;
  saved_wait_minutes: number;
  measured: number;
  estimated: number;
}

// KST '오늘 00:00' 을 UTC ISO 로 — dashboard/page.tsx 의 범위 계산과 동일한 고정 +9h 환산.
function kstTodayStartUtcIso(): string {
  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const startUtcMs =
    Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate(), 0, 0, 0, 0) -
    9 * 60 * 60 * 1000;
  return new Date(startUtcMs).toISOString();
}

export function ImpactWidget() {
  const [data, setData] = useState<ImpactData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    adminApi
      .get(`/api/v1/admin/impact?since=${encodeURIComponent(kstTodayStartUtcIso())}`)
      .then(res => {
        if (active) setData(res);
      })
      .catch(err => {
        console.warn('분산 효과 집계 조회 실패:', err);
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="bg-slate-900 rounded-2xl border border-slate-800 shadow-sm overflow-hidden flex flex-col">
      <div className="p-6 border-b border-slate-800 bg-slate-800/30">
        <div className="flex items-center gap-2">
          <Route className="text-emerald-400" size={20} />
          <h3 className="text-lg font-bold text-slate-100">오늘 분산 효과</h3>
        </div>
        <p className="text-xs text-slate-500 mt-1">수락된 추천이 실제로 덜어낸 혼잡 (KST 오늘 기준)</p>
      </div>

      <div className="flex-1 p-6 flex flex-col justify-center gap-6">
        {/* 실패해도 패널을 비우지 않는다 — 수치는 '—'로 두고 대기 안내만 덧붙여 자리를 유지. */}
        {/* 실패를 실데이터로 위장하지 않으려 0/공란이 아닌 '—'로 명시. */}
        <div className="flex items-center gap-4">
          <div className="p-3 bg-emerald-500/10 rounded-xl text-emerald-400">
            <TimerOff size={24} />
          </div>
          <div>
            <div className="text-3xl font-black text-emerald-300">
              {data ? Math.round(data.saved_wait_minutes).toLocaleString() : '—'}분
            </div>
            <div className="text-xs text-slate-400 font-semibold mt-0.5">절감 대기시간 합계</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="p-3 bg-blue-500/10 rounded-xl text-blue-400">
            <Route size={24} />
          </div>
          <div>
            <div className="text-3xl font-black text-slate-100">
              {data ? data.relocations.toLocaleString() : '—'}건
            </div>
            <div className="text-xs text-slate-400 font-semibold mt-0.5">수요 재배치 (추천 수락)</div>
          </div>
        </div>
        {failed ? (
          <p className="text-[11px] text-slate-500">
            백엔드 연결 대기 중 — 집계 표시에는 백엔드(8000) 기동이 필요합니다.
          </p>
        ) : (
          data &&
          data.estimated > 0 && (
            <p className="text-[11px] text-slate-600">
              실측 {data.measured}건 · 근사 {data.estimated}건 (구버전 추천 행은 혼잡 감소분 기반 근사)
            </p>
          )
        )}
      </div>
    </div>
  );
}
