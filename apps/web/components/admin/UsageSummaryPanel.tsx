'use client';

import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { createPublicClient } from '@/lib/supabase';

// 서비스 이용 현황(10-24) — 익명 이용 기록(usage_events)의 관리자 전용 집계 RPC usage_summary 를 읽는다.
// 행·익명 번호는 오지 않고 숫자만 온다. 방문 → 추천 카드 확인 → 바로 갈래요 → 도착 확인 네 단계를 방문자 대비 %로,
// 그 아래 날짜별 방문자를 막대로 그린다. 조회가 실패하면(권한 없음·함수 미적용) 패널을 그리지 않는다.

interface UsageSummary {
  days: number;
  visitors: number;
  saw_card: number;
  went: number;
  arrived: number;
  daily: Array<{ day: string; visitors: number }>;
}

const PERIODS = [7, 30] as const;

function isSummary(value: unknown): value is UsageSummary {
  const v = value as UsageSummary | null;
  return !!v && typeof v.visitors === 'number' && Array.isArray(v.daily);
}

export function UsageSummaryPanel() {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(7);
  const [data, setData] = useState<UsageSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: raw, error } = await createPublicClient().rpc('usage_summary', { p_days: days });
      if (!alive) return;
      if (error || !isSummary(raw)) {
        setFailed(true);
        return;
      }
      setData(raw);
    })();
    return () => {
      alive = false;
    };
  }, [days]);

  if (failed) return null;

  const steps = data
    ? [
        { label: '방문', value: data.visitors },
        { label: '추천 카드 확인', value: data.saw_card },
        { label: '바로 갈래요', value: data.went },
        { label: '도착 확인', value: data.arrived },
      ]
    : [];
  const peak = Math.max(1, ...(data?.daily ?? []).map((d) => d.visitors));

  return (
    <section className="rounded-2xl border border-hanok-line bg-hanok-panel p-5" data-testid="admin-usage-summary" aria-label="서비스 이용 현황">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-bold text-hanok-ink">
            <Users size={18} className="text-gold-deep" />서비스 이용 현황
          </h3>
          <p className="mt-1 text-xs text-hanok-muted">익명 방문 기록 · 최근 {days}일 · 같은 기기는 한 명으로 셉니다</p>
        </div>
        <div className="flex shrink-0 gap-1" role="group" aria-label="기간">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setDays(p)}
              aria-pressed={days === p}
              className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${
                days === p ? 'border-gold-deep/50 bg-gold-deep/15 text-hanok-ink' : 'border-hanok-line text-hanok-muted'
              }`}
            >
              {p}일
            </button>
          ))}
        </div>
      </div>

      {!data ? (
        <div className="mt-4 h-24 animate-pulse rounded-xl bg-hanok-card" />
      ) : (
        <>
          <ol className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {steps.map((step, i) => (
              <li key={step.label} className="rounded-xl border border-hanok-line bg-hanok-card p-3">
                <p className="text-xs font-semibold text-hanok-muted">{step.label}</p>
                <p className="mt-1 text-2xl font-black tabular-nums text-hanok-ink">{step.value.toLocaleString()}</p>
                {i > 0 && (
                  <p className="text-[11px] font-semibold tabular-nums text-hanok-muted">
                    방문자의 {data.visitors > 0 ? Math.round((step.value / data.visitors) * 100) : 0}%
                  </p>
                )}
              </li>
            ))}
          </ol>
          {data.daily.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold text-hanok-muted">날짜별 방문자</p>
              <div className="mt-2 flex h-20 items-end gap-1">
                {data.daily.map((d) => (
                  <div key={d.day} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${d.day} · ${d.visitors}명`}>
                    <div className="w-full rounded-t bg-gold-deep/70" style={{ height: `${Math.max(4, (d.visitors / peak) * 100)}%` }} />
                    {data.daily.length <= 10 && (
                      <span className="text-[10px] tabular-nums text-hanok-muted">{d.day.slice(5).replace('-', '/')}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
