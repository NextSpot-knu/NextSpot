'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CarFront, RefreshCw } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';

interface ReliabilityResponse {
  source: string;
  history_state: 'no_data' | 'insufficient_history' | 'sufficient_history';
  window: {
    expected_bucket_count: number;
    received_bucket_count: number;
    missing_bucket_count: number;
    missing_rate: number;
    longest_gap_minutes: number;
  };
  latest: null | {
    observed_at: string;
    age_minutes: number;
    freshness_state: 'fresh' | 'delayed' | 'stale' | 'future_timestamp';
    live_lot_count: number;
    total_spaces: number;
    available_spaces: number;
    occupancy: number;
    lot_details_complete: boolean;
  };
  lots: Array<{
    source_lot_id: string;
    name: string;
    total_spaces: number;
    available_spaces: number;
    occupancy: number;
  }>;
}

export function AreaDemandReliabilityPanel() {
  const [data, setData] = useState<ReliabilityResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setError(false);
      const value = await adminApi.get('/api/v1/admin/area-demand-reliability?hours=24');
      setData(value as ReliabilityResponse);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const latest = data?.latest;
  const unhealthy = error || !latest || latest.freshness_state !== 'fresh' || !latest.lot_details_complete;

  return (
    <section className="rounded-2xl border border-hanok-line bg-hanok-panel p-5" aria-label="공영주차 실측 수집 신뢰도">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-bold text-hanok-ink">
            <CarFront size={18} className="text-gold" />공영주차 실측 수집
          </h3>
          <p className="mt-1 text-xs text-hanok-muted">장소 내부 혼잡이 아닌 경주 ITS 주차 수요 · 15분 간격</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading} aria-label="수집 현황 새로고침" className="rounded-lg border border-hanok-line p-2 text-hanok-muted hover:text-hanok-ink disabled:opacity-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading && !data ? (
        <div className="mt-4 h-20 animate-pulse rounded-xl bg-hanok-line/50" />
      ) : error ? (
        <p className="mt-4 flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300"><AlertTriangle size={14} />수집 신뢰도 API를 확인해 주세요.</p>
      ) : data ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
            <Metric label="최근 24시간 수집" value={`${data.window.received_bucket_count}/${data.window.expected_bucket_count}`} />
            <Metric label="누락률" value={`${(data.window.missing_rate * 100).toFixed(1)}%`} />
            <Metric label="최장 공백" value={`${data.window.longest_gap_minutes}분`} />
            <Metric label="최신 관측" value={latest ? `${Math.max(0, Math.round(latest.age_minutes))}분 전` : '없음'} warn={unhealthy} />
          </div>
          {latest && (
            <div className="mt-3 rounded-xl border border-hanok-line bg-hanok-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <strong className="text-hanok-ink">실시간 {latest.live_lot_count}곳 · 총 {latest.total_spaces}면 · 가용 {latest.available_spaces}면</strong>
                <span className="text-hanok-muted">점유 {(latest.occupancy * 100).toFixed(1)}%</span>
              </div>
              <div className="mt-3 grid gap-2 md:grid-cols-3">
                {data.lots.map((lot) => (
                  <div key={lot.source_lot_id} className="rounded-lg border border-hanok-line px-3 py-2 text-[11px] text-hanok-muted">
                    <strong className="block truncate text-hanok-ink">{lot.name}</strong>
                    가용 {lot.available_spaces}/{lot.total_spaces} · 점유 {(lot.occupancy * 100).toFixed(1)}%
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

function Metric({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return <div className="rounded-xl border border-hanok-line bg-hanok-card p-3"><p className="text-[10px] text-hanok-muted">{label}</p><p className={`mt-1 text-lg font-black ${warn ? 'text-rose-300' : 'text-hanok-ink'}`}>{value}</p></div>;
}
