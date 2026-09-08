'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CarFront, RefreshCw } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';

interface ReliabilityResponse {
  source: string;
  /** 수집이 지금 살아 있는가에 대한 서버의 단일 판정.
   *
   * 여러 지표(신선도·누락률·이력 유무)를 화면이 조합해 판단하면, 같은 사실을 서버의 경보
   * 스케줄러와 다르게 읽게 된다. 판정은 서버가 한 번 하고 양쪽이 그 값을 쓴다. */
  alert?: {
    state: 'ok' | 'degraded' | 'down' | 'unknown';
    reason: string | null;
    age_minutes: number | null;
  };
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
  // 숫자를 읽어야 알 수 있던 '수집이 멈췄다' 를 맨 위에 한 줄로 세운다. 이 패널은 지표가
  // 네 칸이라, 멈춘 상태에서도 '최신 관측 1440분 전' 이 다른 숫자들 사이에 묻혔다.
  const alertState = data?.alert?.state;
  const alertText: Record<string, string> = {
    down: '수집이 멈췄습니다 — 새 스냅샷이 들어오지 않습니다.',
    degraded: '수집이 간헐적으로 실패하고 있습니다.',
  };

  return (
    <section className="rounded-2xl border border-hanok-line bg-hanok-panel p-5" aria-label="공영주차 실측 수집 신뢰도">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-bold text-hanok-ink">
            <CarFront size={18} className="text-gold" />공영주차 실측 수집
          </h3>
          <p className="mt-1 text-xs text-hanok-muted">장소 내부 혼잡이 아닌 경주 ITS 주차 수요 · 10분 간격</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading} aria-label="수집 현황 새로고침" className="rounded-lg border border-hanok-line p-2 text-hanok-muted hover:text-hanok-ink disabled:opacity-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {alertState && alertText[alertState] && (
        <p
          role="alert"
          className={`mt-4 flex items-start gap-2 rounded-xl border p-3 text-xs ${
            alertState === 'down'
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
          }`}
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {alertText[alertState]}
            {data?.alert?.reason && <span className="ml-1 opacity-80">({data.alert.reason})</span>}
          </span>
        </p>
      )}

      {loading && !data ? (
        <div className="mt-4 h-20 animate-pulse rounded-xl bg-hanok-line/50" />
      ) : error ? (
        <p className="mt-4 flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300"><AlertTriangle size={14} />수집 신뢰도 API를 확인해 주세요.</p>
      ) : data?.window ? (
        // `data ?` 만으로는 부족하다 — **응답이 오긴 왔는데 window 가 없는 경우**가 그 가드를
        // 통과해 아래 `data.window.received_bucket_count` 에서 터졌고, 그러면 이 패널 하나가
        // 아니라 **관리자 대시보드 전체가 에러 바운더리로 떨어졌다**(브라우저에서 재현).
        // 배포 시차로 옛 서버가 새 shape 을 아직 안 싣거나 프록시가 `{}` 를 돌려줄 때 실제로 온다.
        // 그때는 아래 '수집 이력이 아직 없습니다' 로 조용히 빠지는 것이 맞다.
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
